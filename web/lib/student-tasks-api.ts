import { requestJson } from '@/shared/api/client'
import { scopedUrl } from '@/lib/workspace-scope'
import type { components } from '@/contracts/generated/api'

export const STUDENT_TASKS_HOME = '/learning/tasks'
const ROOT = '/api/student-tasks'

type Complete<T> = T extends readonly (infer Item)[] ? Complete<Item>[] : T extends object ? { -readonly [Key in keyof T]-?: Complete<T[Key]> } : T
// Response models materialize their defaults; editors keep complete mutable data.
export type TaskResponse = Complete<components['schemas']['TaskResponse']>
export type StudentTaskSummary = Complete<components['schemas']['StudentTaskSummary']>
type CompleteSubmission = Complete<components['schemas']['StudentSubmission']>
export type StudentTaskSubmission = Omit<CompleteSubmission, 'hint_usage'> & { hint_usage?: CompleteSubmission['hint_usage'] }
export type StudentTaskView = Omit<Complete<components['schemas']['StudentTaskView']>, 'submission'> & { submission: StudentTaskSubmission | null }
export type StudentTaskStatus = StudentTaskSummary['status']
export type SaveTaskProgressRequest = Complete<components['schemas']['SaveTaskProgressRequest']>
export type SubmitTaskRequest = Complete<components['schemas']['SubmitTaskRequest']>

/** A learner inbox is account-wide. Never inherit a teacher/content workspace. */
export function studentTasksRoute(taskId?: string): string {
  return scopedUrl(taskId ? `${STUDENT_TASKS_HOME}/${encodeURIComponent(taskId)}` : STUDENT_TASKS_HOME, '')
}
const endpoint = (taskId?: string, suffix = '') => scopedUrl(taskId ? `${ROOT}/${encodeURIComponent(taskId)}${suffix}` : ROOT, '')
export function listStudentTasks(query: { state: 'active' | 'history'; limit?: number; offset?: number }, signal?: AbortSignal) {
  const params = new URLSearchParams({ state: query.state, limit: String(query.limit ?? 30), offset: String(query.offset ?? 0) })
  return requestJson<StudentTaskSummary[]>(`${endpoint()}&${params}`, { cache: 'no-store', signal })
}
export function getStudentTask(taskId: string, signal?: AbortSignal) {
  return requestJson<StudentTaskView>(endpoint(taskId), { cache: 'no-store', signal })
}
export function saveStudentTaskProgress(taskId: string, body: SaveTaskProgressRequest, signal?: AbortSignal) {
  return requestJson<StudentTaskView>(endpoint(taskId, '/progress'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
}
export function submitStudentTask(taskId: string, body: SubmitTaskRequest, signal?: AbortSignal) {
  return requestJson<StudentTaskView>(endpoint(taskId, '/submit'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
}
