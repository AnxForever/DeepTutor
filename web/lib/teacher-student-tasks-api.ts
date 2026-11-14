import { requestJson } from '@/shared/api/client'
import { scopedUrl } from '@/lib/workspace-scope'
import type { SavedFollowup } from '@/lib/teaching-followups-api'
import { isSavedFollowupDraftBase } from '@/lib/teaching-followup-drafts'
import { draftObject, draftText, draftUuid } from '@/lib/teaching-draft-validation'
import type { components } from '@/contracts/generated/api'

const ROOT = '/api/teaching-analysis/student-tasks'

type Mutable<T> = T extends readonly (infer Item)[] ? Mutable<Item>[] : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T
type Complete<T> = T extends readonly (infer Item)[] ? Complete<Item>[] : T extends object ? { -readonly [Key in keyof T]-?: Complete<T[Key]> } : T
type Schema<Name extends keyof components['schemas']> = Mutable<components['schemas'][Name]>
export type StudentTaskRecipient = Complete<components['schemas']['TaskRecipient']>
export type StudentTaskSetup = Complete<components['schemas']['TaskRecipientSetup']>
export type TaskQuestionHints = Complete<components['schemas']['TaskQuestionHints']>
export type TaskHintUsage = Complete<components['schemas']['TaskHintUsage']>
export type IssueStudentTaskRequest = Omit<Complete<components['schemas']['IssueTaskRequest']>, 'question_hints'> & { question_hints?: TaskQuestionHints[] }
export type RevokeStudentTaskRequest = Complete<components['schemas']['RevokeTaskRequest']>
export type TeacherStudentTaskSummary = Complete<components['schemas']['TeacherTaskSummary']>
export type StudentTaskFinalResponse = Complete<components['schemas']['TaskResponse']>
type Submission = Omit<NonNullable<Complete<components['schemas']['TeacherTaskView']>['submission']>, 'hint_usage'> & { hint_usage?: TaskHintUsage[] | null }
export type TeacherStudentTask = Omit<Complete<components['schemas']['TeacherTaskView']>, 'source_snapshot' | 'submission' | 'question_hints' | 'hint_usage'> & { source_snapshot: SavedFollowup; question_hints?: TaskQuestionHints[]; hint_usage?: TaskHintUsage[]; submission: Submission | null }
type WireTask = Omit<Schema<'TeacherTaskView'>, 'question_hints' | 'hint_usage' | 'submission'> & { question_hints?: TaskQuestionHints[]; hint_usage?: TaskHintUsage[]; submission: (NonNullable<Schema<'TeacherTaskView'>['submission']> & { hint_usage?: TaskHintUsage[] | null }) | null }

function normalizeSummary(value: Schema<'TeacherTaskSummary'>): TeacherStudentTaskSummary {
  return { ...value, submitted_at: value.submitted_at ?? null, progress: { ...value.progress, saved_at: value.progress.saved_at ?? null } }
}
function normalizeTask(value: WireTask): TeacherStudentTask {
  return {
    ...value, ...normalizeSummary(value), started_at: value.started_at ?? null, revoked_at: value.revoked_at ?? null, revoke_reason: value.revoke_reason ?? null,
    source_snapshot: { ...value.source_snapshot, questions: value.source_snapshot.questions.map(question => ({ ...question, reference_answer: question.reference_answer ?? null, rubric: question.rubric ?? null })) },
    question_hints: cloneQuestionHints(value.question_hints), hint_usage: cloneHintUsage(value.hint_usage ?? []),
    submission: value.submission === null ? null : { ...value.submission, hint_usage: value.submission.hint_usage == null ? null : cloneHintUsage(value.submission.hint_usage), responses: value.submission.responses.map(response => ({ ...response, answer: response.answer ?? null })) },
  }
}

const endpoint = (path: string, workspaceId: string) => scopedUrl(`${ROOT}${path}`, workspaceId)
const json = (body: unknown, signal?: AbortSignal): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })

export function getStudentTaskRecipients(workspaceId: string, signal?: AbortSignal) {
  return requestJson<StudentTaskSetup>(endpoint('/recipients', workspaceId), { cache: 'no-store', signal })
}
export async function listTeacherStudentTasks(followupId: string, query: { limit?: number; offset?: number }, workspaceId: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ followup_id: followupId, limit: String(query.limit ?? 20), offset: String(query.offset ?? 0) })
  return (await requestJson<Schema<'TeacherTaskSummary'>[]>(endpoint(`?${params}`, workspaceId), { cache: 'no-store', signal })).map(normalizeSummary)
}
export async function issueStudentTask(body: IssueStudentTaskRequest, workspaceId: string, signal?: AbortSignal) {
  return normalizeTask(await requestJson<WireTask>(endpoint('', workspaceId), json(canonicalStudentTaskIssue(body), signal)))
}
export async function getTeacherStudentTask(taskId: string, workspaceId: string, signal?: AbortSignal) {
  return normalizeTask(await requestJson<WireTask>(endpoint(`/${encodeURIComponent(taskId)}`, workspaceId), { cache: 'no-store', signal }))
}
export async function revokeStudentTask(taskId: string, body: RevokeStudentTaskRequest, workspaceId: string, signal?: AbortSignal) {
  return normalizeTask(await requestJson<WireTask>(endpoint(`/${encodeURIComponent(taskId)}/revoke`, workspaceId), json(body, signal)))
}

