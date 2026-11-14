"""Task-bound voice actions require fresh consent and never write an answer."""

from __future__ import annotations

import asyncio
import io
import json
from types import SimpleNamespace
from urllib.parse import urlencode
from uuid import uuid4
import wave

from fastapi import Depends
import httpx
import pytest

from deeptutor.api.routers import auth as auth_router
from deeptutor.api.routers import student_task_voice as voice_api
from deeptutor.api.routers import voice as general_voice
from deeptutor.learning.teaching_analysis import learner_task_voice as voice_service
from deeptutor.learning.teaching_analysis.learner_task_models import (
    RevokeTaskRequest,
    SaveTaskProgressRequest,
)
from deeptutor.learning.teaching_analysis.learner_tasks import get_learner_task_store
from deeptutor.learning.teaching_analysis.learner_voice_budget import TaskVoiceBudgetStore
from deeptutor.learning.teaching_analysis.learner_voice_types import TaskVoiceError, VoiceReadiness
from deeptutor.multi_user import grants, identity
from deeptutor.multi_user import learning_tasks_access as access
from tests.api.test_student_tasks import (
    STUDENT,
    TEACHER,
    assert_student_safe,
    issue,
    progress_request,
    responses,
    seed_source,
)
from tests.api.test_student_tasks import (
    task_api as task_api,
)


def opt_in(api, name="alice", *, allowed=True):
    grant = grants.learner_grant(api.users[name]["id"], include_tasks=True)
    grant["learning_policy"]["task_voice_input"] = allowed
    grants.save_grant(api.users[name]["id"], grant)


def wav_audio(frames=800):
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16_000)
        wav.writeframes(b"\x00\x00" * frames)
    return output.getvalue()


def audio_params(*, expected_revision=0, request_id=None, question_id="F1"):
    return {
        "question_id": question_id,
        "request_id": str(request_id or uuid4()),
        "expected_revision": expected_revision,
        "dt_workspace": "",
    }


def post_audio(api, task, *, content=None, params=None, learner="alice", headers=None):
    return api.client.post(
        STUDENT + f"/{task['task_id']}/transcribe",
        params=params if params is not None else audio_params(),
        content=wav_audio() if content is None else content,
        headers=api.headers[learner] | {"Content-Type": "audio/wav"} | (headers or {}),
    )


def fail_transcription(*args, **kwargs):
    pytest.fail("This request must not call speech recognition")


def test_zero_llm_grant_can_read_only_frozen_question_without_voice_opt_in(task_api, monkeypatch):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source)
    assert grants.load_grant(api.users["alice"]["id"])["models"]["llm"] == []
    monkeypatch.setattr(
        voice_api,
        "get_task_voice_readiness",
        lambda: pytest.fail("No opt-in must not inspect STT setup"),
    )
    monkeypatch.setattr(voice_api, "transcribe_task_audio", fail_transcription)
    url = STUDENT + f"/{task['task_id']}"
    caps = api.client.get(
        url + "/voice-capabilities",
        params={"question_id": "F1", "locale": "en", "dt_workspace": ""},
        headers=api.headers["alice"],
    )
    assert caps.status_code == 200, caps.text
    body = caps.json()
    assert body["read_aloud"]["available"] is True
    assert body["transcription"] == {"available": False, "reason": "task_voice_input_disabled"}
    assert body["limits"] == {
        "max_upload_bytes": 1048576,
        "max_audio_seconds": 30,
        "max_recording_seconds": 25,
        "max_transcript_chars": 6000,
    }
    speech = api.client.get(
        url + "/speech-text?question_id=F1&locale=en&dt_workspace=", headers=api.headers["alice"]
    )
    assert speech.status_code == 200, speech.text
    assert "explain a common fraction unit" in speech.json()["text"]
    assert speech.json()["question_id"] == "F1" and speech.json()["locale"] == "en"
    assert speech.headers["cache-control"] == "no-store"
    assert_student_safe(body, source)
    assert_student_safe(speech.json(), source)
    for private_key in ("model", "provider", "base_url", "api_key", "url"):
        assert private_key not in str(body)
    assert not (api.system_root / "student_task_voice.sqlite3").exists()


