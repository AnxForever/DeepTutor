import { requestJson } from '@/shared/api/client'
import { scopedUrl } from './workspace-scope'
import type { components } from '@/contracts/generated/api'

type Complete<T> = T extends readonly (infer Item)[] ? Complete<Item>[] : T extends object ? { -readonly [Key in keyof T]-?: Complete<T[Key]> } : T
export type StudentTaskHintsState = Complete<components['schemas']['TaskHintsState']>
export type RevealStudentHintRequest = Complete<components['schemas']['RevealTaskHintRequest']>
export type StudentQuestionHints = StudentTaskHintsState['questions'][number]
export type RevealedStudentHint = StudentQuestionHints['revealed'][number]

const endpoint = (taskId: string, suffix = '') => scopedUrl(`/api/student-tasks/${encodeURIComponent(taskId)}/hints${suffix}`, '')
export function getStudentTaskHints(taskId: string, signal?: AbortSignal) { return requestJson<StudentTaskHintsState>(endpoint(taskId), { cache: 'no-store', signal }) }
export function revealStudentTaskHint(taskId: string, body: RevealStudentHintRequest, signal?: AbortSignal) { return requestJson<StudentTaskHintsState>(endpoint(taskId, '/reveal'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }) }

/** Reject mismatched or non-prefix responses before showing any hint text. */
export function validStudentTaskHints(value: unknown, taskId: string, questionIds: string[]): value is StudentTaskHintsState {
  if (!value || typeof value !== 'object') return false
  const state = value as StudentTaskHintsState
  if (state.task_id !== taskId || !Number.isSafeInteger(state.hint_revision) || state.hint_revision < 0 || state.hint_revision > 9 || !Array.isArray(state.questions) || state.questions.length !== questionIds.length) return false
  const found = new Set<string>()
  return state.questions.every(question => {
    if (!question || !questionIds.includes(question.question_id) || found.has(question.question_id) || !Number.isSafeInteger(question.total) || question.total < 0 || question.total > 3 || !Array.isArray(question.revealed) || question.revealed.length > question.total) return false
    found.add(question.question_id)
    return question.revealed.every((hint, index) => Boolean(hint && hint.level === index + 1 && typeof hint.text === 'string' && hint.text.trim() && Array.from(hint.text).length <= 600 && typeof hint.revealed_at === 'number' && Number.isFinite(hint.revealed_at) && hint.revealed_at >= 0))
  })
}
