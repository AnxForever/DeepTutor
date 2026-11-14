"""Account-global task inbox for freshly authorized learner accounts only."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
import logging
from typing import Literal, TypedDict, TypeVar
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from deeptutor.api.routers import auth as auth_router
from deeptutor.api.routers.student_task_voice import router as voice_router
from deeptutor.api.routers.teaching_validation import TeachingAPIRoute
from deeptutor.learning.teaching_analysis.learner_task_models import (
    SaveTaskProgressRequest,
    StudentTaskSummary,
    StudentTaskView,
    SubmitTaskRequest,
)
from deeptutor.learning.teaching_analysis.learner_tasks import (
    LearnerTaskStore,
    TaskConflict,
    TaskNotFound,
    TaskRevoked,
    TaskValidationError,
    get_learner_task_store,
)
from deeptutor.multi_user.learning_tasks_access import (
    LearningTaskAccessError,
    LearningTaskAccessUnavailable,
    require_task_learner,
)

logger = logging.getLogger(__name__)
router = APIRouter(route_class=TeachingAPIRoute, dependencies=[Depends(auth_router.require_auth)])
router.include_router(voice_router)
_T = TypeVar("_T")


class _TaskAuthFlags(TypedDict):
    auth_enabled: bool
    identity_backend_supported: bool


def _task_auth_flags() -> _TaskAuthFlags:
    return {
        "auth_enabled": bool(auth_router.AUTH_ENABLED),
        "identity_backend_supported": not bool(auth_router.POCKETBASE_ENABLED),
    }


async def _execute_task(operation: Callable[[], _T]) -> _T:
    try:
        return await asyncio.to_thread(operation)
    except (LearningTaskAccessError, LearningTaskAccessUnavailable) as exc:
        raise HTTPException(
            exc.status_code,
            {
                "error_code": exc.code,
                "message": exc.msg,
                "retryable": exc.status_code >= 500,
            },
        ) from None
    except TaskNotFound:
        # The same response covers absent and another recipient's known UUID.
        raise HTTPException(404, "Student task not found.") from None
    except TaskRevoked as exc:
        raise HTTPException(
            409,
            {
                "error_code": "teaching_student_task_revoked",
                "message": str(exc),
                "retryable": False,
            },
        ) from None
    except TaskConflict as exc:
        raise HTTPException(
            409,
            {
                "error_code": "teaching_student_task_changed",
                "message": str(exc),
                "retryable": False,
            },
        ) from None
    except TaskValidationError as exc:
        raise HTTPException(422, str(exc)) from None
    except HTTPException:
        raise
    except Exception as exc:
        # Never echo answer text, central-storage paths or identity records.
        logger.warning("Student task operation failed (%s)", type(exc).__name__)
        raise HTTPException(503, "Student tasks are unavailable. Reload before retrying.") from None


def _for_learner(operation: Callable[[LearnerTaskStore, str], _T]) -> _T:
    learner = require_task_learner(**_task_auth_flags())
    # This is the deployment's central store. Neither a client workspace nor
    # a teacher's source path participates in a learner lookup.
    return operation(get_learner_task_store(), learner.id)


@router.get("", response_model=list[StudentTaskSummary])
async def list_student_tasks(
    state: Literal["active", "history"] = "active",
    limit: int = Query(default=100, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> list[StudentTaskSummary]:
    return await _execute_task(
        lambda: _for_learner(
            lambda store, user_id: store.list_student_tasks(
                user_id, state=state, limit=limit, offset=offset
            )
        )
    )


@router.get("/{task_id}", response_model=StudentTaskView)
async def get_student_task(task_id: UUID) -> StudentTaskView:
    return await _execute_task(
        lambda: _for_learner(lambda store, user_id: store.get_student_task(user_id, task_id))
    )


@router.put("/{task_id}/progress", response_model=StudentTaskView)
async def save_student_task_progress(
    task_id: UUID, payload: SaveTaskProgressRequest
) -> StudentTaskView:
    return await _execute_task(
        lambda: _for_learner(lambda store, user_id: store.save_progress(user_id, task_id, payload))
    )


@router.post("/{task_id}/submit", response_model=StudentTaskView)
async def submit_student_task(task_id: UUID, payload: SubmitTaskRequest) -> StudentTaskView:
    return await _execute_task(
        lambda: _for_learner(lambda store, user_id: store.submit_task(user_id, task_id, payload))
    )