def test_caps_only_exposes_safe_selected_setup_reason(task_api, monkeypatch):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source)
    opt_in(api)
    monkeypatch.setattr(
        voice_api,
        "get_task_voice_readiness",
        lambda: VoiceReadiness(False, "task_voice_not_configured"),
    )
    url = STUDENT + f"/{task['task_id']}/voice-capabilities?question_id=F1&locale=en"
    response = api.client.get(url, headers=api.headers["alice"])
    assert response.status_code == 200
    assert response.json()["transcription"] == {
        "available": False,
        "reason": "task_voice_not_configured",
    }
    monkeypatch.setattr(
        voice_api,
        "get_task_voice_readiness",
        lambda: VoiceReadiness(True, "https://PRIVATE.invalid/secret-model"),
    )
    hidden = api.client.get(url, headers=api.headers["alice"])
    assert hidden.json()["transcription"] == {
        "available": False,
        "reason": "task_voice_unavailable",
    }
    assert "PRIVATE" not in hidden.text and "secret-model" not in hidden.text


def test_speech_text_does_not_accept_client_text_or_source_overrides(task_api, monkeypatch):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source)
    opt_in(api)
    monkeypatch.setattr(voice_api, "transcribe_task_audio", fail_transcription)
    url = STUDENT + f"/{task['task_id']}/speech-text"
    for key in ("text", "source", "model", "url", "voice"):
        response = api.client.get(
            url, params={"question_id": "F1", key: "PRIVATE override"}, headers=api.headers["alice"]
        )
        assert response.status_code == 422
        assert "PRIVATE override" not in response.text
        capture = post_audio(api, task, params=audio_params() | {key: "PRIVATE override"})
        assert capture.status_code == 422
        assert "PRIVATE override" not in capture.text


def test_denied_opt_in_and_wrong_known_uuid_never_read_raw_body(task_api, monkeypatch):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source)
    monkeypatch.setattr(voice_api, "transcribe_task_audio", fail_transcription)
    reads = []

    def content():
        reads.append(True)
        yield wav_audio()

    denied = post_audio(api, task, content=content())
    assert (
        denied.status_code == 403
        and denied.json()["detail"]["error_code"] == "task_voice_input_disabled"
    )
    assert reads == []
    opt_in(api, "bob")
    wrong = post_audio(api, task, content=content(), learner="bob")
    assert wrong.status_code == 404
    assert reads == []
    assert not (api.system_root / "student_task_voice.sqlite3").exists()


@pytest.mark.parametrize("problem", ["wrong_question", "stale_basis", "submitted", "revoked"])
def test_context_rejected_before_audio_or_provider_spend(task_api, monkeypatch, problem):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source)
    opt_in(api)
    if problem == "submitted":
        result = api.client.post(
            STUDENT + f"/{task['task_id']}/submit",
            json={
                "submission_id": str(uuid4()),
                "expected_revision": 0,
                "responses": responses(source),
            },
            headers=api.headers["alice"],
        )
        assert result.status_code == 200
    elif problem == "revoked":
        assert (
            api.client.post(
                TEACHER + f"/{task['task_id']}/revoke",
                json={"expected_revision": 1, "reason": "Stop this task"},
                headers=api.headers["admin"],
            ).status_code
            == 200
        )
    reads = []

    def content():
        reads.append(True)
        yield wav_audio()

    monkeypatch.setattr(voice_api, "transcribe_task_audio", fail_transcription)
    params = audio_params(
        question_id="not-this-task" if problem == "wrong_question" else "F1",
        expected_revision=9 if problem == "stale_basis" else 0,
    )
    response = post_audio(api, task, content=content(), params=params)
    assert response.status_code == (422 if problem == "wrong_question" else 409)
    assert reads == []
    assert not (api.system_root / "student_task_voice.sqlite3").exists()


def test_raw_upload_declared_and_incremental_limits_precede_recognition(task_api, monkeypatch):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source)
    opt_in(api)
    monkeypatch.setattr(voice_api, "transcribe_task_audio", fail_transcription)
    reads = []

    def declared():
        reads.append(True)
        yield b"unexpected"

    early = post_audio(api, task, content=declared(), headers={"Content-Length": "1048577"})
    assert early.status_code == 413 and reads == []

    def oversized():
        yield b"x" * 600_000
        yield b"x" * 600_000

    bounded = post_audio(api, task, content=oversized())
    assert bounded.status_code == 413
    assert (
        post_audio(
            api, task, headers={"Content-Type": "multipart/form-data; boundary=x"}
        ).status_code
        == 422
    )
    assert post_audio(api, task, headers={"Content-Encoding": "gzip"}).status_code == 422
    assert not (api.system_root / "student_task_voice.sqlite3").exists()


