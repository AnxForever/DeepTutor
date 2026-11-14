"""Teacher review and explicit case overlays never rewrite learner evidence."""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import sqlite3
from uuid import uuid4

import pytest

from deeptutor.api.routers import auth as auth_router
from deeptutor.api.routers import teaching_task_reviews
from deeptutor.multi_user import identity
from deeptutor.services import auth as auth_service
from tests.api.test_student_tasks import (
    PRIVATE_ANSWER,
    PRIVATE_RUBRIC,
    STUDENT,
    TEACHER,
    issue,
    responses,
    seed_source,
)
from tests.api.test_student_tasks import (
    task_api as task_api,
)

BASE = "/api/teaching-analysis"
OPENED_HINT = "OPENEDREVIEWCONTEXTHINTP7ONLY"
FUTURE_HINT = "FUTUREREVIEWCONTEXTHINTP7ONLY"
OTHER_ANSWER = "OTHERQUESTIONANSWERP7ONLY"


def tables(path):
    if not path.exists():
        return set()
    with sqlite3.connect(path) as connection:
        return {
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }


def review_url(task):
    return TEACHER + f"/{task['task_id']}/review"


def complete_task(
    api, source, *, recipient="alice", workspace="", use_hint=False, blank_second=False
):
    extras = (
        {"question_hints": [{"question_id": "F1", "hints": [OPENED_HINT, FUTURE_HINT]}]}
        if use_hint
        else {}
    )
    task, _ = issue(api, source, recipient=recipient, workspace=workspace, **extras)
    if use_hint:
        opened = api.client.post(
            STUDENT + f"/{task['task_id']}/hints/reveal",
            json={"request_id": str(uuid4()), "question_id": "F1", "expected_hint_revision": 0},
            headers=api.headers[recipient],
        )
        assert opened.status_code == 200, opened.text
    work = responses(source)
    if len(work) > 1:
        if blank_second:
            work[1].update(response_status="needs_help", answer=None, assistance="unknown")
        else:
            work[1]["answer"] = OTHER_ANSWER
    payload = {"submission_id": str(uuid4()), "expected_revision": 0, "responses": work}
    result = api.client.post(
        STUDENT + f"/{task['task_id']}/submit", json=payload, headers=api.headers[recipient]
    )
    assert result.status_code == 200, result.text
    return task, result.json(), payload


def review_request(view, *, revision=0, result="partial", blank_second=False, **changes):
    return {
        "request_id": str(uuid4()),
        "submission_id": view["submission"]["submission_id"],
        "expected_revision": revision,
        "items": [
            {
                "question_id": row["question_id"],
                "result": "ungraded" if blank_second and index == 1 else result,
                "feedback": "Teacher checked the submitted work.",
            }
            for index, row in enumerate(view["submission"]["responses"])
        ],
        "summary": "A human review of this final submission.",
        "change_reason": "",
        **changes,
    }


def confirm_review(api, task, view, *, workspace="", **changes):
    payload = review_request(view, **changes)
    response = api.client.post(
        review_url(task),
        params={"dt_workspace": workspace},
        json=payload,
        headers=api.headers["admin"],
    )
    assert response.status_code == 200, response.text
    return response.json(), payload


def create_case(api, source, *, workspace="", linked=True):
    payload = {
        "case_id": str(uuid4()),
        "expected_revision": 0,
        "label": "Anonymous review case",
        "subject": "Mathematics",
        "archived": False,
        "report_refs": [
            {"report_id": source.report["report_id"], "report_revision": source.report["revision"]}
        ]
        if linked
        else [],
    }
    response = api.client.post(
        BASE + "/student-cases",
        params={"dt_workspace": workspace},
        json=payload,
        headers=api.headers["admin"],
    )
    assert response.status_code == 200, response.text
    return response.json(), payload


def overlay_url(case):
    return BASE + f"/student-cases/{case['case_id']}/task-review-evidence"


def evidence_request(case, review, *, revision=0, question_ids=None, **changes):
    return {
        "request_id": str(uuid4()),
        "expected_revision": revision,
        "expected_case_revision": case["revision"],
        "identity_confirmed": True,
        "links": [
            {
                "task_id": review["task_id"],
                "submission_id": review["submission_id"],
                "review_revision": review["revision"],
                "question_ids": question_ids or [review["items"][0]["question_id"]],
                "teacher_observation": "Evidence from the selected response.",
                "next_teaching_action": "Check the common unit independently.",
            }
        ],
        **changes,
    }


