"""Task access rechecks real identities and grants instead of trusting old JWTs."""

from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace

import pytest

from deeptutor.multi_user import identity
from deeptutor.multi_user import learning_tasks_access as access
from deeptutor.multi_user.context import user_from_token_payload
from deeptutor.multi_user.grants import learner_grant, save_grant
from deeptutor.multi_user.models import LOCAL_ADMIN_ID
from deeptutor.services import auth as auth_service


@pytest.fixture
def accounts(mu_isolated_root, monkeypatch):
    monkeypatch.setattr(auth_service, "POCKETBASE_ENABLED", False)
    monkeypatch.setattr(
        auth_service, "AUTH_SECRET", "synthetic-test-signing-material"
    )  # pragma: allowlist secret
    admin = identity.save_user("adult", "synthetic-unused-hash", role="admin")
    kid = identity.save_user("kid", "synthetic-unused-hash", preset="learner")
    ordinary = identity.save_user("ordinary", "synthetic-unused-hash", role="student")
    save_grant(kid["id"], learner_grant(kid["id"], include_tasks=True))

    def actor(username, record):
        encoded = auth_service.create_token(username, record["role"], user_id=record["id"])
        payload = auth_service.decode_token(encoded)
        assert payload is not None
        return user_from_token_payload(payload)

    return {
        "admin": admin,
        "kid": kid,
        "ordinary": ordinary,
        "admin_actor": actor("adult", admin),
        "kid_actor": actor("kid", kid),
        "ordinary_actor": actor("ordinary", ordinary),
    }


def test_existing_learner_with_user_role_and_opaque_id_can_open_tasks(accounts):
    actor = accounts["kid_actor"]
    assert actor.role == "user" and actor.id.startswith("u_")
    assert access.require_task_learner(auth_enabled=True, actor=actor) == actor


@pytest.mark.parametrize(
    "change,code",
    [
        ("disabled", "account_disabled"),
        ("role", "identity_changed"),
        ("preset", "learner_access_required"),
        ("policy", "tasks_disabled"),
        ("deleted", "account_unavailable"),
    ],
)
def test_previously_valid_signed_token_cannot_survive_current_access_changes(
    accounts, change, code
):
    stale = accounts["kid_actor"]
    if change in {"disabled", "deleted"}:
        records = identity.load_users()
        if change == "deleted":
            records.pop("kid")
        else:
            records["kid"]["disabled"] = True
        identity._write_users(records)
    elif change == "role":
        identity.set_role("kid", "teacher")
    elif change == "preset":
        identity.set_preset("kid", "standard")
    else:
        save_grant(stale.id, learner_grant(stale.id))
    with pytest.raises(access.LearningTaskAccessError) as error:
        access.require_task_learner(auth_enabled=True, actor=stale)
    assert error.value.code == code
    assert error.value.status_code == 403
    assert stale.id not in str(error.value)


def test_student_role_label_does_not_replace_the_learner_preset(accounts):
    with pytest.raises(access.LearningTaskAccessError) as error:
        access.require_task_learner(auth_enabled=True, actor=accounts["ordinary_actor"])
    assert error.value.code == "learner_access_required"


def test_stale_admin_role_is_rejected_before_publishing(accounts):
    stale = accounts["admin_actor"]
    identity.set_role("adult", "user")
    with pytest.raises(access.LearningTaskAccessError) as error:
        access.require_task_admin(auth_enabled=True, publishing=True, actor=stale)
    assert error.value.code == "identity_changed"


def test_disabled_administrator_is_not_an_issue_authority(accounts):
    records = identity.load_users()
    records["adult"]["disabled"] = True
    identity._write_users(records)
    with pytest.raises(access.LearningTaskAccessError) as error:
        access.require_task_admin(auth_enabled=True, publishing=True, actor=accounts["admin_actor"])
    assert error.value.code == "account_disabled"


def test_authenticated_admin_is_not_a_student_or_a_task_recipient(accounts):
    with pytest.raises(access.LearningTaskAccessError):
        access.require_task_learner(auth_enabled=True, actor=accounts["admin_actor"])
    with pytest.raises(access.LearningTaskAccessError):
        access.require_task_recipient(
            accounts["admin"]["id"], auth_enabled=True, actor=accounts["admin_actor"]
        )


def test_native_auth_off_allows_only_local_adult_setup_without_identity_reads(
    make_user, monkeypatch
):
    local = make_user(LOCAL_ADMIN_ID, role="admin", username="local")
    monkeypatch.setattr(
        access, "get_user_by_id", lambda _uid: pytest.fail("Native setup must not load accounts")
    )
    monkeypatch.setattr(
        access, "list_user_info", lambda: pytest.fail("Native setup must not load accounts")
    )
    assert access.require_task_admin(auth_enabled=False, actor=local) == local
    assert access.task_recipient_setup(auth_enabled=False, actor=local) == {
        "enabled": False,
        "reason": "authentication_disabled",
        "recipients": [],
    }
    for operation in (
        lambda: access.require_task_admin(auth_enabled=False, publishing=True, actor=local),
        lambda: access.require_task_learner(auth_enabled=False, actor=local),
        lambda: access.require_task_recipient("u_any", auth_enabled=False, actor=local),
    ):
        with pytest.raises(access.LearningTaskAccessError) as error:
            operation()
        assert error.value.status_code == 403
        assert error.value.code == "authentication_disabled"


