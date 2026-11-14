import { requestJson } from '@/shared/api/client'
import { scopedUrl } from './workspace-scope'
import type { components } from '@/contracts/generated/api'

type Complete<T> = T extends readonly (infer Item)[] ? Complete<Item>[] : T extends object ? { -readonly [Key in keyof T]-?: Complete<T[Key]> } : T
export type TaskReviewItem = Complete<components['schemas']['TaskReviewItem']>
export type TaskReviewResult = TaskReviewItem['result']
export type SaveTaskReviewRequest = Complete<components['schemas']['SaveTaskReviewRequest']>
export type TaskReviewEditor = Pick<SaveTaskReviewRequest, 'expected_revision' | 'items' | 'summary' | 'change_reason'>
export type WithdrawTaskReviewRequest = Complete<components['schemas']['WithdrawTaskReviewRequest']>
export type SavedTaskReview = Complete<components['schemas']['SavedTaskReview']>
export type TaskReviewState = Complete<components['schemas']['TaskReviewState']>
const root = (taskId: string, workspaceId: string, suffix = '') => scopedUrl(`/api/teaching-analysis/student-tasks/${encodeURIComponent(taskId)}/review${suffix}`, workspaceId)
const json = (body: unknown, signal?: AbortSignal): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
export function taskReviewRoute(taskId: string, workspaceId: string) { return scopedUrl(`/learning/teaching-analysis/student-tasks/${encodeURIComponent(taskId)}/review`, workspaceId) }
export function getTaskReviewState(taskId: string, workspaceId: string, signal?: AbortSignal) { return requestJson<TaskReviewState>(root(taskId, workspaceId), { cache: 'no-store', signal }) }
export function saveTaskReview(taskId: string, body: SaveTaskReviewRequest, workspaceId: string, signal?: AbortSignal) { return requestJson<SavedTaskReview>(root(taskId, workspaceId), json(body, signal)) }
export function withdrawTaskReview(taskId: string, body: WithdrawTaskReviewRequest, workspaceId: string, signal?: AbortSignal) { return requestJson<SavedTaskReview>(root(taskId, workspaceId, '/withdraw'), json(body, signal)) }
export function listTaskReviewRevisions(taskId: string, query: { limit?: number; offset?: number }, workspaceId: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: String(query.limit ?? 20), offset: String(query.offset ?? 0) })
  return requestJson<SavedTaskReview[]>(root(taskId, workspaceId, `/revisions?${params}`), { cache: 'no-store', signal })
}
export function getTaskReviewRevision(taskId: string, revision: number, workspaceId: string, signal?: AbortSignal) { return requestJson<SavedTaskReview>(root(taskId, workspaceId, `/revisions/${revision}`), { cache: 'no-store', signal }) }