def raw_submission(api, task):
    with sqlite3.connect(api.system_root / "student_tasks.sqlite3") as connection:
        return connection.execute(
            "SELECT submission_json,submission_hash FROM student_task_submissions WHERE task_id=?",
            (task["task_id"],),
        ).fetchone()


def test_review_and_overlay_getters_do_not_create_tables_or_require_final(task_api):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source)
    case, _ = create_case(api, source)
    central = api.system_root / "student_tasks.sqlite3"
    case_db = source.root / "student_cases.sqlite3"
    before = (tables(central), tables(case_db))
    state = api.client.get(review_url(task), headers=api.headers["admin"])
    assert state.status_code == 200, state.text
    assert state.json()["submission_id"] is None and state.json()["current_review"] is None
    assert state.headers["cache-control"] == "no-store"
    assert (
        api.client.get(review_url(task) + "/revisions", headers=api.headers["admin"]).json() == []
    )
    assert (
        api.client.get(review_url(task) + "/revisions/1", headers=api.headers["admin"]).status_code
        == 404
    )
    pending = {
        "request_id": str(uuid4()),
        "submission_id": str(uuid4()),
        "expected_revision": 0,
        "items": [
            {"question_id": row["question_id"], "result": "ungraded", "feedback": "No final work"}
            for row in source.practice["questions"]
        ],
        "summary": "",
        "change_reason": "",
    }
    assert (
        api.client.post(review_url(task), json=pending, headers=api.headers["admin"]).status_code
        == 409
    )
    overlay = api.client.get(overlay_url(case), headers=api.headers["admin"])
    assert overlay.status_code == 200, overlay.text
    assert overlay.json()["overlay"] is None and overlay.json()["acknowledged"] is None
    assert overlay.json()["source_states"] == [] and overlay.json()["focus_cards"] == []
    assert (
        api.client.get(overlay_url(case) + "/revisions", headers=api.headers["admin"]).json() == []
    )
    assert (tables(central), tables(case_db)) == before


def test_teacher_review_corrections_withdrawal_restore_and_original_uuid_ack(task_api):
    api = task_api
    source = seed_source(api)
    task, final, _ = complete_task(api, source)
    raw = raw_submission(api, task)
    first, payload = confirm_review(api, task, final)
    assert first["revision"] == 1 and first["status"] == "confirmed"
    assert first["reviewer_user_id"] == api.users["admin"]["id"]
    assert first["recipient_user_id"] == api.users["alice"]["id"]
    assert first["submission_receipt_hash"] == raw[1]
    assert first["report_id"] == source.report["report_id"]
    assert (
        api.client.post(review_url(task), json=payload, headers=api.headers["admin"]).json()
        == first
    )
    missing_reason = review_request(final, revision=1, result="correct")
    assert (
        api.client.post(
            review_url(task), json=missing_reason, headers=api.headers["admin"]
        ).status_code
        == 422
    )
    second, _ = confirm_review(
        api, task, final, revision=1, result="correct", change_reason="Rechecked the reasoning."
    )
    assert second["revision"] == 2
    stale = api.client.post(
        review_url(task), json=review_request(final), headers=api.headers["admin"]
    )
    assert (
        stale.status_code == 409
        and stale.json()["detail"]["error_code"] == "teaching_task_review_changed"
    )
    changed_uuid = deepcopy(payload)
    changed_uuid["items"][0]["feedback"] = "Different intent under the old request id."
    assert (
        api.client.post(
            review_url(task), json=changed_uuid, headers=api.headers["admin"]
        ).status_code
        == 409
    )
    withdrawal = {
        "request_id": str(uuid4()),
        "expected_revision": 2,
        "reason": "This assessment needs correction.",
    }
    withdrawn = api.client.post(
        review_url(task) + "/withdraw", json=withdrawal, headers=api.headers["admin"]
    )
    assert withdrawn.status_code == 200, withdrawn.text
    assert withdrawn.json()["status"] == "withdrawn" and withdrawn.json()["revision"] == 3
    assert (
        api.client.post(
            review_url(task) + "/withdraw", json=withdrawal, headers=api.headers["admin"]
        ).json()
        == withdrawn.json()
    )
    restored, _ = confirm_review(
        api, task, final, revision=3, change_reason="Newly verified assessment."
    )
    assert restored["revision"] == 4 and restored["status"] == "confirmed"
    assert (
        api.client.post(review_url(task), json=payload, headers=api.headers["admin"]).json()
        == first
    )
    assert (
        api.client.get(review_url(task), headers=api.headers["admin"]).json()["current_review"]
        == restored
    )
    assert [
        row["revision"]
        for row in api.client.get(
            review_url(task) + "/revisions", headers=api.headers["admin"]
        ).json()
    ] == [4, 3, 2, 1]
    assert (
        api.client.get(review_url(task) + "/revisions/1", headers=api.headers["admin"]).json()
        == first
    )
    assert (
        api.client.get(review_url(task) + "/revisions/5", headers=api.headers["admin"]).status_code
        == 404
    )
    assert raw_submission(api, task) == raw
    assert (
        api.client.get(STUDENT + "/" + task["task_id"], headers=api.headers["alice"]).json()
        == final
    )
    assert source.practices.attempts(source.practice["followup_id"]) == []


