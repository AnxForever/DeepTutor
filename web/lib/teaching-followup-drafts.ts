import type { FollowupQuestion, SavedFollowup, SavedFollowupAttempt, SaveFollowupAttemptRequest, SaveFollowupRequest } from './teaching-followups-api'
import { draftObject, draftText, draftUuid } from './teaching-draft-validation'

export interface FollowupWorkspaceDraft {
  kind: 'followup-workspace'
  version: 1
  report_id: string
  report_revision: number
  draft: SaveFollowupRequest | null
  selected: SavedFollowup | null
  void_target: SavedFollowupAttempt | null
  void_reason: string
}
export interface FollowupResponseDraft {
  kind: 'followup-response'
  version: 1
  followup_id: string
  followup_revision: number
  question_id: string
  question_snapshot: FollowupQuestion
  payload: SaveFollowupAttemptRequest
}

export const followupWorkspaceSlot = (reportId: string, revision: number) => `followup-workspace:${reportId}:${revision}`
export const followupResponseSlot = (followupId: string, revision: number, questionId: string) => `followup-response:${followupId}:${revision}:${questionId}`

const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key))
const revision = (value: unknown, zero = false): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= (zero ? 0 : 1)
const timestamp = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const nonblank = (value: unknown, max: number): value is string => draftText(value, max) && Boolean(value.trim())
const nullable = (value: unknown, max: number) => value === null || draftText(value, max)
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const choice = (value: unknown, allowed: string[]) => typeof value === 'string' && allowed.includes(value)
const priority = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2

const questionKeys = ['question_id', 'question', 'reference_answer', 'rubric']
function question(value: unknown, pending = false): value is FollowupQuestion {
  return draftObject(value) && keys(value, questionKeys) && (pending ? draftText(value.question_id, 128) && draftText(value.question, 6000) : nonblank(value.question_id, 128) && nonblank(value.question, 6000)) &&
    nullable(value.reference_answer, 6000) && nullable(value.rubric, 4000)
}

const contentKeys = ['followup_id', 'report_id', 'report_revision', 'priority_index', 'title', 'questions']
const sourceKeys = ['student_ref', 'assignment_ref', 'subject', 'grade', 'source_fingerprint', 'knowledge_point']
const payloadKeys = ['attempt_id', 'followup_revision', 'question_id', 'student_answer', 'student_work', 'answer_status', 'assistance', 'teacher_result', 'teacher_feedback']
function source(value: Record<string, unknown>): boolean {
  return ['student_ref', 'assignment_ref', 'subject', 'grade', 'knowledge_point'].every(key => draftText(value[key], 200)) && hash(value.source_fingerprint)
}
function content(value: Record<string, unknown>, pending: boolean): boolean {
  return draftUuid(value.followup_id) && draftUuid(value.report_id) && revision(value.report_revision) && priority(value.priority_index) && draftText(value.title, 300) &&
    (pending || Boolean(String(value.title).trim())) && Array.isArray(value.questions) && value.questions.length >= 1 && value.questions.length <= 3 && value.questions.every(item => question(item, pending)) &&
    (pending || new Set(value.questions.map(item => item.question_id)).size === value.questions.length)
}
function pendingSet(value: unknown): value is SaveFollowupRequest {
  return draftObject(value) && keys(value, [...contentKeys, 'expected_revision']) && content(value, true) && revision(value.expected_revision, true)
}
export function isSavedFollowupDraftBase(value: unknown): value is SavedFollowup {
  return draftObject(value) && keys(value, [...contentKeys, ...sourceKeys, 'revision', 'created_at', 'updated_at']) && content(value, false) && source(value) &&
    revision(value.revision) && timestamp(value.created_at) && timestamp(value.updated_at)
}
function payload(value: unknown, strict = true): boolean {
  if (!draftObject(value) || (strict && !keys(value, payloadKeys)) || !draftUuid(value.attempt_id) || !revision(value.followup_revision) || !nonblank(value.question_id, 128) ||
    !nullable(value.student_answer, 6000) || !nullable(value.student_work, 8000) || !draftText(value.teacher_feedback, 4000) ||
    !choice(value.answer_status, ['present', 'confirmed_blank', 'unknown']) || !choice(value.assistance, ['independent', 'assisted', 'unknown']) ||
    !choice(value.teacher_result, ['ungraded', 'correct', 'partial', 'incorrect'])) return false
  const actual = Boolean((typeof value.student_answer === 'string' && value.student_answer.trim()) || (typeof value.student_work === 'string' && value.student_work.trim()))
  return (value.answer_status !== 'present' || actual) && (value.answer_status !== 'confirmed_blank' || (value.student_answer === '' && value.student_work === '')) &&
    (value.answer_status !== 'unknown' || value.student_answer === null) && (value.answer_status === 'present' || value.teacher_result === 'ungraded')
}
function savedAttempt(value: unknown): value is SavedFollowupAttempt {
  return draftObject(value) && keys(value, [...payloadKeys, ...sourceKeys, 'followup_id', 'report_id', 'report_revision', 'priority_index', 'question_snapshot', 'created_at', 'voided_at', 'void_reason']) &&
    payload(value, false) && source(value) && draftUuid(value.followup_id) && draftUuid(value.report_id) && revision(value.report_revision) && priority(value.priority_index) &&
    question(value.question_snapshot) && value.question_id === value.question_snapshot.question_id && timestamp(value.created_at) &&
    (value.voided_at === null ? value.void_reason === null : timestamp(value.voided_at) && nonblank(value.void_reason, 2000))
}

