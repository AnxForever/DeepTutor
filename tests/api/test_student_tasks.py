"""Signed identities, fresh policy and allowlisted learner task payloads."""

from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
from types import SimpleNamespace
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from deeptutor.api.routers import auth as auth_router
from deeptutor.api.routers import student_tasks, teaching_analysis, teaching_student_tasks
from deeptutor.learning.teaching_analysis.followup_models import SaveFollowupRequest
from deeptutor.learning.teaching_analysis.followups import FollowupStore
from deeptutor.learning.teaching_analysis.models import AssignmentInput, ReportContent
from deeptutor.learning.teaching_analysis.service import fingerprint_assignment
from deeptutor.learning.teaching_analysis.storage import TeachingAnalysisStore
from deeptutor.multi_user import audit, grants, guardians, identity, paths
from deeptutor.multi_user import learning_tasks_access as access
from deeptutor.multi_user.context import reset_current_user
from deeptutor.services import auth as auth_service
from deeptutor.services.path_service import PathService, get_path_service
from deeptutor.services.workspace import get_content_workspace_service
from deeptutor.services.workspace.activity import WorkspaceActivityMiddleware
from deeptutor.services.workspace.context import workspace_context

TEACHER = "/api/teaching-analysis/student-tasks"
STUDENT = "/api/student-tasks"
PRIVATE_ANSWER = "PRIVATEANSWERP4ONLY739"
PRIVATE_RUBRIC = "PRIVATERUBRICP4ONLY739"
PRIVATE_DIAGNOSIS = "PRIVATEDIAGNOSISP4ONLY739"
PRIVATE_LABEL = "PRIVATESOURCELABELP4ONLY739"
PRIVATE_ORIGINAL = "PRIVATEORIGINALWORKP4ONLY739"
PRIVATE_SOURCE_TITLE = "PRIVATESOURCETITLEP4ONLY739"


