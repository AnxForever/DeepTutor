import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StrictMode, useLayoutEffect, type ReactNode } from 'react'
import TaskReviewPage from '@/components/learning/teaching-analysis/TaskReviewPage'
import { initI18n } from '@/i18n/init'
import translations from '@/locales/en/tasks.json'
import { ApiError } from '@/shared/api/errors'
import type { TaskReviewDraft } from '@/lib/task-review-drafts'
import * as api from '@/lib/task-reviews-api'
import * as source from '@/lib/teacher-student-tasks-api'
import { REVIEW_TASK, REVIEW_SUBMISSION, REVIEW_REQUEST, reviewTask, savedTaskReview, taskReviewDraft } from './fixtures/task-reviews'

const current = vi.hoisted(() => ({ workspace: 'class-a', actor: 'teacher-a' as string | null, enabled: true, admin: true, available: true, clear: vi.fn(), restore: null as unknown, autoRestore: false, didAutoRestore: false, registration: null as { slot: string; value: unknown; onRestore: (value: unknown) => void } | null, router: { push: vi.fn() } }))
vi.mock('next/navigation', () => ({ useRouter: () => current.router, usePathname: () => '/learning/teaching-analysis/student-tasks/task/review' }))
vi.mock('next/link', () => ({ default: ({ href, prefetch, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean }) => { void prefetch; return <a href={href} {...props} /> } }))
vi.mock('@/hooks/useAuthStatus', () => ({ useAuthStatus: () => ({ loading: false, enabled: current.enabled, authenticated: true, isAdmin: current.admin, userId: current.actor, statusAvailable: current.available }) }))
vi.mock('@/hooks/useActiveWorkspaceId', () => ({ useActiveWorkspaceId: () => current.workspace }))
vi.mock('@/components/learning/TaskTranslations', () => ({ TaskTranslations: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/components/common/MarkdownRenderer', () => ({ default: ({ content }: { content: string }) => <div>{content}</div> }))
vi.mock('@/components/learning/teaching-analysis/TeachingDrafts', () => {
  function useTaskReviewSlotMock(options: typeof current.registration) {
    useLayoutEffect(() => { current.registration = options; if (current.autoRestore && !current.didAutoRestore && options) { current.didAutoRestore = true; options.onRestore(structuredClone(current.restore)) } }, [options])
    return { clear: current.clear }
  }
  return { TeachingDraftProvider: ({ children }: { children: ReactNode }) => <><button onClick={() => current.registration?.onRestore(structuredClone(current.restore))}>Restore prepared local assessment</button>{children}</>, useTeachingDraftSlot: useTaskReviewSlotMock }
})
vi.mock('@/components/learning/teaching-analysis/TaskReviewCaseLinker', () => ({ TaskReviewCaseLinker: ({ review, disabled, onDirtyChange }: { review: api.SavedTaskReview; disabled: boolean; onDirtyChange?: (value: boolean) => void }) => <section aria-label="Case linker" data-revision={review.revision} data-status={review.status}><button disabled={disabled} onClick={() => onDirtyChange?.(true)}>Select a case for this assessment</button><button onClick={() => onDirtyChange?.(false)}>Clear case link draft</button></section> }))
vi.mock('@/lib/teacher-student-tasks-api', async original => ({ ...(await original<typeof source>()), getTeacherStudentTask: vi.fn() }))
vi.mock('@/lib/task-reviews-api', async original => ({ ...(await original<typeof api>()), getTaskReviewState: vi.fn(), saveTaskReview: vi.fn(), withdrawTaskReview: vi.fn(), listTaskReviewRevisions: vi.fn(), getTaskReviewRevision: vi.fn() }))
const i18n = initI18n('en'); i18n.addResourceBundle('en', 'app', translations, true, true)
const label = (key: string, options?: Record<string, unknown>) => i18n.t(`teacherTaskReviews.${key}`, options)
let task: source.TeacherStudentTask
let head: api.SavedTaskReview | null
let versions: Map<number, api.SavedTaskReview>
const state = (): api.TaskReviewState => ({ task_id: task.task_id, submission_id: task.submission?.submission_id ?? null, task_status: task.status, current_review: structuredClone(head) })
function commit(body: api.SaveTaskReviewRequest): api.SavedTaskReview {
  const old = Array.from(versions.values()).find(value => value.request_id === body.request_id)
  if (old) return structuredClone(old)
  if (body.expected_revision !== (head?.revision ?? 0)) throw new ApiError({ code: 'teaching_task_review_changed', message: 'Changed', status: 409, retryable: false, scope: 'network' })
  head = savedTaskReview(task, { request_id: body.request_id, revision: body.expected_revision + 1, items: structuredClone(body.items), summary: body.summary, change_reason: body.change_reason, recorded_at: 10 + body.expected_revision })
  versions.set(head.revision, structuredClone(head)); return structuredClone(head)
}
beforeEach(() => {
  vi.clearAllMocks(); current.workspace = 'class-a'; current.actor = 'teacher-a'; current.enabled = true; current.admin = true; current.available = true; current.restore = null; current.autoRestore = false; current.didAutoRestore = false; current.registration = null
  current.clear.mockReset().mockResolvedValue(undefined); task = reviewTask(); head = null; versions = new Map()
  for (const method of [source.getTeacherStudentTask, api.getTaskReviewState, api.saveTaskReview, api.withdrawTaskReview, api.listTaskReviewRevisions, api.getTaskReviewRevision]) vi.mocked(method).mockReset()
  vi.mocked(source.getTeacherStudentTask).mockImplementation(async () => structuredClone(task))
  vi.mocked(api.getTaskReviewState).mockImplementation(async () => state())
  vi.mocked(api.saveTaskReview).mockImplementation(async (_id, body) => commit(body))
  vi.mocked(api.withdrawTaskReview).mockImplementation(async (_id, body) => { const old = Array.from(versions.values()).find(value => value.request_id === body.request_id); if (old) return structuredClone(old); if (!head || body.expected_revision !== head.revision) throw new Error('Stale'); head = { ...head, request_id: body.request_id, revision: head.revision + 1, status: 'withdrawn', change_reason: body.reason, recorded_at: 20 }; versions.set(head.revision, structuredClone(head)); return structuredClone(head) })
  vi.mocked(api.listTaskReviewRevisions).mockImplementation(async (_id, query) => Array.from(versions.values()).sort((a, b) => b.revision - a.revision).slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 20)))
  vi.mocked(api.getTaskReviewRevision).mockImplementation(async (_id, revision) => { const value = versions.get(revision); if (!value) throw new ApiError({ code: 'not_found', message: 'Not found', status: 404, retryable: false, scope: 'network' }); return structuredClone(value) })
})
afterEach(async () => { await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)) }) })
async function openPage() { const view = render(<TaskReviewPage taskId={REVIEW_TASK} />); await screen.findByLabelText(`${label('feedback')} · F1`); return view }
function assess(text = 'Compare equal-sized parts.') { fireEvent.change(screen.getByLabelText(`${label('result')} · F1`), { target: { value: 'partial' } }); fireEvent.change(screen.getByLabelText(`${label('feedback')} · F1`), { target: { value: text } }) }
async function saved(revision: number) { await screen.findByText(label('saved', { n: revision })); await waitFor(() => expect(screen.getByRole('button', { name: label('edit') })).toBeEnabled()) }

