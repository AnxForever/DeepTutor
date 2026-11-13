"""Student identity, immutable pins, complete timelines and cursor invalidation."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar
import json
from pathlib import Path
import sqlite3
import stat
from types import SimpleNamespace
from uuid import uuid4

from pydantic import ValidationError
import pytest

from deeptutor.learning.teaching_analysis import case_storage, cases, followups
from deeptutor.learning.teaching_analysis.case_models import PinnedReportRef, SaveStudentCaseRequest
from deeptutor.learning.teaching_analysis.cases import (
    CaseConflict,
    CaseNotFound,
    CaseSourceConflict,
    CaseValidationError,
    StudentCaseStore,
)
from deeptutor.learning.teaching_analysis.followup_models import (
    SaveFollowupAttemptRequest,
    SaveFollowupRequest,
)
from deeptutor.learning.teaching_analysis.followups import FollowupStore
from deeptutor.learning.teaching_analysis.models import AssignmentInput
from deeptutor.learning.teaching_analysis.service import fingerprint_assignment
from deeptutor.learning.teaching_analysis.storage import ReportNotFound, TeachingAnalysisStore


def source_payload(*, status="confirmed", note=""):
    assignment = AssignmentInput(
        student_ref="Anonymous",
        assignment_ref="Worksheet 1",
        subject="Math",
        items=[
            {
                "question_id": "Q1",
                "question": "Calculate 1+1.",
                "student_answer": "3",
                "student_work": "1+1=3",
                "answer_status": "present",
                "transcription_status": "confirmed",
                "assistance": "independent",
            }
        ],
    )
    return {
        "assignment": assignment.model_dump(mode="json"),
        "source_fingerprint": fingerprint_assignment(assignment),
        "status": status,
        "teacher_notes": note,
        "analysis": {
            "summary": "The written answer differs from the reference calculation.",
            "items": [
                {
                    "question_id": "Q1",
                    "result": "incorrect",
                    "observation": "The answer is written as 3.",
                    "evidence": [{"question_id": "Q1", "field": "student_answer", "quote": "3"}],
                }
            ],
            "priorities": [
                {
                    "knowledge_point": "Addition",
                    "observation": "Review this calculation.",
                    "hypothesis": "Insufficient evidence for a persistent cause.",
                    "alternative_explanation": "Possible isolated slip.",
                    "teaching_action": "Demonstrate a count.",
                    "follow_up_question": "Calculate 2+1.",
                    "reference_guidance": "Expected result is 3.",
                    "evidence_status": "supported",
                    "evidence": [{"question_id": "Q1", "field": "student_answer", "quote": "3"}],
                }
            ],
            "limitations": ["One item does not establish mastery or a lasting difficulty."],
        },
    }


@pytest.fixture
def evidence(tmp_path):
    source = TeachingAnalysisStore(tmp_path / "workspace")
    report = source.save_report(str(uuid4()), 0, source_payload())
    practice = FollowupStore(source.root)
    request = SaveFollowupRequest(
        followup_id=uuid4(),
        report_id=report["report_id"],
        report_revision=report["revision"],
        priority_index=0,
        title="Teacher-reviewed follow-up",
        questions=[{"question_id": "P1", "question": "Calculate 2+1.", "reference_answer": "3"}],
    )
    practice.save_followup(request)
    return source, report, practice, request, StudentCaseStore(source.root)


def case_request(report=None, *, case_id=None, expected_revision=0, **changes):
    return SaveStudentCaseRequest.model_validate(
        {
            "case_id": str(case_id or uuid4()),
            "expected_revision": expected_revision,
            "label": "匿名学生",
            "subject": None,
            "archived": False,
            "report_refs": [
                {"report_id": report["report_id"], "report_revision": report["revision"]}
            ]
            if report
            else [],
            **changes,
        }
    )


def record(practice, request, *, assistance="independent", result="correct"):
    return practice.record_attempt(
        request.followup_id,
        SaveFollowupAttemptRequest(
            attempt_id=uuid4(),
            followup_revision=practice.get_followup(request.followup_id)["revision"],
            question_id="P1",
            student_answer="3",
            answer_status="present",
            assistance=assistance,
            teacher_result=result,
        ),
    )


def test_empty_reads_do_not_create_case_or_other_databases(tmp_path):
    store = StudentCaseStore(tmp_path / "absent")
    assert store.list_cases() == []
    for read in (
        lambda: store.get_case(uuid4()),
        lambda: store.revisions(uuid4()),
        lambda: store.timeline(uuid4()),
    ):
        with pytest.raises(CaseNotFound):
            read()
    assert not store.root.exists()


def test_same_labels_are_distinct_ids_and_metadata_versions_are_immutable(evidence):
    _, report, _, _, store = evidence
    first = store.save_case(case_request(report))
    other = store.save_case(case_request(report))
    assert first.label == other.label and first.case_id != other.case_id
    changed = store.save_case(
        case_request(
            report, case_id=first.case_id, expected_revision=1, label="新代号", archived=True
        )
    )
    assert changed.revision == 2 and changed.created_at == first.created_at
    assert [item.case_id for item in store.list_cases()] == [other.case_id]
    assert store.list_cases(archived=True)[0].case_id == first.case_id
    restored = store.save_case(
        case_request(report, case_id=first.case_id, expected_revision=2, label="新代号")
    )
    assert not restored.archived and restored.revision == 3
    assert store.revisions(first.case_id) == [restored, changed, first]


def test_cas_and_successful_retries_do_not_make_duplicate_history(evidence):
    _, report, _, _, store = evidence
    request = case_request(report)
    first = store.save_case(request)
    assert store.save_case(request) == first
    edit = case_request(report, case_id=first.case_id, expected_revision=1, label="修改")
    second = store.save_case(edit)
    assert store.save_case(edit) == second
    assert store.save_case(edit.model_copy(update={"expected_revision": 2})) == second
    with pytest.raises(CaseConflict):
        store.save_case(request)
    with pytest.raises(CaseConflict):
        store.save_case(edit.model_copy(update={"label": "陈旧修改"}))
    assert len(store.revisions(first.case_id)) == 2


def test_concurrent_metadata_edits_have_one_cas_winner(evidence):
    _, report, _, _, store = evidence
    first = store.save_case(case_request(report))

    def edit(label):
        try:
            return store.save_case(
                case_request(report, case_id=first.case_id, expected_revision=1, label=label)
            )
        except CaseConflict:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(edit, ["甲", "乙"]))
    assert sum(value is not None for value in results) == 1
    assert len(store.revisions(first.case_id)) == 2


@pytest.mark.parametrize(
    "field,value",
    [
        ("label", "\ud800"),
        ("subject", "\udfff"),
        ("label", " "),
        ("label", "x" * 201),
        ("subject", "x" * 201),
        ("archived", 1),
        ("expected_revision", True),
    ],
)
def test_invalid_unicode_and_fields_fail_before_case_storage(evidence, field, value):
    _, report, _, _, store = evidence
    payload = case_request(report).model_dump(mode="json") | {field: value}
    with pytest.raises(CaseValidationError):
        store.save_case(payload)
    assert not store.db_path.exists()


def test_report_pins_are_bounded_and_unique_by_report_id():
    identifier = uuid4()
    with pytest.raises(ValidationError):
        case_request(
            report_refs=[
                {"report_id": identifier, "report_revision": 1},
                {"report_id": identifier, "report_revision": 2},
            ]
        )
    with pytest.raises(ValidationError):
        case_request(report_refs=[{"report_id": uuid4(), "report_revision": 1} for _ in range(21)])
    with pytest.raises(ValidationError):
        PinnedReportRef(report_id=uuid4(), report_revision=True)


def test_new_pins_require_exact_confirmed_sources_in_scope(evidence, tmp_path):
    source, report, _, _, store = evidence
    with pytest.raises(CaseSourceConflict):
        StudentCaseStore(tmp_path / "another").save_case(case_request(report))
    draft = source.save_report(str(uuid4()), 0, source_payload(status="draft"))
    with pytest.raises(CaseSourceConflict):
        store.save_case(case_request(draft))
    with pytest.raises(CaseSourceConflict):
        store.save_case(
            case_request(
                report, report_refs=[{"report_id": report["report_id"], "report_revision": 999}]
            )
        )


def test_metadata_only_edits_retain_unavailable_pins_without_erasing_history(evidence):
    source, report, practice, request, store = evidence
    attempt = record(practice, request)
    first = store.save_case(case_request(report))
    with sqlite3.connect(source.db_path) as connection:
        connection.execute(
            "DELETE FROM teaching_report_revisions WHERE report_id=?", (report["report_id"],)
        )
    archived = store.save_case(
        case_request(
            report, case_id=first.case_id, expected_revision=1, label="保留原历史", archived=True
        )
    )
    timeline = store.timeline(first.case_id)
    assert timeline.archived and timeline.source_states[0].status == "unavailable"
    assert timeline.counts.available_reports == 0 and timeline.counts.attempts == 1
    assert str(timeline.events[0].attempt.attempt_id) == attempt["attempt_id"]
    restored = store.save_case(
        case_request(report, case_id=first.case_id, expected_revision=2, label="保留原历史")
    )
    assert restored.report_refs == first.report_refs and not restored.archived
    assert store.revisions(first.case_id) == [restored, archived, first]
    with pytest.raises(CaseSourceConflict):
        store.save_case(case_request(report))
    removed = store.save_case(
        case_request(case_id=first.case_id, expected_revision=3, label="保留原历史")
    )
    with pytest.raises(CaseSourceConflict):
        store.save_case(
            case_request(report, case_id=first.case_id, expected_revision=removed.revision)
        )


def test_exact_old_pin_beyond_last_hundred_versions_remains_readable(evidence):
    source, report, _, _, store = evidence
    for revision in range(1, 105):
        source.save_report(
            report["report_id"], revision, source_payload(note=f"revision {revision + 1}")
        )
    assert source.revisions(report["report_id"])[-1]["revision"] == 6
    assert source.get_revision(report["report_id"], 1) == report
    assert source.get_revision(report["report_id"], 101)["revision"] == 101
    saved = store.save_case(case_request(report))
    timeline = store.timeline(saved.case_id)
    assert (
        timeline.source_states[0].status == "stale"
        and timeline.source_states[0].latest_revision == 105
    )
    assert timeline.events[0].report_snapshot.report_revision == 1
    assert timeline.events[0].recorded_at == report["updated_at"]
    with pytest.raises(ReportNotFound):
        source.get_revision(report["report_id"], 106)


def test_source_upgrade_is_a_warning_never_a_silent_refresh(evidence):
    source, report, _, _, store = evidence
    saved = store.save_case(case_request(report))
    source.save_report(
        report["report_id"], 1, source_payload(status="draft", note="new teacher draft")
    )
    timeline = store.timeline(saved.case_id)
    assert timeline.source_states[0].status == "stale"
    assert timeline.counts.stale_source_count == 1 and timeline.counts.confirmed_report_count == 1
    assert store.get_case(saved.case_id).report_refs[0].report_revision == 1


def test_joint_counts_distinguish_independent_correct_and_assisted_correct(evidence):
    _, report, practice, request, store = evidence
    record(practice, request, assistance="independent", result="correct")
    record(practice, request, assistance="assisted", result="correct")
    record(practice, request, assistance="unknown", result="partial")
    saved = store.save_case(case_request(report))
    counts = store.timeline(saved.case_id, limit=1).counts
    joint = {(row.assistance, row.teacher_result): row.count for row in counts.attempt_outcomes}
    assert (
        len(joint) == 12
        and joint[("independent", "correct")] == joint[("assisted", "correct")] == 1
    )
    assert joint[("unknown", "partial")] == 1 and sum(joint.values()) == 3
    assert counts.report_results.incorrect == 1 and counts.attempt_results.correct == 2
    assert counts.total_events == 4 and counts.attempts == 3


def test_real_pagination_reads_all_attempts_and_counts_independently_of_page(evidence, monkeypatch):
    _, report, practice, request, store = evidence
    monkeypatch.setattr(followups, "time", SimpleNamespace(time=lambda: report["updated_at"] + 1))
    identifiers = {record(practice, request)["attempt_id"] for _ in range(125)}
    saved = store.save_case(case_request(report))
    cursor = None
    events = []
    while True:
        page = store.timeline(saved.case_id, limit=17, cursor=cursor)
        assert page.counts.attempts == 125 and page.counts.total_events == 126
        assert len(page.events) <= 17
        events.extend(page.events)
        cursor = page.next_cursor
        if cursor is None:
            break
    assert len(events) == len({event.event_id for event in events}) == 126
    assert {
        str(event.attempt.attempt_id) for event in events if event.kind == "attempt"
    } == identifiers


def test_attempts_match_exact_immutable_report_revision_even_after_set_update(evidence):
    source, report, practice, request, store = evidence
    old = record(practice, request)
    source.save_report(report["report_id"], 1, source_payload(note="report version 2"))
    revised = request.model_copy(update={"expected_revision": 1, "report_revision": 2})
    practice.save_followup(revised)
    record(practice, revised, assistance="assisted")
    saved = store.save_case(case_request(report))
    page = store.timeline(saved.case_id)
    attempts = [event.attempt for event in page.events if event.kind == "attempt"]
    assert len(attempts) == 1 and str(attempts[0].attempt_id) == old["attempt_id"]
    assert attempts[0].followup_revision == 1 and attempts[0].report_revision == 1


@pytest.mark.parametrize("change", ["attempt", "void", "case", "source"])
def test_cursor_detects_new_data_voids_case_edits_and_source_versions(evidence, change):
    source, report, practice, request, store = evidence
    first_attempt = record(practice, request)
    record(practice, request)
    saved = store.save_case(case_request(report))
    cursor = store.timeline(saved.case_id, limit=1).next_cursor
    assert cursor
    if change == "attempt":
        record(practice, request)
    elif change == "void":
        practice.void_attempt(
            request.followup_id, first_attempt["attempt_id"], "Transcript corrected"
        )
    elif change == "case":
        store.save_case(
            case_request(report, case_id=saved.case_id, expected_revision=1, label="新显示名")
        )
    else:
        source.save_report(report["report_id"], 1, source_payload(note="new revision"))
    with pytest.raises(CaseConflict):
        store.timeline(saved.case_id, limit=1, cursor=cursor)
    fresh = store.timeline(saved.case_id)
    if change == "void":
        assert fresh.counts.attempts == 1 and fresh.counts.voided_attempts == 1
        assert all(
            event.kind != "attempt" or str(event.attempt.attempt_id) != first_attempt["attempt_id"]
            for event in fresh.events
        )


def test_factory_resolves_scope_each_time_and_cursor_cannot_switch_case(
    evidence, tmp_path, monkeypatch
):
    _, report, practice, request, store = evidence
    record(practice, request)
    first = store.save_case(case_request(report))
    second = store.save_case(case_request(report))
    cursor = store.timeline(first.case_id, limit=1).next_cursor
    with pytest.raises(CaseConflict):
        store.timeline(second.case_id, cursor=cursor)
    selected = ContextVar("student_case_test_scope", default="one")
    monkeypatch.setattr(
        case_storage,
        "get_path_service",
        lambda: SimpleNamespace(get_workspace_dir=lambda: tmp_path / selected.get()),
    )
    own = cases.get_student_case_store().save_case(case_request())
    selected.set("two")
    assert cases.get_student_case_store().list_cases() == []
    with pytest.raises(CaseNotFound):
        cases.get_student_case_store().get_case(own.case_id)


@pytest.mark.parametrize(
    "field,value",
    [("case_id", str(uuid4())), ("revision", 99), ("archived", True), ("updated_at", 1.0)],
)
def test_case_json_must_match_its_real_row_identity_before_read_or_retry(evidence, field, value):
    _, report, _, _, store = evidence
    request = case_request(report)
    first = store.save_case(request)
    altered = first.model_dump(mode="json") | {field: value}
    with sqlite3.connect(store.db_path) as connection:
        connection.execute(
            "UPDATE student_case_revisions SET content_json=? WHERE case_id=?",
            (json.dumps(altered), str(first.case_id)),
        )
    for read in (
        lambda: store.get_case(first.case_id),
        lambda: store.list_cases(),
        lambda: store.revisions(first.case_id),
        lambda: store.save_case(request),
    ):
        with pytest.raises(ValueError):
            read()
    with sqlite3.connect(store.db_path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM student_case_revisions").fetchone()[0] == 1


@pytest.mark.parametrize("field,value", [("label", "合法但被篡改的代号"), ("report_refs", [])])
def test_valid_case_metadata_tampering_cannot_reuse_the_original_request_receipt(
    evidence, field, value
):
    _, report, _, _, store = evidence
    request = case_request(report)
    saved = store.save_case(request)
    altered = saved.model_dump(mode="json") | {field: value}
    serialized = json.dumps(altered)
    with sqlite3.connect(store.db_path) as connection:
        connection.execute(
            "UPDATE student_case_revisions SET content_json=? WHERE case_id=?",
            (serialized, str(saved.case_id)),
        )
    for read in (
        lambda: store.get_case(saved.case_id),
        lambda: store.list_cases(),
        lambda: store.revisions(saved.case_id),
        lambda: store.save_case(request),
    ):
        with pytest.raises(ValueError, match="request receipt"):
            read()
    with sqlite3.connect(store.db_path) as connection:
        rows = connection.execute("SELECT content_json FROM student_case_revisions").fetchall()
    assert len(rows) == 1 and rows[0][0] == serialized


@pytest.mark.parametrize("target", ["case", "report", "followup"])
def test_corrupt_database_is_an_error_not_an_empty_timeline(evidence, target):
    source, report, practice, request, store = evidence
    saved = store.save_case(case_request(report))
    path = (
        store.db_path
        if target == "case"
        else source.db_path
        if target == "report"
        else practice.db_path
    )
    path.write_bytes(b"not a sqlite database")
    with pytest.raises(sqlite3.Error):
        store.timeline(saved.case_id)
    assert path.read_bytes() == b"not a sqlite database"


@pytest.mark.parametrize(
    "table,field,value",
    [
        ("teaching_followup_revisions", "followup_id", str(uuid4())),
        ("teaching_followup_attempts", "report_id", str(uuid4())),
        ("teaching_followup_attempts", "teacher_result", "mastered"),
    ],
)
def test_later_page_semantic_corruption_cannot_be_counted_as_valid(evidence, table, field, value):
    _, report, practice, request, store = evidence
    record(practice, request)
    saved = store.save_case(case_request(report))
    with sqlite3.connect(practice.db_path) as connection:
        row = connection.execute(f"SELECT content_json FROM {table}").fetchone()
        altered = json.loads(row[0]) | {field: value}
        connection.execute(f"UPDATE {table} SET content_json=?", (json.dumps(altered),))
    with pytest.raises(ValueError):
        store.timeline(saved.case_id, limit=1)


@pytest.mark.parametrize(
    "field,value",
    [
        ("source_fingerprint", None),
        ("source_fingerprint", "f" * 64),
        ("teacher_notes", {}),
        ("teacher_notes", "x" * 6001),
    ],
)
def test_corrupt_report_envelope_cannot_appear_as_an_available_source(evidence, field, value):
    source, report, _, _, store = evidence
    saved = store.save_case(case_request(report))
    with sqlite3.connect(source.db_path) as connection:
        content = json.loads(
            connection.execute(
                "SELECT content_json FROM teaching_report_revisions WHERE report_id=?",
                (report["report_id"],),
            ).fetchone()[0]
        )
        content[field] = value
        connection.execute(
            "UPDATE teaching_report_revisions SET content_json=? WHERE report_id=?",
            (json.dumps(content), report["report_id"]),
        )
    with pytest.raises(ValueError):
        store.timeline(saved.case_id)


@pytest.mark.parametrize("revision", [None, 2, "1"])
def test_damaged_practice_version_is_checked_before_exact_pin_filtering(evidence, revision):
    _, report, practice, request, store = evidence
    record(practice, request)
    saved = store.save_case(case_request(report))
    with sqlite3.connect(practice.db_path) as connection:
        content = json.loads(
            connection.execute("SELECT content_json FROM teaching_followup_revisions").fetchone()[0]
        )
        if revision is None:
            content.pop("report_revision")
        else:
            content["report_revision"] = revision
        connection.execute(
            "UPDATE teaching_followup_revisions SET content_json=?", (json.dumps(content),)
        )
    with pytest.raises(ValueError):
        store.timeline(saved.case_id, limit=1)


def test_reparse_storage_is_rejected_before_creating_files(tmp_path, monkeypatch):
    target = tmp_path / "redirected"
    original = Path.lstat

    def lstat(path, *args, **kwargs):
        if path == target:
            return SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=0x400)
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "lstat", lstat)
    monkeypatch.setattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400, raising=False)
    with pytest.raises(ValueError):
        StudentCaseStore(target)
    assert not target.exists()