@pytest.fixture
def task_api(tmp_path, monkeypatch):
    """Use real JWT decoding, fresh disk identities/grants and scope handling.

    All deployment/account/workspace paths are redirected into tmp_path. No
    guard dependency or identity lookup is replaced by an always-allow stub.
    Administrator accounts retain the project's shared administrator scope.
    """
    admin_root = tmp_path / "data"
    system_root = admin_root / "system"
    for name, value in {
        "PROJECT_ROOT": tmp_path,
        "ADMIN_WORKSPACE_ROOT": admin_root,
        "USERS_ROOT": admin_root / "users",
        "SYSTEM_ROOT": system_root,
        "LEGACY_MULTI_USER_ROOT": tmp_path / "missing-legacy",
        "_path_services": {},
    }.items():
        monkeypatch.setattr(paths, name, value)
    for name, value in {
        "PROJECT_ROOT": tmp_path,
        "SYSTEM_ROOT": system_root,
        "AUTH_DIR": system_root / "auth",
        "USERS_FILE": system_root / "auth" / "users.json",
        "SECRET_FILE": system_root / "auth" / "auth_secret",
        "LEGACY_USERS_FILE": tmp_path / "missing-users.json",
        "LEGACY_SECRET_FILE": tmp_path / "missing-secret",
    }.items():
        monkeypatch.setattr(identity, name, value)
    monkeypatch.setattr(grants, "GRANTS_DIR", system_root / "grants")
    monkeypatch.setattr(guardians, "GUARDIANS_FILE", system_root / "guardians.json")
    monkeypatch.setattr(audit, "SYSTEM_ROOT", system_root)
    monkeypatch.setattr(PathService, "_instance", PathService(admin_root))
    for variable in ("DEEPTUTOR_WORKSPACE_ROOT", "DEEPTUTOR_WORKSPACE_ALLOWED_ROOTS"):
        monkeypatch.delenv(variable, raising=False)
    monkeypatch.setattr(auth_router, "AUTH_ENABLED", True)
    monkeypatch.setattr(auth_router, "POCKETBASE_ENABLED", False)
    monkeypatch.setattr(auth_service, "AUTH_ENABLED", True)
    monkeypatch.setattr(auth_service, "POCKETBASE_ENABLED", False)
    monkeypatch.setattr(auth_service, "AUTH_USERNAME", "")
    monkeypatch.setattr(auth_service, "AUTH_PASSWORD_HASH", "")
    monkeypatch.setattr(
        auth_service, "AUTH_SECRET", "synthetic-task-api-signing-material"
    )  # pragma: allowlist secret

    users = {
        "admin": identity.save_user("administrator", "synthetic-unused-hash", role="admin"),
        "alice": identity.save_user("alice", "synthetic-unused-hash", preset="learner"),
        "bob": identity.save_user("bob", "synthetic-unused-hash", preset="learner"),
        "adult": identity.save_user("adult", "synthetic-unused-hash", role="user"),
        "disabled": identity.save_user("disabled", "synthetic-unused-hash", preset="learner"),
        "blocked": identity.save_user("blocked", "synthetic-unused-hash", preset="learner"),
    }
    for name in ("alice", "bob", "disabled"):
        grants.save_grant(
            users[name]["id"], grants.learner_grant(users[name]["id"], include_tasks=True)
        )
    grants.save_grant(users["blocked"]["id"], grants.learner_grant(users["blocked"]["id"]))
    current = identity.load_users()
    current["disabled"]["disabled"] = True
    identity._write_users(current)

    encoded = {
        name: auth_service.create_token(
            "administrator" if name == "admin" else name,
            row["role"],
            user_id=row["id"],
        )
        for name, row in users.items()
    }
    headers = {name: {"Authorization": f"Bearer {value}"} for name, value in encoded.items()}

    @contextmanager
    def as_admin(workspace=""):
        payload = auth_service.decode_token(encoded["admin"])
        token = auth_router._install_current_user(payload)
        try:
            with workspace_context(workspace):
                yield
        finally:
            reset_current_user(token)

    app = FastAPI()
    app.add_middleware(WorkspaceActivityMiddleware)
    app.include_router(teaching_analysis.router, prefix="/api/teaching-analysis")
    app.include_router(student_tasks.router, prefix=STUDENT)
    with TestClient(app) as client:
        yield SimpleNamespace(
            client=client,
            root=tmp_path,
            admin_root=admin_root,
            system_root=system_root,
            users=users,
            headers=headers,
            encoded=encoded,
            as_admin=as_admin,
        )


def seed_source(api, *, workspace="", count=2):
    with api.as_admin(workspace):
        root = get_path_service().get_workspace_dir() / "teaching-analysis"
        report_store = TeachingAnalysisStore(root)
        assignment = AssignmentInput(
            student_ref=PRIVATE_LABEL,
            assignment_ref="Private original assignment",
            subject="Mathematics",
            grade="Grade 5",
            items=[
                {
                    "question_id": "Q1",
                    "question": "1/2 + 1/3 = ?",
                    "student_answer": "2/5",
                    "student_work": PRIVATE_ORIGINAL,
                    "answer_status": "present",
                    "assistance": "independent",
                }
            ],
        )
        evidence = {"question_id": "Q1", "field": "student_answer", "quote": "2/5"}
        analysis = ReportContent.model_validate(
            {
                "summary": PRIVATE_DIAGNOSIS,
                "items": [
                    {
                        "question_id": "Q1",
                        "result": "incorrect",
                        "observation": "The response was 2/5.",
                        "evidence": [evidence],
                    }
                ],
                "priorities": [
                    {
                        "knowledge_point": PRIVATE_DIAGNOSIS,
                        "observation": "The response was 2/5.",
                        "hypothesis": "The meaning of a common unit needs checking.",
                        "alternative_explanation": "Only one response.",
                        "teaching_action": "Discuss common fraction units.",
                        "follow_up_question": "What is 1/4 + 1/6?",
                        "reference_guidance": PRIVATE_ANSWER,
                        "evidence_status": "supported",
                        "evidence": [evidence],
                    }
                ],
                "limitations": ["One original response only."],
            }
        )
        source_payload = {
            "assignment": assignment.model_dump(mode="json"),
            "analysis": analysis.model_dump(mode="json"),
            "source_fingerprint": fingerprint_assignment(assignment),
            "status": "confirmed",
            "teacher_notes": "",
        }
        report = report_store.save_report(str(uuid4()), 0, source_payload)
        practice_store = FollowupStore(root)
        request = SaveFollowupRequest.model_validate(
            {
                "followup_id": str(uuid4()),
                "expected_revision": 0,
                "report_id": report["report_id"],
                "report_revision": 1,
                "priority_index": 0,
                "title": PRIVATE_SOURCE_TITLE,
                "questions": [
                    {
                        "question_id": f"F{index + 1}",
                        "question": f"Practice question {index + 1}: explain a common fraction unit.",
                        "reference_answer": PRIVATE_ANSWER,
                        "rubric": PRIVATE_RUBRIC,
                    }
                    for index in range(count)
                ],
            }
        )
        practice = practice_store.save_followup(request)
        return SimpleNamespace(
            root=root,
            reports=report_store,
            report=report,
            source_payload=source_payload,
            practices=practice_store,
            practice=practice,
            request=request,
        )