def test_valid_recording_returns_candidate_without_saving_any_answer(task_api, monkeypatch):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source)
    opt_in(api)
    captured = []

    async def recognize(**kwargs):
        captured.append(kwargs)
        return "This is the student's spoken partial answer."

    monkeypatch.setattr(voice_api, "transcribe_task_audio", recognize)
    params = audio_params()
    response = post_audio(api, task, params=params)
    assert response.status_code == 200, response.text
    candidate = response.json()
    assert candidate["requires_confirmation"] is True
    assert candidate["basis_progress_revision"] == 0
    assert candidate["request_id"] == params["request_id"]
    assert candidate["question_id"] == "F1" and candidate["task_id"] == task["task_id"]
    assert candidate["text"] == "This is the student's spoken partial answer."
    assert captured[0]["recipient_user_id"] == api.users["alice"]["id"]
    assert captured[0]["audio"] == wav_audio()
    current = api.client.get(STUDENT + "/" + task["task_id"], headers=api.headers["alice"]).json()
    assert current["progress"]["revision"] == 0
    assert current["submission"] is None
    assert all(
        row["response_status"] == "unanswered" and row["answer"] is None
        for row in current["progress"]["responses"]
    )
    assert source.practices.attempts(source.practice["followup_id"]) == []
    assert_student_safe(candidate, source)


@pytest.mark.parametrize("change", ["progress", "opt_in", "disabled", "revoked", "submitted"])
def test_inflight_result_is_discarded_after_fresh_state_or_access_change(
    task_api, monkeypatch, change
):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source)
    opt_in(api)
    with api.as_admin():
        teacher_scope = access.teacher_task_scope(auth_enabled=True, resolve_source=False).scope_key

    async def recognize(**kwargs):
        if change == "progress":
            get_learner_task_store().save_progress(
                api.users["alice"]["id"],
                task["task_id"],
                SaveTaskProgressRequest.model_validate(progress_request(source)),
            )
        elif change == "opt_in":
            opt_in(api, allowed=False)
        elif change == "disabled":
            users = identity.load_users()
            users["alice"]["disabled"] = True
            identity._write_users(users)
        elif change == "revoked":
            get_learner_task_store().revoke_task(
                teacher_scope,
                task["task_id"],
                RevokeTaskRequest(expected_revision=1, reason="Stop while recognizing"),
            )
        else:
            from deeptutor.learning.teaching_analysis.learner_task_models import SubmitTaskRequest

            get_learner_task_store().submit_task(
                api.users["alice"]["id"],
                task["task_id"],
                SubmitTaskRequest(
                    submission_id=uuid4(), expected_revision=0, responses=responses(source)
                ),
            )
        return "DISCARDEDRECOGNITIONCANDIDATE"

    monkeypatch.setattr(voice_api, "transcribe_task_audio", recognize)
    result = post_audio(api, task)
    assert result.status_code == (403 if change in {"opt_in", "disabled"} else 409), result.text
    assert "DISCARDEDRECOGNITIONCANDIDATE" not in result.text
    assert source.practices.attempts(source.practice["followup_id"]) == []


def test_basis_is_checked_again_after_stream_upload_before_stt(task_api, monkeypatch):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source)
    opt_in(api)
    audio = wav_audio()

    def changed_upload():
        yield audio[:44]
        get_learner_task_store().save_progress(
            api.users["alice"]["id"],
            task["task_id"],
            SaveTaskProgressRequest.model_validate(progress_request(source)),
        )
        yield audio[44:]

    monkeypatch.setattr(voice_api, "transcribe_task_audio", fail_transcription)
    response = post_audio(api, task, content=changed_upload())
    assert response.status_code == 409
    assert response.json()["detail"]["error_code"] == "teaching_student_task_changed"


