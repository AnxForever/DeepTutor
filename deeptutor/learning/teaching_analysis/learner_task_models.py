"""Separate teacher issue receipts and deliberately small student payloads."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .followup_models import SavedFollowup
from .models import Assistance

TaskStatus = Literal["pending", "in_progress", "submitted", "revoked"]
ResponseStatus = Literal["unanswered", "answered", "needs_help"]


def _utf8(value: str | None) -> str | None:
    if value is not None:
        try:
            value.encode("utf-8")
        except UnicodeError:
            raise ValueError("Task text must be valid Unicode") from None
    return value


class _TaskModel(BaseModel):
    model_config = ConfigDict(extra="forbid", revalidate_instances="always")


class IssueTaskRequest(_TaskModel):
    task_id: UUID
    followup_id: UUID
    followup_revision: int = Field(ge=1, strict=True)
    recipient_user_id: str = Field(min_length=1, max_length=64, strict=True)
    title: str = Field(min_length=1, max_length=200, strict=True)
    instructions: str = Field(default="", max_length=1000, strict=True)

    @field_validator("recipient_user_id", "title", "instructions")
    @classmethod
    def valid_text(cls, value: str) -> str:
        _utf8(value)
        return value

    @field_validator("recipient_user_id", "title")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("A task needs a recipient and a title")
        return value


class TaskResponse(_TaskModel):
    question_id: str = Field(min_length=1, max_length=128, strict=True)
    response_status: ResponseStatus
    answer: str | None = Field(default=None, max_length=6000, strict=True)
    assistance: Assistance = "unknown"

    @field_validator("question_id", "answer")
    @classmethod
    def valid_text(cls, value: str | None) -> str | None:
        return _utf8(value)

    @model_validator(mode="after")
    def explicit_response_state(self) -> TaskResponse:
        if not self.question_id.strip():
            raise ValueError("A response needs a question id")
        if self.response_status == "answered":
            if self.answer is None or not self.answer.strip():
                raise ValueError("An answered response needs actual answer text")
        elif self.response_status == "unanswered" and self.answer is not None:
            raise ValueError("An unanswered response must have a null answer")
        elif self.answer is not None and not self.answer.strip():
            raise ValueError("A needs-help response may retain actual work or a null answer")
        return self


class _Responses(_TaskModel):
    responses: list[TaskResponse] = Field(min_length=1, max_length=3)

    @model_validator(mode="after")
    def unique_questions(self) -> _Responses:
        ids = [response.question_id for response in self.responses]
        if len(ids) != len(set(ids)):
            raise ValueError("Each question must have exactly one response")
        return self


class SaveTaskProgressRequest(_Responses):
    request_id: UUID
    expected_revision: int = Field(ge=0, strict=True)
    current_question_index: int = Field(ge=0, le=2, strict=True)


class SubmitTaskRequest(_Responses):
    submission_id: UUID
    expected_revision: int = Field(ge=0, strict=True)


class RevokeTaskRequest(_TaskModel):
    expected_revision: int = Field(ge=1, strict=True)
    reason: str = Field(min_length=1, max_length=2000, strict=True)

    @field_validator("reason")
    @classmethod
    def actual_reason(cls, value: str) -> str:
        _utf8(value)
        if not value.strip():
            raise ValueError("Revoking a task requires a reason")
        return value


class StudentTaskQuestion(_TaskModel):
    question_id: str
    question: str


class StudentTaskProgress(_Responses):
    revision: int = Field(ge=0, strict=True)
    current_question_index: int = Field(ge=0, le=2, strict=True)
    saved_at: float | None = Field(default=None, ge=0, allow_inf_nan=False, strict=True)


class TeacherTaskProgress(_TaskModel):
    revision: int = Field(ge=0, strict=True)
    current_question_index: int = Field(ge=0, le=2, strict=True)
    saved_at: float | None = Field(default=None, ge=0, allow_inf_nan=False, strict=True)


class StudentSubmission(_Responses):
    task_id: UUID
    submission_id: UUID
    submitted_at: float = Field(ge=0, allow_inf_nan=False, strict=True)


class StudentTaskSummary(_TaskModel):
    task_id: UUID
    title: str
    question_count: int = Field(ge=1, le=3, strict=True)
    status: TaskStatus
    issued_at: float = Field(ge=0, allow_inf_nan=False, strict=True)
    updated_at: float = Field(ge=0, allow_inf_nan=False, strict=True)
    submitted_at: float | None = Field(default=None, ge=0, allow_inf_nan=False, strict=True)


class StudentTaskView(_TaskModel):
    task_id: UUID
    title: str
    instructions: str
    task_revision: int = Field(ge=1, strict=True)
    issued_at: float = Field(ge=0, allow_inf_nan=False, strict=True)
    status: TaskStatus
    questions: list[StudentTaskQuestion] = Field(min_length=1, max_length=3)
    progress: StudentTaskProgress
    submission: StudentSubmission | None


class TeacherTaskSummary(_TaskModel):
    task_id: UUID
    task_revision: int = Field(ge=1, strict=True)
    title: str
    recipient_user_id: str
    followup_id: UUID
    followup_revision: int = Field(ge=1, strict=True)
    status: TaskStatus
    issued_at: float = Field(ge=0, allow_inf_nan=False, strict=True)
    updated_at: float = Field(ge=0, allow_inf_nan=False, strict=True)
    submitted_at: float | None = Field(default=None, ge=0, allow_inf_nan=False, strict=True)
    progress: TeacherTaskProgress


class TeacherTaskView(TeacherTaskSummary):
    instructions: str
    source_snapshot: SavedFollowup
    submission: StudentSubmission | None
    started_at: float | None = Field(default=None, ge=0, allow_inf_nan=False, strict=True)
    revoked_at: float | None = Field(default=None, ge=0, allow_inf_nan=False, strict=True)
    revoke_reason: str | None
    issued_by_user_id: str


__all__ = [
    "IssueTaskRequest",
    "TaskResponse",
    "SaveTaskProgressRequest",
    "SubmitTaskRequest",
    "RevokeTaskRequest",
    "StudentTaskQuestion",
    "StudentTaskProgress",
    "TeacherTaskProgress",
    "StudentSubmission",
    "StudentTaskSummary",
    "StudentTaskView",
    "TeacherTaskSummary",
    "TeacherTaskView",
]
