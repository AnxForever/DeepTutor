"""Teacher-reviewed assignment reports, without changing learner state."""

from __future__ import annotations

import asyncio
import logging
import sqlite3
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, ConfigDict, Field

from deeptutor.api.routers.auth import require_admin
from deeptutor.api.routers.teaching_documents import router as documents_router
from deeptutor.api.routers.teaching_followups import router as followups_router
from deeptutor.api.routers.teaching_rubrics import router as rubrics_router
from deeptutor.api.routers.teaching_validation import TeachingAPIRoute
from deeptutor.api.routers.teaching_worksheets import router as worksheets_router
from deeptutor.learning.teaching_analysis.document_proofs import (
    DocumentProofInvalid,
    DocumentProofStorageError,
    verify_document_provenance,
)
from deeptutor.learning.teaching_analysis.importing import preview_import
from deeptutor.learning.teaching_analysis.models import (
    AssignmentInput,
    GeneratedAnalysis,
    ReportContent,
)
from deeptutor.learning.teaching_analysis.rubrics import RubricNotFound, verify_rubric_snapshot
from deeptutor.learning.teaching_analysis.service import (
    AnalysisNotConfigured,
    AnalysisUnavailable,
    AnalysisValidationError,
    analyze_assignment,
    fingerprint_assignment,
    validate_analysis,
)
from deeptutor.learning.teaching_analysis.storage import (
    ReportConflict,
    ReportNotFound,
    TeachingAnalysisStore,
)

logger = logging.getLogger(__name__)
MAX_IMPORT_BYTES = 1024 * 1024
router = APIRouter(route_class=TeachingAPIRoute, dependencies=[Depends(require_admin)])
router.include_router(rubrics_router)
router.include_router(followups_router)
router.include_router(documents_router)
router.include_router(worksheets_router)


class _ReportData(BaseModel):
    model_config = ConfigDict(extra="forbid")

    assignment: AssignmentInput
    analysis: ReportContent
    source_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    status: Literal["draft", "confirmed"] = "draft"
    teacher_notes: str = Field(default="", max_length=6000)


class SaveReportRequest(_ReportData):
    report_id: UUID
    expected_revision: int = Field(default=0, ge=0, strict=True)


class SavedReport(_ReportData):
    report_id: UUID
    revision: int = Field(ge=1)
    created_at: float
    updated_at: float


class ReportSummary(BaseModel):
    report_id: UUID
    revision: int
    status: Literal["draft", "confirmed"]
    student_ref: str
    assignment_ref: str
    subject: str
    updated_at: float


def _validate_assignment_scope(assignment: AssignmentInput) -> None:
    if not all(
        value.strip()
        for value in (assignment.student_ref, assignment.assignment_ref, assignment.subject)
    ):
        raise HTTPException(422, "Student label, assignment label and subject are required.")


async def _validate_assignment_rubric(assignment: AssignmentInput) -> None:
    if assignment.rubric_template is None:
        return
    try:
        await asyncio.to_thread(verify_rubric_snapshot, assignment.rubric_template)
    except (RubricNotFound, ValueError):
        raise HTTPException(
            422,
            {
                "error_code": "teaching_rubric_unavailable",
                "message": "The selected scoring standard does not match an available version in this workspace. Select it again or clear it.",
                "retryable": False,
            },
        ) from None
    except (OSError, sqlite3.Error):
        raise _storage_failure() from None


async def _validate_assignment_document(assignment: AssignmentInput) -> None:
    if assignment.document_provenance is None:
        return
    try:
        await asyncio.to_thread(verify_document_provenance, assignment.document_provenance)
    except DocumentProofInvalid:
        raise HTTPException(
            422,
            {
                "error_code": "teaching_document_source_invalid",
                "message": "The document source could not be verified in this workspace. Read it again or remove its source references.",
                "retryable": False,
            },
        ) from None
    except (OSError, sqlite3.Error, DocumentProofStorageError):
        raise _storage_failure() from None


def _store() -> TeachingAnalysisStore:
    # Resolve inside each request, after require_admin installed its authorized
    # account and content-workspace scope. Never cache the first user's store.
    return TeachingAnalysisStore()


def _storage_failure() -> HTTPException:
    return HTTPException(503, "Teaching report storage is unavailable. Reload before retrying.")


