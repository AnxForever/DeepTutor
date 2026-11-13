# Teacher assignment analysis (fork feature)

This feature helps a teacher review one student's submitted work and prepare the next teaching step. It belongs to this fork; it is not an accepted HKUDS roadmap commitment.

## Workflow and boundaries

Open **Learning → Teaching analysis** (single-user mode or an administrator account). Start with a Word/TXT/Markdown document or pasted source text, import structured JSON/CSV/TSV, or enter questions manually. Confirm the student label and assignment scope, and correct each question and response before requesting analysis. Reference answers and marking criteria are optional. Images, scans, handwriting recognition and class-roster management remain outside this slice.

The report keeps item observations separate from possible causes and proposes targeted teaching actions and follow-up checks. Its citations point back to exact student-answer or working excerpts. A teacher can edit the narrative, save a draft, confirm it, and inspect earlier saved revisions. Changing source input invalidates the generated report until it is analyzed again. A report-local student label does not grant access to a student's account.

Report storage follows the existing authenticated PathService scope and active content workspace. Existing administrator accounts share the application's administrator root; this feature does not claim separate private stores for each administrator. It does not write Question Notebook entries, learner profiles, learning journals or Mastery Path progress. Confirming a report is a teacher review action, not a student passing an assessment. The existing `teacher` role label does not grant access in this administrator-only first slice.

## Input

JSON accepts an assignment object or an array of question objects. CSV/TSV supports the documented import headers in the importer, including question, student answer, working, optional reference answer/rubric, and knowledge-point labels. Empty imported cells are unknown until the teacher confirms their meaning.

Each question distinguishes:

- `answer_status`: `present`, `confirmed_blank`, or `unknown`.
- `transcription_status`: `confirmed`, `uncertain`, or `not_applicable`.
- `assistance`: `independent`, `assisted`, or `unknown`.

Missing, confirmed-blank and uncertain-transcription answers remain ungraded. A single mistake does not establish a stable misconception; a model's confidence is not a calibrated learner-ability probability.

The bounded workflow accepts at most 40 items, 60,000 total input characters and a 1 MiB import. Model output is parsed and validated without an unbounded repair loop. Missing model configuration and provider/validation failures are actionable errors, not successful saved reports.

The initial UI and prompts are written in English and Chinese. New feature strings in the other strict catalogs and the partial Korean catalog currently use English fallback values; they are not claimed as completed translations. The supplied [synthetic assignment](../examples/teaching_analysis/assignment.example.json) can be imported to explore the workflow without student data. The [eight-case evaluation set](../examples/teaching_analysis/cases.synthetic.json) is for evaluators; import only a case's `input`, never its hidden `expected` results.

## Architecture decisions

Research baseline: v1.7.2, `60fb3bdfddb30b7740c7ce3bd9b28d908f2af6db`, reviewed 2026-11-13.

