"""Teacher reports stay reviewable, scoped, and independent of learner state."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar
import json
from pathlib import Path
import stat
from types import SimpleNamespace
from uuid import uuid4

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.testclient import TestClient
import pytest

from deeptutor.api.routers import auth
from deeptutor.api.routers import teaching_analysis as router
from deeptutor.learning.teaching_analysis.models import AssignmentInput, GeneratedAnalysis
from deeptutor.learning.teaching_analysis.service import (
    AnalysisNotConfigured,
    AnalysisUnavailable,
    fingerprint_assignment,
)
from deeptutor.learning.teaching_analysis.storage import (
    ReportConflict,
    TeachingAnalysisStore,
)
from deeptutor.services.auth import TokenPayload
from deeptutor.services.path_service import PathService


def assignment(**changes) -> dict:
    return AssignmentInput.model_validate(
        {
            "student_ref": "student-a",
            "assignment_ref": "worksheet-a",
            "subject": "Mathematics",
            "items": [
                {
                    "question_id": "Q1",
                    "question": "What is 1 + 1? Show your work.",
                    "student_answer": "3",
                    "student_work": "1 + 1 = 3",
                    "reference_answer": "2",
                    "knowledge_points": ["Addition"],
                    "source_locator": "Page 1, question 1",
                    "answer_status": "present",
                    "transcription_status": "confirmed",
                    "assistance": "independent",
                }
            ],
            **changes,
        }
    ).model_dump(mode="json")


def analysis() -> dict:
    return {
        "summary": "Check this addition with the student before inferring a cause.",
        "items": [
            {
                "question_id": "Q1",
                "result": "incorrect",
                "observation": "The written result is 3; 1 + 1 is 2.",
                "evidence": [{"question_id": "Q1", "field": "student_answer", "quote": "3"}],
            }
        ],
        "priorities": [],
        "limitations": ["One item does not establish a persistent misconception."],
    }


def save_request(**changes) -> dict:
    material = assignment()
    return {
        "report_id": str(uuid4()),
        "expected_revision": 0,
        "assignment": material,
        "analysis": analysis(),
        "source_fingerprint": fingerprint_assignment(AssignmentInput.model_validate(material)),
        "status": "draft",
        "teacher_notes": "",
        **changes,
    }


@pytest.fixture
def report_client(tmp_path, monkeypatch):
    """Exercise the real admin guard with explicitly injected test scopes.

    Existing authentication/workspace suites own JWT and workspace-catalog
    validation. Here an async auth override installs a test-only scoped path
    so the router/storage contract cannot fall back to the first request's
    account or workspace. No real account, catalog, or model config is read.
    """
    from deeptutor.learning.teaching_analysis import storage

    selected = ContextVar("teacher_report_test_scope", default=("local", "default"))
    tokens = {
        "admin-a": TokenPayload(username="alice", role="admin", user_id="alice"),
        "admin-b": TokenPayload(username="bob", role="admin", user_id="bob"),
        "learner": TokenPayload(username="learner", role="student", user_id="learner"),
        "teacher": TokenPayload(username="teacher", role="teacher", user_id="teacher"),
        "user": TokenPayload(username="user", role="user", user_id="user"),
    }
    monkeypatch.setattr(auth, "AUTH_ENABLED", False)

    async def scoped_auth(
        request: Request, authorization: str | None = Header(default=None)
    ) -> TokenPayload | None:
        if auth.AUTH_ENABLED:
            payload = tokens.get((authorization or "").removeprefix("Bearer "))
            if payload is None:
                raise HTTPException(401, "Not authenticated")
            account = payload.username
        else:
            payload = None
            account = "local"
        workspace = request.query_params.get("dt_workspace", "default")
        if workspace not in {"default", "second"}:
            raise HTTPException(404, "Workspace not available")
        selected.set((account, workspace))
        return payload

    def scoped_paths():
        account, workspace = selected.get()
        return PathService(tmp_path / account / workspace)

    monkeypatch.setattr(storage, "get_path_service", scoped_paths)
    app = FastAPI()
    app.include_router(router.router, prefix="/api/teaching-analysis")
    app.dependency_overrides[auth.require_auth] = scoped_auth
    with TestClient(app) as client:
        yield client, tmp_path


def test_empty_reads_do_not_create_report_storage(report_client):
    client, root = report_client
    assert client.get("/api/teaching-analysis/reports").json() == []
    assert client.get(f"/api/teaching-analysis/reports/{uuid4()}").status_code == 404
    assert not list(root.rglob("reports.sqlite3"))


@pytest.mark.parametrize("token", ["learner", "teacher", "user"])
def test_non_admin_cannot_import_analyze_or_save(report_client, monkeypatch, token):
    client, root = report_client
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    headers = {"Authorization": f"Bearer {token}"}
    requests = [
        ("GET", "/reports", {}),
        ("POST", "/preview", {"files": {"file": ("work.json", b"[]", "application/json")}}),
        ("POST", "/analyze", {"json": assignment()}),
        ("POST", "/reports", {"json": save_request()}),
        ("GET", f"/reports/{uuid4()}", {}),
        ("GET", f"/reports/{uuid4()}/revisions", {}),
    ]
    for method, path, kwargs in requests:
        response = client.request(
            method, "/api/teaching-analysis" + path, headers=headers, **kwargs
        )
        assert response.status_code == 403, (method, path, response.text)
    assert not list(root.rglob("reports.sqlite3"))


def test_auth_enabled_requires_login(report_client, monkeypatch):
    client, _ = report_client
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    assert client.get("/api/teaching-analysis/reports").status_code == 401


def test_preview_accepts_optional_reference_without_creating_entries(report_client):
    client, root = report_client
    material = assignment()
    material["items"][0]["reference_answer"] = None
    response = client.post(
        "/api/teaching-analysis/preview",
        files={"file": ("assignment.json", json.dumps(material).encode(), "application/json")},
    )
    assert response.status_code == 200, response.text
    assert response.json()["items"][0]["reference_answer"] is None
    assert response.json()["items"][0]["answer_status"] == "present"
    assert not list(root.rglob("*.sqlite3"))


def test_preview_rejects_large_invalid_and_evaluation_payloads(report_client):
    client, root = report_client
    large = client.post(
        "/api/teaching-analysis/preview",
        files={"file": ("work.json", b" " * (1024 * 1024 + 1), "application/json")},
    )
    assert large.status_code == 413
    for data in (b"not JSON", b'{"cases": [], "expected": {}}'):
        response = client.post(
            "/api/teaching-analysis/preview",
            files={"file": ("work.json", data, "application/json")},
        )
        assert response.status_code == 422
    assert not list(root.rglob("reports.sqlite3"))


def test_analysis_returns_a_verifiable_draft_without_saving(report_client, monkeypatch):
    client, root = report_client
    received = []

    async def generate(value, language):
        received.append((value, language))
        return GeneratedAnalysis(
            analysis=analysis(), source_fingerprint=fingerprint_assignment(value)
        )

    monkeypatch.setattr(router, "analyze_assignment", generate)
    response = client.post("/api/teaching-analysis/analyze?language=en", json=assignment())
    assert response.status_code == 200, response.text
    assert response.json()["analysis"] == analysis()
    assert response.json()["source_fingerprint"] == fingerprint_assignment(received[0][0])
    assert received[0][1] == "en"
    assert not list(root.rglob("reports.sqlite3"))


def test_missing_analysis_metadata_is_rejected_before_model_call(report_client, monkeypatch):
    client, _ = report_client

    async def unexpected(*args, **kwargs):
        pytest.fail("Invalid material must not reach the provider")

    monkeypatch.setattr(router, "analyze_assignment", unexpected)
    for key in ("student_ref", "assignment_ref", "subject"):
        response = client.post("/api/teaching-analysis/analyze", json=assignment(**{key: " "}))
        assert response.status_code == 422


@pytest.mark.parametrize(
    ("error", "status", "message"),
    [
        (AnalysisNotConfigured("private missing profile"), 503, "Settings"),
        (AnalysisUnavailable("private bad provider output"), 502, "could not be verified"),
        (RuntimeError("private api_key=not-for-the-client"), 502, "temporarily unavailable"),
    ],
)
def test_provider_failures_are_actionable_and_do_not_save(
    report_client, monkeypatch, error, status, message
):
    client, root = report_client

    async def unavailable(*args, **kwargs):
        raise error

    monkeypatch.setattr(router, "analyze_assignment", unavailable)
    response = client.post("/api/teaching-analysis/analyze", json=assignment())
    assert response.status_code == status
    detail = response.json()["detail"]
    assert message in (detail["message"] if isinstance(detail, dict) else detail)
    if isinstance(error, AnalysisNotConfigured):
        assert detail["error_code"] == "teaching_model_not_configured"
        assert detail["retryable"] is False
    assert "private" not in response.text and "api_key" not in response.text
    assert not list(root.rglob("reports.sqlite3"))


def test_explicit_save_retry_confirm_and_revision_history(report_client, monkeypatch):
    client, root = report_client

    async def unexpected(*args, **kwargs):
        pytest.fail("Saving a teacher review must not run another model call")

    monkeypatch.setattr(router, "analyze_assignment", unexpected)
    payload = save_request()
    first = client.post("/api/teaching-analysis/reports", json=payload)
    assert first.status_code == 200, first.text
    assert first.json()["revision"] == 1
    assert first.json()["status"] == "draft"
    assert client.post("/api/teaching-analysis/reports", json=payload).json() == first.json()
    confirmed = {
        **payload,
        "expected_revision": 1,
        "status": "confirmed",
        "teacher_notes": "Reviewed",
    }
    second = client.post("/api/teaching-analysis/reports", json=confirmed)
    assert second.status_code == 200
    assert second.json()["revision"] == 2
    assert second.json()["created_at"] == first.json()["created_at"]
    assert client.post("/api/teaching-analysis/reports", json=confirmed).json() == second.json()
    stale = {**payload, "teacher_notes": "Another browser still edited revision zero"}
    assert client.post("/api/teaching-analysis/reports", json=stale).status_code == 409
    url = f"/api/teaching-analysis/reports/{payload['report_id']}"
    assert client.get(url).json() == second.json()
    history = client.get(url + "/revisions").json()
    assert [item["revision"] for item in history] == [2, 1]
    assert history[1] == first.json()
    summary = client.get("/api/teaching-analysis/reports").json()
    assert len(summary) == 1 and summary[0]["revision"] == 2
    assert summary[0]["student_ref"] == payload["assignment"]["student_ref"]
    # Dedicated report storage cannot silently enroll questions or mastery evidence.
    assert len(list(root.rglob("reports.sqlite3"))) == 1
    assert not list(root.rglob("chat_history.db"))
    assert not list(root.rglob("learning.db"))


def test_changed_or_withdrawn_material_cannot_reuse_old_findings(report_client):
    client, _ = report_client
    payload = save_request()
    assert client.post("/api/teaching-analysis/reports", json=payload).status_code == 200
    changed = json.loads(json.dumps(payload))
    changed["expected_revision"] = 1
    changed["assignment"]["items"][0]["student_answer"] = "4"
    response = client.post("/api/teaching-analysis/reports", json=changed)
    assert response.status_code == 409
    changed["source_fingerprint"] = fingerprint_assignment(
        AssignmentInput.model_validate(changed["assignment"])
    )
    # Updating just the fingerprint cannot make the old quotation valid.
    assert client.post("/api/teaching-analysis/reports", json=changed).status_code == 422
    changed["assignment"]["items"] = []
    changed["source_fingerprint"] = fingerprint_assignment(
        AssignmentInput.model_validate(changed["assignment"])
    )
    assert client.post("/api/teaching-analysis/reports", json=changed).status_code == 422
    saved = client.get(f"/api/teaching-analysis/reports/{payload['report_id']}").json()
    assert saved["revision"] == 1
    assert saved["assignment"] == payload["assignment"]


def test_teacher_edits_and_corrections_preserve_prior_snapshot(report_client):
    client, _ = report_client
    payload = save_request(status="confirmed")
    original = client.post("/api/teaching-analysis/reports", json=payload).json()
    revised = json.loads(json.dumps(payload))
    revised["expected_revision"] = 1
    revised["assignment"]["items"][0]["student_answer"] = "2"
    revised["assignment"]["items"][0]["student_work"] = "1 + 1 = 2"
    revised["analysis"]["items"][0].update(
        result="correct",
        observation="The corrected transcript is 2.",
        evidence=[{"question_id": "Q1", "field": "student_answer", "quote": "2"}],
    )
    revised["analysis"]["summary"] = "Corrected original work was reviewed again."
    revised["source_fingerprint"] = fingerprint_assignment(
        AssignmentInput.model_validate(revised["assignment"])
    )
    revised["status"] = "draft"
    result = client.post("/api/teaching-analysis/reports", json=revised)
    assert result.status_code == 200, result.text
    assert result.json()["revision"] == 2 and result.json()["status"] == "draft"
    history = client.get(f"/api/teaching-analysis/reports/{payload['report_id']}/revisions").json()
    assert history[0]["assignment"]["items"][0]["student_answer"] == "2"
    assert history[1] == original


def test_reports_follow_each_request_account_and_workspace(report_client, monkeypatch):
    client, _ = report_client
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    alice = {"Authorization": "Bearer admin-a"}
    bob = {"Authorization": "Bearer admin-b"}
    payload = save_request()
    assert (
        client.post("/api/teaching-analysis/reports", json=payload, headers=alice).status_code
        == 200
    )
    report_url = f"/api/teaching-analysis/reports/{payload['report_id']}"
    assert client.get(report_url, headers=bob).status_code == 404
    assert client.get(report_url + "?dt_workspace=second", headers=alice).status_code == 404
    assert client.get("/api/teaching-analysis/reports", headers=bob).json() == []
    assert (
        client.get("/api/teaching-analysis/reports?dt_workspace=second", headers=alice).json() == []
    )
    other = {**payload, "teacher_notes": "A report separately saved in Bob's scope"}
    assert client.post("/api/teaching-analysis/reports", json=other, headers=bob).status_code == 200
    assert client.get(report_url, headers=alice).json()["teacher_notes"] == ""
    assert client.get(report_url, headers=bob).json()["teacher_notes"] == other["teacher_notes"]
    assert client.get(report_url + "?dt_workspace=second", headers=bob).status_code == 404


def test_unknown_uuid_and_invalid_request_are_not_storage_paths(report_client):
    client, root = report_client
    assert client.get("/api/teaching-analysis/reports/not-a-uuid").status_code == 422
    assert client.get(f"/api/teaching-analysis/reports/{uuid4()}/revisions").status_code == 404
    assert (
        client.post(
            "/api/teaching-analysis/reports", json=save_request(report_id="../other")
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/teaching-analysis/reports", json=save_request(expected_revision=-1)
        ).status_code
        == 422
    )
    assert not list(root.rglob("reports.sqlite3"))


def test_concurrent_teacher_edits_have_one_cas_winner(tmp_path):
    store = TeachingAnalysisStore(tmp_path / "scope")
    payload = save_request()
    content = {
        key: value
        for key, value in payload.items()
        if key not in {"report_id", "expected_revision"}
    }
    report_id = payload["report_id"]
    store.save_report(report_id, 0, content)

    def edit(note):
        try:
            return store.save_report(report_id, 1, content | {"teacher_notes": note})
        except ReportConflict:
            return None

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(edit, ("Edit A", "Edit B")))
    assert sum(value is not None for value in results) == 1
    assert store.get_report(report_id)["revision"] == 2
    assert len(store.revisions(report_id)) == 2


def test_report_storage_rejects_reparse_point_before_writing(tmp_path, monkeypatch):
    target = tmp_path / "redirected"
    original_lstat = Path.lstat

    def stat_for_test(path, *args, **kwargs):
        if path == target:
            return SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=0x400)
        return original_lstat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "lstat", stat_for_test)
    monkeypatch.setattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400, raising=False)
    with pytest.raises(ValueError, match="redirected paths"):
        TeachingAnalysisStore(target)
    assert not target.exists()


def test_report_storage_rejects_linked_database(tmp_path):
    store = TeachingAnalysisStore(tmp_path / "reports")
    store.root.mkdir()
    elsewhere = tmp_path / "outside.sqlite3"
    elsewhere.write_bytes(b"untouched")
    try:
        store.db_path.symlink_to(elsewhere)
    except OSError:
        pytest.skip("Creating symbolic links is not available to this test user")
    with pytest.raises(ValueError, match="redirected paths"):
        store.list_reports()
    assert elsewhere.read_bytes() == b"untouched"


def test_manifest_keeps_teacher_feature_owned_and_admin_only():
    path = Path(__file__).resolve().parents[2] / "deeptutor/modules/manifests/mastery.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    assert "deeptutor/api/routers/teaching_analysis.py" in manifest["paths"]
    assert "/learning/teaching-analysis" in manifest["navigation"]
    route = next(
        row
        for row in manifest["routes"]
        if row["reference"] == "deeptutor.api.routers.teaching_analysis:router"
    )
    assert route["auth"] == "admin"
    assert route["options"]["prefix"] == "/api/teaching-analysis"