export const cloneQuestionHints = (value?: TaskQuestionHints[]) => (value ?? []).map(({ question_id, hints }) => ({ question_id, hints: [...hints] }))
const cloneHintUsage = (value: TaskHintUsage[]) => value.map(({ question_id, revealed }) => ({ question_id, revealed: revealed.map(({ level, revealed_at }) => ({ level, revealed_at })) }))
export function cloneStudentTaskIssue(value: IssueStudentTaskRequest): IssueStudentTaskRequest {
  return { ...value, ...(value.question_hints === undefined ? {} : { question_hints: cloneQuestionHints(value.question_hints) }) }
}
/** Match the server receipt convention: old absent and new empty plans are equivalent. */
export function canonicalStudentTaskIssue(value: IssueStudentTaskRequest): IssueStudentTaskRequest {
  const cloned = cloneStudentTaskIssue(value)
  if (!cloned.question_hints?.length) delete cloned.question_hints
  return cloned
}
export function sameQuestionHints(left?: TaskQuestionHints[], right?: TaskQuestionHints[]) {
  const a = left ?? [], b = right ?? []
  return a.length === b.length && a.every((entry, index) => entry.question_id === b[index].question_id && entry.hints.length === b[index].hints.length && entry.hints.every((hint, level) => hint === b[index].hints[level]))
}

/** Explicit projection: teacher-only labels, keys, rubrics and observations never enter the preview. */
export function studentVisibleTaskPreview(source: SavedFollowup, title: string, instructions: string, hints?: TaskQuestionHints[]) {
  return { title, instructions, questions: source.questions.map(({ question_id, question }) => ({ question_id, question })), ...(hints?.length ? { question_hints: cloneQuestionHints(hints) } : {}) }
}

export const studentTaskPublishSlot = (followupId: string) => `student-task-publish:${followupId}`
export interface StudentTaskPublishDraft {
  kind: 'student-task-publish'; version: 1; source: SavedFollowup; payload: IssueStudentTaskRequest
  reviewed: boolean; submitted_payload: IssueStudentTaskRequest | null; acknowledged_task_id: string | null
  revoke: { task_id: string; expected_revision: number; reason: string } | null
}
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key))
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
const payloadKeys = ['task_id', 'followup_id', 'followup_revision', 'recipient_user_id', 'title', 'instructions']
export function validTaskHintText(value: unknown): value is string {
  return draftText(value, 600) && Array.from(value).every(character => character.length === 2 || character.charCodeAt(0) < 0xd800 || character.charCodeAt(0) > 0xdfff)
}
export function validQuestionHintPlan(value: unknown, source: SavedFollowup, editing = false): value is TaskQuestionHints[] {
  if (!Array.isArray(value) || value.length > 3) return false
  const ids = new Set(source.questions.map(question => question.question_id))
  return value.every(entry => draftObject(entry) && keys(entry, ['question_id', 'hints']) && typeof entry.question_id === 'string' && ids.has(entry.question_id) && Array.isArray(entry.hints) && entry.hints.length >= 1 && entry.hints.length <= 3 && entry.hints.every(hint => validTaskHintText(hint) && (editing || Boolean(hint.trim())))) && new Set(value.map(entry => entry.question_id)).size === value.length
}
function isIssueDraft(value: unknown, source: SavedFollowup, editing = true): value is IssueStudentTaskRequest {
  return draftObject(value) && keys(value, [...payloadKeys, 'question_hints']) && draftUuid(value.task_id) && draftUuid(value.followup_id) && positive(value.followup_revision) && draftText(value.recipient_user_id, 64) && draftText(value.title, 200) && draftText(value.instructions, 1000) &&
    (editing || Boolean(value.recipient_user_id.trim() && value.title.trim())) && validQuestionHintPlan(value.question_hints === undefined ? [] : value.question_hints, source, editing)
}
export function sameStudentTaskIntent(left: IssueStudentTaskRequest, right: IssueStudentTaskRequest) { return payloadKeys.every(key => left[key as keyof IssueStudentTaskRequest] === right[key as keyof IssueStudentTaskRequest]) && sameQuestionHints(left.question_hints, right.question_hints) }
export function isStudentTaskPublishDraft(value: unknown): value is StudentTaskPublishDraft {
  if (!draftObject(value) || !keys(value, ['kind', 'version', 'source', 'payload', 'reviewed', 'submitted_payload', 'acknowledged_task_id', 'revoke']) || value.kind !== 'student-task-publish' || value.version !== 1 || !isSavedFollowupDraftBase(value.source) || !isIssueDraft(value.payload, value.source) || typeof value.reviewed !== 'boolean') return false
  if (value.payload.followup_id !== value.source.followup_id || value.payload.followup_revision !== value.source.revision) return false
  if (value.reviewed && !validQuestionHintPlan(value.payload.question_hints ?? [], value.source)) return false
  if (!(value.submitted_payload === null || (isIssueDraft(value.submitted_payload, value.source, false) && sameStudentTaskIntent(value.payload, value.submitted_payload)))) return false
  if (!(value.acknowledged_task_id === null || (draftUuid(value.acknowledged_task_id) && value.acknowledged_task_id === value.payload.task_id && value.submitted_payload !== null))) return false
  return value.revoke === null || (draftObject(value.revoke) && keys(value.revoke, ['task_id', 'expected_revision', 'reason']) && draftUuid(value.revoke.task_id) && positive(value.revoke.expected_revision) && draftText(value.revoke.reason, 2000))
}