def test_review_cannot_grade_absent_text_or_accept_client_source_overrides(task_api):
    api = task_api
    source = seed_source(api)
    task, final, _ = complete_task(api, source, blank_second=True)
    invalid = api.client.post(
        review_url(task), json=review_request(final, result="correct"), headers=api.headers["admin"]
    )
    assert invalid.status_code == 422
    payload = review_request(final, blank_second=True)
    for changes in (
        {"reviewer_user_id": api.users["bob"]["id"]},
        {"source_snapshot": {"private": "PRIVATE request source"}},
    ):
        response = api.client.post(
            review_url(task), json=payload | changes, headers=api.headers["admin"]
        )
        assert response.status_code == 422
        assert "PRIVATE request source" not in response.text
    changed = deepcopy(payload)
    changed["items"][0]["assistance"] = "independent"
    changed["items"][0]["answer"] = "PRIVATE override answer"
    bad = api.client.post(review_url(task), json=changed, headers=api.headers["admin"])
    assert bad.status_code == 422 and "PRIVATE override answer" not in bad.text
    valid = api.client.post(review_url(task), json=payload, headers=api.headers["admin"])
    assert valid.status_code == 200, valid.text
    assert valid.json()["items"][1]["result"] == "ungraded"
    mismatch = api.client.post(
        review_url(task),
        json=payload
        | {
            "request_id": str(uuid4()),
            "submission_id": str(uuid4()),
            "expected_revision": 1,
            "change_reason": "Wrong final",
        },
        headers=api.headers["admin"],
    )
    assert mismatch.status_code == 409


def test_real_admin_audit_is_not_private_admin_isolation_and_disabled_learner_history_survives(
    task_api,
):
    api = task_api
    source = seed_source(api)
    task, final, _ = complete_task(api, source)
    first, _ = confirm_review(api, task, final)
    current_users = identity.load_users()
    current_users["alice"]["disabled"] = True
    identity._write_users(current_users)
    another = identity.save_user("another-admin", "synthetic-unused-hash", role="admin")
    token = auth_service.create_token("another-admin", "admin", user_id=another["id"])
    headers = {"Authorization": f"Bearer {token}"}
    # Administrators intentionally share the platform's administrator scope.
    assert api.client.get(review_url(task), headers=headers).json()["current_review"] == first
    payload = review_request(
        final, revision=1, change_reason="A second administrator checked the work."
    )
    second = api.client.post(review_url(task), json=payload, headers=headers)
    assert second.status_code == 200, second.text
    assert second.json()["reviewer_user_id"] == another["id"]
    assert second.json()["recipient_user_id"] == api.users["alice"]["id"]
    assert (
        api.client.get(STUDENT + "/" + task["task_id"], headers=api.headers["alice"]).status_code
        == 403
    )


