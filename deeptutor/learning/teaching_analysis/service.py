"""One-shot report generation and evidence validation, with no persistence."""

from __future__ import annotations

from functools import lru_cache
import hashlib
import json
from pathlib import Path
from typing import Any

from pydantic import ValidationError
import yaml

from .models import AssignmentInput, Evidence, GeneratedAnalysis, ReportContent


class AnalysisValidationError(ValueError):
    """A report does not match the exact reviewed assignment input."""


class AnalysisUnavailable(RuntimeError):
    """A model call or its response failed; nothing has been saved."""


class AnalysisNotConfigured(AnalysisUnavailable):
    """The caller must configure a text model before generating a report."""


def fingerprint_assignment(assignment: AssignmentInput) -> str:
    content = assignment.model_dump(mode="json")
    # P1 adds an optional template snapshot. Keep pre-template report hashes
    # valid; removing all nulls would change historical student-answer data.
    if assignment.rubric_template is None:
        content.pop("rubric_template", None)
    if assignment.document_provenance is None:
        content.pop("document_provenance", None)
    payload = json.dumps(
        content,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _eligible(item: Any) -> bool:
    return item.answer_status == "present" and item.transcription_status != "uncertain"


def _check_evidence(evidence: Evidence, questions: dict[str, Any]) -> None:
    item = questions.get(evidence.question_id)
    if item is None:
        raise AnalysisValidationError("Evidence references an unknown question")
    actual = getattr(item, evidence.field)
    if not isinstance(actual, str) or not evidence.quote.strip() or evidence.quote not in actual:
        raise AnalysisValidationError("Evidence must quote the exact supplied student content")


def validate_analysis(assignment: AssignmentInput, analysis: ReportContent) -> ReportContent:
    """Validate typed results and literal citations without claiming semantic proof.

    This is also used after a teacher edits a draft. Revalidation is mandatory:
    neither a model output nor a human edit can silently convert missing data
    into an incorrect answer. Exact quotations establish provenance, not the
    correctness of the proposed explanation; that still requires review.
    """
    try:
        assignment = AssignmentInput.model_validate(assignment)
        report = ReportContent.model_validate(analysis)
    except ValidationError:
        raise AnalysisValidationError("The assignment or report has an invalid structure") from None
    questions = {item.question_id: item for item in assignment.items}
    reviewed_ids = [item.question_id for item in report.items]
    if len(reviewed_ids) != len(set(reviewed_ids)) or set(reviewed_ids) != set(questions):
        raise AnalysisValidationError("The report must contain exactly one result per question")
    for review in report.items:
        original = questions[review.question_id]
        if not _eligible(original) and review.result != "ungraded":
            raise AnalysisValidationError("Missing, blank or uncertain answers must stay ungraded")
        if review.result != "ungraded" and not review.evidence:
            raise AnalysisValidationError("A graded result requires literal student evidence")
        for evidence in review.evidence:
            if evidence.question_id != review.question_id:
                raise AnalysisValidationError("An item result must cite that same question")
            _check_evidence(evidence, questions)
    for priority in report.priorities:
        if priority.evidence_status == "supported" and not priority.evidence:
            raise AnalysisValidationError("A supported priority requires student evidence")
        for evidence in priority.evidence:
            _check_evidence(evidence, questions)
            if priority.evidence_status == "supported" and not _eligible(
                questions[evidence.question_id]
            ):
                raise AnalysisValidationError(
                    "Missing, blank or uncertain answers cannot support a confirmed priority"
                )
    return report


@lru_cache(maxsize=2)
def _prompts(language: str) -> dict[str, str]:
    locale = "zh" if language.lower().replace("_", "-").startswith("zh") else "en"
    path = Path(__file__).with_name("prompts") / f"{locale}.yaml"
    payload = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise AnalysisUnavailable("The assignment analysis prompt is unavailable")
    return payload


async def _request_model(*, prompt: str, system_prompt: str) -> str:
    # Lazy imports keep preview, validation and empty-input responses separate
    # from provider initialization. No tools, memory, retrieval or other learner
    # records are made available to this request.
    from deeptutor.services.llm.factory import complete

    return await complete(
        prompt=prompt,
        system_prompt=system_prompt,
        max_retries=0,
        max_tokens=8_000,
        allow_image_fallback=False,
    )


def _parse_response(response: str) -> ReportContent:
    if not isinstance(response, str) or len(response) > 160_000:
        raise AnalysisValidationError("The model response is missing or exceeds its size limit")
    text = response.strip()
    # Accept a single conventional JSON fence, without searching arbitrary
    # prose for a fragment or repairing truncated JSON into a valid report.
    if text.startswith("```json\n") and text.endswith("\n```"):
        text = text[8:-4]
    elif text.startswith("```\n") and text.endswith("\n```"):
        text = text[4:-4]

    def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate response keys")
            result[key] = value
        return result

    def invalid_constant(_value: str) -> None:
        raise ValueError("Non-finite JSON number")

    try:
        payload = json.loads(text, object_pairs_hook=unique_object, parse_constant=invalid_constant)
        return ReportContent.model_validate(payload)
    except (ValueError, RecursionError):
        raise AnalysisValidationError("The model returned an invalid report structure") from None


async def analyze_assignment(
    assignment: AssignmentInput, language: str = "zh"
) -> GeneratedAnalysis:
    """Analyze one confirmed input snapshot. The caller owns review and save."""
    try:
        assignment = AssignmentInput.model_validate(assignment)
    except ValidationError:
        raise AnalysisValidationError("The assignment has an invalid structure") from None
    if any(
        not getattr(assignment, field).strip()
        for field in ("student_ref", "assignment_ref", "subject")
    ):
        raise AnalysisValidationError("Student, assignment and subject are required for analysis")
    prompts = _prompts(language)
    source_fingerprint = fingerprint_assignment(assignment)
    if not assignment.items:
        return GeneratedAnalysis(
            analysis=ReportContent(
                summary=prompts["empty_summary"],
                items=[],
                priorities=[],
                limitations=[prompts["empty_limitation"], prompts["empty_next_step"]],
            ),
            source_fingerprint=source_fingerprint,
        )
    system_prompt = (
        prompts["system"]
        + "\n\n"
        + json.dumps(ReportContent.model_json_schema(), ensure_ascii=False)
    )
    # Send only this explicit, bounded input. Expected evaluation outcomes,
    # other students and global settings are never added to the payload.
    # Original document citations are retained in saved reports for review.
    # The teacher-checked fields already contain the working input; avoid
    # duplicating the full source excerpts in another model request.
    prompt = json.dumps(
        assignment.model_dump(mode="json", exclude={"document_provenance"}), ensure_ascii=False
    )
    try:
        response = await _request_model(prompt=prompt, system_prompt=system_prompt)
    except Exception as exc:
        from deeptutor.services.llm.exceptions import LLMConfigError

        if isinstance(exc, LLMConfigError):
            raise AnalysisNotConfigured(
                "Configure a text model in Settings before analyzing this assignment."
            ) from None
        raise AnalysisUnavailable("Assignment analysis is unavailable. Please retry.") from None
    try:
        report = validate_analysis(assignment, _parse_response(response))
    except AnalysisValidationError:
        raise AnalysisUnavailable(
            "The model returned an invalid analysis. Review the input and retry."
        ) from None
    return GeneratedAnalysis(analysis=report, source_fingerprint=source_fingerprint)


__all__ = [
    "AnalysisNotConfigured",
    "AnalysisUnavailable",
    "AnalysisValidationError",
    "analyze_assignment",
    "fingerprint_assignment",
    "validate_analysis",
]
