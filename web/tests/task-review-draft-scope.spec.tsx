import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { useState, type ReactNode } from 'react'
import TaskReviewPage from '@/components/learning/teaching-analysis/TaskReviewPage'
import { TeachingDraftProvider, acceptsWorkbenchDraftSlot, useTeachingDraftSlot } from '@/components/learning/teaching-analysis/TeachingDrafts'
import { createTeachingDraftRepository, type TeachingDraftRepository } from '@/lib/teaching-drafts'
import { taskReviewSlot, type TaskReviewDraft } from '@/lib/task-review-drafts'
import { initI18n } from '@/i18n/init'
import translations from '@/locales/en/tasks.json'
import * as api from '@/lib/task-reviews-api'
import * as source from '@/lib/teacher-student-tasks-api'
import { REVIEW_TASK, REVIEW_SUBMISSION, reviewTask, taskReviewDraft } from './fixtures/task-reviews'

const current = vi.hoisted(() => ({ actor: 'teacher-a', workspace: 'class-a', router: { push: vi.fn() } }))
vi.mock('next/navigation', () => ({ useRouter: () => current.router, usePathname: () => '/learning/teaching-analysis/student-tasks/task/review' }))
vi.mock('next/link', () => ({ default: ({ href, prefetch, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean }) => { void prefetch; return <a href={href} {...props} /> } }))
vi.mock('@/hooks/useAuthStatus', () => ({ useAuthStatus: () => ({ loading: false, enabled: true, authenticated: true, isAdmin: true, userId: current.actor, statusAvailable: true }) }))
vi.mock('@/hooks/useActiveWorkspaceId', () => ({ useActiveWorkspaceId: () => current.workspace }))
vi.mock('@/components/learning/TaskTranslations', () => ({ TaskTranslations: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/components/common/MarkdownRenderer', () => ({ default: ({ content }: { content: string }) => <div>{content}</div> }))
vi.mock('@/components/learning/teaching-analysis/TaskReviewCaseLinker', () => ({ TaskReviewCaseLinker: () => null }))
vi.mock('@/lib/teacher-student-tasks-api', async original => ({ ...(await original<typeof source>()), getTeacherStudentTask: vi.fn() }))
vi.mock('@/lib/task-reviews-api', async original => ({ ...(await original<typeof api>()), getTaskReviewState: vi.fn(), getTaskReviewRevision: vi.fn(), saveTaskReview: vi.fn(), listTaskReviewRevisions: vi.fn() }))
const i18n = initI18n('en'); i18n.addResourceBundle('en', 'app', translations, true, true)
const label = (key: string) => i18n.t(`teacherTaskReviews.${key}`)
const scope = { accountId: 'teacher-a', workspaceId: 'class-a' }
const slot = taskReviewSlot(REVIEW_TASK, REVIEW_SUBMISSION)
let repository: TeachingDraftRepository
beforeEach(() => {
  vi.clearAllMocks(); current.actor = scope.accountId; current.workspace = scope.workspaceId
  vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange); repository = createTeachingDraftRepository()
  const task = reviewTask()
  vi.mocked(source.getTeacherStudentTask).mockImplementation(async id => ({ ...structuredClone(task), task_id: id, submission: task.submission ? { ...structuredClone(task.submission), task_id: id } : null }))
  vi.mocked(api.getTaskReviewState).mockImplementation(async id => ({ task_id: id, submission_id: REVIEW_SUBMISSION, task_status: 'submitted', current_review: null }))
  vi.mocked(api.getTaskReviewRevision).mockRejectedValue(new Error('No saved receipt'))
  vi.mocked(api.listTaskReviewRevisions).mockResolvedValue([])
})
afterEach(async () => { cleanup(); await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)) }); vi.unstubAllGlobals() })
async function feedbackReady() { await waitFor(() => { expect(screen.getByLabelText(`${label('feedback')} · F1`)).toBeEnabled(); expect(document.querySelector('[inert]')).toBeNull() }) }
function WorkbenchEditor() {
  const [text, setText] = useState('')
  useTeachingDraftSlot({ slot: 'primary', value: { text }, dirty: Boolean(text), validate: (value): value is { text: string } => Boolean(value && typeof value === 'object' && typeof (value as { text: unknown }).text === 'string'), onRestore: value => setText(value.text) })
  return <input aria-label="Workbench text" value={text} onChange={event => setText(event.target.value)} />
}
it('keeps review drafts out of the workbench namespace and offers explicit restoration on the review route', async () => {
  const draft = taskReviewDraft(); draft.editor.items[0].feedback = 'Private pending assessment.'
  await repository.write(scope, slot, draft)
  expect(acceptsWorkbenchDraftSlot(slot)).toBe(false)
  const view = render(<TeachingDraftProvider {...scope} repository={repository}><WorkbenchEditor /></TeachingDraftProvider>)
  await waitFor(() => expect(document.querySelector('[inert]')).toBeNull())
  expect(screen.queryByText('A local teaching draft is available')).toBeNull(); expect(screen.getByLabelText('Workbench text')).toHaveValue('')
  view.unmount(); render(<TaskReviewPage taskId={REVIEW_TASK} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Restore local draft' }))
  await waitFor(() => expect(screen.getByLabelText(`${label('feedback')} · F1`)).toHaveValue('Private pending assessment.'))
  expect(api.saveTaskReview).not.toHaveBeenCalled()
})
it('flushes current review text to the source account and workspace before ordinary settings or workbench navigation', async () => {
  const view = render(<TaskReviewPage taskId={REVIEW_TASK} />); await feedbackReady()
  fireEvent.change(screen.getByLabelText(`${label('feedback')} · F1`), { target: { value: 'My latest review draft.' } })
  fireEvent.click(screen.getByRole('link', { name: label('back') }))
  await waitFor(() => expect(current.router.push).toHaveBeenCalledWith('/learning/teaching-analysis?dt_workspace=class-a'))
  const saved = (await repository.read(scope)).find(record => record.slot === slot)!
  expect((saved.value as TaskReviewDraft).editor.items[0].feedback).toBe('My latest review draft.')
  view.unmount(); render(<TaskReviewPage taskId={REVIEW_TASK} />); fireEvent.click(await screen.findByRole('button', { name: 'Restore local draft' }))
  await waitFor(() => expect(screen.getByLabelText(`${label('feedback')} · F1`)).toHaveValue('My latest review draft.'))
  expect(api.saveTaskReview).not.toHaveBeenCalled()
})
it('does not offer another task, account or workspace draft and discards only the selected task family', async () => {
  const otherTask = '99999999-9999-4999-8999-999999999999'
  const draft = taskReviewDraft(); draft.editor.items[0].feedback = 'Task A draft'
  const other = { ...structuredClone(draft), task_id: otherTask }; const otherSlot = taskReviewSlot(otherTask, REVIEW_SUBMISSION)
  await repository.write(scope, slot, draft); await repository.write(scope, otherSlot, other)
  current.actor = 'teacher-b'; const view = render(<TaskReviewPage taskId={REVIEW_TASK} />); await feedbackReady(); expect(screen.queryByText('A local teaching draft is available')).toBeNull()
  view.unmount(); current.actor = scope.accountId; current.workspace = 'class-b'; const second = render(<TaskReviewPage taskId={REVIEW_TASK} />); await feedbackReady(); expect(screen.queryByText('A local teaching draft is available')).toBeNull()
  second.unmount(); current.workspace = scope.workspaceId; render(<TaskReviewPage taskId={REVIEW_TASK} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Discard local draft' }))
  await waitFor(async () => expect((await repository.read(scope)).map(record => record.slot)).toEqual([otherSlot]))
})
