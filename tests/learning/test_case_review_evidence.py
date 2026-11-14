"""Formal case evidence is explicit, scoped, pinned and independently versioned."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import hashlib
import json
import sqlite3
from threading import Event
from types import SimpleNamespace
from uuid import uuid4

from pydantic import ValidationError
import pytest

from deeptutor.learning.teaching_analysis.case_models import SaveStudentCaseRequest
from deeptutor.learning.teaching_analysis.case_review_evidence import CaseReviewEvidenceStore
from deeptutor.learning.teaching_analysis.case_review_models import (
    CaseReviewEvidenceLink,
    SaveCaseReviewEvidence,
)
from deeptutor.learning.teaching_analysis.case_storage import (
    CaseConflict,
    CaseNotFound,
    CaseSourceConflict,
    StudentCaseStore,
)
from deeptutor.learning.teaching_analysis.followup_models import SavedFollowup
from deeptutor.learning.teaching_analysis.learner_task_models import (
    IssueTaskRequest,
    RevealTaskHintRequest,
    RevokeTaskRequest,
    SubmitTaskRequest,
    TaskQuestionHints,
    TaskResponse,
)
from deeptutor.learning.teaching_analysis.learner_task_reviews import TaskReviewStore
from deeptutor.learning.teaching_analysis.learner_tasks import LearnerTaskStore
from deeptutor.learning.teaching_analysis.models import AssignmentInput
from deeptutor.learning.teaching_analysis.service import fingerprint_assignment
from deeptutor.learning.teaching_analysis.storage import TeachingAnalysisStore
from deeptutor.learning.teaching_analysis.task_review_models import (
    SaveTaskReviewRequest,
    TaskReviewItem,
    WithdrawTaskReviewRequest,
)

SCOPE = "synthetic-case-scope:alpha"
ALICE = "u_synthetic_alice"
ACTOR = "u_synthetic_admin"


def report_payload(subject="Math", focus="Addition", note=""):
    assignment = AssignmentInput(
        student_ref="Anonymous label, not an account id",
        assignment_ref="Synthetic worksheet",
        subject=subject,
        items=[
            {
                "question_id": "R1",
                "question": "Calculate 1+1",
                "student_answer": "3",
                "answer_status": "present",
                "transcription_status": "confirmed",
                "assistance": "independent",
            }
        ],
    )
    evidence = [{"question_id": "R1", "field": "student_answer", "quote": "3"}]
    return {
        "assignment": assignment.model_dump(mode="json"),
        "source_fingerprint": fingerprint_assignment(assignment),
        "status": "confirmed",
        "teacher_notes": note,
        "analysis": {
            "summary": "One synthetic calculation is available.",
            "items": [
                {
                    "question_id": "R1",
                    "result": "incorrect",
                    "observation": "The written answer is 3.",
                    "evidence": evidence,
                }
            ],
            "priorities": [
                {
                    "knowledge_point": focus,
                    "observation": "Review this item.",
                    "hypothesis": "An isolated slip is possible.",
                    "alternative_explanation": "No lasting cause is established.",
                    "teaching_action": "Ask for an explanation.",
                    "follow_up_question": "Try another calculation.",
                    "reference_guidance": "Teacher checks the steps.",
                    "evidence_status": "supported",
                    "evidence": evidence,
                }
            ],
            "limitations": ["Synthetic evidence does not establish mastery."],
        },
    }


@pytest.fixture
def environment(tmp_path):
    reports = TeachingAnalysisStore(tmp_path / "workspace")
    report = reports.save_report(str(uuid4()), 0, report_payload())
    cases = StudentCaseStore(reports.root)
    case = cases.save_case(
        SaveStudentCaseRequest(
            case_id=uuid4(),
            expected_revision=0,
            label="匿名档案",
            report_refs=[{"report_id": report["report_id"], "report_revision": 1}],
        )
    )
    tasks = LearnerTaskStore(tmp_path / "central")
    reviews = TaskReviewStore(task_store=tasks)
    overlay = CaseReviewEvidenceStore(reports.root, review_store=reviews)
    env = SimpleNamespace(
        reports=reports,
        report=report,
        cases=cases,
        case=case,
        tasks=tasks,
        reviews=reviews,
        overlay=overlay,
        root=tmp_path,
    )

    def make(
        *,
        recipient=ALICE,
        scope=SCOPE,
        report=None,
        hints=True,
        results=("partial", "correct", "ungraded"),
        submit=True,
    ):
        current_report = report or env.report
        source = SavedFollowup.model_validate(
            {
                "followup_id": str(uuid4()),
                "revision": 1,
                "report_id": current_report["report_id"],
                "report_revision": current_report["revision"],
                "priority_index": 0,
                "title": "Private original practice",
                "student_ref": current_report["assignment"]["student_ref"],
                "assignment_ref": current_report["assignment"]["assignment_ref"],
                "subject": current_report["assignment"]["subject"],
                "grade": "",
                "source_fingerprint": current_report["source_fingerprint"],
                "knowledge_point": current_report["analysis"]["priorities"][0]["knowledge_point"],
                "questions": [
                    {
                        "question_id": f"Q{number}",
                        "question": f"Synthetic question {number}",
                        "reference_answer": "PRIVATE_REFERENCE_71",
                        "rubric": "PRIVATE_RUBRIC_72",
                    }
                    for number in range(1, 4)
                ],
                "created_at": 1.0,
                "updated_at": 1.0,
            }
        )
        issued = IssueTaskRequest(
            task_id=uuid4(),
            followup_id=source.followup_id,
            followup_revision=1,
            recipient_user_id=recipient,
            title="Synthetic task",
            question_hints=[TaskQuestionHints(question_id="Q2", hints=["USED_HINT", "FUTURE_HINT"])]
            if hints
            else [],
        )
        tasks.issue_task(scope, issued, source, issuer_user_id=ACTOR)
        if hints:
            tasks.reveal_task_hint(
                recipient,
                issued.task_id,
                RevealTaskHintRequest(
                    question_id="Q2", request_id=uuid4(), expected_hint_revision=0
                ),
            )
        final = SubmitTaskRequest(
            submission_id=uuid4(),
            expected_revision=0,
            responses=[
                TaskResponse(
                    question_id="Q1",
                    response_status="needs_help",
                    answer="A partial answer remains",
                    assistance="independent",
                ),
                TaskResponse(
                    question_id="Q2",
                    response_status="answered",
                    answer="Synthetic answer",
                    assistance="unknown",
                ),
                TaskResponse(question_id="Q3", response_status="unanswered", assistance="unknown"),
            ],
        )
        if not submit:
            return SimpleNamespace(issued=issued, source=source, final=final)
        tasks.submit_task(recipient, issued.task_id, final)
        request = SaveTaskReviewRequest(
            request_id=uuid4(),
            submission_id=final.submission_id,
            expected_revision=0,
            items=[
                TaskReviewItem(
                    question_id=f"Q{index + 1}",
                    result=result,
                    feedback="Synthetic teacher feedback",
                )
                for index, result in enumerate(results)
            ],
        )
        review = reviews.save_review(scope, issued.task_id, request, reviewer_user_id=ACTOR)
        return SimpleNamespace(
            issued=issued,
            source=source,
            final=final,
            review=review,
            review_request=request,
            scope=scope,
            recipient=recipient,
        )

    env.make = make
    return env


def link(task, **changes):
    return CaseReviewEvidenceLink.model_validate(
        {
            "task_id": str(task.issued.task_id),
            "submission_id": str(task.final.submission_id),
            "review_revision": task.review.revision,
            "question_ids": ["Q1", "Q2", "Q3"],
            **changes,
        }
    )


def request(env, links, *, revision=0, **changes):
    return SaveCaseReviewEvidence.model_validate(
        {
            "request_id": str(uuid4()),
            "expected_revision": revision,
            "expected_case_revision": env.cases.get_case(env.case.case_id).revision,
            "identity_confirmed": True,
            "links": [entry.model_dump(mode="json") for entry in links],
            **changes,
        }
    )


def save(env, payload):
    return env.overlay.save_evidence(env.case.case_id, SCOPE, ACTOR, payload)


def change_case(env, **changes):
    case = env.cases.get_case(env.case.case_id)
    return env.cases.save_case(
        SaveStudentCaseRequest.model_validate(
            case.model_dump(mode="json", exclude={"revision", "created_at", "updated_at"})
            | {"expected_revision": case.revision}
            | changes
        )
    )


def test_get_does_not_migrate_case_or_create_any_overlay_tables(environment):
    env = environment
    before = env.cases.db_path.read_bytes()
    view = env.overlay.get_evidence(env.case.case_id, SCOPE)
    assert view.overlay is None and view.focus_cards == [] and view.source_states == []
    assert env.cases.db_path.read_bytes() == before
    with sqlite3.connect(env.cases.db_path) as connection:
        assert not connection.execute(
            "SELECT 1 FROM sqlite_master WHERE name LIKE 'case_review_evidence_%'"
        ).fetchall()


def test_current_projection_is_selected_positive_evidence_and_factual_focus(environment):
    env = environment
    task = env.make()
    source_before = env.tasks.db_path.read_bytes()
    case_before = env.cases.get_case(env.case.case_id)
    old_timeline = env.cases.timeline(env.case.case_id)
    view = save(env, request(env, [link(task)]))
    assert view.overlay.revision == view.acknowledged.revision == 1
    assert view.overlay.recipient_user_id == ALICE
    assert view.source_states[0].status == "current"
    q1, q2, q3 = view.source_states[0].questions
    assert q1.response_status == "needs_help" and q1.answer == "A partial answer remains"
    assert q1.result == "partial"
    assert q2.assistance == "assisted" and q2.hint_usage[0].text == "USED_HINT"
    assert q3.result == "ungraded" and q3.response_status == "unanswered"
    encoded = view.model_dump_json()
    assert (
        "FUTURE_HINT" not in encoded
        and "PRIVATE_REFERENCE_71" not in encoded
        and "PRIVATE_RUBRIC_72" not in encoded
    )
    assert view.focus_cards[0].model_dump() == {
        "subject": "Math",
        "knowledge_point": "Addition",
        "question_count": 3,
        "needs_teaching": 1,
        "needs_independent_check": 1,
        "ungraded": 1,
        "independent_correct": 0,
        "requested_help": 1,
    }
    assert env.tasks.db_path.read_bytes() == source_before
    assert env.cases.get_case(env.case.case_id) == case_before
    assert len(env.cases.revisions(env.case.case_id)) == 1
    unchanged_timeline = env.cases.timeline(env.case.case_id)
    assert unchanged_timeline.counts == old_timeline.counts
    assert unchanged_timeline.events == old_timeline.events


def test_correction_marks_old_pin_stale_until_teacher_explicitly_updates(environment):
    env = environment
    task = env.make()
    original = request(env, [link(task)])
    save(env, original)
    corrected = env.reviews.save_review(
        SCOPE,
        task.issued.task_id,
        task.review_request.model_copy(
            update={
                "request_id": uuid4(),
                "expected_revision": 1,
                "change_reason": "Corrected teacher evidence",
            }
        ),
        reviewer_user_id=ACTOR,
    )
    stale = env.overlay.get_evidence(env.case.case_id, SCOPE)
    assert stale.source_states[0].status == "stale" and stale.focus_cards == []
    assert stale.overlay.revision == 1 and stale.source_states[0].review_revision == 1
    assert stale.source_states[0].latest_review_revision == 2
    with pytest.raises(CaseSourceConflict):
        save(env, request(env, [link(task, teacher_observation="Old pin edited")], revision=1))
    updated = save(env, request(env, [link(task, review_revision=corrected.revision)], revision=1))
    assert updated.source_states[0].status == "current" and updated.overlay.revision == 2


def test_old_uuid_acknowledges_original_without_rolling_back_clear(environment):
    env = environment
    task = env.make()
    original = request(env, [link(task)])
    save(env, original)
    cleared = save(env, request(env, [], revision=1))
    retry = save(env, original)
    assert retry.overlay == cleared.overlay and retry.overlay.revision == 2
    assert retry.acknowledged.revision == 1 and retry.acknowledged.request_id == original.request_id
    assert retry.source_states == retry.focus_cards == []
    with pytest.raises(CaseConflict):
        save(env, original.model_copy(update={"links": []}))


def test_overlay_cas_and_case_cas_are_independent_and_required(environment):
    env = environment
    task = env.make()
    old = request(env, [link(task)])
    change_case(env, label="Renamed anonymous case")
    with pytest.raises(CaseConflict):
        save(env, old)
    saved = save(env, request(env, [link(task)]))
    assert saved.overlay.revision == 1 and saved.case_revision == 2
    with pytest.raises(CaseConflict):
        save(env, request(env, [], revision=0))


@pytest.mark.parametrize("bad", [None, False, 1, "true"])
def test_identity_confirmation_is_literal_boolean_true(environment, bad):
    env = environment
    with pytest.raises(ValidationError):
        request(env, [], identity_confirmed=bad)


def test_one_submission_has_one_ref_and_question_ids_are_unique(environment):
    env = environment
    task = env.make()
    with pytest.raises(ValidationError):
        request(env, [link(task), link(task, question_ids=["Q1"])])
    with pytest.raises(ValidationError):
        link(task, question_ids=["Q1", "Q1"])
    with pytest.raises(ValidationError):
        link(task, teacher_observation="\ud800")


def test_mixed_learners_and_direct_identity_replacement_require_explicit_clear(environment):
    env = environment
    alice, bob = env.make(), env.make(recipient="u_synthetic_bob")
    with pytest.raises(CaseConflict):
        save(env, request(env, [link(alice), link(bob)]))
    save(env, request(env, [link(alice)]))
    with pytest.raises(CaseConflict):
        save(env, request(env, [link(bob)], revision=1))
    save(env, request(env, [], revision=1))
    rebound = save(env, request(env, [link(bob)], revision=2))
    assert rebound.overlay.recipient_user_id == "u_synthetic_bob"
    assert env.overlay.revisions(env.case.case_id, SCOPE)[-1].recipient_user_id == ALICE


@pytest.mark.parametrize(
    "change", ["wrong_scope", "wrong_submission", "unknown_question", "source_not_pinned"]
)
def test_new_links_validate_actual_scope_receipt_question_and_report_pin(environment, change):
    env = environment
    task = env.make(scope="other-workspace") if change == "wrong_scope" else env.make()
    selected = link(task)
    if change == "wrong_submission":
        selected = link(task, submission_id=str(uuid4()))
    elif change == "unknown_question":
        selected = link(task, question_ids=["not-issued"])
    elif change == "source_not_pinned":
        change_case(env, report_refs=[])
    with pytest.raises(CaseSourceConflict):
        save(env, request(env, [selected]))


def test_newer_report_does_not_replace_an_exact_confirmed_source(environment):
    env = environment
    task = env.make()
    save(env, request(env, [link(task)]))
    env.reports.save_report(
        env.report["report_id"], 1, report_payload(note="A newer report exists")
    )
    assert env.overlay.get_evidence(env.case.case_id, SCOPE).source_states[0].status == "current"


def test_withdrawn_and_revoked_sources_stay_visible_but_leave_current_focus(environment):
    env = environment
    task = env.make()
    save(env, request(env, [link(task)]))
    env.reviews.withdraw_review(
        SCOPE,
        task.issued.task_id,
        WithdrawTaskReviewRequest(
            request_id=uuid4(), expected_revision=1, reason="Incorrect teacher interpretation"
        ),
        reviewer_user_id=ACTOR,
    )
    task_view = env.tasks.get_teacher_task(SCOPE, task.issued.task_id)
    env.tasks.revoke_task(
        SCOPE,
        task.issued.task_id,
        RevokeTaskRequest(
            expected_revision=task_view.task_revision, reason="Withdraw the task too"
        ),
    )
    view = env.overlay.get_evidence(env.case.case_id, SCOPE)
    assert view.source_states[0].status == "withdrawn" and view.focus_cards == []
    assert view.source_states[0].questions[0].result == "partial"
    with pytest.raises(CaseSourceConflict):
        save(env, request(env, [link(task, teacher_observation="Changed annotation")], revision=1))


def test_archived_case_and_unavailable_sources_allow_partial_delete_and_clear(
    environment, monkeypatch
):
    env = environment
    first, second = env.make(), env.make()
    save(env, request(env, [link(first), link(second)]))
    change_case(env, archived=True)

    def unavailable(*_args, **_kwargs):
        raise OSError("private path must not be exposed")

    monkeypatch.setattr(env.reviews, "read_connection", unavailable)
    deleted = save(env, request(env, [link(first)], revision=1))
    assert deleted.overlay.revision == 2 and deleted.source_states[0].status == "unavailable"
    assert deleted.focus_cards == []
    with pytest.raises(CaseConflict):
        save(env, request(env, [link(first, teacher_observation="Not a deletion")], revision=2))
    cleared = save(env, request(env, [], revision=2))
    assert cleared.overlay.recipient_user_id is None and cleared.overlay.links == []
    assert len(env.overlay.revisions(env.case.case_id, SCOPE)) == 3


def test_removed_report_pin_disables_current_evidence_without_deleting_old_pin(environment):
    env = environment
    task = env.make()
    save(env, request(env, [link(task)]))
    change_case(env, report_refs=[])
    view = env.overlay.get_evidence(env.case.case_id, SCOPE)
    assert view.source_states[0].status == "report_unlinked" and view.focus_cards == []
    assert view.overlay.links[0].review_revision == 1
    assert save(env, request(env, [], revision=1)).overlay.links == []


def test_same_named_focus_from_different_subjects_does_not_merge(environment):
    env = environment
    other = env.reports.save_report(str(uuid4()), 0, report_payload(subject="Language"))
    change_case(
        env,
        report_refs=[
            {"report_id": env.report["report_id"], "report_revision": 1},
            {"report_id": other["report_id"], "report_revision": 1},
        ],
    )
    first, second = env.make(), env.make(report=other)
    view = save(
        env, request(env, [link(first, question_ids=["Q1"]), link(second, question_ids=["Q1"])])
    )
    assert [
        (card.subject, card.knowledge_point, card.question_count) for card in view.focus_cards
    ] == [("Language", "Addition", 1), ("Math", "Addition", 1)]


def test_missing_case_and_wrong_workspace_cannot_create_overlay_tables(environment):
    env = environment
    with pytest.raises(CaseNotFound):
        env.overlay.save_evidence(uuid4(), SCOPE, ACTOR, request(env, []))
    other = CaseReviewEvidenceStore(env.root / "other-workspace", review_store=env.reviews)
    with pytest.raises(CaseNotFound):
        other.get_evidence(env.case.case_id, SCOPE)
    assert not other.db_path.exists()


def test_scoped_overlay_queries_do_not_parse_other_scope_private_records(environment):
    env = environment
    task = env.make()
    save(env, request(env, [link(task)]))
    with sqlite3.connect(env.overlay.db_path) as connection:
        connection.execute(
            "UPDATE case_review_evidence_revisions SET content_json='bad-json' WHERE teacher_scope_key=?",
            (SCOPE,),
        )
    assert env.overlay.get_evidence(env.case.case_id, "unrelated-scope").overlay is None
    with pytest.raises(ValueError):
        env.overlay.get_evidence(env.case.case_id, SCOPE)


@pytest.mark.parametrize(
    "table,column",
    [
        ("case_review_evidence_revisions", "content_json"),
        ("case_review_evidence_receipts", "request_json"),
        ("case_review_evidence_heads", "head_json"),
    ],
)
def test_corrupt_own_scope_history_fails_closed(environment, table, column):
    env = environment
    task = env.make()
    save(env, request(env, [link(task)]))
    with sqlite3.connect(env.overlay.db_path) as connection:
        connection.execute(
            f"UPDATE {table} SET {column}='{{}}' WHERE teacher_scope_key=?", (SCOPE,)
        )
    with pytest.raises((ValueError, ValidationError)):
        env.overlay.get_evidence(env.case.case_id, SCOPE)


def test_deleted_tail_version_does_not_restore_old_links(environment):
    env = environment
    task = env.make()
    save(env, request(env, [link(task)]))
    save(env, request(env, [], revision=1))
    with sqlite3.connect(env.overlay.db_path) as connection:
        connection.execute("DELETE FROM case_review_evidence_revisions WHERE revision=2")
        connection.execute("DELETE FROM case_review_evidence_receipts WHERE overlay_revision=2")
    with pytest.raises(ValueError):
        env.overlay.get_evidence(env.case.case_id, SCOPE)


def test_boolean_head_revision_cannot_alias_integer_revision(environment):
    env = environment
    task = env.make()
    save(env, request(env, [link(task)]))
    with sqlite3.connect(env.overlay.db_path) as connection:
        raw = json.loads(
            connection.execute("SELECT head_json FROM case_review_evidence_heads").fetchone()[0]
        )
        raw["revision"] = True
        canonical = json.dumps(
            raw, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
        )
        connection.execute(
            "UPDATE case_review_evidence_heads SET head_json=?,head_hash=?",
            (canonical, hashlib.sha256(canonical.encode()).hexdigest()),
        )
    with pytest.raises(ValueError):
        env.overlay.get_evidence(env.case.case_id, SCOPE)


def test_clear_still_requires_a_readable_owned_base_case(environment):
    env = environment
    task = env.make()
    save(env, request(env, [link(task)]))
    clear = request(env, [], revision=1)
    with sqlite3.connect(env.overlay.db_path) as connection:
        connection.execute("UPDATE student_case_revisions SET content_json='{}'")
    with pytest.raises(ValueError):
        save(env, clear)
    with sqlite3.connect(env.overlay.db_path) as connection:
        assert (
            connection.execute(
                "SELECT MAX(revision) FROM case_review_evidence_revisions"
            ).fetchone()[0]
            == 1
        )


def test_parallel_overlay_cas_has_exactly_one_winner(environment):
    env = environment
    task = env.make()
    save(env, request(env, [link(task)]))
    requests = [
        request(env, [link(task, teacher_observation=str(index))], revision=1) for index in range(2)
    ]

    def execute(payload):
        try:
            return save(env, payload).overlay.revision
        except CaseConflict:
            return "conflict"

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(execute, requests))
    assert sorted(map(str, results)) == ["2", "conflict"]
    assert len(env.overlay.revisions(env.case.case_id, SCOPE)) == 2


def test_only_current_task_revocation_removes_focus_without_erasing_pin(environment):
    env = environment
    task = env.make()
    save(env, request(env, [link(task)]))
    current = env.tasks.get_teacher_task(SCOPE, task.issued.task_id)
    env.tasks.revoke_task(
        SCOPE,
        task.issued.task_id,
        RevokeTaskRequest(
            expected_revision=current.task_revision, reason="Synthetic task withdrawal"
        ),
    )
    view = env.overlay.get_evidence(env.case.case_id, SCOPE)
    assert view.source_states[0].status == "task_revoked" and view.focus_cards == []
    assert view.overlay.links[0].review_revision == 1 and view.source_states[0].questions


def test_missing_central_store_stays_unavailable_and_clear_does_not_create_it(environment):
    env = environment
    task = env.make()
    save(env, request(env, [link(task)]))
    missing_tasks = LearnerTaskStore(env.root / "missing-central")
    env.overlay.reviews = TaskReviewStore(task_store=missing_tasks)
    view = env.overlay.get_evidence(env.case.case_id, SCOPE)
    assert view.source_states[0].status == "unavailable" and view.focus_cards == []
    assert save(env, request(env, [], revision=1)).overlay.links == []
    assert not missing_tasks.db_path.exists()


def test_corrupt_central_head_cannot_revive_focus_or_prevent_removing_links(environment):
    env = environment
    first, second = env.make(), env.make()
    original = request(env, [link(first), link(second)])
    save(env, original)
    with sqlite3.connect(env.tasks.db_path) as connection:
        connection.execute(
            "DELETE FROM student_task_review_heads WHERE task_id=?", (str(first.issued.task_id),)
        )
    view = env.overlay.get_evidence(env.case.case_id, SCOPE)
    assert view.focus_cards == []
    assert all(
        state.status == "unavailable" and state.questions == [] for state in view.source_states
    )
    with pytest.raises(ValueError):
        save(env, request(env, [link(first, teacher_observation="Changed source")], revision=1))
    assert len(env.overlay.revisions(env.case.case_id, SCOPE)) == 1
    replay = save(env, original)
    assert replay.acknowledged.revision == replay.overlay.revision == 1 and replay.focus_cards == []
    removed = save(env, request(env, [link(first)], revision=1))
    assert removed.overlay.revision == 2 and removed.source_states[0].status == "unavailable"
    assert removed.focus_cards == []
    assert save(env, request(env, [], revision=2)).overlay.links == []


def test_single_question_projection_does_not_expose_unselected_answers(environment):
    env = environment
    task = env.make()
    view = save(env, request(env, [link(task, question_ids=["Q1"])]))
    assert [question.question_id for question in view.source_states[0].questions] == ["Q1"]
    assert (
        "Synthetic answer" not in view.model_dump_json()
        and "USED_HINT" not in view.model_dump_json()
    )


def test_overlay_request_cannot_inject_identity_or_unbounded_links(environment):
    env = environment
    with pytest.raises(ValidationError):
        request(env, [], recipient_user_id="u_client_chosen")
    entries = [
        CaseReviewEvidenceLink(
            task_id=uuid4(), submission_id=uuid4(), review_revision=1, question_ids=["Q1"]
        )
        for _ in range(21)
    ]
    with pytest.raises(ValidationError):
        request(env, entries)


def test_case_write_lock_blocks_archival_until_overlay_commits(environment, monkeypatch):
    env = environment
    task = env.make()
    payload = request(env, [link(task)])
    entered, resume, attempted = Event(), Event(), Event()
    original_write, original_connection = env.overlay._write, env.cases._connection

    def paused_write(*args, **kwargs):
        entered.set()
        assert resume.wait(5)
        return original_write(*args, **kwargs)

    @contextmanager
    def traced_connection(*args, **kwargs):
        with original_connection(*args, **kwargs) as connection:
            if connection is not None:
                connection.set_trace_callback(
                    lambda sql: attempted.set() if sql.upper() == "BEGIN IMMEDIATE" else None
                )
            yield connection

    monkeypatch.setattr(env.overlay, "_write", paused_write)
    monkeypatch.setattr(env.cases, "_connection", traced_connection)
    with ThreadPoolExecutor(max_workers=2) as pool:
        overlay_future = pool.submit(save, env, payload)
        assert entered.wait(5)
        archive_future = pool.submit(change_case, env, archived=True)
        try:
            assert attempted.wait(5)
            assert not archive_future.done()
        finally:
            resume.set()
        assert overlay_future.result(5).overlay.revision == 1
        assert archive_future.result(5).archived is True


def test_central_shared_read_lock_is_held_through_overlay_commit(environment, monkeypatch):
    env = environment
    task = env.make()
    payload = request(env, [link(task)])
    entered, resume, commit_attempted = Event(), Event(), Event()
    original_write, original_connection = env.overlay._write, env.tasks._connection

    def paused_write(*args, **kwargs):
        entered.set()
        assert resume.wait(5)
        return original_write(*args, **kwargs)

    @contextmanager
    def traced_connection(*args, **kwargs):
        with original_connection(*args, **kwargs) as connection:
            if connection is not None:
                connection.set_trace_callback(
                    lambda sql: commit_attempted.set() if sql.upper() == "COMMIT" else None
                )
            yield connection

    monkeypatch.setattr(env.overlay, "_write", paused_write)
    monkeypatch.setattr(env.tasks, "_connection", traced_connection)
    correction = task.review_request.model_copy(
        update={
            "request_id": uuid4(),
            "expected_revision": 1,
            "change_reason": "Concurrent correction",
        }
    )
    with ThreadPoolExecutor(max_workers=2) as pool:
        overlay_future = pool.submit(save, env, payload)
        assert entered.wait(5)
        correction_future = pool.submit(
            env.reviews.save_review, SCOPE, task.issued.task_id, correction, reviewer_user_id=ACTOR
        )
        try:
            assert commit_attempted.wait(5)
            assert not correction_future.done()
        finally:
            resume.set()
        assert overlay_future.result(5).overlay.revision == 1
        assert correction_future.result(5).revision == 2
    assert env.overlay.get_evidence(env.case.case_id, SCOPE).source_states[0].status == "stale"
