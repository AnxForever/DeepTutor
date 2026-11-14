"""Teacher-only review revisions over immutable learner submissions."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
import logging
from typing import TypeVar
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi import Path as PathParameter

from deeptutor.api.routers import auth as auth_router
from deeptutor.api.routers.student_tasks import _task_auth_flags
from deeptutor.api.routers.teaching_validation import TeachingAPIRoute
from deeptutor.learning.teaching_analysis.case_storage import (
    CaseConflict,
    CaseNotFound,
    CaseSourceConflict,
    CaseValidationError,
)
from deeptutor.learning.teaching_analysis.learner_task_reviews import (
    ReviewConflict,
    ReviewNotFound,
    ReviewValidationError,
    get_task_review_store,
)
from deeptutor.learning.teaching_analysis.learner_tasks import TaskNotFound
from deeptutor.learning.teaching_analysis.task_review_models import (
    SavedTaskReview,
    SaveTaskReviewRequest,
    TaskReviewState,
    WithdrawTaskReviewRequest,
)
from deeptutor.multi_user.learning_tasks_access import (
    LearningTaskAccessError,
    LearningTaskAccessUnavailable,
    require_task_admin,
    teacher_task_scope,
)

logger = logging.getLogger(__name__)
router = APIRouter(route_class=TeachingAPIRoute, dependencies=[Depends(auth_router.require_admin)])
_T = TypeVar("_T")


def _review_scope(*, publishing: bool = False, resolve_source: bool = False):
    flags = _task_auth_flags()
    if publishing:
        require_task_admin(**flags, publishing=True)
    return teacher_task_scope(**flags, resolve_source=resolve_source)


async def _review_work(operation: Callable[[], _T]) -> _T:
    try:
        return await asyncio.to_thread(operation)
    except (LearningTaskAccessError, LearningTaskAccessUnavailable) as exc:
        raise HTTPException(
            exc.status_code,
            {"error_code": exc.code, "message": exc.msg, "retryable": exc.status_code >= 500},
        ) from None
    except (ReviewNotFound, TaskNotFound):
        raise HTTPException(404, "Task review not found.") from None
    except ReviewConflict as exc:
        raise HTTPException(
            409,
            {"error_code": "teaching_task_review_changed", "message": str(exc), "retryable": False},
        ) from None
    except ReviewValidationError as exc:
        raise HTTPException(422, str(exc)) from None
    except CaseNotFound:
        raise HTTPException(404, "Student case evidence not found.") from None
    except CaseSourceConflict as exc:
        raise HTTPException(
            409,
            {
                "error_code": "teaching_case_review_source_changed",
                "message": str(exc),
                "retryable": False,
            },
        ) from None
    except CaseConflict as exc:
        raise HTTPException(
            409,
            {
                "error_code": "teaching_case_review_evidence_changed",
                "message": str(exc),
                "retryable": False,
            },
        ) from None
    except CaseValidationError as exc:
        raise HTTPException(422, str(exc)) from None
    except HTTPException:
        raise
    except Exception as exc:
        # No answers, review text, source paths or provider details in logs.
        logger.warning("Teacher task review operation failed (%s)", type(exc).__name__)
        raise HTTPException(
            503, "Task review storage is unavailable. Reload before retrying."
        ) from None


@router.get("/student-tasks/{task_id}/review", response_model=TaskReviewState)
async def get_teaching_task_review(task_id: UUID, response: Response) -> TaskReviewState:
    def read():
        scope = _review_scope()
        return get_task_review_store().get_review_state(scope.scope_key, task_id)

    result = await _review_work(read)
    response.headers["Cache-Control"] = "no-store"
    return result


@router.post("/student-tasks/{task_id}/review", response_model=SavedTaskReview)
async def save_teaching_task_review(
    task_id: UUID, payload: SaveTaskReviewRequest, response: Response
) -> SavedTaskReview:
    def save():
        scope = _review_scope(publishing=True)
        return get_task_review_store().save_review(
            scope.scope_key, task_id, payload, reviewer_user_id=scope.actor_user_id
        )

    result = await _review_work(save)
    response.headers["Cache-Control"] = "no-store"
    return result


@router.get("/student-tasks/{task_id}/review/revisions", response_model=list[SavedTaskReview])
async def list_teaching_task_review_revisions(
    task_id: UUID,
    response: Response,
    limit: int = Query(default=100, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> list[SavedTaskReview]:
    def history():
        scope = _review_scope()
        return get_task_review_store().review_revisions(
            scope.scope_key, task_id, limit=limit, offset=offset
        )

    result = await _review_work(history)
    response.headers["Cache-Control"] = "no-store"
    return result


@router.get("/student-tasks/{task_id}/review/revisions/{revision}", response_model=SavedTaskReview)
async def get_teaching_task_review_revision(
    task_id: UUID, response: Response, revision: int = PathParameter(ge=1)
) -> SavedTaskReview:
    def exact():
        scope = _review_scope()
        return get_task_review_store().get_review(scope.scope_key, task_id, revision)

    result = await _review_work(exact)
    response.headers["Cache-Control"] = "no-store"
    return result


@router.post("/student-tasks/{task_id}/review/withdraw", response_model=SavedTaskReview)
async def withdraw_teaching_task_review(
    task_id: UUID, payload: WithdrawTaskReviewRequest, response: Response
) -> SavedTaskReview:
    def withdraw():
        scope = _review_scope(publishing=True)
        return get_task_review_store().withdraw_review(
            scope.scope_key, task_id, payload, reviewer_user_id=scope.actor_user_id
        )

    result = await _review_work(withdraw)
    response.headers["Cache-Control"] = "no-store"
    return result
