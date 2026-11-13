"""Stable, workspace-local student cases and explicit pinned evidence views."""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .followup_models import SavedFollowupAttempt
from .models import AssessmentResult, Assistance, ItemReview, TeachingPriority


class _CaseModel(BaseModel):
    model_config = ConfigDict(extra="forbid", revalidate_instances="always")


class PinnedReportRef(_CaseModel):
    report_id: UUID
    report_revision: int = Field(ge=1, strict=True)


class _CaseContent(_CaseModel):
    case_id: UUID
    label: str = Field(min_length=1, max_length=200, strict=True)
    subject: str | None = Field(default=None, max_length=200, strict=True)
    archived: bool = Field(default=False, strict=True)
    report_refs: list[PinnedReportRef] = Field(default_factory=list, max_length=20)

    @field_validator("label", "subject")
    @classmethod
    def valid_text(cls, value: str | None) -> str | None:
        if value is not None:
            try:
                value.encode("utf-8")
            except UnicodeError:
                raise ValueError("Case text must be valid Unicode") from None
        return value

    @field_validator("label")
    @classmethod
    def nonblank_label(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("A student case needs a display label")
        return value

    @model_validator(mode="after")
    def unique_reports(self) -> _CaseContent:
        ids = [ref.report_id for ref in self.report_refs]
        if len(ids) != len(set(ids)):
            raise ValueError("A report may be pinned only once in a student case")
        return self


class SaveStudentCaseRequest(_CaseContent):
    expected_revision: int = Field(default=0, ge=0, strict=True)


class SavedStudentCase(_CaseContent):
    revision: int = Field(ge=1, strict=True)
    created_at: float = Field(ge=0, allow_inf_nan=False, strict=True)
    updated_at: float = Field(ge=0, allow_inf_nan=False, strict=True)


class StudentCaseSummary(_CaseModel):
    case_id: UUID
    revision: int = Field(ge=1, strict=True)
    label: str
    subject: str | None
    archived: bool
    report_count: int = Field(ge=0, le=20, strict=True)
    created_at: float = Field(ge=0, allow_inf_nan=False, strict=True)
    updated_at: float = Field(ge=0, allow_inf_nan=False, strict=True)


class CaseSourceState(_CaseModel):
    report_id: UUID
    report_revision: int = Field(ge=1, strict=True)
    status: Literal["current", "stale", "unavailable"]
    latest_revision: int | None = Field(default=None, ge=1, strict=True)
    student_ref: str | None = None
    assignment_ref: str | None = None
    message: str | None = None


class CaseResultCounts(_CaseModel):
    correct: int = Field(default=0, ge=0, strict=True)
    partial: int = Field(default=0, ge=0, strict=True)
    incorrect: int = Field(default=0, ge=0, strict=True)
    ungraded: int = Field(default=0, ge=0, strict=True)


class CaseAssistanceCounts(_CaseModel):
    independent: int = Field(default=0, ge=0, strict=True)
    assisted: int = Field(default=0, ge=0, strict=True)
    unknown: int = Field(default=0, ge=0, strict=True)


class CaseAttemptOutcome(_CaseModel):
    assistance: Assistance
    teacher_result: AssessmentResult
    count: int = Field(ge=0, strict=True)


class CaseTimelineCounts(_CaseModel):
    linked_reports: int = Field(ge=0, strict=True)
    available_reports: int = Field(ge=0, strict=True)
    unavailable_reports: int = Field(ge=0, strict=True)
    confirmed_report_count: int = Field(ge=0, strict=True)
    stale_source_count: int = Field(ge=0, strict=True)
    report_items: int = Field(ge=0, strict=True)
    report_results: CaseResultCounts
    attempts: int = Field(ge=0, strict=True)
    voided_attempts: int = Field(ge=0, strict=True)
    attempt_results: CaseResultCounts
    attempt_assistance: CaseAssistanceCounts
    attempt_outcomes: list[CaseAttemptOutcome] = Field(min_length=12, max_length=12)
    total_events: int = Field(ge=0, strict=True)


class CaseReportSnapshot(_CaseModel):
    report_id: UUID
    report_revision: int = Field(ge=1, strict=True)
    student_ref: str
    assignment_ref: str
    subject: str
    summary: str
    items: list[ItemReview]
    priorities: list[TeachingPriority]


class CaseReportEvent(_CaseModel):
    kind: Literal["report"] = "report"
    event_id: str
    recorded_at: float = Field(ge=0, allow_inf_nan=False, strict=True)
    report_snapshot: CaseReportSnapshot


class CaseAttemptEvent(_CaseModel):
    kind: Literal["attempt"] = "attempt"
    event_id: str
    recorded_at: float = Field(ge=0, allow_inf_nan=False, strict=True)
    attempt: SavedFollowupAttempt


CaseTimelineEvent = Annotated[CaseReportEvent | CaseAttemptEvent, Field(discriminator="kind")]


class StudentCaseTimeline(_CaseModel):
    case_id: UUID
    case_revision: int = Field(ge=1, strict=True)
    case_label: str
    archived: bool
    source_states: list[CaseSourceState]
    counts: CaseTimelineCounts
    events: list[CaseTimelineEvent] = Field(max_length=100)
    next_cursor: str | None
    generated_at: float = Field(ge=0, allow_inf_nan=False, strict=True)
