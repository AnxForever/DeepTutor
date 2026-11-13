"""A short task is recipient-bound draft state plus one immutable final receipt."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sqlite3
import stat
from types import SimpleNamespace
from uuid import uuid4

from pydantic import ValidationError
import pytest

from deeptutor.learning.teaching_analysis import learner_tasks
from deeptutor.learning.teaching_analysis.followup_models import SavedFollowup
from deeptutor.learning.teaching_analysis.learner_task_models import (
    IssueTaskRequest,
    RevokeTaskRequest,
    SaveTaskProgressRequest,
    SubmitTaskRequest,
    TaskResponse,
)
from deeptutor.learning.teaching_analysis.learner_tasks import (
    LearnerTaskStore,
    TaskConflict,
    TaskNotFound,
    TaskRevoked,
    TaskValidationError,
)

RECIPIENT = "u_student_alpha"
SCOPE = "workspace:default:" + "b" * 64
SECRETS = (
    "PRIVATE_REFERENCE_81",
    "PRIVATE_RUBRIC_82",
    "PRIVATE_DIAGNOSIS_83",
    "PRIVATE_STUDENT_84",
    "PRIVATE_SOURCE_TITLE_85",
)


def source_snapshot(**changes):
    return SavedFollowup.model_validate(
        {
            "followup_id": str(uuid4()),
            "revision": 1,
            "report_id": str(uuid4()),
            "report_revision": 1,
            "priority_index": 0,
            "title": SECRETS[4],
            "student_ref": SECRETS[3],
            "assignment_ref": "private worksheet",
            "subject": "数学",
            "grade": "三年级",
            "source_fingerprint": "a" * 64,
            "knowledge_point": SECRETS[2],
            "questions": [
                {
                    "question_id": "Q1",
                    "question": "计算8+7。",
                    "reference_answer": SECRETS[0],
                    "rubric": SECRETS[1],
                },
                {
                    "question_id": "Q2",
                    "question": "计算9+6。",
                    "reference_answer": "private second key",
                    "rubric": "private second criterion",
                },
            ],
            "created_at": 1.0,
            "updated_at": 1.0,
            **changes,
        }
    )


def issue_request(snapshot, **changes):
    return IssueTaskRequest.model_validate(
        {
            "task_id": str(uuid4()),
            "followup_id": str(snapshot.followup_id),
            "followup_revision": snapshot.revision,
            "recipient_user_id": RECIPIENT,
            "title": "每日小练习",
            "instructions": "慢慢做，不会也可以告诉老师。",
            **changes,
        }
    )


def responses(answer="15", *, second="needs_help", assistance="unknown"):
    return [
        TaskResponse(
            question_id="Q1", response_status="answered", answer=answer, assistance=assistance
        ),
        TaskResponse(question_id="Q2", response_status=second, answer=None),
    ]


def save_request(expected_revision=0, **changes):
    return SaveTaskProgressRequest(
        request_id=uuid4(),
        expected_revision=expected_revision,
        current_question_index=0,
        responses=responses(),
        **changes,
    )


def submit_request(expected_revision=0, **changes):
    return SubmitTaskRequest(
        submission_id=uuid4(), expected_revision=expected_revision, responses=responses(), **changes
    )


@pytest.fixture
def task(tmp_path):
    store = LearnerTaskStore(tmp_path / "system")
    snapshot = source_snapshot()
    request = issue_request(snapshot)
    issued = store.issue_task(SCOPE, request, snapshot, issuer_user_id="local-admin")
    return store, snapshot, request, issued


def assert_student_allowlist(value, snapshot):
    payload = value.model_dump_json() if hasattr(value, "model_dump_json") else json.dumps(value)
    for secret in (
        *SECRETS,
        str(snapshot.followup_id),
        str(snapshot.report_id),
        SCOPE,
        "local-admin",
    ):
        assert secret not in payload
    for field in (
        "reference_answer",
        "rubric",
        "teacher_result",
        "teacher_feedback",
        "source_snapshot",
        "source_fingerprint",
        "teacher_scope_key",
    ):
        assert '"' + field + '"' not in payload


def test_initial_reads_do_not_create_a_central_database(tmp_path):
    store = LearnerTaskStore(tmp_path / "absent")
    assert store.list_student_tasks(RECIPIENT) == []
    assert store.list_teacher_tasks(SCOPE) == []
    with pytest.raises(TaskNotFound):
        store.get_student_task(RECIPIENT, uuid4())
    with pytest.raises(TaskNotFound):
        store.get_teacher_task(SCOPE, uuid4())
    assert not store.root.exists()


def test_factory_resolves_system_root_per_call_without_account_workspace_fallback(
    tmp_path, monkeypatch
):
    from deeptutor.multi_user import paths

    monkeypatch.setattr(paths, "SYSTEM_ROOT", tmp_path / "one")
    first = learner_tasks.get_learner_task_store()
    monkeypatch.setattr(paths, "SYSTEM_ROOT", tmp_path / "two")
    second = learner_tasks.get_learner_task_store()
    assert first.root == tmp_path / "one" and second.root == tmp_path / "two"
    assert first.db_path.name == second.db_path.name == "student_tasks.sqlite3"
    assert not first.root.exists() and not second.root.exists()


def test_issue_and_all_student_reads_use_a_positive_allowlist(task):
    store, snapshot, request, issued = task
    assert issued.task_revision == 1 and issued.status == "pending"
    assert issued.source_snapshot == snapshot
    view = store.get_student_task(RECIPIENT, request.task_id)
    assert view.progress.revision == 0 and view.progress.saved_at is None
    assert view.progress.current_question_index == 0 and view.submission is None
    assert [row.response_status for row in view.progress.responses] == ["unanswered", "unanswered"]
    assert [row.answer for row in view.progress.responses] == [None, None]
    assert_student_allowlist(view, snapshot)
    for row in store.list_student_tasks(RECIPIENT):
        assert_student_allowlist(row, snapshot)


@pytest.mark.parametrize(
    "change", [{"title": "另一标题"}, {"recipient_user_id": "u_other"}, {"followup_revision": 2}]
)
def test_issue_idempotency_key_cannot_be_rebound_to_different_intent(task, change):
    store, snapshot, request, issued = task
    assert store.issue_task(SCOPE, request, None, issuer_user_id="another-admin") == issued
    with pytest.raises(TaskConflict):
        store.issue_task(
            SCOPE,
            IssueTaskRequest.model_validate(request.model_dump() | change),
            snapshot,
            issuer_user_id="local-admin",
        )
    assert len(store.list_teacher_tasks(SCOPE)) == 1


def test_actor_and_teacher_scope_are_checked_before_private_payload_access(task):
    store, _, request, _ = task
    assert store.list_student_tasks("u_other") == []
    assert store.list_teacher_tasks("workspace:other") == []
    for operation in (
        lambda: store.get_student_task("u_other", request.task_id),
        lambda: store.get_teacher_task("workspace:other", request.task_id),
        lambda: store.save_progress("u_other", request.task_id, save_request()),
        lambda: store.submit_task("u_other", request.task_id, submit_request()),
        lambda: store.revoke_task(
            "workspace:other",
            request.task_id,
            RevokeTaskRequest(expected_revision=1, reason="撤回"),
        ),
    ):
        with pytest.raises(TaskNotFound):
            operation()
    assert store.get_student_task(RECIPIENT, request.task_id).progress.revision == 0


def test_draft_save_starts_task_and_teacher_sees_only_progress_metadata(task):
    store, snapshot, request, _ = task
    intent = save_request().model_copy(update={"responses": responses("DRAFT_NOT_SUBMITTED_99")})
    view = store.save_progress(RECIPIENT, request.task_id, intent)
    assert view.status == "in_progress" and view.task_revision == 2
    assert (
        view.progress.revision == 1
        and view.progress.responses[0].answer == "DRAFT_NOT_SUBMITTED_99"
    )
    assert (
        view.progress.responses[1].response_status == "needs_help"
        and view.progress.responses[1].answer is None
    )
    assert_student_allowlist(view, snapshot)
    teacher = store.get_teacher_task(SCOPE, request.task_id)
    assert teacher.submission is None and teacher.progress.revision == 1
    assert "DRAFT_NOT_SUBMITTED_99" not in teacher.model_dump_json()
    assert "DRAFT_NOT_SUBMITTED_99" not in store.list_teacher_tasks(SCOPE)[0].model_dump_json()


def test_draft_retries_do_not_overwrite_a_later_writer(task):
    store, _, request, _ = task
    first = save_request()
    saved = store.save_progress(RECIPIENT, request.task_id, first)
    assert store.save_progress(RECIPIENT, request.task_id, first) == saved
    changed = first.model_copy(update={"responses": responses("different same-id body")})
    with pytest.raises(TaskConflict):
        store.save_progress(RECIPIENT, request.task_id, changed)
    with pytest.raises(TaskConflict):
        store.save_progress(RECIPIENT, request.task_id, save_request())
    newer = save_request(expected_revision=1).model_copy(
        update={"responses": responses("SECOND_WRITER_100")}
    )
    latest = store.save_progress(RECIPIENT, request.task_id, newer)
    assert latest.progress.revision == 2 and latest.task_revision == 2
    retried = store.save_progress(RECIPIENT, request.task_id, first)
    assert retried.progress == latest.progress
    with sqlite3.connect(store.db_path) as connection:
        assert (
            connection.execute("SELECT COUNT(*) FROM student_task_save_receipts").fetchone()[0] == 2
        )


@pytest.mark.parametrize(
    "change",
    [
        {"responses": [{"question_id": "Q1", "response_status": "answered", "answer": "15"}]},
        {
            "responses": [
                {"question_id": "Q1", "response_status": "answered", "answer": "15"},
                {"question_id": "FOREIGN", "response_status": "unanswered", "answer": None},
            ]
        },
        {"current_question_index": 2},
        {"expected_revision": True},
        {"teacher_result": "correct"},
        {
            "responses": [
                {"question_id": "Q1", "response_status": "answered", "answer": " "},
                {"question_id": "Q2", "response_status": "unanswered", "answer": None},
            ]
        },
        {
            "responses": [
                {"question_id": "Q1", "response_status": "needs_help", "answer": " \n "},
                {"question_id": "Q2", "response_status": "unanswered", "answer": None},
            ]
        },
        {
            "responses": [
                {"question_id": "Q1", "response_status": "answered", "answer": "\ud800"},
                {"question_id": "Q2", "response_status": "unanswered", "answer": None},
            ]
        },
    ],
)
def test_invalid_student_payloads_fail_without_changing_the_draft(task, change):
    store, _, request, _ = task
    payload = save_request().model_dump(mode="json") | change
    with pytest.raises(TaskValidationError):
        store.save_progress(RECIPIENT, request.task_id, payload)
    view = store.get_student_task(RECIPIENT, request.task_id)
    assert view.status == "pending" and view.progress.revision == 0


def test_final_submit_freezes_the_actual_last_keystrokes_atomically(task):
    store, snapshot, request, _ = task
    store.save_progress(RECIPIENT, request.task_id, save_request())
    final = submit_request(expected_revision=1).model_copy(
        update={"responses": responses("FINAL_LAST_KEYSTROKES_101")}
    )
    view = store.submit_task(RECIPIENT, request.task_id, final)
    assert view.status == "submitted" and view.progress.revision == 2 and view.task_revision == 3
    assert view.progress.current_question_index == 1
    assert view.submission.responses == view.progress.responses
    assert view.submission.responses[0].answer == "FINAL_LAST_KEYSTROKES_101"
    assert view.submission.responses[1].response_status == "needs_help"
    assert_student_allowlist(view, snapshot)
    teacher = store.get_teacher_task(SCOPE, request.task_id)
    assert teacher.submission == view.submission
    assert store.list_student_tasks(RECIPIENT) == []
    assert (
        store.list_student_tasks(RECIPIENT, state="history")[0].submitted_at
        == view.submission.submitted_at
    )
    assert sorted(path.name for path in store.root.iterdir()) == ["student_tasks.sqlite3"]


def test_one_final_receipt_is_idempotent_and_never_becomes_multiple_attempts(task):
    store, _, request, _ = task
    intent = submit_request()
    first = store.submit_task(RECIPIENT, request.task_id, intent)
    assert store.submit_task(RECIPIENT, request.task_id, intent) == first
    with pytest.raises(TaskConflict):
        store.submit_task(RECIPIENT, request.task_id, submit_request())
    with pytest.raises(TaskConflict):
        store.submit_task(
            RECIPIENT,
            request.task_id,
            intent.model_copy(update={"responses": responses("changed")}),
        )
    with pytest.raises(TaskConflict):
        store.save_progress(RECIPIENT, request.task_id, save_request(expected_revision=1))
    with sqlite3.connect(store.db_path) as connection:
        assert (
            connection.execute("SELECT COUNT(*) FROM student_task_submissions").fetchone()[0] == 1
        )
        assert connection.execute("SELECT COUNT(*) FROM student_task_states").fetchone()[0] == 2


def test_all_response_states_are_explicit_even_when_no_answer_is_claimed(task):
    store, _, request, _ = task
    raw = submit_request().model_dump(mode="json")
    raw["responses"] = [
        {"question_id": "Q1", "response_status": "unanswered", "answer": None},
        {"question_id": "Q2", "response_status": "needs_help", "answer": None},
    ]
    final = store.submit_task(RECIPIENT, request.task_id, SubmitTaskRequest.model_validate(raw))
    assert [row.response_status for row in final.submission.responses] == [
        "unanswered",
        "needs_help",
    ]
    assert all(row.answer is None for row in final.submission.responses)
    assert "teacher_result" not in final.submission.model_dump_json()


@pytest.mark.parametrize("answer", [None, "我先把7分成2和5，还没有做完。"])
def test_needs_help_accepts_existing_null_or_preserves_nonblank_partial_work(answer):
    response = TaskResponse(question_id="Q1", response_status="needs_help", answer=answer)
    assert response.response_status == "needs_help" and response.answer == answer
    with pytest.raises(ValidationError):
        TaskResponse(question_id="Q1", response_status="unanswered", answer="仍有文字")


def test_partial_work_survives_help_progress_final_revoke_and_receipt_replay(task):
    store, snapshot, request, _ = task
    partial = "我先算8+2=10，剩下的5还没有算完。"
    help_responses = [
        TaskResponse(question_id="Q1", response_status="needs_help", answer=partial),
        TaskResponse(question_id="Q2", response_status="needs_help", answer=None),
    ]
    progress_intent = save_request().model_copy(update={"responses": help_responses})
    progress = store.save_progress(RECIPIENT, request.task_id, progress_intent)
    assert progress.progress.responses == help_responses
    assert store.get_student_task(RECIPIENT, request.task_id).progress.responses == help_responses
    assert partial not in store.get_teacher_task(SCOPE, request.task_id).model_dump_json()
    final_intent = submit_request(expected_revision=1).model_copy(
        update={"responses": help_responses}
    )
    final = store.submit_task(RECIPIENT, request.task_id, final_intent)
    assert final.submission.responses == help_responses
    assert final.progress.responses == help_responses
    assert "teacher_result" not in final.submission.model_dump_json()
    assert_student_allowlist(final, snapshot)
    revoked = store.revoke_task(
        SCOPE,
        request.task_id,
        RevokeTaskRequest(expected_revision=final.task_revision, reason="保留已交作答后撤回"),
    )
    assert revoked.submission == final.submission
    replayed = store.submit_task(RECIPIENT, request.task_id, final_intent)
    assert replayed.status == "revoked" and replayed.submission == final.submission
    assert replayed.submission.responses[0].response_status == "needs_help"
    assert replayed.submission.responses[0].answer == partial
    with sqlite3.connect(store.db_path) as connection:
        assert (
            connection.execute("SELECT COUNT(*) FROM student_task_submissions").fetchone()[0] == 1
        )


def test_revoke_is_versioned_and_preserves_drafts_but_blocks_new_writes(task):
    store, _, request, _ = task
    draft = store.save_progress(RECIPIENT, request.task_id, save_request())
    with pytest.raises(TaskConflict):
        store.revoke_task(
            SCOPE, request.task_id, RevokeTaskRequest(expected_revision=1, reason="stale")
        )
    revoke = RevokeTaskRequest(expected_revision=draft.task_revision, reason="发放对象核对有误")
    result = store.revoke_task(SCOPE, request.task_id, revoke)
    assert result.status == "revoked" and result.task_revision == 3
    assert store.revoke_task(SCOPE, request.task_id, revoke) == result
    assert store.get_student_task(RECIPIENT, request.task_id).progress == draft.progress
    for write in (
        lambda: store.save_progress(RECIPIENT, request.task_id, save_request(expected_revision=1)),
        lambda: store.submit_task(RECIPIENT, request.task_id, submit_request(expected_revision=1)),
    ):
        with pytest.raises(TaskRevoked):
            write()
    with pytest.raises(TaskConflict):
        store.revoke_task(SCOPE, request.task_id, revoke.model_copy(update={"reason": "different"}))
    with sqlite3.connect(store.db_path) as connection:
        assert (
            connection.execute("SELECT COUNT(*) FROM student_task_submissions").fetchone()[0] == 0
        )


def test_successful_submission_retry_survives_revoke_and_source_unavailability(task):
    store, snapshot, request, _ = task
    intent = submit_request()
    final = store.submit_task(RECIPIENT, request.task_id, intent)
    store.revoke_task(
        SCOPE,
        request.task_id,
        RevokeTaskRequest(expected_revision=final.task_revision, reason="撤回后保留历史"),
    )
    retry = store.submit_task(RECIPIENT, request.task_id, intent)
    assert retry.status == "revoked" and retry.submission == final.submission
    assert (
        store.issue_task(SCOPE, request, None, issuer_user_id="local-admin").submission
        == final.submission
    )
    assert_student_allowlist(retry, snapshot)


def test_source_update_cannot_change_an_already_issued_question_snapshot(task, monkeypatch):
    from deeptutor.services import path_service

    store, snapshot, request, _ = task

    def forbidden():
        pytest.fail("Student task reads must not access a teacher filesystem")

    monkeypatch.setattr(path_service, "get_path_service", forbidden)
    original = store.get_student_task(RECIPIENT, request.task_id)
    snapshot.questions[0].question = "A newer source question"
    snapshot.questions[0].reference_answer = "a changed secret key"
    assert store.get_student_task(RECIPIENT, request.task_id).questions == original.questions
    store.save_progress(RECIPIENT, request.task_id, save_request())
    final = store.submit_task(RECIPIENT, request.task_id, submit_request(expected_revision=1))
    assert final.questions == original.questions


@pytest.mark.parametrize("same_intent", [False, True])
def test_concurrent_draft_saves_cas_or_replay_without_duplicate_revisions(task, same_intent):
    store, _, request, _ = task
    first = save_request()
    second = (
        first
        if same_intent
        else save_request().model_copy(update={"responses": responses("other writer")})
    )

    def write(intent):
        try:
            return store.save_progress(RECIPIENT, request.task_id, intent)
        except TaskConflict:
            return None

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(write, [first, second]))
    assert sum(row is not None for row in results) == (2 if same_intent else 1)
    assert store.get_student_task(RECIPIENT, request.task_id).progress.revision == 1


@pytest.mark.parametrize("same_intent", [False, True])
def test_concurrent_final_submissions_have_one_immutable_receipt(task, same_intent):
    store, _, request, _ = task
    first = submit_request()
    second = first if same_intent else submit_request()

    def write(intent):
        try:
            return store.submit_task(RECIPIENT, request.task_id, intent)
        except TaskConflict:
            return None

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(write, [first, second]))
    assert sum(row is not None for row in results) == (2 if same_intent else 1)
    with sqlite3.connect(store.db_path) as connection:
        assert (
            connection.execute("SELECT COUNT(*) FROM student_task_submissions").fetchone()[0] == 1
        )


def test_failed_final_write_rolls_back_progress_and_lifecycle_before_retry(task, monkeypatch):
    store, _, request, _ = task
    original = store._put_state

    def fail(connection, state):
        if state.status == "submitted":
            raise RuntimeError("simulated interrupted write")
        return original(connection, state)

    monkeypatch.setattr(store, "_put_state", fail)
    intent = submit_request()
    with pytest.raises(RuntimeError):
        store.submit_task(RECIPIENT, request.task_id, intent)
    current = store.get_student_task(RECIPIENT, request.task_id)
    assert (
        current.status == "pending"
        and current.progress.revision == 0
        and current.submission is None
    )
    monkeypatch.setattr(store, "_put_state", original)
    assert (
        store.submit_task(RECIPIENT, request.task_id, intent).submission.submission_id
        == intent.submission_id
    )


def test_teacher_followup_filter_is_applied_before_pagination(task):
    store, snapshot, request, _ = task
    other = source_snapshot()
    for _ in range(5):
        store.issue_task(SCOPE, issue_request(other), other, issuer_user_id="local-admin")
    selected = store.list_teacher_tasks(SCOPE, followup_id=snapshot.followup_id, limit=1)
    assert len(selected) == 1 and selected[0].task_id == request.task_id
    assert store.list_teacher_tasks(SCOPE, followup_id=uuid4()) == []


@pytest.mark.parametrize(
    "table,content_column,hash_column",
    [
        ("issued_student_tasks", "issue_json", "issue_hash"),
        ("student_task_states", "state_json", "state_hash"),
        ("student_task_progress", "progress_json", "progress_hash"),
    ],
)
def test_changed_valid_json_cannot_bypass_receipt_integrity(
    task, table, content_column, hash_column
):
    store, _, request, _ = task
    with sqlite3.connect(store.db_path) as connection:
        raw = json.loads(connection.execute(f"SELECT {content_column} FROM {table}").fetchone()[0])
        if table == "issued_student_tasks":
            raw["request"]["title"] = "forged title"
        elif table == "student_task_states":
            raw["status"] = "revoked"
        else:
            raw["responses"][0]["response_status"] = "needs_help"
        connection.execute(f"UPDATE {table} SET {content_column}=?", (json.dumps(raw),))
    with pytest.raises(ValueError):
        store.get_student_task(RECIPIENT, request.task_id)
    with pytest.raises((ValueError, sqlite3.Error)):
        store.list_student_tasks(RECIPIENT)


def test_missing_lifecycle_cannot_disappear_as_an_empty_inbox(task):
    store, _, _, _ = task
    with sqlite3.connect(store.db_path) as connection:
        connection.execute("DELETE FROM student_task_states")
    with pytest.raises(ValueError):
        store.list_student_tasks(RECIPIENT)
    with pytest.raises(ValueError):
        store.list_teacher_tasks(SCOPE)


def test_corrupt_database_is_not_silently_empty(task):
    store, _, _, _ = task
    store.db_path.write_bytes(b"not sqlite")
    with pytest.raises(sqlite3.Error):
        store.list_student_tasks(RECIPIENT)
    assert store.db_path.read_bytes() == b"not sqlite"


def test_reparse_root_is_refused_before_creation(tmp_path, monkeypatch):
    root = tmp_path / "redirected"
    original = Path.lstat

    def lstat(path, *args, **kwargs):
        if path == root:
            return SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=0x400)
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "lstat", lstat)
    monkeypatch.setattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400, raising=False)
    with pytest.raises(ValueError):
        LearnerTaskStore(root)
    assert not root.exists()


@pytest.mark.parametrize(
    "field,value",
    [
        ("title", " "),
        ("title", "\ud800"),
        ("recipient_user_id", "x" * 65),
        ("followup_revision", True),
        ("instructions", "x" * 1001),
    ],
)
def test_issue_contract_rejects_invalid_text_and_untrusted_metadata(field, value):
    snapshot = source_snapshot()
    raw = issue_request(snapshot).model_dump(mode="json") | {field: value}
    with pytest.raises(ValidationError):
        IssueTaskRequest.model_validate(raw)
