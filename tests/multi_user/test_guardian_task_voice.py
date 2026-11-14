"""Only an existing restrictions authority may change task recognition opt-in."""

from __future__ import annotations

from copy import deepcopy

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from deeptutor.multi_user import grants, guardians, identity
from deeptutor.services import auth as auth_service


@pytest.fixture
def voice_accounts(mu_isolated_root, monkeypatch):
    from deeptutor.api.routers import auth as auth_router
    from deeptutor.api.routers import multi_user as router

    monkeypatch.setattr(auth_router, "AUTH_ENABLED", True)
    monkeypatch.setattr(auth_router, "POCKETBASE_ENABLED", False)
    monkeypatch.setattr(router, "POCKETBASE_ENABLED", False)
    monkeypatch.setattr(auth_service, "POCKETBASE_ENABLED", False)
    monkeypatch.setattr(
        auth_service, "AUTH_SECRET", "synthetic-task-voice-signing-material"
    )  # pragma: allowlist secret
    adult = identity.save_user("adult", "synthetic-unused-hash", role="admin")
    guardian = identity.save_user("guardian", "synthetic-unused-hash")
    learner = identity.save_user("learner", "synthetic-unused-hash", preset="learner")
    viewer = identity.save_user("viewer", "synthetic-unused-hash")
    grant = grants.learner_grant(learner["id"], include_tasks=True)
    grants.save_grant(learner["id"], grant)
    guardians.authorize_guardian(guardian["id"], learner["id"], ["manage_restrictions"])
    guardians.authorize_guardian(viewer["id"], learner["id"], ["view_reports"])
    app = FastAPI()
    app.include_router(router.router, prefix="/api/multi-user")

    def headers(username, user):
        token = auth_service.create_token(username, user["role"], user_id=user["id"])
        return {"Authorization": f"Bearer {token}"}

    with TestClient(app) as client:
        yield {
            "client": client,
            "url": f"/api/multi-user/learners/{learner['id']}/restrictions",
            "uid": learner["id"],
            "adult": headers("adult", adult),
            "guardian": headers("guardian", guardian),
            "learner": headers("learner", learner),
            "viewer": headers("viewer", viewer),
            "grant": grant,
        }


def restrictions_payload(**changes):
    return {
        "age_band": "9-12",
        "allow_upload": False,
        "allowed_surfaces": ["chat", "reading", "tasks"],
        "extensions": [],
        **changes,
    }


@pytest.mark.parametrize("authority", ["adult", "guardian"])
def test_existing_restrictions_authority_can_opt_in_and_revoke(voice_accounts, authority):
    setup = voice_accounts
    client, uid = setup["client"], setup["uid"]
    original = deepcopy(setup["grant"])
    before = client.get(setup["url"], headers=setup[authority])
    assert before.status_code == 200
    assert "task_voice_input" not in before.json()["restrictions"]
    for enabled in (True, False):
        result = client.put(
            setup["url"],
            headers=setup[authority],
            json=restrictions_payload(task_voice_input=enabled),
        )
        assert result.status_code == 200, result.text
        assert result.json()["restrictions"]["task_voice_input"] is enabled
        saved = grants.load_grant(uid)
        assert saved["learning_policy"].pop("task_voice_input") is enabled
        assert saved == original


def test_legacy_omission_preserves_both_old_absence_and_existing_explicit_opt_in(voice_accounts):
    setup = voice_accounts
    client = setup["client"]
    for initial in (None, True, False):
        grant = deepcopy(setup["grant"])
        if initial is not None:
            grant["learning_policy"]["task_voice_input"] = initial
        grants.save_grant(setup["uid"], grant)
        before = grants.grant_path(setup["uid"]).read_bytes()
        result = client.put(setup["url"], headers=setup["guardian"], json=restrictions_payload())
        assert result.status_code == 200
        assert grants.grant_path(setup["uid"]).read_bytes() == before
        if initial is None:
            assert "task_voice_input" not in result.json()["restrictions"]
        else:
            assert result.json()["restrictions"]["task_voice_input"] is initial


@pytest.mark.parametrize("value", [None, 0, 1, "true", "false", [], {}])
def test_guardian_rejects_non_boolean_voice_opt_in_without_writing(voice_accounts, value):
    setup = voice_accounts
    path = grants.grant_path(setup["uid"])
    before = path.read_bytes()
    result = setup["client"].put(
        setup["url"],
        headers=setup["guardian"],
        json=restrictions_payload(task_voice_input=value),
    )
    assert result.status_code == 422
    assert path.read_bytes() == before


@pytest.mark.parametrize("actor", ["learner", "viewer"])
def test_task_voice_checkbox_does_not_expand_guardian_authority(voice_accounts, actor):
    setup = voice_accounts
    path = grants.grant_path(setup["uid"])
    before = path.read_bytes()
    result = setup["client"].put(
        setup["url"],
        headers=setup[actor],
        json=restrictions_payload(task_voice_input=True),
    )
    assert result.status_code == 403
    assert path.read_bytes() == before


def test_voice_opt_in_does_not_authorize_guardian_to_publish_tasks(voice_accounts):
    from deeptutor.multi_user.context import user_from_token_payload
    from deeptutor.multi_user.learning_tasks_access import (
        LearningTaskAccessError,
        require_task_admin,
    )

    encoded = voice_accounts["guardian"]["Authorization"].removeprefix("Bearer ")
    payload = auth_service.decode_token(encoded)
    assert payload is not None
    actor = user_from_token_payload(payload)
    with pytest.raises(LearningTaskAccessError) as error:
        require_task_admin(auth_enabled=True, publishing=True, actor=actor)
    assert error.value.code == "admin_access_required"
