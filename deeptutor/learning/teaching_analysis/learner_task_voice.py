"""Task-scoped STT candidates; never updates an answer, draft or submission.

The API owns fresh opt-in/account/task/basis checks before and after awaiting
this service. Only an explicitly selected admin STT profile is used. No speech
synthesis provider is invoked: question listening is device-local elsewhere.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from copy import deepcopy
import hashlib
import io
import json
import logging
from pathlib import Path
import struct
import threading
import time
from typing import Any, Literal
from uuid import UUID
import wave

import httpx
from pydantic import ValidationError

from .learner_voice_budget import TaskVoiceBudgetStore, VoiceAdmission, VoiceIntent
from .learner_voice_types import (
    MAX_AUDIO_BYTES,
    MAX_AUDIO_FRAMES,
    SAMPLE_RATE,
    STT_TIMEOUT_SECONDS,
    TaskVoiceError,
    VoiceReadiness,
)
from .storage import _assert_unredirected

logger = logging.getLogger(__name__)
MAX_CATALOG_BYTES = 1_048_576
CANDIDATE_CACHE_SIZE = 128
CANDIDATE_CACHE_TTL = 300
_AUTH_CREDENTIAL_HEADERS = frozenset(
    {
        "authorization",
        "proxy-authorization",
        "api-key",
        "x-api-key",
        "token",
        "x-token",
        "x-auth-token",
        "x-access-token",
        "x-api-token",
        "x-goog-api-key",
        "x-api-access-key",
        "ocp-apim-subscription-key",
    }
)


def validate_task_audio(audio: bytes) -> bytes:
    """Validate complete RIFF chunks and rewrap only the verified PCM frames."""
    if not isinstance(audio, bytes) or not audio:
        raise TaskVoiceError("task_voice_audio_invalid")
    if len(audio) > MAX_AUDIO_BYTES:
        raise TaskVoiceError("task_voice_audio_too_large")
    if len(audio) < 44 or audio[:4] != b"RIFF" or audio[8:12] != b"WAVE":
        raise TaskVoiceError("task_voice_audio_invalid")
    if int.from_bytes(audio[4:8], "little") + 8 != len(audio):
        raise TaskVoiceError("task_voice_audio_invalid")
    offset, fmt_seen, frames = 12, False, None
    while offset < len(audio):
        if offset + 8 > len(audio):
            raise TaskVoiceError("task_voice_audio_invalid")
        kind = audio[offset : offset + 4]
        size = int.from_bytes(audio[offset + 4 : offset + 8], "little")
        start, end = offset + 8, offset + 8 + size
        padded = end + size % 2
        if end > len(audio) or padded > len(audio):
            raise TaskVoiceError("task_voice_audio_invalid")
        if kind == b"fmt ":
            if fmt_seen or frames is not None or size != 16:
                raise TaskVoiceError("task_voice_audio_invalid")
            if struct.unpack("<HHIIHH", audio[start:end]) != (
                1,
                1,
                SAMPLE_RATE,
                SAMPLE_RATE * 2,
                2,
                16,
            ):
                raise TaskVoiceError("task_voice_audio_invalid")
            fmt_seen = True
        elif kind == b"data":
            if not fmt_seen or frames is not None or size == 0 or size % 2:
                raise TaskVoiceError("task_voice_audio_invalid")
            if size // 2 > MAX_AUDIO_FRAMES:
                raise TaskVoiceError("task_voice_audio_too_long")
            frames = audio[start:end]
        offset = padded
    if not fmt_seen or frames is None or not 1 <= len(frames) // 2 <= MAX_AUDIO_FRAMES:
        raise TaskVoiceError("task_voice_audio_invalid")
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(frames)
    return output.getvalue()


def _catalog_path(path: Path | None) -> Path:
    if path is None:
        from deeptutor.multi_user import paths

        path = paths.ADMIN_WORKSPACE_ROOT / "user" / "settings" / "model_catalog.json"
    result = Path(path).absolute()
    _assert_unredirected(result)
    return result


def _unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate catalog keys")
        result[key] = value
    return result


def _nonfinite(_value: str) -> None:
    raise ValueError("Nonfinite catalog number")


def _read_catalog(path: Path) -> dict[str, Any]:
    try:
        _assert_unredirected(path)
        with path.open("rb") as handle:
            raw = handle.read(MAX_CATALOG_BYTES + 1)
    except FileNotFoundError:
        raise TaskVoiceError("task_voice_not_configured") from None
    if not raw or len(raw) > MAX_CATALOG_BYTES:
        raise TaskVoiceError("task_voice_configuration_invalid")
    try:
        snapshot = json.loads(
            raw.decode("utf-8"), object_pairs_hook=_unique, parse_constant=_nonfinite
        )
    except (ValueError, UnicodeError, RecursionError):
        raise TaskVoiceError("task_voice_configuration_invalid") from None
    if not isinstance(snapshot, dict):
        raise TaskVoiceError("task_voice_configuration_invalid")
    try:
        json.dumps(snapshot, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (ValueError, UnicodeError, RecursionError):
        raise TaskVoiceError("task_voice_configuration_invalid") from None
    return snapshot


def _explicit_selection(catalog: dict) -> tuple[dict, dict]:
    services = catalog.get("services")
    service = services.get("stt") if isinstance(services, dict) else None
    if service is None:
        raise TaskVoiceError("task_voice_not_configured")
    if not isinstance(service, dict):
        raise TaskVoiceError("task_voice_configuration_invalid")
    profile_id, model_id = service.get("active_profile_id"), service.get("active_model_id")
    if not profile_id or not model_id:
        raise TaskVoiceError("task_voice_not_configured")
    if not isinstance(profile_id, str) or not isinstance(model_id, str):
        raise TaskVoiceError("task_voice_configuration_invalid")
    profiles = service.get("profiles")
    if not isinstance(profiles, list) or any(not isinstance(item, dict) for item in profiles):
        raise TaskVoiceError("task_voice_configuration_invalid")
    selected = [profile for profile in profiles if profile.get("id") == profile_id]
    if len(selected) != 1 or selected[0].get("provider_only"):
        raise TaskVoiceError("task_voice_configuration_invalid")
    models = selected[0].get("models")
    if not isinstance(models, list) or any(not isinstance(item, dict) for item in models):
        raise TaskVoiceError("task_voice_configuration_invalid")
    active = [model for model in models if model.get("id") == model_id]
    if (
        len(active) != 1
        or not isinstance(active[0].get("model"), str)
        or not active[0]["model"].strip()
    ):
        raise TaskVoiceError("task_voice_configuration_invalid")
    return selected[0], active[0]


def _resolved_config(catalog_path: Path | None = None):
    path = _catalog_path(catalog_path)
    snapshot = _read_catalog(path)
    _explicit_selection(snapshot)
    # resolve_connections is the catalog's existing in-memory-only helper.
    # Never call load(), normalize/save migrations or settings previews here.
    from deeptutor.services.config.model_catalog import ModelCatalogService
    from deeptutor.services.config.provider_links import resolve_profile_provider
    from deeptutor.services.config.provider_runtime import (
        STT_PROVIDERS,
        VOICE_PROVIDER_ALIASES,
        resolve_stt_runtime_config,
    )
    from deeptutor.services.voice.adapters import get_stt_adapter

    selector = ModelCatalogService(path=path)
    catalog = selector.resolve_connections(deepcopy(snapshot))
    profile, model = _explicit_selection(catalog)
    profile = resolve_profile_provider(catalog, "stt", profile, model)
    binding = str(profile.get("binding") or "").strip().lower().replace("-", "_")
    binding = VOICE_PROVIDER_ALIASES.get(binding, binding)
    if binding not in STT_PROVIDERS:
        raise TaskVoiceError("task_voice_adapter_unavailable")
    spec = STT_PROVIDERS[binding]
    key = profile.get("api_key")
    headers = profile.get("extra_headers") or {}
    if not isinstance(headers, dict) or any(
        not isinstance(name, str) or not isinstance(value, str) or value.strip() == "***"
        for name, value in headers.items()
    ):
        raise TaskVoiceError("task_voice_configuration_invalid")
    if not spec.is_local and (not isinstance(key, str) or not key.strip() or key.strip() == "***"):
        raise TaskVoiceError("task_voice_configuration_invalid")
    if model["model"] in {"paraformer-realtime-8k-v1", "paraformer-realtime-8k-v2"}:
        raise TaskVoiceError("task_voice_adapter_unavailable")
    try:
        get_stt_adapter(spec.adapter)
    except (ValueError, RuntimeError, ImportError):
        raise TaskVoiceError("task_voice_adapter_unavailable") from None
    config = resolve_stt_runtime_config(catalog=catalog, service=selector)
    if not config.base_url or not config.model:
        raise TaskVoiceError("task_voice_configuration_invalid")
    config.request_timeout = min(config.request_timeout, STT_TIMEOUT_SECONDS)
    return config


def get_task_voice_readiness(catalog_path: Path | None = None) -> VoiceReadiness:
    try:
        _resolved_config(catalog_path)
        return VoiceReadiness(True, None)
    except TaskVoiceError as exc:
        return VoiceReadiness(False, exc.code)
    except (ValueError, TypeError, KeyError, AttributeError, ImportError):
        return VoiceReadiness(False, "task_voice_configuration_invalid")
    except Exception as exc:
        logger.warning("Task voice readiness failed (%s)", type(exc).__name__)
        return VoiceReadiness(False, "task_voice_unavailable")


class _CandidateCache:
    def __init__(self) -> None:
        self.values: OrderedDict[tuple, tuple[float, str]] = OrderedDict()
        self.lock = threading.RLock()

    @staticmethod
    def key(intent: VoiceIntent) -> tuple:
        return (
            intent.recipient_user_id,
            str(intent.task_id),
            intent.question_id,
            intent.request_hash(),
            intent.basis_revision,
        )

    def get(self, intent: VoiceIntent) -> str | None:
        key = self.key(intent)
        with self.lock:
            found = self.values.get(key)
            if found is None:
                return None
            if found[0] <= time.monotonic():
                self.values.pop(key, None)
                return None
            self.values.move_to_end(key)
            return found[1]

    def put(self, intent: VoiceIntent, text: str) -> None:
        with self.lock:
            self.values[self.key(intent)] = (time.monotonic() + CANDIDATE_CACHE_TTL, text)
            self.values.move_to_end(self.key(intent))
            while len(self.values) > CANDIDATE_CACHE_SIZE:
                self.values.popitem(last=False)


_candidate_cache = _CandidateCache()


def _replay(intent: VoiceIntent, admission: VoiceAdmission) -> str:
    if admission.state == "completed":
        cached = _candidate_cache.get(intent)
        if cached is not None:
            return cached
    if (
        admission.state in {"reserved", "attempting"}
        and admission.lease_until is not None
        and admission.lease_until > time.time()
    ):
        raise TaskVoiceError("task_voice_request_in_progress")
    raise TaskVoiceError("task_voice_result_unavailable")


async def _finish(
    store: TaskVoiceBudgetStore,
    admission: VoiceAdmission,
    state: Literal["completed", "failed", "cancelled"],
) -> bool:
    task = asyncio.create_task(asyncio.to_thread(store.finish, admission, state))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await task
        raise


async def _reserve(store: TaskVoiceBudgetStore, intent: VoiceIntent) -> VoiceAdmission:
    task = asyncio.create_task(asyncio.to_thread(store.admit, intent))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        # A cancelled await must not leave a reservation that its completed
        # worker thread just committed. Never finish a duplicate's lease.
        try:
            admitted = await task
        except Exception:
            raise asyncio.CancelledError() from None
        if admitted.is_new:
            await _finish(store, admitted, "cancelled")
        raise


async def _recognize(audio: bytes, config) -> str:
    from deeptutor.services.voice.adapters import get_stt_adapter

    async with asyncio.timeout(STT_TIMEOUT_SECONDS):
        return await get_stt_adapter(config.adapter).transcribe(
            audio, config, filename="answer.wav", content_type="audio/wav"
        )


def _validate_transcript(text: Any, config) -> str:
    if not isinstance(text, str) or not text.strip() or len(text) > 6000:
        raise TaskVoiceError("task_voice_transcript_invalid")
    try:
        text.encode("utf-8")
    except UnicodeError:
        raise TaskVoiceError("task_voice_transcript_invalid") from None
    # A valid ASR payload should not echo the administrator's credential.
    # Refuse it instead of editing the child's candidate text into new words.
    key = config.api_key
    if key and key != "sk-no-key-required" and len(key) >= 8 and key in text:
        raise TaskVoiceError("task_voice_transcript_invalid")
    headers = getattr(config, "extra_headers", {})
    if isinstance(headers, dict):
        for name, value in headers.items():
            if not isinstance(name, str) or not isinstance(value, str):
                continue
            normalized = name.strip().casefold()
            if normalized not in _AUTH_CREDENTIAL_HEADERS and not normalized.endswith(
                ("-api-key", "-auth-token", "-access-token")
            ):
                continue
            credential = value.strip()
            if not credential or credential == "***":
                continue
            secrets = {credential}
            if normalized in {"authorization", "proxy-authorization"}:
                parts = credential.split(None, 1)
                if len(parts) == 2 and parts[1].strip():
                    secrets.add(parts[1].strip())
            if any(secret in text for secret in secrets):
                raise TaskVoiceError("task_voice_transcript_invalid")
    return text


async def transcribe_task_audio(
    *,
    recipient_user_id: str,
    task_id: UUID | str,
    question_id: str,
    request_id: UUID | str,
    basis_revision: int,
    audio: bytes,
    budget_root: Path | None = None,
    catalog_path: Path | None = None,
) -> str:
    cleaned = validate_task_audio(audio)
    try:
        intent = VoiceIntent(
            request_id=request_id,
            recipient_user_id=recipient_user_id,
            task_id=task_id,
            question_id=question_id,
            basis_revision=basis_revision,
            audio_sha256=hashlib.sha256(audio).hexdigest(),
        )
    except (ValueError, TypeError, ValidationError):
        raise TaskVoiceError("task_voice_request_invalid") from None
    try:
        store = TaskVoiceBudgetStore(budget_root)
        found = await asyncio.to_thread(store.peek, intent)
        if found is not None:
            return _replay(intent, found)
        try:
            config = await asyncio.to_thread(_resolved_config, catalog_path)
        except TaskVoiceError:
            raise
        except (ValueError, TypeError, KeyError, AttributeError, ImportError):
            raise TaskVoiceError("task_voice_configuration_invalid") from None
        admission = await _reserve(store, intent)
        if not admission.is_new:
            return _replay(intent, admission)
        released = False
        outcome: Literal["failed", "cancelled"] = "failed"
        try:
            start = asyncio.create_task(asyncio.to_thread(store.start, admission))
            try:
                await asyncio.shield(start)
            except asyncio.CancelledError:
                await start
                raise
            try:
                text = _validate_transcript(await _recognize(cleaned, config), config)
            except (TimeoutError, httpx.TimeoutException):
                raise TaskVoiceError("task_voice_timeout") from None
            except TaskVoiceError:
                raise
            except Exception as exc:
                if isinstance(exc.__cause__, (TimeoutError, httpx.TimeoutException)):
                    raise TaskVoiceError("task_voice_timeout") from None
                logger.warning("Task speech recognition failed (%s)", type(exc).__name__)
                raise TaskVoiceError("task_voice_failed") from None
            if not await _finish(store, admission, "completed"):
                released = True
                raise TaskVoiceError("task_voice_result_unavailable")
            released = True
            _candidate_cache.put(intent, text)
            return text
        except asyncio.CancelledError:
            outcome = "cancelled"
            raise
        finally:
            if not released:
                await _finish(store, admission, outcome)
    except TaskVoiceError:
        raise
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.warning("Task voice storage/configuration failed (%s)", type(exc).__name__)
        raise TaskVoiceError("task_voice_unavailable") from None


__all__ = [
    "TaskVoiceError",
    "VoiceReadiness",
    "get_task_voice_readiness",
    "transcribe_task_audio",
    "validate_task_audio",
    "MAX_AUDIO_BYTES",
    "MAX_AUDIO_FRAMES",
    "SAMPLE_RATE",
    "STT_TIMEOUT_SECONDS",
]
