"""Manual assessments version existing receipts without creating another attempt."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
import sqlite3
from uuid import uuid4

from pydantic import ValidationError
import pytest

from deeptutor.learning.teaching_analysis import learner_task_reviews, learner_tasks
from deeptutor.learning.teaching_analysis.followup_models import SavedFollowup
from deeptutor.learning.teaching_analysis.learner_task_models import (
    IssueTaskRequest,
    RevealTaskHintRequest,
    RevokeTaskRequest,
    SubmitTaskRequest,
    TaskQuestionHints,
    TaskResponse,
)
from deeptutor.learning.teaching_analysis.learner_task_reviews import (
    ReviewConflict,
    ReviewNotFound,
    ReviewValidationError,
    TaskReviewStore,
)
from deeptutor.learning.teaching_analysis.learner_tasks import LearnerTaskStore
from deeptutor.learning.teaching_analysis.task_review_models import (
    SaveTaskReviewRequest,
    TaskReviewItem,
    WithdrawTaskReviewRequest,
)

SCOPE = "synthetic-workspace:reviews:" + "a" * 64
RECIPIENT = "u_synthetic_review_student"
REVIEWER = "u_real_admin_actor"


def source_snapshot():
    return SavedFollowup.model_validate(
        {
            "followup_id": str(uuid4()),
            "revision": 1,
            "report_id": str(uuid4()),
            "report_revision": 1,
            "priority_index": 0,
            "title": "Private original practice",
            "student_ref": "Anonymous label",
            "assignment_ref": "synthetic worksheet",
            "subject": "数学",
            "grade": "二年级",
            "source_fingerprint": "a" * 64,
            "knowledge_point": "凑十法",
            "questions": [
                {
                    "question_id": "Q1",
                    "question": "计算8+7。",
                    "reference_answer": "PRIVATE_KEY_15",
                    "rubric": "PRIVATE_RUBRIC",
                },
                {
                    "question_id": "Q2",
                    "question": "计算9+6。",
                    "reference_answer": "PRIVATE_SECOND_KEY",
                    "rubric": "PRIVATE_SECOND_RUBRIC",
                },
            ],
            "created_at": 1.0,
            "updated_at": 1.0,
        }
    )


def issue(task_store, *, submit=True, hints=False, source=None):
    snapshot = source if source is not None else source_snapshot()
    request = IssueTaskRequest(
        task_id=uuid4(),
        followup_id=snapshot.followup_id,
        followup_revision=1,
        recipient_user_id=RECIPIENT,
        title="给老师看的小练习",
        question_hints=[TaskQuestionHints(question_id="Q1", hints=["先想想怎样凑成10。"])]
        if hints
        else [],
    )
    task_store.issue_task(SCOPE, request, snapshot, issuer_user_id="u_original_issuer")
    if hints:
        task_store.reveal_task_hint(
            RECIPIENT,
            request.task_id,
            RevealTaskHintRequest(question_id="Q1", request_id=uuid4(), expected_hint_revision=0),
        )
    submission = SubmitTaskRequest(
        submission_id=uuid4(),
        expected_revision=0,
        responses=[
            TaskResponse(
                question_id="Q1",
                response_status="needs_help",
                answer="7+3=10，还剩5",
                assistance="independent",
            ),
            TaskResponse(question_id="Q2", response_status="needs_help", answer=None),
        ],
    )
    if submit:
        task_store.submit_task(RECIPIENT, request.task_id, submission)
    return snapshot, request, submission


@pytest.fixture
def task(tmp_path):
    tasks = LearnerTaskStore(tmp_path / "central")
    reviews = TaskReviewStore(task_store=tasks)
    source, issued, submitted = issue(tasks)
    return tasks, reviews, source, issued, submitted


def save_request(submission, *, revision=0, **changes):
    return SaveTaskReviewRequest.model_validate(
        {
            "request_id": str(uuid4()),
            "submission_id": str(submission.submission_id),
            "expected_revision": revision,
            "items": [
                {
                    "question_id": "Q1",
                    "result": "partial",
                    "feedback": "已经找到凑十的方法，还需写出最终结果。",
                },
                {"question_id": "Q2", "result": "ungraded", "feedback": "尚无作答文本。"},
            ],
            "summary": "下一次可让学生口述剩余数的处理。",
            "change_reason": "补充教师核对依据" if revision else "",
            **changes,
        }
    )


def confirm(task, *, revision=0, **changes):
    _, store, _, issued, submitted = task
    request = save_request(submitted, revision=revision, **changes)
    return store.save_review(SCOPE, issued.task_id, request, reviewer_user_id=REVIEWER), request


def old_rows(tasks):
    with sqlite3.connect(tasks.db_path) as connection:
        existing = {
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        return {
            table: connection.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()
            for table in (
                "issued_student_tasks",
                "student_task_states",
                "student_task_progress",
                "student_task_save_receipts",
                "student_task_submissions",
                "student_task_hint_states",
                "student_task_hint_events",
            )
            if table in existing
        }


def table_names(store):
    with sqlite3.connect(store.db_path) as connection:
        return {
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }


def test_absent_central_reads_and_projections_never_create_files(tmp_path):
    store = TaskReviewStore(tmp_path / "absent")
    identifier = uuid4()
    with store.read_connection() as connection:
        assert connection is None
        projected = store.project_refs(SCOPE, [(identifier, 1)], connection=connection)
        assert projected[(str(identifier), 1)].review is None
        assert projected[(str(identifier), 1)].latest_review is None
        assert projected[(str(identifier), 1)].task is None
    with pytest.raises(ReviewNotFound):
        store.get_review_state(SCOPE, identifier)
    assert not store.root.exists()


def test_factory_resolves_the_current_central_root_and_keeps_path_guards(tmp_path, monkeypatch):
    from deeptutor.multi_user import paths

    monkeypatch.setattr(paths, "SYSTEM_ROOT", tmp_path / "one")
    first = learner_task_reviews.get_task_review_store()
    monkeypatch.setattr(paths, "SYSTEM_ROOT", tmp_path / "two")
    second = learner_task_reviews.get_task_review_store()
    assert first.db_path == tmp_path / "one" / "student_tasks.sqlite3"
    assert second.db_path == tmp_path / "two" / "student_tasks.sqlite3"
    assert not first.root.exists() and not second.root.exists()


def test_unreviewed_existing_task_reads_do_not_migrate_the_database(task):
    tasks, store, _, issued, submitted = task
    before = tasks.db_path.read_bytes()
    state = store.get_review_state(SCOPE, issued.task_id)
    assert state.task_status == "submitted" and state.submission_id == submitted.submission_id
    assert state.current_review is None
    assert store.review_revisions(SCOPE, issued.task_id) == []
    with pytest.raises(ReviewNotFound):
        store.get_review(SCOPE, issued.task_id, 1)
    assert tasks.db_path.read_bytes() == before
    assert "student_task_review_revisions" not in table_names(store)


def test_pending_task_has_no_review_and_cannot_be_confirmed_before_submission(tmp_path):
    tasks = LearnerTaskStore(tmp_path / "central")
    _, issued, submission = issue(tasks, submit=False)
    store = TaskReviewStore(task_store=tasks)
    state = store.get_review_state(SCOPE, issued.task_id)
    assert state.submission_id is None and state.current_review is None
    before = old_rows(tasks)
    with pytest.raises(ReviewConflict):
        store.save_review(
            SCOPE, issued.task_id, save_request(submission), reviewer_user_id=REVIEWER
        )
    assert old_rows(tasks) == before
    assert "student_task_review_revisions" not in table_names(store)


def test_confirmed_review_is_derived_from_immutable_source_without_creating_an_attempt(task):
    tasks, store, source, issued, submitted = task
    before = old_rows(tasks)
    review, request = confirm(task)
    assert review.revision == 1 and review.status == "confirmed"
    assert review.task_id == issued.task_id and review.submission_id == submitted.submission_id
    assert review.request_id == request.request_id
    assert review.recipient_user_id == RECIPIENT and review.reviewer_user_id == REVIEWER
    assert review.report_id == source.report_id and review.report_revision == source.report_revision
    assert review.followup_id == source.followup_id and review.followup_revision == source.revision
    assert review.subject == source.subject and review.knowledge_point == source.knowledge_point
    assert (
        review.recorded_at
        >= tasks.get_student_task(RECIPIENT, issued.task_id).submission.submitted_at
    )
    assert store.get_review_state(SCOPE, issued.task_id).current_review == review
    assert store.get_review(SCOPE, issued.task_id, 1) == review
    assert old_rows(tasks) == before
    assert table_names(store) - set(before) == {
        "student_task_review_revisions",
        "student_task_review_heads",
    }
    payload = review.model_dump_json()
    for secret in (
        "PRIVATE_KEY_15",
        "PRIVATE_RUBRIC",
        "reference_answer",
        "source_snapshot",
        "responses",
        "hint_usage",
        "assistance",
    ):
        assert secret not in payload


def test_used_hints_and_partial_needs_help_work_cannot_be_overwritten_by_review(tmp_path):
    tasks = LearnerTaskStore(tmp_path / "central")
    source, issued, submitted = issue(tasks, hints=True)
    store = TaskReviewStore(task_store=tasks)
    before = tasks.get_student_task(RECIPIENT, issued.task_id)
    review = store.save_review(
        SCOPE, issued.task_id, save_request(submitted), reviewer_user_id=REVIEWER
    )
    after = tasks.get_student_task(RECIPIENT, issued.task_id)
    assert after == before
    assert after.submission.responses[0].assistance == "assisted"
    assert after.submission.responses[0].response_status == "needs_help"
    assert after.submission.responses[0].answer == "7+3=10，还剩5"
    assert review.items[0].result == "partial"
    with store.read_connection() as connection:
        projected = store.project_refs(SCOPE, [(issued.task_id, 1)], connection=connection)
    assert projected[(str(issued.task_id), 1)].task.submission == before.submission


@pytest.mark.parametrize("result", ["correct", "partial", "incorrect"])
def test_no_answer_text_must_remain_ungraded(task, result):
    _, store, _, issued, submitted = task
    request = save_request(submitted)
    raw = request.model_dump(mode="json")
    raw["items"][1]["result"] = result
    with pytest.raises(ReviewValidationError):
        store.save_review(SCOPE, issued.task_id, raw, reviewer_user_id=REVIEWER)
    assert store.get_review_state(SCOPE, issued.task_id).current_review is None


@pytest.mark.parametrize("question_ids", [["Q1"], ["Q1", "invented"], ["Q1", "Q1"]])
def test_exact_source_questions_are_required(task, question_ids):
    _, store, _, issued, submitted = task
    raw = save_request(submitted).model_dump(mode="json")
    raw["items"] = [{"question_id": qid, "result": "ungraded"} for qid in question_ids]
    with pytest.raises(ReviewValidationError):
        store.save_review(SCOPE, issued.task_id, raw, reviewer_user_id=REVIEWER)


def test_review_output_uses_question_order_but_preserves_original_request_intent(task):
    _, store, _, issued, submitted = task
    request = save_request(submitted)
    request = request.model_copy(update={"items": list(reversed(request.items))})
    review = store.save_review(SCOPE, issued.task_id, request, reviewer_user_id=REVIEWER)
    assert [item.question_id for item in review.items] == ["Q1", "Q2"]
    with sqlite3.connect(store.db_path) as connection:
        raw = json.loads(
            connection.execute("SELECT request_json FROM student_task_review_revisions").fetchone()[
                0
            ]
        )
    assert raw == request.model_dump(mode="json")
    with pytest.raises(ReviewConflict):
        store.save_review(
            SCOPE,
            issued.task_id,
            request.model_copy(update={"items": list(reversed(request.items))}),
            reviewer_user_id=REVIEWER,
        )


def test_correction_and_withdrawal_are_independent_immutable_revisions(task):
    tasks, store, _, issued, submitted = task
    original_source = old_rows(tasks)
    first, first_request = confirm(task)
    second, _ = confirm(task, revision=1, summary="核对书面过程后更正评阅。")
    withdrawal = WithdrawTaskReviewRequest(
        request_id=uuid4(), expected_revision=2, reason="需重新核对本次评阅依据。"
    )
    third = store.withdraw_review(
        SCOPE, issued.task_id, withdrawal, reviewer_user_id="u_second_admin"
    )
    assert [first.revision, second.revision, third.revision] == [1, 2, 3]
    assert (
        third.status == "withdrawn"
        and third.items == second.items
        and third.summary == second.summary
    )
    assert third.change_reason == withdrawal.reason and third.reviewer_user_id == "u_second_admin"
    assert (
        store.save_review(SCOPE, issued.task_id, first_request, reviewer_user_id="u_other_admin")
        == first
    )
    assert (
        store.withdraw_review(SCOPE, issued.task_id, withdrawal, reviewer_user_id=REVIEWER) == third
    )
    fourth, _ = confirm(task, revision=3, summary="重新核对后正式确认。")
    assert fourth.revision == 4 and fourth.status == "confirmed"
    assert store.get_review(SCOPE, issued.task_id, 1) == first
    assert [
        item.revision for item in store.review_revisions(SCOPE, issued.task_id, limit=2, offset=1)
    ] == [3, 2]
    assert old_rows(tasks) == original_source


def test_correction_requires_reason_and_cas_does_not_overwrite_another_version(task):
    _, store, _, issued, submitted = task
    first, original = confirm(task)
    with pytest.raises(ReviewValidationError):
        store.save_review(
            SCOPE,
            issued.task_id,
            save_request(submitted, revision=1, change_reason=" "),
            reviewer_user_id=REVIEWER,
        )
    with pytest.raises(ReviewConflict):
        store.save_review(SCOPE, issued.task_id, save_request(submitted), reviewer_user_id=REVIEWER)
    for changed in (
        original.model_copy(update={"summary": "different intent"}),
        original.model_copy(update={"submission_id": uuid4()}),
    ):
        with pytest.raises(ReviewConflict):
            store.save_review(SCOPE, issued.task_id, changed, reviewer_user_id=REVIEWER)
    with pytest.raises(ReviewConflict):
        store.withdraw_review(
            SCOPE,
            issued.task_id,
            WithdrawTaskReviewRequest(
                request_id=original.request_id,
                expected_revision=1,
                reason="same UUID, different operation",
            ),
            reviewer_user_id=REVIEWER,
        )
    assert store.get_review_state(SCOPE, issued.task_id).current_review == first


def test_new_withdrawal_id_cannot_create_repeated_withdrawn_revisions(task):
    _, store, _, issued, _ = task
    confirm(task)
    store.withdraw_review(
        SCOPE,
        issued.task_id,
        WithdrawTaskReviewRequest(request_id=uuid4(), expected_revision=1, reason="撤回"),
        reviewer_user_id=REVIEWER,
    )
    with pytest.raises(ReviewConflict):
        store.withdraw_review(
            SCOPE,
            issued.task_id,
            WithdrawTaskReviewRequest(request_id=uuid4(), expected_revision=2, reason="再次撤回"),
            reviewer_user_id=REVIEWER,
        )
    assert len(store.review_revisions(SCOPE, issued.task_id)) == 2


@pytest.mark.parametrize("same_intent", [False, True])
def test_concurrent_confirmations_cas_or_recover_one_revision(task, same_intent):
    _, store, _, issued, submitted = task
    first = save_request(submitted)
    second = first if same_intent else save_request(submitted, summary="another reviewer")

    def write(request):
        try:
            return store.save_review(SCOPE, issued.task_id, request, reviewer_user_id=REVIEWER)
        except ReviewConflict:
            return None

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(write, [first, second]))
    assert sum(result is not None for result in results) == (2 if same_intent else 1)
    assert len(store.review_revisions(SCOPE, issued.task_id)) == 1


def test_concurrent_correction_and_withdrawal_share_review_cas(task):
    _, store, _, issued, submitted = task
    confirm(task)

    def correct():
        try:
            return store.save_review(
                SCOPE,
                issued.task_id,
                save_request(submitted, revision=1),
                reviewer_user_id=REVIEWER,
            )
        except ReviewConflict:
            return None

    def withdraw():
        try:
            return store.withdraw_review(
                SCOPE,
                issued.task_id,
                WithdrawTaskReviewRequest(
                    request_id=uuid4(), expected_revision=1, reason="撤回核对"
                ),
                reviewer_user_id=REVIEWER,
            )
        except ReviewConflict:
            return None

    with ThreadPoolExecutor(max_workers=2) as executor:
        a, b = executor.submit(correct), executor.submit(withdraw)
        results = [a.result(), b.result()]
    assert sum(result is not None for result in results) == 1
    assert store.get_review_state(SCOPE, issued.task_id).current_review.revision == 2


def test_revoked_submitted_task_keeps_history_reviewable_without_source_filesystem_reads(
    task, monkeypatch
):
    from deeptutor.services import path_service

    tasks, store, _, issued, _ = task
    first, _ = confirm(task)
    current = tasks.get_teacher_task(SCOPE, issued.task_id)
    tasks.revoke_task(
        SCOPE,
        issued.task_id,
        RevokeTaskRequest(
            expected_revision=current.task_revision, reason="停止后续操作但保留已交作答"
        ),
    )

    def forbidden():
        pytest.fail("Review must use the frozen central source, not a teacher filesystem")

    monkeypatch.setattr(path_service, "get_path_service", forbidden)
    second, _ = confirm(task, revision=1)
    assert second.revision == 2
    withdrawn = store.withdraw_review(
        SCOPE,
        issued.task_id,
        WithdrawTaskReviewRequest(request_id=uuid4(), expected_revision=2, reason="历史评阅核对"),
        reviewer_user_id=REVIEWER,
    )
    assert withdrawn.status == "withdrawn"
    assert store.get_review(SCOPE, issued.task_id, 1) == first
    assert store.get_review_state(SCOPE, issued.task_id).task_status == "revoked"


def test_failed_first_write_rolls_back_schema_and_leaves_source_receipts_unchanged(
    task, monkeypatch
):
    tasks, store, _, issued, submitted = task
    before = old_rows(tasks)
    original = learner_task_reviews._create_schema

    def fail(connection):
        original(connection)
        raise RuntimeError("synthetic failure after transactional DDL")

    monkeypatch.setattr(learner_task_reviews, "_create_schema", fail)
    request = save_request(submitted)
    with pytest.raises(RuntimeError):
        store.save_review(SCOPE, issued.task_id, request, reviewer_user_id=REVIEWER)
    assert "student_task_review_revisions" not in table_names(store)
    assert "student_task_review_heads" not in table_names(store)
    assert old_rows(tasks) == before
    monkeypatch.setattr(learner_task_reviews, "_create_schema", original)
    assert (
        store.save_review(SCOPE, issued.task_id, request, reviewer_user_id=REVIEWER).revision == 1
    )


def test_exact_versions_and_history_offsets_are_not_truncated_at_one_hundred(task):
    _, store, _, issued, submitted = task
    first = None
    for expected in range(105):
        result = store.save_review(
            SCOPE,
            issued.task_id,
            save_request(submitted, revision=expected, summary=f"合成教师评阅版本{expected + 1}"),
            reviewer_user_id=REVIEWER,
        )
        first = result if first is None else first
    assert store.get_review(SCOPE, issued.task_id, 1) == first
    assert store.get_review(SCOPE, issued.task_id, 101).revision == 101
    assert [
        item.revision for item in store.review_revisions(SCOPE, issued.task_id, offset=100)
    ] == [5, 4, 3, 2, 1]


def test_lost_withdrawal_tail_cannot_revive_an_old_confirmed_assessment(task):
    tasks, store, _, issued, _ = task
    original_source = old_rows(tasks)
    first, original_request = confirm(task)
    withdrawn = store.withdraw_review(
        SCOPE,
        issued.task_id,
        WithdrawTaskReviewRequest(request_id=uuid4(), expected_revision=1, reason="合成撤回记录"),
        reviewer_user_id=REVIEWER,
    )
    assert withdrawn.status == "withdrawn"
    with sqlite3.connect(store.db_path) as connection:
        connection.execute(
            "DELETE FROM student_task_review_revisions WHERE task_id=? AND revision=2",
            (str(issued.task_id),),
        )
    for operation in (
        lambda: store.get_review_state(SCOPE, issued.task_id),
        lambda: store.get_review(SCOPE, issued.task_id, first.revision),
        lambda: store.review_revisions(SCOPE, issued.task_id, limit=1),
        lambda: store.project_refs(SCOPE, [(issued.task_id, first.revision)]),
        lambda: store.save_review(
            SCOPE, issued.task_id, original_request, reviewer_user_id=REVIEWER
        ),
    ):
        with pytest.raises(ValueError):
            operation()
    assert old_rows(tasks) == original_source


@pytest.mark.parametrize("damage", ["head_row", "all_revisions", "head_table"])
def test_missing_review_head_or_entire_recorded_history_is_not_unreviewed(task, damage):
    _, store, _, issued, _ = task
    confirm(task)
    with sqlite3.connect(store.db_path) as connection:
        if damage == "head_row":
            connection.execute(
                "DELETE FROM student_task_review_heads WHERE task_id=?", (str(issued.task_id),)
            )
        elif damage == "all_revisions":
            connection.execute(
                "DELETE FROM student_task_review_revisions WHERE task_id=?", (str(issued.task_id),)
            )
        else:
            connection.execute("DROP TABLE student_task_review_heads")
    with pytest.raises(ValueError):
        store.get_review_state(SCOPE, issued.task_id)
    with pytest.raises(ValueError):
        store.project_refs(SCOPE, [(issued.task_id, 1)])


def test_review_append_and_latest_receipt_update_roll_back_together(task, monkeypatch):
    tasks, store, _, issued, submitted = task
    first, _ = confirm(task)
    original_source = old_rows(tasks)
    with sqlite3.connect(store.db_path) as connection:
        old_head = connection.execute("SELECT * FROM student_task_review_heads").fetchall()
    original = store._put_head

    def fail(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("synthetic interruption after updating latest receipt")

    monkeypatch.setattr(store, "_put_head", fail)
    request = save_request(submitted, revision=1)
    with pytest.raises(RuntimeError):
        store.save_review(SCOPE, issued.task_id, request, reviewer_user_id=REVIEWER)
    assert store.get_review_state(SCOPE, issued.task_id).current_review == first
    with sqlite3.connect(store.db_path) as connection:
        assert connection.execute("SELECT * FROM student_task_review_heads").fetchall() == old_head
        assert (
            connection.execute("SELECT COUNT(*) FROM student_task_review_revisions").fetchone()[0]
            == 1
        )
    assert old_rows(tasks) == original_source
    monkeypatch.setattr(store, "_put_head", original)
    assert (
        store.save_review(SCOPE, issued.task_id, request, reviewer_user_id=REVIEWER).revision == 2
    )


def test_projection_returns_exact_and_current_revisions_with_current_task_status(task):
    tasks, store, _, issued, _ = task
    first, _ = confirm(task)
    second, _ = confirm(task, revision=1)
    current = tasks.get_teacher_task(SCOPE, issued.task_id)
    tasks.revoke_task(
        SCOPE,
        issued.task_id,
        RevokeTaskRequest(expected_revision=current.task_revision, reason="已撤回任务"),
    )
    missing = uuid4()
    with store.read_connection() as connection:
        projected = store.project_refs(
            SCOPE, [(issued.task_id, 1), (issued.task_id, 100), (missing, 1)], connection=connection
        )
    old = projected[(str(issued.task_id), 1)]
    assert old.review == first and old.latest_review == second and old.task.status == "revoked"
    assert old.task.submission.submission_id == first.submission_id
    assert projected[(str(issued.task_id), 100)].review is None
    assert projected[(str(missing), 1)].task is None
    denied = store.project_refs("another scope", [(issued.task_id, 1)])[(str(issued.task_id), 1)]
    assert denied.review is None and denied.latest_review is None and denied.task is None


def test_read_connection_holds_source_snapshot_until_caller_commit_boundary(task):
    tasks, store, _, issued, _ = task
    confirm(task)
    with store.read_connection() as protected:
        assert (
            store.project_refs(SCOPE, [(issued.task_id, 1)], connection=protected)[
                (str(issued.task_id), 1)
            ].review
            is not None
        )
        with sqlite3.connect(tasks.db_path, timeout=0.01) as writer:
            writer.execute("BEGIN IMMEDIATE")
            writer.execute(
                "UPDATE student_task_states SET state_hash=state_hash WHERE task_id=?",
                (str(issued.task_id),),
            )
            with pytest.raises(sqlite3.OperationalError, match="locked"):
                writer.commit()
            writer.rollback()
    assert store.get_review_state(SCOPE, issued.task_id).current_review.revision == 1


def test_cross_scope_checks_happen_before_corrupt_private_review_json_is_decoded(task):
    _, store, _, issued, _ = task
    confirm(task)
    with sqlite3.connect(store.db_path) as connection:
        connection.execute("UPDATE student_task_review_revisions SET review_json='not-json'")
    with pytest.raises(ReviewNotFound):
        store.get_review_state("another scope", issued.task_id)
    assert (
        store.project_refs("another scope", [(issued.task_id, 1)])[(str(issued.task_id), 1)].review
        is None
    )
    with pytest.raises(ValueError):
        store.get_review_state(SCOPE, issued.task_id)


@pytest.mark.parametrize(
    "field,value",
    [
        ("task_id", str(uuid4())),
        ("submission_id", str(uuid4())),
        ("request_id", str(uuid4())),
        ("revision", 2),
        ("subject", "语文"),
        ("knowledge_point", "invented"),
        ("submission_receipt_hash", "b" * 64),
        ("reviewer_user_id", "u_forged_actor"),
        ("recorded_at", 0.0),
    ],
)
def test_valid_but_misbound_review_json_fails_closed_even_with_recomputed_checksum(
    task, field, value
):
    _, store, _, issued, _ = task
    review, _ = confirm(task)
    raw = review.model_dump(mode="json") | {field: value}
    with sqlite3.connect(store.db_path) as connection:
        connection.execute(
            "UPDATE student_task_review_revisions SET review_json=?,review_hash=?",
            (learner_task_reviews._canonical(raw), learner_task_reviews._digest(raw)),
        )
    with pytest.raises(ValueError):
        store.get_review_state(SCOPE, issued.task_id)
    with pytest.raises(ValueError):
        store.project_refs(SCOPE, [(issued.task_id, 1)])


def test_request_or_answer_semantic_corruption_cannot_hide_outside_requested_history_page(task):
    _, store, _, issued, _ = task
    first, _ = confirm(task)
    confirm(task, revision=1)
    raw = first.model_dump(mode="json")
    raw["items"][0]["result"] = "correct"
    with sqlite3.connect(store.db_path) as connection:
        connection.execute(
            "UPDATE student_task_review_revisions SET review_json=?,review_hash=? WHERE revision=1",
            (learner_task_reviews._canonical(raw), learner_task_reviews._digest(raw)),
        )
    for operation in (
        lambda: store.review_revisions(SCOPE, issued.task_id, limit=1),
        lambda: store.get_review(SCOPE, issued.task_id, 2),
        lambda: store.project_refs(SCOPE, [(issued.task_id, 2)]),
    ):
        with pytest.raises(ValueError):
            operation()


def test_changed_original_request_cannot_recover_as_a_successful_old_uuid(task):
    _, store, _, issued, _ = task
    _, original = confirm(task)
    changed = original.model_dump(mode="json") | {"summary": "forged request intent"}
    with sqlite3.connect(store.db_path) as connection:
        connection.execute(
            "UPDATE student_task_review_revisions SET request_json=?",
            (learner_task_reviews._canonical(changed),),
        )
    with pytest.raises(ValueError):
        store.save_review(SCOPE, issued.task_id, original, reviewer_user_id=REVIEWER)


def test_legacy_submission_uses_original_raw_receipt_hash_without_rewriting_unknown_hint_usage(
    task,
):
    tasks, store, _, issued, submitted = task
    with sqlite3.connect(tasks.db_path) as connection:
        issue_raw = json.loads(
            connection.execute("SELECT issue_json FROM issued_student_tasks").fetchone()[0]
        )
        issue_raw["request"].pop("question_hints")
        connection.execute(
            "UPDATE issued_student_tasks SET issue_json=?,issue_hash=?",
            (learner_tasks._canonical(issue_raw), learner_tasks._digest(issue_raw)),
        )
        raw = json.loads(
            connection.execute("SELECT submission_json FROM student_task_submissions").fetchone()[0]
        )
        raw.pop("hint_usage")
        receipt_hash = learner_tasks._digest(raw)
        connection.execute(
            "UPDATE student_task_submissions SET submission_json=?,submission_hash=?",
            (learner_tasks._canonical(raw), receipt_hash),
        )
        connection.execute("DROP TABLE student_task_hint_events")
        connection.execute("DROP TABLE student_task_hint_states")
    legacy_source = tasks.get_student_task(RECIPIENT, issued.task_id).submission
    assert legacy_source.hint_usage is None
    assert learner_tasks._digest(legacy_source.model_dump(mode="json")) != receipt_hash
    before = old_rows(tasks)
    review, _ = confirm(task)
    assert review.submission_receipt_hash == receipt_hash
    assert store.get_review(SCOPE, issued.task_id, 1) == review
    assert old_rows(tasks) == before
    assert "student_task_hint_events" not in table_names(store)
    assert "student_task_hint_states" not in table_names(store)
    assert tasks.get_student_task(RECIPIENT, issued.task_id).submission.hint_usage is None


def test_valid_historical_empty_subject_and_focus_are_preserved_without_inference(tmp_path):
    tasks = LearnerTaskStore(tmp_path / "central")
    source = source_snapshot().model_copy(update={"subject": "", "knowledge_point": ""})
    _, issued, submitted = issue(tasks, source=source)
    store = TaskReviewStore(task_store=tasks)
    review = store.save_review(
        SCOPE, issued.task_id, save_request(submitted), reviewer_user_id=REVIEWER
    )
    assert review.subject == "" and review.knowledge_point == ""
    assert store.get_review_state(SCOPE, issued.task_id).current_review == review


@pytest.mark.parametrize(
    "field,value",
    [
        ("summary", "\ud800"),
        ("summary", "x" * 3001),
        ("change_reason", "x" * 2001),
        ("expected_revision", True),
        ("expected_revision", -1),
        ("recipient_user_id", RECIPIENT),
        ("assistance", "independent"),
        ("responses", []),
        ("knowledge_point", "client-defined"),
    ],
)
def test_review_requests_reject_invalid_text_and_server_owned_fields(task, field, value):
    _, store, _, issued, submitted = task
    raw = save_request(submitted).model_dump(mode="json") | {field: value}
    with pytest.raises(ReviewValidationError):
        store.save_review(SCOPE, issued.task_id, raw, reviewer_user_id=REVIEWER)


@pytest.mark.parametrize(
    "changes",
    [
        {"question_id": "\ud800"},
        {"question_id": " "},
        {"feedback": "x" * 2001},
        {"feedback": "\ud800"},
        {"student_answer": "forged"},
        {"result": "unknown"},
    ],
)
def test_review_item_contract_is_bounded_utf8_and_assessment_only(changes):
    with pytest.raises(ValidationError):
        TaskReviewItem.model_validate({"question_id": "Q1", "result": "ungraded", **changes})


@pytest.mark.parametrize(
    "changes",
    [
        {"expected_revision": 0},
        {"expected_revision": True},
        {"reason": " "},
        {"reason": "\ud800"},
        {"reason": "x" * 2001},
    ],
)
def test_withdrawal_requires_valid_revision_and_actual_audit_reason(changes):
    with pytest.raises(ValidationError):
        WithdrawTaskReviewRequest.model_validate(
            {"request_id": str(uuid4()), "expected_revision": 1, "reason": "核对后撤回", **changes}
        )


def test_corrupt_sqlite_is_not_unreviewed_or_an_empty_projection(task):
    _, store, _, issued, _ = task
    store.db_path.write_bytes(b"synthetic corrupt sqlite")
    with pytest.raises(sqlite3.Error):
        store.get_review_state(SCOPE, issued.task_id)
    with pytest.raises(sqlite3.Error):
        store.project_refs(SCOPE, [(issued.task_id, 1)])