| Feature ID | Decision and source evidence | Acceptance and remaining gap |
| --- | --- | --- |
| TD-01 intake | Adapt LearningShell/shared form and import-preview patterns; teacher task is separate from the existing learner self-test starter | Imported work is editable before generation; first-use sample is explicitly synthetic |
| TD-02 identity/scope | Administrator-only route, account/workspace-scoped PathService, report-local student label | Test non-admin refusal and store isolation; no student-account impersonation |
| TD-03 input correction | Independent parser; Practice's required answer key and mistake-import semantics do not fit teacher work | Preserve null versus confirmed blank; reject evaluation fixtures with hidden expectations |
| TD-04 analysis | Existing LLM service, no tools or account memory; structured output and exact evidence validation | Invalid IDs/quotes and grading unknown answers are rejected; citation validity does not prove semantic correctness |
| TD-05 actionable report | Observations, hypotheses, alternatives and follow-up checks tied to student evidence | Teacher review and real-model evaluation still needed to establish pedagogical quality |
| TD-06 revision | Explicit saves, SQLite optimistic revision checks and immutable history | Stale saves/retries must not overwrite newer work; source edits require fresh analysis |
| TD-07 learning integration | Deferred; AssessmentRecord can support later explicit linkage | No mastery/profile/notebook writes from this feature |
| TD-08 evaluation | Synthetic cases cover contradictory keys, weak evidence, reasoning errors, assistance and injection | Deterministic tests prove boundaries; no claim of learning benefit without model/teacher evaluation |
| TD-09 reusable rubric / P1 | Versioned workspace templates are copied as explicit assignment snapshots; selected snapshots are verified against their stored revision | CAS/retry, forged or cross-workspace snapshots, explicit upgrade, old-report fingerprint compatibility; no silent history changes |
| TD-10 reviewed follow-up / P1 | Reuse a confirmed report's existing follow-up suggestion, then let the teacher correct up to three questions before saving | Source report revision must still be current; editing questions creates a new revision and never rewrites previous attempts |
| TD-11 new attempts / P1 | Store each submission with a stable attempt ID, question snapshot, assistance and explicit teacher review | Same-intent retries are idempotent; genuinely new answers remain separate; missing/blank answers stay ungraded; no automatic mastery update |
| TD-12 withdrawal / P1 | A teacher can void an erroneous attempt with a reason while preserving the original answer and assessment | Voiding stays auditable and idempotent; old evidence is shown as voided rather than erased or silently counted as a new failure |
| TD-13 located document preview / P2 | Adapt the existing Office Math renderer into bounded TXT/Markdown/DOCX text blocks with real line/paragraph/table positions | ZIP/XML limits, no global cloud parser, no invented DOCX page numbers, no OCR claims; partial until browser acceptance |
| TD-14 source-only extraction / P2 | A single model request selects literal field quotations; the server projects field values and verifies overlap/duplication | No fabricated answers, metadata or locations; ambiguous repeated questions are rejected without automatic repair |
| TD-15 original/corrected source / P2 | Workspace-local signatures bind original excerpts; teacher corrections remain separate in the assignment | Cross-scope/tampered proofs rejected, old no-source hashes/receipts preserved, source quotes excluded from repeated diagnostic model input |
| TD-16 local draft recovery / P2 | Account/workspace-scoped browser drafts preserve work through settings and refresh, with explicit restore/discard | Storage failure, stale writers, staged child restoration and navigation must not silently overwrite or discard work; no automatic server confirmation |
| TD-17 worksheet editions / P2 | Saved follow-up questions become student handouts or an explicitly selected teacher reference edition | Student output uses a field allowlist, no hidden answers/history, HTML escaping/CSP, exact old revision, print layout and download checks |
| TD-18 stable student cases / P3 | Adapt the entity-identity boundary in the P2 Kolibri/Moodle research: a workspace-local UUID is independent of its editable label, and same-name cases remain separate | Implemented with CAS snapshots, idempotent saves, rename/archive/restore and scope isolation; row identity and raw request receipts are checked before reads and retries |
| TD-19 explicit report links / P3 | A teacher selects the exact confirmed report revision; metadata-only edits may retain an already-linked missing source | Implemented: unique report IDs, at most 20 pins, precise historical reads, stale/unavailable warnings and no automatic latest-version substitution |
| TD-20 evidence timeline / P3 | Adapt ASSISTments detail navigation and assessment-policy provenance: show chosen report observations and distinct nonvoid follow-up attempts in recorded-time order | Implemented: whole-dataset counts, assistance/result joint groups, real cursor pagination, void/source changes invalidate stale cursors; malformed candidate sources fail rather than silently reducing counts |
| TD-21 case draft continuity / P3 | Extend the existing local CAS drafts with exact page/case namespaces | Implemented: one case's restore/discard does not clear another case or workbench draft; server conflicts preserve editing and require explicit reload |

The code review found existing primitives in `services/practice`, `learning/assessment.py`, `learning/models.py` and the content-workspace services. They are reused as conventions where compatible; the feature does not introduce another agent framework or change mastery gates.

