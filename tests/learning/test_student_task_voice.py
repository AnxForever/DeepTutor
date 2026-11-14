"""Task speech recognizes bounded candidates without saving student answers."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import stat
import struct
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4
import wave

import pytest

from deeptutor.learning.teaching_analysis import learner_task_voice as voice
from deeptutor.learning.teaching_analysis.learner_voice_budget import (
    TaskVoiceBudgetStore,
    VoiceIntent,
)
from deeptutor.learning.teaching_analysis.learner_voice_types import TaskVoiceError

KEY = "PRIVATE_TEST_STT_CREDENTIAL_32"
UID = "u_voice_student"


def wav_bytes(frames=160, *, channels=1, width=2, rate=16000):
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(width)
        wav.setframerate(rate)
        wav.writeframes(b"\x00" * (frames * channels * width))
    return output.getvalue()


def metadata_wav(audio, metadata=b"PRIVATE_FILENAME_AND_STUDENT_NAME"):
    part = b"LIST" + len(metadata).to_bytes(4, "little") + metadata + b"\x00" * (len(metadata) % 2)
    content = audio[:36] + part + audio[36:]
    return content[:4] + (len(content) - 8).to_bytes(4, "little") + content[8:]


def catalog():
    return {
        "connections": [],
        "services": {
            "stt": {
                "active_profile_id": "speech",
                "active_model_id": "chosen",
                "profiles": [
                    {
                        "id": "speech",
                        "binding": "openai",
                        "api_key": KEY,
                        "base_url": "https://speech.invalid/v1",
                        "extra_headers": {},
                        "models": [{"id": "chosen", "model": "whisper-1", "language": "zh"}],
                    }
                ],
            }
        },
    }


@pytest.fixture
def environment(tmp_path, monkeypatch):
    from deeptutor.services.voice import adapters

    path = tmp_path / "model_catalog.json"
    path.write_text(json.dumps(catalog()), encoding="utf-8")
    adapter = SimpleNamespace(transcribe=AsyncMock(return_value="我先算到十，后面还没有做完。"))
    monkeypatch.setattr(adapters, "get_stt_adapter", lambda _name: adapter)
    monkeypatch.setattr(voice, "_candidate_cache", voice._CandidateCache())
    return path, tmp_path / "system", adapter


def request(environment, **changes):
    path, root, _ = environment
    return {
        "recipient_user_id": UID,
        "task_id": uuid4(),
        "question_id": "Q1",
        "request_id": uuid4(),
        "basis_revision": 0,
        "audio": wav_bytes(),
        "budget_root": root,
        "catalog_path": path,
        **changes,
    }


def intent(*, uid=UID, **changes):
    return VoiceIntent(
        request_id=uuid4(),
        recipient_user_id=uid,
        task_id=uuid4(),
        question_id="Q1",
        basis_revision=0,
        audio_sha256="f" * 64,
        **changes,
    )


def test_canonical_wav_is_verified_and_metadata_is_removed():
    clean = wav_bytes(160)
    raw = metadata_wav(clean)
    assert voice.validate_task_audio(raw) == clean
    assert b"PRIVATE_FILENAME" not in voice.validate_task_audio(raw)
    with wave.open(io.BytesIO(voice.validate_task_audio(raw)), "rb") as wav:
        assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getnframes()) == (
            1,
            2,
            16000,
            160,
        )


@pytest.mark.parametrize("frames", [1, 480000])
def test_actual_frame_bounds_are_inclusive(frames):
    assert voice.validate_task_audio(wav_bytes(frames)) == wav_bytes(frames)


@pytest.mark.parametrize(
    "audio,code",
    [
        (b"", "task_voice_audio_invalid"),
        (b"\x1aE\xdf\xa3webm", "task_voice_audio_invalid"),
        (wav_bytes(0), "task_voice_audio_invalid"),
        (wav_bytes(480001), "task_voice_audio_too_long"),
        (b"0" * (voice.MAX_AUDIO_BYTES + 1), "task_voice_audio_too_large"),
        (wav_bytes(channels=2), "task_voice_audio_invalid"),
        (wav_bytes(width=1), "task_voice_audio_invalid"),
        (wav_bytes(rate=8000), "task_voice_audio_invalid"),
        (wav_bytes()[:-1], "task_voice_audio_invalid"),
        (wav_bytes() + b"trailing", "task_voice_audio_invalid"),
    ],
)
def test_bad_or_oversized_audio_is_not_forwarded(audio, code):
    with pytest.raises(TaskVoiceError) as error:
        voice.validate_task_audio(audio)
    assert error.value.code == code


@pytest.mark.parametrize("offset,value", [(20, 3), (28, 1), (32, 4), (34, 24)])
def test_pcm_header_values_cannot_disagree_with_the_frames(offset, value):
    raw = bytearray(wav_bytes())
    size = 4 if offset == 28 else 2
    raw[offset : offset + size] = value.to_bytes(size, "little")
    with pytest.raises(TaskVoiceError):
        voice.validate_task_audio(bytes(raw))


def test_duplicate_data_chunks_and_forged_lengths_are_rejected():
    clean = wav_bytes()
    duplicated = clean + b"data" + (2).to_bytes(4, "little") + b"\x00\x00"
    duplicated = duplicated[:4] + (len(duplicated) - 8).to_bytes(4, "little") + duplicated[8:]
    with pytest.raises(TaskVoiceError):
        voice.validate_task_audio(duplicated)
    forged = bytearray(clean)
    forged[40:44] = (999999).to_bytes(4, "little")
    with pytest.raises(TaskVoiceError):
        voice.validate_task_audio(bytes(forged))


def test_readiness_and_empty_counters_are_read_only(tmp_path, monkeypatch):
    from deeptutor.services.config.model_catalog import ModelCatalogService

    def forbidden(*args, **kwargs):
        pytest.fail("Readiness must not load/migrate/save a catalog")

    monkeypatch.setattr(ModelCatalogService, "load", forbidden)
    monkeypatch.setattr(ModelCatalogService, "save", forbidden)
    missing = tmp_path / "missing" / "model_catalog.json"
    assert voice.get_task_voice_readiness(missing).reason == "task_voice_not_configured"
    assert not missing.parent.exists()
    store = TaskVoiceBudgetStore(tmp_path / "absent-budget")
    assert store.counters(UID) == {
        "in_flight": 0,
        "global_in_flight": 0,
        "minute_calls": 0,
        "day_calls": 0,
    }
    assert not store.root.exists()
    path = tmp_path / "selected.json"
    raw = json.dumps(catalog()).encode()
    path.write_bytes(raw)
    assert voice.get_task_voice_readiness(path).available
    assert path.read_bytes() == raw
    assert list(tmp_path.iterdir()) == [path]


@pytest.mark.parametrize(
    "change,reason",
    [
        ({"active_profile_id": None}, "task_voice_not_configured"),
        ({"active_model_id": None}, "task_voice_not_configured"),
        ({"active_profile_id": "absent"}, "task_voice_configuration_invalid"),
        ({"active_model_id": "absent"}, "task_voice_configuration_invalid"),
    ],
)
def test_no_first_profile_or_model_fallback_is_allowed(tmp_path, change, reason):
    payload = catalog()
    payload["services"]["stt"].update(change)
    path = tmp_path / "catalog.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    ready = voice.get_task_voice_readiness(path)
    assert not ready.available and ready.reason == reason


@pytest.mark.parametrize(
    "kind",
    ["mask", "headers_mask", "duplicate_profile", "duplicate_model", "unknown_adapter", "model_8k"],
)
def test_static_readiness_rejects_credentials_and_selection_ambiguity(tmp_path, kind):
    payload = catalog()
    service = payload["services"]["stt"]
    profile = service["profiles"][0]
    if kind == "mask":
        profile["api_key"] = " *** "
    elif kind == "headers_mask":
        profile["extra_headers"] = {"Authorization": "***"}
    elif kind == "duplicate_profile":
        service["profiles"].append(deepcopy(profile))
    elif kind == "duplicate_model":
        profile["models"].append(deepcopy(profile["models"][0]))
    elif kind == "unknown_adapter":
        profile["binding"] = "edge"
    else:
        profile["binding"] = "dashscope"
        profile["models"][0]["model"] = "paraformer-realtime-8k-v2"
    path = tmp_path / "catalog.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    assert not voice.get_task_voice_readiness(path).available


@pytest.mark.parametrize(
    "raw",
    [
        b"not json",
        b'{"services":{},"services":{}}',
        b"[]",
        b'{"x":NaN}',
        b'{"x":1e999}',
        b'{"x":"\\ud800"}',
    ],
)
def test_corrupt_catalog_is_not_rewritten_to_defaults(tmp_path, raw):
    path = tmp_path / "catalog.json"
    path.write_bytes(raw)
    ready = voice.get_task_voice_readiness(path)
    assert not ready.available and ready.reason == "task_voice_configuration_invalid"
    assert path.read_bytes() == raw


@pytest.mark.asyncio
async def test_provider_gets_only_clean_wav_and_candidate_does_not_save_task_state(environment):
    path, root, adapter = environment
    raw = metadata_wav(wav_bytes())
    args = request(environment, audio=raw)
    result = await voice.transcribe_task_audio(**args)
    assert result == "我先算到十，后面还没有做完。"
    adapter.transcribe.assert_awaited_once()
    supplied = adapter.transcribe.call_args
    assert supplied.args[0] == wav_bytes()
    assert supplied.kwargs == {"filename": "answer.wav", "content_type": "audio/wav"}
    assert supplied.args[1].request_timeout <= 30
    assert supplied.args[1].language == "zh"
    assert not (root / "student_tasks.sqlite3").exists()
    store = TaskVoiceBudgetStore(root)
    assert store.counters(UID)["day_calls"] == 1 and store.counters(UID)["in_flight"] == 0
    with sqlite3.connect(store.db_path) as connection:
        stored = " ".join(
            str(row) for row in connection.execute("SELECT * FROM task_voice_requests")
        )
    for absent in (result, KEY, "PRIVATE_FILENAME", raw.hex()):
        assert absent not in stored
    assert hashlib.sha256(raw).hexdigest() in stored


@pytest.mark.asyncio
async def test_same_request_replays_ram_candidate_without_a_second_provider_call(
    environment, monkeypatch
):
    _, root, adapter = environment
    args = request(environment)
    result = await voice.transcribe_task_audio(**args)

    def no_config(*args, **kwargs):
        pytest.fail("A completed replay must not resolve the provider again")

    monkeypatch.setattr(voice, "_resolved_config", no_config)
    assert await voice.transcribe_task_audio(**args) == result
    adapter.transcribe.assert_awaited_once()
    assert TaskVoiceBudgetStore(root).counters(UID)["day_calls"] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["uid", "task", "question", "basis", "audio"])
async def test_request_id_cannot_rebind_to_another_body_or_scope(environment, change):
    _, _, adapter = environment
    args = request(environment)
    await voice.transcribe_task_audio(**args)
    altered = dict(args)
    if change == "uid":
        altered["recipient_user_id"] = "u_other"
    elif change == "task":
        altered["task_id"] = uuid4()
    elif change == "question":
        altered["question_id"] = "Q2"
    elif change == "basis":
        altered["basis_revision"] = 1
    else:
        altered["audio"] = metadata_wav(args["audio"])
    with pytest.raises(TaskVoiceError) as error:
        await voice.transcribe_task_audio(**altered)
    assert error.value.code == "task_voice_request_changed"
    adapter.transcribe.assert_awaited_once()


@pytest.mark.asyncio
async def test_terminal_request_without_cached_text_never_calls_provider_again(
    environment, monkeypatch
):
    _, _, adapter = environment
    args = request(environment)
    await voice.transcribe_task_audio(**args)
    monkeypatch.setattr(voice, "_candidate_cache", voice._CandidateCache())
    with pytest.raises(TaskVoiceError) as error:
        await voice.transcribe_task_audio(**args)
    assert error.value.code == "task_voice_result_unavailable"
    adapter.transcribe.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("text", ["", " \n ", "x" * 6001, "\ud800", KEY])
async def test_invalid_transcripts_are_not_truncated_cached_or_written(environment, text):
    _, root, adapter = environment
    adapter.transcribe.return_value = text
    args = request(environment)
    with pytest.raises(TaskVoiceError) as error:
        await voice.transcribe_task_audio(**args)
    assert error.value.code == "task_voice_transcript_invalid"
    assert TaskVoiceBudgetStore(root).counters(UID)["day_calls"] == 1
    assert TaskVoiceBudgetStore(root).counters(UID)["in_flight"] == 0
    with pytest.raises(TaskVoiceError) as replay:
        await voice.transcribe_task_audio(**args)
    assert replay.value.code == "task_voice_result_unavailable"
    adapter.transcribe.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "header,with_prefix", [("Authorization", True), ("AUTHORIZATION", False), ("Api-Key", False)]
)
async def test_provider_echo_of_configured_auth_headers_is_not_returned_or_cached(
    environment, caplog, header, with_prefix
):
    path, root, adapter = environment
    credential = "TASK_VOICE_OFFLINE_HEADER_SENTINEL"
    configured = "Bearer " + credential if header.casefold() == "authorization" else credential
    payload = catalog()
    payload["services"]["stt"]["profiles"][0]["extra_headers"] = {header: configured}
    path.write_text(json.dumps(payload), encoding="utf-8")
    adapter.transcribe.return_value = "recognized: " + (configured if with_prefix else credential)
    args = request(environment)
    with pytest.raises(TaskVoiceError) as error:
        await voice.transcribe_task_audio(**args)
    assert error.value.code == "task_voice_transcript_invalid"
    assert credential not in str(error.value) and credential not in caplog.text
    assert TaskVoiceBudgetStore(root).counters(UID)["in_flight"] == 0
    with pytest.raises(TaskVoiceError) as retry:
        await voice.transcribe_task_audio(**args)
    assert retry.value.code == "task_voice_result_unavailable"
    adapter.transcribe.assert_awaited_once()
    with sqlite3.connect(TaskVoiceBudgetStore(root).db_path) as connection:
        stored = " ".join(
            str(row) for row in connection.execute("SELECT * FROM task_voice_requests")
        )
    assert credential not in stored


@pytest.mark.asyncio
async def test_ordinary_region_and_model_header_words_are_not_treated_as_credentials(environment):
    path, _, adapter = environment
    payload = catalog()
    payload["services"]["stt"]["profiles"][0]["extra_headers"] = {
        "X-Region": "2",
        "X-Model-Tag": "math",
    }
    path.write_text(json.dumps(payload), encoding="utf-8")
    adapter.transcribe.return_value = "2 math"
    assert await voice.transcribe_task_audio(**request(environment)) == "2 math"


@pytest.mark.asyncio
async def test_provider_failure_has_safe_copy_and_attempts_are_not_refunded(environment, caplog):
    _, root, adapter = environment
    adapter.transcribe.side_effect = RuntimeError(KEY + " https://speech.invalid/private")
    with pytest.raises(TaskVoiceError) as error:
        await voice.transcribe_task_audio(**request(environment))
    assert error.value.code == "task_voice_failed"
    assert (
        KEY not in str(error.value)
        and "speech.invalid" not in caplog.text
        and KEY not in caplog.text
    )
    assert TaskVoiceBudgetStore(root).counters(UID)["day_calls"] == 1
    assert TaskVoiceBudgetStore(root).counters(UID)["in_flight"] == 0


@pytest.mark.asyncio
async def test_cancellation_releases_lease_but_not_the_attempted_call(environment):
    _, root, adapter = environment
    entered = asyncio.Event()

    async def wait(*args, **kwargs):
        entered.set()
        await asyncio.Event().wait()

    adapter.transcribe.side_effect = wait
    args = request(environment)
    task = asyncio.create_task(voice.transcribe_task_audio(**args))
    await asyncio.wait_for(entered.wait(), 2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert TaskVoiceBudgetStore(root).counters(UID)["in_flight"] == 0
    assert TaskVoiceBudgetStore(root).counters(UID)["day_calls"] == 1
    with pytest.raises(TaskVoiceError) as error:
        await voice.transcribe_task_audio(**args)
    assert error.value.code == "task_voice_result_unavailable"
    adapter.transcribe.assert_awaited_once()


@pytest.mark.asyncio
async def test_cancellation_during_reservation_cleans_the_new_unattempted_lease(
    environment, monkeypatch
):
    _, root, adapter = environment
    committed, released = threading.Event(), threading.Event()
    original = TaskVoiceBudgetStore.admit

    def delayed(self, value):
        result = original(self, value)
        committed.set()
        released.wait(2)
        return result

    monkeypatch.setattr(TaskVoiceBudgetStore, "admit", delayed)
    job = asyncio.create_task(voice.transcribe_task_audio(**request(environment)))
    assert await asyncio.to_thread(committed.wait, 2)
    job.cancel()
    released.set()
    with pytest.raises(asyncio.CancelledError):
        await job
    assert TaskVoiceBudgetStore(root).counters(UID)["in_flight"] == 0
    assert TaskVoiceBudgetStore(root).counters(UID)["day_calls"] == 0
    adapter.transcribe.assert_not_awaited()


@pytest.mark.asyncio
async def test_timeout_is_safe_and_releases_the_lease(environment, monkeypatch):
    _, root, adapter = environment

    async def slow(*args, **kwargs):
        await asyncio.sleep(1)

    adapter.transcribe.side_effect = slow
    monkeypatch.setattr(voice, "STT_TIMEOUT_SECONDS", 0.01)
    with pytest.raises(TaskVoiceError) as error:
        await voice.transcribe_task_audio(**request(environment))
    assert error.value.code == "task_voice_timeout" and error.value.status_code == 504
    assert TaskVoiceBudgetStore(root).counters(UID)["in_flight"] == 0


def test_budget_admission_is_atomic_for_user_and_global_concurrency(tmp_path):
    store = TaskVoiceBudgetStore(tmp_path / "system")
    first = store.admit(intent())
    with pytest.raises(TaskVoiceError) as busy:
        store.admit(intent())
    assert busy.value.code == "task_voice_busy"
    second = store.admit(intent(uid="u_two"))
    with pytest.raises(TaskVoiceError):
        store.admit(intent(uid="u_three"))
    store.finish(first, "cancelled")
    third = store.admit(intent(uid="u_three"))
    assert third.is_new
    assert store.counters(UID)["global_in_flight"] == 2
    store.finish(second, "cancelled")
    store.finish(third, "cancelled")


def test_same_user_parallel_reservations_have_only_one_winner(tmp_path):
    store = TaskVoiceBudgetStore(tmp_path / "system")

    def reserve(_):
        try:
            return store.admit(intent())
        except TaskVoiceError:
            return None

    with ThreadPoolExecutor(max_workers=3) as executor:
        values = list(executor.map(reserve, range(3)))
    assert sum(value is not None for value in values) == 1
    assert store.counters(UID)["in_flight"] == 1


def test_minute_and_utc_daily_limits_count_attempts_not_successes(tmp_path, monkeypatch):
    store = TaskVoiceBudgetStore(tmp_path / "system")
    clock = [100.0]
    monkeypatch.setattr(store, "_now", lambda: clock[0])
    for _ in range(4):
        admitted = store.admit(intent())
        store.start(admitted)
        store.finish(admitted, "failed")
    with pytest.raises(TaskVoiceError) as error:
        store.admit(intent())
    assert error.value.code == "task_voice_minute_limit"
    clock[0] += 60
    for _ in range(16):
        admitted = store.admit(intent())
        store.start(admitted)
        store.finish(admitted, "failed")
        clock[0] += 61
    assert store.counters(UID)["day_calls"] == 20
    with pytest.raises(TaskVoiceError) as error:
        store.admit(intent())
    assert error.value.code == "task_voice_daily_limit"
    clock[0] = 86400.0
    assert store.admit(intent()).is_new


def test_expired_leases_release_slots_without_recalling_the_old_request(tmp_path, monkeypatch):
    store = TaskVoiceBudgetStore(tmp_path / "system")
    clock = [100.0]
    monkeypatch.setattr(store, "_now", lambda: clock[0])
    original = intent()
    old = store.admit(original)
    store.start(old)
    clock[0] = 160.0
    replacement = store.admit(intent())
    assert replacement.is_new
    replay = store.admit(original)
    assert not replay.is_new and replay.state == "expired"
    assert not store.finish(old, "completed")
    assert store.counters(UID)["in_flight"] == 1


def test_cache_is_bounded_and_expiration_does_not_resurrect_a_result():
    cache = voice._CandidateCache()
    originals = [intent(uid=f"u_{index}") for index in range(129)]
    for item in originals:
        cache.put(item, "候选文字")
    assert len(cache.values) == 128 and cache.get(originals[0]) is None
    key = cache.key(originals[-1])
    cache.values[key] = (0, "过期文字")
    assert cache.get(originals[-1]) is None


@pytest.mark.asyncio
async def test_canonical_wav_never_invokes_native_adapter_temp_or_ffmpeg(monkeypatch):
    from deeptutor.services.voice import audio as audio_module
    from deeptutor.services.voice.adapters import dashscope, volcengine
    from deeptutor.services.voice.config import STTConfig

    def forbidden(*args, **kwargs):
        pytest.fail("Canonical task WAV must not create a temp file or spawn FFmpeg")

    monkeypatch.setattr(audio_module.tempfile, "TemporaryDirectory", forbidden)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", forbidden)
    audio = voice.validate_task_audio(metadata_wav(wav_bytes()))
    assert (
        await dashscope.DashScopeSTTAdapter()._prepare_wav(audio, "answer.wav", "audio/wav")
        == audio
    )
    assert await audio_module.normalize_wav(audio) == audio
    captured = {}

    class Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def post(self, *args, **kwargs):
            captured.update(kwargs)
            return SimpleNamespace(
                status_code=200,
                headers={"X-Api-Status-Code": "20000000"},
                json=lambda: {"result": {"text": "测试候选"}},
            )

    monkeypatch.setattr(volcengine.httpx, "AsyncClient", Client)
    assert (
        await volcengine.VolcengineSTTAdapter().transcribe(
            audio, STTConfig(model="bigmodel", api_key=KEY, base_url="https://speech.invalid")
        )
        == "测试候选"
    )
    assert captured["json"]["audio"]["format"] == "wav"


@pytest.mark.asyncio
async def test_damaged_ledger_does_not_call_provider_or_reset_the_allowance(environment):
    _, root, adapter = environment
    args = request(environment)
    await voice.transcribe_task_audio(**args)
    store = TaskVoiceBudgetStore(root)
    with sqlite3.connect(store.db_path) as connection:
        raw = json.loads(
            connection.execute("SELECT request_json FROM task_voice_requests").fetchone()[0]
        )
        raw["basis_revision"] = 99
        connection.execute("UPDATE task_voice_requests SET request_json=?", (json.dumps(raw),))
    with pytest.raises(TaskVoiceError) as error:
        await voice.transcribe_task_audio(**args)
    assert error.value.code == "task_voice_unavailable"
    adapter.transcribe.assert_awaited_once()


def test_reparse_catalog_is_refused_without_following_or_writing(tmp_path, monkeypatch):
    path = tmp_path / "catalog.json"
    original = Path.lstat

    def lstat(value, *args, **kwargs):
        if value == path:
            return SimpleNamespace(st_mode=stat.S_IFREG, st_file_attributes=0x400)
        return original(value, *args, **kwargs)

    monkeypatch.setattr(Path, "lstat", lstat)
    monkeypatch.setattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400, raising=False)
    assert not voice.get_task_voice_readiness(path).available
    with pytest.raises(ValueError):
        TaskVoiceBudgetStore(path)
    assert not path.exists()