@router.post("/preview", response_model=AssignmentInput)
async def preview_teaching_assignment(file: UploadFile = File(...)) -> AssignmentInput:
    try:
        data = await file.read(MAX_IMPORT_BYTES + 1)
        if len(data) > MAX_IMPORT_BYTES:
            raise HTTPException(413, "Choose an assignment file up to 1 MB.")
        return await asyncio.to_thread(preview_import, data, file.filename or "assignment.json")
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    finally:
        await file.close()


@router.post("/analyze", response_model=GeneratedAnalysis)
async def analyze_teaching_assignment(
    assignment: AssignmentInput, language: Literal["en", "zh"] = "zh"
) -> GeneratedAnalysis:
    _validate_assignment_scope(assignment)
    await _validate_assignment_rubric(assignment)
    await _validate_assignment_document(assignment)
    try:
        return await analyze_assignment(assignment, language=language)
    except AnalysisNotConfigured:
        raise HTTPException(
            503,
            {
                "error_code": "teaching_model_not_configured",
                "message": "Configure an available chat model in Settings before analyzing assignments.",
                "retryable": False,
            },
        ) from None
    except AnalysisUnavailable:
        raise HTTPException(
            502, "The analysis could not be verified. Review the material and try again."
        ) from None
    except AnalysisValidationError:
        raise HTTPException(
            422, "Review the assignment details before requesting analysis."
        ) from None
    except Exception as exc:
        # Provider exception messages can contain endpoints, keys, or uploaded
        # student work. Keep them out of both the response and this log entry.
        logger.warning("Teacher analysis request failed (%s)", type(exc).__name__)
        raise HTTPException(
            502, "Analysis is temporarily unavailable. No report was saved."
        ) from None


@router.get("/reports", response_model=list[ReportSummary])
async def list_teaching_reports(
    limit: int = Query(default=100, ge=1, le=100), offset: int = Query(default=0, ge=0)
) -> list[dict]:
    try:
        store = _store()
        return await asyncio.to_thread(store.list_reports, limit=limit, offset=offset)
    except (OSError, sqlite3.Error, ValueError):
        raise _storage_failure() from None


@router.get("/reports/{report_id}", response_model=SavedReport)
async def get_teaching_report(report_id: UUID) -> dict:
    try:
        store = _store()
        return await asyncio.to_thread(store.get_report, str(report_id))
    except ReportNotFound:
        raise HTTPException(404, "Teaching report not found in this workspace.") from None
    except (OSError, sqlite3.Error, ValueError):
        raise _storage_failure() from None


@router.get("/reports/{report_id}/revisions", response_model=list[SavedReport])
async def list_teaching_report_revisions(
    report_id: UUID, limit: int = Query(default=100, ge=1, le=100)
) -> list[dict]:
    try:
        store = _store()
        return await asyncio.to_thread(store.revisions, str(report_id), limit=limit)
    except ReportNotFound:
        raise HTTPException(404, "Teaching report not found in this workspace.") from None
    except (OSError, sqlite3.Error, ValueError):
        raise _storage_failure() from None


@router.post("/reports", response_model=SavedReport)
async def save_teaching_report(payload: SaveReportRequest) -> dict:
    _validate_assignment_scope(payload.assignment)
    await _validate_assignment_rubric(payload.assignment)
    await _validate_assignment_document(payload.assignment)
    if payload.source_fingerprint != fingerprint_assignment(payload.assignment):
        raise HTTPException(409, "The assignment changed. Generate a new analysis before saving.")
    try:
        analysis = validate_analysis(payload.assignment, payload.analysis)
    except AnalysisValidationError:
        raise HTTPException(
            422, "The analysis no longer matches the supplied work. Review its evidence."
        ) from None
    content = {
        "assignment": payload.assignment.model_dump(mode="json"),
        "analysis": analysis.model_dump(mode="json"),
        "source_fingerprint": payload.source_fingerprint,
        "status": payload.status,
        "teacher_notes": payload.teacher_notes,
    }
    try:
        store = _store()
        return await asyncio.to_thread(
            store.save_report, str(payload.report_id), payload.expected_revision, content
        )
    except ReportConflict as exc:
        raise HTTPException(409, str(exc)) from None
    except (OSError, sqlite3.Error, ValueError):
        raise _storage_failure() from None
