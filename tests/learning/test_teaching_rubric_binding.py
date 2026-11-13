"""Template provenance and pre-template report compatibility at the report boundary."""

from __future__ import annotations

import hashlib
import json
from unittest.mock import AsyncMock
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

from deeptutor.api.routers import auth
from deeptutor.api.routers import teaching_analysis as router
from deeptutor.learning.teaching_analysis import rubrics, service
from deeptutor.learning.teaching_analysis.models import AssignmentInput, ReportContent
from deeptutor.learning.teaching_analysis.rubric_models import RubricSnapshot, SaveRubricRequest
from deeptutor.learning.teaching_analysis.storage import TeachingAnalysisStore


def material(**changes):
    return AssignmentInput.model_validate(
        {
            "student_ref": "synthetic-student",
            "assignment_ref": "synthetic-work",
            "subject": "math",
            "items": [{"question_id": "Q1", "question": "Explain 1 + 1.", "student_answer": None}],
            **changes,
        }
    )


def report():
    return ReportContent(
        summary="The answer was not supplied.",
        items=[
            {
                "question_id": "Q1",
                "result": "ungraded",
                "observation": "No answer supplied.",
                "evidence": [],
            }
        ],
        priorities=[],
        limitations=["Request the original answer before deciding what the student understands."],
    )


def legacy_hash(assignment):
    original = assignment.model_dump(mode="json")
    original.pop("rubric_template", None)
    original.pop("document_provenance", None)
    encoded = json.dumps(original, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


@pytest.fixture
def binding(tmp_path, monkeypatch):
    library = rubrics.RubricStore(tmp_path / "library")
    reports = TeachingAnalysisStore(tmp_path / "reports")
    monkeypatch.setattr(auth, "AUTH_ENABLED", False)
    monkeypatch.setattr(rubrics, "get_rubric_store", lambda: library)
    monkeypatch.setattr(router, "_store", lambda: reports)
    app = FastAPI()
    app.include_router(router.router, prefix="/api/teaching-analysis")
    with TestClient(app) as client:
        yield client, library, reports


def save_template(library, **changes):
    return library.save_template(
        SaveRubricRequest(
            **{
                "template_id": str(uuid4()),
                "expected_revision": 0,
                "name": "Explain the reasoning",
                "subject": "math",
                "grade": "",
                "criteria": "Check the reasoning as well as the final answer.",
                **changes,
            }
        )
    )


def snapshot(template):
    return RubricSnapshot.model_validate(template.model_dump(exclude={"created_at", "updated_at"}))


def test_optional_template_preserves_pre_p1_hash_including_unknown_answer_nulls():
    assignment = material()
    assert assignment.items[0].student_answer is None
    assert service.fingerprint_assignment(assignment) == legacy_hash(assignment)
    without_nulls = assignment.model_dump(mode="json", exclude_none=True)
    encoded = json.dumps(without_nulls, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    assert (
        service.fingerprint_assignment(assignment) != hashlib.sha256(encoded.encode()).hexdigest()
    )


def test_template_snapshot_counts_toward_full_input_budget():
    items = [
        {"question_id": str(n), "question": "q" * 6000, "student_answer": "a" * 1000}
        for n in range(8)
    ]
    assignment = material(items=items)
    template = {
        "template_id": str(uuid4()),
        "revision": 1,
        "name": "Large standard",
        "criteria": "c" * 6000,
    }
    with pytest.raises(ValidationError, match="60000"):
        material(items=assignment.model_dump(mode="json")["items"], rubric_template=template)


def test_old_saved_report_is_still_editable_after_optional_template_is_materialized(binding):
    client, _, reports = binding
    assignment = material()
    original = assignment.model_dump(mode="json")
    original.pop("rubric_template")
    original.pop("document_provenance")
    report_id = str(uuid4())
    saved = reports.save_report(
        report_id,
        0,
        {
            "assignment": original,
            "analysis": report().model_dump(),
            "source_fingerprint": legacy_hash(assignment),
            "status": "draft",
            "teacher_notes": "original",
        },
    )
    loaded = client.get(f"/api/teaching-analysis/reports/{report_id}").json()
    assert loaded["assignment"]["rubric_template"] is None
    payload = {
        key: loaded[key]
        for key in (
            "report_id",
            "assignment",
            "analysis",
            "source_fingerprint",
            "status",
            "teacher_notes",
        )
    }
    payload.update(expected_revision=saved["revision"], teacher_notes="teacher clarified the note")
    response = client.post("/api/teaching-analysis/reports", json=payload)
    assert response.status_code == 200
    assert response.json()["revision"] == 2
    assert response.json()["source_fingerprint"] == saved["source_fingerprint"]


def test_selected_old_version_is_verified_without_silently_upgrading_it(binding, monkeypatch):
    client, library, _ = binding
    first = save_template(library)
    old = snapshot(first)
    second = save_template(
        library,
        template_id=first.template_id,
        expected_revision=1,
        criteria="New standard, explicitly chosen only.",
    )
    request = AsyncMock(return_value=json.dumps(report().model_dump()))
    monkeypatch.setattr(service, "_request_model", request)
    assignment = material(rubric_template=old)
    response = client.post(
        "/api/teaching-analysis/analyze", json=assignment.model_dump(mode="json")
    )
    assert response.status_code == 200
    sent = json.loads(request.await_args.kwargs["prompt"])
    assert sent["rubric_template"]["criteria"] == first.criteria
    assert sent["rubric_template"]["revision"] == 1
    assert service.fingerprint_assignment(assignment) != service.fingerprint_assignment(
        material(rubric_template=snapshot(second))
    )


@pytest.mark.parametrize(
    "change", [{"criteria": "Invented criteria"}, {"name": "Wrong provenance"}, {"revision": 99}]
)
def test_forged_snapshot_does_not_reach_model_or_report_storage(binding, monkeypatch, change):
    client, library, reports = binding
    original = snapshot(save_template(library)).model_dump()
    assignment = material(rubric_template=original | change)
    model = AsyncMock()
    monkeypatch.setattr(router, "analyze_assignment", model)
    response = client.post(
        "/api/teaching-analysis/analyze", json=assignment.model_dump(mode="json")
    )
    assert response.status_code == 422
    assert response.json()["detail"]["error_code"] == "teaching_rubric_unavailable"
    model.assert_not_awaited()
    saved = client.post(
        "/api/teaching-analysis/reports",
        json={
            "report_id": str(uuid4()),
            "expected_revision": 0,
            "assignment": assignment.model_dump(mode="json"),
            "analysis": report().model_dump(),
            "source_fingerprint": service.fingerprint_assignment(assignment),
            "status": "draft",
        },
    )
    assert saved.status_code == 422
    assert not reports.db_path.exists()


def test_snapshot_from_another_workspace_is_not_an_access_credential(
    binding, monkeypatch, tmp_path
):
    client, library, _ = binding
    template = snapshot(save_template(library))
    other = rubrics.RubricStore(tmp_path / "other-workspace")
    monkeypatch.setattr(rubrics, "get_rubric_store", lambda: other)
    model = AsyncMock()
    monkeypatch.setattr(router, "analyze_assignment", model)
    response = client.post(
        "/api/teaching-analysis/analyze",
        json=material(rubric_template=template).model_dump(mode="json"),
    )
    assert response.status_code == 422
    model.assert_not_awaited()