def test_revoked_task_with_final_can_still_have_historical_teacher_review(task_api):
    api = task_api
    source = seed_source(api)
    task, final, _ = complete_task(api, source)
    current = api.client.get(TEACHER + "/" + task["task_id"], headers=api.headers["admin"]).json()
    assert (
        api.client.post(
            TEACHER + f"/{task['task_id']}/revoke",
            json={"expected_revision": current["task_revision"], "reason": "Task closed"},
            headers=api.headers["admin"],
        ).status_code
        == 200
    )
    review, _ = confirm_review(api, task, final)
    assert review["status"] == "confirmed"
    state = api.client.get(review_url(task), headers=api.headers["admin"]).json()
    assert state["task_status"] == "revoked" and state["current_review"] == review


def test_student_and_foreign_workspace_cannot_read_or_write_teacher_reviews(task_api):
    api = task_api
    with api.as_admin():
        from deeptutor.services.workspace import get_content_workspace_service

        workspace = get_content_workspace_service().create_workspace("Review source scope")
    source = seed_source(api, workspace=workspace["workspace_id"])
    task, final, _ = complete_task(api, source, workspace=workspace["workspace_id"])
    review, _ = confirm_review(api, task, final, workspace=workspace["workspace_id"])
    for path in (
        review_url(task),
        review_url(task) + "/revisions",
        review_url(task) + "/revisions/1",
    ):
        assert api.client.get(path, headers=api.headers["alice"]).status_code == 403
        assert api.client.get(path, headers=api.headers["admin"]).status_code == 404
    assert (
        api.client.post(
            review_url(task), json=review_request(final), headers=api.headers["alice"]
        ).status_code
        == 403
    )
    original_scope = api.client.get(
        review_url(task),
        params={"dt_workspace": workspace["workspace_id"]},
        headers=api.headers["admin"],
    )
    assert original_scope.json()["current_review"] == review


def test_auth_off_cannot_confirm_withdraw_or_link_student_evidence(task_api, monkeypatch):
    api = task_api
    source = seed_source(api)
    task, final, _ = complete_task(api, source)
    review, _ = confirm_review(api, task, final)
    case, _ = create_case(api, source)
    monkeypatch.setattr(auth_router, "AUTH_ENABLED", False)
    writes = [
        (review_url(task), review_request(final, revision=1, change_reason="Not authenticated")),
        (
            review_url(task) + "/withdraw",
            {"request_id": str(uuid4()), "expected_revision": 1, "reason": "Not authenticated"},
        ),
        (overlay_url(case), evidence_request(case, review)),
    ]
    for path, payload in writes:
        response = api.client.post(path, json=payload)
        assert response.status_code == 403
        assert response.json()["detail"]["error_code"] == "authentication_disabled"
    monkeypatch.setattr(auth_router, "AUTH_ENABLED", True)
    assert (
        api.client.get(review_url(task), headers=api.headers["admin"]).json()["current_review"]
        == review
    )
    assert api.client.get(overlay_url(case), headers=api.headers["admin"]).json()["overlay"] is None


def test_selected_case_evidence_uses_actual_review_guidance_and_does_not_change_p3(task_api):
    api = task_api
    source = seed_source(api)
    task, final, _ = complete_task(api, source, use_hint=True)
    review, _ = confirm_review(api, task, final, result="correct")
    case, _ = create_case(api, source)
    before_case = api.client.get(
        BASE + f"/student-cases/{case['case_id']}", headers=api.headers["admin"]
    ).json()
    before_timeline = api.client.get(
        BASE + f"/student-cases/{case['case_id']}/timeline", headers=api.headers["admin"]
    ).json()
    payload = evidence_request(case, review)
    result = api.client.post(overlay_url(case), json=payload, headers=api.headers["admin"])
    assert result.status_code == 200, result.text
    view = result.json()
    assert view["acknowledged"]["request_id"] == payload["request_id"]
    assert (
        view["overlay"]["revision"] == 1
        and view["overlay"]["recipient_user_id"] == api.users["alice"]["id"]
    )
    assert view["source_states"][0]["status"] == "current"
    evidence = view["source_states"][0]["questions"]
    assert len(evidence) == 1 and evidence[0]["question_id"] == "F1"
    assert evidence[0]["assistance"] == "assisted" and evidence[0]["result"] == "correct"
    assert evidence[0]["hint_usage"][0]["text"] == OPENED_HINT
    assert FUTURE_HINT not in result.text and OTHER_ANSWER not in result.text
    assert PRIVATE_ANSWER not in result.text and PRIVATE_RUBRIC not in result.text
    card = view["focus_cards"][0]
    assert card["question_count"] == 1 and card["needs_independent_check"] == 1
    assert card["independent_correct"] == 0
    assert (
        api.client.get(
            BASE + f"/student-cases/{case['case_id']}", headers=api.headers["admin"]
        ).json()
        == before_case
    )
    after_timeline = api.client.get(
        BASE + f"/student-cases/{case['case_id']}/timeline", headers=api.headers["admin"]
    ).json()
    assert after_timeline["counts"] == before_timeline["counts"]
    assert [event["event_id"] for event in after_timeline["events"]] == [
        event["event_id"] for event in before_timeline["events"]
    ]
    assert source.practices.attempts(source.practice["followup_id"]) == []


