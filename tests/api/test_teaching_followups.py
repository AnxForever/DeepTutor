"""Admin-only practice sets and teacher-reviewed submissions stay scope-local."""

from __future__ import annotations

from contextvars import ContextVar
from uuid import uuid4

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.testclient import TestClient
import pytest

from deeptutor.api.routers import auth, teaching_analysis, teaching_followups
from deeptutor.learning.teaching_analysis import followups, storage
from deeptutor.learning.teaching_analysis.models import AssignmentInput
from deeptutor.learning.teaching_analysis.service import fingerprint_assignment
from deeptutor.services.auth import TokenPayload
from deeptutor.services.path_service import PathService

BASE = "/api/teaching-analysis"


@pytest.fixture
def followup_client(tmp_path, monkeypatch):
    # As in the report API tests, JWT/catalog validation belongs to the shared
    # auth/workspace suites. The real require_admin guard runs here against an
    # explicit test identity, and both stores resolve the selected test scope.
    scope = ContextVar("followup_api_test_scope", default=("local", "default"))
    tokens = {
        "admin-a": TokenPayload(username="alice", role="admin", user_id="alice"),
        "admin-b": TokenPayload(username="bob", role="admin", user_id="bob"),
        "student": TokenPayload(username="student", role="student", user_id="student"),
        "teacher": TokenPayload(username="teacher", role="teacher", user_id="teacher"),
        "user": TokenPayload(username="user", role="user", user_id="user"),
    }
    monkeypatch.setattr(auth, "AUTH_ENABLED", False)

    async def scoped_auth(
        request: Request, authorization: str | None = Header(default=None)
    ) -> TokenPayload | None:
        payload = None
        if auth.AUTH_ENABLED:
            payload = tokens.get((authorization or "").removeprefix("Bearer "))
            if payload is None:
                raise HTTPException(401, "Not authenticated")
        account = payload.username if payload else "local"
        workspace = request.query_params.get("dt_workspace", "default")
        if workspace not in {"default", "second"}:
            raise HTTPException(404, "Workspace not available")
        scope.set((account, workspace))
        return payload

    def paths():
        account, workspace = scope.get()
        return PathService(tmp_path / account / workspace)

    monkeypatch.setattr(storage, "get_path_service", paths)
    monkeypatch.setattr(followups, "get_path_service", paths)
    app = FastAPI()
    app.include_router(teaching_analysis.router, prefix=BASE)
    app.include_router(teaching_followups.router, prefix=BASE)
    app.dependency_overrides[auth.require_auth] = scoped_auth
    with TestClient(app) as client:
        yield client, tmp_path


def report_payload(**changes):
    material = AssignmentInput(
        student_ref="student-a",
        assignment_ref="worksheet-a",
        subject="Mathematics",
        grade="Grade 5",
        items=[{"question_id": "Q1", "question": "1/2 + 1/3 = ?", "student_answer": "2/5"}],
    )
    evidence = {"question_id": "Q1", "field": "student_answer", "quote": "2/5"}
    return {
        "report_id": str(uuid4()),
        "expected_revision": 0,
        "assignment": material.model_dump(mode="json"),
        "analysis": {
            "summary": "Check unlike denominators with the student.",
            "items": [
                {
                    "question_id": "Q1",
                    "result": "incorrect",
                    "observation": "The response is 2/5.",
                    "evidence": [evidence],
                }
            ],
            "priorities": [
                {
                    "knowledge_point": "Unlike denominators",
                    "observation": "The denominators were added.",
                    "hypothesis": "Possibly not using common units.",
                    "alternative_explanation": "One response is not enough to establish why.",
                    "teaching_action": "Compare equal-sized fraction parts.",
                    "follow_up_question": "Find 1/4 + 1/6 and explain the common unit.",
                    "reference_guidance": "5/12, using twelfths.",
                    "evidence_status": "supported",
                    "evidence": [evidence],
                }
            ],
            "limitations": ["No other student work was supplied."],
        },
        "source_fingerprint": fingerprint_assignment(material),
        "status": "confirmed",
        "teacher_notes": "",
        **changes,
    }


