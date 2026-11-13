"""Central, recipient-bound short tasks; no teacher filesystem or model access.

The API verifies live authentication and publication policy. This store requires
trusted actor/scope arguments and always checks them before constructing views.
Issued source snapshots and final submissions are immutable. Drafts are CAS
state; their receipts never become independent assessment attempts.
"""

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
from typing import Any, Iterator
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from deeptutor.utils.secret_files import ensure_private_directory, ensure_private_file

from .followup_models import SavedFollowup
from .learner_task_models import (
    IssueTaskRequest,
    RevokeTaskRequest,
    SaveTaskProgressRequest,
    StudentSubmission,
    StudentTaskProgress,
    StudentTaskQuestion,
    StudentTaskSummary,
    StudentTaskView,
    SubmitTaskRequest,
    TaskResponse,
    TaskStatus,
    TeacherTaskProgress,
    TeacherTaskSummary,
    TeacherTaskView,
)
from .storage import _assert_unredirected


class TaskNotFound(LookupError):
    """The task is absent or is not owned by this recipient/teacher scope."""


class TaskConflict(ValueError):
    """A revision or an idempotency intent changed."""


class TaskRevoked(TaskConflict):
    """The teacher revoked the task; existing data remains readable."""


class TaskValidationError(ValueError):
    """Correct a request before writing anything."""


def _canonical(value: Any) -> str:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    )


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _receipt_valid(raw: Any, expected: Any) -> int:
    try:
        payload = json.loads(raw)
        return int(isinstance(payload, dict) and _digest(payload) == expected)
    except (ValueError, TypeError, UnicodeError):
        return 0


def _intent_valid(task_id: str, recipient: str, raw: Any, expected: Any) -> int:
    try:
        payload = json.loads(raw)
        return int(
            isinstance(payload, dict)
            and _digest({"task_id": task_id, "recipient_user_id": recipient, "request": payload})
            == expected
        )
    except (ValueError, TypeError, UnicodeError):
        return 0


def _id(value: str | UUID) -> str:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError, AttributeError):
        raise TaskValidationError("Use a valid task identifier.") from None


def _actor(value: str, *, scope: bool = False) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > (512 if scope else 64):
        raise TaskValidationError("A valid account or teacher scope is required.")
    try:
        value.encode("utf-8")
    except UnicodeError:
        raise TaskValidationError("Account and scope identifiers must be valid Unicode.") from None
    return value


def _bounds(limit: int, offset: int) -> None:
    if type(limit) is not int or not 1 <= limit <= 100 or type(offset) is not int or offset < 0:
        raise TaskValidationError("Use a page size from 1 to 100 and a nonnegative offset.")


def _time(value: Any) -> float:
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        raise ValueError("Stored task timestamps must be finite and nonnegative.")
    return float(value)


class _Issue(BaseModel):
    model_config = ConfigDict(extra="forbid", revalidate_instances="always")
    request: IssueTaskRequest
    teacher_scope_key: str
    issued_by_user_id: str
    source_snapshot: SavedFollowup
    issued_at: float = Field(ge=0, allow_inf_nan=False, strict=True)


class _State(BaseModel):
    model_config = ConfigDict(extra="forbid", revalidate_instances="always")
    task_id: UUID
    revision: int = Field(ge=1, strict=True)
    status: TaskStatus
    updated_at: float = Field(ge=0, allow_inf_nan=False, strict=True)
    started_at: float | None = Field(default=None, ge=0, allow_inf_nan=False, strict=True)
    submitted_at: float | None = Field(default=None, ge=0, allow_inf_nan=False, strict=True)
    revoked_at: float | None = Field(default=None, ge=0, allow_inf_nan=False, strict=True)
    revoke_request: RevokeTaskRequest | None = None


@dataclass(frozen=True)
class _Bundle:
    issue: _Issue
    state: _State
    progress: StudentTaskProgress
    submission: StudentSubmission | None


def _checked_json(row: sqlite3.Row, content: str, digest: str) -> dict[str, Any]:
    value = json.loads(row[content])
    if not isinstance(value, dict) or _digest(value) != row[digest]:
        raise ValueError("Stored task content does not match its receipt.")
    return value


def _responses(issue: _Issue, responses: list[TaskResponse]) -> list[TaskResponse]:
    ids = [question.question_id for question in issue.source_snapshot.questions]
    by_id = {response.question_id: response for response in responses}
    if len(by_id) != len(responses) or set(by_id) != set(ids):
        raise TaskValidationError("Provide exactly one response state for every assigned question.")
    return [by_id[identifier] for identifier in ids]


