"""Central voice-attempt reservations; never stores audio or recognized text."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import stat
import time
from typing import Any, Iterator, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from deeptutor.utils.secret_files import ensure_private_directory, ensure_private_file

from .learner_voice_types import (
    DAY_CALL_LIMIT,
    GLOBAL_INFLIGHT_LIMIT,
    LEASE_SECONDS,
    MINUTE_CALL_LIMIT,
    USER_INFLIGHT_LIMIT,
    TaskVoiceError,
)
from .storage import _assert_unredirected


def _canonical(value: Any) -> str:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    )


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


class VoiceIntent(BaseModel):
    model_config = ConfigDict(extra="forbid", revalidate_instances="always")
    request_id: UUID
    recipient_user_id: str = Field(min_length=1, max_length=64, strict=True)
    task_id: UUID
    question_id: str = Field(min_length=1, max_length=128, strict=True)
    basis_revision: int = Field(ge=0, strict=True)
    audio_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")

    @field_validator("recipient_user_id", "question_id")
    @classmethod
    def valid_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Voice request identifiers cannot be blank")
        value.encode("utf-8")
        return value

    def request_hash(self) -> str:
        return _digest(self.model_dump(mode="json"))


class _VoiceState(BaseModel):
    model_config = ConfigDict(extra="forbid", revalidate_instances="always")
    request_id: UUID
    lease_token: UUID
    state: Literal["reserved", "attempting", "completed", "failed", "cancelled", "expired"]
    admitted_at: float = Field(ge=0, allow_inf_nan=False, strict=True)
    lease_until: float | None = Field(ge=0, allow_inf_nan=False, strict=True)
    attempted_at: float | None = Field(default=None, ge=0, allow_inf_nan=False, strict=True)
    finished_at: float | None = Field(default=None, ge=0, allow_inf_nan=False, strict=True)

    @model_validator(mode="after")
    def valid_lifecycle(self) -> _VoiceState:
        active = self.state in {"reserved", "attempting"}
        if active:
            if self.lease_until != self.admitted_at + LEASE_SECONDS or self.finished_at is not None:
                raise ValueError("Active voice request has an invalid lease")
        elif (
            self.lease_until is not None
            or self.finished_at is None
            or self.finished_at < self.admitted_at
        ):
            raise ValueError("Terminal voice request has an invalid finish receipt")
        if self.state == "reserved" and self.attempted_at is not None:
            raise ValueError("A reservation cannot already be attempted")
        if self.state in {"attempting", "completed"} and self.attempted_at is None:
            raise ValueError("An attempted voice request needs a timestamp")
        if self.attempted_at is not None:
            end = self.finished_at if self.finished_at is not None else self.lease_until
            if end is None or self.attempted_at < self.admitted_at or self.attempted_at > end:
                raise ValueError("Invalid voice attempt timestamp")
        return self


@dataclass(frozen=True, slots=True)
class VoiceAdmission:
    request_id: str
    request_hash: str
    lease_token: str
    is_new: bool
    state: str
    lease_until: float | None


class TaskVoiceBudgetStore:
    def __init__(self, root: Path | None = None) -> None:
        if root is None:
            from deeptutor.multi_user import paths

            root = paths.SYSTEM_ROOT
        self.root = Path(root).absolute()
        self.db_path = self.root / "student_task_voice.sqlite3"
        self._assert_paths()

    def _assert_paths(self) -> None:
        _assert_unredirected(self.root)
        for suffix in ("", "-journal", "-wal", "-shm"):
            _assert_unredirected(Path(str(self.db_path) + suffix))

    @staticmethod
    def _now() -> float:
        value = time.time()
        if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
            raise ValueError("Voice budget clock is invalid.")
        return float(value)

    @contextmanager
    def _connection(self, *, create: bool = False) -> Iterator[sqlite3.Connection | None]:
        self._assert_paths()
        if not create and not self.db_path.exists():
            yield None
            return
        if create:
            ensure_private_directory(self.root)
            self._assert_paths()
            try:
                descriptor = os.open(
                    self.db_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, stat.S_IRUSR | stat.S_IWUSR
                )
            except FileExistsError:
                pass
            else:
                os.close(descriptor)
        self._assert_paths()
        connection = sqlite3.connect(
            self.db_path.as_uri() + "?mode=rw", uri=True, timeout=10, isolation_level=None
        )
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA busy_timeout=10000")
            connection.execute("PRAGMA synchronous=FULL")
            if create:
                connection.executescript("""
                    CREATE TABLE IF NOT EXISTS task_voice_requests (
                        request_id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
                        request_json TEXT NOT NULL, request_hash TEXT NOT NULL,
                        state TEXT NOT NULL CHECK(state IN ('reserved','attempting','completed','failed','cancelled','expired')),
                        state_json TEXT NOT NULL,state_hash TEXT NOT NULL,
                        admitted_at REAL NOT NULL,attempted_at REAL,lease_until REAL
                    );
                    CREATE INDEX IF NOT EXISTS task_voice_user_calls ON task_voice_requests(user_id,attempted_at);
                    CREATE INDEX IF NOT EXISTS task_voice_leases ON task_voice_requests(state,lease_until);
                """)
                ensure_private_file(self.db_path)
            yield connection
        finally:
            connection.close()

    @staticmethod
    def _record(row: sqlite3.Row) -> tuple[VoiceIntent, _VoiceState]:
        intent_raw = json.loads(row["request_json"])
        state_raw = json.loads(row["state_json"])
        if _digest(intent_raw) != row["request_hash"] or _digest(state_raw) != row["state_hash"]:
            raise ValueError("Voice budget receipt is damaged.")
        intent = VoiceIntent.model_validate(intent_raw)
        state = _VoiceState.model_validate(state_raw)
        if (
            str(intent.request_id) != row["request_id"]
            or intent.recipient_user_id != row["user_id"]
            or state.request_id != intent.request_id
            or state.state != row["state"]
            or state.admitted_at != row["admitted_at"]
            or state.attempted_at != row["attempted_at"]
            or state.lease_until != row["lease_until"]
        ):
            raise ValueError("Voice budget row does not match its request identity.")
        return intent, state

    @staticmethod
    def _admission(
        intent: VoiceIntent, state: _VoiceState, *, is_new: bool = False
    ) -> VoiceAdmission:
        return VoiceAdmission(
            str(intent.request_id),
            intent.request_hash(),
            str(state.lease_token),
            is_new,
            state.state,
            state.lease_until,
        )

    def peek(self, intent: VoiceIntent) -> VoiceAdmission | None:
        intent = VoiceIntent.model_validate(intent)
        with self._connection() as connection:
            row = (
                connection.execute(
                    "SELECT * FROM task_voice_requests WHERE request_id=?",
                    (str(intent.request_id),),
                ).fetchone()
                if connection is not None
                else None
            )
        if row is None:
            return None
        saved, state = self._record(row)
        if saved.request_hash() != intent.request_hash():
            raise TaskVoiceError("task_voice_request_changed")
        return self._admission(saved, state)

    @staticmethod
    def _put_state(connection: sqlite3.Connection, state: _VoiceState) -> None:
        raw = state.model_dump(mode="json")
        connection.execute(
            "UPDATE task_voice_requests SET state=?,state_json=?,state_hash=?,attempted_at=?,lease_until=? WHERE request_id=?",
            (
                state.state,
                _canonical(raw),
                _digest(raw),
                state.attempted_at,
                state.lease_until,
                str(state.request_id),
            ),
        )

    @staticmethod
    def _counts(
        records: list[tuple[VoiceIntent, _VoiceState]], user_id: str, now: float
    ) -> dict[str, int]:
        day_start = math.floor(now / 86400) * 86400
        return {
            "in_flight": sum(
                intent.recipient_user_id == user_id
                and state.lease_until is not None
                and state.lease_until > now
                for intent, state in records
            ),
            "global_in_flight": sum(
                state.lease_until is not None and state.lease_until > now for _, state in records
            ),
            "minute_calls": sum(
                intent.recipient_user_id == user_id
                and state.attempted_at is not None
                and now - 60 < state.attempted_at <= now
                for intent, state in records
            ),
            "day_calls": sum(
                intent.recipient_user_id == user_id
                and state.attempted_at is not None
                and day_start <= state.attempted_at <= now
                for intent, state in records
            ),
        }

    def counters(self, user_id: str) -> dict[str, int]:
        now = self._now()
        with self._connection() as connection:
            records = (
                [
                    self._record(row)
                    for row in connection.execute("SELECT * FROM task_voice_requests")
                ]
                if connection is not None
                else []
            )
        return self._counts(records, user_id, now)

    def admit(self, intent: VoiceIntent) -> VoiceAdmission:
        intent = VoiceIntent.model_validate(intent)
        now = self._now()
        with self._connection(create=True) as connection:
            if connection is None:
                raise ValueError("Voice budget storage is unavailable.")
            connection.execute("BEGIN IMMEDIATE")
            try:
                records = [
                    self._record(row)
                    for row in connection.execute("SELECT * FROM task_voice_requests")
                ]
                for saved, state in records:
                    if state.lease_until is not None and state.lease_until <= now:
                        expired = state.model_copy(
                            update={
                                "state": "expired",
                                "lease_until": None,
                                "finished_at": max(now, state.admitted_at),
                            }
                        )
                        self._put_state(connection, _VoiceState.model_validate(expired))
                # Re-read after expiry so counters and duplicate handling use
                # the same atomic state, never an in-process-only semaphore.
                records = [
                    self._record(row)
                    for row in connection.execute("SELECT * FROM task_voice_requests")
                ]
                for saved, state in records:
                    if saved.request_id == intent.request_id:
                        if saved.request_hash() != intent.request_hash():
                            raise TaskVoiceError("task_voice_request_changed")
                        connection.commit()
                        return self._admission(saved, state)
                counts = self._counts(records, intent.recipient_user_id, now)
                if (
                    counts["in_flight"] >= USER_INFLIGHT_LIMIT
                    or counts["global_in_flight"] >= GLOBAL_INFLIGHT_LIMIT
                ):
                    raise TaskVoiceError("task_voice_busy", retry_after=1)
                if counts["day_calls"] >= DAY_CALL_LIMIT:
                    raise TaskVoiceError(
                        "task_voice_daily_limit",
                        retry_after=max(1, math.ceil((math.floor(now / 86400) + 1) * 86400 - now)),
                    )
                if counts["minute_calls"] >= MINUTE_CALL_LIMIT:
                    first = min(
                        state.attempted_at
                        for saved, state in records
                        if saved.recipient_user_id == intent.recipient_user_id
                        and state.attempted_at is not None
                        and now - 60 < state.attempted_at <= now
                    )
                    raise TaskVoiceError(
                        "task_voice_minute_limit", retry_after=max(1, math.ceil(first + 60 - now))
                    )
                state = _VoiceState(
                    request_id=intent.request_id,
                    lease_token=uuid4(),
                    state="reserved",
                    admitted_at=now,
                    lease_until=now + LEASE_SECONDS,
                )
                raw, state_raw = intent.model_dump(mode="json"), state.model_dump(mode="json")
                connection.execute(
                    "INSERT INTO task_voice_requests VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (
                        str(intent.request_id),
                        intent.recipient_user_id,
                        _canonical(raw),
                        _digest(raw),
                        state.state,
                        _canonical(state_raw),
                        _digest(state_raw),
                        now,
                        None,
                        state.lease_until,
                    ),
                )
                connection.commit()
                return self._admission(intent, state, is_new=True)
            except BaseException:
                connection.rollback()
                raise

    def start(self, admission: VoiceAdmission) -> None:
        now = self._now()
        with self._connection() as connection:
            if connection is None:
                raise ValueError("Voice reservation is missing.")
            connection.execute("BEGIN IMMEDIATE")
            try:
                row = connection.execute(
                    "SELECT * FROM task_voice_requests WHERE request_id=?", (admission.request_id,)
                ).fetchone()
                if row is None:
                    raise ValueError("Voice reservation is missing.")
                intent, state = self._record(row)
                if (
                    intent.request_hash() != admission.request_hash
                    or str(state.lease_token) != admission.lease_token
                ):
                    raise ValueError("Voice reservation ownership changed.")
                if (
                    state.state != "reserved"
                    or state.lease_until is None
                    or state.lease_until <= now
                ):
                    raise TaskVoiceError("task_voice_result_unavailable")
                self._put_state(
                    connection,
                    _VoiceState.model_validate(
                        state.model_copy(
                            update={
                                "state": "attempting",
                                "attempted_at": max(now, state.admitted_at),
                            }
                        )
                    ),
                )
                connection.commit()
            except BaseException:
                connection.rollback()
                raise

    def finish(
        self, admission: VoiceAdmission, outcome: Literal["completed", "failed", "cancelled"]
    ) -> bool:
        now = self._now()
        with self._connection() as connection:
            if connection is None:
                raise ValueError("Voice reservation is missing.")
            connection.execute("BEGIN IMMEDIATE")
            try:
                row = connection.execute(
                    "SELECT * FROM task_voice_requests WHERE request_id=?", (admission.request_id,)
                ).fetchone()
                if row is None:
                    raise ValueError("Voice reservation is missing.")
                intent, state = self._record(row)
                if (
                    intent.request_hash() != admission.request_hash
                    or str(state.lease_token) != admission.lease_token
                ):
                    raise ValueError("Voice reservation ownership changed.")
                if state.state not in {"reserved", "attempting"}:
                    connection.commit()
                    return False
                expired = state.lease_until is None or state.lease_until <= now
                final = state.model_copy(
                    update={
                        "state": "expired" if expired else outcome,
                        "lease_until": None,
                        "finished_at": max(now, state.attempted_at or state.admitted_at),
                    }
                )
                self._put_state(connection, _VoiceState.model_validate(final))
                connection.commit()
                return not expired
            except BaseException:
                connection.rollback()
                raise