def create_report(client, *, headers=None, **changes):
    response = client.post(BASE + "/reports", json=report_payload(**changes), headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def followup_request(report, **changes):
    return {
        "followup_id": str(uuid4()),
        "expected_revision": 0,
        "report_id": report["report_id"],
        "report_revision": report["revision"],
        "priority_index": 0,
        "title": "Follow-up on fraction units",
        "questions": [
            {
                "question_id": "F1",
                "question": "Find 1/4 + 1/6 and explain the common unit.",
                "reference_answer": "5/12",
                "rubric": "Check common units and the calculation.",
            }
        ],
        **changes,
    }


def attempt_request(**changes):
    return {
        "attempt_id": str(uuid4()),
        "followup_revision": 1,
        "question_id": "F1",
        "student_answer": "5/12",
        "student_work": "3/12 + 2/12 = 5/12",
        "answer_status": "present",
        "assistance": "independent",
        "teacher_result": "correct",
        "teacher_feedback": "Explained common units.",
        **changes,
    }


@pytest.mark.parametrize("role", ["student", "teacher", "user"])
def test_non_admin_cannot_read_create_record_or_void_practice(followup_client, monkeypatch, role):
    client, root = followup_client
    report = create_report(client)
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    headers = {"Authorization": f"Bearer {role}"}
    identifier = str(uuid4())
    routes = [
        ("GET", "/followups", {}),
        ("POST", "/followups", {"json": followup_request(report)}),
        ("GET", f"/followups/{identifier}", {}),
        ("GET", f"/followups/{identifier}/revisions", {}),
        ("GET", f"/followups/{identifier}/attempts", {}),
        ("POST", f"/followups/{identifier}/attempts", {"json": attempt_request()}),
        (
            "POST",
            f"/followups/{identifier}/attempts/{uuid4()}/void",
            {"json": {"reason": "Wrong input"}},
        ),
    ]
    for method, path, kwargs in routes:
        response = client.request(method, BASE + path, headers=headers, **kwargs)
        assert response.status_code == 403, (method, path, response.text)
    assert not list(root.rglob("followups.sqlite3"))


def test_auth_enabled_requires_login_and_empty_reads_do_not_create_storage(
    followup_client, monkeypatch
):
    client, root = followup_client
    assert client.get(BASE + "/followups").json() == []
    assert client.get(BASE + f"/followups/{uuid4()}").status_code == 404
    assert not list(root.rglob("followups.sqlite3"))
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    assert client.get(BASE + "/followups").status_code == 401


def test_followup_source_is_confirmed_stored_report_not_client_labels(followup_client):
    client, _ = followup_client
    draft = create_report(client, status="draft")
    assert client.post(BASE + "/followups", json=followup_request(draft)).status_code == 409
    report = create_report(client)
    forged = followup_request(report, student_ref="other-student")
    assert client.post(BASE + "/followups", json=forged).status_code == 422
    request = followup_request(report)
    response = client.post(BASE + "/followups", json=request)
    assert response.status_code == 200, response.text
    saved = response.json()
    for field in ("student_ref", "assignment_ref", "subject", "grade"):
        assert saved[field] == report["assignment"][field]
    assert saved["knowledge_point"] == report["analysis"]["priorities"][0]["knowledge_point"]
    assert saved["source_fingerprint"] == report["source_fingerprint"]
    assert saved["questions"] == request["questions"]
    assert client.post(BASE + "/followups", json=request).json() == saved
    assert client.get(BASE + "/followups?report_id=" + report["report_id"]).json() == [saved]
    assert client.get(BASE + f"/followups?report_id={uuid4()}").json() == []


def test_practice_revision_conflicts_and_original_question_snapshot(followup_client):
    client, _ = followup_client
    report = create_report(client)
    request = followup_request(report)
    first = client.post(BASE + "/followups", json=request).json()
    url = BASE + "/followups/" + first["followup_id"]
    submitted = attempt_request()
    receipt = client.post(url + "/attempts", json=submitted).json()
    updated = {**request, "expected_revision": 1, "title": "Revised practice"}
    updated["questions"] = [
        {
            **request["questions"][0],
            "question": "Find 1/3 + 1/4 instead.",
            "reference_answer": "7/12",
        }
    ]
    second = client.post(BASE + "/followups", json=updated)
    assert second.status_code == 200, second.text
    assert second.json()["revision"] == 2
    assert client.post(BASE + "/followups", json=updated).json() == second.json()
    assert (
        client.post(BASE + "/followups", json={**request, "title": "A stale edit"}).status_code
        == 409
    )
    stale_attempt = client.post(url + "/attempts", json=attempt_request())
    assert stale_attempt.status_code == 409
    assert isinstance(stale_attempt.json()["detail"], str)
    assert client.post(url + "/attempts", json=submitted).json() == receipt
    assert receipt["question_snapshot"] == first["questions"][0]
    assert client.get(url + "/revisions").json() == [second.json(), first]


def test_source_revision_change_blocks_new_set_but_keeps_existing_responses(followup_client):
    client, _ = followup_client
    source = report_payload()
    report = client.post(BASE + "/reports", json=source).json()
    request = followup_request(report)
    practice = client.post(BASE + "/followups", json=request).json()
    changed = {**source, "expected_revision": 1, "teacher_notes": "New review", "status": "draft"}
    assert client.post(BASE + "/reports", json=changed).status_code == 200
    source_conflict = client.post(BASE + "/followups", json=followup_request(report))
    assert source_conflict.status_code == 409
    detail = source_conflict.json()["detail"]
    assert detail["error_code"] == "teaching_followup_source_changed"
    assert detail["retryable"] is False
    assert "source report changed" in detail["message"]
    assert client.get(BASE + "/followups/" + practice["followup_id"]).json() == practice
    response = client.post(
        BASE + f"/followups/{practice['followup_id']}/attempts", json=attempt_request()
    )
    assert response.status_code == 200, response.text
    assert response.json()["report_revision"] == 1


def test_confirmed_source_correction_cannot_move_a_set_to_another_student(followup_client):
    client, _ = followup_client
    payload = report_payload()
    report = client.post(BASE + "/reports", json=payload).json()
    request = followup_request(report)
    original = client.post(BASE + "/followups", json=request).json()
    changed = {**payload, "expected_revision": 1}
    changed["assignment"] = {**payload["assignment"], "student_ref": "another-student"}
    changed["source_fingerprint"] = fingerprint_assignment(
        AssignmentInput.model_validate(changed["assignment"])
    )
    assert client.post(BASE + "/reports", json=changed).json()["revision"] == 2
    attempt_to_move = {**request, "expected_revision": 1, "report_revision": 2}
    source_conflict = client.post(BASE + "/followups", json=attempt_to_move)
    assert source_conflict.status_code == 409
    assert source_conflict.json()["detail"]["error_code"] == "teaching_followup_source_changed"
    assert client.get(BASE + "/followups/" + original["followup_id"]).json() == original


def test_each_submission_is_independent_and_void_keeps_the_original_work(
    followup_client, monkeypatch
):
    client, root = followup_client
    report = create_report(client)
    practice = client.post(BASE + "/followups", json=followup_request(report)).json()
    url = BASE + "/followups/" + practice["followup_id"]

    async def unexpected(*args, **kwargs):
        pytest.fail("Follow-up recording must not generate or grade with a model")

    monkeypatch.setattr(teaching_analysis, "analyze_assignment", unexpected)
    payload = attempt_request(assistance="assisted")
    first = client.post(url + "/attempts", json=payload)
    assert first.status_code == 200, first.text
    assert first.json()["teacher_result"] == "correct" and first.json()["assistance"] == "assisted"
    assert client.post(url + "/attempts", json=payload).json() == first.json()
    assert client.post(url + "/attempts", json=attempt_request()).status_code == 200
    assert len(client.get(url + "/attempts").json()) == 2
    changed = {**payload, "student_answer": "7/12"}
    assert client.post(url + "/attempts", json=changed).status_code == 409
    void_url = url + "/attempts/" + payload["attempt_id"] + "/void"
    assert client.post(void_url, json={"reason": " "}).status_code == 422
    voided = client.post(void_url, json={"reason": "Wrong transcript"})
    assert voided.status_code == 200
    assert voided.json()["voided_at"] is not None
    assert voided.json()["student_answer"] == first.json()["student_answer"]
    assert voided.json()["teacher_result"] == first.json()["teacher_result"]
    assert client.post(void_url, json={"reason": "Wrong transcript"}).json() == voided.json()
    assert client.post(void_url, json={"reason": "Another reason"}).status_code == 409
    assert client.post(url + "/attempts", json=payload).json() == voided.json()
    assert any(row["voided_at"] is not None for row in client.get(url + "/attempts").json())
    assert not list(root.rglob("learning.db"))
    assert not list(root.rglob("chat_history.db"))


@pytest.mark.parametrize("status", ["unknown", "confirmed_blank"])
@pytest.mark.parametrize("result", ["correct", "partial", "incorrect"])
def test_unknown_and_confirmed_blank_remain_ungraded(followup_client, status, result):
    client, _ = followup_client
    report = create_report(client)
    practice = client.post(BASE + "/followups", json=followup_request(report)).json()
    url = BASE + f"/followups/{practice['followup_id']}/attempts"
    empty = "" if status == "confirmed_blank" else None
    payload = attempt_request(
        answer_status=status, student_answer=empty, student_work=empty, teacher_result=result
    )
    assert client.post(url, json=payload).status_code == 422
    payload["teacher_result"] = "ungraded"
    response = client.post(url, json=payload)
    assert response.status_code == 200, response.text
    assert response.json()["teacher_result"] == "ungraded"


def test_account_and_workspace_do_not_share_sources_sets_or_attempts(followup_client, monkeypatch):
    client, _ = followup_client
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    alice = {"Authorization": "Bearer admin-a"}
    bob = {"Authorization": "Bearer admin-b"}
    report = create_report(client, headers=alice)
    request = followup_request(report)
    practice = client.post(BASE + "/followups", json=request, headers=alice).json()
    url = BASE + "/followups/" + practice["followup_id"]
    assert client.post(BASE + "/followups", json=request, headers=bob).status_code == 404
    assert client.get(url, headers=bob).status_code == 404
    assert client.get(url + "?dt_workspace=second", headers=alice).status_code == 404
    assert client.get(BASE + "/followups", headers=bob).json() == []
    assert client.get(BASE + "/followups?dt_workspace=second", headers=alice).json() == []
    assert client.get(url + "/attempts", headers=bob).status_code == 404
    assert client.post(url + "/attempts", json=attempt_request(), headers=bob).status_code == 404
    assert client.get(url + "/attempts", headers=alice).json() == []


def test_invalid_ids_question_and_storage_errors_are_actionable(followup_client, monkeypatch):
    client, _ = followup_client
    assert client.get(BASE + "/followups/not-a-uuid").status_code == 422
    report = create_report(client)
    practice = client.post(BASE + "/followups", json=followup_request(report)).json()
    url = BASE + "/followups/" + practice["followup_id"]
    assert (
        client.post(url + "/attempts", json=attempt_request(question_id="absent")).status_code
        == 422
    )
    assert (
        client.post(
            url + f"/attempts/{uuid4()}/void", json={"reason": "Unknown attempt"}
        ).status_code
        == 404
    )

    def unavailable():
        raise OSError("private storage location must not be shown")

    monkeypatch.setattr(teaching_followups, "get_followup_store", unavailable)
    response = client.get(BASE + "/followups")
    assert response.status_code == 503
    assert "private" not in response.text
    assert "Reload" in response.json()["detail"]
