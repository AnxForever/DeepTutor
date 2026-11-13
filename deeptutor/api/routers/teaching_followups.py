"""Teacher-reviewed follow-up practice, without automatic learning-state writes."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
import logging
from typing import TypeVar
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from deeptutor.api.routers.auth import require_admin
from deeptutor.api.routers.teaching_validation import TeachingAPIRoute
from deeptutor.learning.teaching_analysis.followup_models import (
    SavedFollowup,
    SavedFollowupAttempt,
    SaveFollowupAttemptRequest,
    SaveFollowupRequest,
    VoidFollowupAttemptRequest,
)
from deeptutor.learning.teaching_analysis.followups import (
    FollowupConflict,
    FollowupNotFound,
    FollowupSourceConflict,
    FollowupStore,
    FollowupValidationError,
    get_followup_store,
)

logger = logging.getLogger(__name__)
router = APIRouter(route_class=TeachingAPIRoute, dependencies=[Depends(require_admin)])
_T = TypeVar("_T")


async def _execute(operation: Callable[[FollowupStore], _T]) -> _T:
    try:
        # Resolve the authorized account/workspace before dispatching I/O. The
        # store is request-local; student/report labels never choose a scope.
        store = get_followup_store()
        return await asyncio.to_thread(operation, store)
    except FollowupNotFound as exc:
        raise HTTPException(404, str(exc)) from None
    except FollowupSourceConflict as exc:
        raise HTTPException(
            409,
            {
                "error_code": "teaching_followup_source_changed",
                "message": str(exc),
                "retryable": False,
            },
        ) from None
    except FollowupConflict as exc:
        raise HTTPException(409, str(exc)) from None
    except FollowupValidationError as exc:
        raise HTTPException(422, str(exc)) from None
    except Exception as exc:
        # A failed commit has an uncertain client-visible outcome. Preserve
        # the receipt/idempotency key and ask the client to reload/retry.
        logger.warning("Teacher follow-up storage failed (%s)", type(exc).__name__)
        raise HTTPException(
            503, "Practice storage is unavailable. Reload before retrying."
        ) from None


@router.get("/followups", response_model=list[SavedFollowup])
async def list_teaching_followups(
    report_id: UUID | None = None, limit: int = Query(default=100, ge=1, le=100)
) -> list[dict]:
    return await _execute(lambda store: store.list_followups(report_id=report_id, limit=limit))


@router.get("/followups/{followup_id}", response_model=SavedFollowup)
async def get_teaching_followup(followup_id: UUID) -> dict:
    return await _execute(lambda store: store.get_followup(followup_id))


@router.get("/followups/{followup_id}/revisions", response_model=list[SavedFollowup])
async def list_teaching_followup_revisions(
    followup_id: UUID, limit: int = Query(default=100, ge=1, le=100)
) -> list[dict]:
    return await _execute(lambda store: store.revisions(followup_id, limit=limit))


@router.post("/followups", response_model=SavedFollowup)
async def save_teaching_followup(payload: SaveFollowupRequest) -> dict:
    return await _execute(lambda store: store.save_followup(payload))


@router.get("/followups/{followup_id}/attempts", response_model=list[SavedFollowupAttempt])
async def list_teaching_followup_attempts(
    followup_id: UUID, limit: int = Query(default=100, ge=1, le=100)
) -> list[dict]:
    return await _execute(lambda store: store.attempts(followup_id, limit=limit))


@router.post("/followups/{followup_id}/attempts", response_model=SavedFollowupAttempt)
async def record_teaching_followup_attempt(
    followup_id: UUID, payload: SaveFollowupAttemptRequest
) -> dict:
    return await _execute(lambda store: store.record_attempt(followup_id, payload))


@router.post(
    "/followups/{followup_id}/attempts/{attempt_id}/void", response_model=SavedFollowupAttempt
)
async def void_teaching_followup_attempt(
    followup_id: UUID, attempt_id: UUID, payload: VoidFollowupAttemptRequest
) -> dict:
    return await _execute(lambda store: store.void_attempt(followup_id, attempt_id, payload.reason))
