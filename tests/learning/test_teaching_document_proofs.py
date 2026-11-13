"""Document proofs stay scoped, durable and separate from uploaded source data."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sqlite3
import stat
from types import SimpleNamespace

import pytest

from deeptutor.learning.teaching_analysis import document_proofs
from deeptutor.learning.teaching_analysis.document_proofs import (
    DocumentProofInvalid,
    DocumentProofStorageError,
    DocumentProofStore,
    verify_document_provenance,
)
from deeptutor.learning.teaching_analysis.document_provenance import DocumentProvenance
from deeptutor.learning.teaching_analysis.documents import preview_document
from deeptutor.learning.teaching_analysis.models import AssignmentInput
from deeptutor.learning.teaching_analysis.service import fingerprint_assignment
from deeptutor.learning.teaching_analysis.storage import TeachingAnalysisStore
from deeptutor.services.path_service import PathService


def _preview_payload() -> dict:
    return preview_document(
        b"Synthetic question: Calculate 8+7.\n\nSynthetic student answer: 14.",
        "synthetic-worksheet.txt",
    ).model_dump(mode="json")


def _source_payload() -> dict:
    return {
        "filename": "synthetic-worksheet.txt",
        "source_hash": "a" * 64,
        "parser_version": "located-text-v1",
        "fields": [
            {
                "question_id": "Q1",
                "field": "student_answer",
                "citations": [{"block_id": "B2", "locator": "Line 3", "quote": "14"}],
            }
        ],
    }


def test_missing_key_verification_does_not_create_a_workspace_or_key(tmp_path):
    store = DocumentProofStore(tmp_path / "new-workspace")
    with pytest.raises(DocumentProofInvalid):
        store.verify("preview", _preview_payload(), "0" * 64)
    assert not store.root.exists()


def test_key_survives_new_store_instances_and_canonical_dictionary_order(tmp_path):
    root = tmp_path / "workspace"
    payload = _preview_payload()
    first = DocumentProofStore(root).sign("preview", payload)
    reopened = DocumentProofStore(root)
    assert reopened.sign("preview", dict(reversed(list(payload.items())))) == first
    reopened.verify("preview", payload, first)
    with sqlite3.connect(reopened.path) as connection:
        rows = connection.execute("SELECT id, material FROM document_key").fetchall()
    assert len(rows) == 1 and rows[0][0] == 1
    assert len(bytes.fromhex(rows[0][1])) == 32


def test_preview_signature_cannot_authorize_a_provenance_payload(tmp_path):
    store = DocumentProofStore(tmp_path / "workspace")
    payload = _source_payload()
    preview_token = store.sign("preview", payload)
    with pytest.raises(DocumentProofInvalid):
        store.verify("provenance", payload, preview_token)
    assert store.sign("provenance", payload) != preview_token


@pytest.mark.parametrize("invalid_value", ["\ud800", float("nan"), object()])
def test_invalid_canonical_payload_is_rejected_without_changing_the_key(tmp_path, invalid_value):
    store = DocumentProofStore(tmp_path / "workspace")
    payload = _preview_payload()
    token = store.sign("preview", payload)
    original_key_file = store.path.read_bytes()
    payload["blocks"][0]["text"] = invalid_value
    with pytest.raises(DocumentProofInvalid):
        store.verify("preview", payload, token)
    assert store.path.read_bytes() == original_key_file


@pytest.mark.parametrize(
    "change",
    ["filename", "hash", "parser", "text", "locator", "block_id", "order", "warnings"],
)
def test_preview_binds_the_entire_document_including_locations_and_order(tmp_path, change):
    store = DocumentProofStore(tmp_path / "workspace")
    payload = _preview_payload()
    token = store.sign("preview", payload)
    changed = deepcopy(payload)
    if change == "filename":
        changed["filename"] = "another-worksheet.txt"
    elif change == "hash":
        changed["source_hash"] = "b" * 64
    elif change == "parser":
        changed["parser_version"] = "another-parser"
    elif change == "text":
        changed["blocks"][0]["text"] = "A fabricated original question."
    elif change == "locator":
        changed["blocks"][0]["locator"] = "Line 999"
    elif change == "block_id":
        changed["blocks"][0]["block_id"] = "B999"
    elif change == "order":
        changed["blocks"].reverse()
    else:
        changed["warnings"] = ["A warning added after verification"]
    with pytest.raises(DocumentProofInvalid):
        store.verify("preview", changed, token)


def test_cross_workspace_token_neither_verifies_nor_creates_a_second_key(tmp_path):
    payload = _preview_payload()
    first = DocumentProofStore(tmp_path / "first")
    second = DocumentProofStore(tmp_path / "second")
    token = first.sign("preview", payload)
    with pytest.raises(DocumentProofInvalid):
        second.verify("preview", payload, token)
    assert not second.root.exists()
    second.sign("preview", payload)
    with pytest.raises(DocumentProofInvalid):
        second.verify("preview", payload, token)
    first.verify("preview", payload, token)


def test_concurrent_workers_share_one_durable_key(tmp_path):
    root = tmp_path / "concurrent-workspace"
    payload = _preview_payload()

    def sign(_index):
        return DocumentProofStore(root).sign("preview", payload)

    with ThreadPoolExecutor(max_workers=6) as executor:
        signatures = list(executor.map(sign, range(12)))
    assert len(set(signatures)) == 1
    DocumentProofStore(root).verify("preview", payload, signatures[0])
    with sqlite3.connect(root / ".document-signing.db") as connection:
        assert connection.execute("SELECT COUNT(*) FROM document_key").fetchone()[0] == 1


def test_signing_store_does_not_persist_original_uploads_or_preview_content(tmp_path):
    store = DocumentProofStore(tmp_path / "workspace")
    payload = _preview_payload()
    store.sign("preview", payload)
    store.sign("provenance", _source_payload())
    assert [path.name for path in store.root.iterdir()] == [".document-signing.db"]
    raw = store.path.read_bytes()
    assert b"synthetic-worksheet.txt" not in raw
    assert b"Synthetic student answer: 14." not in raw
    with sqlite3.connect(store.path) as connection:
        tables = connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
    assert tables == [("document_key",)]


@pytest.mark.parametrize("target_kind", ["root", "key", "journal", "wal", "shm"])
def test_reparse_roots_keys_and_sidecars_are_rejected_before_any_write(
    tmp_path, monkeypatch, target_kind
):
    store = DocumentProofStore(tmp_path / "uncreated-workspace")
    suffixes = {"key": "", "journal": "-journal", "wal": "-wal", "shm": "-shm"}
    target = store.root if target_kind == "root" else Path(str(store.path) + suffixes[target_kind])
    original_lstat = Path.lstat

    def fake_lstat(path, *args, **kwargs):
        if path == target:
            return SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=0x400)
        return original_lstat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "lstat", fake_lstat)
    monkeypatch.setattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400, raising=False)
    with pytest.raises(DocumentProofStorageError):
        store.sign("preview", _preview_payload())
    assert not store.root.exists()


def test_invalid_key_material_is_not_silently_rotated(tmp_path):
    store = DocumentProofStore(tmp_path / "workspace")
    payload = _preview_payload()
    token = store.sign("preview", payload)
    with sqlite3.connect(store.path) as connection:
        connection.execute("UPDATE document_key SET material='invalid' WHERE id=1")
    with pytest.raises(DocumentProofInvalid):
        store.verify("preview", payload, token)
    with pytest.raises(DocumentProofInvalid):
        store.sign("preview", payload)
    with sqlite3.connect(store.path) as connection:
        assert connection.execute("SELECT material FROM document_key").fetchone() == ("invalid",)


def test_provenance_factory_uses_current_scope_and_rejects_changed_originals(tmp_path, monkeypatch):
    selected = ["first"]
    monkeypatch.setattr(
        document_proofs,
        "get_path_service",
        lambda: PathService(tmp_path / selected[0]),
    )
    payload = _source_payload()
    signature = document_proofs.get_document_proof_store().sign("provenance", payload)
    proof = DocumentProvenance.model_validate(payload | {"signature": signature})
    verify_document_provenance(proof)
    for field in ("locator", "quote"):
        altered = proof.model_dump(mode="json")
        altered["fields"][0]["citations"][0][field] = "Changed after signing"
        with pytest.raises(DocumentProofInvalid):
            verify_document_provenance(DocumentProvenance.model_validate(altered))
    selected[0] = "second"
    with pytest.raises(DocumentProofInvalid):
        verify_document_provenance(proof)
    selected[0] = "first"
    verify_document_provenance(proof)


@pytest.mark.parametrize("legacy_version", ["P0", "P1"])
def test_optional_document_proof_preserves_old_fingerprints_and_save_receipts(
    tmp_path, legacy_version
):
    template = None
    if legacy_version == "P1":
        template = {
            "template_id": "11111111-1111-4111-8111-111111111111",
            "name": "Synthetic reasoning rubric",
            "revision": 1,
            "criteria": "Check the explanation.",
        }
    assignment = AssignmentInput(
        student_ref="synthetic-student",
        assignment_ref="synthetic-assignment",
        subject="math",
        rubric_template=template,
        items=[{"question_id": "Q1", "question": "Explain 1 + 1.", "student_answer": None}],
    )
    old_assignment = assignment.model_dump(mode="json")
    old_assignment.pop("document_provenance")
    if legacy_version == "P0":
        old_assignment.pop("rubric_template")
    encoded = json.dumps(old_assignment, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    old_hash = hashlib.sha256(encoded.encode()).hexdigest()
    assert fingerprint_assignment(assignment) == old_hash
    content = {
        "assignment": old_assignment,
        "analysis": {
            "summary": "No student answer was supplied.",
            "items": [
                {
                    "question_id": "Q1",
                    "result": "ungraded",
                    "observation": "Unknown.",
                    "evidence": [],
                }
            ],
            "priorities": [],
            "limitations": ["No answer supplied."],
        },
        "source_fingerprint": old_hash,
        "status": "draft",
        "teacher_notes": "",
    }
    store = TeachingAnalysisStore(tmp_path / "workspace")
    report_id = "22222222-2222-4222-8222-222222222222"
    first = store.save_report(report_id, 0, content)
    with sqlite3.connect(store.db_path) as connection:
        before = connection.execute(
            "SELECT payload_hash, content_json FROM teaching_report_revisions"
        ).fetchall()
    restored = content | {
        "assignment": AssignmentInput.model_validate(old_assignment).model_dump(mode="json")
    }
    assert restored["assignment"]["document_provenance"] is None
    assert store.save_report(report_id, 0, restored) == first
    assert store.save_report(report_id, 1, restored) == first
    with sqlite3.connect(store.db_path) as connection:
        assert (
            connection.execute(
                "SELECT payload_hash, content_json FROM teaching_report_revisions"
            ).fetchall()
            == before
        )
    assert first["assignment"]["items"][0]["student_answer"] is None
    assert "document_provenance" not in first["assignment"]


def test_key_database_is_not_an_allowed_public_output(tmp_path):
    paths = PathService(tmp_path / "scope")
    store = DocumentProofStore(paths.get_workspace_dir() / "teaching-analysis")
    store.sign("preview", _preview_payload())
    assert store.path.is_relative_to(paths.get_public_outputs_root())
    assert paths.resolve_public_output_path(store.path) is None
