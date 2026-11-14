import { createTeachingDraftRepository } from './teaching-drafts'
import { draftObject, draftText, draftUuid, isPlainTeachingJson } from './teaching-draft-validation'
import type { SaveTaskProgressRequest, SubmitTaskRequest, TaskResponse } from './student-tasks-api'
import type { StudentVoiceCandidate } from './student-task-voice-api'

export type StudentTaskOperation = { kind: 'progress'; body: SaveTaskProgressRequest; reviewAfter: boolean } | { kind: 'submit'; body: SubmitTaskRequest }
export interface StudentTaskBuffer {
  kind: 'student-task-buffer'
  version: 1
  taskId: string
  taskRevision: number
  baseRevision: number
  questionIds: string[]
  currentQuestionIndex: number
  responses: TaskResponse[]
  operation: StudentTaskOperation | null
  voiceCandidate?: StudentVoiceCandidate | null
}
/** Each mounted editor owns its CAS observations, including duplicate views. */
export const createStudentTaskBufferRepository = () => createTeachingDraftRepository('deeptutor-student-task-buffers')
const pendingWrites = new Map<string, Set<Promise<void>>>()
const writerKey = (accountId: string, taskId: string) => JSON.stringify([accountId, taskId])
/** Share only in-flight I/O, never a writer's observed CAS revisions. */
export function trackStudentTaskBufferWrite(accountId: string, taskId: string, operation: Promise<void>) {
  const key = writerKey(accountId, taskId)
  const pending = pendingWrites.get(key) ?? new Set<Promise<void>>()
  pending.add(operation); pendingWrites.set(key, pending)
  void operation.finally(() => { pending.delete(operation); if (!pending.size && pendingWrites.get(key) === pending) pendingWrites.delete(key) }).catch(() => {})
  return operation
}
export async function waitForStudentTaskBufferWrites(accountId: string, taskId: string) {
  await Promise.allSettled(Array.from(pendingWrites.get(writerKey(accountId, taskId)) ?? []))
}
const revision = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && Number(value) >= minimum
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key))
export function isTaskResponse(value: unknown): value is TaskResponse {
  if (!draftObject(value) || !keys(value, ['question_id', 'response_status', 'answer', 'assistance']) || !draftText(value.question_id, 128) || !value.question_id.trim() || !['unknown', 'independent', 'assisted'].includes(String(value.assistance))) return false
  const actualAnswer = draftText(value.answer, 6000) && Boolean(value.answer.trim())
  return value.response_status === 'answered' ? actualAnswer : value.response_status === 'needs_help' ? value.answer === null || actualAnswer : value.response_status === 'unanswered' && value.answer === null
}
export function isStudentVoiceCandidate(value: unknown): value is StudentVoiceCandidate {
  return draftObject(value) && keys(value, ['version', 'task_id', 'task_revision', 'question_id', 'request_id', 'basis_progress_revision', 'text', 'requires_confirmation']) && value.version === 1 && draftUuid(value.task_id) && revision(value.task_revision, 1) && draftText(value.question_id, 128) && Boolean(value.question_id.trim()) && draftUuid(value.request_id) && revision(value.basis_progress_revision) && draftText(value.text, 6000) && value.requires_confirmation === true
}
function exactResponses(value: unknown, ids: string[]): value is TaskResponse[] {
  return Array.isArray(value) && value.length === ids.length && value.every((response, index) => isTaskResponse(response) && response.question_id === ids[index])
}
export function isStudentTaskBuffer(value: unknown): value is StudentTaskBuffer {
  if (!isPlainTeachingJson(value) || !draftObject(value) || !keys(value, ['kind', 'version', 'taskId', 'taskRevision', 'baseRevision', 'questionIds', 'currentQuestionIndex', 'responses', 'operation', 'voiceCandidate']) || value.kind !== 'student-task-buffer' || value.version !== 1 || !draftUuid(value.taskId) || !revision(value.taskRevision, 1) || !revision(value.baseRevision) ||
    !Array.isArray(value.questionIds) || value.questionIds.length < 1 || value.questionIds.length > 3 || !value.questionIds.every(id => draftText(id, 128) && Boolean(id.trim())) || new Set(value.questionIds).size !== value.questionIds.length ||
    !revision(value.currentQuestionIndex) || value.currentQuestionIndex >= value.questionIds.length || !exactResponses(value.responses, value.questionIds)) return false
  if (value.voiceCandidate !== undefined && value.voiceCandidate !== null && (!isStudentVoiceCandidate(value.voiceCandidate) || value.voiceCandidate.task_id !== value.taskId || value.voiceCandidate.task_revision !== value.taskRevision || value.voiceCandidate.basis_progress_revision !== value.baseRevision || value.voiceCandidate.question_id !== value.questionIds[value.currentQuestionIndex] || value.operation !== null)) return false
  if (value.operation === null) return true
  if (!draftObject(value.operation) || !keys(value.operation, value.operation.kind === 'progress' ? ['kind', 'body', 'reviewAfter'] : ['kind', 'body']) || !draftObject(value.operation.body)) return false
  const { body } = value.operation
  if (body.expected_revision !== value.baseRevision || !exactResponses(body.responses, value.questionIds) || JSON.stringify(body.responses) !== JSON.stringify(value.responses)) return false
  return value.operation.kind === 'progress' ? keys(body, ['request_id', 'expected_revision', 'current_question_index', 'responses']) && draftUuid(body.request_id) && body.current_question_index === value.currentQuestionIndex && typeof value.operation.reviewAfter === 'boolean' : value.operation.kind === 'submit' && keys(body, ['submission_id', 'expected_revision', 'responses']) && draftUuid(body.submission_id)
}

export function downloadStudentTaskBuffer(value: unknown, taskId: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = `my-task-${taskId.slice(0, 8)}-backup.json`; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
