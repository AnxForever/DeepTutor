"""Bounded input and report contracts for one uploaded assignment package."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .document_provenance import DocumentProvenance
from .rubric_models import RubricSnapshot

MAX_ITEMS = 40
MAX_TOTAL_CHARS = 60_000

AnswerStatus = Literal["present", "confirmed_blank", "unknown"]
TranscriptionStatus = Literal["confirmed", "uncertain", "not_applicable"]
Assistance = Literal["independent", "assisted", "unknown"]
AssessmentResult = Literal["correct", "partial", "incorrect", "ungraded"]
KnowledgePoint = Annotated[str, Field(min_length=1, max_length=200)]


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, revalidate_instances="always")


class AssignmentItem(_StrictModel):
    question_id: str = Field(min_length=1, max_length=128)
    question: str = Field(min_length=1, max_length=6_000)
    student_answer: str | None = Field(default=None, max_length=6_000)
    student_work: str | None = Field(default=None, max_length=8_000)
    reference_answer: str | None = Field(default=None, max_length=6_000)
    rubric: str | None = Field(default=None, max_length=4_000)
    knowledge_points: list[KnowledgePoint] = Field(default_factory=list, max_length=20)
    source_locator: str = Field(default="", max_length=500)
    answer_status: AnswerStatus = "unknown"
    transcription_status: TranscriptionStatus = "not_applicable"
    assistance: Assistance = "unknown"

    @model_validator(mode="before")
    @classmethod
    def infer_present_content(cls, value: Any) -> Any:
        # A missing cell is never evidence that the learner left a blank.
        # Actual supplied content can establish presence, but only an explicit
        # teacher declaration can establish a confirmed blank.
        if isinstance(value, dict) and "answer_status" not in value:
            present = any(
                isinstance(value.get(key), str) and value[key].strip()
                for key in ("student_answer", "student_work")
            )
            normalized = {**value, "answer_status": "present" if present else "unknown"}
            if not present:
                for key in ("student_answer", "student_work"):
                    if isinstance(normalized.get(key), str) and not normalized[key].strip():
                        normalized[key] = None
            return normalized
        return value

    @field_validator("question_id", "question")
    @classmethod
    def require_visible_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Question id and question must contain text")
        return value

    @model_validator(mode="after")
    def consistent_answer_status(self) -> AssignmentItem:
        has_content = any(
            isinstance(value, str) and value.strip()
            for value in (self.student_answer, self.student_work)
        )
        if self.answer_status == "present" and not has_content:
            raise ValueError("A present answer requires actual answer or work content")
        if self.answer_status == "confirmed_blank" and (
            self.student_answer != "" or self.student_work != ""
        ):
            raise ValueError("Confirmed blank requires explicit empty answer and work strings")
        if self.answer_status == "unknown" and self.student_answer is not None:
            raise ValueError("An unknown answer must be null, not a confirmed blank or answer")
        return self


def _text_size(value: Any) -> int:
    if isinstance(value, str):
        return len(value)
    if isinstance(value, dict):
        return sum(_text_size(item) for item in value.values())
    if isinstance(value, list):
        return sum(_text_size(item) for item in value)
    return 0


class AssignmentInput(_StrictModel):
    # Empty metadata is permitted while previewing; analysis requires these
    # three identifiers, so the teacher can supply missing CSV metadata first.
    student_ref: str = Field(default="", max_length=200)
    assignment_ref: str = Field(default="", max_length=200)
    subject: str = Field(default="", max_length=200)
    grade: str = Field(default="", max_length=200)
    teacher_context: str = Field(default="", max_length=6_000)
    rubric_template: RubricSnapshot | None = None
    document_provenance: DocumentProvenance | None = None
    items: list[AssignmentItem] = Field(default_factory=list, max_length=MAX_ITEMS)

    @model_validator(mode="after")
    def bounded_unique_assignment(self) -> AssignmentInput:
        ids = [item.question_id for item in self.items]
        if len(ids) != len(set(ids)):
            raise ValueError("Question ids must be unique within this assignment")
        if _text_size(self.model_dump(mode="json")) > MAX_TOTAL_CHARS:
            raise ValueError(f"Assignment exceeds {MAX_TOTAL_CHARS} text characters")
        return self


class Evidence(_StrictModel):
    question_id: str = Field(min_length=1, max_length=128)
    field: Literal["student_answer", "student_work"]
    quote: str = Field(min_length=1, max_length=2_000)

    @field_validator("quote")
    @classmethod
    def require_nonblank_quote(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Evidence quote cannot be whitespace")
        # Preserve the literal string; normalizing it would weaken the exact
        # match against the teacher-confirmed input.
        return value


class ItemReview(_StrictModel):
    question_id: str = Field(min_length=1, max_length=128)
    result: AssessmentResult
    observation: str = Field(min_length=1, max_length=3_000)
    evidence: list[Evidence] = Field(max_length=10)

    @field_validator("observation")
    @classmethod
    def require_observation(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("An observation must contain text")
        return value


class TeachingPriority(_StrictModel):
    knowledge_point: str = Field(min_length=1, max_length=200)
    observation: str = Field(min_length=1, max_length=2_000)
    hypothesis: str = Field(max_length=2_000)
    alternative_explanation: str = Field(max_length=2_000)
    teaching_action: str = Field(min_length=1, max_length=3_000)
    follow_up_question: str = Field(min_length=1, max_length=2_000)
    reference_guidance: str = Field(max_length=2_000)
    evidence_status: Literal["supported", "needs_check"]
    evidence: list[Evidence] = Field(max_length=10)

    @field_validator("knowledge_point", "observation", "teaching_action", "follow_up_question")
    @classmethod
    def require_priority_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("A priority requires an observation and actionable teaching text")
        return value


class ReportContent(_StrictModel):
    summary: str = Field(min_length=1, max_length=5_000)
    items: list[ItemReview] = Field(max_length=MAX_ITEMS)
    priorities: list[TeachingPriority] = Field(max_length=3)
    limitations: list[Annotated[str, Field(min_length=1, max_length=1_000)]] = Field(max_length=20)

    @field_validator("summary")
    @classmethod
    def require_summary(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("A report summary must contain text")
        return value


class GeneratedAnalysis(_StrictModel):
    analysis: ReportContent
    source_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
