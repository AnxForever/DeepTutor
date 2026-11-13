import { requestJson } from '@/shared/api/client'
import { scopedUrl } from '@/lib/workspace-scope'
import type { SavedTeachingReport } from '@/lib/teaching-analysis-api'
import type { components } from '@/contracts/generated/api'

export const STUDENT_CASES_HOME = '/learning/teaching-analysis/students'
const ROOT = '/api/teaching-analysis/student-cases'

type Mutable<T> = T extends readonly (infer Item)[] ? Mutable<Item>[] : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T
type Complete<T> = T extends readonly (infer Item)[] ? Complete<Item>[] : T extends object ? { -readonly [Key in keyof T]-?: Complete<T[Key]> } : T
type Schema<Name extends keyof components['schemas']> = Mutable<components['schemas'][Name]>
export type StudentCaseReportRef = Complete<components['schemas']['PinnedReportRef']>
export type SaveStudentCaseRequest = Complete<components['schemas']['SaveStudentCaseRequest']>
export type SavedStudentCase = Complete<components['schemas']['SavedStudentCase']>
export type StudentCaseSummary = Complete<components['schemas']['StudentCaseSummary']>
export type StudentCaseSourceState = Complete<components['schemas']['CaseSourceState']>
export type StudentCaseReportSnapshot = Complete<components['schemas']['CaseReportSnapshot']>
export type StudentCaseTimelineEvent = Complete<components['schemas']['CaseReportEvent']> | Complete<components['schemas']['CaseAttemptEvent']>
export type StudentCaseResultCounts = Complete<components['schemas']['CaseResultCounts']>
export type StudentCaseTimelineCounts = Complete<components['schemas']['CaseTimelineCounts']>
export type StudentCaseTimeline = Complete<components['schemas']['StudentCaseTimeline']>

function normalizeCase(value: Schema<'SavedStudentCase'>): SavedStudentCase {
  return { ...value, report_refs: value.report_refs ?? [], subject: value.subject ?? null, archived: value.archived ?? false }
}

export function studentCaseRoute(caseId: string, workspaceId: string) { return scopedUrl(`${STUDENT_CASES_HOME}/${encodeURIComponent(caseId)}`, workspaceId) }
export function listStudentCases(query: { archived?: boolean; limit?: number; offset?: number }, workspaceId: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ archived: String(query.archived ?? false), limit: String(query.limit ?? 50), offset: String(query.offset ?? 0) })
  return requestJson<StudentCaseSummary[]>(scopedUrl(`${ROOT}?${params}`, workspaceId), { cache: 'no-store', signal })
}
export async function getStudentCase(caseId: string, workspaceId: string, signal?: AbortSignal) {
  return normalizeCase(await requestJson<Schema<'SavedStudentCase'>>(scopedUrl(`${ROOT}/${encodeURIComponent(caseId)}`, workspaceId), { cache: 'no-store', signal }))
}
export async function saveStudentCase(body: SaveStudentCaseRequest, workspaceId: string, signal?: AbortSignal) {
  return normalizeCase(await requestJson<Schema<'SavedStudentCase'>>(scopedUrl(ROOT, workspaceId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }))
}
export async function getStudentCaseRevisions(caseId: string, workspaceId: string, signal?: AbortSignal) {
  return (await requestJson<Schema<'SavedStudentCase'>[]>(scopedUrl(`${ROOT}/${encodeURIComponent(caseId)}/revisions`, workspaceId), { cache: 'no-store', signal })).map(normalizeCase)
}
export async function getStudentCaseTimeline(caseId: string, query: { limit?: number; cursor?: string }, workspaceId: string, signal?: AbortSignal): Promise<StudentCaseTimeline> {
  const params = new URLSearchParams({ limit: String(query.limit ?? 30) })
  if (query.cursor) params.set('cursor', query.cursor)
  const value = await requestJson<Schema<'StudentCaseTimeline'>>(scopedUrl(`${ROOT}/${encodeURIComponent(caseId)}/timeline?${params}`, workspaceId), { cache: 'no-store', signal })
  // Response models materialize defaults; explicitly restore union discriminants.
  return { ...value, source_states: value.source_states.map(state => ({ ...state, latest_revision: state.latest_revision ?? null, student_ref: state.student_ref ?? null, assignment_ref: state.assignment_ref ?? null, message: state.message ?? null })), events: value.events.map(event => 'report_snapshot' in event ? { ...event, kind: 'report' } : { ...event, kind: 'attempt' }) } as StudentCaseTimeline
}
export function getTeachingReportRevision(reportId: string, revision: number, workspaceId: string, signal?: AbortSignal) {
  return requestJson<SavedTeachingReport>(scopedUrl(`/api/teaching-analysis/reports/${encodeURIComponent(reportId)}/revisions/${revision}`, workspaceId), { cache: 'no-store', signal })
}
