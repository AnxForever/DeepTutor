import { draftObject, draftText, draftUuid, isPlainTeachingJson } from './teaching-draft-validation'
import type { TeacherStudentTask } from './teacher-student-tasks-api'
import type { SavedTaskReview, SaveTaskReviewRequest, TaskReviewEditor, TaskReviewItem, WithdrawTaskReviewRequest } from './task-reviews-api'

export type PendingTaskReview = { kind: 'save'; body: SaveTaskReviewRequest } | { kind: 'withdraw'; body: WithdrawTaskReviewRequest }
export interface TaskReviewDraft {
  kind: 'task-review-editor'; version: 1; task_id: string; submission_id: string
  editor: TaskReviewEditor; editing: boolean; withdraw_reason: string; withdrawing: boolean
  pending: PendingTaskReview | null; acknowledged: SavedTaskReview | null
}
export const taskReviewSlot = (taskId: string, submissionId: string) => `task-review:${taskId}:${submissionId}`
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key))
const revision = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && Number(value) >= minimum
export const reviewText = (value: unknown, max: number): value is string => draftText(value, max) && Array.from(value).every(character => character.length === 2 || character.charCodeAt(0) < 0xd800 || character.charCodeAt(0) > 0xdfff)
const item = (value: unknown): value is TaskReviewItem => draftObject(value) && keys(value, ['question_id', 'result', 'feedback']) && reviewText(value.question_id, 128) && Boolean(value.question_id.trim()) && ['correct', 'partial', 'incorrect', 'ungraded'].includes(String(value.result)) && reviewText(value.feedback, 2000)
const items = (value: unknown): value is TaskReviewItem[] => Array.isArray(value) && value.length >= 1 && value.length <= 3 && value.every(item) && new Set(value.map(entry => entry.question_id)).size === value.length
export function isSavedTaskReview(value: unknown): value is SavedTaskReview {
  return draftObject(value) && keys(value, ['task_id', 'submission_id', 'request_id', 'revision', 'status', 'items', 'summary', 'change_reason', 'recipient_user_id', 'report_id', 'report_revision', 'followup_id', 'followup_revision', 'subject', 'knowledge_point', 'submission_receipt_hash', 'reviewer_user_id', 'recorded_at']) &&
    ['task_id', 'submission_id', 'request_id', 'report_id', 'followup_id'].every(key => draftUuid(value[key])) && revision(value.revision, 1) && revision(value.report_revision, 1) && revision(value.followup_revision, 1) && ['confirmed', 'withdrawn'].includes(String(value.status)) && items(value.items) && reviewText(value.summary, 3000) && reviewText(value.change_reason, 2000) &&
    ['recipient_user_id', 'reviewer_user_id'].every(key => reviewText(value[key], 64) && Boolean(String(value[key]).trim())) && ['subject', 'knowledge_point'].every(key => reviewText(value[key], 200)) && typeof value.submission_receipt_hash === 'string' && /^[a-f0-9]{64}$/.test(value.submission_receipt_hash) && typeof value.recorded_at === 'number' && Number.isFinite(value.recorded_at) && value.recorded_at >= 0 && (Number(value.revision) === 1 && value.status === 'confirmed' || Boolean(value.change_reason.trim()))
}
export function reviewMatchesTask(review: SavedTaskReview, task: TeacherStudentTask): boolean {
  if (!task.submission || review.task_id !== task.task_id || review.submission_id !== task.submission.submission_id || review.recipient_user_id !== task.recipient_user_id || review.report_id !== task.source_snapshot.report_id || review.report_revision !== task.source_snapshot.report_revision || review.followup_id !== task.followup_id || review.followup_revision !== task.followup_revision || review.subject !== task.source_snapshot.subject || review.knowledge_point !== task.source_snapshot.knowledge_point) return false
  const ids = task.source_snapshot.questions.map(question => question.question_id)
  return review.items.length === ids.length && review.items.every(entry => ids.includes(entry.question_id) && (entry.result === 'ungraded' || Boolean(task.submission!.responses.find(response => response.question_id === entry.question_id)?.answer?.trim())))
}
export function editorForTaskReview(task: TeacherStudentTask, review: SavedTaskReview | null): TaskReviewEditor {
  return { expected_revision: review?.revision ?? 0, items: task.source_snapshot.questions.map(question => { const previous = review?.items.find(entry => entry.question_id === question.question_id); return { question_id: question.question_id, result: previous?.result ?? 'ungraded', feedback: previous?.feedback ?? '' } }), summary: review?.summary ?? '', change_reason: '' }
}
export function sameReviewContent(left: Pick<TaskReviewEditor, 'items' | 'summary' | 'change_reason'>, right: Pick<TaskReviewEditor, 'items' | 'summary' | 'change_reason'>): boolean {
  return left.summary === right.summary && left.change_reason === right.change_reason && left.items.length === right.items.length && left.items.every((entry, index) => entry.question_id === right.items[index].question_id && entry.result === right.items[index].result && entry.feedback === right.items[index].feedback)
}
export function isTaskReviewDraft(value: unknown): value is TaskReviewDraft {
  if (!isPlainTeachingJson(value) || !draftObject(value) || !keys(value, ['kind', 'version', 'task_id', 'submission_id', 'editor', 'editing', 'withdraw_reason', 'withdrawing', 'pending', 'acknowledged']) || value.kind !== 'task-review-editor' || value.version !== 1 || !draftUuid(value.task_id) || !draftUuid(value.submission_id) || !draftObject(value.editor) || !keys(value.editor, ['expected_revision', 'items', 'summary', 'change_reason']) || !revision(value.editor.expected_revision) || !items(value.editor.items) || !reviewText(value.editor.summary, 3000) || !reviewText(value.editor.change_reason, 2000) || typeof value.editing !== 'boolean' || typeof value.withdrawing !== 'boolean' || !reviewText(value.withdraw_reason, 2000)) return false
  if (value.acknowledged !== null && (!isSavedTaskReview(value.acknowledged) || value.acknowledged.task_id !== value.task_id || value.acknowledged.submission_id !== value.submission_id)) return false
  if (value.pending === null) return true
  if (!draftObject(value.pending) || !keys(value.pending, ['kind', 'body']) || !draftObject(value.pending.body)) return false
  const body = value.pending.body
  if (!draftUuid(body.request_id) || body.expected_revision !== value.editor.expected_revision) return false
  if (value.pending.kind === 'withdraw') return keys(body, ['request_id', 'expected_revision', 'reason']) && revision(body.expected_revision, 1) && reviewText(body.reason, 2000) && Boolean(body.reason.trim()) && body.reason === value.withdraw_reason
  return value.pending.kind === 'save' && keys(body, ['request_id', 'submission_id', 'expected_revision', 'items', 'summary', 'change_reason']) && body.submission_id === value.submission_id && items(body.items) && reviewText(body.summary, 3000) && reviewText(body.change_reason, 2000) && (body.expected_revision === 0 || Boolean(body.change_reason.trim())) && sameReviewContent(body as unknown as SaveTaskReviewRequest, value.editor as unknown as TaskReviewEditor)
}
export function draftMatchesTask(value: TaskReviewDraft, task: TeacherStudentTask): boolean {
  const ids = task.source_snapshot.questions.map(question => question.question_id)
  return value.task_id === task.task_id && value.submission_id === task.submission?.submission_id && value.editor.items.length === ids.length && value.editor.items.every(entry => ids.includes(entry.question_id) && (entry.result === 'ungraded' || Boolean(task.submission!.responses.find(response => response.question_id === entry.question_id)?.answer?.trim()))) && (!value.acknowledged || reviewMatchesTask(value.acknowledged, task))
}
export const cloneReviewDraft = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