def test_case_overlay_cas_original_ack_and_source_review_replacement_are_explicit(task_api):
    api = task_api
    source = seed_source(api)
    task, final, _ = complete_task(api, source)
    first_review, _ = confirm_review(api, task, final)
    case, _ = create_case(api, source)
    payload = evidence_request(case, first_review)
    saved = api.client.post(overlay_url(case), json=payload, headers=api.headers["admin"])
    assert saved.status_code == 200, saved.text
    assert (
        api.client.post(overlay_url(case), json=payload, headers=api.headers["admin"]).json()[
            "acknowledged"
        ]
        == saved.json()["acknowledged"]
    )
    second_review, _ = confirm_review(
        api, task, final, revision=1, result="incorrect", change_reason="Checked the omitted step."
    )
    stale = api.client.get(overlay_url(case), headers=api.headers["admin"]).json()
    assert stale["overlay"]["links"][0]["review_revision"] == 1
    assert stale["source_states"][0]["status"] == "stale" and stale["focus_cards"] == []
    replacement = evidence_request(case, second_review, revision=1)
    current = api.client.post(overlay_url(case), json=replacement, headers=api.headers["admin"])
    assert current.status_code == 200, current.text
    assert current.json()["overlay"]["revision"] == 2
    assert current.json()["focus_cards"][0]["needs_teaching"] == 1
    retry_old = api.client.post(overlay_url(case), json=payload, headers=api.headers["admin"])
    assert retry_old.status_code == 200
    assert retry_old.json()["acknowledged"]["revision"] == 1
    assert retry_old.json()["overlay"]["revision"] == 2
    conflict = api.client.post(
        overlay_url(case), json=evidence_request(case, second_review), headers=api.headers["admin"]
    )
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["error_code"] == "teaching_case_review_evidence_changed"
    withdrawal = {
        "request_id": str(uuid4()),
        "expected_revision": 2,
        "reason": "Withdraw this result.",
    }
    assert (
        api.client.post(
            review_url(task) + "/withdraw", json=withdrawal, headers=api.headers["admin"]
        ).status_code
        == 200
    )
    withdrawn = api.client.get(overlay_url(case), headers=api.headers["admin"]).json()
    assert withdrawn["source_states"][0]["status"] == "withdrawn" and withdrawn["focus_cards"] == []
    assert [
        row["revision"]
        for row in api.client.get(
            overlay_url(case) + "/revisions", headers=api.headers["admin"]
        ).json()
    ] == [2, 1]


