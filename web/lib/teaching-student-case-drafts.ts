import type { SavedStudentCase, SaveStudentCaseRequest } from './teaching-student-cases-api'
import { draftObject, draftText, draftUuid, isPlainTeachingJson } from './teaching-draft-validation'

export const studentCaseEditorSlot = (caseId: string) => `student-case:${caseId}:editor`
export const newStudentCaseEditor = (): SaveStudentCaseRequest => ({ case_id: crypto.randomUUID(), expected_revision: 0, label: '', subject: null, archived: false, report_refs: [] })
export const editorForStudentCase = (value: SavedStudentCase): SaveStudentCaseRequest => ({ case_id: value.case_id, expected_revision: value.revision, label: value.label, subject: value.subject, archived: value.archived, report_refs: value.report_refs.map(ref => ({ ...ref })) })
export interface StudentCaseDraft { kind: 'student-case-editor'; version: 1; editor: SaveStudentCaseRequest }
export function isStudentCaseDraft(value: unknown): value is StudentCaseDraft {
  if (!isPlainTeachingJson(value) || !draftObject(value) || value.kind !== 'student-case-editor' || value.version !== 1 || !draftObject(value.editor)) return false
  const editor = value.editor
  return draftUuid(editor.case_id) && Number.isSafeInteger(editor.expected_revision) && Number(editor.expected_revision) >= 0 && draftText(editor.label, 200) &&
    (editor.subject === null || draftText(editor.subject, 200)) && typeof editor.archived === 'boolean' && Array.isArray(editor.report_refs) && editor.report_refs.length <= 20 &&
    editor.report_refs.every(ref => draftObject(ref) && draftUuid(ref.report_id) && Number.isSafeInteger(ref.report_revision) && Number(ref.report_revision) > 0) &&
    new Set(editor.report_refs.map(ref => ref.report_id)).size === editor.report_refs.length
}
