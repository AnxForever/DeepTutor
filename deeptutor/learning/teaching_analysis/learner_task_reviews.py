"""Append-only teacher assessments of one already committed student submission.

The central task database is the transaction boundary. No assessment operation
writes an answer, task state, hint event, follow-up attempt or mastery record.
"""

from __future__ import annotations

from collections.abc import Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from enum import Enum
import hashlib
import json
from pathlib import Path
import sqlite3
import time
from typing import Any, Iterator, Literal
from uuid import UUID

from pydantic import ValidationError

from .learner_task_models import TeacherTaskView
from .learner_tasks import LearnerTaskStore, TaskNotFound, TaskValidationError, _actor, _id, _time
from .task_review_models import (
    SavedTaskReview,
    SaveTaskReviewRequest,
    TaskReviewItem,
    TaskReviewState,
    WithdrawTaskReviewRequest,
)


class ReviewNotFound(LookupError):
    """The task or exact assessment is absent from this teacher scope."""


class ReviewConflict(ValueError):
    """The assessment revision, submission or request intent changed."""


class ReviewValidationError(ValueError):
    """Correct assessment input before writing anything."""


def _canonical(value: Any) -> str:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    )


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _identity(scope: str, task_id: str | UUID) -> tuple[str, str]:
    try:
        return _actor(scope, scope=True), _id(task_id)
    except TaskValidationError as exc:
        raise ReviewValidationError(str(exc)) from None


def _bounds(limit: int, offset: int) -> None:
    if type(limit) is not int or not 1 <= limit <= 100 or type(offset) is not int or offset < 0:
        raise ReviewValidationError("Use a page size from 1 to 100 and a nonnegative offset.")


def _exists(connection: sqlite3.Connection) -> bool:
    tables = {
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('student_task_review_revisions','student_task_review_heads')"
        )
    }
    if len(tables) == 1:
        raise ValueError("Stored assessment revisions or their latest-version receipt are missing.")
    return bool(tables)


def _create_schema(connection: sqlite3.Connection) -> None:
    # Explicit statements keep DDL inside the caller's write transaction;
    # executescript would commit that transaction before creating the table.
    connection.execute("""
        CREATE TABLE IF NOT EXISTS student_task_review_revisions (
            task_id TEXT NOT NULL REFERENCES issued_student_tasks(task_id),
            revision INTEGER NOT NULL CHECK(revision>0),
            submission_id TEXT NOT NULL REFERENCES student_task_submissions(submission_id),
            request_id TEXT NOT NULL,operation TEXT NOT NULL CHECK(operation IN ('save','withdraw')),
            teacher_scope_key TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('confirmed','withdrawn')),
            request_hash TEXT NOT NULL,request_json TEXT NOT NULL,
            review_hash TEXT NOT NULL,review_json TEXT NOT NULL,
            reviewer_user_id TEXT NOT NULL,recorded_at REAL NOT NULL,
            PRIMARY KEY(task_id,revision),UNIQUE(task_id,request_id)
        )
    """)
    connection.execute("""
        CREATE TABLE IF NOT EXISTS student_task_review_heads (
            task_id TEXT PRIMARY KEY REFERENCES issued_student_tasks(task_id),
            submission_id TEXT NOT NULL REFERENCES student_task_submissions(submission_id),
            teacher_scope_key TEXT NOT NULL,latest_revision INTEGER NOT NULL CHECK(latest_revision>0),
            history_hash TEXT NOT NULL,head_hash TEXT NOT NULL,head_json TEXT NOT NULL
        )
    """)


def _history_hash(rows: list[sqlite3.Row]) -> str:
    return _digest([[row["revision"], row["request_hash"], row["review_hash"]] for row in rows])


@dataclass(frozen=True)
class _Source:
    task: TeacherTaskView
    receipt_hash: str | None


@dataclass(frozen=True)
class ReviewProjection:
    """Teacher-only projection for an explicitly selected case evidence pin."""

    review: SavedTaskReview | None
    latest_review: SavedTaskReview | None
    task: TeacherTaskView | None


class _ConnectionDefault(Enum):
    OPEN = "open"


