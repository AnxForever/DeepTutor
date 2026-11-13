"""Workspace-local, versioned teacher reports, separate from learner evidence.

Generating an analysis never opens this store. Only an explicit save creates a
report revision; SQLite compare-and-swap prevents stale browser tabs from
overwriting a later teacher review.
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


class ReportConflict(ValueError):
    """The caller did not edit the current report revision."""


class ReportNotFound(LookupError):
    """There is no such report in the current account/content workspace."""


def _assert_unredirected(path: Path) -> None:
    """Reject links before resolving or creating private report files.

    ``Path.is_symlink`` alone does not detect Windows junctions. Checking the
    reparse attribute also prevents a D: path from silently targeting C:.
    """
    for candidate in (path, *path.parents):
        try:
            info = candidate.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(
            stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0
        ):
            raise ValueError("Teaching report storage cannot use redirected paths.")


def _canonical(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _request_hash(payload: dict[str, Any]) -> str:
    comparison = payload
    assignment = payload.get("assignment")
    if isinstance(assignment, dict):
        # P1 materializes this optional field when reading a pre-template
        # report. Its absence and null represent the same request intent;
        # student-answer nulls and all other source data remain significant.
        comparison = payload | {
            "assignment": {
                key: value
                for key, value in assignment.items()
                if key not in {"rubric_template", "document_provenance"} or value is not None
            }
        }
    return hashlib.sha256(_canonical(comparison).encode("utf-8")).hexdigest()


class TeachingAnalysisStore:
    """A short-lived handle pinned to the request's already-authorized scope."""

    def __init__(self, root: Path | None = None) -> None:
        self.root = Path(
            root
            if root is not None
            else get_path_service().get_workspace_dir() / "teaching-analysis"
        ).absolute()
        self.db_path = self.root / "reports.sqlite3"
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
        # ``mode=rw`` prevents a read or a raced-away target from silently
        # creating a replacement database in another location.
        connection = sqlite3.connect(
            self.db_path.as_uri() + "?mode=rw", uri=True, timeout=15, isolation_level=None
        )
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA busy_timeout=15000")
            connection.execute("PRAGMA synchronous=FULL")
            if create:
                connection.execute(
                    """CREATE TABLE IF NOT EXISTS teaching_report_revisions (
                        report_id TEXT NOT NULL,
                        revision INTEGER NOT NULL CHECK(revision > 0),
                        payload_hash TEXT NOT NULL,
                        content_json TEXT NOT NULL,
                        updated_at REAL NOT NULL,
                        PRIMARY KEY(report_id, revision)
                    )"""
                )
                ensure_private_file(self.db_path)
            yield connection
        finally:
            connection.close()

    @staticmethod
    def _report_id(report_id: str) -> str:
        return str(UUID(str(report_id)))

    @staticmethod
    def _content(row: sqlite3.Row) -> dict[str, Any]:
        return json.loads(row["content_json"])

    def list_reports(self, *, limit: int = 100, offset: int = 0) -> list[dict[str, Any]]:
        with self._connection() as connection:
            if connection is None:
                return []
            rows = connection.execute(
                """SELECT current.content_json
                    FROM teaching_report_revisions current
                    JOIN (
                        SELECT report_id, MAX(revision) AS revision
                        FROM teaching_report_revisions GROUP BY report_id
                    ) latest ON current.report_id=latest.report_id
                        AND current.revision=latest.revision
                    ORDER BY current.updated_at DESC, current.report_id
                    LIMIT ? OFFSET ?""",
                (limit, offset),
            ).fetchall()
        reports = []
        for row in rows:
            content = self._content(row)
            reports.append(
                {key: content[key] for key in ("report_id", "revision", "status", "updated_at")}
                | {
                    key: content["assignment"][key]
                    for key in ("student_ref", "assignment_ref", "subject")
                }
            )
        return reports

    def get_report(self, report_id: str) -> dict[str, Any]:
        report_id = self._report_id(report_id)
        with self._connection() as connection:
            row = (
                connection.execute(
                    """SELECT content_json FROM teaching_report_revisions
                        WHERE report_id=? ORDER BY revision DESC LIMIT 1""",
                    (report_id,),
                ).fetchone()
                if connection is not None
                else None
            )
        if row is None:
            raise ReportNotFound("Teaching report not found in this workspace.")
        return self._content(row)

    def revisions(self, report_id: str, *, limit: int = 100) -> list[dict[str, Any]]:
        report_id = self._report_id(report_id)
        with self._connection() as connection:
            rows = (
                connection.execute(
                    """SELECT content_json FROM teaching_report_revisions
                        WHERE report_id=? ORDER BY revision DESC LIMIT ?""",
                    (report_id, limit),
                ).fetchall()
                if connection is not None
                else []
            )
        if not rows:
            raise ReportNotFound("Teaching report not found in this workspace.")
        return [self._content(row) for row in rows]

    def save_report(
        self, report_id: str, expected_revision: int, payload: dict[str, Any]
    ) -> dict[str, Any]:
        report_id = self._report_id(report_id)
        if expected_revision < 0:
            raise ValueError("Expected revision cannot be negative.")
        payload_hash = _request_hash(payload)
        with self._connection(create=True) as connection:
            assert connection is not None
            connection.execute("BEGIN IMMEDIATE")
            try:
                latest = connection.execute(
                    """SELECT revision, payload_hash, content_json
                        FROM teaching_report_revisions WHERE report_id=?
                        ORDER BY revision DESC LIMIT 1""",
                    (report_id,),
                ).fetchone()
                latest_content = self._content(latest) if latest is not None else None
                # A network retry of the currently saved content must not
                # create a second confirmation or a new revision.
                # Early P1 receipts hashed the explicit null template field.
                # Compare their original request content without rewriting the
                # immutable receipt or discarding any real null answer data.
                if (
                    latest is not None
                    and latest_content is not None
                    and (
                        latest["payload_hash"] == payload_hash
                        or _request_hash(
                            {
                                key: value
                                for key, value in latest_content.items()
                                if key not in {"report_id", "revision", "created_at", "updated_at"}
                            }
                        )
                        == payload_hash
                    )
                ):
                    result = latest_content
                    connection.commit()
                    return result
                current_revision = latest["revision"] if latest is not None else 0
                if current_revision != expected_revision:
                    raise ReportConflict(
                        "The report was changed elsewhere. Reload the latest revision before saving."
                    )
                now = time.time()
                created_at = latest_content["created_at"] if latest_content is not None else now
                result = payload | {
                    "report_id": report_id,
                    "revision": current_revision + 1,
                    "created_at": created_at,
                    "updated_at": now,
                }
                connection.execute(
                    """INSERT INTO teaching_report_revisions
                        (report_id, revision, payload_hash, content_json, updated_at)
                        VALUES (?, ?, ?, ?, ?)""",
                    (
                        report_id,
                        result["revision"],
                        payload_hash,
                        _canonical(result),
                        now,
                    ),
                )
                connection.commit()
                return result
            except BaseException:
                connection.rollback()
                raise
