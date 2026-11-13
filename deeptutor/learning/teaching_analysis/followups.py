"""Versioned follow-up practice and teacher reviews, with no AI grading.

Practice is copied from a confirmed report and explicitly reviewed by a
teacher. Its questions, student submissions and review receipts remain
separate from the mastery engine, profile, and question notebook.
"""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import time
from typing import Any, Iterator
from uuid import UUID

from deeptutor.services.path_service import get_path_service
from deeptutor.utils.secret_files import ensure_private_directory, ensure_private_file

from .followup_models import (
    SavedFollowup,
    SavedFollowupAttempt,
    SaveFollowupAttemptRequest,
    SaveFollowupRequest,
)
from .storage import _assert_unredirected


class FollowupConflict(ValueError):
    """The source, practice version, or idempotency key changed."""


class FollowupSourceConflict(FollowupConflict):
    """The teacher must reload and review the source report before proceeding."""


class FollowupNotFound(LookupError):
    """The requested source or practice does not exist in this scope."""


class FollowupValidationError(ValueError):
    """A teacher must correct a question or review field before saving."""


def _canonical(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _digest(value: dict[str, Any]) -> str:
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


_METADATA_FIELDS = (
    "student_ref",
    "assignment_ref",
    "subject",
    "grade",
    "source_fingerprint",
    "knowledge_point",
)


class FollowupStore:
    """A fresh handle bound to an already-authorized account/workspace root."""

    def __init__(self, root: Path | None = None) -> None:
        self.root = Path(
            root
            if root is not None
            else get_path_service().get_workspace_dir() / "teaching-analysis"
        ).absolute()
        self.db_path = self.root / "followups.sqlite3"
        self.source_db_path = self.root / "reports.sqlite3"
        self._assert_paths()

    def _assert_paths(self, *, source: bool = False) -> None:
        _assert_unredirected(self.root)
        paths = [self.db_path]
        if source:
            paths.append(self.source_db_path)
        for path in paths:
            for suffix in ("", "-journal", "-wal", "-shm"):
                _assert_unredirected(Path(str(path) + suffix))

    @contextmanager
    def _connection(
        self, *, create: bool = False, source: bool = False
    ) -> Iterator[sqlite3.Connection | None]:
        self._assert_paths(source=source)
        if not create and not self.db_path.exists():
            yield None
            return
        if create:
            ensure_private_directory(self.root)
            self._assert_paths(source=source)
            try:
                descriptor = os.open(
                    self.db_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, stat.S_IRUSR | stat.S_IWUSR
                )
            except FileExistsError:
                pass
            else:
                os.close(descriptor)
        self._assert_paths(source=source)
        connection = sqlite3.connect(
            self.db_path.as_uri() + "?mode=rw", uri=True, timeout=15, isolation_level=None
        )
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA busy_timeout=15000")
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute("PRAGMA foreign_keys=ON")
            if create:
                connection.executescript(
                    """CREATE TABLE IF NOT EXISTS teaching_followup_revisions (
                        followup_id TEXT NOT NULL,
                        revision INTEGER NOT NULL CHECK(revision > 0),
                        report_id TEXT NOT NULL,
                        request_hash TEXT NOT NULL,
                        content_json TEXT NOT NULL,
                        updated_at REAL NOT NULL,
                        PRIMARY KEY(followup_id, revision)
                    );
                    CREATE TABLE IF NOT EXISTS teaching_followup_attempts (
                        attempt_id TEXT PRIMARY KEY,
                        followup_id TEXT NOT NULL,
                        followup_revision INTEGER NOT NULL,
                        request_hash TEXT NOT NULL,
                        content_json TEXT NOT NULL,
                        created_at REAL NOT NULL,
                        FOREIGN KEY(followup_id, followup_revision)
                            REFERENCES teaching_followup_revisions(followup_id, revision)
                    );
                    CREATE INDEX IF NOT EXISTS teaching_followup_attempt_order
                        ON teaching_followup_attempts(followup_id, created_at DESC);
                    CREATE TABLE IF NOT EXISTS teaching_followup_voids (
                        attempt_id TEXT PRIMARY KEY
                            REFERENCES teaching_followup_attempts(attempt_id),
                        voided_at REAL NOT NULL,
                        reason TEXT NOT NULL
                    );"""
                )
                ensure_private_file(self.db_path)
            if source and self.source_db_path.exists():
                # BEGIN IMMEDIATE below reserves both attached databases.
                # A source-report writer cannot change its current revision
                # between our source check and the practice-set commit.
                connection.execute(
                    "ATTACH DATABASE ? AS source_reports",
                    (self.source_db_path.as_uri() + "?mode=rw",),
                )
            yield connection
        finally:
            connection.close()

    @staticmethod
    def _id(value: str | UUID) -> str:
        return str(UUID(str(value)))

    @staticmethod
    def _content(row: sqlite3.Row) -> dict[str, Any]:
        return json.loads(row["content_json"])

    @staticmethod
    def _current_row(connection: sqlite3.Connection, followup_id: str) -> sqlite3.Row | None:
        return connection.execute(
            """SELECT revision, request_hash, content_json FROM teaching_followup_revisions
                WHERE followup_id=? ORDER BY revision DESC LIMIT 1""",
            (followup_id,),
        ).fetchone()

    @staticmethod
    def _source_metadata(
        connection: sqlite3.Connection, request: SaveFollowupRequest
    ) -> dict[str, Any]:
        if "source_reports" not in {
            row["name"] for row in connection.execute("PRAGMA database_list")
        }:
            raise FollowupNotFound("Source report not found in this workspace.")
        row = connection.execute(
            """SELECT content_json FROM source_reports.teaching_report_revisions
                WHERE report_id=? ORDER BY revision DESC LIMIT 1""",
            (str(request.report_id),),
        ).fetchone()
        if row is None:
            raise FollowupNotFound("Source report not found in this workspace.")
        report = json.loads(row["content_json"])
        if report["revision"] != request.report_revision or report["status"] != "confirmed":
            raise FollowupSourceConflict(
                "The source report changed or is not confirmed. Reload and review its current version."
            )
        priorities = report["analysis"]["priorities"]
        if request.priority_index >= len(priorities):
            raise FollowupValidationError("This concern is not present in the confirmed report.")
        return {
            key: report["assignment"].get(key, "")
            for key in ("student_ref", "assignment_ref", "subject", "grade")
        } | {
            "source_fingerprint": report["source_fingerprint"],
            "knowledge_point": priorities[request.priority_index]["knowledge_point"],
        }

    def list_followups(
        self, *, report_id: str | UUID | None = None, limit: int = 100
    ) -> list[dict[str, Any]]:
        report_filter = "WHERE current.report_id=?" if report_id is not None else ""
        params: tuple[Any, ...] = (
            (self._id(report_id), limit) if report_id is not None else (limit,)
        )
        with self._connection() as connection:
            if connection is None:
                return []
            rows = connection.execute(
                f"""SELECT current.content_json FROM teaching_followup_revisions current
                    JOIN (
                        SELECT followup_id, MAX(revision) AS revision
                        FROM teaching_followup_revisions GROUP BY followup_id
                    ) latest ON latest.followup_id=current.followup_id
                        AND latest.revision=current.revision
                    {report_filter}
                    ORDER BY current.updated_at DESC, current.followup_id LIMIT ?""",  # nosec B608 - internal clause only
                params,
            ).fetchall()
        return [self._content(row) for row in rows]

    def get_followup(self, followup_id: str | UUID) -> dict[str, Any]:
        followup_id = self._id(followup_id)
        with self._connection() as connection:
            row = self._current_row(connection, followup_id) if connection is not None else None
        if row is None:
            raise FollowupNotFound("Practice set not found in this workspace.")
        return self._content(row)

    def get_revision(self, followup_id: str | UUID, revision: int) -> dict[str, Any]:
        """Read exactly the requested immutable version, never a latest fallback."""
        followup_id = self._id(followup_id)
        if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
            raise ValueError("Practice revision must be a positive integer.")
        with self._connection() as connection:
            row = (
                connection.execute(
                    """SELECT content_json FROM teaching_followup_revisions
                        WHERE followup_id=? AND revision=?""",
                    (followup_id, revision),
                ).fetchone()
                if connection is not None
                else None
            )
        if row is None:
            raise FollowupNotFound("Practice version not found in this workspace.")
        return self._content(row)

    def revisions(self, followup_id: str | UUID, *, limit: int = 100) -> list[dict[str, Any]]:
        followup_id = self._id(followup_id)
        with self._connection() as connection:
            rows = (
                connection.execute(
                    """SELECT content_json FROM teaching_followup_revisions
                        WHERE followup_id=? ORDER BY revision DESC LIMIT ?""",
                    (followup_id, limit),
                ).fetchall()
                if connection is not None
                else []
            )
        if not rows:
            raise FollowupNotFound("Practice set not found in this workspace.")
        return [self._content(row) for row in rows]

    def save_followup(self, request: SaveFollowupRequest) -> dict[str, Any]:
        request = SaveFollowupRequest.model_validate(request)
        followup_id = str(request.followup_id)
        payload = request.model_dump(mode="json", exclude={"expected_revision"})
        request_hash = _digest(payload)
        with self._connection(create=True, source=True) as connection:
            assert connection is not None
            connection.execute("BEGIN IMMEDIATE")
            try:
                latest = self._current_row(connection, followup_id)
                if latest is not None and latest["request_hash"] == request_hash:
                    result = self._content(latest)
                    connection.commit()
                    return result
                current_revision = latest["revision"] if latest is not None else 0
                if current_revision != request.expected_revision:
                    raise FollowupConflict(
                        "The practice set changed elsewhere. Reload its current version."
                    )
                if latest is not None:
                    original = self._content(latest)
                    if (
                        original["report_id"] != str(request.report_id)
                        or original["priority_index"] != request.priority_index
                    ):
                        raise FollowupConflict(
                            "Create a new practice set for a different report or concern."
                        )
                metadata = self._source_metadata(connection, request)
                if latest is not None and any(
                    original[field] != metadata[field]
                    for field in ("student_ref", "assignment_ref", "subject", "knowledge_point")
                ):
                    raise FollowupSourceConflict(
                        "The student, assignment or concern changed. Create a new practice set."
                    )
                now = time.time()
                result = SavedFollowup.model_validate(
                    payload
                    | metadata
                    | {
                        "revision": current_revision + 1,
                        "created_at": self._content(latest)["created_at"]
                        if latest is not None
                        else now,
                        "updated_at": now,
                    }
                ).model_dump(mode="json")
                connection.execute(
                    """INSERT INTO teaching_followup_revisions
                        (followup_id, revision, report_id, request_hash, content_json, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?)""",
                    (
                        followup_id,
                        result["revision"],
                        result["report_id"],
                        request_hash,
                        _canonical(result),
                        now,
                    ),
                )
                connection.commit()
                return result
            except BaseException:
                connection.rollback()
                raise

    @staticmethod
    def _attempt_content(connection: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
        result = json.loads(row["content_json"])
        audit = connection.execute(
            "SELECT voided_at, reason FROM teaching_followup_voids WHERE attempt_id=?",
            (result["attempt_id"],),
        ).fetchone()
        if audit is not None:
            result.update(voided_at=audit["voided_at"], void_reason=audit["reason"])
        return result

    def record_attempt(
        self, followup_id: str | UUID, request: SaveFollowupAttemptRequest
    ) -> dict[str, Any]:
        followup_id = self._id(followup_id)
        request = SaveFollowupAttemptRequest.model_validate(request)
        payload = request.model_dump(mode="json")
        request_hash = _digest(payload | {"followup_id": followup_id})
        with self._connection() as connection:
            if connection is None:
                raise FollowupNotFound("Practice set not found in this workspace.")
            connection.execute("BEGIN IMMEDIATE")
            try:
                previous = connection.execute(
                    "SELECT request_hash, content_json FROM teaching_followup_attempts WHERE attempt_id=?",
                    (str(request.attempt_id),),
                ).fetchone()
                if previous is not None:
                    if previous["request_hash"] != request_hash:
                        raise FollowupConflict(
                            "This submission id was already used for different work."
                        )
                    # Check a committed receipt before checking the current set
                    # version, so retrying a successful old submission is safe.
                    result = self._attempt_content(connection, previous)
                    connection.commit()
                    return result
                latest = self._current_row(connection, followup_id)
                if latest is None:
                    raise FollowupNotFound("Practice set not found in this workspace.")
                if latest["revision"] != request.followup_revision:
                    raise FollowupConflict(
                        "The practice questions changed. Reload them before recording a response."
                    )
                practice = self._content(latest)
                question = next(
                    (
                        item
                        for item in practice["questions"]
                        if item["question_id"] == request.question_id
                    ),
                    None,
                )
                if question is None:
                    raise FollowupValidationError("The question is not in this practice version.")
                result = SavedFollowupAttempt.model_validate(
                    payload
                    | {key: practice[key] for key in _METADATA_FIELDS}
                    | {
                        "followup_id": followup_id,
                        "report_id": practice["report_id"],
                        "report_revision": practice["report_revision"],
                        "priority_index": practice["priority_index"],
                        "question_snapshot": question,
                        "created_at": time.time(),
                        "voided_at": None,
                        "void_reason": None,
                    }
                ).model_dump(mode="json")
                connection.execute(
                    """INSERT INTO teaching_followup_attempts
                        (attempt_id, followup_id, followup_revision, request_hash, content_json, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)""",
                    (
                        result["attempt_id"],
                        followup_id,
                        request.followup_revision,
                        request_hash,
                        _canonical(result),
                        result["created_at"],
                    ),
                )
                connection.commit()
                return result
            except BaseException:
                connection.rollback()
                raise

    def attempts(self, followup_id: str | UUID, *, limit: int = 100) -> list[dict[str, Any]]:
        followup_id = self._id(followup_id)
        with self._connection() as connection:
            if connection is None or self._current_row(connection, followup_id) is None:
                raise FollowupNotFound("Practice set not found in this workspace.")
            rows = connection.execute(
                """SELECT content_json FROM teaching_followup_attempts WHERE followup_id=?
                    ORDER BY created_at DESC, attempt_id LIMIT ?""",
                (followup_id, limit),
            ).fetchall()
            return [self._attempt_content(connection, row) for row in rows]

    def void_attempt(
        self, followup_id: str | UUID, attempt_id: str | UUID, reason: str
    ) -> dict[str, Any]:
        followup_id = self._id(followup_id)
        attempt_id = self._id(attempt_id)
        reason = reason.strip()
        if not reason or len(reason) > 2_000:
            raise FollowupValidationError(
                "Voiding a response requires a reason up to 2000 characters."
            )
        with self._connection() as connection:
            if connection is None:
                raise FollowupNotFound("Student response not found in this workspace.")
            connection.execute("BEGIN IMMEDIATE")
            try:
                original = connection.execute(
                    """SELECT content_json FROM teaching_followup_attempts
                        WHERE attempt_id=? AND followup_id=?""",
                    (attempt_id, followup_id),
                ).fetchone()
                if original is None:
                    raise FollowupNotFound("Student response not found in this workspace.")
                existing = connection.execute(
                    "SELECT reason FROM teaching_followup_voids WHERE attempt_id=?", (attempt_id,)
                ).fetchone()
                if existing is not None and existing["reason"] != reason:
                    raise FollowupConflict("This response was already voided with another reason.")
                if existing is None:
                    connection.execute(
                        "INSERT INTO teaching_followup_voids(attempt_id, voided_at, reason) VALUES (?, ?, ?)",
                        (attempt_id, time.time(), reason),
                    )
                result = self._attempt_content(connection, original)
                connection.commit()
                return result
            except BaseException:
                connection.rollback()
                raise


def get_followup_store() -> FollowupStore:
    """Resolve the current request's scope without sharing a cached handle."""
    return FollowupStore()


__all__ = [
    "FollowupConflict",
    "FollowupSourceConflict",
    "FollowupNotFound",
    "FollowupValidationError",
    "FollowupStore",
    "get_followup_store",
]