def test_pocketbase_setup_is_explicitly_unsupported_without_local_fallback(accounts, monkeypatch):
    monkeypatch.setattr(
        access, "get_user_by_id", lambda _uid: pytest.fail("No local fallback for another backend")
    )
    assert access.task_recipient_setup(
        auth_enabled=True, identity_backend_supported=False, actor=accounts["admin_actor"]
    ) == {"enabled": False, "reason": "unsupported_identity_backend", "recipients": []}
    with pytest.raises(access.LearningTaskAccessError) as error:
        access.require_task_learner(
            auth_enabled=True, identity_backend_supported=False, actor=accounts["kid_actor"]
        )
    assert error.value.code == "unsupported_identity_backend"


def test_recipient_discovery_has_only_safe_learner_fields_and_publish_rechecks(accounts):
    another = identity.save_user("blocked", "synthetic-unused-hash", preset="learner")
    disabled = identity.save_user("disabled", "synthetic-unused-hash", preset="learner")
    records = identity.load_users()
    records["disabled"]["disabled"] = True
    identity._write_users(records)
    setup = access.task_recipient_setup(auth_enabled=True, actor=accounts["admin_actor"])
    assert setup["enabled"] is True and setup["reason"] is None
    views = {item["user_id"]: item for item in setup["recipients"]}
    assert set(views) == {accounts["kid"]["id"], another["id"], disabled["id"]}
    assert all(
        set(view) == {"user_id", "username", "can_receive", "reason"} for view in views.values()
    )
    assert views[accounts["kid"]["id"]]["can_receive"] is True
    assert views[another["id"]]["reason"] == "tasks_disabled"
    assert views[disabled["id"]]["reason"] == "account_disabled"
    save_grant(accounts["kid"]["id"], learner_grant(accounts["kid"]["id"]))
    with pytest.raises(access.LearningTaskAccessError) as error:
        access.require_task_recipient(
            accounts["kid"]["id"], auth_enabled=True, actor=accounts["admin_actor"]
        )
    assert error.value.code == "tasks_disabled"


@pytest.mark.parametrize(
    "policy", [None, {}, {"allowed_surfaces": []}, {"allowed_surfaces": "tasks"}]
)
def test_missing_or_malformed_policy_never_becomes_unrestricted_task_access(
    accounts, monkeypatch, policy
):
    monkeypatch.setattr(access, "learning_policy_for_user", lambda *_args, **_kw: policy)
    with pytest.raises(access.LearningTaskAccessError) as error:
        access.require_task_learner(auth_enabled=True, actor=accounts["kid_actor"])
    assert error.value.code == "tasks_disabled"


def test_policy_read_failure_is_safe_and_does_not_allow_access(accounts, monkeypatch):
    def failed(*_args, **_kwargs):
        raise RuntimeError("private filesystem path and grant")

    monkeypatch.setattr(access, "learning_policy_for_user", failed)
    with pytest.raises(access.LearningTaskAccessUnavailable) as error:
        access.require_task_learner(auth_enabled=True, actor=accounts["kid_actor"])
    assert error.value.status_code == 503
    assert "private" not in str(error.value)


def test_teacher_history_scope_is_stable_across_root_moves_and_skips_source_files(
    accounts, monkeypatch, tmp_path
):
    actor = accounts["admin_actor"]
    workspace = ["canonical-workspace"]
    monkeypatch.setattr(access, "current_workspace_id", lambda: workspace[0])
    monkeypatch.setattr(
        access, "get_path_service", lambda: pytest.fail("History must not resolve source files")
    )
    first = access.teacher_task_scope(auth_enabled=True, actor=actor, resolve_source=False)
    moved = replace(actor, scope=replace(actor.scope, root=tmp_path / "moved-root"))
    second = access.teacher_task_scope(auth_enabled=True, actor=moved, resolve_source=False)
    assert first.scope_key == second.scope_key and second.root is None
    workspace[0] = "another-workspace"
    assert (
        access.teacher_task_scope(auth_enabled=True, actor=actor, resolve_source=False).scope_key
        != first.scope_key
    )
    monkeypatch.setattr(
        access,
        "get_path_service",
        lambda: SimpleNamespace(get_workspace_dir=lambda: tmp_path / "fresh-source"),
    )
    source = access.teacher_task_scope(auth_enabled=True, actor=actor)
    assert source.root == tmp_path / "fresh-source" / "teaching-analysis"
