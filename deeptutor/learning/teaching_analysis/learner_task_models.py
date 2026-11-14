"""Separate teacher issue receipts and deliberately small student payloads."""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator, model_validator

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


def _nonblank_hint(value: str) -> str:
    _utf8(value)
    if not value.strip():
        raise ValueError("A hint needs actual text")
    return value


HintText = Annotated[
    str, Field(min_length=1, max_length=600, strict=True), AfterValidator(_nonblank_hint)
]


class TaskQuestionHints(_TaskModel):
    question_id: str = Field(min_length=1, max_length=128, strict=True)
    hints: list[HintText] = Field(min_length=1, max_length=3)

    @field_validator("question_id")
    @classmethod
    def valid_question(cls, value: str) -> str:
        _utf8(value)
        if not value.strip():
            raise ValueError("A hint plan needs a question id")
        return value


class IssueTaskRequest(_TaskModel):
    task_id: UUID
    followup_id: UUID
    followup_revision: int = Field(ge=1, strict=True)
    recipient_user_id: str = Field(min_length=1, max_length=64, strict=True)
    title: str = Field(min_length=1, max_length=200, strict=True)
    instructions: str = Field(default="", max_length=1000, strict=True)
    question_hints: list[TaskQuestionHints] = Field(default_factory=list, max_length=3)

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

    @model_validator(mode="after")
    def unique_hint_questions(self) -> IssueTaskRequest:
        ids = [plan.question_id for plan in self.question_hints]
        if len(ids) != len(set(ids)):
            raise ValueError("Each question may have only one hint plan")
        return self


class RevealTaskHintRequest(_TaskModel):
    question_id: str = Field(min_length=1, max_length=128, strict=True)
    request_id: UUID
    expected_hint_revision: int = Field(ge=0, le=9, strict=True)

    @field_validator("question_id")
    @classmethod
    def valid_question(cls, value: str) -> str:
        _utf8(value)
        if not value.strip():
            raise ValueError("A hint request needs a question id")
        return value


class TaskHintUse(_TaskModel):
    level: int = Field(ge=1, le=3, strict=True)
    revealed_at: float = Field(ge=0, allow_inf_nan=False, strict=True)


class TaskRevealedHint(TaskHintUse):
    text: HintText


class TaskHintUsage(_TaskModel):
    question_id: str = Field(min_length=1, max_length=128, strict=True)
    revealed: list[TaskHintUse] = Field(min_length=1, max_length=3)

    @field_validator("question_id")
    @classmethod
    def valid_question(cls, value: str) -> str:
        _utf8(value)
        if not value.strip():
            raise ValueError("Hint usage needs a question id")
        return value

    @model_validator(mode="after")
    def ordered_prefix(self) -> TaskHintUsage:
        if [hint.level for hint in self.revealed] != list(range(1, len(self.revealed) + 1)):
            raise ValueError("Hint usage must be an ordered prefix")
        if any(a.revealed_at > b.revealed_at for a, b in zip(self.revealed, self.revealed[1:])):
            raise ValueError("Hint usage times must be ordered")
        return self


class TaskHintsQuestion(_TaskModel):
    question_id: str
    total: int = Field(ge=0, le=3, strict=True)
    revealed: list[TaskRevealedHint] = Field(default_factory=list, max_length=3)

    @model_validator(mode="after")
    def ordered_prefix(self) -> TaskHintsQuestion:
        if len(self.revealed) > self.total or [hint.level for hint in self.revealed] != list(
            range(1, len(self.revealed) + 1)
        ):
            raise ValueError("Revealed hints must be a prefix of the issued plan")
        return self


class TaskHintsState(_TaskModel):
    task_id: UUID
    hint_revision: int = Field(ge=0, le=9, strict=True)
    questions: list[TaskHintsQuestion] = Field(min_length=1, max_length=3)

    @model_validator(mode="after")
    def consistent_revision(self) -> TaskHintsState:
        ids = [question.question_id for question in self.questions]
        if len(ids) != len(set(ids)) or self.hint_revision != sum(
            len(question.revealed) for question in self.questions
        ):
            raise ValueError("Hint state does not match its successful unlocks")
        return self


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
    hint_usage: list[TaskHintUsage] | None = Field(default=None, max_length=3)

    @model_validator(mode="after")
    def unique_hint_usage(self) -> StudentSubmission:
        if self.hint_usage is not None:
            ids = [usage.question_id for usage in self.hint_usage]
            if len(ids) != len(set(ids)) or not set(ids).issubset(
                response.question_id for response in self.responses
            ):
                raise ValueError("Submission hint usage must refer to distinct answered questions")
        return self


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
    question_hints: list[TaskQuestionHints] = Field(default_factory=list, max_length=3)
    hint_usage: list[TaskHintUsage] = Field(default_factory=list, max_length=3)


__all__ = [
    "IssueTaskRequest",
    "TaskQuestionHints",
    "RevealTaskHintRequest",
    "TaskHintUse",
    "TaskRevealedHint",
    "TaskHintUsage",
    "TaskHintsQuestion",
    "TaskHintsState",
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
