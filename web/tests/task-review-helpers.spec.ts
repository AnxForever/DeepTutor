import { beforeEach, expect, it, vi } from 'vitest'
import { requestJson } from '@/shared/api/client'
import { getTaskReviewState, getTaskReviewRevision, saveTaskReview, withdrawTaskReview, type SaveTaskReviewRequest } from '@/lib/task-reviews-api'
import { draftMatchesTask, isSavedTaskReview, isTaskReviewDraft } from '@/lib/task-review-drafts'
import { REVIEW_TASK, REVIEW_SUBMISSION, REVIEW_REQUEST, reviewTask, savedTaskReview, taskReviewDraft } from './fixtures/task-reviews'

vi.mock('@/shared/api/client', () => ({ requestJson: vi.fn(async () => ({})) }))
beforeEach(() => { vi.clearAllMocks(); window.history.replaceState({}, '', '/learning/teaching-analysis?dt_workspace=other-workspace') })
it('uses the explicit teacher workspace and sends only the manual assessment request', async () => {
  const draft = taskReviewDraft()
  const body: SaveTaskReviewRequest = { ...draft.editor, request_id: REVIEW_REQUEST, submission_id: REVIEW_SUBMISSION }
  await getTaskReviewState(REVIEW_TASK, 'class-a')
  await getTaskReviewRevision(REVIEW_TASK, 1, 'class-a')
  await saveTaskReview(REVIEW_TASK, body, 'class-a')
  await withdrawTaskReview(REVIEW_TASK, { request_id: REVIEW_REQUEST, expected_revision: 1, reason: 'Recheck required.' }, 'class-a')
  const calls = vi.mocked(requestJson).mock.calls
  for (const [url] of calls) expect(new URL(String(url), window.location.origin).searchParams.get('dt_workspace')).toBe('class-a')
  expect(JSON.parse(String(calls[2][1]?.body))).toEqual(body)
  for (const key of ['answer', 'assistance', 'recipient_user_id', 'source_snapshot', 'hint_usage']) expect(String(calls[2][1]?.body)).not.toContain(`"${key}"`)
})
it('accepts empty legacy source labels in saved acknowledgements and restored drafts', () => {
  const task = reviewTask(); task.source_snapshot.subject = ''; task.source_snapshot.knowledge_point = ''
  const saved = savedTaskReview(task)
  const draft = { ...taskReviewDraft(task, saved), editing: false, acknowledged: saved }
  expect(isSavedTaskReview(saved)).toBe(true); expect(isTaskReviewDraft(draft)).toBe(true); expect(draftMatchesTask(draft, task)).toBe(true)
  expect(isSavedTaskReview({ ...saved, reviewer_user_id: '' })).toBe(false)
  expect(isSavedTaskReview({ ...saved, recipient_user_id: '' })).toBe(false)
})
it('rejects forged source bindings, extra request fields and unsupported local draft structures', () => {
  const task = reviewTask(); const draft = taskReviewDraft(task)
  expect(isTaskReviewDraft(draft)).toBe(true)
  expect(draftMatchesTask({ ...draft, submission_id: REVIEW_REQUEST }, task)).toBe(false)
  expect(isTaskReviewDraft({ ...draft, version: 20 })).toBe(false)
  expect(isTaskReviewDraft({ ...draft, audio: new Blob(['no raw data']) })).toBe(false)
  const body = { ...draft.editor, request_id: REVIEW_REQUEST, submission_id: REVIEW_SUBMISSION, answer: 'Do not send or trust this' }
  expect(isTaskReviewDraft({ ...draft, pending: { kind: 'save', body } })).toBe(false)
})
it('preserves exact pending payloads and requires a correction reason before they can be restored', () => {
  const task = reviewTask(); const saved = savedTaskReview(task); const draft = taskReviewDraft(task, saved)
  draft.editor.change_reason = 'Rechecked the reference.'
  draft.pending = { kind: 'save', body: { ...structuredClone(draft.editor), request_id: REVIEW_REQUEST, submission_id: REVIEW_SUBMISSION } }
  expect(isTaskReviewDraft(draft)).toBe(true)
  expect(isTaskReviewDraft({ ...draft, pending: { kind: 'save', body: { ...draft.pending.body, summary: 'Changed after sending' } } })).toBe(false)
  expect(isTaskReviewDraft({ ...draft, editor: { ...draft.editor, change_reason: '' }, pending: { kind: 'save', body: { ...draft.pending.body, change_reason: '' } } })).toBe(false)
})
