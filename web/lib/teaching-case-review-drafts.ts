import { draftObject, draftText, draftUuid, isPlainTeachingJson } from './teaching-draft-validation'
import { sameCaseEvidenceRequest, type SaveCaseReviewEvidence } from './teaching-case-review-api'

export interface CaseEvidenceMutation { payload: SaveCaseReviewEvidence; submitted_payload: SaveCaseReviewEvidence | null; acknowledged_request_id: string | null }
export interface ReviewLinkTarget { task_id: string; submission_id: string; review_revision: number; recipient_user_id: string; report_id: string; report_revision: number; source_fingerprint: string; question_ids: string[] }
export interface TaskReviewCaseDraft { kind: 'task-review-case-link'; version: 1; target: ReviewLinkTarget; case_id: string | null; case_label: string; mutation: CaseEvidenceMutation | null; identity_checked: boolean }
export interface CaseEvidencePanelDraft { kind: 'case-review-evidence'; version: 1; case_id: string; mutation: CaseEvidenceMutation | null; identity_checked: boolean }
export const taskReviewCaseSlot = (taskId: string) => `task-review:${taskId}:case-link`
export const caseReviewEvidenceSlot = (caseId: string) => `student-case:${caseId}:task-review-evidence`
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key))
const integer = (value: unknown, min = 1): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min
function text(value: unknown, max: number): value is string { return draftText(value, max) && Array.from(value).every(character => character.length === 2 || character.charCodeAt(0) < 0xd800 || character.charCodeAt(0) > 0xdfff) }
function questions(value: unknown, empty = false): value is string[] { return Array.isArray(value) && value.length <= 3 && (empty || value.length > 0) && value.every(id => text(id, 128) && Boolean(id.trim())) && new Set(value).size === value.length }
function request(value: unknown, editing = false): value is SaveCaseReviewEvidence {
  return draftObject(value) && keys(value, ['request_id', 'expected_revision', 'expected_case_revision', 'identity_confirmed', 'links']) && draftUuid(value.request_id) && integer(value.expected_revision, 0) && integer(value.expected_case_revision) && value.identity_confirmed === true && Array.isArray(value.links) && value.links.length <= 20 && value.links.every(link => draftObject(link) && keys(link, ['task_id', 'submission_id', 'review_revision', 'question_ids', 'teacher_observation', 'next_teaching_action']) && draftUuid(link.task_id) && draftUuid(link.submission_id) && integer(link.review_revision) && questions(link.question_ids, editing) && text(link.teacher_observation, 2000) && text(link.next_teaching_action, 2000)) && new Set(value.links.map(link => link.submission_id.toLowerCase())).size === value.links.length
}
function mutation(value: unknown): value is CaseEvidenceMutation {
  return draftObject(value) && keys(value, ['payload', 'submitted_payload', 'acknowledged_request_id']) && request(value.payload, true) && (value.submitted_payload === null || (request(value.submitted_payload) && sameCaseEvidenceRequest(value.payload, value.submitted_payload))) && (value.acknowledged_request_id === null || (typeof value.acknowledged_request_id === 'string' && draftUuid(value.acknowledged_request_id) && value.acknowledged_request_id.toLowerCase() === value.payload.request_id.toLowerCase() && value.submitted_payload !== null))
}
function target(value: unknown): value is ReviewLinkTarget {
  return draftObject(value) && keys(value, ['task_id','submission_id','review_revision','recipient_user_id','report_id','report_revision','source_fingerprint','question_ids']) && draftUuid(value.task_id) && draftUuid(value.submission_id) && integer(value.review_revision) && text(value.recipient_user_id, 64) && Boolean(value.recipient_user_id.trim()) && draftUuid(value.report_id) && integer(value.report_revision) && typeof value.source_fingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.source_fingerprint) && questions(value.question_ids)
}
export function isTaskReviewCaseDraft(value: unknown): value is TaskReviewCaseDraft {
  if (!isPlainTeachingJson(value) || !draftObject(value) || !keys(value, ['kind','version','target','case_id','case_label','mutation','identity_checked']) || value.kind !== 'task-review-case-link' || value.version !== 1 || !target(value.target) || !(value.case_id === null || draftUuid(value.case_id)) || !text(value.case_label, 200) || typeof value.identity_checked !== 'boolean' || !(value.mutation === null || mutation(value.mutation))) return false
  if (value.case_id === null) return value.mutation === null && value.case_label === '' && !value.identity_checked
  if (value.mutation === null) return !value.identity_checked
  const context = value.target
  const linked = value.mutation.payload.links.find(link => link.submission_id.toLowerCase() === context.submission_id.toLowerCase())
  return Boolean(linked && linked.task_id.toLowerCase() === context.task_id.toLowerCase() && linked.review_revision === context.review_revision && linked.question_ids.every(id => context.question_ids.includes(id)))
}
export function isCaseEvidencePanelDraft(value: unknown): value is CaseEvidencePanelDraft {
  return isPlainTeachingJson(value) && draftObject(value) && keys(value, ['kind','version','case_id','mutation','identity_checked']) && value.kind === 'case-review-evidence' && value.version === 1 && draftUuid(value.case_id) && typeof value.identity_checked === 'boolean' && (value.mutation === null ? !value.identity_checked : mutation(value.mutation))
}
