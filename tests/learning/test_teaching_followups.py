"""Practice-set versions and teacher reviews must preserve independent evidence."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sqlite3
import stat
from types import SimpleNamespace
from uuid import UUID, uuid4

from pydantic import ValidationError
import pytest

from deeptutor.learning.teaching_analysis.followup_models import (
    FollowupQuestion,
    SaveFollowupAttemptRequest,
    SaveFollowupRequest,
    VoidFollowupAttemptRequest,
)
from deeptutor.learning.teaching_analysis.followups import (
    FollowupConflict,
    FollowupNotFound,
    FollowupStore,
    FollowupValidationError,
)
from deeptutor.learning.teaching_analysis.models import AssignmentInput, ReportContent
from deeptutor.learning.teaching_analysis.service import fingerprint_assignment
from deeptutor.learning.teaching_analysis.storage import TeachingAnalysisStore


def source_payload(*, status="confirmed") -> dict:
    material = AssignmentInput(
        student_ref="student-a",
        assignment_ref="assignment-a",
        subject="Mathematics",
        grade="Grade 5",
        items=[
            {
                "question_id": "Q1",
                "question": "1/2 + 1/3 = ?",
                "student_answer": "2/5",
                "student_work": "(1+1)/(2+3)=2/5",
                "reference_answer": "5/6",
                "answer_status": "present",
                "transcription_status": "confirmed",
                "assistance": "independent",
            }
        ],
    )
    citation = {"question_id": "Q1", "field": "student_answer", "quote": "2/5"}
    report = ReportContent(
        summary="Check unlike denominators.",
        items=[
            {
                "question_id": "Q1",
                "result": "incorrect",
                "observation": "The denominator was added to the other denominator.",
                "evidence": [citation],
            }
        ],
        priorities=[
            {
                "knowledge_point": "Unlike denominators",
                "observation": "The response was 2/5.",
                "hypothesis": "May not be using common units.",
                "alternative_explanation": "A single response does not establish why.",
                "teaching_action": "Compare equal-sized fraction parts.",
                "follow_up_question": "Find 1/4 + 1/6 and explain the common unit.",
                "reference_guidance": "5/12; use twelfths.",
                "evidence_status": "supported",
                "evidence": [citation],
            }
        ],
        limitations=["One original response only."],
    )
    return {
        "assignment": material.model_dump(mode="json"),
        "analysis": report.model_dump(mode="json"),
        "source_fingerprint": fingerprint_assignment(material),
        "status": status,
        "teacher_notes": "",
    }


@pytest.fixture
def practice(tmp_path):
    source = TeachingAnalysisStore(tmp_path / "workspace")
    report_id = str(uuid4())
    report = source.save_report(report_id, 0, source_payload())
    store = FollowupStore(source.root)
    request = SaveFollowupRequest(
        followup_id=uuid4(),
        expected_revision=0,
        report_id=report_id,
        report_revision=1,
        priority_index=0,
        title="Fraction follow-up",
        questions=[
            FollowupQuestion(
                question_id="F1",
                question="Find 1/4 + 1/6 and explain the common unit.",
                reference_answer="5/12",
                rubric="Check common units and the calculation.",
            )
        ],
    )
    return source, report, store, request


def attempt(*, revision=1, **changes) -> SaveFollowupAttemptRequest:
    return SaveFollowupAttemptRequest.model_validate(
        {
            "attempt_id": str(uuid4()),
            "followup_revision": revision,
            "question_id": "F1",
            "student_answer": "5/12",
            "student_work": "3/12 + 2/12 = 5/12",
            "answer_status": "present",
            "assistance": "independent",
            "teacher_result": "correct",
            "teacher_feedback": "Explained the common unit.",
            **changes,
        }
    )


def test_empty_reads_do_not_create_storage(tmp_path):
    store = FollowupStore(tmp_path / "absent")
    assert store.list_followups() == []
    for action in (store.get_followup, store.revisions, store.attempts):
        with pytest.raises(FollowupNotFound):
            action(uuid4())
    assert not store.root.exists()


def test_question_bounds_unique_ids_and_client_labels_are_rejected(practice):
    _, _, _, request = practice
    payload = request.model_dump(mode="json")
    for changes in (
        {"questions": []},
        {"questions": payload["questions"] * 4},
        {"questions": payload["questions"] * 2},
        {"title": "   "},
        {"priority_index": 3},
        {"student_ref": "a-forged-student"},
        {"source_fingerprint": "a" * 64},
    ):
        with pytest.raises(ValidationError):
            SaveFollowupRequest.model_validate(payload | changes)
    with pytest.raises(ValidationError):
        FollowupQuestion(question_id="F1", question=" ")


def test_confirmed_source_supplies_metadata_and_question_versions_are_immutable(practice):
    _, report, store, request = practice
    first = store.save_followup(request)
    for field in ("student_ref", "assignment_ref", "subject", "grade"):
        assert first[field] == report["assignment"][field]
    assert first["source_fingerprint"] == report["source_fingerprint"]
    assert first["knowledge_point"] == report["analysis"]["priorities"][0]["knowledge_point"]
    assert store.save_followup(request) == first
    changed = request.model_dump(mode="json") | {"title": "Reviewed and revised"}
    with pytest.raises(FollowupConflict):
        store.save_followup(SaveFollowupRequest.model_validate(changed))
    changed["expected_revision"] = 1
    second = store.save_followup(SaveFollowupRequest.model_validate(changed))
    assert second["revision"] == 2
    assert second["created_at"] == first["created_at"]
    assert store.revisions(request.followup_id) == [second, first]
    assert store.list_followups(report_id=request.report_id) == [second]
    assert store.list_followups(report_id=uuid4()) == []


def test_draft_stale_missing_or_invalid_source_cannot_create_practice(practice):
    source, report, store, request = practice
    with pytest.raises(FollowupNotFound):
        store.save_followup(request.model_copy(update={"report_id": uuid4()}))
    with pytest.raises(FollowupValidationError):
        store.save_followup(request.model_copy(update={"priority_index": 1}))
    source.save_report(report["report_id"], 1, source_payload(status="draft"))
    with pytest.raises(FollowupConflict):
        store.save_followup(request)
    with pytest.raises(FollowupConflict):
        store.save_followup(request.model_copy(update={"report_revision": 2}))
    assert store.list_followups() == []


def test_saving_practice_locks_source_revision_until_commit(practice, monkeypatch):
    source, _, store, request = practice
    original = FollowupStore._source_metadata
    locked = []

    def observe_lock(connection, payload):
        result = original(connection, payload)
        other = sqlite3.connect(source.db_path, timeout=0.001, isolation_level=None)
        try:
            with pytest.raises(sqlite3.OperationalError, match="locked"):
                other.execute("BEGIN IMMEDIATE")
            locked.append(True)
        finally:
            other.close()
        return result

    monkeypatch.setattr(FollowupStore, "_source_metadata", staticmethod(observe_lock))
    assert store.save_followup(request)["report_revision"] == 1
    assert locked == [True]


def test_old_practice_remains_readable_and_answerable_after_report_changes(practice):
    source, report, store, request = practice
    saved = store.save_followup(request)
    source.save_report(report["report_id"], 1, source_payload(status="draft"))
    assert store.get_followup(request.followup_id) == saved
    # Retrying the already committed snapshot is recovery, not a new revision.
    assert store.save_followup(request) == saved
    changed = request.model_copy(update={"expected_revision": 1, "title": "New draft"})
    with pytest.raises(FollowupConflict):
        store.save_followup(changed)
    receipt = store.record_attempt(request.followup_id, attempt())
    assert receipt["report_revision"] == 1


def test_binding_to_another_report_or_concern_requires_a_new_set(practice):
    source, report, store, request = practice
    store.save_followup(request)
    other_id = str(uuid4())
    source.save_report(other_id, 0, source_payload())
    with pytest.raises(FollowupConflict):
        store.save_followup(
            request.model_copy(update={"expected_revision": 1, "report_id": UUID(other_id)})
        )
    with pytest.raises(FollowupConflict):
        store.save_followup(
            request.model_copy(update={"expected_revision": 1, "priority_index": 1})
        )
    assert store.get_followup(request.followup_id)["report_id"] == report["report_id"]


@pytest.mark.parametrize("field", ["student_ref", "assignment_ref", "subject", "knowledge_point"])
def test_new_source_revision_cannot_rebind_an_existing_set(practice, field):
    source, report, store, request = practice
    original = store.save_followup(request)
    receipt = store.record_attempt(request.followup_id, attempt())
    updated_source = source_payload()
    if field == "knowledge_point":
        updated_source["analysis"]["priorities"][0][field] = "Another learning concern"
    else:
        updated_source["assignment"][field] = "Another " + field
        updated_source["source_fingerprint"] = fingerprint_assignment(
            AssignmentInput.model_validate(updated_source["assignment"])
        )
    source.save_report(report["report_id"], 1, updated_source)
    rebound = request.model_copy(update={"expected_revision": 1, "report_revision": 2})
    with pytest.raises(FollowupConflict, match="Create a new practice set"):
        store.save_followup(rebound)
    assert store.get_followup(request.followup_id) == original
    assert store.attempts(request.followup_id) == [receipt]
    fresh = rebound.model_copy(update={"followup_id": uuid4(), "expected_revision": 0})
    assert store.save_followup(fresh)[field] != original[field]


def test_same_student_and_concern_can_use_a_new_confirmed_source_revision(practice):
    source, report, store, request = practice
    original = store.save_followup(request)
    updated_source = source_payload()
    updated_source["teacher_notes"] = "Source review refined without changing the subject."
    source.save_report(report["report_id"], 1, updated_source)
    updated = store.save_followup(
        request.model_copy(update={"expected_revision": 1, "report_revision": 2})
    )
    assert updated["revision"] == 2 and updated["report_revision"] == 2
    assert store.revisions(request.followup_id) == [updated, original]


def test_repeated_same_answer_is_separate_attempt_but_transport_retry_is_not(practice):
    _, _, store, request = practice
    saved = store.save_followup(request)
    first_request = attempt()
    first = store.record_attempt(request.followup_id, first_request)
    assert store.record_attempt(request.followup_id, first_request) == first
    second = store.record_attempt(request.followup_id, attempt())
    assert second["attempt_id"] != first["attempt_id"]
    assert second["student_answer"] == first["student_answer"]
    assert len(store.attempts(request.followup_id)) == 2
    assert first["question_snapshot"] == saved["questions"][0]
    changed = first_request.model_copy(update={"teacher_feedback": "Different feedback"})
    with pytest.raises(FollowupConflict):
        store.record_attempt(request.followup_id, changed)


def test_new_responses_require_current_questions_but_committed_old_retry_survives(practice):
    _, _, store, request = practice
    original = store.save_followup(request)
    response = attempt()
    receipt = store.record_attempt(request.followup_id, response)
    changed = request.model_dump(mode="json")
    changed["expected_revision"] = 1
    changed["questions"][0]["question"] = "Find 1/3 + 1/4 instead."
    changed["questions"][0]["reference_answer"] = "7/12"
    current = store.save_followup(SaveFollowupRequest.model_validate(changed))
    assert current["revision"] == 2
    with pytest.raises(FollowupConflict):
        store.record_attempt(request.followup_id, attempt())
    assert store.record_attempt(request.followup_id, response) == receipt
    assert receipt["question_snapshot"] == original["questions"][0]
    second = store.record_attempt(
        request.followup_id,
        attempt(revision=2, student_answer="7/12", student_work="4/12 + 3/12 = 7/12"),
    )
    assert second["question_snapshot"] == current["questions"][0]
    assert [row["followup_revision"] for row in store.attempts(request.followup_id)] == [2, 1]


@pytest.mark.parametrize("status", ["unknown", "confirmed_blank"])
@pytest.mark.parametrize("result", ["correct", "partial", "incorrect"])
def test_unknown_or_blank_cannot_receive_a_grade(status, result):
    empty = "" if status == "confirmed_blank" else None
    with pytest.raises(ValidationError):
        attempt(
            answer_status=status,
            student_answer=empty,
            student_work=empty,
            teacher_result=result,
        )
    assert (
        attempt(
            answer_status=status,
            student_answer=empty,
            student_work=empty,
            teacher_result="ungraded",
        ).teacher_result
        == "ungraded"
    )


def test_assisted_correct_answer_is_preserved_without_mastery_or_notebook_writes(practice):
    _, _, store, request = practice
    store.save_followup(request)
    receipt = store.record_attempt(request.followup_id, attempt(assistance="assisted"))
    assert receipt["assistance"] == "assisted" and receipt["teacher_result"] == "correct"
    assert sorted(path.name for path in store.root.iterdir()) == [
        "followups.sqlite3",
        "reports.sqlite3",
    ]


def test_void_is_append_only_idempotent_and_keeps_original_answer(practice):
    _, _, store, request = practice
    store.save_followup(request)
    submitted = attempt()
    original = store.record_attempt(request.followup_id, submitted)
    with sqlite3.connect(store.db_path) as connection:
        raw_before = connection.execute(
            "SELECT content_json FROM teaching_followup_attempts WHERE attempt_id=?",
            (str(submitted.attempt_id),),
        ).fetchone()[0]
    voided = store.void_attempt(request.followup_id, submitted.attempt_id, "  Wrong transcript  ")
    assert voided["void_reason"] == "Wrong transcript" and voided["voided_at"] is not None
    for key, value in original.items():
        if key not in {"voided_at", "void_reason"}:
            assert voided[key] == value
    assert (
        store.void_attempt(request.followup_id, submitted.attempt_id, "Wrong transcript") == voided
    )
    assert store.record_attempt(request.followup_id, submitted) == voided
    with pytest.raises(FollowupConflict):
        store.void_attempt(request.followup_id, submitted.attempt_id, "Another reason")
    with sqlite3.connect(store.db_path) as connection:
        assert (
            connection.execute(
                "SELECT content_json FROM teaching_followup_attempts WHERE attempt_id=?",
                (str(submitted.attempt_id),),
            ).fetchone()[0]
            == raw_before
        )
    assert store.attempts(request.followup_id) == [voided]
    with pytest.raises(ValidationError):
        VoidFollowupAttemptRequest(reason="  ")


def test_missing_question_set_or_attempt_cannot_be_recorded_or_voided(practice):
    _, _, store, request = practice
    store.save_followup(request)
    with pytest.raises(FollowupValidationError):
        store.record_attempt(request.followup_id, attempt(question_id="not-in-set"))
    with pytest.raises(FollowupNotFound):
        store.record_attempt(uuid4(), attempt())
    with pytest.raises(FollowupNotFound):
        store.void_attempt(request.followup_id, uuid4(), "Not a saved attempt")
    assert store.attempts(request.followup_id) == []


def test_scope_roots_never_share_practice_or_submission_ids(practice, tmp_path):
    _, _, store, request = practice
    store.save_followup(request)
    store.record_attempt(request.followup_id, attempt())
    other = FollowupStore(tmp_path / "other-workspace")
    assert other.list_followups() == []
    with pytest.raises(FollowupNotFound):
        other.get_followup(request.followup_id)
    with pytest.raises(FollowupNotFound):
        other.record_attempt(request.followup_id, attempt())


def test_parallel_practice_edits_have_one_cas_winner(practice):
    _, _, store, request = practice
    store.save_followup(request)

    def edit(title):
        try:
            return store.save_followup(
                request.model_copy(update={"expected_revision": 1, "title": title})
            )
        except FollowupConflict:
            return None

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(edit, ("First edit", "Second edit")))
    assert sum(result is not None for result in results) == 1
    assert len(store.revisions(request.followup_id)) == 2


def test_parallel_retry_writes_one_immutable_submission(practice):
    _, _, store, request = practice
    store.save_followup(request)
    submission = attempt()
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(
            executor.map(lambda _: store.record_attempt(request.followup_id, submission), range(2))
        )
    assert results[0] == results[1]
    assert len(store.attempts(request.followup_id)) == 1


def test_reparse_path_is_rejected_before_practice_storage_is_created(tmp_path, monkeypatch):
    target = tmp_path / "redirected"
    original = Path.lstat

    def fake(path, *args, **kwargs):
        if path == target:
            return SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=0x400)
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "lstat", fake)
    monkeypatch.setattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400, raising=False)
    with pytest.raises(ValueError, match="redirected"):
        FollowupStore(target)
    assert not target.exists()
