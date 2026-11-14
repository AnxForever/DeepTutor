import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode, type ReactNode } from 'react'
import i18n from 'i18next'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TeacherStudentTasks } from '@/components/learning/teaching-analysis/TeacherStudentTasks'
import { PracticeFollowups } from '@/components/learning/teaching-analysis/PracticeFollowups'
import { TeachingDraftProvider } from '@/components/learning/teaching-analysis/TeachingDrafts'
import { exampleAssignment } from '@/components/learning/teaching-analysis/sample'
import { initI18n } from '@/i18n/init'
import { ApiError } from '@/shared/api/errors'
import type { SavedTeachingReport } from '@/lib/teaching-analysis-api'
import type { TeachingDraftRecord, TeachingDraftRepository, TeachingDraftScope } from '@/lib/teaching-drafts'
import * as reports from '@/lib/teaching-analysis-api'
import * as followups from '@/lib/teaching-followups-api'
import * as api from '@/lib/teacher-student-tasks-api'
import taskEnglish from '@/locales/en/tasks.json'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/learning/TaskTranslations', () => ({ TaskTranslations: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/lib/teaching-analysis-api', async original => ({ ...(await original<typeof reports>()), getTeachingReport: vi.fn() }))
vi.mock('@/lib/teaching-followups-api', async original => ({
  ...(await original<typeof followups>()), getTeachingFollowup: vi.fn(), listTeachingFollowups: vi.fn(), listTeachingFollowupAttempts: vi.fn(),
}))
vi.mock('@/lib/teacher-student-tasks-api', async original => ({
  ...(await original<typeof api>()), getStudentTaskRecipients: vi.fn(), listTeacherStudentTasks: vi.fn(), issueStudentTask: vi.fn(), getTeacherStudentTask: vi.fn(), revokeStudentTask: vi.fn(),
}))
initI18n('en')
i18n.addResources('en', 'app', taskEnglish)
const scope = { accountId: 'adult-one', workspaceId: 'class-a' }
const reportId = 'efc43d95-2054-412d-814f-54c548b7a777'
const followupId = '4bdc326c-2c22-4407-a4c7-1627ce191e4c'
const taskId = '31755899-a857-4605-b0fb-c51e62410fbd'
const learnerId = 'learner-real-uid'
const savedReport = (change: Partial<SavedTeachingReport> = {}): SavedTeachingReport => ({
  report_id: reportId, revision: 1, status: 'confirmed', assignment: { ...exampleAssignment('en'), student_ref: 'PRIVATE_REPORT_LABEL', assignment_ref: 'PRIVATE_ASSIGNMENT_LABEL' }, analysis: { summary: 'PRIVATE_DIAGNOSIS', items: [], priorities: [{ knowledge_point: 'PRIVATE_DIAGNOSIS', observation: 'Check units.', hypothesis: 'Check units.', alternative_explanation: 'Check the method.', teaching_action: 'Compare units.', follow_up_question: 'Explain the units.', reference_guidance: 'Check equal units.', evidence_status: 'needs_check', evidence: [] }], limitations: [] },
  source_fingerprint: 'a'.repeat(64), teacher_notes: '', created_at: 1, updated_at: 2, ...change,
})
const source = (change: Partial<followups.SavedFollowup> = {}): followups.SavedFollowup => ({
  followup_id: followupId, revision: 1, report_id: reportId, report_revision: 1, priority_index: 0, title: 'PRIVATE_FOLLOWUP_TITLE',
  questions: [{ question_id: 'F1', question: 'Explain the units in 1/4 + 1/6.', reference_answer: 'PRIVATE_REFERENCE_5/12', rubric: 'PRIVATE_MARKING_CRITERIA' }],
  student_ref: 'PRIVATE_REPORT_LABEL', assignment_ref: 'PRIVATE_ASSIGNMENT_LABEL', subject: 'Mathematics', grade: 'Grade 5', knowledge_point: 'PRIVATE_DIAGNOSIS', source_fingerprint: 'a'.repeat(64), created_at: 10, updated_at: 10, ...change,
})
const setup = (): api.StudentTaskSetup => ({ enabled: true, reason: null, recipients: [
  { user_id: learnerId, username: 'Alice', can_receive: true, reason: null },
  { user_id: 'disabled-uid', username: 'Blocked account', can_receive: false, reason: 'Task access is disabled.' },
] })
function task(change: Partial<api.TeacherStudentTask> = {}): api.TeacherStudentTask {
  return {
    task_id: taskId, task_revision: 1, title: 'A little practice', recipient_user_id: learnerId, followup_id: followupId, followup_revision: 1, status: 'pending', issued_at: 100, updated_at: 100, submitted_at: null,
    progress: { revision: 0, current_question_index: 0, saved_at: null }, instructions: 'Show your reasoning.', source_snapshot: source(), submission: null,
    started_at: null, revoked_at: null, revoke_reason: null, issued_by_user_id: 'adult-one', ...change,
  }
}
function publishing(change: Partial<api.StudentTaskPublishDraft> = {}): api.StudentTaskPublishDraft {
  const payload: api.IssueStudentTaskRequest = { task_id: taskId, followup_id: followupId, followup_revision: 1, recipient_user_id: learnerId, title: 'Check equal units', instructions: 'Try explaining it independently.' }
  return { kind: 'student-task-publish', version: 1, source: source(), payload, reviewed: true, submitted_payload: payload, acknowledged_task_id: null, revoke: null, ...change }
}
const slot = api.studentTaskPublishSlot(followupId)
const row = (value: unknown): TeachingDraftRecord => ({ ...scope, slot, version: 1, value, updatedAt: 1 })
function memoryRepository(initial: TeachingDraftRecord[] = []) {
  const rows = new Map(initial.map(value => [JSON.stringify([value.accountId, value.workspaceId, value.slot]), structuredClone(value)]))
  const key = (current: TeachingDraftScope, name: string) => JSON.stringify([current.accountId, current.workspaceId, name])
  const repository: TeachingDraftRepository = {
    read: vi.fn(async current => Array.from(rows.values()).filter(value => value.accountId === current.accountId && value.workspaceId === current.workspaceId)),
    write: vi.fn(async (current, name, value) => { rows.set(key(current, name), { ...current, slot: name, version: 1, value: structuredClone(value), updatedAt: Date.now() }) }),
    clear: vi.fn(async (current, name) => { rows.delete(key(current, name)) }),
  }
  return { repository, get: (name = slot) => rows.get(key(scope, name)) }
}
function mount(props: Partial<Parameters<typeof TeacherStudentTasks>[0]> = {}) { return render(<TeacherStudentTasks followup={source()} workspaceId={scope.workspaceId} {...props} />) }
async function expand() {
  const details = screen.getByText('Send practice to a student').closest('details')!
  act(() => { details.open = true; fireEvent(details, new Event('toggle')) })
  await waitFor(() => expect(screen.getByLabelText('Student account')).toBeEnabled())
}
async function expandDisabled() {
  const details = screen.getByText('Send practice to a student').closest('details')!
  act(() => { details.open = true; fireEvent(details, new Event('toggle')) })
  await waitFor(() => expect(api.getStudentTaskRecipients).toHaveBeenCalled())
}
function chooseAndCheck() {
  fireEvent.change(screen.getByLabelText('Student account'), { target: { value: learnerId } })
  fireEvent.click(screen.getByLabelText('I have checked the selected account and all student-visible content.'))
}
async function restore() { fireEvent.click(await screen.findByRole('button', { name: 'Restore local draft' })) }
function openIssued() {
  const details = screen.getByText(/Issued student tasks \(/).closest('details')!
  act(() => { details.open = true; fireEvent(details, new Event('toggle')) })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getStudentTaskRecipients).mockReset().mockResolvedValue(setup())
  vi.mocked(api.listTeacherStudentTasks).mockReset().mockResolvedValue([])
  vi.mocked(api.issueStudentTask).mockReset().mockImplementation(async payload => task({ task_id: payload.task_id, title: payload.title, instructions: payload.instructions, recipient_user_id: payload.recipient_user_id, question_hints: api.cloneQuestionHints(payload.question_hints) }))
  vi.mocked(api.getTeacherStudentTask).mockReset().mockResolvedValue(task())
  vi.mocked(api.revokeStudentTask).mockReset().mockImplementation(async (_id, payload) => task({ status: 'revoked', task_revision: payload.expected_revision + 1, revoked_at: 300, revoke_reason: payload.reason }))
  vi.mocked(followups.getTeachingFollowup).mockReset().mockResolvedValue(source())
  vi.mocked(followups.listTeachingFollowups).mockReset().mockResolvedValue([source()])
  vi.mocked(followups.listTeachingFollowupAttempts).mockReset().mockResolvedValue([])
  vi.mocked(reports.getTeachingReport).mockReset().mockResolvedValue(savedReport())
})
afterEach(() => vi.unstubAllGlobals())

