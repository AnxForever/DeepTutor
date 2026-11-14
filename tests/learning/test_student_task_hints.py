"""Issued hint ladders have their own bounded, transactional receipt history."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
import sqlite3
from uuid import uuid4

from pydantic import ValidationError
import pytest

from deeptutor.learning.teaching_analysis import learner_task_hints, learner_tasks
from deeptutor.learning.teaching_analysis.followup_models import SavedFollowup
from deeptutor.learning.teaching_analysis.learner_task_models import (
    IssueTaskRequest,
    RevealTaskHintRequest,
    RevokeTaskRequest,
    SaveTaskProgressRequest,
    StudentSubmission,
    SubmitTaskRequest,
    TaskHintUsage,
    TaskQuestionHints,
    TaskResponse,
)
from deeptutor.learning.teaching_analysis.learner_tasks import (
    LearnerTaskStore,
    TaskConflict,
    TaskNotFound,
    TaskRevoked,
    TaskValidationError,
    canonical_issue_request,
)

RECIPIENT = "u_synthetic_hint_student"
SCOPE = "workspace:hint-demo:" + "a" * 64
HINTS = ["先把8拆成5和3。", "试着把7和3凑成10。", "再把剩下的5加上去。"]


def source_snapshot(count=2):
    return SavedFollowup.model_validate(
        {
            "followup_id": str(uuid4()),
            "revision": 1,
            "report_id": str(uuid4()),
            "report_revision": 1,
            "priority_index": 0,
            "title": "PRIVATE_SOURCE_TITLE",
            "student_ref": "PRIVATE_STUDENT_REF",
            "assignment_ref": "synthetic worksheet",
            "subject": "数学",
            "grade": "二年级",
            "source_fingerprint": "a" * 64,
            "knowledge_point": "PRIVATE_DIAGNOSIS",
            "questions": [
                {
                    "question_id": f"Q{i + 1}",
                    "question": f"计算{8 + i}+{7 - i}。",
                    "reference_answer": "PRIVATE_REFERENCE",
                    "rubric": "PRIVATE_RUBRIC",
                }
                for i in range(count)
            ],
            "created_at": 1.0,
            "updated_at": 1.0,
        }
    )


def issue(store, *, count=2, plans=None):
    snapshot = source_snapshot(count)
    request = IssueTaskRequest(
        task_id=uuid4(),
        followup_id=snapshot.followup_id,
        followup_revision=1,
        recipient_user_id=RECIPIENT,
        title="慢慢想的小练习",
        question_hints=(
            plans if plans is not None else [TaskQuestionHints(question_id="Q1", hints=HINTS)]
        ),
    )
    receipt = store.issue_task(SCOPE, request, snapshot, issuer_user_id="local-admin")
    return snapshot, request, receipt


@pytest.fixture
def task(tmp_path):
    store = LearnerTaskStore(tmp_path / "central")
    snapshot, request, receipt = issue(store)
    return store, snapshot, request, receipt


def reveal_request(question_id="Q1", revision=0, **changes):
    return RevealTaskHintRequest.model_validate(
        {
            "question_id": question_id,
            "request_id": str(uuid4()),
            "expected_hint_revision": revision,
            **changes,
        }
    )


def response_states():
    return [
        TaskResponse(
            question_id="Q1",
            response_status="needs_help",
            answer="我算到10，还想把5加上",
            assistance="independent",
        ),
        TaskResponse(
            question_id="Q2", response_status="answered", answer="15", assistance="independent"
        ),
    ]


def submit_request(revision=0):
    return SubmitTaskRequest(
        submission_id=uuid4(), expected_revision=revision, responses=response_states()
    )


def hint_tables(store):
    with sqlite3.connect(store.db_path) as connection:
        return connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'student_task_hint_%' ORDER BY name"
        ).fetchall()


def test_issue_plan_is_private_frozen_and_never_auto_copies_source_guidance(task):
    store, snapshot, request, receipt = task
    assert receipt.question_hints == request.question_hints
    assert receipt.hint_usage == [] and receipt.source_snapshot == snapshot
    state = store.get_task_hints(RECIPIENT, request.task_id)
    assert [(q.question_id, q.total, q.revealed) for q in state.questions] == [
        ("Q1", 3, []),
        ("Q2", 0, []),
    ]
    for payload in (
        state.model_dump_json(),
        store.get_student_task(RECIPIENT, request.task_id).model_dump_json(),
        str(store.list_student_tasks(RECIPIENT)),
    ):
        assert all(hint not in payload for hint in HINTS)
        assert "PRIVATE_" not in payload
        assert "question_hints" not in payload
    summary = store.list_teacher_tasks(SCOPE)[0].model_dump()
    assert "question_hints" not in summary and "hint_usage" not in summary
    request.question_hints[0].hints[0] = "edited after issue"
    assert store.get_teacher_task(SCOPE, request.task_id).question_hints[0].hints == HINTS


def test_each_success_reveals_exactly_one_prefix_without_saving_answers_or_revisions(task):
    store, _, request, _ = task
    before = store.get_student_task(RECIPIENT, request.task_id)
    state = store.reveal_task_hint(RECIPIENT, request.task_id, reveal_request())
    assert state.hint_revision == 1
    assert [(hint.level, hint.text) for hint in state.questions[0].revealed] == [(1, HINTS[0])]
    assert HINTS[1] not in state.model_dump_json() and HINTS[2] not in state.model_dump_json()
    assert store.get_student_task(RECIPIENT, request.task_id) == before
    teacher = store.get_teacher_task(SCOPE, request.task_id)
    assert teacher.hint_usage[0].question_id == "Q1"
    assert teacher.hint_usage[0].revealed[0].level == 1
    assert teacher.progress.revision == 0 and teacher.task_revision == 1
    with sqlite3.connect(store.db_path) as connection:
        assert (
            connection.execute("SELECT COUNT(*) FROM student_task_save_receipts").fetchone()[0] == 0
        )
        assert (
            connection.execute("SELECT COUNT(*) FROM student_task_submissions").fetchone()[0] == 0
        )


def test_independent_hint_revision_supports_cross_question_order_and_at_most_nine(tmp_path):
    store = LearnerTaskStore(tmp_path / "central")
    _, request, _ = issue(
        store,
        count=3,
        plans=[TaskQuestionHints(question_id=f"Q{i}", hints=HINTS) for i in (1, 2, 3)],
    )
    revision = 0
    for level in (1, 2, 3):
        for qid in ("Q3", "Q1", "Q2"):
            state = store.reveal_task_hint(
                RECIPIENT, request.task_id, reveal_request(qid, revision)
            )
            revision += 1
            assert state.hint_revision == revision
            assert len(next(q for q in state.questions if q.question_id == qid).revealed) == level
    assert revision == 9
    with pytest.raises(TaskValidationError):
        store.reveal_task_hint(RECIPIENT, request.task_id, reveal_request("Q1", 9))
    assert store.get_student_task(RECIPIENT, request.task_id).progress.revision == 0


def test_same_uuid_replays_current_state_without_skipping_and_changed_body_conflicts(task):
    store, _, request, _ = task
    first = reveal_request()
    opened = store.reveal_task_hint(RECIPIENT, request.task_id, first)
    assert store.reveal_task_hint(RECIPIENT, request.task_id, first) == opened
    current = store.reveal_task_hint(RECIPIENT, request.task_id, reveal_request(revision=1))
    assert store.reveal_task_hint(RECIPIENT, request.task_id, first) == current
    for changed in (
        first.model_copy(update={"question_id": "Q2"}),
        first.model_copy(update={"expected_hint_revision": 2}),
    ):
        with pytest.raises(TaskConflict):
            store.reveal_task_hint(RECIPIENT, request.task_id, changed)
    with pytest.raises(TaskConflict):
        store.reveal_task_hint(RECIPIENT, request.task_id, reveal_request())
    assert store.get_task_hints(RECIPIENT, request.task_id).hint_revision == 2


@pytest.mark.parametrize("same_intent", [False, True])
def test_concurrent_unlocks_have_one_new_event_for_the_same_basis(task, same_intent):
    store, _, request, _ = task
    first = reveal_request()
    second = first if same_intent else reveal_request()

    def unlock(payload):
        try:
            return store.reveal_task_hint(RECIPIENT, request.task_id, payload)
        except TaskConflict:
            return None

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(unlock, [first, second]))
    assert sum(value is not None for value in results) == (2 if same_intent else 1)
    assert store.get_task_hints(RECIPIENT, request.task_id).hint_revision == 1
    with sqlite3.connect(store.db_path) as connection:
        assert (
            connection.execute("SELECT COUNT(*) FROM student_task_hint_events").fetchone()[0] == 1
        )


@pytest.mark.parametrize("qid", ["Q2", "unknown"])
def test_missing_plan_or_unknown_question_does_not_create_an_event(task, qid):
    store, _, request, _ = task
    with pytest.raises(TaskValidationError):
        store.reveal_task_hint(RECIPIENT, request.task_id, reveal_request(qid))
    assert store.get_task_hints(RECIPIENT, request.task_id).hint_revision == 0


def test_recipient_authorization_precedes_hint_material_access(task):
    store, _, request, _ = task
    for operation in (
        lambda: store.get_task_hints("u_someone_else", request.task_id),
        lambda: store.reveal_task_hint("u_someone_else", request.task_id, reveal_request()),
        lambda: store.get_teacher_task("other_scope", request.task_id),
    ):
        with pytest.raises(TaskNotFound):
            operation()
    assert store.get_task_hints(RECIPIENT, request.task_id).hint_revision == 0


def test_new_final_freezes_server_usage_and_preserves_partial_work_and_original_intent(task):
    store, _, request, _ = task
    draft_request = SaveTaskProgressRequest(
        request_id=uuid4(),
        expected_revision=0,
        current_question_index=0,
        responses=response_states(),
    )
    saved = store.save_progress(RECIPIENT, request.task_id, draft_request)
    hint = store.reveal_task_hint(RECIPIENT, request.task_id, reveal_request())
    assert store.get_student_task(RECIPIENT, request.task_id) == saved
    intent = submit_request(revision=1)
    final = store.submit_task(RECIPIENT, request.task_id, intent)
    assert final.submission.hint_usage == store.get_teacher_task(SCOPE, request.task_id).hint_usage
    assert (
        final.submission.hint_usage[0].revealed[0].revealed_at
        == hint.questions[0].revealed[0].revealed_at
    )
    assert final.submission.responses[0].assistance == "assisted"
    assert final.submission.responses[1].assistance == "independent"
    assert final.submission.responses[0].answer == intent.responses[0].answer
    assert final.submission.responses[0].response_status == "needs_help"
    assert final.progress.responses == final.submission.responses
    assert store.submit_task(RECIPIENT, request.task_id, intent) == final
    assert store.list_student_tasks(RECIPIENT, state="history")[0].task_id == request.task_id
    assert store.list_teacher_tasks(SCOPE)[0].status == "submitted"
    with sqlite3.connect(store.db_path) as connection:
        raw = json.loads(
            connection.execute("SELECT request_json FROM student_task_submissions").fetchone()[0]
        )
        assert raw == intent.model_dump(mode="json")
        assert raw["responses"][0]["assistance"] == "independent"
        assert "hint_usage" not in raw
    revoked = store.revoke_task(
        SCOPE,
        request.task_id,
        RevokeTaskRequest(expected_revision=final.task_revision, reason="保留记录"),
    )
    assert revoked.submission == final.submission
    assert store.submit_task(RECIPIENT, request.task_id, intent).submission == final.submission


def test_new_submission_without_unlocks_is_known_empty_not_legacy_unknown(task):
    store, _, request, _ = task
    final = store.submit_task(RECIPIENT, request.task_id, submit_request())
    assert final.submission.hint_usage == []
    assert [response.assistance for response in final.submission.responses] == ["independent"] * 2


@pytest.mark.parametrize("status", ["unanswered", "needs_help", "answered"])
def test_help_usage_changes_only_assistance_never_response_status_or_answer(task, status):
    store, _, request, _ = task
    store.reveal_task_hint(RECIPIENT, request.task_id, reveal_request())
    response = TaskResponse(
        question_id="Q1",
        response_status=status,
        answer="partial" if status != "unanswered" else None,
    )
    payload = submit_request().model_copy(update={"responses": [response, response_states()[1]]})
    final = store.submit_task(RECIPIENT, request.task_id, payload).submission.responses[0]
    assert final.response_status == status and final.answer == response.answer
    assert final.assistance == "assisted"


@pytest.mark.parametrize("finish", ["submit", "revoke"])
def test_inactive_task_keeps_prefix_readable_but_even_successful_replay_is_blocked(task, finish):
    store, _, request, _ = task
    opened_request = reveal_request()
    opened = store.reveal_task_hint(RECIPIENT, request.task_id, opened_request)
    if finish == "submit":
        store.submit_task(RECIPIENT, request.task_id, submit_request())
    else:
        store.revoke_task(
            SCOPE, request.task_id, RevokeTaskRequest(expected_revision=1, reason="已撤回")
        )
    for payload in (opened_request, reveal_request(revision=1)):
        with pytest.raises(TaskConflict):
            store.reveal_task_hint(RECIPIENT, request.task_id, payload)
    assert store.get_task_hints(RECIPIENT, request.task_id) == opened


@pytest.mark.parametrize("finish", ["submit", "revoke"])
def test_unlock_and_finalization_are_linearized_in_the_same_database(task, finish):
    store, _, request, _ = task

    def unlock():
        try:
            return store.reveal_task_hint(RECIPIENT, request.task_id, reveal_request())
        except TaskConflict:
            return None

    def finalize():
        if finish == "submit":
            return store.submit_task(RECIPIENT, request.task_id, submit_request())
        return store.revoke_task(
            SCOPE, request.task_id, RevokeTaskRequest(expected_revision=1, reason="停止")
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        opened_future = executor.submit(unlock)
        final_future = executor.submit(finalize)
        opened, _ = opened_future.result(), final_future.result()
    state = store.get_task_hints(RECIPIENT, request.task_id)
    teacher = store.get_teacher_task(SCOPE, request.task_id)
    assert state.hint_revision == int(opened is not None)
    if finish == "submit":
        assert teacher.submission.hint_usage == teacher.hint_usage
        assert teacher.submission.responses[0].assistance == (
            "assisted" if opened else "independent"
        )
    with pytest.raises(TaskConflict):
        store.reveal_task_hint(
            RECIPIENT, request.task_id, reveal_request(revision=state.hint_revision)
        )


def test_interrupted_event_write_rolls_back_before_retry(task, monkeypatch):
    store, _, request, _ = task
    original = learner_task_hints._put_header

    def fail(*args, **kwargs):
        raise RuntimeError("synthetic interrupted transaction")

    monkeypatch.setattr(learner_task_hints, "_put_header", fail)
    payload = reveal_request()
    with pytest.raises(RuntimeError):
        store.reveal_task_hint(RECIPIENT, request.task_id, payload)
    assert store.get_task_hints(RECIPIENT, request.task_id).hint_revision == 0
    monkeypatch.setattr(learner_task_hints, "_put_header", original)
    assert store.reveal_task_hint(RECIPIENT, request.task_id, payload).hint_revision == 1


@pytest.mark.parametrize("bad_hint", ["", "  \n", "\ud800", "x" * 601, 123])
def test_teacher_hints_are_bounded_valid_nonblank_text(bad_hint):
    with pytest.raises(ValidationError):
        TaskQuestionHints(question_id="Q1", hints=[bad_hint])


@pytest.mark.parametrize("plans", [None, [], ["hint"] * 4])
def test_one_plan_requires_one_to_three_actual_hint_levels(plans):
    with pytest.raises(ValidationError):
        TaskQuestionHints(question_id="Q1", hints=plans)


def test_plan_questions_are_unique_actual_source_ids_and_issue_retry_includes_text(tmp_path):
    store = LearnerTaskStore(tmp_path / "central")
    with pytest.raises(ValidationError):
        issue(store, plans=[TaskQuestionHints(question_id="Q1", hints=["a"])] * 2)
    with pytest.raises(TaskValidationError):
        issue(store, plans=[TaskQuestionHints(question_id="invented", hints=["a"])])
    _, request, receipt = issue(store)
    changed = request.model_copy(
        update={"question_hints": [TaskQuestionHints(question_id="Q1", hints=["a different hint"])]}
    )
    with pytest.raises(TaskConflict):
        store.issue_task(SCOPE, changed, None, issuer_user_id="local-admin")
    assert store.issue_task(SCOPE, request, None, issuer_user_id="local-admin") == receipt


@pytest.mark.parametrize(
    "changes",
    [
        {"expected_hint_revision": True},
        {"expected_hint_revision": -1},
        {"expected_hint_revision": 10},
        {"question_id": "\ud800"},
        {"question_id": " "},
        {"level": 3},
        {"text": "student-chosen hint"},
    ],
)
def test_reveal_dto_has_no_client_level_text_or_invalid_revision(changes):
    with pytest.raises(ValidationError):
        reveal_request(**changes)


def test_client_cannot_submit_or_save_forged_hint_usage(task):
    store, _, request, _ = task
    raw = submit_request().model_dump(mode="json") | {"hint_usage": []}
    with pytest.raises(TaskValidationError):
        store.submit_task(RECIPIENT, request.task_id, raw)
    assert store.get_student_task(RECIPIENT, request.task_id).progress.revision == 0


def test_canonical_issue_omits_only_empty_new_plan_and_preserves_existing_defaults(task):
    _, _, request, _ = task
    raw = request.model_dump(mode="json")
    raw.pop("question_hints")
    assert canonical_issue_request(raw) == canonical_issue_request(raw | {"question_hints": []})
    assert canonical_issue_request(raw)["instructions"] == ""
    assert "question_hints" in canonical_issue_request(request)
    with pytest.raises(ValidationError):
        canonical_issue_request(raw | {"question_hints": None})


def _make_legacy(store, task_id, *, submitted):
    with sqlite3.connect(store.db_path) as connection:
        issue_json = json.loads(
            connection.execute("SELECT issue_json FROM issued_student_tasks").fetchone()[0]
        )
        issue_json["request"].pop("question_hints")
        connection.execute(
            "UPDATE issued_student_tasks SET issue_json=?,issue_hash=? WHERE task_id=?",
            (learner_tasks._canonical(issue_json), learner_tasks._digest(issue_json), str(task_id)),
        )
        if submitted:
            receipt = json.loads(
                connection.execute(
                    "SELECT submission_json FROM student_task_submissions"
                ).fetchone()[0]
            )
            receipt.pop("hint_usage")
            connection.execute(
                "UPDATE student_task_submissions SET submission_json=?,submission_hash=? WHERE task_id=?",
                (learner_tasks._canonical(receipt), learner_tasks._digest(receipt), str(task_id)),
            )
        connection.execute("DROP TABLE student_task_hint_events")
        connection.execute("DROP TABLE student_task_hint_states")
        return connection.execute(
            "SELECT issue_json,issue_hash,intent_hash FROM issued_student_tasks"
        ).fetchone(), connection.execute("SELECT * FROM student_task_submissions").fetchall()


@pytest.mark.parametrize("submitted", [False, True])
def test_legacy_absent_plan_and_usage_keep_receipts_and_read_without_hint_table_writes(
    tmp_path, submitted
):
    store = LearnerTaskStore(tmp_path / "central")
    _, request, _ = issue(store, plans=[])
    intent = submit_request()
    if submitted:
        store.submit_task(RECIPIENT, request.task_id, intent)
    old_issue, old_submission = _make_legacy(store, request.task_id, submitted=submitted)
    before_bytes = store.db_path.read_bytes()
    hints = store.get_task_hints(RECIPIENT, request.task_id)
    view = store.get_student_task(RECIPIENT, request.task_id)
    assert hints.hint_revision == 0 and all(q.total == 0 for q in hints.questions)
    assert hint_tables(store) == [] and store.db_path.read_bytes() == before_bytes
    assert store.list_teacher_tasks(SCOPE)[0].task_id == request.task_id
    assert (
        store.list_student_tasks(RECIPIENT, state="history" if submitted else "active")[0].task_id
        == request.task_id
    )
    if submitted:
        assert view.submission.hint_usage is None
        assert store.submit_task(RECIPIENT, request.task_id, intent).submission.hint_usage is None
    assert store.issue_task(SCOPE, request, None, issuer_user_id="local-admin").question_hints == []
    with sqlite3.connect(store.db_path) as connection:
        assert (
            connection.execute(
                "SELECT issue_json,issue_hash,intent_hash FROM issued_student_tasks"
            ).fetchone()
            == old_issue
        )
        assert (
            connection.execute("SELECT * FROM student_task_submissions").fetchall()
            == old_submission
        )


@pytest.mark.parametrize(
    "damage",
    [
        "event_text",
        "event_row_identity",
        "header_revision",
        "delete_event",
        "delete_header",
        "drop_one_table",
    ],
)
def test_changed_or_missing_hint_receipts_fail_closed_instead_of_erasing_assistance(task, damage):
    store, _, request, _ = task
    store.reveal_task_hint(RECIPIENT, request.task_id, reveal_request())
    with sqlite3.connect(store.db_path) as connection:
        if damage == "event_text":
            raw = json.loads(
                connection.execute("SELECT event_json FROM student_task_hint_events").fetchone()[0]
            )
            raw["level"] = 2
            connection.execute(
                "UPDATE student_task_hint_events SET event_json=?", (json.dumps(raw),)
            )
        elif damage == "event_row_identity":
            connection.execute("UPDATE student_task_hint_events SET recipient_user_id='u_other'")
        elif damage == "header_revision":
            connection.execute("UPDATE student_task_hint_states SET hint_revision=0")
        elif damage == "delete_event":
            connection.execute("DELETE FROM student_task_hint_events")
        elif damage == "delete_header":
            connection.execute("DELETE FROM student_task_hint_states")
        else:
            connection.execute("DROP TABLE student_task_hint_events")
    for operation in (
        lambda: store.get_task_hints(RECIPIENT, request.task_id),
        lambda: store.get_teacher_task(SCOPE, request.task_id),
        lambda: store.submit_task(RECIPIENT, request.task_id, submit_request()),
        lambda: store.list_student_tasks(RECIPIENT),
    ):
        with pytest.raises((ValueError, sqlite3.Error)):
            operation()


def test_receipt_normalization_predicate_matches_final_load_and_rejects_forged_independence(task):
    store, _, request, _ = task
    store.reveal_task_hint(RECIPIENT, request.task_id, reveal_request())
    intent = submit_request()
    final = store.submit_task(RECIPIENT, request.task_id, intent).submission.model_dump(mode="json")
    issue_json = json.dumps({"request": request.model_dump(mode="json")})
    assert (
        learner_task_hints.submission_matches_request(
            json.dumps(final), intent.model_dump_json(), issue_json
        )
        == 1
    )
    final["responses"][0]["assistance"] = "independent"
    assert (
        learner_task_hints.submission_matches_request(
            json.dumps(final), intent.model_dump_json(), issue_json
        )
        == 0
    )
    with sqlite3.connect(store.db_path) as connection:
        connection.execute(
            "UPDATE student_task_submissions SET submission_json=?,submission_hash=?",
            (learner_tasks._canonical(final), learner_tasks._digest(final)),
        )
    with pytest.raises(ValueError):
        store.list_student_tasks(RECIPIENT, state="history")


@pytest.mark.parametrize("missing", [True, False])
def test_an_issued_hint_plan_cannot_hide_unknown_usage_outside_the_list_page(task, missing):
    store, _, request, _ = task
    final = store.submit_task(RECIPIENT, request.task_id, submit_request()).submission.model_dump(
        mode="json"
    )
    _, newer, _ = issue(store, plans=[])
    assert store.list_teacher_tasks(SCOPE, limit=1)[0].task_id == newer.task_id
    assert store.list_student_tasks(RECIPIENT, limit=1)[0].task_id == newer.task_id
    if missing:
        final.pop("hint_usage")
    else:
        final["hint_usage"] = None
    with sqlite3.connect(store.db_path) as connection:
        connection.execute(
            "UPDATE student_task_submissions SET submission_json=?,submission_hash=? WHERE task_id=?",
            (learner_tasks._canonical(final), learner_tasks._digest(final), str(request.task_id)),
        )
    for operation in (
        lambda: store.get_student_task(RECIPIENT, request.task_id),
        lambda: store.list_teacher_tasks(SCOPE, limit=1),
        lambda: store.list_student_tasks(RECIPIENT, limit=1),
    ):
        with pytest.raises(ValueError):
            operation()


def test_recorded_usage_requires_valid_prefix_finite_times_and_existing_questions():
    for revealed in (
        [{"level": 2, "revealed_at": 1.0}],
        [{"level": 1, "revealed_at": float("nan")}],
        [{"level": True, "revealed_at": 1.0}],
        [{"level": 1, "revealed_at": 2.0}, {"level": 2, "revealed_at": 1.0}],
    ):
        with pytest.raises(ValidationError):
            TaskHintUsage(question_id="Q1", revealed=revealed)
    with pytest.raises(ValidationError):
        StudentSubmission(
            task_id=uuid4(),
            submission_id=uuid4(),
            submitted_at=1.0,
            responses=response_states(),
            hint_usage=[
                TaskHintUsage(question_id="invented", revealed=[{"level": 1, "revealed_at": 1.0}])
            ],
        )
