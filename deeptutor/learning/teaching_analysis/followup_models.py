"""Teacher-reviewed practice sets and immutable student submission contracts."""

from __future__ import annotations

from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .models import AnswerStatus, AssessmentResult, AssignmentItem, Assistance


class _FollowupModel(BaseModel):
    model_config = ConfigDict(extra="forbid", revalidate_instances="always")


class FollowupQuestion(_FollowupModel):
    question_id: str = Field(min_length=1, max_length=128, strict=True)
    question: str = Field(min_length=1, max_length=6_000, strict=True)
    reference_answer: str | None = Field(default=None, max_length=6_000, strict=True)
    rubric: str | None = Field(default=None, max_length=4_000, strict=True)

    @field_validator("question_id", "question")
    @classmethod
    def nonblank_question(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("A practice question needs an id and question text")
        return value


class _FollowupContent(_FollowupModel):
    report_id: UUID
    report_revision: int = Field(ge=1, strict=True)
    priority_index: int = Field(ge=0, le=2, strict=True)
    title: str = Field(min_length=1, max_length=300, strict=True)
    questions: list[FollowupQuestion] = Field(min_length=1, max_length=3)

    @field_validator("title")
    @classmethod
    def nonblank_title(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("A practice set needs a title")
        return value

    @model_validator(mode="after")
    def unique_question_ids(self) -> _FollowupContent:
        ids = [question.question_id for question in self.questions]
        if len(ids) != len(set(ids)):
            raise ValueError("Question ids must be unique within a practice set")
        return self


class SaveFollowupRequest(_FollowupContent):
    followup_id: UUID
    expected_revision: int = Field(default=0, ge=0, strict=True)


class _SourceMetadata(_FollowupModel):
    student_ref: str
    assignment_ref: str
    subject: str
    grade: str
    source_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    knowledge_point: str


class SavedFollowup(_FollowupContent, _SourceMetadata):
    followup_id: UUID
    revision: int = Field(ge=1, strict=True)
    created_at: float
    updated_at: float


class SaveFollowupAttemptRequest(_FollowupModel):
    attempt_id: UUID
    followup_revision: int = Field(ge=1, strict=True)
    question_id: str = Field(min_length=1, max_length=128, strict=True)
    student_answer: str | None = Field(default=None, max_length=6_000, strict=True)
    student_work: str | None = Field(default=None, max_length=8_000, strict=True)
    answer_status: AnswerStatus = "unknown"
    assistance: Assistance = "unknown"
    teacher_result: AssessmentResult = "ungraded"
    teacher_feedback: str = Field(default="", max_length=4_000, strict=True)

    @model_validator(mode="after")
    def review_actual_answer_only(self) -> SaveFollowupAttemptRequest:
        # Use the same present/confirmed-blank/unknown distinctions as the
        # assignment input. This is validation, not a grading call.
        AssignmentItem(
            question_id=self.question_id,
            question="Teacher-reviewed follow-up response",
            student_answer=self.student_answer,
            student_work=self.student_work,
            answer_status=self.answer_status,
            assistance=self.assistance,
        )
        if self.answer_status != "present" and self.teacher_result != "ungraded":
            raise ValueError("Unknown or blank responses must remain ungraded")
        return self


class SavedFollowupAttempt(SaveFollowupAttemptRequest, _SourceMetadata):
    followup_id: UUID
    report_id: UUID
    report_revision: int = Field(ge=1, strict=True)
    priority_index: int = Field(ge=0, le=2, strict=True)
    question_snapshot: FollowupQuestion
    created_at: float
    voided_at: float | None = None
    void_reason: str | None = None


class VoidFollowupAttemptRequest(_FollowupModel):
    reason: str = Field(min_length=1, max_length=2_000, strict=True)

    @field_validator("reason")
    @classmethod
    def nonblank_reason(cls, value: str) -> str:
        reason = value.strip()
        if not reason:
            raise ValueError("Voiding a response requires a reason")
        return reason


__all__ = [
    "FollowupQuestion",
    "SaveFollowupRequest",
    "SavedFollowup",
    "SaveFollowupAttemptRequest",
    "SavedFollowupAttempt",
    "VoidFollowupAttemptRequest",
]
