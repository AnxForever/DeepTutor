import { requestJson } from '@/shared/api/client'
import { scopedUrl } from '@/lib/workspace-scope'
import type { components } from '@/contracts/generated/api'
import type { RubricSnapshot } from '@/lib/teaching-rubrics-api'

export const TEACHING_ANALYSIS_HOME = '/learning/teaching-analysis'
const ROOT = '/api/teaching-analysis'

type Mutable<T> = T extends readonly (infer Item)[] ? Mutable<Item>[] : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T
type Schema<Name extends keyof components['schemas']> = Mutable<components['schemas'][Name]>

export type AssignmentItem = Required<Schema<'AssignmentItem'>>
export type AssignmentInput = Omit<Required<Schema<'AssignmentInput'>>, 'items' | 'rubric_template'> & { items: AssignmentItem[]; rubric_template: RubricSnapshot | null }
export type TeachingEvidence = Schema<'Evidence'>
export type TeachingItemFinding = Schema<'ItemReview'>
export type TeachingPriority = Schema<'TeachingPriority'>
export type ReportContent = Schema<'ReportContent'>
export type AnalysisResult = Schema<'GeneratedAnalysis'>
export type SaveTeachingReport = Omit<Schema<'SaveReportRequest'>, 'assignment'> & { assignment: AssignmentInput }
export type SavedTeachingReport = Omit<Schema<'SavedReport'>, 'assignment'> & { assignment: AssignmentInput }
export type TeachingReportSummary = Schema<'ReportSummary'>

/** Preview responses materialize Pydantic defaults; keep editable values explicit. */
function normalizeAssignment(value: Schema<'AssignmentInput'> & { rubric_template?: RubricSnapshot | null }): AssignmentInput {
  return {
    ...value,
    document_provenance: value.document_provenance ?? null,
    rubric_template: value.rubric_template ?? null,
    items: (value.items ?? []).map(item => ({
      ...item,
      student_answer: item.student_answer ?? null,
      student_work: item.student_work ?? null,
      reference_answer: item.reference_answer ?? null,
      rubric: item.rubric ?? null,
      knowledge_points: item.knowledge_points ?? [],
    })),
  }
}

function normalizeReport(value: Schema<'SavedReport'>): SavedTeachingReport {
  return { ...value, assignment: normalizeAssignment(value.assignment) }
}

function endpoint(path: string, workspaceId: string) {
  return scopedUrl(`${ROOT}${path}`, workspaceId)
}

function json(body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  }
}

export async function previewTeachingAssignment(file: File, workspaceId: string, signal?: AbortSignal) {
  const body = new FormData()
  body.append('file', file)
  return normalizeAssignment(await requestJson<Schema<'AssignmentInput'>>(endpoint('/preview', workspaceId), { method: 'POST', body, signal }))
}

export function analyzeTeachingAssignment(assignment: AssignmentInput, language: 'zh' | 'en', workspaceId: string, signal?: AbortSignal) {
  return requestJson<AnalysisResult>(endpoint(`/analyze?language=${language}`, workspaceId), json(assignment, signal))
}

export async function saveTeachingReport(body: SaveTeachingReport, workspaceId: string, signal?: AbortSignal) {
  return normalizeReport(await requestJson<Schema<'SavedReport'>>(endpoint('/reports', workspaceId), json(body, signal)))
}

export function listTeachingReports(workspaceId: string, signal?: AbortSignal) {
  return requestJson<TeachingReportSummary[]>(endpoint('/reports', workspaceId), { cache: 'no-store', signal })
}

export async function getTeachingReport(reportId: string, workspaceId: string, signal?: AbortSignal) {
  return normalizeReport(await requestJson<Schema<'SavedReport'>>(endpoint(`/reports/${encodeURIComponent(reportId)}`, workspaceId), { cache: 'no-store', signal }))
}

export async function getTeachingReportRevisions(reportId: string, workspaceId: string, signal?: AbortSignal) {
  return (await requestJson<Schema<'SavedReport'>[]>(endpoint(`/reports/${encodeURIComponent(reportId)}/revisions`, workspaceId), { cache: 'no-store', signal })).map(normalizeReport)
}
