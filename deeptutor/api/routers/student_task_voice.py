"""Task-bound local reading text and opt-in transcription candidates only.

Audio is bounded in memory after fresh authorization. No multipart upload,
teacher source lookup, general voice surface, or answer write is involved.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
import logging
from typing import Literal, TypedDict, TypeVar
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from starlette.requests import ClientDisconnect

from deeptutor.api.routers import auth as auth_router
from deeptutor.api.routers.teaching_validation import TeachingAPIRoute
from deeptutor.learning.teaching_analysis.learner_task_models import (
    StudentTaskQuestion,
    StudentTaskView,
)
from deeptutor.learning.teaching_analysis.learner_task_voice import (
    TaskVoiceError,
    get_task_voice_readiness,
    transcribe_task_audio,
)
from deeptutor.learning.teaching_analysis.learner_tasks import (
    TaskConflict,
    TaskNotFound,
    TaskRevoked,
    TaskValidationError,
    get_learner_task_store,
)
from deeptutor.learning.teaching_analysis.task_speech_text import (
    TaskSpeechUnsupported,
    prepare_task_speech,
)
from deeptutor.multi_user.learning_tasks_access import (
    LearningTaskAccessError,
    LearningTaskAccessUnavailable,
    require_task_learner,
    require_task_voice_learner,
)

logger = logging.getLogger(__name__)
router = APIRouter(route_class=TeachingAPIRoute, dependencies=[Depends(auth_router.require_auth)])
MAX_UPLOAD_BYTES = 1_048_576
_UPLOAD_TIMEOUT_SECONDS = 15
_T = TypeVar("_T")
_Locale = Literal["en", "zh"]


class _VoiceAuthFlags(TypedDict):
    auth_enabled: bool
    identity_backend_supported: bool


class _VoiceModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TaskVoiceAvailability(_VoiceModel):
    available: bool
    reason: str | None


class TaskReadAloudAvailability(TaskVoiceAvailability):
    locale: _Locale | None = None


class TaskVoiceLimits(_VoiceModel):
    max_upload_bytes: Literal[1_048_576] = 1_048_576
    max_audio_seconds: Literal[30] = 30
    max_recording_seconds: Literal[25] = 25
    max_transcript_chars: Literal[6000] = 6000


class TaskVoiceCapabilities(_VoiceModel):
    task_id: UUID
    task_revision: int
    question_id: str
    read_aloud: TaskReadAloudAvailability
    transcription: TaskVoiceAvailability
    limits: TaskVoiceLimits = Field(default_factory=TaskVoiceLimits)


class TaskSpeechTextResponse(_VoiceModel):
    task_id: UUID
    task_revision: int
    question_id: str
    text: str = Field(min_length=1, max_length=6000)
    locale: _Locale


class TaskVoiceTranscriptCandidate(_VoiceModel):
    task_id: UUID
    task_revision: int
    question_id: str
    request_id: UUID
    basis_progress_revision: int
    text: str = Field(min_length=1, max_length=6000)
    requires_confirmation: Literal[True] = True


@dataclass(frozen=True)
class _TaskContext:
    recipient_user_id: str
    task: StudentTaskView
    question: StudentTaskQuestion


_SERVICE_ERRORS = {
    "task_voice_request_invalid": (422, "Review the recording request and record again."),
    "task_voice_audio_invalid": (422, "Use a valid uncompressed task recording."),
    "task_voice_audio_too_long": (422, "The recording is too long. Record a shorter answer."),
    "task_voice_audio_too_large": (413, "The recording exceeds the 1 MB upload limit."),
    "task_voice_busy": (429, "Voice input is busy. Wait before recording again."),
    "task_voice_minute_limit": (
        429,
        "Too many recordings this minute. Wait before recording again.",
    ),
    "task_voice_daily_limit": (429, "The daily recording limit has been reached."),
    "task_voice_request_changed": (
        409,
        "This recording id was already used for different content.",
    ),
    "task_voice_request_in_progress": (409, "This recording request is already being processed."),
    "task_voice_result_unavailable": (
        409,
        "This recording result is unavailable. Record again when ready.",
    ),
    "task_voice_failed": (502, "Voice recognition failed. Your answer has not been changed."),
    "task_voice_transcript_invalid": (
        502,
        "Voice recognition did not return a usable short transcript.",
    ),
    "task_voice_timeout": (504, "Voice recognition timed out. Your answer has not been changed."),
    "task_voice_not_configured": (503, "Task voice input is not configured. You can still type."),
    "task_voice_configuration_invalid": (
        503,
        "Task voice input needs an administrator's attention. You can still type.",
    ),
    "task_voice_adapter_unavailable": (
        503,
        "The selected task voice input is unavailable. You can still type.",
    ),
    "task_voice_unavailable": (503, "Task voice input is unavailable. Try again later."),
}
_READINESS_REASONS = {
    "task_voice_not_configured",
    "task_voice_configuration_invalid",
    "task_voice_adapter_unavailable",
    "task_voice_unavailable",
}
_SPEECH_REASONS = {
    "invalid_input",
    "invalid_locale",
    "invalid_unicode",
    "too_long",
    "unsupported_content",
    "unsupported_math",
    "malformed_markup",
    "no_text",
}


def _error(status: int, code: str, message: str, *, retryable: bool = False) -> HTTPException:
    return HTTPException(status, {"error_code": code, "message": message, "retryable": retryable})


@contextmanager
def _safe_errors() -> Iterator[None]:
    try:
        yield
    except (LearningTaskAccessError, LearningTaskAccessUnavailable) as exc:
        raise _error(exc.status_code, exc.code, exc.msg, retryable=exc.status_code >= 500) from None
    except TaskNotFound:
        raise HTTPException(404, "Student task not found.") from None
    except TaskRevoked as exc:
        raise _error(409, "teaching_student_task_revoked", str(exc)) from None
    except TaskConflict as exc:
        raise _error(409, "teaching_student_task_changed", str(exc)) from None
    except TaskValidationError as exc:
        raise HTTPException(422, str(exc)) from None
    except TaskVoiceError as exc:
        status, message = _SERVICE_ERRORS.get(exc.code, _SERVICE_ERRORS["task_voice_unavailable"])
        code = exc.code if exc.code in _SERVICE_ERRORS else "task_voice_unavailable"
        headers = None
        retry_after = exc.retry_after
        if type(retry_after) is int and 0 <= retry_after <= 86400:
            headers = {"Retry-After": str(retry_after)}
        raise HTTPException(
            status,
            {"error_code": code, "message": message, "retryable": bool(exc.retryable)},
            headers=headers,
        ) from None
    except HTTPException:
        raise
    except ClientDisconnect:
        raise _error(
            409,
            "task_voice_result_unavailable",
            "The recording upload ended. Record again when ready.",
        ) from None
    except Exception as exc:
        # Never log audio, a transcript, source text or provider exception text.
        logger.warning("Task voice operation failed (%s)", type(exc).__name__)
        raise _error(
            503, "task_voice_unavailable", "Task voice input is unavailable. Try again later."
        ) from None


async def _work(operation: Callable[[], _T]) -> _T:
    return await asyncio.to_thread(operation)


def _load_context(
    task_id: UUID,
    question_id: str,
    *,
    voice_input: bool = False,
    expected_revision: int | None = None,
) -> _TaskContext:
    flags: _VoiceAuthFlags = {
        "auth_enabled": bool(auth_router.AUTH_ENABLED),
        "identity_backend_supported": not bool(auth_router.POCKETBASE_ENABLED),
    }
    learner = require_task_voice_learner(**flags) if voice_input else require_task_learner(**flags)
    task = get_learner_task_store().get_student_task(learner.id, task_id)
    if task.status == "revoked":
        raise TaskRevoked("This task was revoked. Voice actions are unavailable.")
    if task.status == "submitted":
        raise TaskConflict("This task has already been submitted. Voice actions are unavailable.")
    question = next((item for item in task.questions if item.question_id == question_id), None)
    if question is None:
        raise TaskValidationError("Choose a question from this task.")
    if expected_revision is not None and task.progress.revision != expected_revision:
        raise TaskConflict("The saved answer changed. Reload before recording again.")
    return _TaskContext(learner.id, task, question)


def _queries(request: Request, allowed: set[str]) -> None:
    allowed = allowed | {"dt_workspace"}
    if set(request.query_params) - allowed or any(
        len(request.query_params.getlist(key)) != 1 for key in request.query_params
    ):
        raise _error(422, "task_voice_request_invalid", "Use only the task recording parameters.")


def _speech(context: _TaskContext, locale: _Locale):
    return prepare_task_speech(context.question.question, locale=locale)


def _capabilities(context: _TaskContext, locale: _Locale) -> TaskVoiceCapabilities:
    try:
        prepared = _speech(context, locale)
    except TaskSpeechUnsupported as exc:
        speech_reason = exc.reason if exc.reason in _SPEECH_REASONS else "unsupported_content"
        reading = TaskReadAloudAvailability(available=False, reason=speech_reason)
    else:
        reading = TaskReadAloudAvailability(available=True, reason=None, locale=prepared.locale)
    flags: _VoiceAuthFlags = {
        "auth_enabled": bool(auth_router.AUTH_ENABLED),
        "identity_backend_supported": not bool(auth_router.POCKETBASE_ENABLED),
    }
    try:
        require_task_voice_learner(**flags)
    except LearningTaskAccessError as exc:
        if exc.code != "task_voice_input_disabled":
            raise
        transcription = TaskVoiceAvailability(available=False, reason=exc.code)
    else:
        try:
            readiness = get_task_voice_readiness()
            readiness_reason = readiness.reason
            if readiness_reason is not None and readiness_reason not in _READINESS_REASONS:
                readiness_reason = "task_voice_unavailable"
            if readiness.available is not True and readiness_reason is None:
                readiness_reason = "task_voice_unavailable"
            transcription = TaskVoiceAvailability(
                available=readiness.available is True and readiness_reason is None,
                reason=readiness_reason,
            )
        except Exception as exc:
            logger.warning("Task voice readiness failed (%s)", type(exc).__name__)
            transcription = TaskVoiceAvailability(available=False, reason="task_voice_unavailable")
    return TaskVoiceCapabilities(
        task_id=context.task.task_id,
        task_revision=context.task.task_revision,
        question_id=context.question.question_id,
        read_aloud=reading,
        transcription=transcription,
    )


async def _audio_body(request: Request) -> bytes:
    media_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if (
        media_type != "audio/wav"
        or len(request.headers.getlist("content-type")) != 1
        or request.headers.get("content-encoding", "identity").lower() != "identity"
    ):
        raise _error(422, "task_voice_audio_invalid", "Upload the uncompressed WAV task recording.")
    declared = request.headers.get("content-length")
    length = None
    if declared is not None:
        if (
            len(request.headers.getlist("content-length")) != 1
            or not declared.isascii()
            or not declared.isdigit()
            or len(declared) > 20
        ):
            raise _error(
                422, "task_voice_request_invalid", "The recording upload length is invalid."
            )
        length = int(declared)
        if length > MAX_UPLOAD_BYTES:
            raise _error(
                413, "task_voice_audio_too_large", "The recording exceeds the 1 MB upload limit."
            )
    data = bytearray()
    try:
        async with asyncio.timeout(_UPLOAD_TIMEOUT_SECONDS):
            async for chunk in request.stream():
                if len(data) + len(chunk) > MAX_UPLOAD_BYTES:
                    raise _error(
                        413,
                        "task_voice_audio_too_large",
                        "The recording exceeds the 1 MB upload limit.",
                    )
                data.extend(chunk)
    except TimeoutError:
        raise _error(
            408,
            "task_voice_upload_timeout",
            "The recording upload took too long. Record again when ready.",
        ) from None
    if not data or length is not None and length != len(data):
        raise _error(
            422, "task_voice_audio_invalid", "The recording upload is empty or incomplete."
        )
    return bytes(data)


async def _recognize_until_disconnect(
    request: Request, context: _TaskContext, request_id: UUID, basis_revision: int, audio: bytes
) -> str:
    """After EOF there is one receive consumer, used only for disconnects.

    ASGI does not necessarily cancel an endpoint when the browser leaves.
    Explicitly cancel the STT coroutine and await its lease-release cleanup;
    this cannot promise that an already attempted provider call was unbilled.
    """

    async def disconnected() -> None:
        while True:
            message = await request.receive()
            if message["type"] == "http.disconnect":
                return
            # Defensive against transports repeating an empty request after
            # EOF. The upload was already bounded and fully consumed above.
            await asyncio.sleep(0.05)

    recognition = asyncio.create_task(
        transcribe_task_audio(
            recipient_user_id=context.recipient_user_id,
            task_id=context.task.task_id,
            question_id=context.question.question_id,
            request_id=request_id,
            basis_revision=basis_revision,
            audio=audio,
        )
    )
    watcher = asyncio.create_task(disconnected())
    try:
        finished, _ = await asyncio.wait(
            {recognition, watcher}, return_when=asyncio.FIRST_COMPLETED
        )
        if watcher in finished:
            raise _error(
                409,
                "task_voice_result_unavailable",
                "The recording request ended. Its recognition was cancelled.",
            )
        return await recognition
    finally:
        for task in (recognition, watcher):
            if not task.done():
                task.cancel()
        await asyncio.gather(recognition, watcher, return_exceptions=True)


@router.get("/{task_id}/voice-capabilities", response_model=TaskVoiceCapabilities)
async def student_task_voice_capabilities(
    task_id: UUID,
    request: Request,
    response: Response,
    question_id: str = Query(min_length=1, max_length=128),
    locale: _Locale = "zh",
) -> TaskVoiceCapabilities:
    with _safe_errors():
        context = await _work(lambda: _load_context(task_id, question_id))
        _queries(request, {"question_id", "locale"})
        capabilities = await _work(lambda: _capabilities(context, locale))
        final = await _work(lambda: _load_context(task_id, question_id))
        response.headers["Cache-Control"] = "no-store"
        return capabilities.model_copy(update={"task_revision": final.task.task_revision})


@router.get("/{task_id}/speech-text", response_model=TaskSpeechTextResponse)
async def student_task_speech_text(
    task_id: UUID,
    request: Request,
    response: Response,
    question_id: str = Query(min_length=1, max_length=128),
    locale: _Locale = "zh",
) -> TaskSpeechTextResponse:
    with _safe_errors():
        context = await _work(lambda: _load_context(task_id, question_id))
        _queries(request, {"question_id", "locale"})
        try:
            prepared = await _work(lambda: _speech(context, locale))
        except TaskSpeechUnsupported:
            raise _error(
                422,
                "task_read_aloud_unavailable",
                "This question cannot be read aloud reliably. Read its original text.",
            ) from None
        final = await _work(lambda: _load_context(task_id, question_id))
        response.headers["Cache-Control"] = "no-store"
        return TaskSpeechTextResponse(
            task_id=final.task.task_id,
            task_revision=final.task.task_revision,
            question_id=final.question.question_id,
            text=prepared.text,
            locale=prepared.locale,
        )


@router.post(
    "/{task_id}/transcribe",
    response_model=TaskVoiceTranscriptCandidate,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"audio/wav": {"schema": {"type": "string", "format": "binary"}}},
        }
    },
)
async def transcribe_student_task_recording(
    task_id: UUID,
    request: Request,
    response: Response,
    question_id: str = Query(min_length=1, max_length=128),
    request_id: UUID = Query(),
    expected_revision: int = Query(ge=0),
) -> TaskVoiceTranscriptCandidate:
    with _safe_errors():
        admitted = await _work(
            lambda: _load_context(
                task_id, question_id, voice_input=True, expected_revision=expected_revision
            )
        )
        _queries(request, {"question_id", "request_id", "expected_revision"})
        audio = await _audio_body(request)
        ready = await _work(
            lambda: _load_context(
                task_id, question_id, voice_input=True, expected_revision=expected_revision
            )
        )
        if ready.recipient_user_id != admitted.recipient_user_id or await request.is_disconnected():
            raise _error(
                409,
                "task_voice_result_unavailable",
                "The recording request ended. Record again when ready.",
            )
        try:
            text = await _recognize_until_disconnect(
                request, ready, request_id, expected_revision, audio
            )
        except TaskVoiceError:
            raise
        except HTTPException:
            raise
        except Exception as exc:
            logger.warning("Task voice recognition failed (%s)", type(exc).__name__)
            raise _error(
                502,
                "task_voice_failed",
                "Voice recognition failed. Your answer has not been changed.",
            ) from None
        final = await _work(
            lambda: _load_context(
                task_id, question_id, voice_input=True, expected_revision=expected_revision
            )
        )
        if final.recipient_user_id != admitted.recipient_user_id or await request.is_disconnected():
            raise _error(
                409,
                "task_voice_result_unavailable",
                "The recording request ended. Its candidate was discarded.",
            )
        if not isinstance(text, str) or not text.strip() or len(text) > 6000:
            raise _error(
                502,
                "task_voice_transcript_invalid",
                "Voice recognition did not return a usable short transcript.",
            )
        try:
            text.encode("utf-8")
        except UnicodeError:
            raise _error(
                502,
                "task_voice_transcript_invalid",
                "Voice recognition did not return usable text.",
            ) from None
        response.headers["Cache-Control"] = "no-store"
        return TaskVoiceTranscriptCandidate(
            task_id=final.task.task_id,
            task_revision=final.task.task_revision,
            question_id=final.question.question_id,
            request_id=request_id,
            basis_progress_revision=expected_revision,
            text=text,
        )