def issue_request(api, source, *, recipient="alice", **changes):
    return {
        "task_id": str(uuid4()),
        "followup_id": source.practice["followup_id"],
        "followup_revision": source.practice["revision"],
        "recipient_user_id": api.users[recipient]["id"],
        "title": "A short fraction check",
        "instructions": "Explain your thinking.",
        **changes,
    }


def issue(api, source, *, recipient="alice", workspace="", **changes):
    payload = issue_request(api, source, recipient=recipient, **changes)
    response = api.client.post(
        TEACHER, params={"dt_workspace": workspace}, json=payload, headers=api.headers["admin"]
    )
    assert response.status_code == 200, response.text
    return response.json(), payload


def responses(source, *, value="Student's own explanation", status="answered"):
    return [
        {
            "question_id": question["question_id"],
            "response_status": status,
            "answer": value if status == "answered" else None,
            "assistance": "independent",
        }
        for question in source.practice["questions"]
    ]


def progress_request(source, *, revision=0, **changes):
    return {
        "request_id": str(uuid4()),
        "expected_revision": revision,
        "current_question_index": 0,
        "responses": responses(source),
        **changes,
    }


def assert_student_safe(value, source):
    forbidden = {
        "source_snapshot",
        "reference_answer",
        "rubric",
        "teacher_result",
        "teacher_feedback",
        "teacher_scope_key",
        "report_id",
        "report_revision",
        "followup_id",
        "followup_revision",
        "source_fingerprint",
        "student_ref",
        "assignment_ref",
        "knowledge_point",
        "recipient_user_id",
        "issued_by_user_id",
        "revoke_reason",
        "path",
        "root",
    }

    def walk(item):
        if isinstance(item, dict):
            assert not forbidden.intersection(item)
            for child in item.values():
                walk(child)
        elif isinstance(item, list):
            for child in item:
                walk(child)

    walk(value)
    text = str(value)
    for marker in (
        PRIVATE_ANSWER,
        PRIVATE_RUBRIC,
        PRIVATE_DIAGNOSIS,
        PRIVATE_LABEL,
        PRIVATE_ORIGINAL,
        PRIVATE_SOURCE_TITLE,
        source.report["report_id"],
        source.report["source_fingerprint"],
    ):
        assert marker not in text


def test_discovery_is_safe_and_auth_off_never_publishes(task_api, monkeypatch):
    api = task_api
    result = api.client.get(TEACHER + "/recipients", headers=api.headers["admin"])
    assert result.status_code == 200, result.text
    data = result.json()
    assert data["enabled"] is True and data["reason"] is None
    rows = {row["user_id"]: row for row in data["recipients"]}
    assert rows[api.users["alice"]["id"]]["can_receive"] is True
    assert rows[api.users["disabled"]["id"]]["reason"] == "account_disabled"
    assert rows[api.users["blocked"]["id"]]["reason"] == "tasks_disabled"
    assert api.users["adult"]["id"] not in rows
    assert all(
        set(row) == {"user_id", "username", "can_receive", "reason"} for row in rows.values()
    )
    source = seed_source(api)
    monkeypatch.setattr(auth_router, "AUTH_ENABLED", False)
    disabled = api.client.get(TEACHER + "/recipients")
    assert disabled.json() == {
        "enabled": False,
        "reason": "authentication_disabled",
        "recipients": [],
    }
    blocked = api.client.post(TEACHER, json=issue_request(api, source))
    assert blocked.status_code == 403
    assert blocked.json()["detail"]["error_code"] == "authentication_disabled"
    assert api.client.get(STUDENT).status_code == 403
    assert not (api.system_root / "student_tasks.sqlite3").exists()


