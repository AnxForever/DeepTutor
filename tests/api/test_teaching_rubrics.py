"""Real admin dependency plus isolated workspace template APIs; no model calls."""

from __future__ import annotations

from contextvars import ContextVar
from types import SimpleNamespace
from uuid import uuid4

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.testclient import TestClient
import pytest

from deeptutor.api.routers import auth, teaching_rubrics
from deeptutor.learning.teaching_analysis import rubrics
from deeptutor.services.auth import TokenPayload

PREFIX = "/api/teaching-analysis"


def payload(template_id=None, expected_revision=0, **changes):
    return {
        "template_id": template_id or str(uuid4()),
        "expected_revision": expected_revision,
        "name": "分数加法评分标准",
        "subject": "数学",
        "grade": "五年级",
        "criteria": "检查计算过程和结果。",
        **changes,
    }


@pytest.fixture
def rubric_client(tmp_path, monkeypatch):
    selected = ContextVar("rubric_api_scope", default=("local", "default"))
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
            token = tokens.get((authorization or "").removeprefix("Bearer "))
            if token is None:
                raise HTTPException(401, "Not authenticated")
            account = token.username
        else:
            token, account = None, "local"
        workspace = request.query_params.get("dt_workspace", "default")
        if workspace not in {"default", "second"}:
            raise HTTPException(404, "Workspace not available")
        selected.set((account, workspace))
        return token

    def paths():
        account, workspace = selected.get()
        return SimpleNamespace(get_workspace_dir=lambda: tmp_path / account / workspace)

    monkeypatch.setattr(rubrics, "get_path_service", paths)
    app = FastAPI()
    app.include_router(teaching_rubrics.router, prefix=PREFIX)
    app.dependency_overrides[auth.require_auth] = scoped_auth
    with TestClient(app) as client:
        yield client, tmp_path


def test_first_gets_do_not_create_any_template_database(rubric_client):
    client, root = rubric_client
    assert client.get(PREFIX + "/rubrics").json() == []
    for path in (f"/rubrics/{uuid4()}", f"/rubrics/{uuid4()}/revisions"):
        assert client.get(PREFIX + path).status_code == 404
    assert not list(root.rglob("rubrics.sqlite3"))


@pytest.mark.parametrize("role", ["learner", "teacher", "user"])
def test_non_admins_cannot_read_or_write_templates(rubric_client, monkeypatch, role):
    client, root = rubric_client
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    headers = {"Authorization": "Bearer " + role}
    requests = [
        ("GET", "/rubrics", {}),
        ("POST", "/rubrics", {"json": payload()}),
        ("GET", f"/rubrics/{uuid4()}", {}),
        ("GET", f"/rubrics/{uuid4()}/revisions", {}),
    ]
    for method, path, kwargs in requests:
        assert client.request(method, PREFIX + path, headers=headers, **kwargs).status_code == 403
    assert not list(root.rglob("rubrics.sqlite3"))


def test_auth_enabled_requires_login(rubric_client, monkeypatch):
    client, root = rubric_client
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    assert client.get(PREFIX + "/rubrics").status_code == 401
    assert client.post(PREFIX + "/rubrics", json=payload()).status_code == 401
    assert not list(root.rglob("rubrics.sqlite3"))


def test_local_user_can_create_edit_retry_and_view_immutable_history(rubric_client):
    client, root = rubric_client
    initial = payload()
    url = PREFIX + "/rubrics"
    response = client.post(url, json=initial)
    assert response.status_code == 200, response.text
    first = response.json()
    assert first["revision"] == 1
    assert client.post(url, json=initial).json() == first
    edit = payload(first["template_id"], 1, name="新版评分标准", criteria="检查结果、过程及单位。")
    updated = client.post(url, json=edit)
    assert updated.status_code == 200, updated.text
    second = updated.json()
    assert second["revision"] == 2
    assert client.post(url, json=edit).json() == second
    assert client.get(url).json() == [second]
    assert client.get(url + f"/{first['template_id']}").json() == second
    assert client.get(url + f"/{first['template_id']}/revisions").json() == [second, first]
    assert not list(root.rglob("reports.sqlite3"))


def test_stale_edit_is_a_conflict_and_preserves_both_versions(rubric_client):
    client, _ = rubric_client
    initial = payload()
    url = PREFIX + "/rubrics"
    first = client.post(url, json=initial).json()
    second = client.post(url, json=payload(first["template_id"], 1, criteria="标准二。"))
    assert second.status_code == 200
    conflict = client.post(url, json=payload(first["template_id"], 1, criteria="陈旧标准。"))
    assert conflict.status_code == 409
    assert len(client.get(url + f"/{first['template_id']}/revisions").json()) == 2


def test_factory_resolves_current_scope_for_each_request(rubric_client, monkeypatch):
    client, _ = rubric_client
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    alice = {"Authorization": "Bearer admin-a"}
    bob = {"Authorization": "Bearer admin-b"}
    initial = payload()
    assert client.post(PREFIX + "/rubrics", headers=alice, json=initial).status_code == 200
    template_url = PREFIX + f"/rubrics/{initial['template_id']}"
    assert client.get(template_url, headers=bob).status_code == 404
    assert client.get(template_url + "?dt_workspace=second", headers=alice).status_code == 404
    assert client.get(PREFIX + "/rubrics", headers=bob).json() == []
    assert client.get(PREFIX + "/rubrics?dt_workspace=second", headers=alice).json() == []
    other = payload(initial["template_id"], criteria="另一工作区的独立标准。")
    assert client.post(PREFIX + "/rubrics", headers=bob, json=other).status_code == 200
    assert client.get(template_url, headers=alice).json()["criteria"] == initial["criteria"]
    assert client.get(template_url, headers=bob).json()["criteria"] == other["criteria"]


@pytest.mark.parametrize(
    "changes",
    [
        {"template_id": "../other"},
        {"expected_revision": -1},
        {"expected_revision": True},
        {"expected_revision": "0"},
        {"name": " "},
        {"criteria": " "},
        {"criteria": "x" * 6001},
        {"subject": "x" * 201},
        {"revision": 1},
    ],
)
def test_invalid_payload_is_rejected_before_storage(rubric_client, changes):
    client, root = rubric_client
    response = client.post(PREFIX + "/rubrics", json=payload(**changes))
    assert response.status_code == 422, response.text
    assert not list(root.rglob("rubrics.sqlite3"))


def test_invalid_uuid_paths_are_validation_errors(rubric_client):
    client, root = rubric_client
    assert client.get(PREFIX + "/rubrics/not-a-uuid").status_code == 422
    assert client.get(PREFIX + "/rubrics/not-a-uuid/revisions").status_code == 422
    assert not list(root.rglob("rubrics.sqlite3"))


def test_storage_errors_are_generic_and_do_not_expose_paths(rubric_client, monkeypatch):
    client, _ = rubric_client

    def unavailable():
        raise OSError("private filesystem path and student criteria")

    monkeypatch.setattr(teaching_rubrics, "get_rubric_store", unavailable)
    response = client.get(PREFIX + "/rubrics")
    assert response.status_code == 503
    assert "private" not in response.text
    assert "criteria" not in response.text
