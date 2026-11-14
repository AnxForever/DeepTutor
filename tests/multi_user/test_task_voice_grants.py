"""Task recognition permission is explicit, strictly boolean, and lossless."""

from __future__ import annotations

from copy import deepcopy
import json

import pytest

from deeptutor.multi_user import grants, identity
from deeptutor.multi_user.learning_access import learning_policy_for_user


@pytest.fixture(autouse=True)
def adult_account(mu_isolated_root):
    # Identity bootstraps the first account as an administrator.
    identity.save_user("adult", "synthetic-unused-hash", role="admin")


def test_legacy_and_new_preset_policies_do_not_opt_in_or_change_on_read(mu_isolated_root):
    learner = identity.save_user("kid", "synthetic-unused-hash", preset="learner")
    uid = learner["id"]
    assert "task_voice_input" not in learning_policy_for_user(uid)
    for include_tasks in (False, True):
        grant = grants.learner_grant(uid, include_tasks=include_tasks)
        assert "task_voice_input" not in grant["learning_policy"]
        grants.save_grant(uid, grant)
        path = grants.grant_path(uid)
        before = path.read_bytes()
        assert "task_voice_input" not in grants.load_grant(uid)["learning_policy"]
        assert "task_voice_input" not in learning_policy_for_user(uid)
        assert path.read_bytes() == before
    assert grants.normalize_grant(uid, None)["learning_policy"] is None
    assert grants.normalize_grant(uid, {"learning_policy": None})["learning_policy"] is None


@pytest.mark.parametrize("enabled", [False, True])
def test_voice_opt_in_round_trip_preserves_all_other_policy_and_source_fields(
    mu_isolated_root, enabled
):
    learner = identity.save_user("kid", "synthetic-unused-hash", preset="learner")
    uid = learner["id"]
    grant = grants.learner_grant(uid, include_tasks=True)
    grant["knowledge_bases"] = [{"resource_id": "admin:kb:synthetic"}]
    grant["models"]["llm"] = [{"profile_id": "synthetic", "model_id": "synthetic-model"}]
    grant["learning_policy"]["reading"]["material_ids"] = ["synthetic-material"]
    grant["learning_policy"]["task_voice_input"] = enabled
    original = deepcopy(grant)
    assert grants.save_grant(uid, grant) == original
    assert grants.load_grant(uid) == original
    assert grant == original


def test_task_recognition_opt_in_does_not_open_the_generic_voice_api(mu_isolated_root, as_user):
    from deeptutor.api.routers.auth import _learning_surface_for_path
    from deeptutor.multi_user.learning_access import assert_learning_surface

    learner = identity.save_user("kid", "synthetic-unused-hash", preset="learner")
    uid = learner["id"]
    grant = grants.learner_grant(uid, include_tasks=True)
    grant["learning_policy"]["task_voice_input"] = True
    grants.save_grant(uid, grant)
    with as_user(uid, username="kid"):
        assert_learning_surface("tasks")
        for path in ("/api/voice/tts", "/api/voice/stt"):
            with pytest.raises(PermissionError):
                assert_learning_surface(_learning_surface_for_path(path, "POST"))


@pytest.mark.parametrize("value", [None, 0, 1, "true", "false", [], {}, {"enabled": True}])
def test_non_boolean_voice_permissions_are_rejected_without_rewriting_existing_grant(
    mu_isolated_root, value
):
    learner = identity.save_user("kid", "synthetic-unused-hash", preset="learner")
    uid = learner["id"]
    original = grants.learner_grant(uid, include_tasks=True)
    grants.save_grant(uid, original)
    path = grants.grant_path(uid)
    before = path.read_bytes()
    invalid = deepcopy(original)
    invalid["learning_policy"]["task_voice_input"] = value
    with pytest.raises(ValueError, match="task_voice_input must be a boolean"):
        grants.save_grant(uid, invalid)
    assert path.read_bytes() == before
    path.write_text(json.dumps(invalid), encoding="utf-8")
    corrupt_bytes = path.read_bytes()
    with pytest.raises(grants.GrantStorageError):
        grants.load_grant(uid)
    assert path.read_bytes() == corrupt_bytes
