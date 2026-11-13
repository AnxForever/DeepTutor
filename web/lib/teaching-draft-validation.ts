import type { AssignmentInput, ReportContent, SavedTeachingReport } from './teaching-analysis-api'

export interface PrimaryTeachingDraft {
  kind: 'teaching-primary'
  version: 1
  assignment: AssignmentInput
  analysis: ReportContent | null
  fingerprint: string
  reportId: string
  saved: SavedTeachingReport | null
  baseRevision: number
  teacherNotes: string
  pasted: string
  editing: boolean
  primaryDirty?: boolean
}
export const draftObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
export function isPlainTeachingJson(value: unknown, depth = 0, seen = new WeakSet<object>()): boolean {
  if (depth > 32) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object' || seen.has(value)) return false
  if (!Array.isArray(value) && !draftObject(value)) return false
  if (Array.isArray(value) && Object.keys(value).length !== value.length) return false
  seen.add(value)
  const valid = Object.values(value).every(item => isPlainTeachingJson(item, depth + 1, seen))
  seen.delete(value)
  return valid
}
export const draftText = (value: unknown, limit = 100000): value is string => typeof value === 'string' && Array.from(value).length <= limit
const nullableText = (value: unknown, limit: number) => value === null || draftText(value, limit)
const choice = (value: unknown, choices: string[]) => typeof value === 'string' && choices.includes(value)
const list = (value: unknown, limit: number, validate: (item: unknown) => boolean) => Array.isArray(value) && value.length <= limit && value.every(validate)
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
export const draftUuid = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
const revision = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
const rubric = (value: unknown) => draftObject(value) && draftUuid(value.template_id) && revision(value.revision) && draftText(value.name, 200) && draftText(value.subject, 200) && draftText(value.grade, 200) && draftText(value.criteria, 6000)
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export function isDraftDocumentProvenance(value: unknown): boolean {
  return value === undefined || value === null || (draftObject(value) && draftText(value.filename, 255) && hash(value.source_hash) && draftText(value.parser_version, 120) && hash(value.signature) &&
    list(value.fields, 200, field => draftObject(field) && draftText(field.question_id, 128) && choice(field.field, ['question', 'student_answer', 'student_work', 'reference_answer', 'rubric']) &&
      list(field.citations, 6, citation => draftObject(citation) && draftText(citation.block_id, 128) && draftText(citation.locator, 500) && draftText(citation.quote, 8000))))
}
export function isDraftAssignment(value: unknown): value is AssignmentInput {
  return draftObject(value) && ['student_ref', 'assignment_ref', 'subject', 'grade'].every(key => draftText(value[key], 200)) && draftText(value.teacher_context, 6000) &&
    (value.rubric_template === null || rubric(value.rubric_template)) && isDraftDocumentProvenance(value.document_provenance) && list(value.items, 40, item => draftObject(item) &&
      draftText(item.question_id, 128) && draftText(item.question, 6000) && nullableText(item.student_answer, 6000) && nullableText(item.student_work, 8000) &&
      nullableText(item.reference_answer, 6000) && nullableText(item.rubric, 4000) && draftText(item.source_locator, 500) && list(item.knowledge_points, 20, x => draftText(x, 200)) &&
      choice(item.answer_status, ['present', 'confirmed_blank', 'unknown']) && choice(item.transcription_status, ['confirmed', 'uncertain', 'not_applicable']) && choice(item.assistance, ['independent', 'assisted', 'unknown']))
}
const evidence = (value: unknown) => list(value, 10, item => draftObject(item) && draftText(item.question_id, 128) && choice(item.field, ['student_answer', 'student_work']) && draftText(item.quote, 2000))
export function isDraftReport(value: unknown): value is ReportContent {
  return draftObject(value) && draftText(value.summary, 5000) && list(value.items, 40, item => draftObject(item) && draftText(item.question_id, 128) && choice(item.result, ['correct', 'partial', 'incorrect', 'ungraded']) && draftText(item.observation, 3000) && evidence(item.evidence)) &&
    list(value.priorities, 12, item => draftObject(item) && ['knowledge_point', 'observation', 'hypothesis', 'alternative_explanation', 'teaching_action', 'follow_up_question', 'reference_guidance'].every(key => draftText(item[key], 3000)) && choice(item.evidence_status, ['supported', 'needs_check']) && evidence(item.evidence)) && list(value.limitations, 20, x => draftText(x, 1000))
}
const savedReport = (value: unknown) => draftObject(value) && draftUuid(value.report_id) && revision(value.revision) && isDraftAssignment(value.assignment) && isDraftReport(value.analysis) && draftText(value.source_fingerprint, 64) && choice(value.status, ['draft', 'confirmed']) && draftText(value.teacher_notes, 6000) && finite(value.created_at) && finite(value.updated_at)
export function isPrimaryTeachingDraft(value: unknown): value is PrimaryTeachingDraft {
  return isPlainTeachingJson(value) && draftObject(value) && value.kind === 'teaching-primary' && value.version === 1 && isDraftAssignment(value.assignment) && (value.analysis === null || isDraftReport(value.analysis)) &&
    draftText(value.fingerprint, 64) && (value.fingerprint === '' || /^[a-f0-9]{64}$/.test(value.fingerprint)) && draftUuid(value.reportId) && (value.saved === null || savedReport(value.saved)) &&
    revision(value.baseRevision) && value.baseRevision === (value.saved === null ? 0 : (value.saved as SavedTeachingReport).revision) && draftText(value.teacherNotes, 6000) && draftText(value.pasted, 1048576) && typeof value.editing === 'boolean' && (value.primaryDirty === undefined || typeof value.primaryDirty === 'boolean')
}
