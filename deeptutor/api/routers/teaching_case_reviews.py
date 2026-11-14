"""Explicit case overlays for selected, formally reviewed task questions."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response

from deeptutor.api.routers import auth as auth_router
from deeptutor.api.routers.teaching_task_reviews import _review_scope, _review_work
from deeptutor.api.routers.teaching_validation import TeachingAPIRoute
from deeptutor.learning.teaching_analysis.case_review_evidence import CaseReviewEvidenceStore
from deeptutor.learning.teaching_analysis.case_review_models import (
    CaseReviewEvidenceView,
    SaveCaseReviewEvidence,
    SavedCaseReviewEvidence,
)

router = APIRouter(route_class=TeachingAPIRoute, dependencies=[Depends(auth_router.require_admin)])


def _overlay_scope(*, publishing: bool = False):
    scope = _review_scope(publishing=publishing, resolve_source=True)
    if scope.root is None:
        # Never let a missing authorized source root fall back to default data.
        raise ValueError("The authorized case workspace is unavailable.")
    return scope


@router.get("/student-cases/{case_id}/task-review-evidence", response_model=CaseReviewEvidenceView)
async def get_teaching_case_review_evidence(
    case_id: UUID, response: Response
) -> CaseReviewEvidenceView:
    def read():
        scope = _overlay_scope()
        return CaseReviewEvidenceStore(scope.root).get_evidence(case_id, scope.scope_key)

    result = await _review_work(read)
    response.headers["Cache-Control"] = "no-store"
    return result


@router.post("/student-cases/{case_id}/task-review-evidence", response_model=CaseReviewEvidenceView)
async def save_teaching_case_review_evidence(
    case_id: UUID, payload: SaveCaseReviewEvidence, response: Response
) -> CaseReviewEvidenceView:
    def save():
        scope = _overlay_scope(publishing=True)
        return CaseReviewEvidenceStore(scope.root).save_evidence(
            case_id, scope.scope_key, scope.actor_user_id, payload
        )

    result = await _review_work(save)
    response.headers["Cache-Control"] = "no-store"
    return result


@router.get(
    "/student-cases/{case_id}/task-review-evidence/revisions",
    response_model=list[SavedCaseReviewEvidence],
)
async def list_teaching_case_review_evidence_revisions(
    case_id: UUID, response: Response, limit: int = Query(default=100, ge=1, le=100)
) -> list[SavedCaseReviewEvidence]:
    def history():
        scope = _overlay_scope()
        return CaseReviewEvidenceStore(scope.root).revisions(case_id, scope.scope_key, limit=limit)

    result = await _review_work(history)
    response.headers["Cache-Control"] = "no-store"
    return result
