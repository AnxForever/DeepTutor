"""Worksheet downloads are scoped, read-only and student-safe by default."""

from __future__ import annotations

from contextvars import ContextVar
import hashlib
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.testclient import TestClient
import pytest

from deeptutor.api.routers import auth, teaching_worksheets
from deeptutor.learning.teaching_analysis import followups
from deeptutor.learning.teaching_analysis.followup_models import (
    SaveFollowupAttemptRequest,
    SaveFollowupRequest,
)
from deeptutor.learning.teaching_analysis.followups import FollowupStore
from deeptutor.learning.teaching_analysis.storage import TeachingAnalysisStore
from deeptutor.learning.teaching_analysis.worksheets import WORKSHEET_CSP
from deeptutor.services.auth import TokenPayload
from deeptutor.services.path_service import PathService

BASE = "/api/teaching-analysis/followups"
ANSWER = "PRIVATEANSWER7549ONLY"
RUBRIC = "PRIVATERUBRIC7549ONLY"
STUDENT = "PRIVATESTUDENT7549ONLY"
ORIGINAL = "PRIVATEORIGINAL7549ONLY"
FEEDBACK = "PRIVATEFEEDBACK7549ONLY"
DIAGNOSIS = "PRIVATEDIAGNOSIS7549ONLY"
SOURCE_HASH = "abcdef" * 10 + "abcd"


@pytest.fixture
def worksheet_client(tmp_path, monkeypatch):
    selected = ContextVar("worksheet_test_scope", default=("local", "default"))
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
        selected.set((payload.username if payload else "local", workspace))
        return payload

    def paths():
        account, workspace = selected.get()
        return PathService(tmp_path / account / workspace)

    monkeypatch.setattr(followups, "get_path_service", paths)
    app = FastAPI()
    app.include_router(teaching_worksheets.router, prefix="/api/teaching-analysis")
    app.dependency_overrides[auth.require_auth] = scoped_auth
    with TestClient(app) as client:
        yield client, tmp_path


def seed(root, *, account="local", workspace="default", versions=1, title=None, stem=None):
    feature_root = PathService(root / account / workspace).get_workspace_dir() / "teaching-analysis"
    reports = TeachingAnalysisStore(feature_root)
    report_id = str(uuid4())
    reports.save_report(
        report_id,
        0,
        {
            "assignment": {
                "student_ref": STUDENT,
                "assignment_ref": "Private source",
                "subject": "Math",
                "grade": "Grade 5",
            },
            "analysis": {"priorities": [{"knowledge_point": DIAGNOSIS}]},
            "source_fingerprint": SOURCE_HASH,
            "status": "confirmed",
        },
    )
    store = FollowupStore(feature_root)
    followup_id = str(uuid4())
    for revision in range(1, versions + 1):
        store.save_followup(
            SaveFollowupRequest.model_validate(
                {
                    "followup_id": followup_id,
                    "expected_revision": revision - 1,
                    "report_id": report_id,
                    "report_revision": 1,
                    "priority_index": 0,
                    "title": title if title is not None else f"Worksheet version {revision}",
                    "questions": [
                        {
                            "question_id": "F1",
                            "question": stem
                            if stem is not None
                            else f"Version {revision}: compute 1 + 1.",
                            "reference_answer": ANSWER,
                            "rubric": RUBRIC,
                        }
                    ],
                }
            )
        )
    return store, followup_id, report_id


def tree_snapshot(root: Path):
    return {
        str(path.relative_to(root)): (
            hashlib.sha256(path.read_bytes()).hexdigest(),
            path.stat().st_mtime_ns,
        )
        for path in root.rglob("*")
        if path.is_file()
    }


def test_default_is_student_html_with_safe_headers_and_no_private_content(worksheet_client):
    client, root = worksheet_client
    store, identifier, source_id = seed(
        root, versions=2, title="练习\r\nX-Injected: yes/../../名称"
    )
    store.record_attempt(
        identifier,
        SaveFollowupAttemptRequest(
            attempt_id=uuid4(),
            followup_revision=2,
            question_id="F1",
            student_answer=ORIGINAL,
            answer_status="present",
            teacher_result="correct",
            teacher_feedback=FEEDBACK,
        ),
    )
    before = tree_snapshot(root)
    response = client.get(f"{BASE}/{identifier}/worksheet")
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/html; charset=utf-8"
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["content-language"] == "zh"
    assert response.headers["content-security-policy"] == WORKSHEET_CSP
    assert (
        response.headers["content-disposition"]
        == f'attachment; filename="practice-{identifier}-v2-student.html"'
    )
    assert "Version 2: compute 1 + 1." in response.text
    for private in (ANSWER, RUBRIC, STUDENT, ORIGINAL, FEEDBACK, DIAGNOSIS, source_id, SOURCE_HASH):
        assert private not in response.text
    assert "教师版" not in response.text
    assert tree_snapshot(root) == before


