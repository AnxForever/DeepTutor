"""Separate, teacher-confirmed links from anonymous cases to formal reviews."""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .learner_task_models import ResponseStatus, TaskRevealedHint
from .models import AssessmentResult, Assistance


def _text(value: str) -> str:
    try:
        value.encode("utf-8")
    except UnicodeError:
        raise ValueError("Evidence text must be valid Unicode") from None
    return value


class _EvidenceModel(BaseModel):
    model_config = ConfigDict(extra="forbid", revalidate_instances="always")


QuestionId = Annotated[str, Field(min_length=1, max_length=128, strict=True)]


class CaseReviewEvidenceLink(_EvidenceModel):
    task_id: UUID
    submission_id: UUID
    review_revision: int = Field(ge=1, strict=True)
    question_ids: list[QuestionId] = Field(min_length=1, max_length=3)
    teacher_observation: str = Field(default="", max_length=2000, strict=True)
    next_teaching_action: str = Field(default="", max_length=2000, strict=True)

    @field_validator("teacher_observation", "next_teaching_action")
    @classmethod
    def valid_text(cls, value: str) -> str:
        return _text(value)

    @field_validator("question_ids")
    @classmethod
    def valid_questions(cls, values: list[str]) -> list[str]:
        if len(values) != len(set(values)):
            raise ValueError("Each evidence question may be selected only once")
        for value in values:
            if not _text(value).strip():
                raise ValueError("Evidence needs a question identifier")
        return values


class _EvidenceContent(_EvidenceModel):
    identity_confirmed: Literal[True]
    links: list[CaseReviewEvidenceLink] = Field(max_length=20)

    @field_validator("identity_confirmed", mode="before")
    @classmethod
    def explicitly_confirmed(cls, value: object) -> bool:
        if value is not True:
            raise ValueError("Explicitly confirm the learner and anonymous case identity")
        return True

    @model_validator(mode="after")
    def unique_submissions(self) -> _EvidenceContent:
        ids = [link.submission_id for link in self.links]
        if len(ids) != len(set(ids)):
            raise ValueError("Each formal submission may be linked only once")
        return self


class SaveCaseReviewEvidence(_EvidenceContent):
    request_id: UUID
    expected_revision: int = Field(ge=0, strict=True)
    expected_case_revision: int = Field(ge=1, strict=True)


class SavedCaseReviewEvidence(_EvidenceContent):
    case_id: UUID
    revision: int = Field(ge=1, strict=True)
    case_revision: int = Field(ge=1, strict=True)
    request_id: UUID
    actor_user_id: str = Field(min_length=1, max_length=64, strict=True)
    recipient_user_id: str | None = Field(default=None, min_length=1, max_length=64, strict=True)
    recorded_at: float = Field(ge=0, allow_inf_nan=False, strict=True)

    @field_validator("actor_user_id")
    @classmethod
    def valid_actor(cls, value: str) -> str:
        if not _text(value).strip():
            raise ValueError("Evidence needs an audited actor")
        return value

    @field_validator("recipient_user_id")
    @classmethod
    def valid_recipient(cls, value: str | None) -> str | None:
        if value is not None and not _text(value).strip():
            raise ValueError("Evidence needs a real learner identifier")
        return value

    @model_validator(mode="after")
    def bound_identity(self) -> SavedCaseReviewEvidence:
        if bool(self.links) != (self.recipient_user_id is not None):
            raise ValueError("Nonempty evidence must bind one confirmed learner")
        return self


class CaseReviewQuestionEvidence(_EvidenceModel):
    question_id: str
    question: str
    answer: str | None
    response_status: ResponseStatus
    assistance: Assistance
    result: AssessmentResult
    feedback: str
    # None records legacy unknown usage; [] records known no hint use.
    hint_usage: list[TaskRevealedHint] | None


EvidenceSourceStatus = Literal[
    "current", "stale", "withdrawn", "task_revoked", "unavailable", "report_unlinked"
]


class CaseReviewEvidenceSourceState(_EvidenceModel):
    task_id: UUID
    submission_id: UUID
    review_revision: int = Field(ge=1, strict=True)
    status: EvidenceSourceStatus
    latest_review_revision: int | None = Field(default=None, ge=1, strict=True)
    review_status: Literal["confirmed", "withdrawn"] | None = None
    latest_review_status: Literal["confirmed", "withdrawn"] | None = None
    latest_recorded_at: float | None = Field(default=None, ge=0, allow_inf_nan=False, strict=True)
    recipient_user_id: str | None = None
    subject: str | None = None
    knowledge_point: str | None = None
    report_id: UUID | None = None
    report_revision: int | None = Field(default=None, ge=1, strict=True)
    reviewer_user_id: str | None = None
    recorded_at: float | None = Field(default=None, ge=0, allow_inf_nan=False, strict=True)
    questions: list[CaseReviewQuestionEvidence] = Field(default_factory=list, max_length=3)


class CaseReviewFocusCard(_EvidenceModel):
    subject: str
    knowledge_point: str
    question_count: int = Field(ge=1, strict=True)
    needs_teaching: int = Field(ge=0, strict=True)
    needs_independent_check: int = Field(ge=0, strict=True)
    ungraded: int = Field(ge=0, strict=True)
    independent_correct: int = Field(ge=0, strict=True)
    requested_help: int = Field(default=0, ge=0, strict=True)

    @model_validator(mode="after")
    def complete_counts(self) -> CaseReviewFocusCard:
        if self.question_count != (
            self.needs_teaching
            + self.needs_independent_check
            + self.ungraded
            + self.independent_correct
        ):
            raise ValueError("Evidence focus counts do not match unique reviewed questions")
        if self.requested_help > self.question_count:
            raise ValueError("Help requests cannot exceed unique evidence questions")
        return self


class CaseReviewEvidenceView(_EvidenceModel):
    case_id: UUID
    case_revision: int = Field(ge=1, strict=True)
    case_archived: bool
    overlay: SavedCaseReviewEvidence | None
    acknowledged: SavedCaseReviewEvidence | None = None
    source_states: list[CaseReviewEvidenceSourceState] = Field(max_length=20)
    focus_cards: list[CaseReviewFocusCard] = Field(max_length=20)


__all__ = [
    "CaseReviewEvidenceLink",
    "SaveCaseReviewEvidence",
    "SavedCaseReviewEvidence",
    "CaseReviewQuestionEvidence",
    "CaseReviewEvidenceSourceState",
    "CaseReviewFocusCard",
    "CaseReviewEvidenceView",
]
