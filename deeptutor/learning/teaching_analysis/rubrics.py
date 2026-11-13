"""Workspace-scoped scoring templates with append-only SQLite revisions."""

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

from deeptutor.services.path_service import get_path_service
from deeptutor.utils.secret_files import ensure_private_directory, ensure_private_file

from .rubric_models import RubricSnapshot, RubricTemplate, SaveRubricRequest


class RubricConflict(ValueError):
    """The caller did not edit the current template version."""


class RubricNotFound(LookupError):
    """The requested template version does not exist in this workspace."""


def _assert_unredirected(path: Path) -> None:
    for candidate in (path, *path.parents):
        try:
            info = candidate.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(
            stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0
        ):
            raise ValueError("Rubric storage cannot use redirected paths.")


def _canonical(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _template_id(template_id: str) -> str:
    return str(UUID(str(template_id)))


def _revision(revision: int) -> int:
    if type(revision) is not int or revision < 1:
        raise ValueError("Rubric revision must be a positive integer.")
    return revision


def _snapshot(template: RubricTemplate) -> RubricSnapshot:
    return RubricSnapshot.model_validate(
        template.model_dump(mode="json", include=set(RubricSnapshot.model_fields))
    )


class RubricStore:
    """A request-local handle pinned to its authorized content workspace."""

    def __init__(self, root: Path | None = None) -> None:
        self.root = Path(
            root
            if root is not None
            else get_path_service().get_workspace_dir() / "teaching-analysis"
        ).absolute()
        self.db_path = self.root / "rubrics.sqlite3"
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
                    """CREATE TABLE IF NOT EXISTS rubric_revisions (
                        template_id TEXT NOT NULL,
                        revision INTEGER NOT NULL CHECK(revision > 0),
                        payload_hash TEXT NOT NULL,
                        content_json TEXT NOT NULL,
                        updated_at REAL NOT NULL,
                        PRIMARY KEY(template_id, revision)
                    )"""
                )
                ensure_private_file(self.db_path)
            else:
                connection.execute("PRAGMA query_only=ON")
            yield connection
        finally:
            connection.close()

    @staticmethod
    def _template(row: sqlite3.Row) -> RubricTemplate:
        return RubricTemplate.model_validate(json.loads(row["content_json"]))

    def list_templates(self) -> list[RubricTemplate]:
        with self._connection() as connection:
            if connection is None:
                return []
            rows = connection.execute(
                """SELECT current.content_json FROM rubric_revisions current
                    JOIN (
                        SELECT template_id, MAX(revision) AS revision
                        FROM rubric_revisions GROUP BY template_id
                    ) latest ON current.template_id=latest.template_id
                        AND current.revision=latest.revision
                    ORDER BY current.updated_at DESC, current.template_id"""
            ).fetchall()
        return [self._template(row) for row in rows]

    def get_latest(self, template_id: str) -> RubricTemplate:
        template_id = _template_id(template_id)
        with self._connection() as connection:
            row = (
                connection.execute(
                    """SELECT content_json FROM rubric_revisions
                        WHERE template_id=? ORDER BY revision DESC LIMIT 1""",
                    (template_id,),
                ).fetchone()
                if connection is not None
                else None
            )
        if row is None:
            raise RubricNotFound("Rubric template not found in this workspace.")
        return self._template(row)

    def get_revision(self, template_id: str, revision: int) -> RubricTemplate:
        template_id, revision = _template_id(template_id), _revision(revision)
        with self._connection() as connection:
            row = (
                connection.execute(
                    "SELECT content_json FROM rubric_revisions WHERE template_id=? AND revision=?",
                    (template_id, revision),
                ).fetchone()
                if connection is not None
                else None
            )
        if row is None:
            raise RubricNotFound("Rubric version not found in this workspace.")
        return self._template(row)

    def revisions(self, template_id: str) -> list[RubricTemplate]:
        template_id = _template_id(template_id)
        with self._connection() as connection:
            rows = (
                connection.execute(
                    """SELECT content_json FROM rubric_revisions
                        WHERE template_id=? ORDER BY revision DESC""",
                    (template_id,),
                ).fetchall()
                if connection is not None
                else []
            )
        if not rows:
            raise RubricNotFound("Rubric template not found in this workspace.")
        return [self._template(row) for row in rows]

    def save_template(self, request: SaveRubricRequest) -> RubricTemplate:
        request = SaveRubricRequest.model_validate(request)
        payload = request.model_dump(mode="json", exclude={"expected_revision"})
        payload_hash = hashlib.sha256(_canonical(payload).encode("utf-8")).hexdigest()
        with self._connection(create=True) as connection:
            assert connection is not None
            connection.execute("BEGIN IMMEDIATE")
            try:
                latest = connection.execute(
                    """SELECT revision, payload_hash, content_json FROM rubric_revisions
                        WHERE template_id=? ORDER BY revision DESC LIMIT 1""",
                    (request.template_id,),
                ).fetchone()
                current_revision = latest["revision"] if latest is not None else 0
                if latest is not None and latest["payload_hash"] == payload_hash:
                    # A retry from the immediately preceding version, or an
                    # unchanged save of the current version, is a no-op. A
                    # much older request must still reload after intervening
                    # edits, even if the text later happened to match again.
                    if request.expected_revision in {current_revision, current_revision - 1}:
                        result = self._template(latest)
                        connection.commit()
                        return result
                if request.expected_revision != current_revision:
                    raise RubricConflict(
                        "The rubric changed elsewhere. Reload its latest version before saving."
                    )
                now = time.time()
                created_at = self._template(latest).created_at if latest is not None else now
                result = RubricTemplate(
                    **payload,
                    revision=current_revision + 1,
                    created_at=created_at,
                    updated_at=now,
                )
                connection.execute(
                    """INSERT INTO rubric_revisions
                        (template_id, revision, payload_hash, content_json, updated_at)
                        VALUES (?, ?, ?, ?, ?)""",
                    (
                        request.template_id,
                        result.revision,
                        payload_hash,
                        _canonical(result.model_dump(mode="json")),
                        now,
                    ),
                )
                connection.commit()
                return result
            except BaseException:
                connection.rollback()
                raise


def get_rubric_store() -> RubricStore:
    """Resolve after auth/workspace dependencies, never cache the first scope."""
    return RubricStore()


def verify_rubric_snapshot(snapshot: RubricSnapshot) -> RubricSnapshot:
    """Verify the exact adopted version in this workspace, not today's latest."""
    snapshot = RubricSnapshot.model_validate(snapshot)
    try:
        saved = get_rubric_store().get_revision(snapshot.template_id, snapshot.revision)
    except RubricNotFound:
        raise ValueError("Rubric version not found in this workspace.") from None
    if _snapshot(saved) != snapshot:
        raise ValueError("The adopted rubric does not match its stored version.")
    return snapshot


__all__ = [
    "RubricConflict",
    "RubricNotFound",
    "RubricStore",
    "get_rubric_store",
    "verify_rubric_snapshot",
]
