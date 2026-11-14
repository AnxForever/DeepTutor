# Progressive hints in student tasks

P6 adds teacher-reviewed hints to the P4 task flow. A learner asks for one next step, keeps their current answer, and can still ask the teacher for help. The teacher can see which steps were unlocked. Requesting, displaying, reading and understanding a hint are different facts; this feature records the server's unlocks, not comprehension.

## Evidence and decisions

Baseline: the P5 fork at `db43043923db99c5faa9a81371f74401fff96da3`, reviewed 2026-11-14. Existing chat, reading and mastery `ask-hint` services generate suggested questions/input placeholders. Practice reveal paths can expose solutions and update review records. Neither is the student task's teaching-hint lifecycle. This task-specific implementation backfills that missing lifecycle without reusing their model or assessment writes.

ASSISTments recommends opening one hint, taking a concrete action, and trying the problem again. Its student report includes hint use and the hints provided. We adapt those interaction and observation patterns without treating repeated help as failure or claiming a learning effect. [Using hints](https://www.assistments.org/blog-posts/clicking-is-not-the-same-as-learning-teaching-students-to-use-hints-effectively), [student report](https://www.assistments.org/individual-resource/the-student-report-2).

Khan's Perseus uses edited, ordered hints and an explicit next-hint action. Its client-side visibility count is a display mechanism; DeepTutor instead keeps unrevealed text on the server. No Perseus runtime, content or assets are copied. Source inspected at commit `4163210b8e6b71ecda752cd1d882bb87973ee571`: [renderer](https://github.com/Khan/perseus/blob/4163210b8e6b71ecda752cd1d882bb87973ee571/packages/perseus/src/hints-renderer.tsx), [editor](https://github.com/Khan/perseus/blob/4163210b8e6b71ecda752cd1d882bb87973ee571/packages/perseus-editor/src/combined-hints-editor.tsx).

The IES elementary mathematics intervention guide supports breaking tasks into steps, worked examples with omitted steps, and asking learners to express their thinking. This supports actionable scaffolding; it does not establish that a fixed three-step ladder outperforms an LLM or proves this implementation effective. Recommendation 1 was reviewed in the first 22 PDF pages. [Guide](https://ies.ed.gov/ncee/WWC/PracticeGuide/26), [PDF](https://ies.ed.gov/ncee/WWC/Docs/PracticeGuide/WWC2021006-Math-PG.pdf).

The first implementation therefore uses optional teacher-authored, reviewed hint ladders. It makes no learner-time model call. Adaptive generated tutoring would require separate content-quality, context, model-access, cost and failure evidence. A teacher may still write an incorrect or overly revealing hint; the application does not certify pedagogical correctness.

## Feature evidence ledger

Delivery, coverage and history are separate. Local domain, authenticated API and rendered tests cover the lifecycles below. Evidence remains partial: synthetic runtime acceptance and tests do not establish hint quality or classroom effectiveness.

| ID | Outcome / lifecycle | Decision | Delivery / coverage / history | Acceptance |
| --- | --- | --- | --- | --- |
| SH-01 | Teacher prepares and reviews help | Optional per-question ladder in the issue request; freeze it with the assignment without modifying the saved practice source | Implemented / partial / backfilled | Preview, review reset, complete publish intent, old absent/empty-plan equivalence, immutable source and issued plan |
| SH-02 | Child gets one actionable next step | Explicit next-hint button; keep previous revealed steps and the teacher-help action | Implemented / partial / backfilled | Only revealed text in student responses/DOM; short plain text; zero model grants/calls; no automatic answer or submission |
| SH-03 | A retry does not skip steps | Central transactional events, request UUID and independent whole-task hint revision | Implemented / partial / none | Duplicate/reordered requests, stale CAS, cross-question races, submit/revoke races, at most one new step per accepted request |
| SH-04 | Teacher can interpret assisted work | Freeze server-derived use in the final receipt and mark responses with unlocked hints as assisted | Implemented / partial / backfilled | Client cannot erase help or claim independent; preserve original submission intent and answer/status; old receipts retain unknown/unrecorded use |
| SH-05 | Help does not lose unfinished work | Hint state has its own request/recovery lifecycle; never adopt a whole task into answer state after a hint response | Implemented / partial / backfilled | Preserve typed work, pending answer requests and P5 candidate/basis; reconcile unknown acknowledgements by GET without automatic further reveal |
| SH-06 | Teacher sees help before and after submission | Owner-scoped read-only unlock metadata and the frozen issue plan; no draft answers in teacher progress | Implemented / partial / none | Learner/teacher isolation, withdrawn-task history, level/time display, no grading/mastery/attempt writes |

## Content and permissions

`IssueTaskRequest.question_hints` is optional and defaults to an empty plan. There are at most three question entries, each referring to an actual question in the verified issue snapshot, with one to three nonblank hints of at most 600 Unicode characters. A question without an entry has no hints. Hints are intentionally public teaching material after unlocking; private reference answers, rubrics and report guidance are not copied into them automatically.

Editing the hint plan invalidates the teacher's review and publishing intent just like changing the recipient or instructions. The teacher sees the complete student-facing material before issuing. Once issued, corrections require withdrawal and a new task. The underlying saved follow-up, worksheets and P3 evidence snapshots are unchanged.

Learners need the existing task access and fresh learner identity. There is no additional model grant, voice permission or shared model configuration requirement. The account-global workspace behavior from P4 remains in force. Teacher metadata is scoped to the issuing teacher's canonical scope and task; it reveals unlock history, not unsubmitted answer text.

## Unlocking, recovery and final evidence

The student hint GET returns the task ID, an independent `hint_revision`, and each question's hint count and already revealed prefix. It never returns the unrevealed ladder. A reveal POST includes the question ID, request UUID and expected hint revision. The server selects exactly the next level. Successful events are bounded by the issued plan, at most nine per task. Repeating the same request does not unlock another level; changing its body or using a stale revision conflicts.

Unlocks, submission and withdrawal use the same central task database transaction boundary. A new unlock requires an active task. Previously revealed text can be read after completion or withdrawal; an inactive task cannot unlock more hints, including through a replay. Revealing help changes neither answer progress nor task revision, so it does not invalidate a P5 transcription candidate or silently save local work.

A failed acknowledgement is reconciled by fetching authoritative hint state. A refresh may recover a step the server committed before the response was lost. It must not automatically reveal another step. Hint responses update only hint state, preserve unfinished answers and remain bound to the current account/task/question. Unrevealed text is never placed in the learner's durable buffer.

While a reveal is pending, the learner can choose to try the work alone. This aborts the client wait and releases navigation without changing the answer. It cannot undo an unlock already committed by the server. New reveals require reconciliation; an explicit retry retains the original request UUID and body. Late responses from the canceled request cannot clear a newer request or overwrite its hint state.

New final receipts freeze the used question IDs, levels and timestamps from server events. For those questions the server sets `assistance` to `assisted`, preserving the exact answer and answer status. The original client submission JSON and request hash remain available for idempotency and validation. Legacy receipts with no hint-use field retain `None`, distinct from a new recorded empty list. No mastery, grading, practice-attempt or student-case evidence is written.

Compatibility requires omitting only the new empty plan from canonical issue intents. Other existing defaults remain part of their original digest. Historical raw issue/submission JSON and hashes are not rewritten. Teacher recovery and browser draft comparisons use the same plan semantics, including hint content rather than array identity.

## Verification boundaries

Use fresh synthetic accounts and material in an isolated D-drive runtime. Test domain/API transactions, legacy raw receipts, positive student payloads, authenticated access, client state/recovery and production-browser teacher-to-student-to-teacher operation. Preserve the normal runtime's settings, teaching collections and authentication mode. Unit tests and synthetic browser tasks do not establish child readability, hint correctness, learning gains or curriculum alignment.