def test_case_link_requires_exact_source_pin_and_explicit_identity_confirmation(task_api):
    api = task_api
    source = seed_source(api)
    task, final, _ = complete_task(api, source)
    review, _ = confirm_review(api, task, final)
    unlinked, _ = create_case(api, source, linked=False)
    invalid = api.client.post(
        overlay_url(unlinked), json=evidence_request(unlinked, review), headers=api.headers["admin"]
    )
    assert invalid.status_code == 409
    assert invalid.json()["detail"]["error_code"] == "teaching_case_review_source_changed"
    case, payload = create_case(api, source)
    evidence = evidence_request(case, review)
    for value in (False, 1, "true"):
        response = api.client.post(
            overlay_url(case),
            json=evidence | {"identity_confirmed": value},
            headers=api.headers["admin"],
        )
        assert response.status_code == 422
    assert (
        api.client.post(
            overlay_url(case),
            json=evidence | {"recipient_user_id": api.users["bob"]["id"]},
            headers=api.headers["admin"],
        ).status_code
        == 422
    )
    renamed = api.client.post(
        BASE + "/student-cases",
        json=payload | {"expected_revision": 1, "label": "Changed case version"},
        headers=api.headers["admin"],
    )
    assert renamed.status_code == 200
    stale_case = api.client.post(overlay_url(case), json=evidence, headers=api.headers["admin"])
    assert stale_case.status_code == 409
    assert api.client.get(overlay_url(case), headers=api.headers["admin"]).json()["overlay"] is None


def test_overlay_does_not_mix_or_silently_rebind_different_real_recipients(task_api):
    api = task_api
    source = seed_source(api)
    alice_task, alice_final, _ = complete_task(api, source)
    alice_review, _ = confirm_review(api, alice_task, alice_final)
    bob_task, bob_final, _ = complete_task(api, source, recipient="bob")
    bob_review, _ = confirm_review(api, bob_task, bob_final)
    case, _ = create_case(api, source)
    alice = evidence_request(case, alice_review)
    bob = evidence_request(case, bob_review)
    mixed = alice | {"links": alice["links"] + bob["links"]}
    assert (
        api.client.post(overlay_url(case), json=mixed, headers=api.headers["admin"]).status_code
        == 409
    )
    assert (
        api.client.post(overlay_url(case), json=alice, headers=api.headers["admin"]).status_code
        == 200
    )
    rebound = bob | {"expected_revision": 1}
    assert (
        api.client.post(overlay_url(case), json=rebound, headers=api.headers["admin"]).status_code
        == 409
    )
    cleared = evidence_request(case, alice_review, revision=1, links=[])
    assert (
        api.client.post(overlay_url(case), json=cleared, headers=api.headers["admin"]).status_code
        == 200
    )
    explicit = bob | {"expected_revision": 2}
    accepted = api.client.post(overlay_url(case), json=explicit, headers=api.headers["admin"])
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["overlay"]["recipient_user_id"] == api.users["bob"]["id"]


def test_revoked_or_unlinked_review_source_does_not_count_as_current_case_evidence(task_api):
    api = task_api
    source = seed_source(api)
    task, final, _ = complete_task(api, source)
    review, _ = confirm_review(api, task, final, result="correct")
    case, case_payload = create_case(api, source)
    assert (
        api.client.post(
            overlay_url(case), json=evidence_request(case, review), headers=api.headers["admin"]
        ).status_code
        == 200
    )
    current_task = api.client.get(
        TEACHER + "/" + task["task_id"], headers=api.headers["admin"]
    ).json()
    assert (
        api.client.post(
            TEACHER + f"/{task['task_id']}/revoke",
            json={
                "expected_revision": current_task["task_revision"],
                "reason": "Closed source task",
            },
            headers=api.headers["admin"],
        ).status_code
        == 200
    )
    view = api.client.get(overlay_url(case), headers=api.headers["admin"]).json()
    assert view["source_states"][0]["status"] == "task_revoked" and view["focus_cards"] == []
    assert (
        api.client.post(
            BASE + "/student-cases",
            json=case_payload | {"expected_revision": 1, "report_refs": []},
            headers=api.headers["admin"],
        ).status_code
        == 200
    )
    after = api.client.get(overlay_url(case), headers=api.headers["admin"]).json()
    assert after["focus_cards"] == []
    assert after["overlay"]["links"] == view["overlay"]["links"]


