# Student tasks

The student task flow connects a teacher-reviewed short practice set to an authenticated learner: open today's tasks, answer one question at a time, save progress, and explicitly hand the work to the teacher. It is implemented on the teacher-diagnostics fork. The task delivery and submission path does not invoke a model or mark work automatically. P5 adds optional device-local question listening and adult-enabled speech recognition, with candidate review before words enter an answer; see [Student task voice](STUDENT_TASK_VOICE.md). Guided hints remain a later slice.

## Evidence and decisions

Reviewed 2026-11-13 against the fork at `f749788f105e1c9c680cf06a58a40389c6c42c56`.

Khan Academy Kids separates adult class setup and assignment selection from a child's prominent start action. Its accessibility guidance describes assignments first, predictable navigation and manageable activities. We adapt those workflow patterns to DeepTutor's existing learner accounts and saved 1–3-question sets, without copying its content, claiming local curriculum alignment or introducing a public class-code login. [Teacher tools](https://khankids.zendesk.com/hc/en-us/articles/360041862972-All-about-Teacher-Tools-in-Khan-Academy-Kids), [accessibility statement](https://khankids.zendesk.com/hc/en-us/articles/48491600117787-Our-Accessibility-Statement).

The existing application already has learner presets, scoped grants, question cards, voice primitives and teacher follow-up snapshots. The existing task board is personal planning, not an assignment/submission store. Existing practice and reading quizzes may grade work or update learning records, so their write paths are not reused. Teacher follow-up attempts combine answers and assessments and cannot represent a later review without special handling; student submissions therefore have a separate lifecycle.

Authorization is evaluated for both the action and the specific object. Task IDs identify records; they do not grant access. Fresh identity and permission checks are necessary because an existing signed token can outlive an account disable or role change. This follows [OWASP authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) and the application's account/grant boundaries.

## Feature evidence ledger

| ID | Outcome and lifecycle | Decision | Delivery and current coverage | Acceptance and failure evidence |
| --- | --- | --- | --- | --- |
| ST-01 | Teacher issues a reviewed short task to a real learner | Copy an explicit saved question-set version into a deployment-private central store; recipient identity is an account ID, not an anonymous case label | Implemented; partial; previous teacher-only gap backfilled by source and product research | Fixed source/recipient, idempotent issuance, exact source checks, student-visible preview and explicit revoke |
| ST-02 | Child opens today's tasks without selecting a model or learning mode | Account-global inbox, task route exempt from the model requirement, explicit `tasks` permission | Implemented; partial | Real login and zero model grants; preserve explicit return links and existing restricted grants; authorization disabled is adult setup/preview only |
| ST-03 | Child can answer, ask for help and continue | One question at a time, short text, explicit `needs_help` separate from unanswered | Implemented; partial | No blank-as-wrong conversion; account/task buffer isolation, server CAS, recoverable network/storage errors and source-bound asynchronous responses |
| ST-04 | Work is handed to the teacher exactly once | Submit the complete final answers atomically under one stable submission ID; teacher reads the frozen receipt | Implemented; partial | Last keystroke, lost acknowledgement, retry, concurrent windows, revoke and post-submit read-only behavior; no implicit new attempt |
| ST-05 | Adults can control access and withdraw a task | Fresh enabled identity and grants on every operation; new learner defaults can expose tasks while old explicit surface lists are retained | Implemented; partial | Wrong learner/known ID, disabled/deleted account, changed role/preset/grant, workspace isolation and malformed payload refusal |
| ST-06a | Child can listen and speak an answer | Integrate optional task-scoped speech after the task delivery path is reliable | Implemented; partial; see [Student task voice](STUDENT_TASK_VOICE.md) | Explicit audio permission, transcription confirmation, cancellation, resource limits and manual fallback; real-child use remains unverified |
| ST-06b | Child receives progressive teaching hints | Build a separate teaching policy on reliable task responses | Planned; gap | Hint quality, pedagogy and real-child acceptance remain unverified |
| ST-07 | Teacher evaluates submitted work and uses it as later teaching evidence | Keep any future assessment revisions separate from immutable student submissions | Planned; gap | No automatic follow-up-attempt, student-case, mastery or retention writes in this first slice |
| ST-08 | Task-specific copy does not expand every page's initial download | Load task catalogs with the feature and retain only navigation/policy labels in the shared catalog; P3's root bundle is already 382KB against a 390KB budget | Implemented; partial | Retry task resources without an additional editor unmount; recover answers and the exact pending request after application-language remounts; verify production budgets |

Full Node checks also backfill two inherited localization gaps: punctuation in the English fallback worksheet label for German/Turkish, and the distinction between bilingual synthetic assignment data and interface labels. Existing student answers and sample output content are not translated or rewritten by this change. Bundle measurement uses an isolated unauthenticated server so it measures the requested route rather than a login redirect; real authentication and landing behavior have separate browser checks.

## Ownership and permissions

The central SQLite file is `data/system/student_tasks.sqlite3` under the configured runtime home. It is private server state. Teachers resolve their currently authorized content workspace before reading a saved follow-up; learner endpoints query the central store by the authenticated account ID and never read a teacher's filesystem. Teacher views remain scoped to the originating teacher content workspace. Existing administrators retain the platform's shared administrator-root semantics.

The learner inbox is independent of the child's selected content workspace. Its API client supplies an explicit empty `dt_workspace` query value, rather than borrowing the teacher's workspace ID or inheriting an unavailable learner workspace. Browser recovery is keyed by the real account and task, with a separate database from teacher drafts.

The existing application language provider can remount a page when its language changes. Recovery therefore retains both the answer text and the exact pending save/submission ID and payload. The learner explicitly restores and retries; restoration never automatically sends the work. The task-specific catalog gate preserves its own editor state while resources load or fail.

Only an enabled local learner account with task access may use student writes. A `student` role label alone is insufficient. Student responses are a field allowlist: task title, instructions, question IDs/text, that learner's own progress and submission receipt. Reference answers, scoring criteria, source diagnosis, historical student answers and teacher paths are not included. Teachers must still check titles and question text because a field allowlist cannot remove information deliberately written into those fields.

## Adult setup

An administrator prepares accounts and task permissions once. The application must be running with its existing multi-user authentication enabled. In account management (`/admin/users`), create a learner account or explicitly enable task access for an existing learner. Existing explicit reading-only or other restricted surface lists are not silently migrated. Give the child only their own account access, then use the saved practice-set publishing panel to select that account and check the child-visible questions before issuing the task.

For a local built-in-auth deployment, change only the `enabled` field to `true` in `<DEEPTUTOR_HOME>/data/user/settings/auth.json`, preserving the rest of that file and existing accounts. Restart the backend and frontend with matching authentication settings. If the deployment has no accounts, complete its first administrator registration; otherwise sign in with the existing administrator account. A newly provisioned learner must complete the required initial credential update before ordinary task access. An explicit safe return link is preserved; an ordinary learner sign-in with task access lands at `/learning/tasks`.

The normal single-user application remains an administrator session. It can show an adult setup explanation and a read-only question preview; it cannot masquerade as a child or accept an anonymous student submission. This feature does not enable authentication, replace credentials or create real accounts as a side effect. Follow the deployment's existing authentication setup and restart procedure when changing authentication configuration.

## Snapshots and completion

Issued question text is frozen. Updating the source report or question set does not change work already issued. To correct or replace an assignment, explicitly withdraw it and issue a new task. Withdrawals retain the original task, saved progress and submission history. A successful final submission remains one receipt; a later assessment or a retry must not be counted as another independent response.

Unanswered, answered and explicitly asking for help remain different states. Asking for help retains any partial response already written; the child can return to editing it, and the teacher sees that original work with its help-needed status. Help used defaults to unknown; a written answer does not prove independent work. Submission means the server has recorded the work, not that the answer is correct or a knowledge point is mastered.

Moving forward requires an answer or an explicit request for help. If a restored server draft still has an earlier unanswered question, the final check returns to that question before creating a submission request. It preserves the other answers rather than repeatedly submitting an invalid form.

## Verification

Use an isolated D-drive runtime and synthetic accounts/materials. Required checks include domain and API state transitions, real authorization and stale tokens, public payload allowlists, scope/source changes, retry/CAS and incomplete-storage behavior, plus rendered and production-browser task delivery. Exercise actual admin and learner login with zero model profiles/grants. Preserve the normal runtime's settings and data.

Focused backend suites are `tests/learning/test_student_tasks.py`, `tests/api/test_student_tasks.py`, and `tests/multi_user/test_learning_tasks_{access,policy}.py`. Rendered suites cover `student-tasks-workflow`, `student-task-buffers`, `student-task-auth-boundary`, `student-task-landing`, `student-task-question` and `teacher-student-tasks`; task resource loading also has dedicated retry/language-state tests. Existing teacher workflows and learner navigation remain regression targets.

Automated correctness and browser operation are separate from classroom effectiveness. No real-child usability study, real-model diagnostic evaluation, transcription accuracy or teaching-outcome claim follows from this first implementation.
