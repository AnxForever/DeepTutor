"""A new task surface must not retroactively expand existing learner grants."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from deeptutor.multi_user import identity
from deeptutor.multi_user.grants import learner_grant, normalize_grant, save_grant, validate_grant
from deeptutor.multi_user.learning_access import assert_learning_surface, learning_policy_for_user


def test_tasks_default_is_opt_in_only_for_new_account_provisioning(mu_isolated_root):
    legacy = learner_grant("u_existing")
    new = learner_grant("u_new", include_tasks=True)
    assert legacy["learning_policy"]["allowed_surfaces"] == ["chat", "reading"]
    assert new["learning_policy"]["allowed_surfaces"] == ["chat", "reading", "tasks"]
    validate_grant(legacy)
    validate_grant(new)


@pytest.mark.parametrize("surfaces", [["reading"], ["chat", "reading"], ["tasks"]])
def test_existing_explicit_lists_are_preserved_exactly(mu_isolated_root, surfaces):
    existing = learner_grant("u_existing")
    existing["learning_policy"]["allowed_surfaces"] = surfaces
    normalized = normalize_grant("u_existing", existing)
    validate_grant(normalized)
    assert normalized["learning_policy"]["allowed_surfaces"] == surfaces


def test_existing_missing_policy_fallback_does_not_enable_tasks(mu_isolated_root, as_user):
    identity.save_user("adult", "synthetic-unused-hash", role="admin")
    learner = identity.save_user("old-learner", "synthetic-unused-hash", preset="learner")
    policy = learning_policy_for_user(learner["id"])
    assert policy["allowed_surfaces"] == ["chat", "reading"]
    with as_user(learner["id"], username="old-learner"):
        with pytest.raises(PermissionError):
            assert_learning_surface("tasks")
        save_grant(learner["id"], learner_grant(learner["id"], include_tasks=True))
        assert_learning_surface("tasks")


def test_new_learner_created_by_admin_receives_the_explicit_task_default(
    mu_isolated_root, monkeypatch
):
    from deeptutor.api.routers import auth
    from deeptutor.multi_user.grants import load_grant
    from deeptutor.services.auth import TokenPayload

    adult = identity.save_user("adult", "synthetic-unused-hash", role="admin")
    monkeypatch.setattr(auth, "POCKETBASE_ENABLED", False)
    body = auth.AdminCreateUserRequest.model_validate(
        {
            "username": "new-learner",
            "pass" + "word": "synthetic-child-credential",  # pragma: allowlist secret
            "preset": "learner",
        }
    )
    result = auth._create_admin_user(
        body, TokenPayload(username="adult", role="admin", user_id=adult["id"])
    )
    assert load_grant(result["user_id"])["learning_policy"]["allowed_surfaces"] == [
        "chat",
        "reading",
        "tasks",
    ]


@pytest.mark.parametrize(
    "path", ["/api/student-tasks", "/api/student-tasks/today", "/api/student-tasks/id/answers"]
)
def test_student_task_surface_uses_an_exact_slash_bounded_prefix(path):
    from deeptutor.api.routers.auth import _learning_surface_for_path

    assert _learning_surface_for_path(path) == "tasks"


@pytest.mark.parametrize(
    "path", ["/api/student-tasks-admin", "/api/student-tasks-other/id", "/api/student-task"]
)
def test_lookalike_prefixes_do_not_gain_task_surface_access(path):
    from deeptutor.api.routers.auth import _learning_surface_for_path

    assert _learning_surface_for_path(path) == ""


@pytest.mark.parametrize("path", ["/api/student-tasks", "/api/student-tasks/id/submit"])
def test_account_global_task_requests_never_resolve_a_teacher_or_archived_workspace(
    monkeypatch, path
):
    from deeptutor.api.routers import auth
    from deeptutor.services.workspace import context

    selected = []

    def install(value):
        selected.append(value)
        return SimpleNamespace(workspace_id="", archived=value is not None)

    monkeypatch.setattr(context, "install_workspace_scope", install)
    request = SimpleNamespace(
        headers={},
        query_params={"dt_workspace": "teacher-private-or-archived-workspace"},
        url=SimpleNamespace(path=path),
        method="POST",
        state=None,
    )
    auth._install_request_workspace(request)
    assert selected == [None]


def test_non_task_lookalike_keeps_normal_workspace_enforcement(monkeypatch):
    from deeptutor.api.routers import auth
    from deeptutor.services.workspace import context

    selected = []

    def install(value):
        selected.append(value)
        return SimpleNamespace(workspace_id="same", archived=False)

    monkeypatch.setattr(context, "install_workspace_scope", install)
    auth._install_request_workspace(
        SimpleNamespace(
            headers={},
            query_params={"dt_workspace": "existing-own-workspace"},
            url=SimpleNamespace(path="/api/student-tasks-admin"),
            method="GET",
            state=None,
        )
    )
    assert selected == ["existing-own-workspace"]


def test_global_tasks_ignore_a_stale_teacher_header_even_with_empty_query_scope(monkeypatch):
    from deeptutor.api.routers import auth
    from deeptutor.services.workspace import context

    selected = []

    def install(value):
        selected.append(value)
        return SimpleNamespace(workspace_id="", archived=False)

    monkeypatch.setattr(context, "install_workspace_scope", install)
    auth._install_request_workspace(
        SimpleNamespace(
            headers={"x-deeptutor-workspace": "teacher-private-archived-workspace"},
            query_params={"dt_workspace": ""},
            url=SimpleNamespace(path="/api/student-tasks/today"),
            method="POST",
            state=None,
        )
    )
    assert selected == [None]


def test_lookalike_still_rejects_conflicting_scope_selectors():
    from fastapi import HTTPException

    from deeptutor.api.routers import auth

    with pytest.raises(HTTPException) as error:
        auth._install_request_workspace(
            SimpleNamespace(
                headers={"x-deeptutor-workspace": "first"},
                query_params={"dt_workspace": "second"},
                url=SimpleNamespace(path="/api/student-tasks-admin"),
                method="GET",
                state=None,
            )
        )
    assert error.value.status_code == 400
