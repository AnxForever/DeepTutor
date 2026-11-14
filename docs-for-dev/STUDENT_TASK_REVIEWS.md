# Teacher reviews and linked teaching evidence

P7 separates a learner's final submission from a teacher's later assessment. A teacher reviews the frozen answers and help record, confirms an assessment, and can explicitly associate a particular review version with a student case. Corrections and withdrawals remain auditable. A new assessment version is never another student attempt.

## Evidence and decisions

Baseline: P6 `fb63fdbfa63b8b61086d3a69cc7b68576c938864`, reviewed 2026-11-14. P4 owns immutable submissions and P6 freezes hint use. The existing follow-up attempt path combines a new response with its assessment; it cannot represent later assessment of an existing submission without fabricating another response. P3 cases pin report versions and aggregate reports/attempts, but do not bind anonymous labels to authenticated learner accounts.

Gradescope's regrade workflow stays within an existing submission/question and retains the discussion around changes. Moodle distinguishes attempts, manual assessment, regrading and grade history. These support separate assessment revisions; neither product's documentation is evidence that this implementation improves learning or that every deployment retains history forever. We do not copy shared-rubric changes that implicitly regrade other students. [Gradescope](https://guides.gradescope.com/hc/en-us/articles/22237994239885-Managing-Regrade-Requests), [Moodle manual grading](https://docs.moodle.org/503/en/Quiz_manual_grading_report), [Moodle grade history](https://docs.moodle.org/503/en/Grade_history).

ASSISTments presents results, later teacher feedback and hint use as distinct information. We retain that distinction: correct work with help remains helped work, and unknown assistance is not proof of independence. [Student report](https://www.assistments.org/individual-resource/the-student-report-2).

The first implementation is teacher-only and requires no model call. It adds a separate task-review section to case details. Existing P3 timelines, report/attempt counts, cursors and stored case/report/attempt bodies keep their existing meaning. Student-visible feedback publication and merging the separate evidence streams are later decisions.

## Feature evidence ledger

| ID | Outcome / lifecycle | Decision | Delivery / coverage / history | Acceptance |
| --- | --- | --- | --- | --- |
| RV-01 | Assess a submitted answer without changing it | Bind reviews to exact task/submission identity and frozen receipt hash; derive source and assistance server-side | Implemented / partial / backfilled | Exact questions; no client-supplied answer, UID or help override; no real answer text remains ungraded; old submission and hint bytes unchanged |
| RV-02 | Correct or withdraw an assessment | Immutable review revisions, stable request UUID and independent CAS; changes retain reasons and actor | Implemented / partial / none | Lost acknowledgement, identical replay, changed body, concurrent editors, correction/withdrawal, no older decision silently revived |
| RV-03 | Keep unfinished teacher work | Dedicated review page and actor/workspace/task/submission draft scope | Implemented / partial / reopened-by-change | Refresh, navigation, language-resource failure, exact pending request recovery, conflict preservation and saved-but-local-cleanup failure |
| RV-04 | Associate evidence with the intended learner | Explicit case UUID selection and teacher identity confirmation; verify workspace and exact pinned report/fingerprint | Implemented / partial / none | No label matching or automatic case creation; source mismatch, stale case revision, cross-workspace, archive and concurrent source changes |
| RV-05 | See actionable teaching concerns | Group current linked questions by frozen subject and knowledge point; separate partial/incorrect, helped/unknown-correct and ungraded/help-requested facts | Implemented / partial / none | Distinct submission/question counts, no duplicate assessment versions, no mastery/percentage/diagnosis inference |
| RV-06 | Stop relying on outdated evidence | Pin exact review versions; show stale, withdrawn, revoked or unavailable sources and exclude them from current summaries | Implemented / partial / none | Explicit repin, history retention, removals despite unavailable/archived source, no silent switch to latest |
| RV-07 | Preserve access boundaries | Fresh teacher administration and canonical workspace scope; student endpoints remain unchanged | Implemented / partial / reopened-by-change | Learner denial, stale roles, wrong workspace, shared-admin semantics and actual reviewer audit identity |
| RV-08 | Keep existing teaching history intact | New tables and separate projection; no changes to old case, follow-up or task payloads | Implemented / partial / backfilled | Read without schema migration, old retries/hashes, original P3 timeline counts/cursors, no new follow-up attempt or mastery write |

Domain, authenticated API and rendered regression tests cover these lifecycles. Evidence remains partial while synthetic runtime acceptance is completed. Classroom usefulness and the correctness of individual teacher judgements require separate evaluation.

## Reviews

The teacher sees original question text, reference guidance, final answers, help-needed status, assistance and frozen hint use. The editable fields are a result (`correct`, `partial`, `incorrect`, `ungraded`), feedback, an overall note and a change reason. The subject and knowledge-point focus come from the task's issued follow-up snapshot. Missing historical labels remain missing rather than being inferred from a case name.

The server requires one assessment per submitted question. A response with no actual answer text cannot be called correct, partial or incorrect merely because it was submitted or asked for help. A partial answer that also asks for help can still be assessed by the teacher. This does not change its original answer status.

Review writes use the same central task database and transaction boundary as the original submission/withdrawal checks. The server binds the immutable submission hash, authenticated recipient, source versions and actual reviewer account. The client cannot supply those facts or change assistance. The first confirmation creates revision one; later confirmations require a reason. Withdrawal adds a revision and keeps prior content. Reconfirming after withdrawal requires another explicit confirmation and reason.

A repeated request UUID with the same body recovers its original saved revision, including when a later correction already exists. It must not overwrite the current revision. A mismatched body or stale CAS conflicts. The editor retains dirty content until the teacher explicitly reloads, retries or discards it. Local cleanup failure after a server save is not a reason to issue another review.

Historical submissions may still be reviewed when the learner account is later disabled or task access is removed. Task withdrawal and review withdrawal are different facts. A withdrawn task's existing submission and assessment history remain available to authorized staff; it is excluded from current case concerns. Review withdrawal stops a judgement from acting as current evidence without deleting the student's work.

## Explicit case evidence

Case links live in a separate versioned overlay in the workspace's case database. They do not add default fields to old case payloads or change their hashes. A case can link at most twenty submissions, each to one exact review version and a nonempty subset of its questions, with optional teacher observations and next teaching actions.

New or changed associations require an active target case, its expected revision, a current confirmed review from the same canonical teacher scope, a non-withdrawn task, and the task's exact report ID/revision already pinned in that case. The corresponding confirmed report and source fingerprint are checked again. A case label, source `student_ref` or similar name is not an identity join. The teacher must explicitly confirm the learner-account/case association; the actual UID is derived from the task.

A nonempty overlay binds to one server-derived learner UID, and every linked submission must belong to that UID. Switching to another learner requires an explicit clear followed by a separately confirmed association; it cannot happen as a side effect of adding a reference. The original case body remains unchanged, and prior bindings remain in overlay history.

Case validation and overlay persistence hold the required case/source and central source locks together. Lock ordering must remain compatible with task issuance, which can reserve a source report before the central task write. Existing unchanged references may remain as historical entries when a source later becomes unavailable; removing an incorrect association is still possible after case archiving or source loss. Adding or changing a reference requires fresh validation.

An overlay POST identifies both its original acknowledged revision and the latest overlay view. An old UUID may acknowledge an earlier save without moving the current view backwards. Removing references can succeed without a readable report or central source; remaining unavailable references carry no invented questions or grades and do not contribute to current concerns.

An amended review makes its previous pin stale. A withdrawn review, withdrawn task, missing source or removed report pin is not counted as current evidence. The old entry stays visible, with an explicit action to choose a newer confirmed version when appropriate. No fallback resurrects an older assessment and no background process silently changes the pinned version.

Current concern cards count distinct submissions/questions, not review revisions. Grouping uses the frozen subject and knowledge-point strings without guessing synonyms. Partial or incorrect results can suggest further teaching; correct answers with assisted or unknown conditions call for an independent check. Unreviewed answers and requests for help remain separate facts. These are teacher-confirmed observations, not mastery, psychological diagnosis or proof that a hint caused an answer.

## Access and verification

This extends the existing administrative workspace policy. Administrators sharing the same administrative workspace already share its task scope; the feature does not claim per-teacher isolation within that shared scope. Every write records the actual actor. Other workspace scopes are checked separately. New APIs require fresh authorized staff, and student task payloads gain no review, reference-answer or teacher-note fields.

Use synthetic accounts/materials in an isolated D-drive runtime. Verify domain and authenticated API transactions, original receipt/hash preservation, UI drafts/recovery, explicit association and production-browser review-to-case operation. Test corrections and withdrawals without increasing attempt counts. Preserve the normal runtime's settings, data and authentication mode. No real-child learning or diagnostic-quality claim follows from these checks.