class LearnerTaskStore:
    def __init__(self, root: Path | None = None) -> None:
        if root is None:
            from deeptutor.multi_user import paths

            root = paths.SYSTEM_ROOT
        self.root = Path(root).absolute()
        self.db_path = self.root / "student_tasks.sqlite3"
        self._assert_paths()

    def _assert_paths(self) -> None:
        _assert_unredirected(self.root)
        for suffix in ("", "-journal", "-wal", "-shm"):
            _assert_unredirected(Path(str(self.db_path) + suffix))

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
            self.db_path.as_uri() + "?mode=rw", uri=True, timeout=15, isolation_level=None
        )
        connection.row_factory = sqlite3.Row
        connection.create_function("task_receipt_valid", 2, _receipt_valid, deterministic=True)
        connection.create_function("task_intent_valid", 4, _intent_valid, deterministic=True)
        try:
            connection.execute("PRAGMA busy_timeout=15000")
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA synchronous=FULL")
            if create:
                connection.executescript("""
                    CREATE TABLE IF NOT EXISTS issued_student_tasks (
                        task_id TEXT PRIMARY KEY,teacher_scope_key TEXT NOT NULL,recipient_user_id TEXT NOT NULL,
                        issuer_user_id TEXT NOT NULL,intent_hash TEXT NOT NULL,issue_hash TEXT NOT NULL,
                        issue_json TEXT NOT NULL,issued_at REAL NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS student_task_recipient ON issued_student_tasks(recipient_user_id,issued_at DESC);
                    CREATE INDEX IF NOT EXISTS student_task_teacher ON issued_student_tasks(teacher_scope_key,issued_at DESC);
                    CREATE TABLE IF NOT EXISTS student_task_states (
                        task_id TEXT NOT NULL REFERENCES issued_student_tasks(task_id),revision INTEGER NOT NULL CHECK(revision>0),
                        status TEXT NOT NULL CHECK(status IN ('pending','in_progress','submitted','revoked')),
                        state_hash TEXT NOT NULL,state_json TEXT NOT NULL,updated_at REAL NOT NULL,
                        PRIMARY KEY(task_id,revision)
                    );
                    CREATE TABLE IF NOT EXISTS student_task_progress (
                        task_id TEXT PRIMARY KEY REFERENCES issued_student_tasks(task_id),revision INTEGER NOT NULL CHECK(revision>=0),
                        progress_hash TEXT NOT NULL,progress_json TEXT NOT NULL,saved_at REAL
                    );
                    CREATE TABLE IF NOT EXISTS student_task_save_receipts (
                        task_id TEXT NOT NULL REFERENCES issued_student_tasks(task_id),request_id TEXT NOT NULL,
                        request_hash TEXT NOT NULL,request_json TEXT NOT NULL,progress_revision INTEGER NOT NULL CHECK(progress_revision>0),
                        PRIMARY KEY(task_id,request_id)
                    );
                    CREATE TABLE IF NOT EXISTS student_task_submissions (
                        task_id TEXT PRIMARY KEY REFERENCES issued_student_tasks(task_id),submission_id TEXT UNIQUE NOT NULL,
                        request_hash TEXT NOT NULL,request_json TEXT NOT NULL,submission_hash TEXT NOT NULL,
                        submission_json TEXT NOT NULL,progress_revision INTEGER NOT NULL CHECK(progress_revision>0),submitted_at REAL NOT NULL
                    );
                """)
                ensure_private_file(self.db_path)
            yield connection
        finally:
            connection.close()

    @staticmethod
    def _intent(scope: str, request: IssueTaskRequest) -> dict:
        return {"teacher_scope_key": scope, "request": request.model_dump(mode="json")}

    @staticmethod
    def _answer_intent(task_id: str, recipient: str, request: Any) -> dict:
        return {
            "task_id": task_id,
            "recipient_user_id": recipient,
            "request": request.model_dump(mode="json"),
        }

    @staticmethod
    def _put_state(connection: sqlite3.Connection, state: _State) -> None:
        value = state.model_dump(mode="json")
        connection.execute(
            "INSERT INTO student_task_states VALUES(?,?,?,?,?,?)",
            (
                str(state.task_id),
                state.revision,
                state.status,
                _digest(value),
                _canonical(value),
                state.updated_at,
            ),
        )

    @staticmethod
    def _put_progress(
        connection: sqlite3.Connection,
        task_id: str,
        progress: StudentTaskProgress,
        *,
        create: bool = False,
    ) -> None:
        value = progress.model_dump(mode="json")
        if create:
            connection.execute(
                "INSERT INTO student_task_progress VALUES(?,?,?,?,?)",
                (task_id, progress.revision, _digest(value), _canonical(value), progress.saved_at),
            )
        else:
            connection.execute(
                "UPDATE student_task_progress SET revision=?,progress_hash=?,progress_json=?,saved_at=? WHERE task_id=?",
                (progress.revision, _digest(value), _canonical(value), progress.saved_at, task_id),
            )

    def _load(
        self,
        connection: sqlite3.Connection | None,
        task_id: str,
        *,
        recipient: str | None = None,
        scope: str | None = None,
    ) -> _Bundle:
        if connection is None:
            raise TaskNotFound("Task not found.")
        # Both query shapes bind their authorization key; student-supplied
        # labels/workspace paths never select a teacher store or another user.
        if recipient is not None:
            row = connection.execute(
                "SELECT * FROM issued_student_tasks WHERE task_id=? AND recipient_user_id=?",
                (task_id, recipient),
            ).fetchone()
        else:
            row = connection.execute(
                "SELECT * FROM issued_student_tasks WHERE task_id=? AND teacher_scope_key=?",
                (task_id, scope),
            ).fetchone()
        if row is None:
            raise TaskNotFound("Task not found.")
        raw = _checked_json(row, "issue_json", "issue_hash")
        issue = _Issue.model_validate(raw)
        if (
            str(issue.request.task_id) != row["task_id"]
            or issue.teacher_scope_key != row["teacher_scope_key"]
            or issue.request.recipient_user_id != row["recipient_user_id"]
            or issue.issued_by_user_id != row["issuer_user_id"]
            or issue.issued_at != row["issued_at"]
            or _digest(self._intent(issue.teacher_scope_key, issue.request)) != row["intent_hash"]
            or issue.request.followup_id != issue.source_snapshot.followup_id
            or issue.request.followup_revision != issue.source_snapshot.revision
        ):
            raise ValueError("Task issue does not match its stored identity.")
        state_row = connection.execute(
            "SELECT * FROM student_task_states WHERE task_id=? ORDER BY revision DESC LIMIT 1",
            (task_id,),
        ).fetchone()
        progress_row = connection.execute(
            "SELECT * FROM student_task_progress WHERE task_id=?", (task_id,)
        ).fetchone()
        if state_row is None or progress_row is None:
            raise ValueError("Task state or progress is missing.")
        state = _State.model_validate(_checked_json(state_row, "state_json", "state_hash"))
        progress = StudentTaskProgress.model_validate(
            _checked_json(progress_row, "progress_json", "progress_hash")
        )
        if (
            str(state.task_id) != task_id
            or state.revision != state_row["revision"]
            or state.status != state_row["status"]
            or state.updated_at != state_row["updated_at"]
            or progress.revision != progress_row["revision"]
            or progress.saved_at != progress_row["saved_at"]
            or progress.current_question_index >= len(issue.source_snapshot.questions)
        ):
            raise ValueError("Task state does not match its row.")
        try:
            normalized = _responses(issue, progress.responses)
        except TaskValidationError:
            raise ValueError("Stored progress does not match the issued questions.") from None
        if normalized != progress.responses or (progress.revision == 0) != (
            progress.saved_at is None
        ):
            raise ValueError("Stored progress has invalid ordering or timestamps.")
        if state.status == "pending" and (
            state.revision != 1 or progress.revision != 0 or state.started_at is not None
        ):
            raise ValueError("Pending task state is inconsistent.")
        if state.status == "in_progress" and (state.started_at is None or progress.revision == 0):
            raise ValueError("Started task state is inconsistent.")
        if state.status == "revoked":
            if (
                state.revoked_at is None
                or state.revoke_request is None
                or state.revoke_request.expected_revision != state.revision - 1
                or state.updated_at != state.revoked_at
            ):
                raise ValueError("Revoked task has no matching audit receipt.")
        elif state.revoked_at is not None or state.revoke_request is not None:
            raise ValueError("Non-revoked task contains revoke state.")
        if state.updated_at < issue.issued_at or (
            progress.saved_at is not None and progress.saved_at < issue.issued_at
        ):
            raise ValueError("Task timestamps precede issuance.")
        submission_row = connection.execute(
            "SELECT * FROM student_task_submissions WHERE task_id=?", (task_id,)
        ).fetchone()
        submission = None
        if submission_row is not None:
            request_raw = json.loads(submission_row["request_json"])
            request = SubmitTaskRequest.model_validate(request_raw)
            if (
                _digest(self._answer_intent(task_id, issue.request.recipient_user_id, request))
                != submission_row["request_hash"]
            ):
                raise ValueError("Submission intent does not match its receipt.")
            submission = StudentSubmission.model_validate(
                _checked_json(submission_row, "submission_json", "submission_hash")
            )
            if (
                str(submission.task_id) != task_id
                or str(submission.submission_id) != submission_row["submission_id"]
                or submission.submission_id != request.submission_id
                or submission.submitted_at != submission_row["submitted_at"]
                or submission.responses != request.responses
                or submission.responses != progress.responses
                or submission_row["progress_revision"] != progress.revision
                or progress.revision != request.expected_revision + 1
                or progress.saved_at != submission.submitted_at
                or state.submitted_at != submission.submitted_at
                or state.status not in {"submitted", "revoked"}
            ):
                raise ValueError("Submission, final progress and lifecycle are inconsistent.")
        elif state.submitted_at is not None or state.status == "submitted":
            raise ValueError("Submitted task is missing its immutable receipt.")
        return _Bundle(issue, state, progress, submission)

    @staticmethod
    def _student_view(bundle: _Bundle) -> StudentTaskView:
        issue, state, progress = bundle.issue, bundle.state, bundle.progress
        # A positive allowlist: never dump or subtract fields from a private
        # SavedFollowup. Future teacher-only fields stay private by default.
        return StudentTaskView(
            task_id=issue.request.task_id,
            title=issue.request.title,
            instructions=issue.request.instructions,
            task_revision=state.revision,
            issued_at=issue.issued_at,
            status=state.status,
            questions=[
                StudentTaskQuestion(question_id=q.question_id, question=q.question)
                for q in issue.source_snapshot.questions
            ],
            progress=progress,
            submission=bundle.submission,
        )

    @staticmethod
    def _teacher_view(bundle: _Bundle) -> TeacherTaskView:
        issue, state, progress = bundle.issue, bundle.state, bundle.progress
        return TeacherTaskView(
            task_id=issue.request.task_id,
            task_revision=state.revision,
            title=issue.request.title,
            recipient_user_id=issue.request.recipient_user_id,
            followup_id=issue.request.followup_id,
            followup_revision=issue.request.followup_revision,
            status=state.status,
            issued_at=issue.issued_at,
            updated_at=max(state.updated_at, progress.saved_at or issue.issued_at),
            submitted_at=state.submitted_at,
            progress=TeacherTaskProgress(
                revision=progress.revision,
                current_question_index=progress.current_question_index,
                saved_at=progress.saved_at,
            ),
            instructions=issue.request.instructions,
            source_snapshot=issue.source_snapshot,
            submission=bundle.submission,
            started_at=state.started_at,
            revoked_at=state.revoked_at,
            revoke_reason=state.revoke_request.reason if state.revoke_request else None,
            issued_by_user_id=issue.issued_by_user_id,
        )

    @staticmethod
    def _now(bundle: _Bundle | None = None) -> float:
        now = _time(time.time())
        return (
            max(now, bundle.state.updated_at, bundle.progress.saved_at or bundle.issue.issued_at)
            if bundle
            else now
        )

    def issue_task(
        self,
        teacher_scope_key: str,
        payload: IssueTaskRequest,
        snapshot: SavedFollowup | dict | None,
        *,
        issuer_user_id: str,
    ) -> TeacherTaskView:
        scope, issuer = _actor(teacher_scope_key, scope=True), _actor(issuer_user_id)
        try:
            request = IssueTaskRequest.model_validate(payload)
        except ValidationError:
            raise TaskValidationError(
                "Review the task recipient, title and question version."
            ) from None
        intent_hash = _digest(self._intent(scope, request))
        with self._connection(create=True) as connection:
            assert connection is not None
            connection.execute("BEGIN IMMEDIATE")
            try:
                existing = connection.execute(
                    "SELECT * FROM issued_student_tasks WHERE task_id=?", (str(request.task_id),)
                ).fetchone()
                if existing is not None:
                    if (
                        existing["teacher_scope_key"] != scope
                        or existing["intent_hash"] != intent_hash
                    ):
                        raise TaskConflict(
                            "This task id was already used for a different issue request."
                        )
                    result = self._teacher_view(
                        self._load(connection, str(request.task_id), scope=scope)
                    )
                    connection.commit()
                    return result
                try:
                    source = SavedFollowup.model_validate(snapshot)
                    if (
                        source.followup_id != request.followup_id
                        or source.revision != request.followup_revision
                    ):
                        raise ValueError("Source version mismatch")
                    _time(source.created_at)
                    _time(source.updated_at)
                    _digest(source.model_dump(mode="json"))
                except (ValueError, TypeError):
                    raise TaskValidationError(
                        "A verified saved question-set snapshot is required."
                    ) from None
                now = self._now()
                issue = _Issue(
                    request=request,
                    teacher_scope_key=scope,
                    issued_by_user_id=issuer,
                    source_snapshot=source,
                    issued_at=now,
                )
                raw = issue.model_dump(mode="json")
                connection.execute(
                    "INSERT INTO issued_student_tasks VALUES(?,?,?,?,?,?,?,?)",
                    (
                        str(request.task_id),
                        scope,
                        request.recipient_user_id,
                        issuer,
                        intent_hash,
                        _digest(raw),
                        _canonical(raw),
                        now,
                    ),
                )
                self._put_state(
                    connection,
                    _State(task_id=request.task_id, revision=1, status="pending", updated_at=now),
                )
                progress = StudentTaskProgress(
                    revision=0,
                    current_question_index=0,
                    saved_at=None,
                    responses=[
                        TaskResponse(
                            question_id=q.question_id, response_status="unanswered", answer=None
                        )
                        for q in source.questions
                    ],
                )
                self._put_progress(connection, str(request.task_id), progress, create=True)
                result = self._teacher_view(
                    self._load(connection, str(request.task_id), scope=scope)
                )
                connection.commit()
                return result
            except BaseException:
                connection.rollback()
                raise

    def get_teacher_task(self, teacher_scope_key: str, task_id: str | UUID) -> TeacherTaskView:
        scope, identifier = _actor(teacher_scope_key, scope=True), _id(task_id)
        with self._connection() as connection:
            if connection is not None:
                connection.execute("BEGIN")
            return self._teacher_view(self._load(connection, identifier, scope=scope))

    def get_student_task(self, recipient_user_id: str, task_id: str | UUID) -> StudentTaskView:
        recipient, identifier = _actor(recipient_user_id), _id(task_id)
        with self._connection() as connection:
            if connection is not None:
                connection.execute("BEGIN")
            return self._student_view(self._load(connection, identifier, recipient=recipient))

    @staticmethod
    def _active(state: _State) -> None:
        if state.status == "revoked":
            raise TaskRevoked("This task was revoked. Your saved work is retained.")
        if state.status == "submitted":
            raise TaskConflict("This task has already been submitted.")

    def save_progress(
        self, recipient_user_id: str, task_id: str | UUID, payload: SaveTaskProgressRequest
    ) -> StudentTaskView:
        recipient, identifier = _actor(recipient_user_id), _id(task_id)
        try:
            request = SaveTaskProgressRequest.model_validate(payload)
        except ValidationError:
            raise TaskValidationError("Review the answer states and draft revision.") from None
        with self._connection() as connection:
            if connection is None:
                raise TaskNotFound("Task not found.")
            connection.execute("BEGIN IMMEDIATE")
            try:
                bundle = self._load(connection, identifier, recipient=recipient)
                self._active(bundle.state)
                normalized = _responses(bundle.issue, request.responses)
                if request.current_question_index >= len(normalized):
                    raise TaskValidationError("The current question index is outside this task.")
                request = request.model_copy(update={"responses": normalized})
                intent = self._answer_intent(identifier, recipient, request)
                request_hash = _digest(intent)
                receipt = connection.execute(
                    "SELECT * FROM student_task_save_receipts WHERE task_id=? AND request_id=?",
                    (identifier, str(request.request_id)),
                ).fetchone()
                if receipt is not None:
                    recorded = SaveTaskProgressRequest.model_validate(
                        json.loads(receipt["request_json"])
                    )
                    if (
                        str(recorded.request_id) != receipt["request_id"]
                        or _digest(self._answer_intent(identifier, recipient, recorded))
                        != receipt["request_hash"]
                        or receipt["progress_revision"] != recorded.expected_revision + 1
                        or receipt["progress_revision"] > bundle.progress.revision
                    ):
                        raise ValueError("Draft receipt is inconsistent.")
                    if request_hash != receipt["request_hash"]:
                        raise TaskConflict(
                            "This save id was already used for different draft content."
                        )
                    result = self._student_view(bundle)
                    connection.commit()
                    return result
                if request.expected_revision != bundle.progress.revision:
                    raise TaskConflict("The saved draft changed. Reload before saving again.")
                now = self._now(bundle)
                progress = StudentTaskProgress(
                    revision=bundle.progress.revision + 1,
                    current_question_index=request.current_question_index,
                    responses=normalized,
                    saved_at=now,
                )
                self._put_progress(connection, identifier, progress)
                if bundle.state.status == "pending":
                    self._put_state(
                        connection,
                        _State(
                            task_id=identifier,
                            revision=bundle.state.revision + 1,
                            status="in_progress",
                            updated_at=now,
                            started_at=now,
                        ),
                    )
                connection.execute(
                    "INSERT INTO student_task_save_receipts VALUES(?,?,?,?,?)",
                    (
                        identifier,
                        str(request.request_id),
                        request_hash,
                        _canonical(request.model_dump(mode="json")),
                        progress.revision,
                    ),
                )
                result = self._student_view(self._load(connection, identifier, recipient=recipient))
                connection.commit()
                return result
            except BaseException:
                connection.rollback()
                raise

    def submit_task(
        self, recipient_user_id: str, task_id: str | UUID, payload: SubmitTaskRequest
    ) -> StudentTaskView:
        recipient, identifier = _actor(recipient_user_id), _id(task_id)
        try:
            request = SubmitTaskRequest.model_validate(payload)
        except ValidationError:
            raise TaskValidationError("Review every response before submitting.") from None
        with self._connection() as connection:
            if connection is None:
                raise TaskNotFound("Task not found.")
            connection.execute("BEGIN IMMEDIATE")
            try:
                bundle = self._load(connection, identifier, recipient=recipient)
                normalized = _responses(bundle.issue, request.responses)
                request = request.model_copy(update={"responses": normalized})
                request_hash = _digest(self._answer_intent(identifier, recipient, request))
                existing = connection.execute(
                    "SELECT * FROM student_task_submissions WHERE task_id=?", (identifier,)
                ).fetchone()
                if existing is not None:
                    if (
                        existing["submission_id"] != str(request.submission_id)
                        or existing["request_hash"] != request_hash
                    ):
                        raise TaskConflict("This task already has an immutable final submission.")
                    result = self._student_view(bundle)
                    connection.commit()
                    return result
                self._active(bundle.state)
                if request.expected_revision != bundle.progress.revision:
                    raise TaskConflict("The saved draft changed. Reload before submitting.")
                if (
                    connection.execute(
                        "SELECT 1 FROM student_task_submissions WHERE submission_id=?",
                        (str(request.submission_id),),
                    ).fetchone()
                    is not None
                ):
                    raise TaskConflict("This submission id was already used.")
                now = self._now(bundle)
                final = StudentSubmission(
                    task_id=identifier,
                    submission_id=request.submission_id,
                    submitted_at=now,
                    responses=normalized,
                )
                progress = StudentTaskProgress(
                    revision=bundle.progress.revision + 1,
                    current_question_index=len(normalized) - 1,
                    saved_at=now,
                    responses=normalized,
                )
                self._put_progress(connection, identifier, progress)
                self._put_state(
                    connection,
                    _State(
                        task_id=identifier,
                        revision=bundle.state.revision + 1,
                        status="submitted",
                        updated_at=now,
                        started_at=bundle.state.started_at,
                        submitted_at=now,
                    ),
                )
                raw = final.model_dump(mode="json")
                connection.execute(
                    "INSERT INTO student_task_submissions VALUES(?,?,?,?,?,?,?,?)",
                    (
                        identifier,
                        str(request.submission_id),
                        request_hash,
                        _canonical(request.model_dump(mode="json")),
                        _digest(raw),
                        _canonical(raw),
                        progress.revision,
                        now,
                    ),
                )
                result = self._student_view(self._load(connection, identifier, recipient=recipient))
                connection.commit()
                return result
            except BaseException:
                connection.rollback()
                raise

    def revoke_task(
        self, teacher_scope_key: str, task_id: str | UUID, payload: RevokeTaskRequest
    ) -> TeacherTaskView:
        scope, identifier = _actor(teacher_scope_key, scope=True), _id(task_id)
        try:
            request = RevokeTaskRequest.model_validate(payload)
        except ValidationError:
            raise TaskValidationError("Give a reason and the current task revision.") from None
        with self._connection() as connection:
            if connection is None:
                raise TaskNotFound("Task not found.")
            connection.execute("BEGIN IMMEDIATE")
            try:
                bundle = self._load(connection, identifier, scope=scope)
                if bundle.state.status == "revoked":
                    if request != bundle.state.revoke_request:
                        raise TaskConflict("This task was already revoked with another request.")
                    result = self._teacher_view(bundle)
                    connection.commit()
                    return result
                if request.expected_revision != bundle.state.revision:
                    raise TaskConflict("The task status changed. Reload before revoking it.")
                now = self._now(bundle)
                state = bundle.state.model_copy(
                    update={
                        "revision": bundle.state.revision + 1,
                        "status": "revoked",
                        "updated_at": now,
                        "revoked_at": now,
                        "revoke_request": request,
                    }
                )
                self._put_state(connection, _State.model_validate(state))
                result = self._teacher_view(self._load(connection, identifier, scope=scope))
                connection.commit()
                return result
            except BaseException:
                connection.rollback()
                raise

    @staticmethod
    def _list_integrity(connection: sqlite3.Connection, actor: str, *, teacher: bool) -> None:
        # Verify actor-owned records before status/source filters or pagination.
        # A damaged state must not disappear as an apparently empty task list.
        bad = connection.execute(
            """SELECT COUNT(*) FROM issued_student_tasks t
            LEFT JOIN student_task_states s ON s.task_id=t.task_id AND s.revision=(SELECT MAX(revision) FROM student_task_states WHERE task_id=t.task_id)
            LEFT JOIN student_task_progress p ON p.task_id=t.task_id
            LEFT JOIN student_task_submissions u ON u.task_id=t.task_id
            WHERE ((?=1 AND t.teacher_scope_key=?) OR (?=0 AND t.recipient_user_id=?)) AND (
                s.task_id IS NULL OR p.task_id IS NULL
                OR task_receipt_valid(t.issue_json,t.issue_hash)=0
                OR task_receipt_valid(s.state_json,s.state_hash)=0
                OR task_receipt_valid(p.progress_json,p.progress_hash)=0
                OR json_extract(t.issue_json,'$.request.task_id') IS NOT t.task_id
                OR json_extract(t.issue_json,'$.request.recipient_user_id') IS NOT t.recipient_user_id
                OR json_extract(t.issue_json,'$.teacher_scope_key') IS NOT t.teacher_scope_key
                OR json_extract(t.issue_json,'$.issued_by_user_id') IS NOT t.issuer_user_id
                OR json_extract(t.issue_json,'$.issued_at') IS NOT t.issued_at
                OR json_extract(s.state_json,'$.task_id') IS NOT t.task_id
                OR json_extract(s.state_json,'$.revision') IS NOT s.revision
                OR json_extract(s.state_json,'$.status') IS NOT s.status
                OR json_extract(s.state_json,'$.updated_at') IS NOT s.updated_at
                OR json_extract(p.progress_json,'$.revision') IS NOT p.revision
                OR json_extract(p.progress_json,'$.saved_at') IS NOT p.saved_at
                OR json_extract(s.state_json,'$.submitted_at') IS NOT u.submitted_at
                OR (s.status='submitted' AND u.task_id IS NULL)
                OR (s.status IN ('pending','in_progress') AND u.task_id IS NOT NULL)
                OR (s.status='pending' AND (s.revision!=1 OR p.revision!=0 OR json_extract(s.state_json,'$.started_at') IS NOT NULL))
                OR (s.status='in_progress' AND (p.revision=0 OR json_extract(s.state_json,'$.started_at') IS NULL))
                OR (s.status='revoked' AND (json_extract(s.state_json,'$.revoked_at') IS NULL
                    OR json_extract(s.state_json,'$.revoke_request.expected_revision') IS NOT s.revision-1))
                OR (u.task_id IS NOT NULL AND (
                    task_receipt_valid(u.submission_json,u.submission_hash)=0
                    OR task_intent_valid(t.task_id,t.recipient_user_id,u.request_json,u.request_hash)=0
                    OR json_extract(u.submission_json,'$.task_id') IS NOT t.task_id
                    OR json_extract(u.submission_json,'$.submission_id') IS NOT u.submission_id
                    OR json_extract(u.submission_json,'$.submitted_at') IS NOT u.submitted_at
                    OR u.progress_revision IS NOT p.revision
                    OR json_extract(u.request_json,'$.submission_id') IS NOT u.submission_id
                    OR json_extract(u.request_json,'$.expected_revision')+1 IS NOT p.revision
                    OR json_extract(u.submission_json,'$.responses') IS NOT json_extract(p.progress_json,'$.responses')
                    OR json_extract(u.submission_json,'$.responses') IS NOT json_extract(u.request_json,'$.responses')
                ))
            )""",
            (int(teacher), actor, int(teacher), actor),
        ).fetchone()[0]
        if bad:
            raise ValueError("Task list contains inconsistent receipts or lifecycle data.")

    def _list(
        self,
        actor: str,
        *,
        teacher: bool,
        state: str = "active",
        followup_id: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[_Bundle]:
        _bounds(limit, offset)
        if not teacher and state not in {"active", "history"}:
            raise TaskValidationError("Choose active tasks or submission history.")
        with self._connection() as connection:
            if connection is None:
                return []
            connection.execute("BEGIN")
            self._list_integrity(connection, actor, teacher=teacher)
            # Each branch has a fixed authorization column and bound values.
            if teacher:
                rows = connection.execute(
                    """SELECT * FROM issued_student_tasks WHERE teacher_scope_key=?
                    AND (? IS NULL OR json_extract(issue_json,'$.request.followup_id')=?)
                    ORDER BY issued_at DESC,task_id LIMIT ? OFFSET ?""",
                    (actor, followup_id, followup_id, limit, offset),
                ).fetchall()
            else:
                rows = connection.execute(
                    """SELECT t.* FROM issued_student_tasks t
                    JOIN student_task_states s ON s.task_id=t.task_id AND s.revision=(SELECT MAX(revision) FROM student_task_states WHERE task_id=t.task_id)
                    WHERE t.recipient_user_id=? AND ((?='active' AND s.status IN ('pending','in_progress'))
                        OR (?='history' AND s.status IN ('submitted','revoked')))
                    ORDER BY t.issued_at DESC,t.task_id LIMIT ? OFFSET ?""",
                    (actor, state, state, limit, offset),
                ).fetchall()
            return [
                self._load(
                    connection,
                    row["task_id"],
                    scope=actor if teacher else None,
                    recipient=None if teacher else actor,
                )
                for row in rows
            ]

    def list_teacher_tasks(
        self,
        teacher_scope_key: str,
        *,
        followup_id: str | UUID | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[TeacherTaskSummary]:
        scope = _actor(teacher_scope_key, scope=True)
        followup = _id(followup_id) if followup_id is not None else None
        return [
            TeacherTaskSummary.model_validate(
                self._teacher_view(bundle).model_dump(
                    exclude={
                        "instructions",
                        "source_snapshot",
                        "submission",
                        "started_at",
                        "revoked_at",
                        "revoke_reason",
                        "issued_by_user_id",
                    }
                )
            )
            for bundle in self._list(
                scope, teacher=True, followup_id=followup, limit=limit, offset=offset
            )
        ]

    def list_student_tasks(
        self, recipient_user_id: str, *, state: str = "active", limit: int = 100, offset: int = 0
    ) -> list[StudentTaskSummary]:
        recipient = _actor(recipient_user_id)
        return [
            StudentTaskSummary(
                task_id=bundle.issue.request.task_id,
                title=bundle.issue.request.title,
                question_count=len(bundle.issue.source_snapshot.questions),
                status=bundle.state.status,
                issued_at=bundle.issue.issued_at,
                updated_at=max(
                    bundle.state.updated_at, bundle.progress.saved_at or bundle.issue.issued_at
                ),
                submitted_at=bundle.state.submitted_at,
            )
            for bundle in self._list(
                recipient, teacher=False, state=state, limit=limit, offset=offset
            )
        ]


def get_learner_task_store() -> LearnerTaskStore:
    return LearnerTaskStore()


__all__ = [
    "LearnerTaskStore",
    "get_learner_task_store",
    "TaskNotFound",
    "TaskConflict",
    "TaskRevoked",
    "TaskValidationError",
]