def test_auth_off_cannot_revoke_an_existing_task(task_api, monkeypatch):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source)
    monkeypatch.setattr(auth_router, "AUTH_ENABLED", False)
    response = api.client.post(
        TEACHER + f"/{task['task_id']}/revoke",
        json={"expected_revision": task["task_revision"], "reason": "No authenticated actor"},
    )
    assert response.status_code == 403
    assert response.json()["detail"]["error_code"] == "authentication_disabled"
    monkeypatch.setattr(auth_router, "AUTH_ENABLED", True)
    assert (
        api.client.get(TEACHER + "/" + task["task_id"], headers=api.headers["admin"]).json()[
            "status"
        ]
        == "pending"
    )


def test_real_signed_identity_gets_allowlisted_assigned_snapshot_only(task_api):
    api = task_api
    source = seed_source(api)
    task, request = issue(api, source)
    assert task["source_snapshot"]["questions"][0]["reference_answer"] == PRIVATE_ANSWER
    assert task["recipient_user_id"] == api.users["alice"]["id"]
    listed = api.client.get(STUDENT, headers=api.headers["alice"])
    assert listed.status_code == 200 and len(listed.json()) == 1
    detail = api.client.get(STUDENT + "/" + task["task_id"], headers=api.headers["alice"])
    assert detail.status_code == 200
    value = detail.json()
    assert value["title"] == request["title"] and value["instructions"] == request["instructions"]
    assert value["questions"] == [
        {"question_id": q["question_id"], "question": q["question"]}
        for q in source.practice["questions"]
    ]
    assert value["progress"]["revision"] == 0 and value["submission"] is None
    assert_student_safe(value, source)
    assert_student_safe(listed.json(), source)


def test_known_task_uuid_does_not_allow_another_learner_or_adult(task_api):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source)
    url = STUDENT + "/" + task["task_id"]
    assert api.client.get(STUDENT, headers=api.headers["bob"]).json() == []
    assert api.client.get(url, headers=api.headers["bob"]).status_code == 404
    assert (
        api.client.put(
            url + "/progress", json=progress_request(source), headers=api.headers["bob"]
        ).status_code
        == 404
    )
    assert (
        api.client.post(
            url + "/submit",
            json={
                "submission_id": str(uuid4()),
                "expected_revision": 0,
                "responses": responses(source),
            },
            headers=api.headers["bob"],
        ).status_code
        == 404
    )
    for name in ("admin", "adult", "blocked", "disabled"):
        assert api.client.get(url, headers=api.headers[name]).status_code == 403
    assert api.client.get(url).status_code == 401


@pytest.mark.parametrize("change", ["disabled", "role", "preset", "policy", "deleted"])
def test_old_valid_signed_learner_token_loses_access_immediately(task_api, change, monkeypatch):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source)
    if change in {"disabled", "deleted"}:
        records = identity.load_users()
        if change == "deleted":
            records.pop("alice")
        else:
            records["alice"]["disabled"] = True
        identity._write_users(records)
    elif change == "role":
        identity.set_role("alice", "teacher")
    elif change == "preset":
        identity.set_preset("alice", "standard")
    else:
        grants.save_grant(api.users["alice"]["id"], grants.learner_grant(api.users["alice"]["id"]))
    monkeypatch.setattr(
        student_tasks,
        "get_learner_task_store",
        lambda: pytest.fail("Denied learners must not query central tasks"),
    )
    response = api.client.get(STUDENT + "/" + task["task_id"], headers=api.headers["alice"])
    assert response.status_code == 403
    assert response.json()["detail"]["retryable"] is False
    assert PRIVATE_ANSWER not in response.text


