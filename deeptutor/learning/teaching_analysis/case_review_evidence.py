"""Workspace-local, versioned links to confirmed formal task reviews.

Case/report source locks precede the central task read lock. A write never
changes a P3 case revision, report, attempt, learner response or assessment.
"""

from __future__ import annotations

from collections import defaultdict
from contextlib import contextmanager
import hashlib
import json
import logging
from pathlib import Path
import sqlite3
import time
from typing import Any, Iterator
from uuid import UUID

from pydantic import ValidationError

from deeptutor.utils.secret_files import ensure_private_file

from .case_models import SavedStudentCase
from .case_review_models import (
    CaseReviewEvidenceLink,
    CaseReviewEvidenceSourceState,
    CaseReviewEvidenceView,
    CaseReviewFocusCard,
    CaseReviewQuestionEvidence,
    SaveCaseReviewEvidence,
    SavedCaseReviewEvidence,
)
from .case_storage import (
    CaseConflict,
    CaseNotFound,
    CaseSourceConflict,
    CaseValidationError,
    StudentCaseStore,
    _case_id,
)
from .cases import _validated_report
from .learner_task_models import TaskRevealedHint
from .learner_task_reviews import ReviewProjection, TaskReviewStore, get_task_review_store
from .storage import TeachingAnalysisStore

logger = logging.getLogger(__name__)
_TABLES = {
    "case_review_evidence_heads",
    "case_review_evidence_revisions",
    "case_review_evidence_receipts",
}