it('keeps APIs closed for non-admin or an unverified account', () => {
  current.admin = false; const view = render(<TaskReviewPage taskId={REVIEW_TASK} />)
  expect(source.getTeacherStudentTask).not.toHaveBeenCalled(); expect(api.getTaskReviewState).not.toHaveBeenCalled()
  current.admin = true; current.actor = null; view.rerender(<TaskReviewPage taskId={REVIEW_TASK} />)
  expect(source.getTeacherStudentTask).not.toHaveBeenCalled()
})
it('shows auth-disabled history and source readonly without offering writes', async () => {
  current.enabled = false; current.actor = 'local-admin'; head = savedTaskReview(task); versions.set(1, head)
  await openPage(); expect(screen.getByText(label('authRequired'))).toBeVisible()
  expect(screen.getByLabelText(`${label('feedback')} · F1`)).toBeDisabled(); expect(screen.queryByRole('button', { name: label('save') })).toBeNull(); expect(screen.queryByRole('button', { name: label('withdraw') })).toBeNull()
  expect(api.saveTaskReview).not.toHaveBeenCalled(); expect(api.withdrawTaskReview).not.toHaveBeenCalled()
})
it('requires an actual immutable final submission before mounting an editor', async () => {
  task = { ...task, submission: null, status: 'in_progress' }
  render(<TaskReviewPage taskId={REVIEW_TASK} />); await screen.findByText(label('noSubmission'))
  expect(current.registration).toBeNull(); expect(api.saveTaskReview).not.toHaveBeenCalled()
})
it('saves only manual review fields and keeps original answers, help and hints unchanged', async () => {
  const before = structuredClone(task)
  await openPage(); assess(); fireEvent.click(screen.getByRole('button', { name: label('save') })); await saved(1)
  const request = vi.mocked(api.saveTaskReview).mock.calls[0][1]
  expect(Object.keys(request).sort()).toEqual(['change_reason', 'expected_revision', 'items', 'request_id', 'submission_id', 'summary'])
  expect(request).toMatchObject({ expected_revision: 0, submission_id: REVIEW_SUBMISSION, items: [{ question_id: 'F1', result: 'partial', feedback: 'Compare equal-sized parts.' }, { question_id: 'F2', result: 'ungraded', feedback: '' }] })
  expect(task).toEqual(before); expect(screen.getByText(before.submission!.responses[0].answer!)).toBeVisible(); expect(screen.getByRole('region', { name: 'Case linker' })).toHaveAttribute('data-revision', '1')
})
it('rejects grading a missing answer before creating a request', async () => {
  await openPage(); expect(within(screen.getByLabelText(`${label('result')} · F2`)).getByRole('option', { name: i18n.t('teaching.result.incorrect') })).toBeDisabled()
  fireEvent.change(screen.getByLabelText(`${label('result')} · F2`), { target: { value: 'incorrect' } }); fireEvent.click(screen.getByRole('button', { name: label('save') }))
  await screen.findByText(label('validation')); expect(api.saveTaskReview).not.toHaveBeenCalled()
})
it('requires a reason for a correction and records a new version', async () => {
  head = savedTaskReview(task); versions.set(1, head)
  await openPage(); fireEvent.click(screen.getByRole('button', { name: label('edit') })); assess('Updated assessment.'); fireEvent.click(screen.getByRole('button', { name: label('save') }))
  await screen.findByText(label('validation')); expect(api.saveTaskReview).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText(label('changeReason')), { target: { value: 'Rechecked the original work.' } }); fireEvent.click(screen.getByRole('button', { name: label('save') })); await saved(2)
  expect(versions.get(1)!.items[0].feedback).toBe(''); expect(versions.get(2)!.change_reason).toBe('Rechecked the original work.')
})
it('retains a deep-cloned pending request and retries its exact UUID and body', async () => {
  vi.mocked(api.saveTaskReview).mockRejectedValueOnce(new Error('Offline'))
  await openPage(); assess('Keep these words.'); fireEvent.click(screen.getByRole('button', { name: label('save') }))
  await screen.findByText(label('pending')); expect(screen.getByLabelText(`${label('feedback')} · F1`)).toHaveValue('Keep these words.'); expect(screen.getByLabelText(`${label('feedback')} · F1`)).toBeDisabled()
  const original = structuredClone(vi.mocked(api.saveTaskReview).mock.calls[0][1])
  fireEvent.click(screen.getByRole('button', { name: label('retry') })); await saved(1)
  expect(vi.mocked(api.saveTaskReview).mock.calls[1][1]).toEqual(original); expect(versions.size).toBe(1)
})
it('keeps the editor and requires explicit reload after a review CAS conflict', async () => {
  vi.mocked(api.saveTaskReview).mockRejectedValueOnce(new ApiError({ code: 'teaching_task_review_changed', message: 'Changed', status: 409, retryable: false, scope: 'network' }))
  await openPage(); assess('My unsaved review.'); fireEvent.click(screen.getByRole('button', { name: label('save') })); await screen.findByText(label('conflict'))
  fireEvent.click(screen.getAllByRole('button', { name: label('reload') })[0]); const dialog = screen.getByRole('dialog', { name: label('replaceTitle') }); fireEvent.click(within(dialog).getByRole('button', { name: label('keepEditing') }))
  expect(screen.getByLabelText(`${label('feedback')} · F1`)).toHaveValue('My unsaved review.')
})
it('keeps the original acknowledgement separate from a newer current assessment during retry', async () => {
  vi.mocked(api.saveTaskReview).mockImplementationOnce(async (_id, body) => { commit(body); throw new Error('Acknowledgement lost') })
  await openPage(); assess('My version one.'); fireEvent.click(screen.getByRole('button', { name: label('save') })); await screen.findByText(label('pending'))
  head = savedTaskReview(task, { revision: 3, request_id: '77777777-7777-4777-8777-777777777777', items: [{ question_id: 'F1', result: 'correct', feedback: 'A later reviewer changed this.' }, { question_id: 'F2', result: 'ungraded', feedback: '' }], change_reason: 'Later audit', recorded_at: 30 }); versions.set(3, head)
  fireEvent.click(screen.getByRole('button', { name: label('retry') })); await screen.findByText(label('savedNewer', { n: 1 }))
  expect(screen.getByLabelText(`${label('feedback')} · F1`)).toHaveValue('My version one.'); expect(screen.getByRole('button', { name: 'Select a case for this assessment' })).toBeDisabled(); expect(current.clear).not.toHaveBeenCalled(); expect(head.revision).toBe(3)
  fireEvent.click(screen.getByRole('button', { name: label('reload') })); fireEvent.click(within(screen.getByRole('dialog', { name: label('replaceTitle') })).getByRole('button', { name: label('reload') }))
  await waitFor(() => expect(screen.getByLabelText(`${label('feedback')} · F1`)).toHaveValue('A later reviewer changed this.'))
})
it('does not turn failed local cleanup after a confirmed save into another POST', async () => {
  current.clear.mockRejectedValueOnce(new Error('Quota')).mockResolvedValue(undefined)
  await openPage(); assess(); fireEvent.click(screen.getByRole('button', { name: label('save') })); await screen.findByText(label('savedLocalPending'))
  expect(api.saveTaskReview).toHaveBeenCalledOnce(); fireEvent.click(screen.getByRole('button', { name: label('retryCleanup') })); await waitFor(() => expect(current.clear).toHaveBeenCalledTimes(2)); expect(api.saveTaskReview).toHaveBeenCalledOnce()
})
it('verifies a restored late acknowledgement against a fresh head when the initial head was null, including empty legacy labels', async () => {
  task.source_snapshot.subject = ''; task.source_snapshot.knowledge_point = ''
  const draft = taskReviewDraft(task); draft.editor.items[0] = { question_id: 'F1', result: 'partial', feedback: 'Recovered manual review.' }; draft.pending = { kind: 'save', body: { ...structuredClone(draft.editor), request_id: REVIEW_REQUEST, submission_id: REVIEW_SUBMISSION } }; current.restore = draft
  await openPage(); const ack = savedTaskReview(task, { items: structuredClone(draft.editor.items) }); head = ack; versions.set(1, ack)
  fireEvent.click(screen.getByRole('button', { name: 'Restore prepared local assessment' })); await saved(1)
  expect(api.saveTaskReview).not.toHaveBeenCalled(); expect(current.clear).toHaveBeenCalledOnce(); expect(api.getTaskReviewState).toHaveBeenCalledTimes(2)
  expect(vi.mocked(api.getTaskReviewState).mock.invocationCallOrder[1]).toBeGreaterThan(vi.mocked(api.getTaskReviewRevision).mock.invocationCallOrder[0])
})
it('does not consume a layout-hydrated request before the first passive effect, including StrictMode replay', async () => {
  const draft = taskReviewDraft(task); draft.editor.items[0].feedback = 'Hydrated before passive setup.'; draft.pending = { kind: 'save', body: { ...structuredClone(draft.editor), request_id: REVIEW_REQUEST, submission_id: REVIEW_SUBMISSION } }
  current.restore = draft; current.autoRestore = true
  const initialState = state(); const ack = savedTaskReview(task, { items: structuredClone(draft.editor.items) }); head = ack; versions.set(1, ack)
  vi.mocked(api.getTaskReviewState).mockResolvedValueOnce(initialState).mockImplementation(async () => state())
  render(<StrictMode><TaskReviewPage taskId={REVIEW_TASK} /></StrictMode>)
  await screen.findByText(label('saved', { n: 1 })); await waitFor(() => expect(screen.getByRole('button', { name: label('edit') })).toBeEnabled())
  expect(api.saveTaskReview).not.toHaveBeenCalled(); expect(api.getTaskReviewRevision).toHaveBeenCalled(); expect(current.clear).toHaveBeenCalled()
})
it('keeps a restored exact acknowledgement unverified when its fresh current head is missing', async () => {
  const draft = taskReviewDraft(task); draft.pending = { kind: 'save', body: { ...structuredClone(draft.editor), request_id: REVIEW_REQUEST, submission_id: REVIEW_SUBMISSION } }; current.restore = draft
  await openPage(); versions.set(1, savedTaskReview(task)); fireEvent.click(screen.getByRole('button', { name: 'Restore prepared local assessment' }))
  await screen.findByText(label('headUnverified')); expect(screen.getByRole('button', { name: label('edit') })).toBeDisabled(); expect(screen.getByRole('button', { name: 'Select a case for this assessment' })).toBeDisabled(); expect(api.saveTaskReview).not.toHaveBeenCalled()
  head = versions.get(1)!; fireEvent.click(screen.getByRole('button', { name: label('checkLatest') }))
  await waitFor(() => expect(screen.getByRole('button', { name: label('edit') })).toBeEnabled()); expect(api.saveTaskReview).not.toHaveBeenCalled()
})
it('checks a fresh newer head after restoring an old exact acknowledgement instead of promoting its cached initial head', async () => {
  const draft = taskReviewDraft(task); draft.editor.items[0].feedback = 'My old acknowledged assessment.'; draft.pending = { kind: 'save', body: { ...structuredClone(draft.editor), request_id: REVIEW_REQUEST, submission_id: REVIEW_SUBMISSION } }; current.restore = draft
  const ack = savedTaskReview(task, { items: structuredClone(draft.editor.items) }); head = ack; versions.set(1, ack)
  await openPage()
  head = savedTaskReview(task, { revision: 2, request_id: '88888888-8888-4888-8888-888888888888', change_reason: 'Another reviewer corrected this.', items: [{ question_id: 'F1', result: 'partial', feedback: 'Current newer feedback.' }, { question_id: 'F2', result: 'ungraded', feedback: '' }] }); versions.set(2, head)
  fireEvent.click(screen.getByRole('button', { name: 'Restore prepared local assessment' }))
  await screen.findByText(label('savedNewer', { n: 1 }))
  expect(screen.getByLabelText(`${label('feedback')} · F1`)).toHaveValue('My old acknowledged assessment.'); expect(current.clear).not.toHaveBeenCalled(); expect(api.saveTaskReview).not.toHaveBeenCalled(); expect(screen.getByRole('region', { name: 'Case linker' })).toHaveAttribute('data-revision', '2'); expect(screen.getByRole('button', { name: 'Select a case for this assessment' })).toBeDisabled()
})
it('can stop waiting on an ambiguous write, retains its request and ignores a late response until an explicit receipt check', async () => {
  let release!: (value: api.SavedTaskReview) => void
  vi.mocked(api.saveTaskReview).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  await openPage(); assess('Keep this pending manual assessment.'); fireEvent.click(screen.getByRole('button', { name: label('save') })); await waitFor(() => expect(api.saveTaskReview).toHaveBeenCalledOnce())
  const body = structuredClone(vi.mocked(api.saveTaskReview).mock.calls[0][1]); const signal = vi.mocked(api.saveTaskReview).mock.calls[0][3]!
  fireEvent.click(screen.getByRole('button', { name: label('stopRequest') })); expect(signal.aborted).toBe(true); expect(screen.getByRole('button', { name: label('retry') })).toBeEnabled()
  const acknowledgement = commit(body); await act(async () => release(acknowledgement))
  expect(screen.getByText(label('pending'))).toBeVisible(); expect(screen.getByLabelText(`${label('feedback')} · F1`)).toHaveValue('Keep this pending manual assessment.')
  fireEvent.click(screen.getByRole('button', { name: label('checkReceipt') })); await saved(1)
  expect(api.saveTaskReview).toHaveBeenCalledOnce()
})
it('withdraws through a new revision and can later explicitly reassess the same immutable submission', async () => {
  head = savedTaskReview(task); versions.set(1, head)
  await openPage(); fireEvent.click(screen.getByRole('button', { name: label('withdraw') })); const dialog = screen.getByRole('dialog', { name: label('withdrawTitle') })
  fireEvent.change(within(dialog).getByLabelText(label('withdrawReason')), { target: { value: 'The marking guidance was wrong.' } }); fireEvent.click(within(dialog).getByRole('button', { name: label('withdrawConfirm') }))
  await screen.findByText(label('saved', { n: 2 })); await waitFor(() => expect(screen.getByRole('button', { name: label('restore') })).toBeEnabled())
  expect(versions.get(1)!.status).toBe('confirmed'); expect(versions.get(2)!.status).toBe('withdrawn'); expect(task.submission!.responses[0].answer).toBe('1/2 = 3/6, then I got stuck.')
  fireEvent.click(screen.getByRole('button', { name: label('restore') })); fireEvent.change(screen.getByLabelText(label('changeReason')), { target: { value: 'Corrected guidance and rechecked.' } }); fireEvent.click(screen.getByRole('button', { name: label('save') })); await saved(3)
})
it('reads historical assessments without replacing dirty editor content', async () => {
  head = savedTaskReview(task); versions.set(1, head)
  await openPage(); fireEvent.click(screen.getByRole('button', { name: label('edit') })); assess('Still editing the current correction.')
  fireEvent.click(screen.getByText(label('history'), { selector: 'summary' })); await waitFor(() => expect(api.listTaskReviewRevisions).toHaveBeenCalled())
  const historical = screen.getByText(`${label('version', { n: 1 })} · ${label('confirmed')}`, { selector: 'summary' }); fireEvent.click(historical)
  expect(screen.getByLabelText(`${label('feedback')} · F1`)).toHaveValue('Still editing the current correction.'); expect(api.saveTaskReview).not.toHaveBeenCalled()
})
it('ignores an old source request after changing the teacher workspace', async () => {
  let release!: (value: source.TeacherStudentTask) => void
  vi.mocked(source.getTeacherStudentTask).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const view = render(<TaskReviewPage taskId={REVIEW_TASK} />); current.workspace = 'class-b'; view.rerender(<TaskReviewPage taskId={REVIEW_TASK} />)
  await screen.findByLabelText(`${label('feedback')} · F1`); await act(async () => release({ ...task, title: 'Old workspace private title' }))
  expect(screen.queryByText('Old workspace private title')).toBeNull()
})