def test_old_admin_token_cannot_issue_after_role_change(task_api):
    api = task_api
    source = seed_source(api)
    identity.set_role("administrator", "user")
    result = api.client.post(TEACHER, json=issue_request(api, source), headers=api.headers["admin"])
    assert result.status_code == 403
    assert result.json()["detail"]["error_code"] == "identity_changed"
    assert not (api.system_root / "student_tasks.sqlite3").exists()


def test_only_existing_eligible_recipient_ids_can_receive_new_tasks(task_api):
    api = task_api
    source = seed_source(api)
    for recipient in ("adult", "disabled", "blocked", "admin"):
        response = api.client.post(
            TEACHER,
            json=issue_request(api, source, recipient=recipient),
            headers=api.headers["admin"],
        )
        assert response.status_code == 403
    unknown = api.client.post(
        TEACHER,
        json=issue_request(api, source, recipient_user_id="not-a-real-user"),
        headers=api.headers["admin"],
    )
    assert unknown.status_code == 403
    assert not (api.system_root / "student_tasks.sqlite3").exists()


def test_progress_cas_retries_and_immutable_submission_are_teacher_read_only(task_api):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source)
    url = STUDENT + "/" + task["task_id"]
    draft = progress_request(source)
    first = api.client.put(url + "/progress", json=draft, headers=api.headers["alice"])
    assert first.status_code == 200, first.text
    assert first.json()["progress"]["revision"] == 1 and first.json()["status"] == "in_progress"
    assert (
        api.client.put(url + "/progress", json=draft, headers=api.headers["alice"]).json()
        == first.json()
    )
    stale = api.client.put(
        url + "/progress", json=progress_request(source), headers=api.headers["alice"]
    )
    assert (
        stale.status_code == 409
        and stale.json()["detail"]["error_code"] == "teaching_student_task_changed"
    )
    second_draft = progress_request(
        source,
        revision=1,
        responses=responses(source, value="A newer explanation"),
        current_question_index=1,
    )
    second = api.client.put(url + "/progress", json=second_draft, headers=api.headers["alice"])
    assert second.status_code == 200 and second.json()["progress"]["revision"] == 2
    assert (
        api.client.put(url + "/progress", json=draft, headers=api.headers["alice"]).json()
        == second.json()
    )
    teacher_draft = api.client.get(
        TEACHER + "/" + task["task_id"], headers=api.headers["admin"]
    ).json()
    assert teacher_draft["submission"] is None
    assert set(teacher_draft["progress"]) == {"revision", "current_question_index", "saved_at"}
    assert "A newer explanation" not in str(teacher_draft["progress"])
    final = {
        "submission_id": str(uuid4()),
        "expected_revision": 2,
        "responses": responses(source, value="Final student's explanation"),
    }
    submitted = api.client.post(url + "/submit", json=final, headers=api.headers["alice"])
    assert submitted.status_code == 200, submitted.text
    assert submitted.json()["status"] == "submitted"
    assert submitted.json()["submission"]["submission_id"] == final["submission_id"]
    assert_student_safe(submitted.json(), source)
    assert (
        api.client.post(url + "/submit", json=final, headers=api.headers["alice"]).json()
        == submitted.json()
    )
    changed = deepcopy(final)
    changed["responses"][0]["answer"] = "A different final answer"
    assert (
        api.client.post(url + "/submit", json=changed, headers=api.headers["alice"]).status_code
        == 409
    )
    assert (
        api.client.put(
            url + "/progress",
            json=progress_request(source, revision=3),
            headers=api.headers["alice"],
        ).status_code
        == 409
    )
    teacher = api.client.get(TEACHER + "/" + task["task_id"], headers=api.headers["admin"]).json()
    assert teacher["submission"] == submitted.json()["submission"]
    assert teacher["source_snapshot"]["questions"][0]["reference_answer"] == PRIVATE_ANSWER
    assert source.practices.attempts(source.practice["followup_id"]) == []
    assert source.reports.get_report(source.report["report_id"])["revision"] == 1
    assert api.client.get(STUDENT, headers=api.headers["alice"]).json() == []
    assert (
        api.client.get(STUDENT + "?state=history", headers=api.headers["alice"]).json()[0][
            "task_id"
        ]
        == task["task_id"]
    )


