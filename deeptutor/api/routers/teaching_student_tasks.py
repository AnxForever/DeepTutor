"""Explicitly issue reviewed practice snapshots to real learner accounts."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict

from deeptutor.api.routers import auth as auth_router
from deeptutor.api.routers.student_tasks import _execute_task, _task_auth_flags
from deeptutor.api.routers.teaching_validation import TeachingAPIRoute
from deeptutor.learning.teaching_analysis.cases import _validated_report
from deeptutor.learning.teaching_analysis.followup_models import SavedFollowup
from deeptutor.learning.teaching_analysis.followups import FollowupNotFound, FollowupStore
from deeptutor.learning.teaching_analysis.learner_task_models import (
    IssueTaskRequest,
    RevokeTaskRequest,
    TeacherTaskSummary,
    TeacherTaskView,
)
from deeptutor.learning.teaching_analysis.learner_tasks import (
    LearnerTaskStore,
    TaskConflict,
    TaskNotFound,
    get_learner_task_store,
)
from deeptutor.learning.teaching_analysis.storage import ReportNotFound, TeachingAnalysisStore
from deeptutor.multi_user.learning_tasks_access import (
    require_task_admin,
    require_task_recipient,
    task_recipient_setup,
    teacher_task_scope,
)

router = APIRouter(route_class=TeachingAPIRoute, dependencies=[Depends(auth_router.require_admin)])


class TaskRecipient(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: str
    username: str
    can_receive: bool
    reason: str | None


class TaskRecipientSetup(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool
    reason: Literal["authentication_disabled", "unsupported_identity_backend"] | None
    recipients: list[TaskRecipient]


def _source_changed() -> HTTPException:
    return HTTPException(
        409,
        {
            "error_code": "teaching_student_task_source_changed",
            "message": "The reviewed practice source changed. Reload it before sending a new task.",
            "retryable": False,
        },
    )


def _recover_issue(
    store: LearnerTaskStore, scope_key: str, request: IssueTaskRequest
) -> TeacherTaskView | None:
    try:
        existing = store.get_teacher_task(scope_key, request.task_id)
    except TaskNotFound:
        return None
    original = {
        "task_id": str(existing.task_id),
        "followup_id": str(existing.followup_id),
        "followup_revision": existing.followup_revision,
        "recipient_user_id": existing.recipient_user_id,
        "title": existing.title,
        "instructions": existing.instructions,
    }
    if original != request.model_dump(mode="json"):
        raise TaskConflict("This task id was already used for a different assignment.")
    # Recover a committed receipt even if its reviewed source later changed,
    # was deleted, or its recipient can no longer receive new tasks.
    return existing


def _issue_task(request: IssueTaskRequest) -> TeacherTaskView:
    flags = _task_auth_flags()
    require_task_admin(**flags, publishing=True)
    scope = teacher_task_scope(**flags, resolve_source=False)
    store = get_learner_task_store()
    existing = _recover_issue(store, scope.scope_key, request)
    if existing is not None:
        return existing
    require_task_recipient(request.recipient_user_id, **flags)
    source_scope = teacher_task_scope(**flags, resolve_source=True)
    if source_scope.scope_key != scope.scope_key or source_scope.root is None:
        raise _source_changed()
    practice_store = FollowupStore(source_scope.root)
    # Reserve both the practice and source-report databases while validating
    # the current reviewed snapshot and copying it to the central task store.
    # Source locks contain no model call and no student-facing file access.
    with practice_store._connection(source=True) as connection:
        existing = _recover_issue(store, scope.scope_key, request)
        if existing is not None:
            return existing
        if connection is None:
            raise _source_changed()
        connection.execute("BEGIN IMMEDIATE")
        try:
            try:
                snapshot = SavedFollowup.model_validate(
                    practice_store.get_revision(request.followup_id, request.followup_revision)
                )
                current = SavedFollowup.model_validate(
                    practice_store.get_followup(request.followup_id)
                )
                report = TeachingAnalysisStore(source_scope.root).get_report(
                    str(snapshot.report_id)
                )
            except (FollowupNotFound, ReportNotFound):
                raise _source_changed() from None
            report = _validated_report(report, (str(snapshot.report_id), report["revision"]))
            if (
                current.revision != request.followup_revision
                or report["status"] != "confirmed"
                or report["revision"] != snapshot.report_revision
            ):
                raise _source_changed()
            if (
                current.model_dump(mode="json") != snapshot.model_dump(mode="json")
                or report["source_fingerprint"] != snapshot.source_fingerprint
                or any(
                    getattr(snapshot, key) != report["assignment"].get(key, "")
                    for key in ("student_ref", "assignment_ref", "subject", "grade")
                )
                or snapshot.priority_index >= len(report["analysis"]["priorities"])
                or snapshot.knowledge_point
                != report["analysis"]["priorities"][snapshot.priority_index]["knowledge_point"]
            ):
                raise ValueError("The stored practice source is inconsistent.")
            # Recheck recipient eligibility after source I/O. No client path
            # or student label can select the receiving account.
            require_task_recipient(request.recipient_user_id, **flags)
            result = store.issue_task(
                scope.scope_key, request, snapshot, issuer_user_id=scope.actor_user_id
            )
            connection.commit()
            return result
        except BaseException:
            connection.rollback()
            raise


@router.get("/student-tasks/recipients", response_model=TaskRecipientSetup)
async def teaching_task_recipients() -> TaskRecipientSetup:
    return await _execute_task(
        lambda: TaskRecipientSetup.model_validate(task_recipient_setup(**_task_auth_flags()))
    )


@router.get("/student-tasks", response_model=list[TeacherTaskSummary])
async def list_teaching_student_tasks(
    followup_id: UUID | None = None,
    limit: int = Query(default=100, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> list[TeacherTaskSummary]:
    def execute():
        scope = teacher_task_scope(**_task_auth_flags(), resolve_source=False)
        return get_learner_task_store().list_teacher_tasks(
            scope.scope_key, followup_id=followup_id, limit=limit, offset=offset
        )

    return await _execute_task(execute)


@router.post("/student-tasks", response_model=TeacherTaskView)
async def issue_teaching_student_task(payload: IssueTaskRequest) -> TeacherTaskView:
    return await _execute_task(lambda: _issue_task(payload))


@router.get("/student-tasks/{task_id}", response_model=TeacherTaskView)
async def get_teaching_student_task(task_id: UUID) -> TeacherTaskView:
    def execute():
        scope = teacher_task_scope(**_task_auth_flags(), resolve_source=False)
        return get_learner_task_store().get_teacher_task(scope.scope_key, task_id)

    return await _execute_task(execute)


@router.post("/student-tasks/{task_id}/revoke", response_model=TeacherTaskView)
async def revoke_teaching_student_task(
    task_id: UUID, payload: RevokeTaskRequest
) -> TeacherTaskView:
    def execute():
        require_task_admin(**_task_auth_flags(), publishing=True)
        scope = teacher_task_scope(**_task_auth_flags(), resolve_source=False)
        return get_learner_task_store().revoke_task(scope.scope_key, task_id, payload)

    return await _execute_task(execute)
