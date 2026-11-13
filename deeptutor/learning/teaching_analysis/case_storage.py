"""Immutable student-case snapshots with explicit, versioned report pins."""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import time
from typing import Iterator
from uuid import UUID

from pydantic import ValidationError

from deeptutor.services.path_service import get_path_service
from deeptutor.utils.secret_files import ensure_private_directory, ensure_private_file

from .case_models import SavedStudentCase, SaveStudentCaseRequest, StudentCaseSummary
from .storage import TeachingAnalysisStore, _assert_unredirected


class CaseNotFound(LookupError):
    """No such student case exists in the current workspace."""


class CaseConflict(ValueError):
    """A case or the timeline dataset changed since it was read."""


class CaseSourceConflict(CaseConflict):
    """A newly selected pin is unavailable or is not a confirmed report."""


class CaseValidationError(ValueError):
    """A request field or cursor must be corrected before continuing."""


def _canonical(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _case_id(identifier: str | UUID) -> str:
    try:
        return str(UUID(str(identifier)))
    except (ValueError, TypeError, AttributeError):
        raise CaseValidationError("A valid student case id is required.") from None


def _pagination(limit: int, offset: int = 0) -> None:
    if type(limit) is not int or not 1 <= limit <= 100 or type(offset) is not int or offset < 0:
        raise CaseValidationError("Use a page size from 1 to 100 and a nonnegative offset.")


class StudentCaseStore:
    """A request-local handle; names are labels and never identity keys."""

    def __init__(self, root: Path | None = None) -> None:
        self.root = Path(
            root
            if root is not None
            else get_path_service().get_workspace_dir() / "teaching-analysis"
        ).absolute()
        self.db_path = self.root / "student_cases.sqlite3"
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
        try:
            connection.execute("PRAGMA busy_timeout=15000")
            connection.execute("PRAGMA synchronous=FULL")
            if create:
                connection.execute(
                    """CREATE TABLE IF NOT EXISTS student_case_revisions (
                        case_id TEXT NOT NULL,
                        revision INTEGER NOT NULL CHECK(revision > 0),
                        request_hash TEXT NOT NULL,
                        content_json TEXT NOT NULL,
                        archived INTEGER NOT NULL CHECK(archived IN (0,1)),
                        updated_at REAL NOT NULL,
                        PRIMARY KEY(case_id, revision)
                    )"""
                )
                ensure_private_file(self.db_path)
            yield connection
        finally:
            connection.close()

    @staticmethod
    def _content(row: sqlite3.Row) -> SavedStudentCase:
        raw = json.loads(row["content_json"])
        if not isinstance(raw, dict):
            raise ValueError("Stored student-case content is not an object.")
        # Verify the original request fields before defaults or UUID parsing
        # can normalize them. A retry must never return a different intent
        # merely because damaged JSON still fits the public response schema.
        payload = {
            key: value
            for key, value in raw.items()
            if key not in {"revision", "created_at", "updated_at"}
        }
        if hashlib.sha256(_canonical(payload).encode("utf-8")).hexdigest() != row["request_hash"]:
            raise ValueError("Stored student-case content does not match its request receipt.")
        saved = SavedStudentCase.model_validate(raw)
        if (
            str(saved.case_id) != row["case_id"]
            or saved.revision != row["revision"]
            or saved.archived != bool(row["archived"])
            or saved.updated_at != row["updated_at"]
        ):
            raise ValueError("Stored student-case content does not match its row identity.")
        return saved

    def get_case(self, case_id: str | UUID) -> SavedStudentCase:
        identifier = _case_id(case_id)
        with self._connection() as connection:
            row = (
                connection.execute(
                    "SELECT * FROM student_case_revisions WHERE case_id=? ORDER BY revision DESC LIMIT 1",
                    (identifier,),
                ).fetchone()
                if connection is not None
                else None
            )
        if row is None:
            raise CaseNotFound("Student case not found in this workspace.")
        return self._content(row)

    def list_cases(
        self, *, archived: bool = False, limit: int = 100, offset: int = 0
    ) -> list[StudentCaseSummary]:
        _pagination(limit, offset)
        if type(archived) is not bool:
            raise CaseValidationError("Archived must be a boolean.")
        with self._connection() as connection:
            if connection is None:
                return []
            rows = connection.execute(
                """SELECT current.* FROM student_case_revisions current
                    JOIN (SELECT case_id,MAX(revision) AS revision FROM student_case_revisions
                          GROUP BY case_id) latest
                    ON current.case_id=latest.case_id AND current.revision=latest.revision
                    WHERE current.archived=? ORDER BY current.updated_at DESC,current.case_id
                    LIMIT ? OFFSET ?""",
                (int(archived), limit, offset),
            ).fetchall()
        return [
            StudentCaseSummary(
                **saved.model_dump(exclude={"report_refs"}), report_count=len(saved.report_refs)
            )
            for saved in (self._content(row) for row in rows)
        ]

    def revisions(self, case_id: str | UUID, *, limit: int = 100) -> list[SavedStudentCase]:
        identifier = _case_id(case_id)
        _pagination(limit)
        with self._connection() as connection:
            rows = (
                connection.execute(
                    "SELECT * FROM student_case_revisions WHERE case_id=? ORDER BY revision DESC LIMIT ?",
                    (identifier, limit),
                ).fetchall()
                if connection is not None
                else []
            )
        if not rows:
            raise CaseNotFound("Student case not found in this workspace.")
        return [self._content(row) for row in rows]

    def save_case(self, request: SaveStudentCaseRequest) -> SavedStudentCase:
        try:
            request = SaveStudentCaseRequest.model_validate(request)
        except ValidationError:
            raise CaseValidationError(
                "Review the student label and selected report versions."
            ) from None
        payload = request.model_dump(mode="json", exclude={"expected_revision"})
        request_hash = hashlib.sha256(_canonical(payload).encode("utf-8")).hexdigest()
        with self._connection(create=True) as connection:
            assert connection is not None
            connection.execute("BEGIN IMMEDIATE")
            try:
                row = connection.execute(
                    "SELECT * FROM student_case_revisions WHERE case_id=? ORDER BY revision DESC LIMIT 1",
                    (str(request.case_id),),
                ).fetchone()
                previous = self._content(row) if row is not None else None
                current = previous.revision if previous else 0
                if (
                    row is not None
                    and row["request_hash"] == request_hash
                    and request.expected_revision in {current, current - 1}
                ):
                    connection.commit()
                    return previous
                if request.expected_revision != current:
                    raise CaseConflict(
                        "The student case changed. Reload its latest version before saving."
                    )
                retained = (
                    {(str(ref.report_id), ref.report_revision) for ref in previous.report_refs}
                    if previous
                    else set()
                )
                added = [
                    (str(ref.report_id), ref.report_revision)
                    for ref in request.report_refs
                    if (str(ref.report_id), ref.report_revision) not in retained
                ]
                if added:
                    source = TeachingAnalysisStore(self.root)
                    pins, _ = source.pinned_projection(added)
                    from .cases import _validated_report

                    for pair in added:
                        report = pins.get(pair)
                        if report is None:
                            raise CaseSourceConflict(
                                "A selected report version is unavailable in this workspace."
                            )
                        report = _validated_report(report, pair)
                        if report["status"] != "confirmed":
                            raise CaseSourceConflict(
                                "Select a teacher-confirmed report version before linking it."
                            )
                now = time.time()
                saved = SavedStudentCase(
                    **payload,
                    revision=current + 1,
                    created_at=previous.created_at if previous else now,
                    updated_at=now,
                )
                connection.execute(
                    "INSERT INTO student_case_revisions(case_id,revision,request_hash,content_json,archived,updated_at) VALUES(?,?,?,?,?,?)",
                    (
                        str(saved.case_id),
                        saved.revision,
                        request_hash,
                        _canonical(saved.model_dump(mode="json")),
                        int(saved.archived),
                        now,
                    ),
                )
                connection.commit()
                return saved
            except BaseException:
                connection.rollback()
                raise

    def timeline(self, case_id: str | UUID, *, limit: int = 50, cursor: str | None = None):
        from .cases import build_timeline

        _pagination(limit)
        return build_timeline(self, case_id, limit=limit, cursor=cursor)