def test_needs_help_preserves_partial_work_through_progress_and_final_receipts(task_api):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source)
    url = STUDENT + "/" + task["task_id"]
    partial = "我已经把 1/4 改写成 3/12，但还不知道下一步。"
    work = responses(source, status="needs_help")
    work[0]["answer"] = partial
    assert work[1]["answer"] is None  # Existing null-only help remains valid.
    draft = progress_request(source, responses=work)
    saved = api.client.put(url + "/progress", json=draft, headers=api.headers["alice"])
    assert saved.status_code == 200, saved.text
    restored = api.client.get(url, headers=api.headers["alice"])
    assert restored.json()["progress"]["responses"] == work
    assert restored.json()["progress"]["responses"][0]["response_status"] == "needs_help"
    assert restored.json()["progress"]["responses"][0]["answer"] == partial
    teacher_draft = api.client.get(TEACHER + "/" + task["task_id"], headers=api.headers["admin"])
    assert teacher_draft.json()["submission"] is None
    assert "responses" not in teacher_draft.json()["progress"]
    final = {
        "submission_id": str(uuid4()),
        "expected_revision": saved.json()["progress"]["revision"],
        "responses": work,
    }
    submitted = api.client.post(url + "/submit", json=final, headers=api.headers["alice"])
    assert submitted.status_code == 200, submitted.text
    assert submitted.json()["submission"]["responses"] == work
    student_history = api.client.get(url, headers=api.headers["alice"]).json()
    teacher_history = api.client.get(
        TEACHER + "/" + task["task_id"], headers=api.headers["admin"]
    ).json()
    assert student_history["submission"]["responses"] == work
    assert teacher_history["submission"]["responses"] == work
    assert student_history["submission"]["responses"][0]["response_status"] == "needs_help"
    assert student_history["submission"]["responses"][0]["answer"] == partial
    assert all("teacher_result" not in item for item in work)
    assert source.practices.attempts(source.practice["followup_id"]) == []
    assert not list(api.root.rglob("student_cases.sqlite3"))
    assert_student_safe(student_history, source)


def test_source_changes_and_deletion_do_not_rewrite_issued_snapshot_or_receipt(
    task_api, monkeypatch
):
    api = task_api
    source = seed_source(api)
    task, request = issue(api, source)
    source.reports.save_report(
        source.report["report_id"],
        1,
        source.source_payload | {"teacher_notes": "Revised source review"},
    )
    rejected = api.client.post(
        TEACHER, json=issue_request(api, source), headers=api.headers["admin"]
    )
    assert rejected.status_code == 409
    assert rejected.json()["detail"]["error_code"] == "teaching_student_task_source_changed"
    for path in (source.reports.db_path, source.practices.db_path):
        path.rename(path.with_name("retired-" + path.name))

    def source_access(*args, **kwargs):
        pytest.fail("Issued tasks must not reopen teacher source data")

    monkeypatch.setattr(FollowupStore, "get_followup", source_access)
    monkeypatch.setattr(FollowupStore, "get_revision", source_access)
    monkeypatch.setattr(TeachingAnalysisStore, "get_report", source_access)
    assert api.client.post(TEACHER, json=request, headers=api.headers["admin"]).json() == task
    public = api.client.get(STUDENT + "/" + task["task_id"], headers=api.headers["alice"])
    assert public.status_code == 200
    assert_student_safe(public.json(), source)
    assert (
        api.client.get(TEACHER + "/" + task["task_id"], headers=api.headers["admin"]).json() == task
    )