class TaskReviewStore:
    def __init__(
        self, root: Path | None = None, *, task_store: LearnerTaskStore | None = None
    ) -> None:
        if root is not None and task_store is not None:
            raise ValueError("Provide either a central root or an existing task store.")
        self.task_store = task_store if task_store is not None else LearnerTaskStore(root)
        self.root, self.db_path = self.task_store.root, self.task_store.db_path

    @contextmanager
    def read_connection(self) -> Iterator[sqlite3.Connection | None]:
        """Keep one protected central snapshot open until the caller exits."""
        with self.task_store._connection() as connection:
            if connection is not None:
                connection.execute("BEGIN")
            yield connection

    def _source(self, connection: sqlite3.Connection | None, scope: str, task_id: str) -> _Source:
        try:
            bundle = self.task_store._load(connection, task_id, scope=scope)
        except TaskNotFound:
            if connection is not None and _exists(connection):
                orphan = connection.execute(
                    """SELECT 1 FROM student_task_review_revisions r
                    LEFT JOIN issued_student_tasks t ON t.task_id=r.task_id
                    WHERE r.task_id=? AND t.task_id IS NULL LIMIT 1""",
                    (task_id,),
                ).fetchone()
                if orphan is not None:
                    raise ValueError("Stored assessments have no matching task receipt.") from None
            raise ReviewNotFound("Task not found.") from None
        task = self.task_store._teacher_view(bundle)
        receipt = None
        if task.submission is not None:
            assert connection is not None
            row = connection.execute(
                "SELECT submission_hash FROM student_task_submissions WHERE task_id=?",
                (task_id,),
            ).fetchone()
            if row is None:
                raise ValueError("The immutable submission receipt is missing.")
            receipt = row["submission_hash"]
        return _Source(task, receipt)

    @staticmethod
    def _metadata(source: _Source) -> dict:
        task = source.task
        if task.submission is None or source.receipt_hash is None:
            raise ReviewConflict("A final student submission is required before assessment.")
        snapshot = task.source_snapshot
        return {
            "task_id": task.task_id,
            "submission_id": task.submission.submission_id,
            "recipient_user_id": task.recipient_user_id,
            "report_id": snapshot.report_id,
            "report_revision": snapshot.report_revision,
            "followup_id": task.followup_id,
            "followup_revision": task.followup_revision,
            "subject": snapshot.subject,
            "knowledge_point": snapshot.knowledge_point,
            "submission_receipt_hash": source.receipt_hash,
        }

    @staticmethod
    def _items(source: _Source, items: list[TaskReviewItem]) -> list[TaskReviewItem]:
        task = source.task
        if task.submission is None:
            raise ReviewConflict("A final student submission is required before assessment.")
        by_id = {item.question_id: item for item in items}
        question_ids = [question.question_id for question in task.source_snapshot.questions]
        if len(by_id) != len(items) or set(by_id) != set(question_ids):
            raise ReviewValidationError("Assess exactly the questions in this submitted task.")
        for response in task.submission.responses:
            if (response.answer is None or not response.answer.strip()) and by_id[
                response.question_id
            ].result != "ungraded":
                raise ReviewValidationError(
                    "A response without actual answer text must stay ungraded."
                )
        return [by_id[qid] for qid in question_ids]

    @staticmethod
    def _intent(scope: str, task_id: str, operation: str, raw_request: dict) -> dict:
        return {
            "teacher_scope_key": scope,
            "task_id": task_id,
            "operation": operation,
            "request": raw_request,
        }

    def _content(
        self, row: sqlite3.Row, source: _Source, scope: str, previous: SavedTaskReview | None
    ) -> SavedTaskReview:
        raw = json.loads(row["review_json"])
        request_raw = json.loads(row["request_json"])
        task_id = str(source.task.task_id)
        if (
            not isinstance(raw, dict)
            or not isinstance(request_raw, dict)
            or _digest(raw) != row["review_hash"]
            or _digest(self._intent(scope, task_id, row["operation"], request_raw))
            != row["request_hash"]
        ):
            raise ValueError("Stored assessment content does not match its receipts.")
        review = SavedTaskReview.model_validate(raw)
        if (
            str(review.task_id) != row["task_id"]
            or review.revision != row["revision"]
            or str(review.submission_id) != row["submission_id"]
            or str(review.request_id) != row["request_id"]
            or review.status != row["status"]
            or row["teacher_scope_key"] != scope
            or review.reviewer_user_id != row["reviewer_user_id"]
            or review.recorded_at != row["recorded_at"]
            or review.revision != (previous.revision + 1 if previous else 1)
            or review.recorded_at < source.task.submission.submitted_at
            or (previous is not None and review.recorded_at < previous.recorded_at)
            or any(getattr(review, key) != value for key, value in self._metadata(source).items())
        ):
            raise ValueError("Stored assessment does not match its source or row identity.")
        try:
            if self._items(source, review.items) != review.items:
                raise ValueError("Stored assessment questions are not in source order.")
            if row["operation"] == "save":
                request = SaveTaskReviewRequest.model_validate(request_raw)
                valid = (
                    review.status == "confirmed"
                    and request.submission_id == review.submission_id
                    and request.request_id == review.request_id
                    and request.expected_revision == review.revision - 1
                    and self._items(source, request.items) == review.items
                    and request.summary == review.summary
                    and request.change_reason == review.change_reason
                )
            elif row["operation"] == "withdraw":
                withdrawal = WithdrawTaskReviewRequest.model_validate(request_raw)
                valid = (
                    previous is not None
                    and previous.status == "confirmed"
                    and review.status == "withdrawn"
                    and withdrawal.request_id == review.request_id
                    and withdrawal.expected_revision == previous.revision
                    and review.items == previous.items
                    and review.summary == previous.summary
                    and review.change_reason == withdrawal.reason
                )
            else:
                valid = False
        except (ReviewConflict, ReviewValidationError):
            raise ValueError("Stored assessment has invalid source questions.") from None
        if not valid:
            raise ValueError("Stored assessment differs from its original request.")
        return review

    def _history(
        self, connection: sqlite3.Connection | None, source: _Source, scope: str
    ) -> list[SavedTaskReview]:
        if connection is None or not _exists(connection):
            return []
        # The actual task's ownership is checked before any private JSON is
        # decoded. A damaged redundant scope column cannot hide a review row.
        rows = connection.execute(
            """SELECT r.* FROM student_task_review_revisions r
            JOIN issued_student_tasks t ON t.task_id=r.task_id
            WHERE t.teacher_scope_key=? AND r.task_id=? ORDER BY r.revision""",
            (scope, str(source.task.task_id)),
        ).fetchall()
        if rows and source.task.submission is None:
            raise ValueError("An assessment exists without an immutable submission.")
        self._check_head(connection, source, scope, rows)
        history: list[SavedTaskReview] = []
        for row in rows:
            history.append(self._content(row, source, scope, history[-1] if history else None))
        return history

    @staticmethod
    def _check_head(
        connection: sqlite3.Connection, source: _Source, scope: str, rows: list[sqlite3.Row]
    ) -> None:
        head = connection.execute(
            "SELECT * FROM student_task_review_heads WHERE task_id=?",
            (str(source.task.task_id),),
        ).fetchone()
        if head is None:
            if rows:
                raise ValueError("Stored assessment history has no latest-version receipt.")
            return
        raw = json.loads(head["head_json"])
        expected = {
            "task_id": str(source.task.task_id),
            "submission_id": str(source.task.submission.submission_id)
            if source.task.submission
            else None,
            "teacher_scope_key": scope,
            "latest_revision": len(rows),
            "history_hash": _history_hash(rows),
        }
        if (
            not isinstance(raw, dict)
            or _digest(raw) != head["head_hash"]
            or type(raw.get("latest_revision")) is not int
            or not rows
            or raw != expected
            or any(head[key] != value for key, value in expected.items())
        ):
            raise ValueError("Assessment history does not match its latest-version receipt.")

    @staticmethod
    def _put_head(connection: sqlite3.Connection, source: _Source, scope: str) -> None:
        task_id = str(source.task.task_id)
        rows = connection.execute(
            "SELECT revision,request_hash,review_hash FROM student_task_review_revisions WHERE task_id=? ORDER BY revision",
            (task_id,),
        ).fetchall()
        if not rows or source.task.submission is None:
            raise ValueError("A latest-version receipt needs an assessed immutable submission.")
        raw = {
            "task_id": task_id,
            "submission_id": str(source.task.submission.submission_id),
            "teacher_scope_key": scope,
            "latest_revision": len(rows),
            "history_hash": _history_hash(rows),
        }
        connection.execute(
            """INSERT INTO student_task_review_heads VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(task_id) DO UPDATE SET submission_id=excluded.submission_id,
            teacher_scope_key=excluded.teacher_scope_key,latest_revision=excluded.latest_revision,
            history_hash=excluded.history_hash,head_hash=excluded.head_hash,head_json=excluded.head_json""",
            (
                task_id,
                raw["submission_id"],
                scope,
                len(rows),
                raw["history_hash"],
                _digest(raw),
                _canonical(raw),
            ),
        )

    def get_review_state(self, teacher_scope_key: str, task_id: str | UUID) -> TaskReviewState:
        scope, identifier = _identity(teacher_scope_key, task_id)
        with self.read_connection() as connection:
            source = self._source(connection, scope, identifier)
            history = self._history(connection, source, scope)
            return TaskReviewState(
                task_id=source.task.task_id,
                submission_id=source.task.submission.submission_id
                if source.task.submission
                else None,
                task_status=source.task.status,
                current_review=history[-1] if history else None,
            )

    def get_review(
        self, teacher_scope_key: str, task_id: str | UUID, revision: int
    ) -> SavedTaskReview:
        scope, identifier = _identity(teacher_scope_key, task_id)
        if type(revision) is not int or revision < 1:
            raise ReviewValidationError("Use a positive assessment revision.")
        with self.read_connection() as connection:
            source = self._source(connection, scope, identifier)
            history = self._history(connection, source, scope)
            if revision > len(history):
                raise ReviewNotFound("Assessment version not found.")
            return history[revision - 1]

    def review_revisions(
        self, teacher_scope_key: str, task_id: str | UUID, *, limit: int = 100, offset: int = 0
    ) -> list[SavedTaskReview]:
        scope, identifier = _identity(teacher_scope_key, task_id)
        _bounds(limit, offset)
        with self.read_connection() as connection:
            source = self._source(connection, scope, identifier)
            history = self._history(connection, source, scope)
            return list(reversed(history))[offset : offset + limit]

    def _write(
        self,
        scope: str,
        task_id: str,
        payload: SaveTaskReviewRequest | WithdrawTaskReviewRequest,
        reviewer: str,
        operation: Literal["save", "withdraw"],
    ) -> SavedTaskReview:
        request_raw = payload.model_dump(mode="json")
        request_hash = _digest(self._intent(scope, task_id, operation, request_raw))
        with self.task_store._connection() as connection:
            if connection is None:
                raise ReviewNotFound("Task not found.")
            connection.execute("BEGIN IMMEDIATE")
            try:
                source = self._source(connection, scope, task_id)
                metadata = self._metadata(source)
                history = self._history(connection, source, scope)
                for old in history:
                    if old.request_id == payload.request_id:
                        row = connection.execute(
                            "SELECT request_hash FROM student_task_review_revisions WHERE task_id=? AND request_id=?",
                            (task_id, str(payload.request_id)),
                        ).fetchone()
                        if row is None or row["request_hash"] != request_hash:
                            raise ReviewConflict(
                                "This assessment request id was already used for different content."
                            )
                        connection.commit()
                        return old
                previous = history[-1] if history else None
                current = previous.revision if previous else 0
                if payload.expected_revision != current:
                    raise ReviewConflict(
                        "The assessment changed. Reload before confirming another version."
                    )
                if isinstance(payload, SaveTaskReviewRequest):
                    if payload.submission_id != metadata["submission_id"]:
                        raise ReviewConflict(
                            "This assessment does not refer to the final submission."
                        )
                    if current and not payload.change_reason.strip():
                        raise ReviewValidationError(
                            "Explain the assessment correction before confirming it."
                        )
                    items = self._items(source, payload.items)
                    summary, reason, status = payload.summary, payload.change_reason, "confirmed"
                else:
                    if previous is None or previous.status != "confirmed":
                        raise ReviewConflict(
                            "There is no current confirmed assessment to withdraw."
                        )
                    items, summary = previous.items, previous.summary
                    reason, status = payload.reason, "withdrawn"
                now = max(
                    _time(time.time()),
                    source.task.submission.submitted_at,
                    previous.recorded_at if previous else 0,
                )
                review = SavedTaskReview(
                    **metadata,
                    request_id=payload.request_id,
                    revision=current + 1,
                    status=status,
                    items=items,
                    summary=summary,
                    change_reason=reason,
                    reviewer_user_id=reviewer,
                    recorded_at=now,
                )
                raw = review.model_dump(mode="json")
                _create_schema(connection)
                connection.execute(
                    "INSERT INTO student_task_review_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        task_id,
                        review.revision,
                        str(review.submission_id),
                        str(payload.request_id),
                        operation,
                        scope,
                        review.status,
                        request_hash,
                        _canonical(request_raw),
                        _digest(raw),
                        _canonical(raw),
                        reviewer,
                        now,
                    ),
                )
                self._put_head(connection, source, scope)
                # Verify the same typed receipt path used by all reads before
                # committing the new version; failures roll back the DDL too.
                saved = self._history(connection, source, scope)[-1]
                connection.commit()
                return saved
            except BaseException:
                connection.rollback()
                raise

    def save_review(
        self,
        teacher_scope_key: str,
        task_id: str | UUID,
        payload: SaveTaskReviewRequest,
        *,
        reviewer_user_id: str,
    ) -> SavedTaskReview:
        scope, identifier = _identity(teacher_scope_key, task_id)
        try:
            request = SaveTaskReviewRequest.model_validate(payload)
            reviewer = _actor(reviewer_user_id)
        except (ValidationError, TaskValidationError):
            raise ReviewValidationError(
                "Review the assessment fields and reviewer account."
            ) from None
        return self._write(scope, identifier, request, reviewer, "save")

    def withdraw_review(
        self,
        teacher_scope_key: str,
        task_id: str | UUID,
        payload: WithdrawTaskReviewRequest,
        *,
        reviewer_user_id: str,
    ) -> SavedTaskReview:
        scope, identifier = _identity(teacher_scope_key, task_id)
        try:
            request = WithdrawTaskReviewRequest.model_validate(payload)
            reviewer = _actor(reviewer_user_id)
        except (ValidationError, TaskValidationError):
            raise ReviewValidationError(
                "Give the current assessment revision and withdrawal reason."
            ) from None
        return self._write(scope, identifier, request, reviewer, "withdraw")

    def project_refs(
        self,
        teacher_scope_key: str,
        refs: Sequence[tuple[str | UUID, int]],
        *,
        connection: sqlite3.Connection | None | _ConnectionDefault = _ConnectionDefault.OPEN,
    ) -> dict[tuple[str, int], ReviewProjection]:
        if len(refs) > 20:
            raise ReviewValidationError("Select no more than 20 assessment references.")
        normalized: list[tuple[str, int]] = []
        for identifier, revision in refs:
            _, task_id = _identity(teacher_scope_key, identifier)
            if type(revision) is not int or revision < 1:
                raise ReviewValidationError("Use positive assessment revisions.")
            normalized.append((task_id, revision))
        try:
            scope = _actor(teacher_scope_key, scope=True)
        except TaskValidationError as exc:
            raise ReviewValidationError(str(exc)) from None
        if connection is _ConnectionDefault.OPEN:
            with self.read_connection() as opened:
                return self.project_refs(scope, normalized, connection=opened)
        if connection is not None and not isinstance(connection, sqlite3.Connection):
            raise ReviewValidationError("Use a protected central read connection.")
        result: dict[tuple[str, int], ReviewProjection] = {}
        sources: dict[str, _Source | None] = {}
        histories: dict[str, list[SavedTaskReview]] = {}
        for task_id, revision in normalized:
            if task_id not in sources:
                try:
                    source = self._source(connection, scope, task_id)
                except ReviewNotFound:
                    source = None
                sources[task_id] = source
                histories[task_id] = self._history(connection, source, scope) if source else []
            source, history = sources[task_id], histories[task_id]
            result[(task_id, revision)] = ReviewProjection(
                review=history[revision - 1] if revision <= len(history) else None,
                latest_review=history[-1] if history else None,
                task=source.task if source else None,
            )
        return result


def get_task_review_store() -> TaskReviewStore:
    return TaskReviewStore()


__all__ = [
    "TaskReviewStore",
    "ReviewProjection",
    "ReviewNotFound",
    "ReviewConflict",
    "ReviewValidationError",
    "get_task_review_store",
]