@pytest.mark.parametrize(
    "code,status",
    [
        ("task_voice_audio_invalid", 422),
        ("task_voice_not_configured", 503),
        ("task_voice_minute_limit", 429),
        ("task_voice_request_changed", 409),
        ("task_voice_failed", 502),
        ("task_voice_timeout", 504),
    ],
)
def test_safe_service_errors_keep_codes_and_hide_provider_text(task_api, monkeypatch, code, status):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source)
    opt_in(api)

    async def error(**kwargs):
        failure = TaskVoiceError(code, retry_after=17)
        failure.message = "PRIVATE upstream https://credentials.invalid/key transcript"
        raise failure

    monkeypatch.setattr(voice_api, "transcribe_task_audio", error)
    result = post_audio(api, task)
    assert result.status_code == status
    assert result.json()["detail"]["error_code"] == code
    assert result.headers["retry-after"] == "17"
    assert "PRIVATE" not in result.text and "credentials.invalid" not in result.text


def test_bad_wav_does_not_admit_a_paid_attempt(task_api, monkeypatch):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source)
    opt_in(api)
    monkeypatch.setattr(voice_service, "_recognize", fail_transcription)
    result = post_audio(api, task, content=b"not a WAV file")
    assert result.status_code == 422
    assert result.json()["detail"]["error_code"] == "task_voice_audio_invalid"
    assert not (api.system_root / "student_task_voice.sqlite3").exists()


def test_actual_budget_and_terminal_replay_never_repeat_provider(task_api, monkeypatch):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source)
    opt_in(api)
    calls = []
    monkeypatch.setattr(
        voice_service, "_resolved_config", lambda path=None: SimpleNamespace(api_key=None)
    )

    async def recognize(audio, config):
        calls.append(True)
        return "A recognized candidate that needs confirmation."

    monkeypatch.setattr(voice_service, "_recognize", recognize)
    first_params = audio_params()
    first = post_audio(api, task, params=first_params)
    assert first.status_code == 200, first.text
    assert post_audio(api, task, params=first_params).json() == first.json()
    assert len(calls) == 1
    monkeypatch.setattr(voice_service, "_candidate_cache", voice_service._CandidateCache())
    expired = post_audio(api, task, params=first_params)
    assert expired.status_code == 409
    assert expired.json()["detail"]["error_code"] == "task_voice_result_unavailable"
    assert len(calls) == 1
    for _ in range(3):
        assert post_audio(api, task).status_code == 200
    limited = post_audio(api, task)
    assert limited.status_code == 429
    assert limited.json()["detail"]["error_code"] == "task_voice_minute_limit"
    assert len(calls) == 4
    budget = TaskVoiceBudgetStore(api.system_root).counters(api.users["alice"]["id"])
    assert budget["minute_calls"] == 4 and budget["day_calls"] == 4 and budget["in_flight"] == 0
    assert (
        api.client.get(STUDENT + "/" + task["task_id"], headers=api.headers["alice"]).json()[
            "progress"
        ]["revision"]
        == 0
    )


@pytest.mark.asyncio
async def test_upload_deadline_stops_before_provider_or_answer_write(task_api, monkeypatch):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source)
    opt_in(api)
    monkeypatch.setattr(voice_api, "_UPLOAD_TIMEOUT_SECONDS", 0.02)
    monkeypatch.setattr(voice_api, "transcribe_task_audio", fail_transcription)

    class SlowAudio(httpx.AsyncByteStream):
        async def __aiter__(self):
            await asyncio.sleep(0.2)
            yield wav_audio()

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=api.client.app), base_url="http://testserver"
    ) as client:
        result = await client.post(
            STUDENT + f"/{task['task_id']}/transcribe",
            params=audio_params(),
            content=SlowAudio(),
            headers=api.headers["alice"] | {"Content-Type": "audio/wav"},
        )
    assert result.status_code == 408
    assert result.json()["detail"]["error_code"] == "task_voice_upload_timeout"
    assert not (api.system_root / "student_task_voice.sqlite3").exists()
    assert (
        api.client.get(STUDENT + "/" + task["task_id"], headers=api.headers["alice"]).json()[
            "progress"
        ]["revision"]
        == 0
    )