def test_overlay_is_teacher_only_and_cannot_cross_workspaces(task_api):
    api = task_api
    source = seed_source(api)
    task, final, _ = complete_task(api, source)
    review, _ = confirm_review(api, task, final)
    case, _ = create_case(api, source)
    payload = evidence_request(case, review)
    assert (
        api.client.post(overlay_url(case), json=payload, headers=api.headers["alice"]).status_code
        == 403
    )
    assert api.client.get(overlay_url(case), headers=api.headers["alice"]).status_code == 403
    with api.as_admin():
        from deeptutor.services.workspace import get_content_workspace_service

        workspace = get_content_workspace_service().create_workspace("Other evidence workspace")
    args = {"dt_workspace": workspace["workspace_id"]}
    assert (
        api.client.get(overlay_url(case), params=args, headers=api.headers["admin"]).status_code
        == 404
    )
    assert (
        api.client.post(
            overlay_url(case), params=args, json=payload, headers=api.headers["admin"]
        ).status_code
        == 404
    )


def test_review_errors_do_not_echo_original_answers_or_storage_paths(task_api, monkeypatch):
    api = task_api
    source = seed_source(api)
    task, final, _ = complete_task(api, source)
    payload = review_request(final)
    payload["items"][0]["answer"] = "PRIVATE original answer must not be echoed"
    invalid = api.client.post(review_url(task), json=payload, headers=api.headers["admin"])
    assert invalid.status_code == 422 and "PRIVATE original answer" not in invalid.text
    assert invalid.json()["error_code"] == "teaching_invalid_request"

    def unavailable():
        raise OSError("PRIVATE runtime source path")

    monkeypatch.setattr(teaching_task_reviews, "get_task_review_store", unavailable)
    failed = api.client.get(review_url(task), headers=api.headers["admin"])
    assert failed.status_code == 503 and "PRIVATE" not in failed.text


def test_legacy_submission_keeps_unknown_hint_context_without_rewriting_receipt(task_api):
    api = task_api
    source = seed_source(api)
    task, final, _ = complete_task(api, source)
    raw = json.loads(raw_submission(api, task)[0])
    raw.pop("hint_usage")
    text = json.dumps(
        raw, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    )
    checksum = hashlib.sha256(text.encode()).hexdigest()
    with sqlite3.connect(api.system_root / "student_tasks.sqlite3") as connection:
        connection.execute(
            "UPDATE student_task_submissions SET submission_json=?,submission_hash=? WHERE task_id=?",
            (text, checksum, task["task_id"]),
        )
    legacy = api.client.get(STUDENT + "/" + task["task_id"], headers=api.headers["alice"])
    assert legacy.status_code == 200 and legacy.json()["submission"]["hint_usage"] is None
    review, _ = confirm_review(api, task, legacy.json(), result="correct")
    assert review["submission_receipt_hash"] == checksum
    case, _ = create_case(api, source)
    evidence = api.client.post(
        overlay_url(case), json=evidence_request(case, review), headers=api.headers["admin"]
    )
    assert evidence.status_code == 200, evidence.text
    assert evidence.json()["source_states"][0]["questions"][0]["hint_usage"] is None
    assert evidence.json()["focus_cards"][0]["question_count"] == 1
    assert raw_submission(api, task) == (text, checksum)


def test_deleted_withdrawal_tail_cannot_resurrect_confirmed_case_counts(task_api):
    api = task_api
    source = seed_source(api)
    task, final, _ = complete_task(api, source)
    review, _ = confirm_review(api, task, final, result="correct")
    case, _ = create_case(api, source)
    saved = api.client.post(
        overlay_url(case), json=evidence_request(case, review), headers=api.headers["admin"]
    )
    assert saved.status_code == 200 and saved.json()["focus_cards"][0]["question_count"] == 1
    withdrawal = api.client.post(
        review_url(task) + "/withdraw",
        json={"request_id": str(uuid4()), "expected_revision": 1, "reason": "Withdraw the result."},
        headers=api.headers["admin"],
    )
    assert withdrawal.status_code == 200 and withdrawal.json()["revision"] == 2
    with sqlite3.connect(api.system_root / "student_tasks.sqlite3") as connection:
        connection.execute(
            "DELETE FROM student_task_review_revisions WHERE task_id=? AND revision=2",
            (task["task_id"],),
        )
    broken = api.client.get(review_url(task), headers=api.headers["admin"])
    assert broken.status_code == 503
    projected = api.client.get(overlay_url(case), headers=api.headers["admin"])
    assert projected.status_code == 200
    assert projected.json()["focus_cards"] == []
    assert projected.json()["source_states"][0]["status"] == "unavailable"