it('keeps the panel collapsed and projects an explicit student-visible allowlist without teacher fields', async () => {
  expect(api.studentVisibleTaskPreview(source(), 'A little practice', 'Try it.')).toEqual({ title: 'A little practice', instructions: 'Try it.', questions: [{ question_id: 'F1', question: source().questions[0].question }] })
  mount()
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(api.getStudentTaskRecipients).not.toHaveBeenCalled()
  await expand()
  const preview = screen.getByRole('region', { name: 'Student-visible preview' })
  expect(preview).toHaveTextContent('A little practice')
  expect(preview).toHaveTextContent(source().questions[0].question)
  expect(preview.textContent).not.toContain('PRIVATE_')
  expect(screen.getByLabelText('Student account')).toHaveValue('')
  expect(api.issueStudentTask).not.toHaveBeenCalled()
})

it('retains a usable preview with auth disabled and links to adult setup documentation without changing auth', async () => {
  vi.mocked(api.getStudentTaskRecipients).mockResolvedValue({ enabled: false, reason: 'authentication_disabled', recipients: [] })
  mount(); await expandDisabled()
  expect(await screen.findByText(/Student delivery needs multi-user authentication/)).toBeVisible()
  expect(screen.getByRole('region', { name: 'Student-visible preview' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Publish to this student' })).toBeDisabled()
  expect(screen.getByRole('link', { name: 'How to set up student accounts' })).toHaveAttribute('href', expect.stringContaining('docs-for-dev/STUDENT_TASKS.md'))
  expect(screen.queryByRole('link', { name: 'Manage student accounts' })).toBeNull()
  expect(api.issueStudentTask).not.toHaveBeenCalled()
})

it('uses setup flags and recipient eligibility rather than report labels or a single matching account', async () => {
  vi.mocked(api.getStudentTaskRecipients).mockResolvedValueOnce({ enabled: false, reason: 'unsupported_identity_backend', recipients: setup().recipients })
  const view = mount(); await expandDisabled()
  expect(await screen.findByText(/unavailable with the current identity service/)).toBeVisible()
  expect(screen.getByLabelText('Student account')).toBeDisabled()
  view.unmount()
  vi.mocked(api.getStudentTaskRecipients).mockResolvedValueOnce({ enabled: true, reason: null, recipients: [setup().recipients[1]] })
  mount(); await expand()
  expect(screen.getByRole('option', { name: /Blocked account/ })).toBeDisabled()
  expect(screen.getByRole('link', { name: 'Manage student accounts' })).toHaveAttribute('href', '/admin/users?dt_workspace=class-a')
  expect(screen.getByLabelText('Student account')).toHaveValue('')
  expect(screen.getByRole('button', { name: 'Publish to this student' })).toBeDisabled()
})

it('publishes only after explicit account and content checks and sends an actual learner UID', async () => {
  mount(); await expand()
  expect(screen.getByRole('button', { name: 'Publish to this student' })).toBeDisabled()
  chooseAndCheck()
  fireEvent.change(screen.getByLabelText('Student-visible title'), { target: { value: 'A new child-friendly title' } })
  expect(screen.getByLabelText('I have checked the selected account and all student-visible content.')).not.toBeChecked()
  fireEvent.click(screen.getByLabelText('I have checked the selected account and all student-visible content.'))
  fireEvent.click(screen.getByRole('button', { name: 'Publish to this student' }))
  await screen.findByText(/server has confirmed this publishing record/)
  const payload = vi.mocked(api.issueStudentTask).mock.calls[0][0]
  expect(Object.keys(payload).sort()).toEqual(['task_id', 'followup_id', 'followup_revision', 'recipient_user_id', 'title', 'instructions'].sort())
  expect(payload).toMatchObject({ recipient_user_id: learnerId, followup_id: followupId, followup_revision: 1, title: 'A new child-friendly title' })
  expect(JSON.stringify(payload)).not.toContain('PRIVATE_')
  expect(api.issueStudentTask).toHaveBeenCalledWith(payload, 'class-a', expect.any(AbortSignal))
})

it('blocks dirty or no-longer-confirmed source publishing while preserving the preview and explicit reload actions', async () => {
  const onReloadReport = vi.fn()
  vi.mocked(reports.getTeachingReport).mockResolvedValue(savedReport({ status: 'draft', revision: 2 }))
  mount({ canPublish: false, onReloadReport }); await expand()
  expect(await screen.findByText(/saved source or question version has changed/)).toBeVisible()
  expect(screen.getByRole('button', { name: 'Publish to this student' })).toBeDisabled()
  expect(screen.getByRole('region', { name: 'Student-visible preview' })).toHaveTextContent(source().questions[0].question)
  fireEvent.click(screen.getByRole('button', { name: 'Reload source report' }))
  expect(onReloadReport).toHaveBeenCalledTimes(1)
  expect(api.issueStudentTask).not.toHaveBeenCalled()
})

it('retries an ambiguous publication with the same UUID and starts a new identity only after content changes', async () => {
  vi.mocked(api.issueStudentTask).mockRejectedValueOnce(new Error('Connection interrupted')).mockRejectedValueOnce(new Error('Still unavailable'))
  mount(); await expand(); chooseAndCheck()
  fireEvent.click(screen.getByRole('button', { name: 'Publish to this student' }))
  await screen.findByText('Connection interrupted')
  fireEvent.click(screen.getByRole('button', { name: 'Publish to this student' }))
  await screen.findByText('Still unavailable')
  const first = vi.mocked(api.issueStudentTask).mock.calls[0][0]
  expect(vi.mocked(api.issueStudentTask).mock.calls[1][0]).toEqual(first)
  fireEvent.change(screen.getByLabelText('Instructions for the student (optional)'), { target: { value: 'Try this variation.' } })
  fireEvent.click(screen.getByLabelText('I have checked the selected account and all student-visible content.'))
  fireEvent.click(screen.getByRole('button', { name: 'Publish to this student' }))
  await waitFor(() => expect(api.issueStudentTask).toHaveBeenCalledTimes(3))
  expect(vi.mocked(api.issueStudentTask).mock.calls[2][0].task_id).not.toBe(first.task_id)
})

it('prevents duplicate clicks while publishing and keeps source-conflict input without silently adopting new questions', async () => {
  let rejectIssue!: (reason: unknown) => void
  vi.mocked(api.issueStudentTask).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectIssue = reject }))
  const onReloadFollowup = vi.fn()
  mount({ onReloadFollowup }); await expand(); chooseAndCheck()
  fireEvent.change(screen.getByLabelText('Student-visible title'), { target: { value: 'Preserved publishing input' } }); fireEvent.click(screen.getByLabelText('I have checked the selected account and all student-visible content.'))
  fireEvent.click(screen.getByRole('button', { name: 'Publish to this student' })); fireEvent.click(screen.getByRole('button', { name: 'Publish to this student' }))
  expect(api.issueStudentTask).toHaveBeenCalledTimes(1)
  await act(async () => rejectIssue(new ApiError({ code: 'teaching_student_task_source_changed', message: 'Source changed', status: 409, retryable: false, scope: 'network' })))
  expect(screen.getByLabelText('Student-visible title')).toHaveValue('Preserved publishing input')
  expect(screen.getByRole('button', { name: 'Publish to this student' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved practice' }))
  expect(onReloadFollowup).toHaveBeenCalledTimes(1)
})

it('shows only immutable final responses, with needs-help and assistance distinct and no teacher grading controls', async () => {
  const two = source({ questions: [...source().questions, { question_id: 'F2', question: 'Explain a common denominator.', reference_answer: 'PRIVATE_SECOND_KEY', rubric: null }] })
  vi.mocked(api.listTeacherStudentTasks).mockResolvedValue([task({ status: 'submitted' })])
  vi.mocked(api.getTeacherStudentTask).mockResolvedValue(task({ status: 'submitted', task_revision: 3, source_snapshot: two, submitted_at: 200, submission: { task_id: taskId, submission_id: 'f328543a-66d0-4f59-a5af-dc481409e97c', submitted_at: 200, responses: [{ question_id: 'F1', response_status: 'answered', answer: '3/12 + 2/12 = 5/12', assistance: 'assisted' }, { question_id: 'F2', response_status: 'needs_help', answer: null, assistance: 'unknown' }] } }))
  mount(); await expand(); openIssued()
  fireEvent.click(await screen.findByRole('button', { name: 'View task and final answers' }))
  const dialog = screen.getByRole('dialog', { name: 'Student task' })
  await within(dialog).findByText('3/12 + 2/12 = 5/12')
  expect(within(dialog).getByText('Asked for help')).toBeVisible()
  expect(within(dialog).getByText('Completed with help')).toBeVisible()
  expect(within(dialog).queryByRole('textbox')).toBeNull()
  expect(within(dialog).queryByRole('button', { name: /Grade|Correct|Review|Record response/ })).toBeNull()
  expect(dialog.textContent).not.toContain('PRIVATE_REFERENCE')
  expect(api.revokeStudentTask).not.toHaveBeenCalled()
})

it('does not present unsubmitted progress as final answers and requires a reasoned explicit revocation', async () => {
  const inProgress = task({ status: 'in_progress', task_revision: 2, progress: { revision: 2, current_question_index: 0, saved_at: 150 } })
  vi.mocked(api.listTeacherStudentTasks).mockResolvedValue([inProgress])
  vi.mocked(api.getTeacherStudentTask).mockResolvedValue(inProgress)
  mount(); await expand(); openIssued(); fireEvent.click(await screen.findByRole('button', { name: 'View task and final answers' }))
  const dialog = screen.getByRole('dialog', { name: 'Student task' })
  await within(dialog).findByText(/has not submitted final answers/)
  expect(within(dialog).getByText(source().questions[0].question)).toBeVisible()
  expect(dialog.textContent).not.toContain('PRIVATE_REFERENCE')
  expect(within(dialog).queryByRole('region', { name: 'Final answers submitted by the student' })).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke task' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm revocation' }))
  await screen.findByText('Enter a reason for revoking this task.')
  expect(api.revokeStudentTask).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Reason for revoking'), { target: { value: 'Issued to the wrong account.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Confirm revocation' }))
  await screen.findByText(/Task revoked. Its content/)
  expect(api.revokeStudentTask).toHaveBeenCalledWith(taskId, { expected_revision: 2, reason: 'Issued to the wrong account.' }, 'class-a', expect.any(AbortSignal))
})

