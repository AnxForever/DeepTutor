"""Download a saved student or explicitly selected teacher worksheet edition."""

from __future__ import annotations

import asyncio
import logging
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from deeptutor.api.routers.auth import require_admin
from deeptutor.api.routers.teaching_validation import TeachingAPIRoute
from deeptutor.learning.teaching_analysis.followups import FollowupNotFound, get_followup_store
from deeptutor.learning.teaching_analysis.worksheets import (
    WORKSHEET_CSP,
    render_worksheet_html,
    render_worksheet_markdown,
    worksheet_filename,
)

logger = logging.getLogger(__name__)
router = APIRouter(route_class=TeachingAPIRoute, dependencies=[Depends(require_admin)])


@router.get(
    "/followups/{followup_id}/worksheet",
    response_class=Response,
    responses={
        200: {
            "description": "The requested saved worksheet edition as an attachment.",
            "content": {
                "text/html": {"schema": {"type": "string"}},
                "text/markdown": {"schema": {"type": "string"}},
            },
        }
    },
)
async def export_teaching_worksheet(
    followup_id: UUID,
    revision: int | None = Query(default=None, ge=1),
    audience: Literal["student", "teacher"] = "student",
    format: Literal["html", "markdown"] = "html",
    language: Literal["en", "zh"] = "zh",
) -> Response:
    try:
        store = get_followup_store()
        snapshot = (
            await asyncio.to_thread(store.get_revision, followup_id, revision)
            if revision is not None
            else await asyncio.to_thread(store.get_followup, followup_id)
        )
        content = (
            render_worksheet_html(snapshot, audience=audience, language=language)
            if format == "html"
            else render_worksheet_markdown(snapshot, audience=audience, language=language)
        )
        filename = worksheet_filename(followup_id, snapshot["revision"], audience, format)
    except FollowupNotFound:
        raise HTTPException(404, "Practice version not found in this workspace.") from None
    except Exception as exc:
        logger.warning("Teacher worksheet export failed (%s)", type(exc).__name__)
        raise HTTPException(503, "The worksheet is unavailable. Reload and try again.") from None
    return Response(
        content,
        media_type="text/html" if format == "html" else "text/markdown",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Language": language,
            "Content-Security-Policy": WORKSHEET_CSP,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )
