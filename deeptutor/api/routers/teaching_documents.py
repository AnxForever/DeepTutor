"""Read source documents and extract cited fields for explicit teacher review."""

from __future__ import annotations

import asyncio
import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from deeptutor.api.routers.auth import require_admin
from deeptutor.api.routers.teaching_validation import TeachingAPIRoute
from deeptutor.learning.teaching_analysis.document_models import DocumentExtraction, LocatedDocument
from deeptutor.learning.teaching_analysis.document_proofs import (
    DocumentProofInvalid,
    DocumentProofStorageError,
    get_document_proof_store,
)
from deeptutor.learning.teaching_analysis.document_provenance import DocumentProvenance
from deeptutor.learning.teaching_analysis.documents import (
    DocumentExtractionUnavailable,
    DocumentImportError,
    DocumentModelNotConfigured,
    extract_assignment,
    preview_document,
    validate_extraction_provenance,
)
from deeptutor.learning.teaching_analysis.models import AssignmentInput

router = APIRouter(route_class=TeachingAPIRoute, dependencies=[Depends(require_admin)])


class DocumentPreview(BaseModel):
    document: LocatedDocument
    document_token: str = Field(pattern=r"^[a-f0-9]{64}$")


class DocumentExtractRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document: LocatedDocument
    document_token: str = Field(pattern=r"^[a-f0-9]{64}$")
    language: Literal["en", "zh"] = "zh"


def invalid_source() -> HTTPException:
    return HTTPException(
        422,
        {
            "error_code": "teaching_document_token_invalid",
            "message": "Read the source document again in this workspace before extracting its questions.",
            "retryable": False,
        },
    )


@router.post("/documents/preview", response_model=DocumentPreview)
async def preview_teaching_document(file: UploadFile = File(...)) -> DocumentPreview:
    try:
        data = await file.read(1_048_577)
        if len(data) > 1_048_576:
            raise HTTPException(413, "Choose a source document up to 1 MB.")
        document = await asyncio.to_thread(preview_document, data, file.filename or "document.txt")
        proof = get_document_proof_store()
        token = await asyncio.to_thread(proof.sign, "preview", document.model_dump(mode="json"))
        return DocumentPreview(document=document, document_token=token)
    except DocumentImportError as exc:
        raise HTTPException(422, str(exc)) from None
    except DocumentProofInvalid:
        raise invalid_source() from None
    except (OSError, sqlite3.Error, DocumentProofStorageError):
        raise HTTPException(
            503, "Document preview storage is unavailable. Try again later."
        ) from None
    finally:
        await file.close()


@router.post("/documents/extract", response_model=DocumentExtraction)
async def extract_teaching_document(payload: DocumentExtractRequest) -> DocumentExtraction:
    try:
        proof = get_document_proof_store()
        await asyncio.to_thread(
            proof.verify,
            "preview",
            payload.document.model_dump(mode="json"),
            payload.document_token,
        )
    except DocumentProofInvalid:
        raise invalid_source() from None
    except (OSError, sqlite3.Error, DocumentProofStorageError):
        raise HTTPException(503, "Document verification is unavailable. Try again later.") from None
    try:
        result = await extract_assignment(payload.document, language=payload.language)
    except DocumentModelNotConfigured:
        raise HTTPException(
            503,
            {
                "error_code": "teaching_model_not_configured",
                "message": "Configure an available chat model in Settings before extracting questions.",
                "retryable": False,
            },
        ) from None
    except DocumentExtractionUnavailable:
        raise HTTPException(
            502, "The extracted questions could not be verified. Review the source and try again."
        ) from None
    try:
        validate_extraction_provenance(payload.document, result.assignment, result.provenance)
    except (DocumentImportError, ValueError):
        raise HTTPException(
            502,
            "The extracted source quotes could not be verified. Review the document and try again.",
        ) from None
    if not result.assignment.items:
        return result
    blocks = {block.block_id: block for block in payload.document.blocks}
    source = {
        "filename": payload.document.filename,
        "source_hash": payload.document.source_hash,
        "parser_version": payload.document.parser_version,
        "fields": [
            {
                "question_id": field.question_id,
                "field": field.field,
                "citations": [
                    {
                        "block_id": citation.block_id,
                        "locator": blocks[citation.block_id].locator,
                        "quote": citation.quote,
                    }
                    for citation in field.citations
                ],
            }
            for field in result.provenance
        ],
    }
    try:
        signature = await asyncio.to_thread(proof.sign, "provenance", source)
        provenance = DocumentProvenance.model_validate(source | {"signature": signature})
        assignment = AssignmentInput.model_validate(
            result.assignment.model_dump(mode="json")
            | {"document_provenance": provenance.model_dump(mode="json")}
        )
    except ValidationError:
        raise HTTPException(
            422,
            "The extracted questions and source quotes exceed the assignment limits. Split the document into smaller parts.",
        ) from None
    except (OSError, sqlite3.Error, DocumentProofStorageError):
        raise HTTPException(503, "Document verification is unavailable. Try again later.") from None
    return result.model_copy(update={"assignment": assignment})
