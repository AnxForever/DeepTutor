"""Admin-only, workspace-scoped teacher scoring templates."""

from __future__ import annotations

import asyncio
import sqlite3
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from deeptutor.api.routers.auth import require_admin
from deeptutor.api.routers.teaching_validation import TeachingAPIRoute
from deeptutor.learning.teaching_analysis.rubric_models import RubricTemplate, SaveRubricRequest
from deeptutor.learning.teaching_analysis.rubrics import (
    RubricConflict,
    RubricNotFound,
    get_rubric_store,
)

router = APIRouter(route_class=TeachingAPIRoute, dependencies=[Depends(require_admin)])


def _storage_failure() -> HTTPException:
    return HTTPException(503, "Rubric storage is unavailable. Reload before retrying.")


@router.get("/rubrics", response_model=list[RubricTemplate])
async def list_teaching_rubrics() -> list[RubricTemplate]:
    try:
        store = get_rubric_store()
        return await asyncio.to_thread(store.list_templates)
    except (OSError, sqlite3.Error, ValueError):
        raise _storage_failure() from None


@router.post("/rubrics", response_model=RubricTemplate)
async def save_teaching_rubric(payload: SaveRubricRequest) -> RubricTemplate:
    try:
        store = get_rubric_store()
        return await asyncio.to_thread(store.save_template, payload)
    except RubricConflict as exc:
        raise HTTPException(409, str(exc)) from None
    except (OSError, sqlite3.Error, ValueError):
        raise _storage_failure() from None


@router.get("/rubrics/{template_id}/revisions", response_model=list[RubricTemplate])
async def teaching_rubric_revisions(template_id: UUID) -> list[RubricTemplate]:
    try:
        store = get_rubric_store()
        return await asyncio.to_thread(store.revisions, str(template_id))
    except RubricNotFound:
        raise HTTPException(404, "Rubric template not found in this workspace.") from None
    except (OSError, sqlite3.Error, ValueError):
        raise _storage_failure() from None


@router.get("/rubrics/{template_id}", response_model=RubricTemplate)
async def get_teaching_rubric(template_id: UUID) -> RubricTemplate:
    try:
        store = get_rubric_store()
        return await asyncio.to_thread(store.get_latest, str(template_id))
    except RubricNotFound:
        raise HTTPException(404, "Rubric template not found in this workspace.") from None
    except (OSError, sqlite3.Error, ValueError):
        raise _storage_failure() from None
