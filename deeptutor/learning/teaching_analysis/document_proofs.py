"""Workspace-local signing keys for read-only previews and original source quotes.

Only a small signing key is persisted here. Uploaded documents are not written
to disk by this service. SQLite gives concurrent workers the same stable key,
so a restored browser preview survives an ordinary server restart.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat

from deeptutor.services.path_service import get_path_service
from deeptutor.utils.secret_files import ensure_private_directory, ensure_private_file

from .document_provenance import DocumentProvenance
from .storage import _assert_unredirected


class DocumentProofInvalid(ValueError):
    pass


class DocumentProofStorageError(RuntimeError):
    pass


class DocumentProofStore:
    def __init__(self, root: Path | None = None):
        self.root = Path(
            root
            if root is not None
            else get_path_service().get_workspace_dir() / "teaching-analysis"
        ).absolute()
        self.path = self.root / ".document-signing.db"

    def _guard(self):
        try:
            _assert_unredirected(self.root)
            for suffix in ("", "-journal", "-wal", "-shm"):
                _assert_unredirected(Path(str(self.path) + suffix))
        except ValueError:
            raise DocumentProofStorageError(
                "Document verification storage is unavailable."
            ) from None

    def _key(self, *, create: bool) -> bytes:
        self._guard()
        if not self.path.exists():
            if not create:
                raise DocumentProofInvalid("Read the source document again in this workspace.")
            ensure_private_directory(self.root)
            self._guard()
            try:
                fd = os.open(
                    self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, stat.S_IRUSR | stat.S_IWUSR
                )
            except FileExistsError:
                pass
            else:
                os.close(fd)
        self._guard()
        connection = sqlite3.connect(
            self.path.as_uri() + "?mode=rw", uri=True, timeout=15, isolation_level=None
        )
        try:
            if create:
                connection.execute(
                    "CREATE TABLE IF NOT EXISTS document_key (id INTEGER PRIMARY KEY CHECK (id=1), material TEXT NOT NULL)"
                )
                ensure_private_file(self.path)
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    "INSERT OR IGNORE INTO document_key VALUES (1, ?)", (secrets.token_hex(32),)
                )
                connection.commit()
            row = connection.execute("SELECT material FROM document_key WHERE id=1").fetchone()
            if row is None or not re.fullmatch(r"[a-f0-9]{64}", row[0]):
                raise DocumentProofInvalid("Read the source document again in this workspace.")
            return bytes.fromhex(row[0])
        finally:
            connection.close()

    @staticmethod
    def _message(kind: str, payload: dict) -> bytes:
        try:
            content = json.dumps(
                payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False
            )
            return ("teacher-document-v1:" + kind + "\0" + content).encode("utf-8")
        except (ValueError, TypeError, UnicodeError):
            raise DocumentProofInvalid(
                "The source document contains invalid text or metadata."
            ) from None

    def sign(self, kind: str, payload: dict) -> str:
        return hmac.new(
            self._key(create=True), self._message(kind, payload), hashlib.sha256
        ).hexdigest()

    def verify(self, kind: str, payload: dict, signature: str) -> None:
        expected = hmac.new(
            self._key(create=False), self._message(kind, payload), hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(expected, signature):
            raise DocumentProofInvalid(
                "The document source no longer matches its verified preview."
            )


def get_document_proof_store() -> DocumentProofStore:
    return DocumentProofStore()


def verify_document_provenance(value: DocumentProvenance) -> None:
    get_document_proof_store().verify(
        "provenance", value.model_dump(mode="json", exclude={"signature"}), value.signature
    )