def test_new_issue_requires_the_current_reviewed_practice_revision(task_api):
    api = task_api
    source = seed_source(api)
    edited = source.request.model_copy(
        update={"expected_revision": 1, "title": "Updated reviewed source"}
    )
    current = source.practices.save_followup(edited)
    stale = api.client.post(TEACHER, json=issue_request(api, source), headers=api.headers["admin"])
    assert stale.status_code == 409
    assert stale.json()["detail"]["error_code"] == "teaching_student_task_source_changed"
    valid = api.client.post(
        TEACHER,
        json=issue_request(api, source, followup_revision=current["revision"]),
        headers=api.headers["admin"],
    )
    assert valid.status_code == 200, valid.text
    assert valid.json()["source_snapshot"]["revision"] == current["revision"]


def test_corrupt_source_is_rejected_without_creating_a_task(task_api):
    api = task_api
    source = seed_source(api)
    with sqlite3.connect(source.reports.db_path) as connection:
        row = connection.execute(
            "SELECT content_json FROM teaching_report_revisions WHERE report_id=? AND revision=1",
            (source.report["report_id"],),
        ).fetchone()
        corrupt = json.loads(row[0])
        corrupt["source_fingerprint"] = "0" * 64
        connection.execute(
            "UPDATE teaching_report_revisions SET content_json=? WHERE report_id=? AND revision=1",
            (json.dumps(corrupt), source.report["report_id"]),
        )
    response = api.client.post(
        TEACHER, json=issue_request(api, source), headers=api.headers["admin"]
    )
    assert response.status_code == 503
    assert PRIVATE_LABEL not in response.text
    assert not (api.system_root / "student_tasks.sqlite3").exists()


def test_revoke_retains_drafts_blocks_new_work_and_does_not_expose_private_reason(task_api):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source)
    url = STUDENT + "/" + task["task_id"]
    draft = progress_request(source)
    assert (
        api.client.put(url + "/progress", json=draft, headers=api.headers["alice"]).status_code
        == 200
    )
    stale = api.client.post(
        TEACHER + f"/{task['task_id']}/revoke",
        json={"expected_revision": 1, "reason": "PRIVATE teacher reason"},
        headers=api.headers["admin"],
    )
    assert stale.status_code == 409
    current = api.client.get(TEACHER + "/" + task["task_id"], headers=api.headers["admin"]).json()
    request = {"expected_revision": current["task_revision"], "reason": "PRIVATE teacher reason"}
    revoked = api.client.post(
        TEACHER + f"/{task['task_id']}/revoke", json=request, headers=api.headers["admin"]
    )
    assert revoked.status_code == 200 and revoked.json()["status"] == "revoked"
    assert (
        api.client.post(
            TEACHER + f"/{task['task_id']}/revoke", json=request, headers=api.headers["admin"]
        ).json()
        == revoked.json()
    )
    student = api.client.get(url, headers=api.headers["alice"])
    assert student.status_code == 200 and student.json()["status"] == "revoked"
    assert student.json()["progress"]["responses"] == draft["responses"]
    assert "PRIVATE teacher reason" not in student.text
    blocked = api.client.put(
        url + "/progress", json=progress_request(source, revision=1), headers=api.headers["alice"]
    )
    assert (
        blocked.status_code == 409
        and blocked.json()["detail"]["error_code"] == "teaching_student_task_revoked"
    )
    assert (
        api.client.post(
            url + "/submit",
            json={
                "submission_id": str(uuid4()),
                "expected_revision": 1,
                "responses": responses(source),
            },
            headers=api.headers["alice"],
        ).status_code
        == 409
    )


def test_submitted_receipt_survives_revocation_and_retry(task_api):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source)
    url = STUDENT + "/" + task["task_id"]
    payload = {
        "submission_id": str(uuid4()),
        "expected_revision": 0,
        "responses": responses(source),
    }
    submitted = api.client.post(url + "/submit", json=payload, headers=api.headers["alice"])
    assert submitted.status_code == 200
    current = api.client.get(TEACHER + "/" + task["task_id"], headers=api.headers["admin"]).json()
    revoked = api.client.post(
        TEACHER + f"/{task['task_id']}/revoke",
        json={"expected_revision": current["task_revision"], "reason": "PRIVATE later withdrawal"},
        headers=api.headers["admin"],
    )
    assert revoked.status_code == 200
    retried = api.client.post(url + "/submit", json=payload, headers=api.headers["alice"])
    assert retried.status_code == 200 and retried.json()["status"] == "revoked"
    assert retried.json()["submission"] == submitted.json()["submission"]
    assert "PRIVATE later withdrawal" not in retried.text


