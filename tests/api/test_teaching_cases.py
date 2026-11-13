"""Student-case identity and pinned timelines remain explicit and scope-local."""

from __future__ import annotations

from contextvars import ContextVar
import json
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.testclient import TestClient
import pytest

from deeptutor.api.routers import auth, teaching_analysis, teaching_cases
from deeptutor.learning.teaching_analysis import case_storage, followups, storage
from deeptutor.learning.teaching_analysis.followup_models import SaveFollowupAttemptRequest
from deeptutor.learning.teaching_analysis.models import AssignmentInput
from deeptutor.learning.teaching_analysis.service import fingerprint_assignment
from deeptutor.services.auth import TokenPayload
from deeptutor.services.path_service import PathService

BASE = "/api/teaching-analysis"


@pytest.fixture
def case_client(tmp_path, monkeypatch):
    # JWT/catalog authorization is covered by the shared suites. Exercise the
    # real admin guard and inject distinct authorized PathService roots to
    # verify request-context propagation. Production administrator accounts
    # retain the project's shared admin root; this is not a privacy-per-admin
    # guarantee or a replacement for the workspace-catalog authorization tests.
    scope = ContextVar("case_api_test_scope", default=("local", "default"))
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
        workspace = request.query_params.get("dt_workspace", "default")
        if workspace not in {"default", "second"}:
            raise HTTPException(404, "Workspace not available")
        scope.set((payload.username if payload else "local", workspace))
        return payload

    def paths():
        account, workspace = scope.get()
        return PathService(tmp_path / account / workspace)

    for module in (case_storage, storage, followups):
        monkeypatch.setattr(module, "get_path_service", paths)
    app = FastAPI()
    # Parent mounting must include all new child routes without importing the
    # parent SavedReport DTO into the domain or child cases router.
    app.include_router(teaching_analysis.router, prefix=BASE)
    app.dependency_overrides[auth.require_auth] = scoped_auth
    with TestClient(app) as client:
        yield client, tmp_path


def report_payload(**changes):
    material = AssignmentInput(
        student_ref="original-anonymous-label",
        assignment_ref="Assignment A",
        subject="Mathematics",
        grade="Grade 5",
        items=[
            {
                "question_id": "Q1",
                "question": "1/2 + 1/3 = ?",
                "student_answer": "2/5",
                "student_work": "(1+1)/(2+3)=2/5",
                "answer_status": "present",
                "assistance": "independent",
            }
        ],
    )
    evidence = {"question_id": "Q1", "field": "student_answer", "quote": "2/5"}
    return {
        "report_id": str(uuid4()),
        "expected_revision": 0,
        "assignment": material.model_dump(mode="json"),
        "analysis": {
            "summary": "Original confirmed interpretation.",
            "items": [
                {
                    "question_id": "Q1",
                    "result": "incorrect",
                    "observation": "The response was 2/5.",
                    "evidence": [evidence],
                }
            ],
            "priorities": [
                {
                    "knowledge_point": "Unlike denominators",
                    "observation": "The response was 2/5.",
                    "hypothesis": "Possibly using separate addition of numerators and denominators.",
                    "alternative_explanation": "The reason needs checking.",
                    "teaching_action": "Discuss common fraction units.",
                    "follow_up_question": "Find 1/4 + 1/6 and explain the common unit.",
                    "reference_guidance": "5/12, using twelfths.",
                    "evidence_status": "supported",
                    "evidence": [evidence],
                }
            ],
            "limitations": ["This is one observed response."],
        },
        "source_fingerprint": fingerprint_assignment(material),
        "status": "confirmed",
        "teacher_notes": "",
        **changes,
    }


def create_report(client, *, headers=None, **changes):
    payload = report_payload(**changes)
    result = client.post(BASE + "/reports", json=payload, headers=headers)
    assert result.status_code == 200, result.text
    return result.json(), payload


def case_request(*reports, **changes):
    return {
        "case_id": str(uuid4()),
        "expected_revision": 0,
        "label": "Anonymous learner A",
        "subject": None,
        "archived": False,
        "report_refs": [
            {"report_id": report["report_id"], "report_revision": report["revision"]}
            for report in reports
        ],
        **changes,
    }