def test_teacher_edition_is_explicit_and_markdown_has_correct_type(worksheet_client):
    client, root = worksheet_client
    _, identifier, source_id = seed(root)
    response = client.get(
        f"{BASE}/{identifier}/worksheet?audience=teacher&format=markdown&language=en"
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/markdown; charset=utf-8"
    assert response.headers["content-language"] == "en"
    assert response.headers["content-disposition"].endswith('-v1-teacher.md"')
    assert "TEACHER EDITION · CONTAINS ANSWER KEYS" in response.text
    assert ANSWER in response.text and RUBRIC in response.text
    for private in (STUDENT, ORIGINAL, FEEDBACK, DIAGNOSIS, source_id, SOURCE_HASH):
        assert private not in response.text


def test_student_markdown_does_not_contain_teacher_fields(worksheet_client):
    client, root = worksheet_client
    _, identifier, _ = seed(root)
    response = client.get(f"{BASE}/{identifier}/worksheet?format=markdown")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/markdown")
    assert ANSWER not in response.text and RUBRIC not in response.text
    assert "姓名" in response.text and "日期" in response.text


def test_requested_history_is_exact_even_older_than_latest_hundred(worksheet_client):
    client, root = worksheet_client
    _, identifier, _ = seed(root, versions=105)
    old = client.get(f"{BASE}/{identifier}/worksheet?revision=1")
    assert old.status_code == 200
    assert "Worksheet version 1</h1>" in old.text
    assert "Version 1: compute 1 + 1." in old.text
    assert "Version 105: compute" not in old.text
    assert old.headers["content-disposition"].endswith('-v1-student.html"')
    numbered_above_hundred = client.get(f"{BASE}/{identifier}/worksheet?revision=101")
    assert numbered_above_hundred.status_code == 200
    assert "Version 101: compute" in numbered_above_hundred.text
    assert client.get(f"{BASE}/{identifier}/worksheet?revision=106").status_code == 404
    assert "Version 105: compute" in client.get(f"{BASE}/{identifier}/worksheet").text


def test_missing_and_invalid_revision_do_not_create_or_fallback(worksheet_client):
    client, root = worksheet_client
    assert client.get(f"{BASE}/{uuid4()}/worksheet?revision=1").status_code == 404
    assert not list(root.rglob("*.sqlite3"))
    _, identifier, _ = seed(root)
    for query in ("revision=0", "revision=-1", "audience=other", "format=pdf", "language=xx"):
        assert client.get(f"{BASE}/{identifier}/worksheet?{query}").status_code == 422
    assert client.get(f"{BASE}/not-a-uuid/worksheet").status_code == 422


@pytest.mark.parametrize("role", ["student", "teacher", "user"])
def test_non_admin_cannot_download_any_edition(worksheet_client, monkeypatch, role):
    client, root = worksheet_client
    _, identifier, _ = seed(root)
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    for audience in ("student", "teacher"):
        response = client.get(
            f"{BASE}/{identifier}/worksheet?audience={audience}",
            headers={"Authorization": f"Bearer {role}"},
        )
        assert response.status_code == 403


def test_login_and_scope_guards_cannot_read_another_workspace(worksheet_client, monkeypatch):
    client, root = worksheet_client
    _, identifier, _ = seed(root, account="alice")
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    url = f"{BASE}/{identifier}/worksheet"
    assert client.get(url).status_code == 401
    alice = {"Authorization": "Bearer admin-a"}
    bob = {"Authorization": "Bearer admin-b"}
    assert client.get(url, headers=alice).status_code == 200
    assert client.get(url, headers=bob).status_code == 404
    assert client.get(url + "?dt_workspace=second", headers=alice).status_code == 404


def test_html_payloads_are_escaped_and_do_not_create_external_resources(worksheet_client):
    client, root = worksheet_client
    payload = '<img src="https://invalid.example/image"><script>alert(1)</script>'
    _, identifier, _ = seed(root, title=payload, stem=payload)
    response = client.get(f"{BASE}/{identifier}/worksheet")
    assert response.status_code == 200
    assert "<img" not in response.text and "<script" not in response.text
    assert "&lt;img" in response.text and "&lt;script&gt;" in response.text
    assert "default-src 'none'" in response.headers["content-security-policy"]


def test_storage_errors_do_not_expose_local_paths(worksheet_client, monkeypatch):
    client, _ = worksheet_client

    def broken():
        raise OSError("PRIVATE internal path or diagnostic")

    monkeypatch.setattr(teaching_worksheets, "get_followup_store", broken)
    response = client.get(f"{BASE}/{uuid4()}/worksheet")
    assert response.status_code == 503
    assert "PRIVATE" not in response.text
