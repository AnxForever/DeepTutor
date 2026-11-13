"""Evidence timelines: pinned reports and teacher-reviewed, nonvoid responses."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import math
import re
import time
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .case_models import (
    CaseAttemptEvent,
    CaseAttemptOutcome,
    CaseReportEvent,
    CaseReportSnapshot,
    CaseSourceState,
    CaseTimelineCounts,
    StudentCaseTimeline,
)
from .case_storage import (
    CaseConflict,
    CaseNotFound,
    CaseSourceConflict,
    CaseValidationError,
    StudentCaseStore,
)
from .followups import FollowupStore
from .models import AssignmentInput, ReportContent
from .service import fingerprint_assignment, validate_analysis
from .storage import TeachingAnalysisStore

_RESULTS = ("correct", "partial", "incorrect", "ungraded")
_ASSISTANCE = ("independent", "assisted", "unknown")


def _canonical(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _digest(value) -> str:
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _validated_report(payload: dict, pair: tuple[str, int]) -> dict:
    """Malformed stored data is an error, never an absent/empty report."""
    try:
        if (
            not isinstance(payload, dict)
            or str(UUID(str(payload["report_id"]))) != pair[0]
            or type(payload["revision"]) is not int
            or payload["revision"] != pair[1]
            or payload["status"] not in {"draft", "confirmed"}
        ):
            raise ValueError("Invalid report identity or state")
        for key in ("created_at", "updated_at"):
            value = payload[key]
            if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                raise ValueError("Invalid report timestamp")
        assignment = AssignmentInput.model_validate(payload["assignment"])
        analysis = ReportContent.model_validate(payload["analysis"])
        fingerprint = payload["source_fingerprint"]
        if (
            not isinstance(fingerprint, str)
            or not re.fullmatch(r"[a-f0-9]{64}", fingerprint)
            or fingerprint_assignment(assignment) != fingerprint
        ):
            raise ValueError("Invalid stored source fingerprint")
        notes = payload.get("teacher_notes", "")
        if not isinstance(notes, str) or len(notes) > 6000:
            raise ValueError("Invalid stored teacher notes")
        notes.encode("utf-8")
        validate_analysis(assignment, analysis)
    except (KeyError, TypeError, ValidationError):
        raise ValueError("The stored source report is invalid.") from None
    return payload


class _Cursor(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: int = Field(ge=1, le=1)
    case_id: str = Field(min_length=36, max_length=36)
    case_revision: int = Field(ge=1)
    scope: str = Field(pattern=r"^[a-f0-9]{64}$")
    dataset: str = Field(pattern=r"^[a-f0-9]{64}$")
    after_time: float = Field(ge=0, allow_inf_nan=False)
    after_event: str = Field(min_length=1, max_length=200)


def _decode_cursor(value: str | None) -> _Cursor | None:
    if value is None:
        return None
    try:
        if not isinstance(value, str) or not value or len(value) > 2048:
            raise ValueError("Invalid cursor size")
        encoded = value.encode("ascii")
        raw = base64.b64decode(
            encoded + b"=" * ((-len(encoded)) % 4), altchars=b"-_", validate=True
        )
        return _Cursor.model_validate_json(raw)
    except (ValueError, UnicodeError, binascii.Error):
        raise CaseValidationError(
            "The timeline cursor is invalid. Reload the student case."
        ) from None


def _encode_cursor(cursor: _Cursor) -> str:
    return base64.urlsafe_b64encode(cursor.model_dump_json().encode()).decode().rstrip("=")


def get_student_case_store() -> StudentCaseStore:
    return StudentCaseStore()


def build_timeline(
    store: StudentCaseStore, case_id: str | UUID, *, limit: int = 50, cursor: str | None = None
) -> StudentCaseTimeline:
    saved = store.get_case(case_id)
    parsed = _decode_cursor(cursor)
    scope = _digest(str(store.root))
    if parsed and (
        parsed.case_id != str(saved.case_id)
        or parsed.case_revision != saved.revision
        or parsed.scope != scope
    ):
        raise CaseConflict("The student case changed. Reload its timeline before continuing.")
    refs = [(str(ref.report_id), ref.report_revision) for ref in saved.report_refs]
    reports, latest = TeachingAnalysisStore(store.root).pinned_projection(refs)
    source_states = []
    report_events = []
    report_results = dict.fromkeys(_RESULTS, 0)
    for pair in refs:
        raw = reports.get(pair)
        report = _validated_report(raw, pair) if raw is not None else None
        available = report is not None and report["status"] == "confirmed"
        status = (
            "unavailable"
            if not available
            else "current"
            if latest.get(pair[0]) == pair[1]
            else "stale"
        )
        source_states.append(
            CaseSourceState(
                report_id=pair[0],
                report_revision=pair[1],
                status=status,
                latest_revision=latest.get(pair[0]),
                student_ref=report["assignment"]["student_ref"] if available else None,
                assignment_ref=report["assignment"]["assignment_ref"] if available else None,
                message="The pinned source is unavailable in this workspace."
                if not available
                else "A newer source version exists; the linked version has not been changed."
                if status == "stale"
                else None,
            )
        )
        if not available:
            continue
        analysis = ReportContent.model_validate(report["analysis"])
        for item in analysis.items:
            report_results[item.result] += 1
        report_events.append(
            CaseReportEvent(
                event_id=f"report:{pair[0]}:{pair[1]}",
                recorded_at=report["updated_at"],
                report_snapshot=CaseReportSnapshot(
                    report_id=pair[0],
                    report_revision=pair[1],
                    student_ref=report["assignment"]["student_ref"],
                    assignment_ref=report["assignment"]["assignment_ref"],
                    subject=report["assignment"]["subject"],
                    summary=analysis.summary,
                    items=analysis.items,
                    priorities=analysis.priorities,
                ),
            )
        )
    after = (parsed.after_time, parsed.after_event) if parsed else None
    projection = FollowupStore(store.root).case_attempt_projection(
        refs, limit=limit + 1, after=after
    )
    dataset = _digest(
        {
            "reports": [[pair[0], pair[1], reports.get(pair)] for pair in refs],
            "sources": [value.model_dump(mode="json") for value in source_states],
            "attempts": projection["dataset"],
            "attempt_groups": projection["groups"],
        }
    )
    if parsed and parsed.dataset != dataset:
        raise CaseConflict("Timeline evidence changed. Reload before continuing to the next page.")
    attempt_results = dict.fromkeys(_RESULTS, 0)
    attempt_assistance = dict.fromkeys(_ASSISTANCE, 0)
    joint = {(assistance, result): 0 for assistance in _ASSISTANCE for result in _RESULTS}
    for group in projection["groups"]:
        assistance, result, count = group["assistance"], group["teacher_result"], group["count"]
        attempt_results[result] += count
        attempt_assistance[assistance] += count
        joint[(assistance, result)] += count
    counts = CaseTimelineCounts(
        linked_reports=len(refs),
        available_reports=len(report_events),
        unavailable_reports=len(refs) - len(report_events),
        confirmed_report_count=len(report_events),
        stale_source_count=sum(source.status == "stale" for source in source_states),
        report_items=sum(report_results.values()),
        report_results=report_results,
        attempts=projection["total"] - projection["voided"],
        voided_attempts=projection["voided"],
        attempt_results=attempt_results,
        attempt_assistance=attempt_assistance,
        attempt_outcomes=[
            CaseAttemptOutcome(assistance=a, teacher_result=r, count=n)
            for (a, r), n in joint.items()
        ],
        total_events=len(report_events) + projection["total"] - projection["voided"],
    )
    events = [
        event
        for event in report_events
        if after is None
        or event.recorded_at < after[0]
        or (event.recorded_at == after[0] and event.event_id > after[1])
    ]
    events.extend(
        CaseAttemptEvent(
            event_id="attempt:" + attempt["attempt_id"],
            recorded_at=attempt["created_at"],
            attempt=attempt,
        )
        for attempt in projection["attempts"]
    )
    events.sort(key=lambda event: (-event.recorded_at, event.event_id))
    more = len(events) > limit
    selected = events[:limit]
    next_cursor = None
    if more:
        last = selected[-1]
        next_cursor = _encode_cursor(
            _Cursor(
                version=1,
                case_id=str(saved.case_id),
                case_revision=saved.revision,
                scope=scope,
                dataset=dataset,
                after_time=last.recorded_at,
                after_event=last.event_id,
            )
        )
    return StudentCaseTimeline(
        case_id=saved.case_id,
        case_revision=saved.revision,
        case_label=saved.label,
        archived=saved.archived,
        source_states=source_states,
        counts=counts,
        events=selected,
        next_cursor=next_cursor,
        generated_at=time.time(),
    )


__all__ = [
    "StudentCaseStore",
    "CaseNotFound",
    "CaseConflict",
    "CaseSourceConflict",
    "CaseValidationError",
    "get_student_case_store",
]
