"""Explicit, scope-local student cases and their pinned evidence timeline."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
import logging
from typing import TypeVar
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from deeptutor.api.routers.auth import require_admin
from deeptutor.api.routers.teaching_validation import TeachingAPIRoute
from deeptutor.learning.teaching_analysis.case_models import (
    SavedStudentCase,
    SaveStudentCaseRequest,
    StudentCaseSummary,
    StudentCaseTimeline,
)
from deeptutor.learning.teaching_analysis.cases import (
    CaseConflict,
    CaseNotFound,
    CaseSourceConflict,
    CaseValidationError,
    StudentCaseStore,
    get_student_case_store,
)

logger = logging.getLogger(__name__)
router = APIRouter(route_class=TeachingAPIRoute, dependencies=[Depends(require_admin)])
_T = TypeVar("_T")


async def _execute(operation: Callable[[StudentCaseStore], _T]) -> _T:
    try:
        store = get_student_case_store()
        return await asyncio.to_thread(operation, store)
    except CaseNotFound as exc:
        raise HTTPException(404, str(exc)) from None
    except CaseSourceConflict as exc:
        raise HTTPException(
            409,
            {
                "error_code": "teaching_case_source_changed",
                "message": str(exc),
                "retryable": False,
            },
        ) from None
    except CaseConflict as exc:
        raise HTTPException(
            409,
            {
                "error_code": "teaching_case_changed",
                "message": str(exc),
                "retryable": False,
            },
        ) from None
    except CaseValidationError as exc:
        raise HTTPException(422, str(exc)) from None
    except Exception as exc:
        logger.warning("Student case storage failed (%s)", type(exc).__name__)
        raise HTTPException(
            503, "Student case storage is unavailable. Reload before retrying."
        ) from None


@router.get("/student-cases", response_model=list[StudentCaseSummary])
async def list_teaching_student_cases(
    archived: bool = False,
    limit: int = Query(default=100, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> list[StudentCaseSummary]:
    return await _execute(
        lambda store: store.list_cases(archived=archived, limit=limit, offset=offset)
    )


@router.post("/student-cases", response_model=SavedStudentCase)
async def save_teaching_student_case(payload: SaveStudentCaseRequest) -> SavedStudentCase:
    return await _execute(lambda store: store.save_case(payload))


@router.get("/student-cases/{case_id}", response_model=SavedStudentCase)
async def get_teaching_student_case(case_id: UUID) -> SavedStudentCase:
    return await _execute(lambda store: store.get_case(case_id))


@router.get("/student-cases/{case_id}/revisions", response_model=list[SavedStudentCase])
async def list_teaching_student_case_revisions(
    case_id: UUID, limit: int = Query(default=100, ge=1, le=100)
) -> list[SavedStudentCase]:
    return await _execute(lambda store: store.revisions(case_id, limit=limit))


@router.get("/student-cases/{case_id}/timeline", response_model=StudentCaseTimeline)
async def get_teaching_student_case_timeline(
    case_id: UUID,
    limit: int = Query(default=50, ge=1, le=100),
    cursor: str | None = Query(default=None, min_length=1, max_length=2048),
) -> StudentCaseTimeline:
    return await _execute(lambda store: store.timeline(case_id, limit=limit, cursor=cursor))
