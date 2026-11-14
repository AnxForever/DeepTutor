"""Transactional hint receipts and pure final-response normalization.

Only issued teacher text is revealed. This module makes no model calls and
never writes task lifecycle, answer progress, grading or assessment records.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import sqlite3
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from .learner_task_models import (
    IssueTaskRequest,
    RevealTaskHintRequest,
    StudentSubmission,
    SubmitTaskRequest,
    TaskHintsQuestion,
    TaskHintsState,
    TaskHintUsage,
    TaskHintUse,
    TaskQuestionHints,
    TaskResponse,
    TaskRevealedHint,
)


class HintConflict(ValueError):
    """A request id or the independent hint revision has changed."""


class HintUnavailable(ValueError):
    """This question has no further teacher-authored hint."""


def _canonical(value: Any) -> str:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    )


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def normalize_hint_assistance(
    responses: list[TaskResponse],
    usage: list[TaskHintUsage] | None,
    *,
    has_hint_plan: bool = False,
) -> list[TaskResponse]:
    """Preserve original work/status while applying known server help usage.

    None is a legacy unrecorded receipt. An empty list records no unlocks.
    This is also used by the SQLite list guard: it performs no I/O.
    """
    if usage is None:
        if has_hint_plan:
            raise ValueError("A task issued with hints must record final hint usage.")
        return responses
    validated = [TaskHintUsage.model_validate(item) for item in usage]
    ids = [item.question_id for item in validated]
    response_ids = [response.question_id for response in responses]
    if len(ids) != len(set(ids)) or not set(ids).issubset(response_ids):
        raise ValueError("Hint usage does not match the submission questions.")
    used = set(ids)
    return [
        response.model_copy(update={"assistance": "assisted"})
        if response.question_id in used
        else response
        for response in responses
    ]


def submission_matches_request(submission_json: Any, request_json: Any, issue_json: Any) -> int:
    """SQLite predicate, sharing exactly the final receipt normalization."""
    try:
        submission = StudentSubmission.model_validate_json(submission_json)
        request = SubmitTaskRequest.model_validate_json(request_json)
        issue_request = IssueTaskRequest.model_validate(json.loads(issue_json)["request"])
        return int(
            submission.submission_id == request.submission_id
            and submission.responses
            == normalize_hint_assistance(
                request.responses,
                submission.hint_usage,
                has_hint_plan=bool(issue_request.question_hints),
            )
        )
    except (ValueError, TypeError, UnicodeError, KeyError):
        return 0


class _HintRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", revalidate_instances="always")


class _Header(_HintRecord):
    task_id: UUID
    recipient_user_id: str
    hint_revision: int = Field(ge=0, le=9, strict=True)
    events_digest: str = Field(pattern=r"^[0-9a-f]{64}$", strict=True)


class _Event(_HintRecord):
    task_id: UUID
    recipient_user_id: str
    hint_revision: int = Field(ge=1, le=9, strict=True)
    question_id: str
    level: int = Field(ge=1, le=3, strict=True)
    request: RevealTaskHintRequest
    hint_sha256: str = Field(pattern=r"^[0-9a-f]{64}$", strict=True)
    revealed_at: float = Field(ge=0, allow_inf_nan=False, strict=True)


@dataclass(frozen=True)
class HintLedger:
    state: TaskHintsState
    usage: list[TaskHintUsage]
    events: list[_Event]
    initialized: bool


def create_hint_schema(connection: sqlite3.Connection) -> None:
    # Called only on the existing explicit task-create path. A GET, autosave,
    # submit or hint read never migrates a legacy database.
    connection.executescript("""
        CREATE TABLE IF NOT EXISTS student_task_hint_states (
            task_id TEXT PRIMARY KEY REFERENCES issued_student_tasks(task_id),
            recipient_user_id TEXT NOT NULL,hint_revision INTEGER NOT NULL CHECK(hint_revision BETWEEN 0 AND 9),
            state_hash TEXT NOT NULL,state_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS student_task_hint_events (
            task_id TEXT NOT NULL REFERENCES issued_student_tasks(task_id),
            hint_revision INTEGER NOT NULL CHECK(hint_revision BETWEEN 1 AND 9),
            recipient_user_id TEXT NOT NULL,question_id TEXT NOT NULL,
            level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 3),request_id TEXT NOT NULL,
            request_hash TEXT NOT NULL,event_hash TEXT NOT NULL,event_json TEXT NOT NULL,
            revealed_at REAL NOT NULL,
            PRIMARY KEY(task_id,hint_revision),UNIQUE(task_id,question_id,level),UNIQUE(task_id,request_id)
        );
    """)


def _put_header(
    connection: sqlite3.Connection,
    task_id: str,
    recipient: str,
    events: list[_Event],
    *,
    create: bool,
) -> None:
    header = _Header(
        task_id=task_id,
        recipient_user_id=recipient,
        hint_revision=len(events),
        events_digest=_digest([event.model_dump(mode="json") for event in events]),
    )
    raw = header.model_dump(mode="json")
    if create:
        connection.execute(
            "INSERT INTO student_task_hint_states VALUES(?,?,?,?,?)",
            (task_id, recipient, len(events), _digest(raw), _canonical(raw)),
        )
    else:
        connection.execute(
            "UPDATE student_task_hint_states SET hint_revision=?,state_hash=?,state_json=? WHERE task_id=? AND recipient_user_id=?",
            (len(events), _digest(raw), _canonical(raw), task_id, recipient),
        )


def initialize_hints(connection: sqlite3.Connection, task_id: str, recipient: str) -> None:
    _put_header(connection, task_id, recipient, [], create=True)


def _checked(row: sqlite3.Row, content: str, checksum: str) -> dict:
    raw = json.loads(row[content])
    if not isinstance(raw, dict) or _digest(raw) != row[checksum]:
        raise ValueError("Stored hint content does not match its receipt.")
    return raw


def _request_intent(task_id: str, recipient: str, request: RevealTaskHintRequest) -> dict:
    return {
        "task_id": task_id,
        "recipient_user_id": recipient,
        "request": request.model_dump(mode="json"),
    }


def read_hints(
    connection: sqlite3.Connection,
    task_id: str,
    recipient: str,
    question_ids: list[str],
    plans: list[TaskQuestionHints],
    issued_at: float,
) -> HintLedger:
    plan_by_id = {plan.question_id: plan.hints for plan in plans}
    if len(plan_by_id) != len(plans) or not set(plan_by_id).issubset(question_ids):
        raise ValueError("Stored hint plans do not match the issued questions.")
    tables = {
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('student_task_hint_states','student_task_hint_events')"
        )
    }
    if len(tables) == 1 or (not tables and plans):
        raise ValueError("Stored hint receipts are missing.")
    header = None
    rows: list[sqlite3.Row] = []
    if tables:
        header = connection.execute(
            "SELECT * FROM student_task_hint_states WHERE task_id=?", (task_id,)
        ).fetchone()
        rows = connection.execute(
            "SELECT * FROM student_task_hint_events WHERE task_id=? ORDER BY hint_revision",
            (task_id,),
        ).fetchall()
    if header is None and (rows or plans):
        raise ValueError("Stored hint state is missing.")
    events: list[_Event] = []
    by_question: dict[str, list[TaskRevealedHint]] = {qid: [] for qid in question_ids}
    previous_time = issued_at
    for row in rows:
        event = _Event.model_validate(_checked(row, "event_json", "event_hash"))
        prior = by_question.get(event.question_id)
        plan = plan_by_id.get(event.question_id, [])
        if (
            str(event.task_id) != task_id
            or event.recipient_user_id != recipient
            or event.hint_revision != len(events) + 1
            or row["task_id"] != task_id
            or row["recipient_user_id"] != recipient
            or row["hint_revision"] != event.hint_revision
            or row["question_id"] != event.question_id
            or row["level"] != event.level
            or row["revealed_at"] != event.revealed_at
            or row["request_id"] != str(event.request.request_id)
            or row["request_hash"] != _digest(_request_intent(task_id, recipient, event.request))
            or event.request.question_id != event.question_id
            or event.request.expected_hint_revision != event.hint_revision - 1
            or prior is None
            or event.level != len(prior) + 1
            or event.level > len(plan)
            or event.revealed_at < previous_time
        ):
            raise ValueError("Hint event does not match its identity or ordered receipt.")
        text = plan[event.level - 1]
        if event.hint_sha256 != hashlib.sha256(text.encode("utf-8")).hexdigest():
            raise ValueError("Hint event does not match the frozen teacher text.")
        prior.append(TaskRevealedHint(level=event.level, text=text, revealed_at=event.revealed_at))
        events.append(event)
        previous_time = event.revealed_at
    if header is not None:
        parsed = _Header.model_validate(_checked(header, "state_json", "state_hash"))
        if (
            str(parsed.task_id) != task_id
            or parsed.recipient_user_id != recipient
            or header["recipient_user_id"] != recipient
            or header["hint_revision"] != parsed.hint_revision
            or parsed.hint_revision != len(events)
            or parsed.events_digest != _digest([event.model_dump(mode="json") for event in events])
        ):
            raise ValueError("Hint state does not match its immutable event receipts.")
    state = TaskHintsState(
        task_id=task_id,
        hint_revision=len(events),
        questions=[
            TaskHintsQuestion(
                question_id=qid, total=len(plan_by_id.get(qid, [])), revealed=by_question[qid]
            )
            for qid in question_ids
        ],
    )
    usage = [
        TaskHintUsage(
            question_id=qid,
            revealed=[
                TaskHintUse(level=h.level, revealed_at=h.revealed_at) for h in by_question[qid]
            ],
        )
        for qid in question_ids
        if by_question[qid]
    ]
    return HintLedger(state, usage, events, header is not None)


def reveal_hint(
    connection: sqlite3.Connection,
    task_id: str,
    recipient: str,
    question_ids: list[str],
    plans: list[TaskQuestionHints],
    issued_at: float,
    ledger: HintLedger,
    request: RevealTaskHintRequest,
    now: float,
) -> TaskHintsState:
    for event in ledger.events:
        if event.request.request_id == request.request_id:
            if event.request != request:
                raise HintConflict("This hint request id was already used for different content.")
            return ledger.state
    if request.expected_hint_revision != ledger.state.hint_revision:
        raise HintConflict("The opened hints changed. Reload before asking for another step.")
    plan = next((plan.hints for plan in plans if plan.question_id == request.question_id), [])
    opened = next(
        (
            question.revealed
            for question in ledger.state.questions
            if question.question_id == request.question_id
        ),
        [],
    )
    if not plan or len(opened) >= len(plan):
        raise HintUnavailable("This question has no further teacher-provided hint.")
    if not ledger.initialized:
        raise ValueError("A task with hints must have an initialized hint state.")
    level = len(opened) + 1
    event = _Event(
        task_id=task_id,
        recipient_user_id=recipient,
        hint_revision=ledger.state.hint_revision + 1,
        question_id=request.question_id,
        level=level,
        request=request,
        hint_sha256=hashlib.sha256(plan[level - 1].encode("utf-8")).hexdigest(),
        revealed_at=max(now, ledger.events[-1].revealed_at if ledger.events else issued_at),
    )
    raw = event.model_dump(mode="json")
    connection.execute(
        "INSERT INTO student_task_hint_events VALUES(?,?,?,?,?,?,?,?,?,?)",
        (
            task_id,
            event.hint_revision,
            recipient,
            event.question_id,
            level,
            str(request.request_id),
            _digest(_request_intent(task_id, recipient, request)),
            _digest(raw),
            _canonical(raw),
            event.revealed_at,
        ),
    )
    _put_header(connection, task_id, recipient, [*ledger.events, event], create=False)
    return read_hints(connection, task_id, recipient, question_ids, plans, issued_at).state


__all__ = ["normalize_hint_assistance", "submission_matches_request"]