@pytest.mark.asyncio
async def test_upload_cancellation_does_not_start_recognition(task_api, monkeypatch):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source)
    opt_in(api)
    monkeypatch.setattr(voice_api, "transcribe_task_audio", fail_transcription)
    started = asyncio.Event()

    class CancelledAudio(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield wav_audio()[:44]
            started.set()
            await asyncio.Future()

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=api.client.app), base_url="http://testserver"
    ) as client:
        request = asyncio.create_task(
            client.post(
                STUDENT + f"/{task['task_id']}/transcribe",
                params=audio_params(),
                content=CancelledAudio(),
                headers=api.headers["alice"] | {"Content-Type": "audio/wav"},
            )
        )
        await asyncio.wait_for(started.wait(), 2)
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request
    assert not (api.system_root / "student_task_voice.sqlite3").exists()
    assert (
        api.client.get(STUDENT + "/" + task["task_id"], headers=api.headers["alice"]).json()[
            "progress"
        ]["revision"]
        == 0
    )


def test_voice_opt_in_does_not_open_generic_voice_endpoints(task_api, monkeypatch):
    api = task_api
    opt_in(api)
    api.client.app.include_router(
        general_voice.router,
        prefix="/api/voice",
        dependencies=[Depends(auth_router.require_learning_surface)],
    )
    monkeypatch.setattr(general_voice, "transcribe_audio", fail_transcription)
    monkeypatch.setattr(general_voice, "synthesize_speech", fail_transcription)
    tts = api.client.post(
        "/api/voice/tts", json={"text": "Arbitrary caller text"}, headers=api.headers["alice"]
    )
    assert tts.status_code == 403
    stt = api.client.post(
        "/api/voice/stt",
        files={"file": ("answer.wav", wav_audio(), "audio/wav")},
        headers=api.headers["alice"],
    )
    assert stt.status_code == 403


@pytest.mark.asyncio
async def test_provider_stage_disconnect_cancels_service_and_releases_lease(task_api, monkeypatch):
    api = task_api
    source = seed_source(api)
    task, _ = issue(api, source)
    opt_in(api)
    started = asyncio.Event()
    cancelled = asyncio.Event()
    calls = []
    monkeypatch.setattr(
        voice_service, "_resolved_config", lambda path=None: SimpleNamespace(api_key=None)
    )

    async def recognize(audio, config):
        calls.append(True)
        started.set()
        try:
            await asyncio.Future()
        finally:
            cancelled.set()

    monkeypatch.setattr(voice_service, "_recognize", recognize)
    params = audio_params()
    audio = wav_audio()
    sent = []
    provided_body = False

    async def receive():
        nonlocal provided_body
        if not provided_body:
            provided_body = True
            return {"type": "http.request", "body": audio, "more_body": False}
        # The client goes away after recognition has started, while the ASGI
        # handler itself remains alive. This is not cancellation by the test.
        await started.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    path = STUDENT + f"/{task['task_id']}/transcribe"
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "scheme": "http",
        "method": "POST",
        "path": path,
        "raw_path": path.encode("ascii"),
        "root_path": "",
        "query_string": urlencode(params).encode("ascii"),
        "server": ("testserver", 80),
        "client": ("127.0.0.1", 12345),
        "headers": [
            (b"host", b"testserver"),
            (b"authorization", api.headers["alice"]["Authorization"].encode("ascii")),
            (b"content-type", b"audio/wav"),
            (b"content-length", str(len(audio)).encode("ascii")),
        ],
    }
    await asyncio.wait_for(api.client.app(scope, receive, send), timeout=3)
    assert cancelled.is_set() and len(calls) == 1
    assert next(item["status"] for item in sent if item["type"] == "http.response.start") == 409
    result = json.loads(
        b"".join(item.get("body", b"") for item in sent if item["type"] == "http.response.body")
    )
    assert result["detail"]["error_code"] == "task_voice_result_unavailable"
    budget = TaskVoiceBudgetStore(api.system_root).counters(api.users["alice"]["id"])
    assert budget["in_flight"] == 0 and budget["minute_calls"] == 1
    assert (
        api.client.get(STUDENT + "/" + task["task_id"], headers=api.headers["alice"]).json()[
            "progress"
        ]["revision"]
        == 0
    )
    replay = post_audio(api, task, params=params)
    assert replay.status_code == 409
    assert len(calls) == 1
