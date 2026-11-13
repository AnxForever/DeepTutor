"""Fresh identity and explicit policy checks for teacher-issued learner tasks.

Authentication is installed by the API dependency before these functions run.
Flags are passed explicitly so the core module never imports API routers or
silently treats the local unauthenticated administrator as a real learner.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
from typing import Any

from deeptutor.services.path_service import get_path_service
from deeptutor.services.workspace.context import current_workspace_id

from .context import get_current_user
from .identity import get_user_by_id, list_user_info
from .learning_access import learning_policy_for_user
from .models import LOCAL_ADMIN_ID, CurrentUser


class LearningTaskAccessError(PermissionError):
    """A safe, actionable denial for one task operation."""

    def __init__(self, message: str, *, code: str, status_code: int = 403):
        super().__init__(message)
        self.msg = self.message = message
        self.code = code
        self.status_code = status_code


class LearningTaskAccessUnavailable(RuntimeError):
    """Identity or policy could not be read; never interpret it as access."""

    code = "task_access_unavailable"
    status_code = 503
    msg = message = "Task access could not be checked. Ask an administrator to try again."

    def __init__(self):
        super().__init__(self.msg)


@dataclass(frozen=True, slots=True)
class TeacherTaskScope:
    scope_key: str
    workspace_id: str
    root: Path | None
    actor_user_id: str


def _deny(message: str, code: str, status_code: int = 403) -> LearningTaskAccessError:
    return LearningTaskAccessError(message, code=code, status_code=status_code)


def _backend(auth_enabled: bool, supported: bool) -> None:
    if not auth_enabled:
        raise _deny(
            "Enable authenticated learner accounts before sending or completing tasks.",
            "authentication_disabled",
            403,
        )
    if not supported:
        raise _deny(
            "Learner tasks are not available for this identity backend.",
            "unsupported_identity_backend",
            403,
        )


def _user(user_id: str) -> tuple[str, dict[str, Any]]:
    if not isinstance(user_id, str) or not user_id or len(user_id) > 64:
        raise _deny("This account is unavailable. Sign in again.", "account_unavailable")
    try:
        found = get_user_by_id(user_id)
    except Exception:
        raise LearningTaskAccessUnavailable() from None
    if found is None:
        raise _deny("This account is unavailable. Sign in again.", "account_unavailable")
    if not isinstance(found, tuple) or len(found) != 2:
        raise LearningTaskAccessUnavailable()
    username, record = found
    if not isinstance(username, str) or not isinstance(record, dict) or record.get("id") != user_id:
        raise LearningTaskAccessUnavailable()
    return username, record


def _fresh_actor(actor: CurrentUser) -> dict[str, Any]:
    _username, record = _user(actor.id)
    if bool(record.get("disabled", False)):
        raise _deny("This account is disabled. Ask an administrator for help.", "account_disabled")
    if record.get("role", "user") != actor.role:
        raise _deny("This account changed. Sign in again.", "identity_changed")
    if actor.is_admin:
        if actor.scope.kind != "admin":
            raise _deny("This account changed. Sign in again.", "identity_changed")
    elif actor.scope.kind != "user" or actor.scope.user_id != actor.id:
        raise _deny("This account changed. Sign in again.", "identity_changed")
    return record


def _tasks_allowed(user_id: str) -> bool:
    try:
        policy = learning_policy_for_user(user_id, is_admin=False)
    except Exception:
        raise LearningTaskAccessUnavailable() from None
    # Unlike unrestricted adult accounts, a learner must have an explicit
    # tasks surface. The legacy fallback contains only chat/reading.
    surfaces = policy.get("allowed_surfaces") if isinstance(policy, dict) else None
    return (
        isinstance(surfaces, list)
        and all(isinstance(surface, str) for surface in surfaces)
        and "tasks" in surfaces
    )


def require_task_admin(
    *,
    auth_enabled: bool,
    identity_backend_supported: bool = True,
    publishing: bool = False,
    actor: CurrentUser | None = None,
) -> CurrentUser:
    actor = actor if actor is not None else get_current_user()
    if not auth_enabled and not publishing:
        if actor.id == LOCAL_ADMIN_ID and actor.is_admin and actor.scope.kind == "admin":
            return actor
        raise _deny("Administrator access is required.", "admin_access_required")
    _backend(auth_enabled, identity_backend_supported)
    _fresh_actor(actor)
    if not actor.is_admin:
        raise _deny("Administrator access is required.", "admin_access_required")
    return actor


def require_task_learner(
    *,
    auth_enabled: bool,
    identity_backend_supported: bool = True,
    actor: CurrentUser | None = None,
) -> CurrentUser:
    _backend(auth_enabled, identity_backend_supported)
    actor = actor if actor is not None else get_current_user()
    record = _fresh_actor(actor)
    if actor.is_admin or record.get("preset", "standard") != "learner":
        raise _deny("Sign in with an assigned learner account.", "learner_access_required")
    if not _tasks_allowed(actor.id):
        raise _deny(
            "Tasks are not enabled for this learner. Ask an administrator.", "tasks_disabled"
        )
    return actor


def _recipient_view(user_id: str, username: str, record: dict[str, Any]) -> dict[str, Any]:
    disabled = bool(record.get("disabled", False))
    allowed = not disabled and _tasks_allowed(user_id)
    return {
        "user_id": user_id,
        "username": username,
        "can_receive": allowed,
        "reason": "account_disabled" if disabled else None if allowed else "tasks_disabled",
    }


def task_recipient_setup(
    *,
    auth_enabled: bool,
    identity_backend_supported: bool = True,
    actor: CurrentUser | None = None,
) -> dict[str, Any]:
    actor = actor if actor is not None else get_current_user()
    if not auth_enabled:
        require_task_admin(auth_enabled=False, actor=actor)
        return {"enabled": False, "reason": "authentication_disabled", "recipients": []}
    if not identity_backend_supported:
        if not actor.is_admin:
            raise _deny("Administrator access is required.", "admin_access_required")
        return {"enabled": False, "reason": "unsupported_identity_backend", "recipients": []}
    require_task_admin(auth_enabled=True, actor=actor)
    try:
        records = list_user_info()
    except Exception:
        raise LearningTaskAccessUnavailable() from None
    if not isinstance(records, list):
        raise LearningTaskAccessUnavailable()
    recipients = []
    for record in records:
        if not isinstance(record, dict):
            raise LearningTaskAccessUnavailable()
        if record.get("preset", "standard") != "learner" or record.get("role") == "admin":
            continue
        user_id, username = record.get("id"), record.get("username")
        if not isinstance(user_id, str) or not user_id or not isinstance(username, str):
            raise LearningTaskAccessUnavailable()
        recipients.append(_recipient_view(user_id, username, record))
    return {"enabled": True, "reason": None, "recipients": recipients}


def require_task_recipient(
    user_id: str,
    *,
    auth_enabled: bool,
    identity_backend_supported: bool = True,
    actor: CurrentUser | None = None,
) -> dict[str, str]:
    require_task_admin(
        auth_enabled=auth_enabled,
        identity_backend_supported=identity_backend_supported,
        publishing=True,
        actor=actor,
    )
    username, record = _user(user_id)
    if record.get("role") == "admin" or record.get("preset", "standard") != "learner":
        raise _deny("Select an existing learner account.", "learner_access_required")
    view = _recipient_view(user_id, username, record)
    if not view["can_receive"]:
        reason = view["reason"]
        raise _deny(
            "This learner cannot receive tasks until an administrator enables access.", reason
        )
    return {"user_id": user_id, "username": username}


def teacher_task_scope(
    *,
    auth_enabled: bool,
    identity_backend_supported: bool = True,
    actor: CurrentUser | None = None,
    resolve_source: bool = True,
) -> TeacherTaskScope:
    actor = require_task_admin(
        auth_enabled=auth_enabled,
        identity_backend_supported=identity_backend_supported,
        actor=actor,
    )
    root = (
        (get_path_service().get_workspace_dir() / "teaching-analysis").absolute()
        if resolve_source
        else None
    )
    workspace_id = current_workspace_id()
    # Source files are read through the currently authorized PathService, but
    # issued-task ownership follows the stable logical workspace across moves.
    # Administrators deliberately share the platform's admin owner identity.
    binding = {
        "owner_kind": actor.scope.kind,
        "owner_id": actor.scope.user_id,
        "workspace_id": workspace_id,
    }
    scope_key = hashlib.sha256(
        json.dumps(binding, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return TeacherTaskScope(
        scope_key=scope_key, workspace_id=workspace_id, root=root, actor_user_id=actor.id
    )


__all__ = [
    "LearningTaskAccessError",
    "LearningTaskAccessUnavailable",
    "TeacherTaskScope",
    "require_task_admin",
    "require_task_learner",
    "require_task_recipient",
    "task_recipient_setup",
    "teacher_task_scope",
]