def test_student_inbox_is_global_even_when_teacher_workspace_is_archived(task_api):
    api = task_api
    with api.as_admin():
        workspace = get_content_workspace_service().create_workspace("Archived teacher source")
        another = get_content_workspace_service().create_workspace("Another teacher scope")
    source = seed_source(api, workspace=workspace["workspace_id"])
    task, _ = issue(api, source, workspace=workspace["workspace_id"])
    other_params = {"dt_workspace": another["workspace_id"]}
    assert (
        api.client.get(
            TEACHER + "/" + task["task_id"], params=other_params, headers=api.headers["admin"]
        ).status_code
        == 404
    )
    assert (
        api.client.post(
            TEACHER + f"/{task['task_id']}/revoke",
            params=other_params,
            json={"expected_revision": 1, "reason": "Wrong scope"},
            headers=api.headers["admin"],
        ).status_code
        == 404
    )
    with api.as_admin():
        get_content_workspace_service().update_workspace(workspace["workspace_id"], archived=True)
    headers = api.headers["alice"] | {"x-deeptutor-workspace": workspace["workspace_id"]}
    result = api.client.get(STUDENT + "?dt_workspace=", headers=headers)
    assert result.status_code == 200, result.text
    assert result.json()[0]["task_id"] == task["task_id"]
    update = api.client.put(
        STUDENT + f"/{task['task_id']}/progress?dt_workspace=",
        json=progress_request(source),
        headers=headers,
    )
    assert update.status_code == 200, update.text


def test_teacher_lists_filter_source_before_paginating(task_api):
    api = task_api
    first = seed_source(api)
    second = seed_source(api)
    a, _ = issue(api, first)
    issue(api, second)
    b, _ = issue(api, first)
    page = api.client.get(
        TEACHER,
        params={"followup_id": first.practice["followup_id"], "limit": 1, "offset": 1},
        headers=api.headers["admin"],
    )
    assert page.status_code == 200, page.text
    assert page.json()[0]["task_id"] == a["task_id"]
    assert page.json()[0]["task_id"] != b["task_id"]


def test_bad_fields_stay_private_and_do_not_override_the_recipient(task_api):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source)
    payload = progress_request(source)
    payload["recipient_user_id"] = api.users["alice"]["id"]
    payload["responses"][0]["answer"] = "PRIVATE incoming answer must not be echoed"
    response = api.client.put(
        STUDENT + f"/{task['task_id']}/progress", json=payload, headers=api.headers["bob"]
    )
    assert response.status_code == 422
    assert "PRIVATE incoming answer" not in response.text
    assert response.json()["error_code"] == "teaching_invalid_request"
    assert api.client.get(STUDENT + "/not-a-uuid", headers=api.headers["alice"]).status_code == 422
    assert (
        api.client.get(STUDENT + "?state=everything", headers=api.headers["alice"]).status_code
        == 422
    )
    assert (
        api.client.get(
            STUDENT + f"?recipient_user_id={api.users['alice']['id']}", headers=api.headers["bob"]
        ).json()
        == []
    )


def test_storage_failure_is_safe_and_access_revocation_is_not_reclassified(task_api, monkeypatch):
    api = task_api

    def unavailable():
        raise OSError("PRIVATE deployment path")

    monkeypatch.setattr(student_tasks, "get_learner_task_store", unavailable)
    response = api.client.get(STUDENT, headers=api.headers["alice"])
    assert response.status_code == 503
    assert "PRIVATE" not in response.text
    grants.save_grant(api.users["alice"]["id"], grants.learner_grant(api.users["alice"]["id"]))
    denied = api.client.get(STUDENT, headers=api.headers["alice"])
    assert denied.status_code == 403 and denied.json()["detail"]["error_code"] == "tasks_disabled"