def create_case(client, *reports, headers=None, **changes):
    payload = case_request(*reports, **changes)
    response = client.post(BASE + "/student-cases", json=payload, headers=headers)
    assert response.status_code == 200, response.text
    return response.json(), payload


def create_followup(client, report):
    response = client.post(
        BASE + "/followups",
        json={
            "followup_id": str(uuid4()),
            "expected_revision": 0,
            "report_id": report["report_id"],
            "report_revision": report["revision"],
            "priority_index": 0,
            "title": "Common fraction units",
            "questions": [
                {"question_id": "F1", "question": "1/4 + 1/6 = ?", "reference_answer": "5/12"}
            ],
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def record_attempt(client, practice, *, assistance="independent", result="correct"):
    payload = {
        "attempt_id": str(uuid4()),
        "followup_revision": practice["revision"],
        "question_id": "F1",
        "student_answer": "5/12",
        "student_work": "3/12 + 2/12 = 5/12",
        "answer_status": "present",
        "assistance": assistance,
        "teacher_result": result,
        "teacher_feedback": "Teacher-reviewed response.",
    }
    response = client.post(BASE + f"/followups/{practice['followup_id']}/attempts", json=payload)
    assert response.status_code == 200, response.text
    return response.json(), payload


def feature_root(root: Path, *, account="local", workspace="default") -> Path:
    return PathService(root / account / workspace).get_workspace_dir() / "teaching-analysis"


def test_empty_reads_and_missing_ids_do_not_create_case_storage(case_client):
    client, root = case_client
    assert client.get(BASE + "/student-cases").json() == []
    for suffix in ("", "/revisions", "/timeline"):
        assert client.get(BASE + f"/student-cases/{uuid4()}" + suffix).status_code == 404
    assert not list(root.rglob("*.sqlite3"))


@pytest.mark.parametrize("role", ["student", "teacher", "user"])
def test_non_admin_cannot_list_link_read_history_or_timeline(case_client, monkeypatch, role):
    client, _ = case_client
    report, _ = create_report(client)
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    headers = {"Authorization": f"Bearer {role}"}
    identifier = str(uuid4())
    requests = [
        ("GET", "/student-cases", {}),
        ("POST", "/student-cases", {"json": case_request(report)}),
        ("GET", f"/student-cases/{identifier}", {}),
        ("GET", f"/student-cases/{identifier}/revisions", {}),
        ("GET", f"/student-cases/{identifier}/timeline", {}),
        ("GET", f"/reports/{report['report_id']}/revisions/1", {}),
    ]
    for method, path, kwargs in requests:
        response = client.request(method, BASE + path, headers=headers, **kwargs)
        assert response.status_code == 403, (method, path, response.text)


def test_case_identity_is_uuid_not_label_and_links_are_explicit(case_client):
    client, _ = case_client
    report, _ = create_report(client)
    first, payload = create_case(client)
    second, _ = create_case(client, label=first["label"])
    assert first["case_id"] != second["case_id"]
    assert client.get(BASE + f"/student-cases/{first['case_id']}/timeline").json()["events"] == []
    linked = {
        **payload,
        "expected_revision": 1,
        "report_refs": [{"report_id": report["report_id"], "report_revision": 1}],
    }
    response = client.post(BASE + "/student-cases", json=linked)
    assert response.status_code == 200
    assert response.json()["revision"] == 2
    assert len(client.get(BASE + "/student-cases").json()) == 2
    unrelated = client.get(BASE + f"/student-cases/{second['case_id']}/timeline").json()
    assert unrelated["events"] == []


def test_case_retry_cas_archive_restore_and_unlink_preserve_history(case_client):
    client, _ = case_client
    report, _ = create_report(client)
    saved, payload = create_case(client, report)
    assert client.post(BASE + "/student-cases", json=payload).json() == saved
    renamed = {**payload, "expected_revision": 1, "label": "Renamed anonymous learner"}
    revision2 = client.post(BASE + "/student-cases", json=renamed).json()
    assert revision2["revision"] == 2
    stale = client.post(BASE + "/student-cases", json={**payload, "label": "Old browser edit"})
    assert stale.status_code == 409
    assert stale.json()["detail"]["error_code"] == "teaching_case_changed"
    archived = client.post(
        BASE + "/student-cases", json={**renamed, "expected_revision": 2, "archived": True}
    )
    assert archived.status_code == 200
    assert client.get(BASE + "/student-cases").json() == []
    assert (
        client.get(BASE + "/student-cases?archived=true").json()[0]["case_id"] == saved["case_id"]
    )
    url = BASE + "/student-cases/" + saved["case_id"]
    assert client.get(url).json()["archived"] is True
    assert client.get(url + "/timeline").json()["archived"] is True
    restored = client.post(
        BASE + "/student-cases", json={**renamed, "expected_revision": 3, "report_refs": []}
    )
    assert restored.status_code == 200 and restored.json()["revision"] == 4
    assert client.get(url + "/timeline").json()["events"] == []
    history = client.get(url + "/revisions").json()
    assert [entry["revision"] for entry in history] == [4, 3, 2, 1]
    assert history[-1] == saved
    assert history[-1]["report_refs"] == payload["report_refs"]


def test_only_confirmed_exact_report_versions_can_be_new_links(case_client):
    client, _ = case_client
    report, payload = create_report(client, status="draft")
    rejected = client.post(BASE + "/student-cases", json=case_request(report))
    assert rejected.status_code == 409
    assert rejected.json()["detail"]["error_code"] == "teaching_case_source_changed"
    assert (
        client.post(
            BASE + "/student-cases", json=case_request({"report_id": str(uuid4()), "revision": 1})
        ).status_code
        == 409
    )
    confirmed = client.post(
        BASE + "/reports", json={**payload, "expected_revision": 1, "status": "confirmed"}
    ).json()
    assert confirmed["revision"] == 2
    assert (
        client.post(
            BASE + "/student-cases", json=case_request({**confirmed, "revision": 1})
        ).status_code
        == 409
    )
    saved, _ = create_case(client, confirmed)
    assert saved["report_refs"][0]["report_revision"] == 2


def test_source_update_is_stale_without_replacing_the_selected_evidence(case_client):
    client, _ = case_client
    report, source_payload = create_report(client)
    saved, case_payload = create_case(client, report)
    edited_source = json.loads(json.dumps(source_payload))
    edited_source["expected_revision"] = 1
    edited_source["analysis"]["summary"] = "A newly revised interpretation."
    assert client.post(BASE + "/reports", json=edited_source).json()["revision"] == 2
    url = BASE + f"/student-cases/{saved['case_id']}"
    timeline = client.get(url + "/timeline").json()
    assert timeline["case_revision"] == 1
    assert timeline["source_states"][0]["report_revision"] == 1
    assert timeline["source_states"][0]["latest_revision"] == 2
    assert timeline["source_states"][0]["status"] == "stale"
    report_event = next(entry for entry in timeline["events"] if entry["kind"] == "report")
    assert report_event["report_snapshot"]["report_revision"] == 1
    assert report_event["report_snapshot"]["summary"] == "Original confirmed interpretation."
    assert (
        client.post(
            BASE + "/student-cases",
            json={**case_payload, "expected_revision": 1, "label": "New label only"},
        ).status_code
        == 200
    )
    assert client.get(url).json()["report_refs"] == case_payload["report_refs"]


def test_timeline_excludes_voids_and_preserves_assistance_and_ungraded_buckets(case_client):
    client, _ = case_client
    report, _ = create_report(client)
    practice = create_followup(client, report)
    independent, _ = record_attempt(client, practice)
    assisted, _ = record_attempt(client, practice, assistance="assisted")
    unknown, _ = record_attempt(client, practice, assistance="unknown", result="ungraded")
    voided, _ = record_attempt(client, practice)
    void_result = client.post(
        BASE + f"/followups/{practice['followup_id']}/attempts/{voided['attempt_id']}/void",
        json={"reason": "Wrong transcript"},
    )
    assert void_result.status_code == 200
    saved, _ = create_case(client, report)
    response = client.get(BASE + f"/student-cases/{saved['case_id']}/timeline")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["case_id"] == saved["case_id"] and body["case_revision"] == 1
    assert body["generated_at"] > 0
    attempts = [entry["attempt"] for entry in body["events"] if entry["kind"] == "attempt"]
    assert {entry["attempt_id"] for entry in attempts} == {
        independent["attempt_id"],
        assisted["attempt_id"],
        unknown["attempt_id"],
    }
    assert body["counts"]["attempts"] == 3
    assert body["counts"]["voided_attempts"] == 1
    assert body["counts"]["attempt_results"]["ungraded"] == 1
    assert body["counts"]["attempt_assistance"] == {"independent": 1, "assisted": 1, "unknown": 1}
    bins = {
        (entry["assistance"], entry["teacher_result"]): entry["count"]
        for entry in body["counts"]["attempt_outcomes"]
    }
    assert bins[("independent", "correct")] == 1
    assert bins[("assisted", "correct")] == 1
    assert bins[("unknown", "ungraded")] == 1
    assert len(bins) == 12


def test_attempts_follow_exact_pinned_report_revision_not_latest_set_revision(case_client):
    client, _ = case_client
    report, source_payload = create_report(client)
    practice = create_followup(client, report)
    original, _ = record_attempt(client, practice)
    newer_source = client.post(
        BASE + "/reports",
        json={**source_payload, "expected_revision": 1, "teacher_notes": "New source review"},
    ).json()
    newer_practice_request = {
        key: value
        for key, value in practice.items()
        if key
        in {"followup_id", "report_id", "report_revision", "priority_index", "title", "questions"}
    }
    newer_practice_request.update(expected_revision=1, report_revision=2)
    newer_practice = client.post(BASE + "/followups", json=newer_practice_request).json()
    newer_attempt, _ = record_attempt(client, newer_practice)
    saved, request = create_case(client, report)
    url = BASE + f"/student-cases/{saved['case_id']}/timeline"
    first = client.get(url).json()
    assert {
        event["attempt"]["attempt_id"] for event in first["events"] if event["kind"] == "attempt"
    } == {original["attempt_id"]}
    request.update(
        expected_revision=1,
        report_refs=[{"report_id": newer_source["report_id"], "report_revision": 2}],
    )
    assert client.post(BASE + "/student-cases", json=request).status_code == 200
    second = client.get(url).json()
    assert {
        event["attempt"]["attempt_id"] for event in second["events"] if event["kind"] == "attempt"
    } == {newer_attempt["attempt_id"]}


def test_timeline_pages_beyond_hundred_without_duplicates_or_fake_totals(case_client, monkeypatch):
    client, root = case_client
    report, _ = create_report(client)
    practice = create_followup(client, report)
    store = followups.FollowupStore(feature_root(root))
    for _ in range(108):
        store.record_attempt(
            practice["followup_id"],
            SaveFollowupAttemptRequest.model_validate(
                {
                    "attempt_id": str(uuid4()),
                    "followup_revision": 1,
                    "question_id": "F1",
                    "student_answer": "5/12",
                    "answer_status": "present",
                    "assistance": "independent",
                    "teacher_result": "correct",
                }
            ),
        )
    saved, request = create_case(client, report)
    url = BASE + f"/student-cases/{saved['case_id']}/timeline"
    cursor = None
    events = []
    first_cursor = None
    for page in range(20):
        response = client.get(url, params={"limit": 7, **({"cursor": cursor} if cursor else {})})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["counts"]["attempts"] == 108
        assert body["counts"]["total_events"] == 109
        assert len(body["events"]) <= 7
        events.extend(body["events"])
        cursor = body["next_cursor"]
        if page == 0:
            first_cursor = cursor
        if cursor is None:
            break
    assert len(events) == 109
    assert len({event["event_id"] for event in events}) == 109
    assert first_cursor
    assert (
        client.post(
            BASE + "/student-cases",
            json={**request, "expected_revision": 1, "label": "Changed case"},
        ).status_code
        == 200
    )
    stale = client.get(url, params={"limit": 7, "cursor": first_cursor})
    assert stale.status_code == 409
    assert stale.json()["detail"]["error_code"] == "teaching_case_changed"
    assert stale.json()["detail"]["retryable"] is False


def test_metadata_save_retains_unavailable_existing_pin_without_fabricated_report(case_client):
    client, root = case_client
    report, _ = create_report(client)
    practice = create_followup(client, report)
    receipt, _ = record_attempt(client, practice)
    saved, payload = create_case(client, report)
    db = feature_root(root) / "reports.sqlite3"
    db.rename(db.with_name("temporarily-unavailable.sqlite3"))
    response = client.post(
        BASE + "/student-cases",
        json={**payload, "expected_revision": 1, "label": "Renamed while unavailable"},
    )
    assert response.status_code == 200, response.text
    timeline = client.get(BASE + f"/student-cases/{saved['case_id']}/timeline").json()
    assert timeline["source_states"][0]["status"] == "unavailable"
    assert not any(event["kind"] == "report" for event in timeline["events"])
    assert {
        event["attempt"]["attempt_id"] for event in timeline["events"] if event["kind"] == "attempt"
    } == {receipt["attempt_id"]}


def test_case_report_and_timeline_do_not_cross_scopes(case_client, monkeypatch):
    client, _ = case_client
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    alice = {"Authorization": "Bearer admin-a"}
    bob = {"Authorization": "Bearer admin-b"}
    report, _ = create_report(client, headers=alice)
    saved, request = create_case(client, report, headers=alice)
    url = BASE + f"/student-cases/{saved['case_id']}"
    assert client.get(BASE + "/student-cases").status_code == 401
    assert client.get(url, headers=bob).status_code == 404
    assert client.get(url + "/timeline", headers=bob).status_code == 404
    assert client.get(url + "?dt_workspace=second", headers=alice).status_code == 404
    assert client.get(url + "/timeline?dt_workspace=second", headers=alice).status_code == 404
    assert client.post(BASE + "/student-cases", json=request, headers=bob).status_code == 409
    exact = BASE + f"/reports/{report['report_id']}/revisions/1"
    assert client.get(exact, headers=alice).status_code == 200
    assert client.get(exact, headers=bob).status_code == 404


def test_exact_report_read_is_not_limited_to_last_hundred(case_client):
    client, root = case_client
    report_id = str(uuid4())
    store = storage.TeachingAnalysisStore(feature_root(root))
    payload = report_payload(report_id=report_id)
    content = {
        key: value
        for key, value in payload.items()
        if key not in {"report_id", "expected_revision"}
    }
    for revision in range(1, 106):
        store.save_report(
            report_id, revision - 1, content | {"teacher_notes": f"Saved version {revision}"}
        )
    exact = BASE + f"/reports/{report_id}/revisions/1"
    response = client.get(exact)
    assert response.status_code == 200, response.text
    assert response.json()["revision"] == 1
    assert response.json()["teacher_notes"] == "Saved version 1"
    assert (
        client.get(BASE + f"/reports/{report_id}/revisions/101").json()["teacher_notes"]
        == "Saved version 101"
    )
    assert client.get(BASE + f"/reports/{report_id}/revisions/106").status_code == 404
    assert client.get(BASE + f"/reports/{report_id}/revisions/0").status_code == 422
    assert client.get(BASE + f"/reports/{report_id}").json()["revision"] == 105


def test_validation_and_storage_errors_do_not_echo_case_labels(case_client, monkeypatch):
    client, _ = case_client
    marker = "PRIVATEANONYMOUSLABEL974ONLY"
    invalid = case_request(label=marker, unexpected_owner_id="forged")
    response = client.post(BASE + "/student-cases", json=invalid)
    assert response.status_code == 422
    assert marker not in response.text
    assert response.json()["error_code"] == "teaching_invalid_request"
    assert client.get(BASE + "/student-cases/not-a-uuid").status_code == 422
    saved, _ = create_case(client)
    assert (
        client.get(BASE + f"/student-cases/{saved['case_id']}/timeline?cursor=invalid").status_code
        == 422
    )

    def unavailable():
        raise OSError("PRIVATE internal storage path")

    monkeypatch.setattr(teaching_cases, "get_student_case_store", unavailable)
    response = client.get(BASE + "/student-cases")
    assert response.status_code == 503
    assert "PRIVATE" not in response.text
    assert "Reload" in response.json()["detail"]
