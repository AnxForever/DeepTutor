"""Safe task-voice failures and fixed first-slice resource limits."""

from dataclasses import dataclass

MAX_AUDIO_BYTES = 1_048_576
MAX_AUDIO_FRAMES = 480_000
SAMPLE_RATE = 16_000
STT_TIMEOUT_SECONDS = 30
LEASE_SECONDS = 60
USER_INFLIGHT_LIMIT = 1
GLOBAL_INFLIGHT_LIMIT = 2
MINUTE_CALL_LIMIT = 4
DAY_CALL_LIMIT = 20

_ERRORS = {
    "task_voice_request_invalid": (422, "Review the recording request.", False),
    "task_voice_audio_invalid": (422, "Record a mono 16 kHz PCM16 WAV clip.", False),
    "task_voice_audio_too_large": (413, "Record a shorter clip of at most 1 MiB.", False),
    "task_voice_audio_too_long": (422, "Record no more than 30 seconds at a time.", False),
    "task_voice_busy": (429, "Voice input is busy. Try again shortly.", True),
    "task_voice_minute_limit": (429, "Wait a little before recording again.", True),
    "task_voice_daily_limit": (429, "Today's voice allowance is used. You can still type.", False),
    "task_voice_request_changed": (409, "This recording id was used for different content.", False),
    "task_voice_request_in_progress": (409, "This recording is already being recognized.", False),
    "task_voice_result_unavailable": (
        409,
        "This recording result is no longer available. Record a new clip.",
        False,
    ),
    "task_voice_failed": (
        502,
        "The recording could not be recognized. Your answer has not changed.",
        True,
    ),
    "task_voice_transcript_invalid": (
        502,
        "No usable short transcript was returned. Your answer has not changed.",
        False,
    ),
    "task_voice_timeout": (504, "Recognition took too long. Your answer has not changed.", True),
    "task_voice_not_configured": (503, "Voice input is not configured. You can still type.", False),
    "task_voice_configuration_invalid": (
        503,
        "Voice input needs an administrator's attention. You can still type.",
        False,
    ),
    "task_voice_adapter_unavailable": (
        503,
        "The selected voice input is unavailable. You can still type.",
        False,
    ),
    "task_voice_unavailable": (
        503,
        "Voice input is unavailable. Your answer has not changed.",
        True,
    ),
}


class TaskVoiceError(RuntimeError):
    """Only application-authored copy may leave the task voice service."""

    def __init__(self, code: str, *, retry_after: int | None = None):
        if code not in _ERRORS:
            code = "task_voice_unavailable"
        self.code = code
        self.status_code, self.message, self.retryable = _ERRORS[code]
        self.retry_after = retry_after
        super().__init__(self.message)


@dataclass(frozen=True, slots=True)
class VoiceReadiness:
    available: bool
    reason: str | None
