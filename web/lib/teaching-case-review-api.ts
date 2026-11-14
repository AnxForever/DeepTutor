import { requestJson } from '@/shared/api/client'
import { scopedUrl } from '@/lib/workspace-scope'
import type { components } from '@/contracts/generated/api'

type Mutable<T> = T extends readonly (infer Item)[] ? Mutable<Item>[] : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T
type Complete<T> = T extends readonly (infer Item)[] ? Complete<Item>[] : T extends object ? { -readonly [Key in keyof T]-?: Complete<T[Key]> } : T
type Schema<Name extends keyof components['schemas']> = Mutable<components['schemas'][Name]>
export type CaseReviewEvidenceLink = Complete<components['schemas']['CaseReviewEvidenceLink']>
export type SaveCaseReviewEvidence = Complete<components['schemas']['SaveCaseReviewEvidence']>
export type SavedCaseReviewEvidence = Complete<components['schemas']['SavedCaseReviewEvidence']>
export type CaseReviewQuestionEvidence = Complete<components['schemas']['CaseReviewQuestionEvidence']>
export type CaseReviewEvidenceSourceState = Complete<components['schemas']['CaseReviewEvidenceSourceState']>
export type CaseReviewFocusCard = Complete<components['schemas']['CaseReviewFocusCard']>
export type CaseReviewEvidenceView = Complete<components['schemas']['CaseReviewEvidenceView']>
function saved(value: Schema<'SavedCaseReviewEvidence'> | null): SavedCaseReviewEvidence | null { return value === null ? null : { ...value, recipient_user_id: value.recipient_user_id ?? null } }
function normalize(value: Schema<'CaseReviewEvidenceView'>): CaseReviewEvidenceView {
  return { ...value, overlay: saved(value.overlay), acknowledged: saved(value.acknowledged ?? null), source_states: value.source_states.map(state => ({ ...state, knowledge_point: state.knowledge_point ?? null, latest_recorded_at: state.latest_recorded_at ?? null, latest_review_revision: state.latest_review_revision ?? null, latest_review_status: state.latest_review_status ?? null, recipient_user_id: state.recipient_user_id ?? null, recorded_at: state.recorded_at ?? null, report_id: state.report_id ?? null, report_revision: state.report_revision ?? null, review_status: state.review_status ?? null, reviewer_user_id: state.reviewer_user_id ?? null, subject: state.subject ?? null, questions: state.questions ?? [] })) }
}

function endpoint(caseId: string, workspaceId: string) { return scopedUrl(`/api/teaching-analysis/student-cases/${encodeURIComponent(caseId)}/task-review-evidence`, workspaceId) }
export async function getCaseTaskReviewEvidence(caseId: string, workspaceId: string, signal?: AbortSignal) {
  return normalize(await requestJson<Schema<'CaseReviewEvidenceView'>>(endpoint(caseId, workspaceId), { cache: 'no-store', signal }))
}
export async function saveCaseTaskReviewEvidence(caseId: string, body: SaveCaseReviewEvidence, workspaceId: string, signal?: AbortSignal) {
  return normalize(await requestJson<Schema<'CaseReviewEvidenceView'>>(endpoint(caseId, workspaceId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cloneCaseEvidenceRequest(body)), signal }))
}
export function cloneCaseEvidenceLinks(links: CaseReviewEvidenceLink[]): CaseReviewEvidenceLink[] {
  return links.map(link => ({ task_id: link.task_id.toLowerCase(), submission_id: link.submission_id.toLowerCase(), review_revision: link.review_revision, question_ids: [...link.question_ids], teacher_observation: link.teacher_observation ?? '', next_teaching_action: link.next_teaching_action ?? '' }))
}
export function cloneCaseEvidenceRequest(value: SaveCaseReviewEvidence): SaveCaseReviewEvidence { return { ...value, request_id: value.request_id.toLowerCase(), links: cloneCaseEvidenceLinks(value.links) } }
export function sameCaseEvidenceLinks(left: CaseReviewEvidenceLink[], right: CaseReviewEvidenceLink[]) { return JSON.stringify(cloneCaseEvidenceLinks(left)) === JSON.stringify(cloneCaseEvidenceLinks(right)) }
export function sameCaseEvidenceRequest(left: SaveCaseReviewEvidence, right: SaveCaseReviewEvidence) {
  return left.request_id.toLowerCase() === right.request_id.toLowerCase() && left.expected_revision === right.expected_revision && left.expected_case_revision === right.expected_case_revision && left.identity_confirmed === right.identity_confirmed && sameCaseEvidenceLinks(left.links, right.links)
}
export function matchesCaseEvidenceReceipt(view: CaseReviewEvidenceView, caseId: string, request: SaveCaseReviewEvidence, recipient?: string) {
  const receipt = view.acknowledged
  return view.case_id.toLowerCase() === caseId.toLowerCase() && receipt?.case_id.toLowerCase() === caseId.toLowerCase() && receipt.request_id.toLowerCase() === request.request_id.toLowerCase() && receipt.case_revision === request.expected_case_revision && receipt.identity_confirmed === true && (recipient === undefined || receipt.recipient_user_id === recipient) && sameCaseEvidenceLinks(receipt.links, request.links)
}
