"""Teacher assessment revisions, separate from immutable learner submissions."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .learner_task_models import TaskStatus
from .models import AssessmentResult

TaskReviewStatus = Literal["confirmed", "withdrawn"]


def _text(value: str) -> str:
    try:
        value.encode("utf-8")
    except UnicodeError:
        raise ValueError("Review text must be valid Unicode") from None
    return value


class _ReviewModel(BaseModel):
    model_config = ConfigDict(extra="forbid", revalidate_instances="always")


class TaskReviewItem(_ReviewModel):
    question_id: str = Field(min_length=1, max_length=128, strict=True)
    result: AssessmentResult
    feedback: str = Field(default="", max_length=2000, strict=True)

    @field_validator("question_id", "feedback")
    @classmethod
    def valid_text(cls, value: str) -> str:
        return _text(value)

    @field_validator("question_id")
    @classmethod
    def actual_question(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("A review needs a question id")
        return value


class _ReviewContent(_ReviewModel):
    items: list[TaskReviewItem] = Field(min_length=1, max_length=3)
    summary: str = Field(default="", max_length=3000, strict=True)
    change_reason: str = Field(default="", max_length=2000, strict=True)

    @field_validator("summary", "change_reason")
    @classmethod
    def valid_text(cls, value: str) -> str:
        return _text(value)

    @model_validator(mode="after")
    def unique_questions(self) -> _ReviewContent:
        ids = [item.question_id for item in self.items]
        if len(ids) != len(set(ids)):
            raise ValueError("Each question must have exactly one assessment")
        return self


class SaveTaskReviewRequest(_ReviewContent):
    request_id: UUID
    submission_id: UUID
    expected_revision: int = Field(ge=0, strict=True)


class WithdrawTaskReviewRequest(_ReviewModel):
    request_id: UUID
    expected_revision: int = Field(ge=1, strict=True)
    reason: str = Field(min_length=1, max_length=2000, strict=True)

    @field_validator("reason")
    @classmethod
    def actual_reason(cls, value: str) -> str:
        _text(value)
        if not value.strip():
            raise ValueError("Withdrawing an assessment needs a reason")
        return value


class SavedTaskReview(_ReviewContent):
    task_id: UUID
    submission_id: UUID
    request_id: UUID
    revision: int = Field(ge=1, strict=True)
    status: TaskReviewStatus
    recipient_user_id: str = Field(min_length=1, max_length=64, strict=True)
    report_id: UUID
    report_revision: int = Field(ge=1, strict=True)
    followup_id: UUID
    followup_revision: int = Field(ge=1, strict=True)
    subject: str = Field(max_length=200, strict=True)
    knowledge_point: str = Field(max_length=200, strict=True)
    submission_receipt_hash: str = Field(pattern=r"^[a-f0-9]{64}$", strict=True)
    reviewer_user_id: str = Field(min_length=1, max_length=64, strict=True)
    recorded_at: float = Field(ge=0, allow_inf_nan=False, strict=True)

    @field_validator("subject", "knowledge_point")
    @classmethod
    def valid_source_text(cls, value: str) -> str:
        return _text(value)

    @field_validator("recipient_user_id", "reviewer_user_id")
    @classmethod
    def actual_text(cls, value: str) -> str:
        _text(value)
        if not value.strip():
            raise ValueError("Stored review metadata must contain text")
        return value

    @model_validator(mode="after")
    def correction_audit(self) -> SavedTaskReview:
        if (self.revision > 1 or self.status == "withdrawn") and not self.change_reason.strip():
            raise ValueError("A correction or withdrawal needs an audit reason")
        return self


class TaskReviewState(_ReviewModel):
    task_id: UUID
    submission_id: UUID | None
    task_status: TaskStatus
    current_review: SavedTaskReview | None


__all__ = [
    "TaskReviewStatus",
    "TaskReviewItem",
    "SaveTaskReviewRequest",
    "WithdrawTaskReviewRequest",
    "SavedTaskReview",
    "TaskReviewState",
]