Historical context: [teaching friction #1971](https://github.com/HKUDS/DeepTutor/issues/1971), [interaction friction #1972](https://github.com/HKUDS/DeepTutor/issues/1972), and [Partner question recording #1341](https://github.com/HKUDS/DeepTutor/pull/1341). These are context and adjacent implementations, not fresh reproduction evidence for the fork. See [competitor and open-source research](TEACHING_ANALYSIS_RESEARCH.md) for source-specific decisions and the proposed follow-up sequence.

Coverage is **partial** until runtime checks, real-model analysis and teacher review are reported separately. New workflow features were previously ideas; inherited import/assessment behavior remains source-reviewed rather than comprehensively audited. Competitor/open-source research is tracked separately and may refine follow-up work without widening this slice.

## P1: reusable criteria and follow-up evidence

P1 adds optional workspace-local scoring templates and makes the existing follow-up question actionable. It does not need another model call to copy a report's suggestion into an editable exercise. The teacher checks the question and any reference answer before saving a versioned set. Each later answer is a new submission recorded by the teacher; the displayed result is explicitly teacher-assessed, not an invented automatic grade. This is not a student login or an automatic marking service.

An assignment records the exact template ID, revision and criteria used. Updating the library does not mutate older assignments or reports. Applying a newer version is explicit and invalidates the current generated analysis. For older reports without a template, the optional null field is excluded from the canonical fingerprint so existing saved reports remain editable without pretending their sources changed.

Exercise revisions and attempts retain their own snapshots. Repeating an upload or request does not create an additional independent attempt; submitting a genuinely new answer does. Assistance stays visible even when the teacher marks an answer correct. A void action adds a reason and timestamp without overwriting the original submission. These records remain separate from the Question Notebook, learner profile and Mastery Path gates.

Templates and follow-ups use separate private SQLite files in the same authorized teaching-analysis workspace directory. Creating or revising a follow-up requires the current confirmed source report. A follow-up cannot move between different student labels, assignment labels, subjects or knowledge points: start a new set if those anchors change. Older responses remain attached to the question and source-report versions that were actually used. An existing successful submission can be retried even after its question set has advanced; an unsent old question version must first be reloaded.

The API adds `/rubrics`, `/rubrics/{template_id}/revisions`, `/followups`, `/followups/{followup_id}/revisions`, `/followups/{followup_id}/attempts`, and a reasoned attempt-void action beneath `/api/teaching-analysis`. Templates are saved separately from applying them to an assignment; no library change silently updates a report. Report payload receipts, as well as source fingerprints, normalize only the absent-versus-null optional template field for pre-P1 compatibility. Actual missing or confirmed-blank student answers remain distinct.

P1's evidence coverage remains partial until targeted API/UI tests and independent browser checks have been reported. Semantic diagnosis and classroom learning benefit still require a configured real-model evaluation and teacher review.

## P2: collect real material and deliver usable classroom handouts

P2 prioritizes input/output and draft continuity. The [P2 research](TEACHING_ANALYSIS_P2_RESEARCH.md) shows why student timelines require stable identities, explicit report-version links, assessment-policy provenance, and careful treatment of missing or assisted attempts. A shared text label or a report-save timestamp is insufficient. The following P3 slice implements stable student cases and explicit report links; classroom aggregation and teaching-task automation remain proposals.

### Source documents

The document panel accepts TXT, Markdown and DOCX, or pasted plain text. Reading a document is local and does not require a knowledge base. Word equations use the existing plain-math renderer; unsupported equations and image content are marked for review. DOCX locations are logical paragraphs/table cells, never guessed pages. PDF, handwriting and image extraction are not implemented in this slice.

The teacher explicitly requests extraction using the configured chat model. The model may select only original block quotations; field values, question IDs and locations are produced by the server. Missing responses remain unknown, not confirmed blanks. Extracted responses stay uncertain until the teacher explicitly checks them. A teacher can correct fields, while the saved original excerpts remain visible and are marked as different when they no longer match.

Preview and provenance signatures use a workspace-local private signing key that survives normal restarts; another workspace cannot reuse the preview as authority. Uploaded originals are not persisted by this endpoint. The report stores only the cited original fragments and file identity, so the teacher should retain the original file. A signature proves the preview's provenance, not semantic correctness. Original-source excerpts are not duplicated in subsequent diagnostic model calls. Legacy fingerprints and save receipts normalize only the optional absent/null provenance field, preserving real null/blank answer distinctions.

### Local drafts

Browser drafts are separate from explicit report, rubric and attempt saves. Account/workspace keys are captured before asynchronous work. Primary material/report/paste, rubric edits, document previews/extractions, follow-up editors, and pending response intents have restorable snapshots. Restoration is staged as nested editors mount; a restored saved base is checked by authorized GET before writes are enabled. Restoring does not call a model, submit answers or turn local text into a newly confirmed report.

Per-record write revisions prevent concurrent windows from silently overwriting each other. Clears leave a tombstone so an old writer cannot recreate discarded content. Corrupt or unrecognized data remains available for export rather than being silently deleted. Storage failures are visible; recoverable navigation waits for current drafts to flush. Retry writes the current editor state, not an older cached copy. Normal SPA unmount also flushes the last source-scoped snapshot. Forced browser termination and actual storage failures cannot guarantee lossless recovery; export pending work before deliberately leaving when a warning is shown.

### Print and export

The saved question set can be opened as a self-contained student HTML handout or downloaded as Markdown. The student edition contains only the title, question text and writing space; original answers, diagnostic concerns, references, rubrics and teacher feedback are excluded. Teachers must still check whether they themselves placed an answer or private name in a title or question text. The explicitly labeled teacher reference edition includes its saved answer/rubric version.

HTML escapes all input and loads no scripts or external resources. Use the browser print command to print or save locally. The service does not generate PDFs. Explicit historical revisions are read directly, including versions older than the list's pagination limit; a missing version never falls back to the latest question set.

P2 research and tests backfill the source/behavior inventory recorded during implementation. Deterministic extraction and signature checks remain partial evidence of the overall product: real-model field classification, teacher review and classroom effectiveness still need separate evaluation.

## P3: student cases and evidence history

P3 adds student cases using the existing [identity and reporting research](TEACHING_ANALYSIS_P2_RESEARCH.md). Open **Teaching analysis → Student cases**, create a student code with an optional subject, then explicitly select and save confirmed report versions. A workspace-local case links at most 20 different reports. Its UUID stays stable when the label changes. Duplicate labels are allowed; the application never joins records merely because their names match.

Creating, renaming, archiving, restoring, adding/removing a report, or selecting a different report revision saves a new case snapshot with an optimistic revision check. A repeated successful request is idempotent. Reports and attempts retain their original history. Metadata-only edits can retain an already-linked unavailable source, so missing material does not prevent archiving a case; new or replaced links must resolve to an authorized, confirmed version.

The evidence timeline is a projection of the selected report versions and their associated nonvoid follow-up attempts. Each event retains its source and question versions. Times mean **recorded time**, because original learning-event dates are not yet captured. Newer source revisions produce a warning and do not silently replace the selected version. Missing sources remain visible as unavailable; their contents are never invented from another version.

Counts describe the full selected dataset rather than the displayed page. Assistance and teacher-assessed results stay jointly distinguishable; unknown or ungraded answers are not failures. Cursor pagination binds the selected case revision and source dataset. A concurrent case/source/attempt change requires a refresh instead of mixing pages from different states. There is no inferred mastery percentage, task-wide average, automatic knowledge-point merge, student login or classroom ranking.

Case-editor drafts are scoped to their precise page and case. Returning to the teaching workbench must preserve its separate pending material; discarding a case draft must not discard another case's draft. Restoring text remains explicit and cannot silently confirm a report or submit an attempt.

Recent report choices and case revision history show up to 100 entries with explicit notices. Student lists and evidence events support further pages. A selected report is always read by its exact revision, including versions older than the recent-history limit. Archived cases keep a read-only view of their evidence and history; restoring the case is an explicit status action.

The API adds `/student-cases`, `/student-cases/{case_id}`, `/student-cases/{case_id}/revisions`, and `/student-cases/{case_id}/timeline` below `/api/teaching-analysis`. `GET /reports/{report_id}/revisions/{revision}` reads an exact source version. Cases use a separate `student_cases.sqlite3` in the authorized teaching-analysis directory. This adds no model requests, student-account permissions or learner mastery writes.

## Verification

The next student-facing slice is documented in [Student tasks](STUDENT_TASKS.md). It keeps authenticated task delivery and submissions separate from anonymous student cases and teacher-assessed follow-up attempts.

Run focused Python domain/API tests and the web workflow tests, then typecheck, generated contracts and relevant lint/module checks. Use an isolated `DEEPTUTOR_HOME` for tests and development; do not use the teacher's only copy of student data.

The focused suites are `tests/learning/test_teaching_analysis.py`, `tests/api/test_teaching_analysis.py`, and `web/tests/teaching-analysis-workflow.spec.tsx`. Router-index, module-ownership and generated-contract checks cover registration. Browser acceptance should additionally cover source links, source changes invalidating results, draft/confirmation/history, failed imports retaining edits, download, and narrow/light/dark layouts. English and Chinese are the initial authored languages.

Real-model runs are separate from mock-provider contract tests. Report the model/version, input scope, failures, time to useful output, total time and usage availability. Never send hidden expected results along with evaluation inputs. A synthetic text transcription does not validate OCR or handwritten-image reading.
