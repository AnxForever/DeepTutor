"""Teacher-authored hints open as an owned, CAS-protected prefix only."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import sqlite3
from uuid import uuid4

import pytest

from deeptutor.multi_user import grants
from tests.api.test_student_tasks import (
    STUDENT,
    TEACHER,
    issue,
    responses,
    seed_source,
)
from tests.api.test_student_tasks import (
    task_api as task_api,
)

FIRST = "FIRSTTEACHERHINTP6ONLY582"
SECOND = "SECONDTEACHERHINTP6ONLY582"
THIRD = "THIRDTEACHERHINTP6ONLY582"
OTHER = "OTHERQUESTIONHINTP6ONLY582"


def plan():
    return [
        {"question_id": "F1", "hints": [FIRST, SECOND, THIRD]},
        {"question_id": "F2", "hints": [OTHER]},
    ]


def reveal_request(*, question_id="F1", revision=0, request_id=None, **changes):
    return {
        "question_id": question_id,
        "request_id": str(request_id or uuid4()),
        "expected_hint_revision": revision,
        **changes,
    }


def hint_url(task):
    return STUDENT + f"/{task['task_id']}/hints"


def question(state, question_id="F1"):
    return next(row for row in state["questions"] if row["question_id"] == question_id)


def test_student_get_only_shows_hint_totals_and_opened_prefix(task_api):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source, question_hints=plan())
    assert task["question_hints"] == plan()
    assert grants.load_grant(api.users["alice"]["id"])["models"]["llm"] == []
    before = api.client.get(hint_url(task), headers=api.headers["alice"])
    assert before.status_code == 200, before.text
    assert before.headers["cache-control"] == "no-store"
    state = before.json()
    assert state["hint_revision"] == 0
    assert question(state)["total"] == 3 and question(state)["revealed"] == []
    assert question(state, "F2")["total"] == 1
    for marker in (FIRST, SECOND, THIRD, OTHER):
        assert marker not in before.text
        assert (
            marker
            not in api.client.get(
                STUDENT + "/" + task["task_id"], headers=api.headers["alice"]
            ).text
        )
        assert marker not in api.client.get(STUDENT, headers=api.headers["alice"]).text
    opened = api.client.post(
        hint_url(task) + "/reveal", json=reveal_request(), headers=api.headers["alice"]
    )
    assert opened.status_code == 200, opened.text
    assert opened.json()["hint_revision"] == 1
    assert question(opened.json())["revealed"][0]["text"] == FIRST
    assert question(opened.json())["revealed"][0]["level"] == 1
    assert question(opened.json())["revealed"][0]["revealed_at"] > 0
    assert all(marker not in opened.text for marker in (SECOND, THIRD, OTHER))
    progress = api.client.get(STUDENT + "/" + task["task_id"], headers=api.headers["alice"]).json()
    assert progress["progress"]["revision"] == 0 and progress["submission"] is None


def test_reveal_retry_returns_latest_prefix_without_opening_another_hint(task_api):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source, question_hints=plan())
    url = hint_url(task) + "/reveal"
    first_request = reveal_request()
    first = api.client.post(url, json=first_request, headers=api.headers["alice"])
    assert first.status_code == 200
    assert (
        api.client.post(url, json=first_request, headers=api.headers["alice"]).json()
        == first.json()
    )
    next_request = reveal_request(revision=1)
    second = api.client.post(url, json=next_request, headers=api.headers["alice"])
    assert second.status_code == 200 and second.json()["hint_revision"] == 2
    assert [entry["text"] for entry in question(second.json())["revealed"]] == [FIRST, SECOND]
    assert (
        api.client.post(url, json=first_request, headers=api.headers["alice"]).json()
        == second.json()
    )
    changed_id = {**first_request, "question_id": "F2"}
    assert api.client.post(url, json=changed_id, headers=api.headers["alice"]).status_code == 409
    assert (
        api.client.post(
            url, json=reveal_request(revision=1), headers=api.headers["alice"]
        ).status_code
        == 409
    )
    assert api.client.get(hint_url(task), headers=api.headers["alice"]).json()["hint_revision"] == 2
    assert THIRD not in second.text


def test_parallel_tabs_cannot_advance_twice_from_one_hint_revision(task_api):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source, question_hints=plan())
    assert api.client.get(hint_url(task), headers=api.headers["alice"]).status_code == 200

    def open_one(_):
        return api.client.post(
            hint_url(task) + "/reveal", json=reveal_request(), headers=api.headers["alice"]
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        answers = list(executor.map(open_one, range(2)))
    assert sorted(response.status_code for response in answers) == [200, 409]
    state = api.client.get(hint_url(task), headers=api.headers["alice"]).json()
    assert state["hint_revision"] == 1
    assert len(question(state)["revealed"]) == 1
    assert SECOND not in str(state)


def test_fresh_recipient_policy_and_known_uuid_are_enforced(task_api):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source, question_hints=plan())
    for suffix in ("", "/reveal"):
        response = (
            api.client.get(hint_url(task), headers=api.headers["bob"])
            if not suffix
            else api.client.post(
                hint_url(task) + suffix, json=reveal_request(), headers=api.headers["bob"]
            )
        )
        assert response.status_code == 404
        assert FIRST not in response.text
    assert api.client.get(hint_url(task)).status_code == 401
    for role in ("admin", "adult", "blocked", "disabled"):
        assert api.client.get(hint_url(task), headers=api.headers[role]).status_code == 403
    grants.save_grant(api.users["alice"]["id"], grants.learner_grant(api.users["alice"]["id"]))
    assert api.client.get(hint_url(task), headers=api.headers["alice"]).status_code == 403
    assert (
        api.client.post(
            hint_url(task) + "/reveal", json=reveal_request(), headers=api.headers["alice"]
        ).status_code
        == 403
    )


@pytest.mark.parametrize("status", ["submitted", "revoked"])
def test_inactive_task_keeps_revealed_prefix_read_only(task_api, status):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source, question_hints=plan())
    first_request = reveal_request()
    opened = api.client.post(
        hint_url(task) + "/reveal", json=first_request, headers=api.headers["alice"]
    )
    assert opened.status_code == 200
    if status == "submitted":
        submitted = api.client.post(
            STUDENT + f"/{task['task_id']}/submit",
            json={
                "submission_id": str(uuid4()),
                "expected_revision": 0,
                "responses": responses(source),
            },
            headers=api.headers["alice"],
        )
        assert submitted.status_code == 200, submitted.text
    else:
        withdrawn = api.client.post(
            TEACHER + f"/{task['task_id']}/revoke",
            json={"expected_revision": 1, "reason": "Stop this assignment"},
            headers=api.headers["admin"],
        )
        assert withdrawn.status_code == 200
    current = api.client.get(hint_url(task), headers=api.headers["alice"])
    assert current.status_code == 200
    assert current.json()["hint_revision"] == 1
    assert question(current.json())["revealed"][0]["text"] == FIRST
    denied = api.client.post(
        hint_url(task) + "/reveal", json=reveal_request(revision=1), headers=api.headers["alice"]
    )
    assert denied.status_code == 409
    assert SECOND not in denied.text
    assert api.client.get(hint_url(task), headers=api.headers["alice"]).json() == current.json()


def test_server_freezes_hint_usage_and_assisted_question_without_grading(task_api):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source, question_hints=plan())
    reveal = api.client.post(
        hint_url(task) + "/reveal", json=reveal_request(), headers=api.headers["alice"]
    )
    assert reveal.status_code == 200
    payload = {
        "submission_id": str(uuid4()),
        "expected_revision": 0,
        "responses": responses(source),
    }
    assert all(row["assistance"] == "independent" for row in payload["responses"])
    final = api.client.post(
        STUDENT + f"/{task['task_id']}/submit", json=payload, headers=api.headers["alice"]
    )
    assert final.status_code == 200, final.text
    submission = final.json()["submission"]
    assert len(submission["hint_usage"]) == 1
    assert submission["hint_usage"][0]["question_id"] == "F1"
    assert submission["hint_usage"][0]["revealed"][0]["level"] == 1
    assert submission["hint_usage"][0]["revealed"][0]["revealed_at"] > 0
    by_question = {row["question_id"]: row for row in submission["responses"]}
    assert by_question["F1"]["assistance"] == "assisted"
    assert by_question["F2"]["assistance"] == "independent"
    # Replay keeps the original request intent, even though the saved receipt
    # truthfully records assistance that the client tried to mark independent.
    assert (
        api.client.post(
            STUDENT + f"/{task['task_id']}/submit", json=payload, headers=api.headers["alice"]
        ).json()
        == final.json()
    )
    teacher = api.client.get(TEACHER + "/" + task["task_id"], headers=api.headers["admin"]).json()
    assert teacher["submission"] == submission
    assert teacher["hint_usage"] == submission["hint_usage"]
    assert teacher["question_hints"] == plan()
    assert source.practices.attempts(source.practice["followup_id"]) == []
    assert not list(api.root.rglob("student_cases.sqlite3"))
    assert "teacher_result" not in str(submission)
    for marker in (SECOND, THIRD, OTHER):
        assert marker not in final.text


def test_invalid_or_cross_source_hint_plan_is_rejected_without_echo(task_api):
    api = task_api
    source = seed_source(api)
    bad_plans = [
        [{"question_id": "not-in-reviewed-source", "hints": [FIRST]}],
        [{"question_id": "F1", "hints": [FIRST]}] * 2,
        [{"question_id": "F1", "hints": [FIRST] * 4}],
        [{"question_id": "F1", "hints": [FIRST * 100]}],
    ]
    for invalid in bad_plans:
        payload = {
            "task_id": str(uuid4()),
            "followup_id": source.practice["followup_id"],
            "followup_revision": 1,
            "recipient_user_id": api.users["alice"]["id"],
            "title": "Reviewed task",
            "instructions": "",
            "question_hints": invalid,
        }
        result = api.client.post(TEACHER, json=payload, headers=api.headers["admin"])
        assert result.status_code == 422, result.text
        assert FIRST not in result.text
    assert api.client.get(STUDENT, headers=api.headers["alice"]).json() == []


def test_request_cannot_choose_future_level_or_another_recipient(task_api):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source, question_hints=plan())
    for changes in ({"level": 3}, {"recipient_user_id": api.users["bob"]["id"]}, {"text": THIRD}):
        result = api.client.post(
            hint_url(task) + "/reveal", json=reveal_request(**changes), headers=api.headers["alice"]
        )
        assert result.status_code == 422
        assert THIRD not in result.text
    assert (
        api.client.post(
            hint_url(task) + "/reveal",
            json=reveal_request(question_id="other-source"),
            headers=api.headers["alice"],
        ).status_code
        == 422
    )
    assert api.client.get(hint_url(task), headers=api.headers["alice"]).json()["hint_revision"] == 0


def _canonical(value):
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    )


def test_legacy_empty_plan_issue_retry_recovers_without_ignoring_new_plan_or_title(task_api):
    api = task_api
    source = seed_source(api)
    task, payload = issue(api, source)
    db = api.system_root / "student_tasks.sqlite3"
    with sqlite3.connect(db) as connection:
        raw = json.loads(
            connection.execute(
                "SELECT issue_json FROM issued_student_tasks WHERE task_id=?", (task["task_id"],)
            ).fetchone()[0]
        )
        raw["request"].pop("question_hints", None)
        text = _canonical(raw)
        connection.execute(
            "UPDATE issued_student_tasks SET issue_json=?,issue_hash=? WHERE task_id=?",
            (text, hashlib.sha256(text.encode()).hexdigest(), task["task_id"]),
        )
    no_field = api.client.post(TEACHER, json=payload, headers=api.headers["admin"])
    assert no_field.status_code == 200, no_field.text
    empty = api.client.post(
        TEACHER, json=payload | {"question_hints": []}, headers=api.headers["admin"]
    )
    assert empty.status_code == 200 and empty.json() == no_field.json()
    assert empty.json()["question_hints"] == []
    assert (
        api.client.post(
            TEACHER, json=payload | {"question_hints": plan()}, headers=api.headers["admin"]
        ).status_code
        == 409
    )
    assert (
        api.client.post(
            TEACHER,
            json=payload | {"title": "A changed assignment intent"},
            headers=api.headers["admin"],
        ).status_code
        == 409
    )
    assert (
        api.client.get(STUDENT, headers=api.headers["alice"]).json()[0]["task_id"]
        == task["task_id"]
    )
    with sqlite3.connect(db) as connection:
        assert connection.execute("SELECT COUNT(*) FROM issued_student_tasks").fetchone()[0] == 1


def test_legacy_submission_usage_is_unknown_and_not_backfilled_by_reads(task_api):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source)
    payload = {
        "submission_id": str(uuid4()),
        "expected_revision": 0,
        "responses": responses(source),
    }
    final = api.client.post(
        STUDENT + f"/{task['task_id']}/submit", json=payload, headers=api.headers["alice"]
    )
    assert final.status_code == 200
    assert final.json()["submission"]["hint_usage"] == []
    db = api.system_root / "student_tasks.sqlite3"
    with sqlite3.connect(db) as connection:
        raw = json.loads(
            connection.execute(
                "SELECT submission_json FROM student_task_submissions WHERE task_id=?",
                (task["task_id"],),
            ).fetchone()[0]
        )
        raw.pop("hint_usage")
        text = _canonical(raw)
        connection.execute(
            "UPDATE student_task_submissions SET submission_json=?,submission_hash=? WHERE task_id=?",
            (text, hashlib.sha256(text.encode()).hexdigest(), task["task_id"]),
        )
    url = STUDENT + "/" + task["task_id"]
    assert (
        api.client.get(url, headers=api.headers["alice"]).json()["submission"]["hint_usage"] is None
    )
    assert api.client.get(hint_url(task), headers=api.headers["alice"]).json()["hint_revision"] == 0
    replay = api.client.post(url + "/submit", json=payload, headers=api.headers["alice"])
    assert replay.status_code == 200 and replay.json()["submission"]["hint_usage"] is None
    teacher = api.client.get(TEACHER + "/" + task["task_id"], headers=api.headers["admin"]).json()
    assert teacher["submission"]["hint_usage"] is None
    with sqlite3.connect(db) as connection:
        assert (
            "hint_usage"
            not in connection.execute(
                "SELECT submission_json FROM student_task_submissions WHERE task_id=?",
                (task["task_id"],),
            ).fetchone()[0]
        )
