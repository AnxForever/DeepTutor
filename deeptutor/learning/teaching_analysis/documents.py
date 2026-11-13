"""Document-to-assignment extraction with server-derived values and provenance."""

from __future__ import annotations

from functools import lru_cache
import hashlib
import json
from pathlib import Path, PurePosixPath
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
import yaml

from deeptutor.utils.located_document_text import (
    PARSER_VERSION,
    LocatedTextError,
    extract_located_text,
)

from .document_models import (
    DocumentCitation,
    DocumentExtraction,
    ExtractedField,
    ExtractedFieldName,
    LocatedBlock,
    LocatedDocument,
    validate_document_filename,
)
from .models import AssignmentInput, AssignmentItem


class DocumentImportError(ValueError):
    """The uploaded document cannot provide a supported source preview."""


class DocumentExtractionUnavailable(RuntimeError):
    """The model did not return a verifiable extraction; no data was saved."""


class DocumentModelNotConfigured(DocumentExtractionUnavailable):
    """Configure a text model before requesting document extraction."""


class _FieldProposal(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    field: ExtractedFieldName
    citations: list[DocumentCitation] = Field(min_length=1, max_length=6)


class _ItemProposal(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    fields: list[_FieldProposal] = Field(min_length=1, max_length=5)

    @model_validator(mode="after")
    def one_question_and_unique_fields(self) -> _ItemProposal:
        names = [field.field for field in self.fields]
        if len(names) != len(set(names)) or "question" not in names:
            raise ValueError("Each item needs one question field and no duplicate fields")
        return self


class _ExtractionProposal(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    items: list[_ItemProposal] = Field(max_length=40)


def preview_document(data: bytes, filename: str) -> LocatedDocument:
    """Local parsing only; source blocks are read-only in the preview UI."""
    try:
        name = validate_document_filename(filename)
        blocks, warnings = extract_located_text(data, PurePosixPath(name).suffix.lower())
        return LocatedDocument(
            filename=name,
            source_hash=hashlib.sha256(data).hexdigest(),
            parser_version=PARSER_VERSION,
            blocks=[
                LocatedBlock(block_id=f"B{index}", locator=block.locator, text=block.text)
                for index, block in enumerate(blocks, 1)
            ],
            warnings=list(warnings),
        )
    except LocatedTextError as exc:
        raise DocumentImportError(str(exc)) from None
    except ValueError:
        raise DocumentImportError(
            "This document could not be previewed. Use readable TXT, Markdown or unencrypted DOCX within the import limits."
        ) from None


@lru_cache(maxsize=2)
def _prompts(locale: str) -> dict[str, str]:
    path = Path(__file__).with_name("prompts") / f"document_{locale}.yaml"
    return yaml.safe_load(path.read_text(encoding="utf-8"))


async def _request_document_model(*, prompt: str, system_prompt: str) -> str:
    from deeptutor.services.llm.factory import complete

    return await complete(
        prompt=prompt,
        system_prompt=system_prompt,
        max_retries=0,
        max_tokens=10_000,
        allow_image_fallback=False,
    )


def _parse_proposal(response: str) -> _ExtractionProposal:
    if not isinstance(response, str) or len(response) > 160_000:
        raise ValueError("Invalid extraction response size")

    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        payload = {}
        for key, value in pairs:
            if key in payload:
                raise ValueError("Duplicate extraction keys")
            payload[key] = value
        return payload

    def invalid(_constant: str) -> None:
        raise ValueError("Non-finite JSON")

    # An extraction is a source contract, so truncated or wrapped prose is
    # not repaired into a superficially valid set of student answers.
    payload = json.loads(response, object_pairs_hook=unique, parse_constant=invalid)
    return _ExtractionProposal.model_validate(payload)


def _citation_span(
    citation: DocumentCitation, blocks: dict[str, LocatedBlock]
) -> tuple[str, int, int]:
    block = blocks.get(citation.block_id)
    if block is None:
        raise ValueError("Unknown source block")
    start = block.text.find(citation.quote)
    if start < 0 or block.text.find(citation.quote, start + 1) >= 0:
        raise ValueError("Quote must occur exactly once in the cited block")
    return block.block_id, start, start + len(citation.quote)


def _field_value(
    citations: list[DocumentCitation], blocks: dict[str, LocatedBlock], order: dict[str, int]
) -> str:
    positions = []
    values = []
    previous_block, previous_end = None, -1
    for citation in citations:
        block_id, start, end = _citation_span(citation, blocks)
        if previous_block == block_id and start < previous_end:
            raise ValueError("Citations must not overlap")
        positions.append((order[block_id], start))
        values.append(citation.quote)
        previous_block, previous_end = block_id, end
    if positions != sorted(set(positions)):
        raise ValueError("Citations must be unique and follow source order")
    return "\n".join(values)


def _contains_source_ranges(
    outer: list[tuple[str, int, int]], inner: list[tuple[str, int, int]]
) -> bool:
    # Adjacent citations may be two pieces of one continuous source range.
    # Merge them before checking containment, rather than comparing quote
    # strings, whose boundaries the model is free to shorten or expand.
    merged: list[tuple[str, int, int]] = []
    for block_id, start, end in sorted(outer):
        if merged and merged[-1][0] == block_id and start <= merged[-1][2]:
            merged[-1] = (block_id, merged[-1][1], max(merged[-1][2], end))
        else:
            merged.append((block_id, start, end))
    return bool(inner) and all(
        any(
            block_id == other_id and other_start <= start and end <= other_end
            for other_id, other_start, other_end in merged
        )
        for block_id, start, end in inner
    )


def _source_ranges_overlap(
    left: list[tuple[str, int, int]], right: list[tuple[str, int, int]]
) -> bool:
    return any(
        block_id == other_id and max(start, other_start) < min(end, other_end)
        for block_id, start, end in left
        for other_id, other_start, other_end in right
    )


def validate_extraction_provenance(
    document: LocatedDocument,
    assignment: AssignmentInput,
    provenance: list[ExtractedField],
) -> None:
    """Verify an initial extraction before signing it, without I/O or models.

    This compares the original extracted values, not later teacher edits. A
    signed original proof remains a source record after those explicit edits.
    """
    document = LocatedDocument.model_validate(document)
    assignment = AssignmentInput.model_validate(assignment)
    if not isinstance(provenance, list) or len(provenance) > 200:
        raise ValueError("Invalid extraction provenance list")
    fields = [ExtractedField.model_validate(field) for field in provenance]
    blocks = {block.block_id: block for block in document.blocks}
    order = {block.block_id: index for index, block in enumerate(document.blocks)}
    items = {item.question_id: item for item in assignment.items}
    verified = {}
    source_ranges = {}
    question_origins = set()
    for field in fields:
        key = (field.question_id, field.field)
        if key in verified or field.question_id not in items:
            raise ValueError("Duplicate field provenance or unknown question id")
        verified[key] = _field_value(field.citations, blocks, order)
        source_ranges[key] = [_citation_span(citation, blocks) for citation in field.citations]
        if field.field == "question":
            origin = tuple((citation.block_id, citation.quote) for citation in field.citations)
            if origin in question_origins:
                raise ValueError("A question cannot be extracted twice from the same source")
            question_origins.add(origin)
    for item in assignment.items:
        for name in ("question", "student_answer", "student_work", "reference_answer", "rubric"):
            key = (item.question_id, name)
            value = getattr(item, name)
            if value is None:
                if key in verified:
                    raise ValueError("An absent field cannot have extraction provenance")
            elif key not in verified or verified[key] != value:
                raise ValueError("Extracted field values must equal their literal source citations")
    question_ids = list(items)
    for index, left_id in enumerate(question_ids):
        left_question = source_ranges[(left_id, "question")]
        left_answers = source_ranges.get((left_id, "student_answer"), []) + source_ranges.get(
            (left_id, "student_work"), []
        )
        for right_id in question_ids[index + 1 :]:
            right_question = source_ranges[(right_id, "question")]
            if not (
                _contains_source_ranges(left_question, right_question)
                or _contains_source_ranges(right_question, left_question)
            ):
                continue
            right_answers = source_ranges.get((right_id, "student_answer"), []) + source_ranges.get(
                (right_id, "student_work"), []
            )
            if _source_ranges_overlap(left_answers, right_answers):
                raise ValueError(
                    "Contained question sources cannot reuse the same student answer or work"
                )


async def extract_assignment(document: LocatedDocument, language: str = "zh") -> DocumentExtraction:
    """Extract only literal source content; the API verifies its source token."""
    try:
        document = LocatedDocument.model_validate(document)
    except ValidationError:
        raise DocumentImportError("The source document preview is invalid.") from None
    locale = "zh" if language.lower().startswith("zh") else "en"
    prompts = _prompts(locale)
    system_prompt = (
        prompts["system"]
        + "\n\n"
        + json.dumps(_ExtractionProposal.model_json_schema(), ensure_ascii=False)
    )
    # Source locations are passed as data for orientation only. All locations,
    # field values, identifiers and metadata in the result are server-derived.
    prompt = json.dumps(document.model_dump(mode="json"), ensure_ascii=False)
    try:
        response = await _request_document_model(prompt=prompt, system_prompt=system_prompt)
    except Exception as exc:
        from deeptutor.services.llm.exceptions import LLMConfigError

        if isinstance(exc, LLMConfigError):
            raise DocumentModelNotConfigured(
                "Configure an available text model in Settings before extracting questions."
            ) from None
        raise DocumentExtractionUnavailable(
            "Document extraction is unavailable. Please retry."
        ) from None
    try:
        proposal = _parse_proposal(response)
        blocks = {block.block_id: block for block in document.blocks}
        order = {block.block_id: index for index, block in enumerate(document.blocks)}
        items, provenance = [], []
        for index, item in enumerate(proposal.items, 1):
            question_id = f"Q{index}"
            fields: dict[str, str] = {}
            locator_ids: set[str] = set()
            for field in item.fields:
                fields[field.field] = _field_value(field.citations, blocks, order)
                provenance.append(
                    ExtractedField(
                        question_id=question_id, field=field.field, citations=field.citations
                    )
                )
                if field.field in {"question", "student_answer", "student_work"}:
                    locator_ids.update(citation.block_id for citation in field.citations)
            locators = list(
                dict.fromkeys(
                    block.locator for block in document.blocks if block.block_id in locator_ids
                )
            )
            has_answer = "student_answer" in fields or "student_work" in fields
            items.append(
                AssignmentItem(
                    question_id=question_id,
                    **fields,
                    source_locator="; ".join(locators),
                    answer_status="present" if has_answer else "unknown",
                    transcription_status="uncertain",
                    assistance="unknown",
                )
            )
        assignment = AssignmentInput(assignment_ref=document.filename, items=items)
        validate_extraction_provenance(document, assignment, provenance)
        warnings = [*document.warnings, prompts["review_warning"]]
        if not items:
            warnings.append(prompts["no_questions"])
        return DocumentExtraction(
            assignment=assignment, document=document, provenance=provenance, warnings=warnings
        )
    except (ValueError, RecursionError):
        raise DocumentExtractionUnavailable(
            "The extracted questions could not be verified against the source. Review the document and retry."
        ) from None


__all__ = [
    "DocumentImportError",
    "DocumentExtractionUnavailable",
    "DocumentModelNotConfigured",
    "extract_assignment",
    "preview_document",
    "validate_extraction_provenance",
]