def _canonical(value: Any) -> str:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    )


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _identifier(value: str, limit: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise CaseValidationError("A valid authenticated evidence scope and actor are required.")
    try:
        value.encode("utf-8")
    except UnicodeError:
        raise CaseValidationError("Evidence identifiers must be valid Unicode.") from None
    return value


def _intent(case_id: str, scope: str, request: SaveCaseReviewEvidence) -> dict:
    return {
        "case_id": case_id,
        "teacher_scope_key": scope,
        "request": request.model_dump(mode="json"),
    }


def _schema(connection: sqlite3.Connection) -> None:
    # execute(), not executescript(): the latter implicitly commits and would
    # release the case lock before central source validation has finished.
    connection.execute("""CREATE TABLE IF NOT EXISTS case_review_evidence_heads (
        case_id TEXT NOT NULL,teacher_scope_key TEXT NOT NULL,revision INTEGER NOT NULL,
        head_json TEXT NOT NULL,head_hash TEXT NOT NULL,
        PRIMARY KEY(case_id,teacher_scope_key))""")
    connection.execute("""CREATE TABLE IF NOT EXISTS case_review_evidence_revisions (
        case_id TEXT NOT NULL,teacher_scope_key TEXT NOT NULL,revision INTEGER NOT NULL,
        request_id TEXT NOT NULL,actor_user_id TEXT NOT NULL,recorded_at REAL NOT NULL,
        content_json TEXT NOT NULL,content_hash TEXT NOT NULL,
        PRIMARY KEY(case_id,teacher_scope_key,revision),
        UNIQUE(case_id,teacher_scope_key,request_id))""")
    connection.execute("""CREATE TABLE IF NOT EXISTS case_review_evidence_receipts (
        case_id TEXT NOT NULL,teacher_scope_key TEXT NOT NULL,request_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,request_json TEXT NOT NULL,overlay_revision INTEGER NOT NULL,
        PRIMARY KEY(case_id,teacher_scope_key,request_id))""")


def _checked(value: str, checksum: str) -> dict:
    raw = json.loads(value)
    if not isinstance(raw, dict) or _digest(raw) != checksum:
        raise ValueError("Stored case-review evidence does not match its receipt.")
    return raw


class CaseReviewEvidenceStore:
    def __init__(
        self, root: Path | None = None, *, review_store: TaskReviewStore | None = None
    ) -> None:
        self.cases = StudentCaseStore(root)
        self.root = self.cases.root
        self.db_path = self.cases.db_path
        self.reviews = review_store if review_store is not None else get_task_review_store()

    @staticmethod
    def _case(connection: sqlite3.Connection | None, case_id: str) -> SavedStudentCase:
        if connection is None:
            raise CaseNotFound("Student case not found in this workspace.")
        row = connection.execute(
            "SELECT * FROM student_case_revisions WHERE case_id=? ORDER BY revision DESC LIMIT 1",
            (case_id,),
        ).fetchone()
        if row is None:
            raise CaseNotFound("Student case not found in this workspace.")
        return StudentCaseStore._content(row)

    @staticmethod
    def _history(
        connection: sqlite3.Connection, case: SavedStudentCase, scope: str
    ) -> tuple[list[SavedCaseReviewEvidence], dict[str, tuple[dict, SavedCaseReviewEvidence]]]:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name IN (?,?,?)",
                tuple(sorted(_TABLES)),
            )
        }
        if not tables:
            return [], {}
        if tables != _TABLES:
            raise ValueError("Case-review evidence storage is incomplete.")
        case_id = str(case.case_id)
        head = connection.execute(
            "SELECT * FROM case_review_evidence_heads WHERE case_id=? AND teacher_scope_key=?",
            (case_id, scope),
        ).fetchone()
        rows = connection.execute(
            "SELECT * FROM case_review_evidence_revisions WHERE case_id=? AND teacher_scope_key=? ORDER BY revision",
            (case_id, scope),
        ).fetchall()
        receipts = connection.execute(
            "SELECT * FROM case_review_evidence_receipts WHERE case_id=? AND teacher_scope_key=?",
            (case_id, scope),
        ).fetchall()
        if head is None:
            if rows or receipts:
                raise ValueError("Case-review evidence is missing its head receipt.")
            return [], {}
        by_revision = {row["overlay_revision"]: row for row in receipts}
        if len(by_revision) != len(receipts) or len(receipts) != len(rows):
            raise ValueError("Case-review evidence receipts are inconsistent.")
        saved_versions: list[SavedCaseReviewEvidence] = []
        by_request = {}
        history = []
        previous_time = 0.0
        for row in rows:
            raw = _checked(row["content_json"], row["content_hash"])
            saved = SavedCaseReviewEvidence.model_validate(raw)
            receipt = by_revision.get(saved.revision)
            if receipt is None:
                raise ValueError("Case-review evidence has no matching request receipt.")
            request_raw = json.loads(receipt["request_json"])
            request = SaveCaseReviewEvidence.model_validate(request_raw)
            if (
                row["case_id"] != case_id
                or row["teacher_scope_key"] != scope
                or str(saved.case_id) != case_id
                or saved.revision != len(saved_versions) + 1
                or row["revision"] != saved.revision
                or row["request_id"] != str(saved.request_id)
                or row["actor_user_id"] != saved.actor_user_id
                or row["recorded_at"] != saved.recorded_at
                or saved.recorded_at < previous_time
                or saved.case_revision > case.revision
                or receipt["case_id"] != case_id
                or receipt["teacher_scope_key"] != scope
                or receipt["request_id"] != str(request.request_id)
                or request.request_id != saved.request_id
                or request.expected_revision != saved.revision - 1
                or request.expected_case_revision != saved.case_revision
                or request.links != saved.links
                or request.identity_confirmed != saved.identity_confirmed
                or _digest(_intent(case_id, scope, request)) != receipt["request_hash"]
            ):
                raise ValueError("Case-review evidence identity or version is inconsistent.")
            saved_versions.append(saved)
            by_request[str(saved.request_id)] = (request_raw, saved)
            history.append([saved.revision, row["content_hash"], receipt["request_hash"]])
            previous_time = saved.recorded_at
        raw_head = _checked(head["head_json"], head["head_hash"])
        expected = {
            "case_id": case_id,
            "teacher_scope_key": scope,
            "revision": len(saved_versions),
            "history_digest": _digest(history),
        }
        if (
            not saved_versions
            or type(raw_head.get("revision")) is not int
            or head["revision"] != len(saved_versions)
            or raw_head != expected
        ):
            raise ValueError("Case-review evidence history does not match its head receipt.")
        return saved_versions, by_request

    @contextmanager
    def _sources(
        self, scope: str, links: list[CaseReviewEvidenceLink]
    ) -> Iterator[tuple[sqlite3.Connection | None, dict[tuple[str, int], ReviewProjection]]]:
        # Lock order: case (caller) -> report source -> central tasks/reviews.
        with TeachingAnalysisStore(self.root)._connection() as reports:
            if reports is not None:
                reports.execute("BEGIN")
                reports.execute("SELECT 1 FROM teaching_report_revisions LIMIT 1").fetchone()
            with self.reviews.read_connection() as central:
                projections = self.reviews.project_refs(
                    scope,
                    [(str(link.task_id), link.review_revision) for link in links],
                    connection=central,
                )
                yield reports, projections

    @staticmethod
    def _report_matches(
        connection: sqlite3.Connection | None, pair: tuple[str, int], fingerprint: str
    ) -> bool:
        if connection is None:
            return False
        row = connection.execute(
            "SELECT report_id,revision,updated_at,content_json FROM teaching_report_revisions WHERE report_id=? AND revision=?",
            pair,
        ).fetchone()
        if row is None:
            return False
        report = json.loads(row["content_json"])
        if (
            not isinstance(report, dict)
            or report.get("report_id") != row["report_id"]
            or type(report.get("revision")) is not int
            or report["revision"] != row["revision"]
            or report.get("updated_at") != row["updated_at"]
        ):
            raise ValueError("Pinned report identity is inconsistent.")
        report = _validated_report(report, pair)
        return report["status"] == "confirmed" and report["source_fingerprint"] == fingerprint

    @classmethod
    def _state(
        cls,
        case: SavedStudentCase,
        link: CaseReviewEvidenceLink,
        projection: ReviewProjection | None,
        reports: sqlite3.Connection | None,
        bound_recipient: str | None,
    ) -> CaseReviewEvidenceSourceState:
        base = {
            "task_id": link.task_id,
            "submission_id": link.submission_id,
            "review_revision": link.review_revision,
            "status": "unavailable",
            "recipient_user_id": bound_recipient,
        }
        if projection is None or any(
            value is None
            for value in (projection.review, projection.latest_review, projection.task)
        ):
            return CaseReviewEvidenceSourceState.model_validate(base)
        review, latest, task = projection.review, projection.latest_review, projection.task
        if review is None or latest is None or task is None or task.submission is None:
            return CaseReviewEvidenceSourceState.model_validate(base)
        submission = task.submission
        source = task.source_snapshot
        if (
            task.task_id != link.task_id
            or review.task_id != link.task_id
            or latest.task_id != link.task_id
            or submission.submission_id != link.submission_id
            or review.submission_id != link.submission_id
            or latest.submission_id != link.submission_id
            or review.revision != link.review_revision
            or review.recipient_user_id != task.recipient_user_id
            or latest.recipient_user_id != task.recipient_user_id
            or (bound_recipient is not None and task.recipient_user_id != bound_recipient)
            or review.report_id != source.report_id
            or review.report_revision != source.report_revision
            or review.followup_id != source.followup_id
            or review.followup_revision != source.revision
            or review.subject != source.subject
            or review.knowledge_point != source.knowledge_point
        ):
            return CaseReviewEvidenceSourceState.model_validate(base)
        questions = {question.question_id: question for question in source.questions}
        responses = {response.question_id: response for response in submission.responses}
        items = {item.question_id: item for item in review.items}
        if any(
            qid not in questions or qid not in responses or qid not in items
            for qid in link.question_ids
        ):
            return CaseReviewEvidenceSourceState.model_validate(base)
        usage = {entry.question_id: entry.revealed for entry in submission.hint_usage or []}
        plans = {plan.question_id: plan.hints for plan in task.question_hints}
        selected = []
        for qid in link.question_ids:
            response = responses[qid]
            used = None
            if submission.hint_usage is not None:
                used = []
                for hint in usage.get(qid, []):
                    plan = plans.get(qid, [])
                    if hint.level > len(plan):
                        raise ValueError("Frozen hint usage does not match the issued plan.")
                    used.append(
                        TaskRevealedHint(
                            level=hint.level,
                            revealed_at=hint.revealed_at,
                            text=plan[hint.level - 1],
                        )
                    )
            selected.append(
                CaseReviewQuestionEvidence(
                    question_id=qid,
                    question=questions[qid].question,
                    answer=response.answer,
                    response_status=response.response_status,
                    assistance=response.assistance,
                    result=items[qid].result,
                    feedback=items[qid].feedback,
                    hint_usage=used,
                )
            )
        pair = (str(source.report_id), source.report_revision)
        pins = {(str(ref.report_id), ref.report_revision) for ref in case.report_refs}
        # One fixed precedence; all non-current states stay out of focus cards.
        status = (
            "withdrawn"
            if review.status == "withdrawn" or latest.status == "withdrawn"
            else "task_revoked"
            if task.status == "revoked"
            else "report_unlinked"
            if pair not in pins
            else "unavailable"
            if not cls._report_matches(reports, pair, source.source_fingerprint)
            else "stale"
            if latest.revision != review.revision
            else "current"
        )
        return CaseReviewEvidenceSourceState(
            task_id=link.task_id,
            submission_id=link.submission_id,
            review_revision=link.review_revision,
            status=status,
            latest_review_revision=latest.revision,
            review_status=review.status,
            latest_review_status=latest.status,
            latest_recorded_at=latest.recorded_at,
            recipient_user_id=task.recipient_user_id,
            subject=source.subject,
            knowledge_point=source.knowledge_point,
            report_id=source.report_id,
            report_revision=source.report_revision,
            reviewer_user_id=review.reviewer_user_id,
            recorded_at=review.recorded_at,
            questions=selected,
        )

    @staticmethod
    def _cards(states: list[CaseReviewEvidenceSourceState]) -> list[CaseReviewFocusCard]:
        counts: dict[tuple[str, str], dict[str, int]] = defaultdict(
            lambda: dict(
                question_count=0,
                needs_teaching=0,
                needs_independent_check=0,
                ungraded=0,
                independent_correct=0,
                requested_help=0,
            )
        )
        seen = set()
        for state in states:
            if state.status != "current":
                continue
            key = (state.subject or "", state.knowledge_point or "")
            for question in state.questions:
                unique = (str(state.submission_id), question.question_id)
                if unique in seen:
                    continue
                seen.add(unique)
                bucket = counts[key]
                bucket["question_count"] += 1
                bucket["requested_help"] += int(question.response_status == "needs_help")
                category = (
                    "needs_teaching"
                    if question.result in {"partial", "incorrect"}
                    else "ungraded"
                    if question.result == "ungraded"
                    else "independent_correct"
                    if question.assistance == "independent"
                    else "needs_independent_check"
                )
                bucket[category] += 1
        return [
            CaseReviewFocusCard(subject=key[0], knowledge_point=key[1], **counts[key])
            for key in sorted(counts)
        ]

    @classmethod
    def _view(
        cls,
        case: SavedStudentCase,
        overlay: SavedCaseReviewEvidence | None,
        states: list[CaseReviewEvidenceSourceState],
        acknowledged: SavedCaseReviewEvidence | None = None,
    ) -> CaseReviewEvidenceView:
        return CaseReviewEvidenceView(
            case_id=case.case_id,
            case_revision=case.revision,
            case_archived=case.archived,
            overlay=overlay,
            acknowledged=acknowledged,
            source_states=states,
            focus_cards=cls._cards(states),
        )

    def _read_view(
        self,
        case: SavedStudentCase,
        scope: str,
        overlay: SavedCaseReviewEvidence | None,
        acknowledged: SavedCaseReviewEvidence | None = None,
    ) -> CaseReviewEvidenceView:
        if overlay is None or not overlay.links:
            return self._view(case, overlay, [], acknowledged)
        try:
            with self._sources(scope, overlay.links) as (reports, projections):
                states = [
                    self._state(
                        case,
                        link,
                        projections.get((str(link.task_id), link.review_revision)),
                        reports,
                        overlay.recipient_user_id,
                    )
                    for link in overlay.links
                ]
        except Exception as exc:
            # No source failure may fabricate a grade or prevent removing a
            # mistaken link. The healthy case/overlay history was checked first.
            logger.warning("Case-review evidence sources unavailable (%s)", type(exc).__name__)
            states = [
                CaseReviewEvidenceSourceState(
                    task_id=link.task_id,
                    submission_id=link.submission_id,
                    review_revision=link.review_revision,
                    status="unavailable",
                    recipient_user_id=overlay.recipient_user_id,
                )
                for link in overlay.links
            ]
        return self._view(case, overlay, states, acknowledged)

    def get_evidence(self, case_id: str | UUID, teacher_scope_key: str) -> CaseReviewEvidenceView:
        identifier, scope = _case_id(case_id), _identifier(teacher_scope_key, 512)
        with self.cases._connection() as connection:
            if connection is not None:
                connection.execute("BEGIN")
            case = self._case(connection, identifier)
            if connection is None:
                raise CaseNotFound("Student case not found in this workspace.")
            versions, _ = self._history(connection, case, scope)
            return self._read_view(case, scope, versions[-1] if versions else None)

    @staticmethod
    def _write(
        connection: sqlite3.Connection,
        case: SavedStudentCase,
        scope: str,
        actor: str,
        request: SaveCaseReviewEvidence,
        versions: list[SavedCaseReviewEvidence],
        recipient: str | None,
    ) -> SavedCaseReviewEvidence:
        now = max(time.time(), case.updated_at, versions[-1].recorded_at if versions else 0.0)
        saved = SavedCaseReviewEvidence(
            case_id=case.case_id,
            revision=len(versions) + 1,
            case_revision=case.revision,
            request_id=request.request_id,
            actor_user_id=actor,
            recipient_user_id=recipient,
            recorded_at=now,
            identity_confirmed=True,
            links=request.links,
        )
        _schema(connection)
        raw = saved.model_dump(mode="json")
        case_id = str(case.case_id)
        connection.execute(
            "INSERT INTO case_review_evidence_revisions VALUES(?,?,?,?,?,?,?,?)",
            (
                case_id,
                scope,
                saved.revision,
                str(saved.request_id),
                actor,
                now,
                _canonical(raw),
                _digest(raw),
            ),
        )
        connection.execute(
            "INSERT INTO case_review_evidence_receipts VALUES(?,?,?,?,?,?)",
            (
                case_id,
                scope,
                str(request.request_id),
                _digest(_intent(case_id, scope, request)),
                _canonical(request.model_dump(mode="json")),
                saved.revision,
            ),
        )
        history = [
            list(row)
            for row in connection.execute(
                "SELECT r.revision,r.content_hash,u.request_hash FROM case_review_evidence_revisions r JOIN case_review_evidence_receipts u ON u.case_id=r.case_id AND u.teacher_scope_key=r.teacher_scope_key AND u.overlay_revision=r.revision WHERE r.case_id=? AND r.teacher_scope_key=? ORDER BY r.revision",
                (case_id, scope),
            )
        ]
        header = {
            "case_id": case_id,
            "teacher_scope_key": scope,
            "revision": saved.revision,
            "history_digest": _digest(history),
        }
        connection.execute(
            "INSERT INTO case_review_evidence_heads VALUES(?,?,?,?,?) ON CONFLICT(case_id,teacher_scope_key) DO UPDATE SET revision=excluded.revision,head_json=excluded.head_json,head_hash=excluded.head_hash",
            (case_id, scope, saved.revision, _canonical(header), _digest(header)),
        )
        return saved

    def save_evidence(
        self,
        case_id: str | UUID,
        teacher_scope_key: str,
        actor_user_id: str,
        payload: SaveCaseReviewEvidence,
    ) -> CaseReviewEvidenceView:
        identifier = _case_id(case_id)
        scope, actor = _identifier(teacher_scope_key, 512), _identifier(actor_user_id, 64)
        try:
            request = SaveCaseReviewEvidence.model_validate(payload)
        except ValidationError:
            raise CaseValidationError(
                "Review the selected formal evidence and identity confirmation."
            ) from None
        with self.cases._connection() as connection:
            if connection is None:
                raise CaseNotFound("Student case not found in this workspace.")
            connection.execute("BEGIN IMMEDIATE")
            try:
                case = self._case(connection, identifier)
                versions, receipts = self._history(connection, case, scope)
                previous = versions[-1] if versions else None
                receipt = receipts.get(str(request.request_id))
                if receipt is not None:
                    if SaveCaseReviewEvidence.model_validate(receipt[0]) != request:
                        raise CaseConflict(
                            "This evidence request id was used for different content."
                        )
                    connection.commit()
                    return self._read_view(case, scope, previous, receipt[1])
                if (
                    request.expected_revision != len(versions)
                    or request.expected_case_revision != case.revision
                ):
                    raise CaseConflict("The case or linked evidence changed. Reload before saving.")
                retained = {link.submission_id: link for link in previous.links} if previous else {}
                changed = [
                    link for link in request.links if retained.get(link.submission_id) != link
                ]
                if not changed:
                    recipient = previous.recipient_user_id if previous and request.links else None
                    self.cases._assert_paths()
                    ensure_private_file(self.db_path)
                    saved = self._write(
                        connection, case, scope, actor, request, versions, recipient
                    )
                    connection.commit()
                    return self._read_view(case, scope, saved, saved)
                if case.archived:
                    raise CaseConflict(
                        "An archived case only permits removing existing evidence links."
                    )
                # Sources stay locked until the case transaction commits.
                with self._sources(scope, request.links) as (reports, projections):
                    states = [
                        self._state(
                            case,
                            link,
                            projections.get((str(link.task_id), link.review_revision)),
                            reports,
                            None,
                        )
                        for link in request.links
                    ]
                    by_submission = {state.submission_id: state for state in states}
                    for link in changed:
                        if by_submission[link.submission_id].status != "current":
                            raise CaseSourceConflict(
                                "Select a current confirmed review from this case's pinned source."
                            )
                    recipient = previous.recipient_user_id if previous and previous.links else None
                    for link in changed:
                        current_recipient = by_submission[link.submission_id].recipient_user_id
                        if current_recipient is None:
                            raise CaseSourceConflict("The formal submission is unavailable.")
                        if recipient is None:
                            recipient = current_recipient
                        elif recipient != current_recipient:
                            raise CaseConflict(
                                "Clear the existing links before confirming a different learner."
                            )
                    if any(
                        state.recipient_user_id is not None and state.recipient_user_id != recipient
                        for state in states
                    ):
                        raise CaseConflict(
                            "All evidence links in one case must refer to the same learner."
                        )
                    self.cases._assert_paths()
                    ensure_private_file(self.db_path)
                    saved = self._write(
                        connection, case, scope, actor, request, versions, recipient
                    )
                    connection.commit()
                    return self._view(case, saved, states, saved)
            except BaseException:
                connection.rollback()
                raise

    def revisions(
        self, case_id: str | UUID, teacher_scope_key: str, *, limit: int = 100
    ) -> list[SavedCaseReviewEvidence]:
        identifier, scope = _case_id(case_id), _identifier(teacher_scope_key, 512)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise CaseValidationError("Use a history limit from one to one hundred.")
        with self.cases._connection() as connection:
            if connection is not None:
                connection.execute("BEGIN")
            case = self._case(connection, identifier)
            if connection is None:
                raise CaseNotFound("Student case not found in this workspace.")
            versions, _ = self._history(connection, case, scope)
            return list(reversed(versions[-limit:]))


__all__ = ["CaseReviewEvidenceStore"]