export function isFollowupWorkspaceDraft(value: unknown): value is FollowupWorkspaceDraft {
  if (!draftObject(value) || !keys(value, ['kind', 'version', 'report_id', 'report_revision', 'draft', 'selected', 'void_target', 'void_reason']) || value.kind !== 'followup-workspace' || value.version !== 1 ||
    !draftUuid(value.report_id) || !revision(value.report_revision) || !draftText(value.void_reason, 2000) ||
    !(value.draft === null || pendingSet(value.draft)) || !(value.selected === null || isSavedFollowupDraftBase(value.selected)) || !(value.void_target === null || savedAttempt(value.void_target))) return false
  if (value.selected && (value.selected.report_id !== value.report_id || value.selected.report_revision > value.report_revision)) return false
  if (value.draft) {
    if (value.draft.report_id !== value.report_id || value.draft.report_revision !== value.report_revision || value.void_target !== null || value.void_reason !== '') return false
    if (value.draft.expected_revision === 0) return value.selected === null
    return value.selected !== null && value.selected.followup_id === value.draft.followup_id && value.selected.revision === value.draft.expected_revision && value.selected.priority_index === value.draft.priority_index
  }
  if (value.void_target) return value.selected !== null && value.void_target.followup_id === value.selected.followup_id && value.void_target.report_id === value.report_id && value.void_target.voided_at === null
  return value.void_reason === ''
}

export function isFollowupResponseDraft(value: unknown): value is FollowupResponseDraft {
  return draftObject(value) && keys(value, ['kind', 'version', 'followup_id', 'followup_revision', 'question_id', 'question_snapshot', 'payload']) && value.kind === 'followup-response' && value.version === 1 &&
    draftUuid(value.followup_id) && revision(value.followup_revision) && nonblank(value.question_id, 128) && question(value.question_snapshot) && draftObject(value.payload) && payload(value.payload) &&
    value.question_snapshot.question_id === value.question_id && value.payload.question_id === value.question_id && value.payload.followup_revision === value.followup_revision
}

export function sameFollowupQuestion(left: FollowupQuestion, right: FollowupQuestion): boolean {
  return left.question_id === right.question_id && left.question === right.question && left.reference_answer === right.reference_answer && left.rubric === right.rubric
}

/** Cached saved sets are view context until an authorized read confirms them. */
export function sameSavedFollowup(left: SavedFollowup, right: SavedFollowup): boolean {
  return [...contentKeys.filter(key => key !== 'questions'), ...sourceKeys, 'revision', 'created_at', 'updated_at'].every(key => left[key as keyof SavedFollowup] === right[key as keyof SavedFollowup]) &&
    left.questions.length === right.questions.length && left.questions.every((item, index) => sameFollowupQuestion(item, right.questions[index]))
}
