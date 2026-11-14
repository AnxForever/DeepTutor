# Listening and spoken answers in student tasks

P5 adds optional speech to the existing one-question task player. The learner may listen to the current question and record a short answer. Recognition produces an editable candidate; only an explicit action appends it to the answer. Typing and the existing help-needed response remain available when speech cannot be used.

## Evidence and scope

Baseline: the P4 fork at `d2cc1000527fba5a1b09dfcce3af8eb4b0c196a2`, reviewed 2026-11-14. The existing generic voice router accepts arbitrary text and uses shared voice adapters, but learner policy does not expose it. The existing recorder's stop handler transcribes automatically, including when cleanup stops a recorder. The existing generic speech cleaner is intentionally lossy: it drops code/tables/images and can truncate to a provider limit. These inherited gaps require task-specific behavior rather than exposing the generic endpoints.

For listening, the first implementation uses a browser voice whose `localService` is true. It does not select or call a cloud TTS provider. MDN distinguishes local and remote synthesis with this property. If the device has no matching local voice, the learner continues with the visible question. [Local speech voices](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisVoice/localService).

Microphone access is explicit and requires a secure browser context and permission. A permission request may remain unresolved if ignored; cancel and scope changes must invalidate it and stop any stream that arrives late. `MediaRecorder.stop()` queues final data and stop events, so stopping during cleanup must not imply permission to upload. Recorded complete blobs are decoded through Web Audio and resampled before upload. [Microphone access](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia), [stop event ordering](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/stop), [complete-file decoding](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData).

## Feature evidence ledger

| ID | User outcome and lifecycle | Decision | Delivery and coverage | Acceptance and failure behavior |
| --- | --- | --- | --- | --- |
| SV-01 | Listen to the current frozen question | Server prepares only the recipient's public question; browser uses a matching local voice after a click | Implemented; partial; task preparation and local-only selection covered by automated tests | No arbitrary text/model overrides, private source fields, autoplay or silent truncation; unsupported content keeps visual answering available; actual pronunciation remains unverified |
| SV-02 | Speak a short answer | Explicit start, stop and cancel; bounded client capture and canonical server WAV validation | Implemented; partial; inherited cleanup and unexpected device-stop gaps backfilled by lifecycle tests | Permission denial, ignored permission, device loss, hidden page, scope change and unmount release resources without transcription |
| SV-03 | Check and accept recognized words | Separate editable candidate; optional local playback; append only after confirmation | Implemented; partial; rendered task-player tests | Preserve typed partial work and help-needed status; no automatic answer save, submit, grading or mastery change; reject overlong merge without cutting text |
| SV-04 | Adults control audio transmission | Optional strict `task_voice_input` permission, default off; only an explicitly selected shared STT configuration | Implemented; partial; policy tests and authenticated API tests | Fresh identity, task, flag and progress checks before/after recognition; old grants retain absence; no generic voice-route access |
| SV-05 | Limit recognition use and repeat charges | Central atomic attempts/leases plus bounded optional RAM response cache | Implemented; partial; service quota/replay tests and ASGI disconnect test | Invalid uploads/configuration make no provider call; repeated request ID never repeats a provider call; failed/canceled attempts release concurrency, without promising a monetary refund |
| SV-06 | Recover unaccepted text safely | Optional versioned candidate in the existing account/task browser buffer | Implemented; partial; candidate/buffer restore tests | Restore only for the same task/question/basis; no auto recording, playback, acceptance or upload; raw recordings are not added to drafts |

## Permissions and configuration

`learning_policy.task_voice_input` is optional. Missing means disabled. An administrator or an already authorized guardian may explicitly set a boolean in the existing restriction controls. Old policies, existing learner defaults and the normal single-user configuration are not silently changed. Task access is also required; enabling the voice flag alone does not grant task access.

The task voice API remains under `/api/student-tasks` and the account-global workspace handling introduced by P4. It uses the fresh learner identity and recipient-bound central task view. It never resolves a teacher's content directory. Read-aloud text comes only from `questions[].question`, not reference answers, scoring criteria, past responses, diagnosis or teacher notes. This first slice permits speech actions only while the task is active.

Spoken input uses the administrator's selected shared speech-to-text profile and model, without a learner LLM grant. Readiness reads an existing catalog snapshot without migration, saving defaults, network probing or fallback to a different profile. Configuration readiness is not proof that provider authorization, network access or recognition quality will succeed. Responses contain safe availability/reason codes, not credentials, model IDs or provider URLs.

## Media, requests and retention

The browser targets 25 seconds per recording. It stops tracks before decoding the complete blob, resamples to 16 kHz mono PCM16 WAV and sends that WAV as the raw request body. The server reads incrementally up to 1 MiB with a read deadline, checks actual header/frame data against a maximum of 30 seconds, and rebuilds a canonical WAV. No file name, URL, model or recognition prompt is accepted from the learner. Canonical WAV avoids the existing adapters' FFmpeg conversion paths.

The task layer does not intentionally persist the recording. Application buffers and provider response processing are separate from browser/OS-managed caching or paging; this is not a physical erasure guarantee. The recognition service receives audio only after explicit user action and current authorization. Provider privacy and retention terms remain part of the adult's service selection.

The server attempt ledger stores request and quota metadata, not recordings or recognized text. It permits one in-flight request per learner and two globally, with expiring leases; attempted calls are limited to four per minute and twenty per UTC day per learner. A failed or canceled call may already have reached a provider, so counted attempts are not a currency estimate or refund promise.

After an upload is fully read, the endpoint watches for a browser disconnect while recognition runs. A disconnect cancels the recognition coroutine and waits for lease cleanup. This does not retract audio already sent to a provider. Unexpected device termination cancels capture; only the learner's stop action or the recording timer can authorize a completed recording for recognition.

A bounded in-memory candidate cache may retain a result for five minutes, up to 128 entries. Replays must still pass authorization/task/basis checks. A terminal request whose RAM result is unavailable is not sent to the provider again: the learner may make a new recording or type. The browser's unaccepted candidate is scoped to its real account, task, question and progress basis; the recording is never put into that durable buffer.

Accepting a candidate appends it to the latest answer rather than replacing it. It preserves an existing `needs_help` status and assistance value; voice entry is not evidence of independent understanding or teacher-confirmed help. Results that exceed the answer limit are edited rather than silently shortened.

## Supported spoken representation

The initial question preparation supports English/Chinese plain text and a bounded set of elementary arithmetic and fraction notation. It does not calculate answers. Images, code, tables, unsupported mathematics, malformed markup or overly long spoken representations return a safe unavailable reason for the whole question. They are not omitted and described as a complete reading. The screen remains the authoritative question.

## Verification

Use isolated D-drive data, real synthetic learner accounts and a loopback recognition fixture through the actual configured adapter. A fixture response proves routing and confirmation behavior, not speech-recognition accuracy. Browser recording tests use synthetic audio rather than a human microphone. Local device synthesis availability and controlled playback lifecycle tests are reported separately from actual listening quality.

Required cases include wrong learner/known task ID, missing or revoked permission, task completion/withdrawal, changed progress basis, late microphone/provider results, malformed/oversized/overlong WAV, quota/concurrency/replay behavior, safe upstream errors, candidate editing/append/discard/recovery and zero unexpected task saves. Preserve the normal runtime's settings and collections. Real-child usability, pronunciation and real-provider recognition quality require separate evaluation.
