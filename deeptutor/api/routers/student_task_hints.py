"""Open teacher-authored task hints one step at a time, without grading."""

from __future__ import annotations

from collections.abc import Callable
from uuid import UUID

from fastapi import APIRouter, Depends, Response

from deeptutor.api.routers import auth as auth_router
from deeptutor.api.routers.teaching_validation import TeachingAPIRoute
from deeptutor.learning.teaching_analysis.learner_task_models import (
    RevealTaskHintRequest,
    TaskHintsState,
)
from deeptutor.learning.teaching_analysis.learner_tasks import LearnerTaskStore

router = APIRouter(route_class=TeachingAPIRoute, dependencies=[Depends(auth_router.require_auth)])


async def _with_learner(
    operation: Callable[[LearnerTaskStore, str], TaskHintsState],
) -> TaskHintsState:
    # Import the shared fresh-account/error boundary at request time. The
    # parent includes this router before defining those helpers, so an eager
    # import would create a cycle. No authorization logic is duplicated here.
    from deeptutor.api.routers.student_tasks import _execute_task, _for_learner

    return await _execute_task(lambda: _for_learner(operation))


@router.get("/{task_id}/hints", response_model=TaskHintsState)
async def get_student_task_hints(task_id: UUID, response: Response) -> TaskHintsState:
    result = await _with_learner(lambda store, user_id: store.get_task_hints(user_id, task_id))
    response.headers["Cache-Control"] = "no-store"
    return result


@router.post("/{task_id}/hints/reveal", response_model=TaskHintsState)
async def reveal_student_task_hint(
    task_id: UUID, payload: RevealTaskHintRequest, response: Response
) -> TaskHintsState:
    result = await _with_learner(
        lambda store, user_id: store.reveal_task_hint(user_id, task_id, payload)
    )
    response.headers["Cache-Control"] = "no-store"
    return result
