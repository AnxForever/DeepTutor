"""Optional template metadata must not change an existing save's intent."""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import sqlite3
from uuid import uuid4

import pytest

from deeptutor.learning.teaching_analysis.models import AssignmentInput
from deeptutor.learning.teaching_analysis.service import fingerprint_assignment
from deeptutor.learning.teaching_analysis.storage import ReportConflict, TeachingAnalysisStore


def _legacy_payload() -> dict:
    assignment = AssignmentInput(
        student_ref="synthetic-student",
        assignment_ref="synthetic-assignment",
        subject="math",
        items=[{"question_id": "Q1", "question": "Explain 1 + 1.", "student_answer": None}],
    )
    original = assignment.model_dump(mode="json")
    original.pop("rubric_template")
    original.pop("document_provenance")
    return {
        "assignment": original,
        "analysis": {
            "summary": "No answer was supplied.",
            "items": [
                {
                    "question_id": "Q1",
                    "result": "ungraded",
                    "observation": "Request the original answer before assessing it.",
                    "evidence": [],
                }
            ],
            "priorities": [],
            "limitations": ["No student answer was supplied."],
        },
        "source_fingerprint": fingerprint_assignment(assignment),
        "status": "draft",
        "teacher_notes": "",
    }


def _api_materialized(payload: dict) -> dict:
    # This is the same model dump used at the report API boundary after P1.
    return payload | {
        "assignment": AssignmentInput.model_validate(payload["assignment"]).model_dump(mode="json")
    }


def _raw_rows(store: TeachingAnalysisStore) -> list[tuple]:
    with sqlite3.connect(store.db_path) as connection:
        return connection.execute(
            "SELECT revision, payload_hash, content_json FROM teaching_report_revisions ORDER BY revision"
        ).fetchall()


@pytest.mark.parametrize("expected_revision", [0, 1])
def test_pre_template_success_retries_keep_original_revision_and_snapshot(
    tmp_path, expected_revision
):
    store = TeachingAnalysisStore(tmp_path / "workspace")
    report_id = str(uuid4())
    payload = _legacy_payload()
    first = store.save_report(report_id, 0, payload)
    before = _raw_rows(store)
    materialized = _api_materialized(payload)

    assert materialized["assignment"]["rubric_template"] is None
    assert store.save_report(report_id, expected_revision, materialized) == first
    assert store.revisions(report_id) == [first]
    assert _raw_rows(store) == before
    assert "rubric_template" not in first["assignment"]
    assert first["assignment"]["items"][0]["student_answer"] is None
    assert "rubric_template" not in payload["assignment"]


@pytest.mark.parametrize("expected_revision", [0, 1])
def test_early_p1_explicit_null_hash_remains_a_recoverable_receipt(tmp_path, expected_revision):
    store = TeachingAnalysisStore(tmp_path / "workspace")
    report_id = str(uuid4())
    payload = _api_materialized(_legacy_payload())
    first = store.save_report(report_id, 0, payload)
    # Simulate a receipt written before the hash normalization was introduced.
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    old_hash = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    with sqlite3.connect(store.db_path) as connection:
        connection.execute(
            "UPDATE teaching_report_revisions SET payload_hash=? WHERE report_id=? AND revision=1",
            (old_hash, report_id),
        )
    before = _raw_rows(store)

    assert store.save_report(report_id, expected_revision, payload) == first
    assert _raw_rows(store) == before
    without_field = deepcopy(payload)
    without_field["assignment"].pop("rubric_template")
    assert store.save_report(report_id, expected_revision, without_field) == first
    assert _raw_rows(store) == before


def test_real_teacher_edit_creates_a_revision_without_rewriting_legacy_data(tmp_path):
    store = TeachingAnalysisStore(tmp_path / "workspace")
    report_id = str(uuid4())
    legacy = _legacy_payload()
    first = store.save_report(report_id, 0, legacy)
    original_row = _raw_rows(store)[0]
    changed = _api_materialized(legacy) | {"teacher_notes": "Clarified after reviewing the paper."}

    with pytest.raises(ReportConflict):
        store.save_report(report_id, 0, changed)
    second = store.save_report(report_id, 1, changed)
    assert second["revision"] == 2
    assert second["assignment"]["rubric_template"] is None
    assert second["created_at"] == first["created_at"]
    assert store.revisions(report_id) == [second, first]
    assert _raw_rows(store)[0] == original_row
    assert store.save_report(report_id, 1, changed) == second
    assert store.save_report(report_id, 2, changed) == second


def test_confirmed_blank_is_a_real_source_change_not_an_optional_metadata_default(tmp_path):
    store = TeachingAnalysisStore(tmp_path / "workspace")
    report_id = str(uuid4())
    legacy = _legacy_payload()
    first = store.save_report(report_id, 0, legacy)
    changed = _api_materialized(legacy)
    changed["assignment"]["items"][0].update(
        answer_status="confirmed_blank", student_answer="", student_work=""
    )
    changed["source_fingerprint"] = fingerprint_assignment(
        AssignmentInput.model_validate(changed["assignment"])
    )

    with pytest.raises(ReportConflict):
        store.save_report(report_id, 0, changed)
    second = store.save_report(report_id, 1, changed)
    assert second["revision"] == 2
    assert second["assignment"]["items"][0]["student_answer"] == ""
    assert store.revisions(report_id)[1] == first