it('keeps the revocation reason on conflict and rechecks current revision before another explicit confirmation', async () => {
  vi.mocked(api.listTeacherStudentTasks).mockResolvedValue([task()])
  vi.mocked(api.revokeStudentTask).mockRejectedValueOnce(new ApiError({ code: 'teaching_student_task_changed', message: 'Task changed', status: 409, retryable: false, scope: 'network' }))
  mount(); await expand(); openIssued(); fireEvent.click(await screen.findByRole('button', { name: 'View task and final answers' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Revoke task' }))
  fireEvent.change(screen.getByLabelText('Reason for revoking'), { target: { value: 'Please use a replacement task.' } }); fireEvent.click(screen.getByRole('button', { name: 'Confirm revocation' }))
  await screen.findByText('Task changed')
  expect(screen.getByLabelText('Reason for revoking')).toHaveValue('Please use a replacement task.')
  vi.mocked(api.getTeacherStudentTask).mockResolvedValueOnce(task({ task_revision: 3, status: 'submitted' }))
  fireEvent.click(screen.getByRole('button', { name: 'Recheck the current task' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm revocation' })).toBeEnabled())
  expect(api.revokeStudentTask).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Confirm revocation' }))
  await waitFor(() => expect(api.revokeStudentTask).toHaveBeenCalledTimes(2))
  expect(vi.mocked(api.revokeStudentTask).mock.calls[1][1].expected_revision).toBe(3)
})

it('strictly validates recoverable publishing identity, source relationship and acknowledgements', () => {
  expect(api.isStudentTaskPublishDraft(publishing())).toBe(true)
  expect(api.isStudentTaskPublishDraft({ ...publishing(), version: 2 })).toBe(false)
  expect(api.isStudentTaskPublishDraft({ ...publishing(), payload: { ...publishing().payload, followup_revision: 2 } })).toBe(false)
  expect(api.isStudentTaskPublishDraft({ ...publishing(), acknowledged_task_id: followupId })).toBe(false)
  expect(api.isStudentTaskPublishDraft({ ...publishing(), hidden: () => undefined })).toBe(false)
  expect(api.isStudentTaskPublishDraft({ ...publishing(), submitted_payload: { ...publishing().payload, title: 'A different attempt' } })).toBe(false)
})

it('appends issued-task pages without duplicate rows and preserves current rows on a failed refresh', async () => {
  const first = Array.from({ length: 20 }, (_, index) => task({ task_id: crypto.randomUUID(), title: `Task ${index + 1}` }))
  vi.mocked(api.listTeacherStudentTasks).mockResolvedValueOnce(first).mockResolvedValueOnce([first[0], task({ title: 'Additional task' })])
  mount(); await expand(); openIssued()
  expect(await screen.findAllByRole('button', { name: 'View task and final answers' })).toHaveLength(20)
  fireEvent.click(screen.getByRole('button', { name: 'Load more issued tasks' }))
  await screen.findByText('Additional task')
  expect(screen.getAllByRole('button', { name: 'View task and final answers' })).toHaveLength(21)
  expect(api.listTeacherStudentTasks).toHaveBeenLastCalledWith(followupId, { limit: 20, offset: 20 }, 'class-a', expect.any(AbortSignal))
  vi.mocked(api.listTeacherStudentTasks).mockRejectedValueOnce(new Error('Offline'))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh issued tasks' }))
  await screen.findByText(/Issued tasks could not be loaded/)
  expect(screen.getAllByRole('button', { name: 'View task and final answers' })).toHaveLength(21)
})

it('uses the explicit teacher workspace and a small issue payload on the real HTTP client', async () => {
  const real = await vi.importActual<typeof api>('@/lib/teacher-student-tasks-api')
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(task()), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  const controller = new AbortController()
  await real.issueStudentTask(publishing().payload, 'class-a', controller.signal)
  expect(fetch).toHaveBeenCalledWith('/api/teaching-analysis/student-tasks?dt_workspace=class-a', expect.objectContaining({ method: 'POST', signal: controller.signal, credentials: 'include', body: JSON.stringify(publishing().payload) }))
  expect(fetch.mock.calls[0][1].body).not.toContain('PRIVATE_')
})

it('restores the same publishing UUID in StrictMode, verifies fresh recipients and source, and never publishes automatically', async () => {
  const pending = publishing()
  const memory = memoryRepository([row(pending)])
  const onDirtyChange = vi.fn()
  render(<StrictMode><TeachingDraftProvider {...scope} repository={memory.repository}><TeacherStudentTasks followup={source()} workspaceId="class-a" onDirtyChange={onDirtyChange} /></TeachingDraftProvider></StrictMode>)
  await restore()
  await waitFor(() => expect(screen.getByLabelText('Student account')).toBeEnabled())
  expect(screen.getByLabelText('Student-visible title')).toHaveValue(pending.payload.title)
  expect(screen.getByLabelText('I have checked the selected account and all student-visible content.')).not.toBeChecked()
  expect(api.getStudentTaskRecipients).toHaveBeenCalledWith('class-a', expect.any(AbortSignal))
  expect(reports.getTeachingReport).toHaveBeenCalledWith(reportId, 'class-a', expect.any(AbortSignal))
  expect(onDirtyChange).toHaveBeenLastCalledWith(true)
  expect(api.issueStudentTask).not.toHaveBeenCalled()
  fireEvent.click(screen.getByLabelText('I have checked the selected account and all student-visible content.'))
  fireEvent.click(screen.getByRole('button', { name: 'Publish to this student' }))
  await waitFor(() => expect(api.issueStudentTask).toHaveBeenCalledTimes(1))
  expect(vi.mocked(api.issueStudentTask).mock.calls[0][0]).toEqual(pending.payload)
  await waitFor(() => expect(memory.get()).toBeUndefined())
})

it('retains restored input when source verification fails and requires an explicit retry instead of trusting the cache', async () => {
  const pending = publishing()
  const memory = memoryRepository([row(pending)])
  vi.mocked(followups.getTeachingFollowup).mockRejectedValueOnce(new Error('Offline'))
  render(<TeachingDraftProvider {...scope} repository={memory.repository}><TeacherStudentTasks followup={source()} workspaceId="class-a" /></TeachingDraftProvider>)
  await restore()
  await screen.findByText(/The saved source could not be verified/)
  expect(screen.getByLabelText('Student-visible title')).toHaveValue(pending.payload.title)
  expect(screen.getByRole('button', { name: 'Publish to this student' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }))
  await waitFor(() => expect(screen.getByLabelText('I have checked the selected account and all student-visible content.')).toBeEnabled())
  expect(api.issueStudentTask).not.toHaveBeenCalled()
})

it('keeps a server acknowledgement locked through failed local cleanup and retries cleanup without another POST', async () => {
  const memory = memoryRepository()
  vi.mocked(memory.repository.clear).mockRejectedValueOnce(new Error('Local storage unavailable'))
  render(<TeachingDraftProvider {...scope} repository={memory.repository}><TeacherStudentTasks followup={source()} workspaceId="class-a" /></TeachingDraftProvider>)
  await waitFor(() => expect(memory.repository.read).toHaveBeenCalled())
  await expand(); chooseAndCheck(); fireEvent.click(screen.getByRole('button', { name: 'Publish to this student' }))
  await screen.findByText(/server has confirmed publication, but the local publishing draft/)
  expect(screen.getByRole('button', { name: 'Publish to this student' })).toBeDisabled()
  expect(api.issueStudentTask).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Retry local cleanup' }))
  await waitFor(() => expect(screen.getByLabelText('Student account')).toHaveValue(''))
  expect(api.issueStudentTask).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(memory.get()).toBeUndefined())
})

it('does not resurrect an acknowledged task as a publishable draft after explicit restoration', async () => {
  const pending = publishing({ acknowledged_task_id: taskId })
  const memory = memoryRepository([row(pending)])
  render(<TeachingDraftProvider {...scope} repository={memory.repository}><TeacherStudentTasks followup={source()} workspaceId="class-a" /></TeachingDraftProvider>)
  await restore()
  await waitFor(() => expect(memory.get()).toBeUndefined())
  expect(api.issueStudentTask).not.toHaveBeenCalled()
})

it('recovers an ambiguous committed receipt by an explicit read even when the source is now stale', async () => {
  const pending = publishing()
  const memory = memoryRepository([row(pending)])
  vi.mocked(reports.getTeachingReport).mockResolvedValue(savedReport({ revision: 2 }))
  vi.mocked(api.getTeacherStudentTask).mockResolvedValue(task({ task_id: pending.payload.task_id, title: pending.payload.title, instructions: pending.payload.instructions, status: 'revoked', revoked_at: 300, revoke_reason: 'Replaced later.' }))
  render(<TeachingDraftProvider {...scope} repository={memory.repository}><TeacherStudentTasks followup={source()} workspaceId="class-a" /></TeachingDraftProvider>)
  await restore()
  await screen.findByText(/saved source or question version has changed/)
  expect(screen.getByRole('button', { name: 'Publish to this student' })).toBeDisabled()
  expect(api.getTeacherStudentTask).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Check this publishing request' }))
  await waitFor(() => expect(memory.get()).toBeUndefined())
  expect(api.getTeacherStudentTask).toHaveBeenCalledWith(taskId, 'class-a', expect.any(AbortSignal))
  expect(api.issueStudentTask).not.toHaveBeenCalled()
})

it('does not acknowledge a receipt with different recipient content or source snapshots', async () => {
  const pending = publishing()
  const memory = memoryRepository([row(pending)])
  vi.mocked(api.getTeacherStudentTask).mockResolvedValue(task({ title: pending.payload.title, instructions: pending.payload.instructions, source_snapshot: source({ questions: [{ ...source().questions[0], question: 'WRONG_SNAPSHOT_FOR_RECEIPT' }] }) }))
  render(<TeachingDraftProvider {...scope} repository={memory.repository}><TeacherStudentTasks followup={source()} workspaceId="class-a" /></TeachingDraftProvider>)
  await restore()
  await waitFor(() => expect(screen.getByLabelText('Student account')).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Check this publishing request' }))
  await screen.findByText(/publishing receipt could not be confirmed/)
  expect(screen.getByLabelText('Student-visible title')).toHaveValue(pending.payload.title)
  expect(screen.getByRole('region', { name: 'Student-visible preview' })).not.toHaveTextContent('WRONG_SNAPSHOT_FOR_RECEIPT')
  expect(api.issueStudentTask).not.toHaveBeenCalled()
})

it('finds an old-version publishing draft in the stable slot and adopts the newer source only after explicit clearing', async () => {
  const pending = publishing()
  const current = source({ revision: 2, questions: [{ ...source().questions[0], question: 'NEW_VERSION_QUESTION_NOT_YET_ADOPTED' }] })
  const memory = memoryRepository([row(pending)])
  vi.mocked(followups.getTeachingFollowup).mockResolvedValue(current)
  vi.mocked(api.getTeacherStudentTask).mockResolvedValue(task({ title: pending.payload.title, instructions: pending.payload.instructions }))
  render(<TeachingDraftProvider {...scope} repository={memory.repository}><TeacherStudentTasks followup={current} workspaceId="class-a" /></TeachingDraftProvider>)
  await restore()
  await screen.findByText(/saved source or question version has changed/)
  const preview = screen.getByRole('region', { name: 'Student-visible preview' })
  expect(preview).toHaveTextContent(source().questions[0].question)
  expect(preview).not.toHaveTextContent('NEW_VERSION_QUESTION_NOT_YET_ADOPTED')
  expect(screen.getByLabelText('Student-visible title')).toHaveValue(pending.payload.title)
  expect(screen.getByRole('button', { name: 'Publish to this student' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Check this publishing request' }))
  await waitFor(() => expect(memory.get()).toBeUndefined())
  expect(preview).not.toHaveTextContent('NEW_VERSION_QUESTION_NOT_YET_ADOPTED')
  fireEvent.click(screen.getByRole('button', { name: 'Clear this publishing form' }))
  await waitFor(() => expect(preview).toHaveTextContent('NEW_VERSION_QUESTION_NOT_YET_ADOPTED'))
  await waitFor(() => expect(screen.getByLabelText('I have checked the selected account and all student-visible content.')).toBeEnabled())
  chooseAndCheck()
  await waitFor(() => expect((memory.get()?.value as api.StudentTaskPublishDraft | undefined)?.payload.followup_revision).toBe(2))
  expect((memory.get()!.value as api.StudentTaskPublishDraft).payload.task_id).not.toBe(pending.payload.task_id)
  expect(api.issueStudentTask).not.toHaveBeenCalled()
})

it('does not reset an ambiguous intent when a newer saved version arrives through props', async () => {
  vi.mocked(api.issueStudentTask).mockRejectedValueOnce(new Error('Publication response lost'))
  const view = mount(); await expand(); chooseAndCheck()
  fireEvent.click(screen.getByRole('button', { name: 'Publish to this student' }))
  await screen.findByText('Publication response lost')
  const payload = vi.mocked(api.issueStudentTask).mock.calls[0][0]
  const current = source({ revision: 2, questions: [{ ...source().questions[0], question: 'LATEST_QUESTION_WAITING_FOR_EXPLICIT_RESET' }] })
  vi.mocked(followups.getTeachingFollowup).mockResolvedValue(current)
  vi.mocked(api.getTeacherStudentTask).mockResolvedValue(task({ task_id: payload.task_id, title: payload.title, instructions: payload.instructions }))
  view.rerender(<TeacherStudentTasks followup={current} workspaceId="class-a" />)
  await screen.findByText(/saved source or question version has changed/)
  expect(screen.getByLabelText('Student account')).toHaveValue(learnerId)
  expect(screen.getByRole('region', { name: 'Student-visible preview' })).toHaveTextContent(source().questions[0].question)
  expect(screen.getByRole('region', { name: 'Student-visible preview' })).not.toHaveTextContent('LATEST_QUESTION_WAITING_FOR_EXPLICIT_RESET')
  fireEvent.click(screen.getByRole('button', { name: 'Check this publishing request' }))
  await waitFor(() => expect(api.getTeacherStudentTask).toHaveBeenCalledWith(payload.task_id, 'class-a', expect.any(AbortSignal)))
  expect(api.issueStudentTask).toHaveBeenCalledTimes(1)
})

it('aborts old-scope publication and reads when the workspace changes, ignoring late acknowledgements', async () => {
  let finish!: (value: api.TeacherStudentTask) => void
  vi.mocked(api.issueStudentTask).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const view = mount(); await expand(); chooseAndCheck(); fireEvent.click(screen.getByRole('button', { name: 'Publish to this student' }))
  const payload = vi.mocked(api.issueStudentTask).mock.calls[0][0]
  const signal = vi.mocked(api.issueStudentTask).mock.calls[0][2]!
  view.rerender(<TeacherStudentTasks followup={source()} workspaceId="class-b" />)
  expect(signal.aborted).toBe(true)
  await act(async () => finish(task({ task_id: payload.task_id })))
  expect(screen.queryByText(/server has confirmed this publishing record/)).toBeNull()
  await expand()
  expect(api.getStudentTaskRecipients).toHaveBeenLastCalledWith('class-b', expect.any(AbortSignal))
})

it('aggregates pending publishing into practice replacement confirmation and clears only after explicit discard', async () => {
  const memory = memoryRepository()
  render(<TeachingDraftProvider {...scope} repository={memory.repository}><PracticeFollowups report={savedReport()} workspaceId="class-a" /></TeachingDraftProvider>)
  fireEvent.click(await screen.findByRole('button', { name: /PRIVATE_FOLLOWUP_TITLE/ }))
  await screen.findByText('Send practice to a student')
  await expand(); chooseAndCheck()
  await waitFor(() => expect(memory.get()).toBeDefined())
  const originalId = (memory.get()!.value as api.StudentTaskPublishDraft).payload.task_id
  fireEvent.click(screen.getByRole('button', { name: 'Revise practice questions' }))
  const dialog = screen.getByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(screen.getByLabelText('Student account')).toHaveValue(learnerId)
  expect((memory.get()!.value as api.StudentTaskPublishDraft).payload.task_id).toBe(originalId)
  fireEvent.click(screen.getByRole('button', { name: 'Revise practice questions' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard and continue' }))
  await screen.findByLabelText('Practice title')
  await waitFor(() => expect(memory.get()).toBeUndefined())
  expect(api.issueStudentTask).not.toHaveBeenCalled()
})

const hintPlan = (): api.TaskQuestionHints[] => [{ question_id: 'F1', hints: ['Compare the sizes of the units.', 'Sketch twelve equal parts and mark the fractions.'] }]
function openHintEditor() { const details = screen.getByText('Step-by-step hints (optional)').closest('details')!; act(() => { details.open = true; fireEvent(details, new Event('toggle')) }) }
function openHintHistory(dialog: HTMLElement) { const details = within(dialog).getByText('Saved hints and unlock history').closest('details')!; act(() => { details.open = true; fireEvent(details, new Event('toggle')) }); return details }

it('starts with optional hint editing collapsed, leaves new hints blank, and requires valid content before review', async () => {
  const onDirtyChange = vi.fn()
  mount({ onDirtyChange }); await expand()
  expect(screen.getByText('Step-by-step hints (optional)').closest('details')).not.toHaveAttribute('open')
  openHintEditor()
  fireEvent.click(screen.getByRole('button', { name: 'Add a hint for F1' }))
  expect(screen.getByLabelText('F1 · Hint 1')).toHaveValue('')
  expect(screen.getByLabelText('I have checked the selected account and all student-visible content.')).toBeDisabled()
  expect(onDirtyChange).toHaveBeenLastCalledWith(true)
  fireEvent.change(screen.getByLabelText('F1 · Hint 1'), { target: { value: hintPlan()[0].hints[0] } })
  fireEvent.click(screen.getByRole('button', { name: 'Add a hint for F1' }))
  fireEvent.change(screen.getByLabelText('F1 · Hint 2'), { target: { value: hintPlan()[0].hints[1] } })
  fireEvent.click(screen.getByRole('button', { name: 'Add a hint for F1' }))
  fireEvent.change(screen.getByLabelText('F1 · Hint 3'), { target: { value: 'Check whether both units now have the same size.' } })
  expect(screen.getByRole('button', { name: 'Add a hint for F1' })).toBeDisabled()
  const preview = screen.getByRole('region', { name: 'Student-visible preview' })
  expect(preview).toHaveTextContent(hintPlan()[0].hints[0])
  expect(preview).toHaveTextContent(hintPlan()[0].hints[1])
  expect(preview.textContent).not.toContain('PRIVATE_')
  chooseAndCheck()
  expect(screen.getByRole('button', { name: 'Publish to this student' })).toBeEnabled()
  fireEvent.change(screen.getByLabelText('F1 · Hint 2'), { target: { value: 'Draw a strip before choosing equal units.' } })
  expect(screen.getByLabelText('I have checked the selected account and all student-visible content.')).not.toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: 'Remove hint 2 for F1' }))
  expect(screen.getByLabelText('F1 · Hint 2')).toHaveValue('Check whether both units now have the same size.')
  expect(api.issueStudentTask).not.toHaveBeenCalled()
})

it('compares nested hint plans by content and canonicalizes only absent versus empty plans', () => {
  const original = { ...publishing().payload, question_hints: hintPlan() }
  const cloned = api.cloneStudentTaskIssue(original)
  expect(api.sameStudentTaskIntent(original, cloned)).toBe(true)
  expect(cloned.question_hints).not.toBe(original.question_hints)
  expect(cloned.question_hints![0].hints).not.toBe(original.question_hints[0].hints)
  cloned.question_hints![0].hints[0] = 'Different advice.'
  expect(original.question_hints[0].hints[0]).toBe(hintPlan()[0].hints[0])
  expect(api.sameStudentTaskIntent(original, cloned)).toBe(false)
  expect(api.sameStudentTaskIntent(publishing().payload, { ...publishing().payload, question_hints: [] })).toBe(true)
  expect(api.canonicalStudentTaskIssue({ ...publishing().payload, question_hints: [] })).toEqual(publishing().payload)
  expect(api.sameQuestionHints(hintPlan(), [{ question_id: 'F1', hints: [...hintPlan()[0].hints].reverse() }])).toBe(false)
  const preview = api.studentVisibleTaskPreview(source(), 'Small practice', '', original.question_hints)
  expect(preview.question_hints).toEqual(hintPlan())
  expect(JSON.stringify(preview)).not.toContain('PRIVATE_')
})

it('validates source-bound hint fields and lengths while preserving incomplete editing rows', () => {
  const pending = publishing({ payload: { ...publishing().payload, question_hints: [{ question_id: 'F1', hints: [''] }] }, reviewed: false, submitted_payload: null })
  expect(api.isStudentTaskPublishDraft(pending)).toBe(true)
  expect(api.isStudentTaskPublishDraft({ ...pending, reviewed: true })).toBe(false)
  expect(api.isStudentTaskPublishDraft({ ...pending, submitted_payload: pending.payload })).toBe(false)
  expect(api.isStudentTaskPublishDraft(publishing({ submitted_payload: { ...publishing().payload, question_hints: [] } }))).toBe(true)
  for (const plan of [null, [{ question_id: 'F9', hints: ['Read carefully.'] }], [{ ...hintPlan()[0], reference_answer: 'PRIVATE' }], [hintPlan()[0], hintPlan()[0]], [{ question_id: 'F1', hints: ['1', '2', '3', '4'] }], [{ question_id: 'F1', hints: ['a'.repeat(601)] }], [{ question_id: 'F1', hints: ['\ud800'] }]]) {
    expect(api.isStudentTaskPublishDraft({ ...pending, payload: { ...pending.payload, question_hints: plan } })).toBe(false)
  }
  expect(api.validQuestionHintPlan([{ question_id: 'F1', hints: ['🙂'.repeat(600)] }], source())).toBe(true)
  expect(api.validQuestionHintPlan([{ question_id: 'F1', hints: ['   '] }], source())).toBe(false)
})

it('keeps a retry plan and UUID immutable, then creates a new intent when one hint changes', async () => {
  vi.mocked(api.issueStudentTask).mockRejectedValueOnce(new Error('Lost issue acknowledgement')).mockRejectedValueOnce(new Error('Still offline'))
  mount(); await expand(); openHintEditor()
  fireEvent.click(screen.getByRole('button', { name: 'Add a hint for F1' }))
  fireEvent.change(screen.getByLabelText('F1 · Hint 1'), { target: { value: hintPlan()[0].hints[0] } })
  chooseAndCheck(); fireEvent.click(screen.getByRole('button', { name: 'Publish to this student' }))
  await screen.findByText('Lost issue acknowledgement')
  const first = vi.mocked(api.issueStudentTask).mock.calls[0][0]
  fireEvent.click(screen.getByRole('button', { name: 'Publish to this student' }))
  await screen.findByText('Still offline')
  expect(vi.mocked(api.issueStudentTask).mock.calls[1][0]).toEqual(first)
  fireEvent.change(screen.getByLabelText('F1 · Hint 1'), { target: { value: 'Use equal-sized parts as a starting point.' } })
  expect(first.question_hints![0].hints[0]).toBe(hintPlan()[0].hints[0])
  expect(screen.getByLabelText('I have checked the selected account and all student-visible content.')).not.toBeChecked()
  fireEvent.click(screen.getByLabelText('I have checked the selected account and all student-visible content.'))
  fireEvent.click(screen.getByRole('button', { name: 'Publish to this student' }))
  await screen.findByText(/server has confirmed this publishing record/)
  expect(vi.mocked(api.issueStudentTask).mock.calls[2][0].task_id).not.toBe(first.task_id)
  expect(vi.mocked(api.issueStudentTask).mock.calls[2][0].question_hints![0].hints).toEqual(['Use equal-sized parts as a starting point.'])
})

it('restores an incomplete hint row without confirming or publishing it and preserves source question binding', async () => {
  const pending = publishing({ payload: { ...publishing().payload, question_hints: [{ question_id: 'F1', hints: [''] }] }, reviewed: false, submitted_payload: null })
  const memory = memoryRepository([row(pending)])
  render(<TeachingDraftProvider {...scope} repository={memory.repository}><TeacherStudentTasks followup={source()} workspaceId="class-a" /></TeachingDraftProvider>)
  await restore(); await waitFor(() => expect(screen.getByLabelText('Student account')).toBeEnabled()); openHintEditor()
  expect(screen.getByLabelText('F1 · Hint 1')).toHaveValue('')
  expect(screen.getByLabelText('I have checked the selected account and all student-visible content.')).toBeDisabled()
  expect(api.issueStudentTask).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('F1 · Hint 1'), { target: { value: 'Start with one drawing of equal-sized units.' } })
  await waitFor(() => expect((memory.get()?.value as api.StudentTaskPublishDraft)?.payload.question_hints?.[0].hints[0]).toBe('Start with one drawing of equal-sized units.'))
  expect((memory.get()!.value as api.StudentTaskPublishDraft).payload.task_id).not.toBe(pending.payload.task_id)
  expect(api.issueStudentTask).not.toHaveBeenCalled()
})

it('treats hint-only edits as dirty and becomes clean after every hint is explicitly removed', async () => {
  const memory = memoryRepository()
  const dirty = vi.fn()
  render(<TeachingDraftProvider {...scope} repository={memory.repository}><TeacherStudentTasks followup={source()} workspaceId="class-a" onDirtyChange={dirty} /></TeachingDraftProvider>)
  await expand(); openHintEditor(); fireEvent.click(screen.getByRole('button', { name: 'Add a hint for F1' }))
  await waitFor(() => expect(memory.get()).toBeDefined())
  expect(dirty).toHaveBeenLastCalledWith(true)
  fireEvent.click(screen.getByRole('button', { name: 'Remove hint 1 for F1' }))
  await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false))
  await waitFor(() => expect(memory.get()).toBeUndefined())
  expect(api.issueStudentTask).not.toHaveBeenCalled()
})

it('does not accept an ambiguous receipt with a different hint plan even when all source fields match', async () => {
  const pending = publishing({ payload: { ...publishing().payload, question_hints: hintPlan() }, submitted_payload: { ...publishing().payload, question_hints: hintPlan() } })
  const memory = memoryRepository([row(pending)])
  vi.mocked(api.getTeacherStudentTask).mockResolvedValue(task({ title: pending.payload.title, instructions: pending.payload.instructions, question_hints: [{ question_id: 'F1', hints: ['NOT_THE_ISSUED_HINT_PLAN'] }] }))
  render(<TeachingDraftProvider {...scope} repository={memory.repository}><TeacherStudentTasks followup={source()} workspaceId="class-a" /></TeachingDraftProvider>)
  await restore(); await waitFor(() => expect(screen.getByLabelText('Student account')).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Check this publishing request' }))
  await screen.findByText(/publishing receipt could not be confirmed/)
  expect(screen.getByRole('region', { name: 'Student-visible preview' })).toHaveTextContent(hintPlan()[0].hints[0])
  expect(screen.getByRole('region', { name: 'Student-visible preview' })).not.toHaveTextContent('NOT_THE_ISSUED_HINT_PLAN')
  expect(api.issueStudentTask).not.toHaveBeenCalled()
})

it('shows exact unlocked levels and times before final submission without revealing draft answers or implying understanding', async () => {
  const current = task({ status: 'in_progress', question_hints: hintPlan(), hint_usage: [{ question_id: 'F1', revealed: [{ level: 1, revealed_at: 200 }] }] })
  Object.assign(current.progress, { responses: [{ question_id: 'F1', answer: 'PRIVATE_UNSUBMITTED_ANSWER' }] })
  vi.mocked(api.listTeacherStudentTasks).mockResolvedValue([current]); vi.mocked(api.getTeacherStudentTask).mockResolvedValue(current)
  mount(); await expand(); openIssued(); fireEvent.click(await screen.findByRole('button', { name: 'View task and final answers' }))
  const dialog = screen.getByRole('dialog'); await within(dialog).findByText(/has not submitted final answers/)
  const history = openHintHistory(dialog)
  expect(history).toHaveTextContent(hintPlan()[0].hints[0]); expect(history).toHaveTextContent(hintPlan()[0].hints[1])
  expect(within(history).getByText(`Opened: ${new Date(200_000).toLocaleString('en')}`)).toBeVisible()
  expect(within(history).getByText('No recorded unlock')).toBeVisible()
  expect(history).toHaveTextContent(/Opening a hint does not show understanding/)
  expect(dialog.textContent).not.toContain('PRIVATE_UNSUBMITTED_ANSWER')
  expect(within(dialog).queryByRole('textbox')).toBeNull()
})

it('uses frozen submission hint usage instead of later live metadata and keeps legacy unknown use distinct', async () => {
  const submission = { task_id: taskId, submission_id: 'f328543a-66d0-4f59-a5af-dc481409e97c', submitted_at: 300, responses: [{ question_id: 'F1', response_status: 'answered' as const, answer: '5/12', assistance: 'assisted' as const }], hint_usage: [{ question_id: 'F1', revealed: [{ level: 1, revealed_at: 200 }] }] }
  const current = task({ status: 'submitted', question_hints: hintPlan(), hint_usage: [{ question_id: 'F1', revealed: [{ level: 1, revealed_at: 200 }, { level: 2, revealed_at: 999 }] }], submission })
  vi.mocked(api.listTeacherStudentTasks).mockResolvedValue([current]); vi.mocked(api.getTeacherStudentTask).mockResolvedValue(current)
  const view = mount(); await expand(); openIssued(); fireEvent.click(await screen.findByRole('button', { name: 'View task and final answers' }))
  let dialog = screen.getByRole('dialog'); await within(dialog).findByText('5/12'); let history = openHintHistory(dialog)
  expect(history).toHaveTextContent(/were fixed when the final answers were submitted/)
  expect(within(history).getByText('No recorded unlock')).toBeVisible()
  expect(history.textContent).not.toContain(new Date(999_000).toLocaleString('en'))
  expect(within(dialog).getByText('Completed with help')).toBeVisible()
  view.unmount()
  vi.mocked(api.getTeacherStudentTask).mockResolvedValue(task({ ...current, submission: { ...submission, hint_usage: null } }))
  mount(); await expand(); openIssued(); fireEvent.click(await screen.findByRole('button', { name: 'View task and final answers' }))
  dialog = screen.getByRole('dialog'); await within(dialog).findByText('5/12'); history = openHintHistory(dialog)
  expect(history).toHaveTextContent(/older submission has no hint-use record/)
  expect(within(history).queryByText('No recorded unlock')).toBeNull()
})

it('sends a copied hint plan in the real HTTP body and normalizes legacy hint metadata without changing the source snapshot', async () => {
  const real = await vi.importActual<typeof api>('@/lib/teacher-student-tasks-api')
  const payload = { ...publishing().payload, question_hints: hintPlan() }
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(task({ title: payload.title, instructions: payload.instructions, question_hints: hintPlan(), submission: { task_id: taskId, submission_id: 'f328543a-66d0-4f59-a5af-dc481409e97c', submitted_at: 300, responses: [{ question_id: 'F1', response_status: 'answered', answer: '5/12', assistance: 'independent' }] } })), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  const result = await real.issueStudentTask(payload, 'class-a')
  payload.question_hints[0].hints[0] = 'Later editor change.'
  expect(JSON.parse(fetch.mock.calls[0][1].body).question_hints).toEqual(hintPlan())
  expect(result.hint_usage).toEqual([]); expect(result.submission?.hint_usage).toBeNull()
  expect(result.source_snapshot).toEqual(source())
  expect(result.question_hints).toEqual(hintPlan())
})

it('restores an ambiguous complete hint plan as an independent snapshot and explicitly retries the same publishing UUID', async () => {
  const sharedPayload = { ...publishing().payload, question_hints: hintPlan() }
  const pending = publishing({ payload: sharedPayload, submitted_payload: sharedPayload })
  const memory = memoryRepository([row(pending)])
  render(<StrictMode><TeachingDraftProvider {...scope} repository={memory.repository}><TeacherStudentTasks followup={source()} workspaceId="class-a" /></TeachingDraftProvider></StrictMode>)
  await restore(); await waitFor(() => expect(screen.getByLabelText('Student account')).toBeEnabled()); openHintEditor()
  expect(screen.getByLabelText('F1 · Hint 1')).toHaveValue(hintPlan()[0].hints[0])
  expect(screen.getByLabelText('I have checked the selected account and all student-visible content.')).not.toBeChecked()
  expect(api.issueStudentTask).not.toHaveBeenCalled()
  await waitFor(() => expect(memory.repository.write).toHaveBeenCalled())
  const written = vi.mocked(memory.repository.write).mock.calls.filter(call => call[1] === slot).at(-1)![2] as api.StudentTaskPublishDraft
  expect(written.payload.question_hints).not.toBe(written.submitted_payload!.question_hints)
  expect(written.payload.question_hints![0].hints).not.toBe(written.submitted_payload!.question_hints![0].hints)
  fireEvent.click(screen.getByLabelText('I have checked the selected account and all student-visible content.'))
  fireEvent.click(screen.getByRole('button', { name: 'Publish to this student' }))
  await screen.findByText(/server has confirmed this publishing record/)
  expect(vi.mocked(api.issueStudentTask).mock.calls[0][0]).toEqual(sharedPayload)
  await waitFor(() => expect(memory.get()).toBeUndefined())
})
