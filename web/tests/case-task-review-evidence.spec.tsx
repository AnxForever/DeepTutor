import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode, type ReactNode } from 'react'
import i18n from 'i18next'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { TaskReviewCaseLinker } from '@/components/learning/teaching-analysis/TaskReviewCaseLinker'
import { CaseTaskReviewEvidencePanel } from '@/components/learning/teaching-analysis/CaseTaskReviewEvidencePanel'
import StudentCaseDetailPage from '@/components/learning/teaching-analysis/StudentCaseDetailPage'
import TaskReviewPage from '@/components/learning/teaching-analysis/TaskReviewPage'
import { TeachingDraftProvider } from '@/components/learning/teaching-analysis/TeachingDrafts'
import { exampleAssignment } from '@/components/learning/teaching-analysis/sample'
import { initI18n } from '@/i18n/init'
import translations from '@/locales/en/tasks.json'
import type { TeacherStudentTask } from '@/lib/teacher-student-tasks-api'
import type { SavedTaskReview } from '@/lib/task-reviews-api'
import type { TeachingDraftRecord, TeachingDraftRepository, TeachingDraftScope } from '@/lib/teaching-drafts'
import { caseReviewEvidenceSlot, isCaseEvidencePanelDraft, isTaskReviewCaseDraft, taskReviewCaseSlot, type CaseEvidencePanelDraft, type TaskReviewCaseDraft } from '@/lib/teaching-case-review-drafts'
import * as api from '@/lib/teaching-case-review-api'
import * as cases from '@/lib/teaching-student-cases-api'
import * as reviewApi from '@/lib/task-reviews-api'
import * as teacherApi from '@/lib/teacher-student-tasks-api'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => null }))
vi.mock('@/hooks/useActiveWorkspaceId', () => ({ useActiveWorkspaceId: () => 'class-a' }))
vi.mock('@/components/learning/LearningShell', () => ({ LearningShell: ({ title, children }: { title: string; children: ReactNode }) => <main><h1>{title}</h1>{children}</main>, LearningSkeleton: () => <p>Loading source</p> }))
const auth = vi.hoisted(() => ({ enabled: true, authenticated: true, isAdmin: true, userId: 'teacher-one', statusAvailable: true, loading: false }))
vi.mock('@/hooks/useAuthStatus', () => ({ useAuthStatus: () => auth }))
vi.mock('@/components/learning/TaskTranslations', () => ({ TaskTranslations: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/components/learning/teaching-analysis/StudentCaseAccess', () => ({ StudentCaseAccess: ({ children }: { children: (workspaceId: string) => ReactNode }) => children('class-a') }))
vi.mock('@/components/learning/teaching-analysis/StudentCaseHistory', () => ({ StudentCaseHistory: () => null }))
vi.mock('@/components/learning/teaching-analysis/StudentCaseReportPicker', () => ({ StudentCaseReportPicker: () => null }))
vi.mock('@/components/learning/teaching-analysis/StudentEvidenceTimeline', () => ({ StudentEvidenceTimeline: ({ onReloadCase }: { onReloadCase: () => void }) => <button onClick={onReloadCase}>Reload saved case context</button> }))
vi.mock('@/lib/teaching-student-cases-api', async original => ({ ...(await original<typeof cases>()), getStudentCase: vi.fn(), listStudentCases: vi.fn(), saveStudentCase: vi.fn() }))
vi.mock('@/lib/teaching-case-review-api', async original => ({ ...(await original<typeof api>()), getCaseTaskReviewEvidence: vi.fn(), saveCaseTaskReviewEvidence: vi.fn() }))
vi.mock('@/lib/task-reviews-api', async original => ({ ...(await original<typeof reviewApi>()), getTaskReviewState: vi.fn(), listTaskReviewRevisions: vi.fn(), saveTaskReview: vi.fn() }))
vi.mock('@/lib/teacher-student-tasks-api', async original => ({ ...(await original<typeof teacherApi>()), getTeacherStudentTask: vi.fn() }))
initI18n('en'); i18n.addResourceBundle('en', 'app', translations, true, true)
const CASE = '11111111-1111-4111-8111-111111111111'
const OTHER_CASE = '22222222-2222-4222-8222-222222222222'
const TASK = '33333333-3333-4333-8333-333333333333'
const OTHER_TASK = '44444444-4444-4444-8444-444444444444'
const SUBMISSION = '55555555-5555-4555-8555-555555555555'
const OTHER_SUBMISSION = '66666666-6666-4666-8666-666666666666'
const REPORT = '77777777-7777-4777-8777-777777777777'
const FOLLOWUP = '88888888-8888-4888-8888-888888888888'
const REQUEST = '99999999-9999-4999-8999-999999999999'
const UID = 'actual-learner-uid'
const scope = { accountId: 'teacher-one', workspaceId: 'class-a' }
function task(): TeacherStudentTask { return { task_id: TASK, task_revision: 3, title: 'Small unit practice', recipient_user_id: UID, followup_id: FOLLOWUP, followup_revision: 1, status: 'submitted', issued_at: 1, updated_at: 3, submitted_at: 3, progress: { revision: 1, current_question_index: 0, saved_at: 2 }, instructions: '', source_snapshot: { followup_id: FOLLOWUP, revision: 1, report_id: REPORT, report_revision: 1, priority_index: 0, title: 'PRIVATE_TITLE', questions: [{ question_id: 'F1', question: 'Compare the fractional units.', reference_answer: 'PRIVATE_REFERENCE', rubric: 'PRIVATE_RUBRIC' }], student_ref: 'Same visible name', assignment_ref: 'Worksheet', subject: 'Mathematics', grade: '', knowledge_point: 'Equal units', source_fingerprint: 'a'.repeat(64), created_at: 1, updated_at: 1 }, question_hints: [{ question_id: 'F1', hints: ['An opened hint.', 'PRIVATE_FUTURE_HINT'] }], hint_usage: [], submission: { task_id: TASK, submission_id: SUBMISSION, submitted_at: 3, responses: [{ question_id: 'F1', response_status: 'answered', answer: 'I compared equal units.', assistance: 'assisted' }], hint_usage: [] }, started_at: 2, revoked_at: null, revoke_reason: null, issued_by_user_id: 'teacher-one' } }
function review(change: Partial<SavedTaskReview> = {}): SavedTaskReview { return { task_id: TASK, submission_id: SUBMISSION, request_id: REQUEST, revision: 2, status: 'confirmed', items: [{ question_id: 'F1', result: 'partial', feedback: 'Explain the common unit.' }], summary: 'Check the units again.', change_reason: 'Checked the explanation.', recipient_user_id: UID, report_id: REPORT, report_revision: 1, followup_id: FOLLOWUP, followup_revision: 1, subject: 'Mathematics', knowledge_point: 'Equal units', submission_receipt_hash: 'b'.repeat(64), reviewer_user_id: 'teacher-one', recorded_at: 4, ...change } }
function studentCase(change: Partial<cases.SavedStudentCase> = {}): cases.SavedStudentCase { return { case_id: CASE, revision: 1, label: 'Same visible name', subject: 'Mathematics', archived: false, report_refs: [{ report_id: REPORT, report_revision: 1 }], created_at: 1, updated_at: 1, ...change } }
function link(change: Partial<api.CaseReviewEvidenceLink> = {}): api.CaseReviewEvidenceLink { return { task_id: TASK, submission_id: SUBMISSION, review_revision: 2, question_ids: ['F1'], teacher_observation: 'Needs a clearer explanation.', next_teaching_action: 'Use equal unit strips.', ...change } }
function overlay(change: Partial<api.SavedCaseReviewEvidence> = {}): api.SavedCaseReviewEvidence { return { case_id: CASE, revision: 1, case_revision: 1, request_id: REQUEST, actor_user_id: 'teacher-one', recorded_at: 5, identity_confirmed: true, recipient_user_id: UID, links: [link()], ...change } }
function source(change: Partial<api.CaseReviewEvidenceSourceState> = {}): api.CaseReviewEvidenceSourceState { return { task_id: TASK, submission_id: SUBMISSION, review_revision: 2, status: 'current', latest_review_revision: 2, recipient_user_id: UID, subject: 'Mathematics', knowledge_point: 'Equal units', report_id: REPORT, report_revision: 1, reviewer_user_id: 'teacher-one', recorded_at: 4, review_status: 'confirmed', latest_review_status: 'confirmed', latest_recorded_at: 4, questions: [{ question_id: 'F1', question: 'Compare the fractional units.', answer: 'I compared equal units.', response_status: 'answered', assistance: 'assisted', result: 'partial', feedback: 'Explain the common unit.', hint_usage: [{ level: 1, text: 'An opened hint.', revealed_at: 2 }] }], ...change } }
function evidence(change: Partial<api.CaseReviewEvidenceView> = {}): api.CaseReviewEvidenceView { return { case_id: CASE, case_revision: 1, case_archived: false, overlay: overlay(), acknowledged: null, source_states: [source()], focus_cards: [{ subject: 'Mathematics', knowledge_point: 'Equal units', question_count: 1, needs_teaching: 1, needs_independent_check: 0, ungraded: 0, independent_correct: 0, requested_help: 0 }], ...change } }
function request(change: Partial<api.SaveCaseReviewEvidence> = {}): api.SaveCaseReviewEvidence { return { request_id: REQUEST, expected_revision: 1, expected_case_revision: 1, identity_confirmed: true, links: [link()], ...change } }
function pendingLink(change: Partial<TaskReviewCaseDraft> = {}): TaskReviewCaseDraft { return { kind: 'task-review-case-link', version: 1, target: { task_id: TASK, submission_id: SUBMISSION, review_revision: 2, recipient_user_id: UID, report_id: REPORT, report_revision: 1, source_fingerprint: 'a'.repeat(64), question_ids: ['F1'] }, case_id: CASE, case_label: 'Same visible name', mutation: { payload: request(), submitted_payload: null, acknowledged_request_id: null }, identity_checked: false, ...change } }
function memoryRepository(initial: TeachingDraftRecord[] = []) {
  const rows = new Map(initial.map(value => [JSON.stringify([value.accountId, value.workspaceId, value.slot]), structuredClone(value)]))
  const key = (current: TeachingDraftScope, slot: string) => JSON.stringify([current.accountId, current.workspaceId, slot])
  const repository: TeachingDraftRepository = { read: vi.fn(async current => Array.from(rows.values()).filter(value => value.accountId === current.accountId && value.workspaceId === current.workspaceId)), write: vi.fn(async (current, slot, value) => { rows.set(key(current, slot), { ...current, slot, version: 1, value: structuredClone(value), updatedAt: Date.now() }) }), clear: vi.fn(async (current, slot) => { rows.delete(key(current, slot)) }) }
  return { repository, get: (slot: string) => rows.get(key(scope, slot)) }
}
const draftRow = (slot: string, value: unknown): TeachingDraftRecord => ({ ...scope, slot, value, version: 1, updatedAt: 1 })
const linkSlot = taskReviewCaseSlot(TASK)
const panelSlot = caseReviewEvidenceSlot(CASE)
const acceptsReview = (slot: string) => slot.startsWith(`task-review:${TASK}:`)
function mountLink(props: Partial<Parameters<typeof TaskReviewCaseLinker>[0]> = {}) { return render(<TaskReviewCaseLinker task={task()} review={review()} workspaceId="class-a" {...props} />) }
function mountPanel(props: Partial<Parameters<typeof CaseTaskReviewEvidencePanel>[0]> = {}) { return render(<CaseTaskReviewEvidencePanel caseId={CASE} workspaceId="class-a" caseRevision={1} caseLabel="Same visible name" {...props} />) }
async function chooseCase() { await waitFor(() => expect(screen.getByLabelText('Student case')).toBeEnabled()); fireEvent.change(screen.getByLabelText('Student case'), { target: { value: CASE } }); await screen.findByLabelText('Teacher observation for this case') }
function openPanel() { const details = screen.getByText('Formal task review evidence').closest('details')!; act(() => { details.open = true; fireEvent(details, new Event('toggle')) }) }
async function panelReady() { openPanel(); await screen.findByRole('table') }
async function restore() { fireEvent.click(await screen.findByRole('button', { name: 'Restore local draft' })) }

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(auth, { enabled: true, authenticated: true, isAdmin: true, userId: 'teacher-one', statusAvailable: true, loading: false })
  vi.mocked(cases.getStudentCase).mockReset().mockResolvedValue(studentCase())
  vi.mocked(cases.listStudentCases).mockReset().mockResolvedValue([{ ...studentCase(), report_count: 1 }])
  vi.mocked(api.getCaseTaskReviewEvidence).mockReset().mockResolvedValue(evidence())
  vi.mocked(teacherApi.getTeacherStudentTask).mockReset().mockResolvedValue(task())
  vi.mocked(reviewApi.getTaskReviewState).mockReset().mockResolvedValue({ task_id: TASK, submission_id: SUBMISSION, task_status: 'submitted', current_review: review() })
  vi.mocked(reviewApi.listTaskReviewRevisions).mockReset().mockResolvedValue([review()])
  vi.mocked(api.saveCaseTaskReviewEvidence).mockReset().mockImplementation(async (caseId, body) => { const saved = overlay({ case_id: caseId, revision: body.expected_revision + 1, case_revision: body.expected_case_revision, request_id: body.request_id, links: api.cloneCaseEvidenceLinks(body.links), recipient_user_id: body.links.length ? UID : null }); return evidence({ case_id: caseId, overlay: saved, acknowledged: saved }) })
})
afterEach(() => vi.unstubAllGlobals())

it('lists actual cases without inferring identity and appends a reviewed submission only after explicit confirmation', async () => {
  const other = link({ task_id: OTHER_TASK, submission_id: OTHER_SUBMISSION })
  vi.mocked(api.getCaseTaskReviewEvidence).mockResolvedValue(evidence({ overlay: overlay({ links: [other] }), source_states: [] }))
  mountLink()
  await waitFor(() => expect(screen.getByLabelText('Student case')).toBeEnabled())
  expect(screen.getByLabelText('Student case')).toHaveValue('')
  expect(screen.getByText(`Actual learner account ID: ${UID} · Teacher review version 2`)).toBeVisible()
  await chooseCase()
  expect(screen.getByRole('button', { name: 'Confirm and save case association' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Teacher observation for this case'), { target: { value: 'Use the original explanation as evidence.' } })
  fireEvent.click(screen.getByLabelText(/I have checked that this actual learner account/))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm and save case association' }))
  await screen.findByText(/server has confirmed this association change/)
  const body = vi.mocked(api.saveCaseTaskReviewEvidence).mock.calls[0][1]
  expect(body.links).toHaveLength(2); expect(body.links[0]).toEqual(other)
  expect(body.links[1]).toMatchObject({ task_id: TASK, submission_id: SUBMISSION, review_revision: 2, question_ids: ['F1'], teacher_observation: 'Use the original explanation as evidence.' })
  expect(Object.keys(body).sort()).toEqual(['request_id','expected_revision','expected_case_revision','identity_confirmed','links'].sort())
  expect(cases.saveStudentCase).not.toHaveBeenCalled()
})

it('blocks another learner binding and a missing exact source pin without clearing or changing case content', async () => {
  vi.mocked(api.getCaseTaskReviewEvidence).mockResolvedValueOnce(evidence({ overlay: overlay({ recipient_user_id: 'another-learner' }) }))
  const view = mountLink(); await chooseCase()
  expect(await screen.findByText(/bound to another learner account/)).toBeVisible()
  expect(screen.getByLabelText(/I have checked that this actual learner account/)).toBeDisabled()
  expect(api.saveCaseTaskReviewEvidence).not.toHaveBeenCalled()
  view.unmount()
  vi.mocked(cases.getStudentCase).mockResolvedValueOnce(studentCase({ report_refs: [{ report_id: REPORT, report_revision: 2 }] }))
  mountLink(); await chooseCase()
  expect(screen.getByText(/does not contain this exact source report version/)).toBeVisible()
  expect(screen.getByRole('link', { name: 'Open case and report links' })).toHaveAttribute('href', `/learning/teaching-analysis/students/${CASE}?dt_workspace=class-a`)
  expect(screen.getByRole('button', { name: 'Confirm and save case association' })).toBeDisabled()
  expect(cases.saveStudentCase).not.toHaveBeenCalled()
})

it('retains notes and the request UUID for an unchanged ambiguous retry; editing makes a new immutable body', async () => {
  vi.mocked(api.saveCaseTaskReviewEvidence).mockRejectedValueOnce(new Error('Connection lost')).mockRejectedValueOnce(new Error('Still unavailable'))
  mountLink(); await chooseCase()
  fireEvent.change(screen.getByLabelText('Next teaching action'), { target: { value: 'First action.' } }); fireEvent.click(screen.getByLabelText(/I have checked that this actual learner account/)); fireEvent.click(screen.getByRole('button', { name: 'Confirm and save case association' }))
  await screen.findByText(/association was not confirmed/)
  const first = vi.mocked(api.saveCaseTaskReviewEvidence).mock.calls[0][1]
  fireEvent.click(screen.getByRole('button', { name: 'Retry the same association request' }))
  await waitFor(() => expect(api.saveCaseTaskReviewEvidence).toHaveBeenCalledTimes(2))
  expect(vi.mocked(api.saveCaseTaskReviewEvidence).mock.calls[1][1]).toEqual(first)
  fireEvent.change(screen.getByLabelText('Next teaching action'), { target: { value: 'A revised action.' } }); fireEvent.click(screen.getByLabelText(/I have checked that this actual learner account/)); fireEvent.click(screen.getByRole('button', { name: 'Confirm and save case association' }))
  await screen.findByText(/server has confirmed this association change/)
  expect(vi.mocked(api.saveCaseTaskReviewEvidence).mock.calls[2][1].request_id).not.toBe(first.request_id)
  expect(first.links[0].next_teaching_action).toBe('First action.')
})

it('strictly validates recoverable bindings, blocks forged request UID fields, and canonicalizes receipts without sorting', () => {
  expect(isTaskReviewCaseDraft(pendingLink())).toBe(true)
  expect(isTaskReviewCaseDraft({ ...pendingLink(), version: 2 })).toBe(false)
  expect(isTaskReviewCaseDraft({ ...pendingLink(), target: { ...pendingLink().target, submission_id: OTHER_SUBMISSION } })).toBe(false)
  expect(isTaskReviewCaseDraft({ ...pendingLink(), mutation: { ...pendingLink().mutation, payload: { ...request(), recipient_user_id: UID } } })).toBe(false)
  expect(isTaskReviewCaseDraft({ ...pendingLink(), mutation: { payload: request({ links: [link({ question_ids: [] })] }), submitted_payload: null, acknowledged_request_id: null } })).toBe(true)
  expect(isTaskReviewCaseDraft({ ...pendingLink(), mutation: { payload: request({ links: [link({ question_ids: [] })] }), submitted_payload: request({ links: [link({ question_ids: [] })] }), acknowledged_request_id: null } })).toBe(false)
  expect(isCaseEvidencePanelDraft({ kind: 'case-review-evidence', version: 1, case_id: CASE, mutation: null, identity_checked: false })).toBe(true)
  const body = request({ request_id: REQUEST.toUpperCase() })
  expect(api.matchesCaseEvidenceReceipt(evidence({ overlay: overlay({ revision: 7, links: [] }), acknowledged: overlay({ request_id: REQUEST, revision: 2 }) }), CASE, body, UID)).toBe(true)
  expect(api.matchesCaseEvidenceReceipt(evidence({ acknowledged: overlay({ links: [link({ next_teaching_action: 'A different note.' })] }) }), CASE, body)).toBe(false)
  const cloned = api.cloneCaseEvidenceRequest(body); cloned.links[0].question_ids.push('F2'); expect(body.links[0].question_ids).toEqual(['F1'])
})

it('restores old-review draft context under a withdrawn current review, never posts automatically, and clears only its own slot', async () => {
  const pending = pendingLink({ target: { ...pendingLink().target, review_revision: 1 }, mutation: { payload: request({ links: [link({ review_revision: 1 })] }), submitted_payload: null, acknowledged_request_id: null } })
  const otherSlot = `task-review:${TASK}:main-review`
  const memory = memoryRepository([draftRow(linkSlot, pending), draftRow(otherSlot, { version: 1, text: 'A separate review draft' })])
  render(<StrictMode><TeachingDraftProvider {...scope} namespace={`task-review:${TASK}`} acceptsSlot={acceptsReview} repository={memory.repository}><TaskReviewCaseLinker task={task()} review={review({ revision: 3, status: 'withdrawn' })} workspaceId="class-a" disabled /></TeachingDraftProvider></StrictMode>)
  await restore(); await screen.findByLabelText('Next teaching action')
  expect(screen.getByLabelText('Next teaching action')).toHaveValue(pending.mutation!.payload.links[0].next_teaching_action)
  expect(screen.getByRole('button', { name: 'Confirm and save case association' })).toBeDisabled()
  expect(api.saveCaseTaskReviewEvidence).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Clear this association draft' }))
  await waitFor(() => expect(memory.get(linkSlot)).toBeUndefined())
  expect(memory.get(otherSlot)).toBeDefined()
})

it('acknowledges a committed association despite failed local cleanup and retries only cleanup', async () => {
  const memory = memoryRepository(); vi.mocked(memory.repository.clear).mockRejectedValueOnce(new Error('Disk unavailable'))
  render(<TeachingDraftProvider {...scope} namespace={`task-review:${TASK}`} acceptsSlot={acceptsReview} repository={memory.repository}><TaskReviewCaseLinker task={task()} review={review()} workspaceId="class-a" /></TeachingDraftProvider>)
  await chooseCase(); fireEvent.click(screen.getByLabelText(/I have checked that this actual learner account/)); fireEvent.click(screen.getByRole('button', { name: 'Confirm and save case association' }))
  await screen.findByText(/local draft could not be cleared/)
  expect(api.saveCaseTaskReviewEvidence).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Retry local cleanup' }))
  await waitFor(() => expect(screen.getByLabelText('Student case')).toHaveValue(''))
  expect(api.saveCaseTaskReviewEvidence).toHaveBeenCalledTimes(1)
})

it('keeps the case panel collapsed, then shows exact questions, used hint text and server focus counts as facts', async () => {
  mountPanel(); expect(api.getCaseTaskReviewEvidence).not.toHaveBeenCalled(); await panelReady()
  const table = screen.getByRole('table')
  expect(within(table).getAllByRole('cell').map(value => value.textContent)).toEqual(['1','1','0','0','0','0'])
  const details = screen.getByText('View task review and history', { selector: 'summary' }).closest('details')!; act(() => { details.open = true })
  expect(within(details).getByText('Compare the fractional units.')).toBeVisible()
  expect(within(details).getByText('I compared equal units.')).toBeVisible()
  expect(within(details).getByText('Explain the common unit.')).toBeVisible()
  expect(within(details).getByText('An opened hint.')).toBeVisible()
  expect(details.textContent).not.toContain('PRIVATE_')
  expect(within(details).queryByRole('textbox')).toBeNull()
  expect(document.body.textContent).not.toMatch(/\d+\s*%/)
})

it('allows confirmed deletion for an archived case with unavailable source and never deletes task or case content', async () => {
  const current = evidence({ case_archived: true, source_states: [source({ status: 'unavailable', questions: [] })], focus_cards: [] })
  vi.mocked(api.getCaseTaskReviewEvidence).mockResolvedValue(current)
  mountPanel(); openPanel(); await screen.findByText(/case is archived/)
  fireEvent.click(screen.getByLabelText('Remove this evidence reference from the case'))
  expect(screen.getByRole('button', { name: 'Confirm selected removals' })).toBeDisabled()
  fireEvent.click(screen.getByLabelText(/I confirm that only the selected evidence links/)); fireEvent.click(screen.getByRole('button', { name: 'Confirm selected removals' }))
  await screen.findByText(/server has confirmed this association change/)
  expect(vi.mocked(api.saveCaseTaskReviewEvidence).mock.calls[0][1].links).toEqual([])
  expect(cases.saveStudentCase).not.toHaveBeenCalled()
})

it('uses the acknowledged original receipt without rolling the panel back from a newer overlay head', async () => {
  const newerLink = link({ task_id: OTHER_TASK, submission_id: OTHER_SUBMISSION, teacher_observation: 'NEWEST_HEAD_REFERENCE' })
  mountPanel(); await panelReady(); fireEvent.click(screen.getByLabelText('Remove this evidence reference from the case')); fireEvent.click(screen.getByLabelText(/I confirm that only the selected evidence links/))
  vi.mocked(api.saveCaseTaskReviewEvidence).mockImplementationOnce(async (_caseId, body) => evidence({ overlay: overlay({ revision: 5, links: [newerLink] }), acknowledged: overlay({ request_id: body.request_id, revision: 2, links: [] }), source_states: [source({ task_id: OTHER_TASK, submission_id: OTHER_SUBMISSION })] }))
  vi.mocked(api.getCaseTaskReviewEvidence).mockResolvedValueOnce(evidence())
  fireEvent.click(screen.getByRole('button', { name: 'Confirm selected removals' }))
  await screen.findByText('NEWEST_HEAD_REFERENCE')
  await screen.findByText(/saved evidence could not be read/)
  expect(screen.getByText('NEWEST_HEAD_REFERENCE')).toBeVisible()
  expect(api.saveCaseTaskReviewEvidence).toHaveBeenCalledTimes(1)
})

it('refuses evidence from a changed case version and delegates reload through the parent guard', async () => {
  const onReloadCase = vi.fn(); vi.mocked(api.getCaseTaskReviewEvidence).mockResolvedValue(evidence({ case_revision: 2 }))
  mountPanel({ onReloadCase }); openPanel(); await screen.findByText(/draft uses another saved review/)
  expect(screen.queryByRole('table')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Reload student case' })); expect(onReloadCase).toHaveBeenCalledTimes(1)
})

it('checks explicit workspace transport and separates latest overlay from its request acknowledgement', async () => {
  const real = await vi.importActual<typeof api>('@/lib/teaching-case-review-api')
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(evidence({ acknowledged: overlay() })), { status: 200, headers: { 'Content-Type': 'application/json' } })); vi.stubGlobal('fetch', fetch)
  const controller = new AbortController(); await real.saveCaseTaskReviewEvidence(CASE, request(), 'class-a', controller.signal)
  expect(fetch).toHaveBeenCalledWith(`/api/teaching-analysis/student-cases/${CASE}/task-review-evidence?dt_workspace=class-a`, expect.objectContaining({ signal: controller.signal, method: 'POST', body: JSON.stringify(request()), credentials: 'include' }))
})

it('guards case-body reload against evidence drafts and preserves them on cancel before an explicit discard', async () => {
  const memory = memoryRepository([draftRow(`student-case:${OTHER_CASE}:editor`, { version: 1, text: 'Another case' }), draftRow('primary', { version: 1, assignment: exampleAssignment('en') })])
  const accepts = (slot: string) => slot.startsWith(`student-case:${CASE}:`)
  render(<TeachingDraftProvider {...scope} namespace={`student-case:${CASE}`} acceptsSlot={accepts} repository={memory.repository}><StudentCaseDetailPage caseId={CASE} /></TeachingDraftProvider>)
  await screen.findByRole('heading', { name: 'Same visible name' }); await panelReady(); fireEvent.click(screen.getByLabelText('Remove this evidence reference from the case'))
  await waitFor(() => expect(memory.get(panelSlot)).toBeDefined())
  const originalId = (memory.get(panelSlot)!.value as CaseEvidencePanelDraft).mutation!.payload.request_id
  fireEvent.change(screen.getByLabelText(String(i18n.t('teaching.cases.label'))), { target: { value: 'A local metadata change' } })
  expect(screen.getByRole('button', { name: String(i18n.t('teaching.cases.save')) })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved case context' })); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
  expect((memory.get(panelSlot)!.value as CaseEvidencePanelDraft).mutation!.payload.request_id).toBe(originalId)
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved case context' })); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: String(i18n.t('teaching.cases.replaceConfirm')) }))
  await waitFor(() => expect(memory.get(panelSlot)).toBeUndefined())
  expect(memory.get(`student-case:${OTHER_CASE}:editor`)).toBeDefined(); expect(memory.get('primary')).toBeDefined()
  expect(api.saveCaseTaskReviewEvidence).not.toHaveBeenCalled()
})

it('keeps the real review page and linker editable after the child becomes dirty, while protecting review changes', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  render(<TaskReviewPage taskId={TASK} />)
  await chooseCase()
  const notes = screen.getByLabelText('Teacher observation for this case')
  expect(notes).toBeEnabled()
  fireEvent.change(notes, { target: { value: 'A new case observation without self-lock.' } })
  expect(notes).toBeEnabled()
  expect(screen.getByRole('button', { name: String(i18n.t('teacherTaskReviews.edit')) })).toBeDisabled()
  const confirmation = screen.getByLabelText(/I have checked that this actual learner account/)
  expect(confirmation).toBeEnabled(); fireEvent.click(confirmation)
  expect(screen.getByRole('button', { name: 'Confirm and save case association' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Confirm and save case association' }))
  await screen.findByText(/server has confirmed this association change/)
  await waitFor(() => expect(screen.getByRole('button', { name: String(i18n.t('teacherTaskReviews.edit')) })).toBeEnabled())
  expect(api.saveCaseTaskReviewEvidence).toHaveBeenCalledTimes(1)
  expect(reviewApi.saveTaskReview).not.toHaveBeenCalled()
})

it('offers read-only evidence and setup guidance rather than forbidden writes when authentication is disabled', async () => {
  auth.enabled = false; auth.authenticated = false; auth.userId = ''
  const page = mountLink()
  expect(screen.getByLabelText('Student case')).toBeDisabled()
  expect(screen.queryByRole('button', { name: 'Confirm and save case association' })).toBeNull()
  expect(cases.listStudentCases).not.toHaveBeenCalled()
  page.unmount()
  mountPanel(); await panelReady()
  expect(screen.getByLabelText('Remove this evidence reference from the case')).toBeDisabled()
  expect(screen.queryByRole('button', { name: 'Confirm selected removals' })).toBeNull()
  expect(screen.getByRole('link', { name: String(i18n.t('caseTaskReviews.setup')) })).toHaveAttribute('href', expect.stringContaining('STUDENT_TASKS.md'))
  expect(api.saveCaseTaskReviewEvidence).not.toHaveBeenCalled()
})

it('stops a never-ending save without losing its UUID and ignores an old response while the retry is pending', async () => {
  let finishOld!: (value: api.CaseReviewEvidenceView) => void
  let finishNew!: (value: api.CaseReviewEvidenceView) => void
  vi.mocked(api.saveCaseTaskReviewEvidence).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve })).mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve }))
  mountLink(); await chooseCase(); fireEvent.click(screen.getByLabelText(/I have checked that this actual learner account/)); fireEvent.click(screen.getByRole('button', { name: 'Confirm and save case association' }))
  const first = vi.mocked(api.saveCaseTaskReviewEvidence).mock.calls[0][1]
  const signal = vi.mocked(api.saveCaseTaskReviewEvidence).mock.calls[0][3]!
  fireEvent.click(screen.getByRole('button', { name: String(i18n.t('caseTaskReviews.stopRequest')) }))
  expect(signal.aborted).toBe(true)
  expect(screen.getByRole('button', { name: 'Clear this association draft' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Retry the same association request' }))
  expect(vi.mocked(api.saveCaseTaskReviewEvidence).mock.calls[1][1]).toEqual(first)
  const receipt = overlay({ request_id: first.request_id, revision: 2, links: first.links })
  await act(async () => finishOld(evidence({ overlay: receipt, acknowledged: receipt })))
  expect(screen.getByRole('button', { name: 'Retry the same association request' })).toBeDisabled()
  expect(screen.queryByText(/server has confirmed this association change/)).toBeNull()
  await act(async () => finishNew(evidence({ overlay: receipt, acknowledged: receipt })))
  await screen.findByText(/server has confirmed this association change/)
  expect(new Set(vi.mocked(api.saveCaseTaskReviewEvidence).mock.calls.map(call => call[1].request_id)).size).toBe(1)
})

it('aborts a save on workspace changes and never adopts the late acknowledgement under the new scope', async () => {
  let finish!: (value: api.CaseReviewEvidenceView) => void
  vi.mocked(api.saveCaseTaskReviewEvidence).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const page = mountLink(); await chooseCase(); fireEvent.click(screen.getByLabelText(/I have checked that this actual learner account/)); fireEvent.click(screen.getByRole('button', { name: 'Confirm and save case association' }))
  const body = vi.mocked(api.saveCaseTaskReviewEvidence).mock.calls[0][1]
  const signal = vi.mocked(api.saveCaseTaskReviewEvidence).mock.calls[0][3]!
  page.rerender(<TaskReviewCaseLinker task={task()} review={review()} workspaceId="class-b" />)
  expect(signal.aborted).toBe(true)
  const receipt = overlay({ request_id: body.request_id, revision: 2, links: body.links })
  await act(async () => finish(evidence({ overlay: receipt, acknowledged: receipt })))
  expect(screen.queryByText(/server has confirmed this association change/)).toBeNull()
  expect(screen.getByLabelText('Student case')).toHaveValue('')
})

it('marks noncurrent references excluded without merging their results or replacing their pinned review versions', async () => {
  const statuses: api.CaseReviewEvidenceSourceState['status'][] = ['current','stale','withdrawn','task_revoked','unavailable','report_unlinked']
  const refs = statuses.map((_, index) => link({ task_id: crypto.randomUUID(), submission_id: crypto.randomUUID(), teacher_observation: `Observation ${index}` }))
  const states = refs.map((ref, index) => source({ ...ref, status: statuses[index], latest_review_revision: index ? 3 : 2, questions: index === 4 ? [] : [{ ...source().questions[0], result: 'correct' }] }))
  vi.mocked(api.getCaseTaskReviewEvidence).mockResolvedValue(evidence({ overlay: overlay({ links: refs }), source_states: states, focus_cards: [{ subject: 'Mathematics', knowledge_point: 'Equal units', question_count: 1, needs_teaching: 0, needs_independent_check: 1, ungraded: 0, independent_correct: 0, requested_help: 1 }] }))
  mountPanel(); await panelReady()
  expect(within(screen.getByRole('table')).getAllByRole('cell').map(value => value.textContent)).toEqual(['1','0','1','0','0','1'])
  for (const status of statuses) expect(screen.getByText(String(i18n.t(`caseTaskReviews.source.${status}`)))).toBeVisible()
  expect(screen.getAllByText(/excluded from current concern counts/)).toHaveLength(5)
  expect(screen.getAllByText('Pinned review 2 · Latest review 3')).toHaveLength(5)
  expect(reviewApi.getTaskReviewState).not.toHaveBeenCalled()
  expect(api.saveCaseTaskReviewEvidence).not.toHaveBeenCalled()
})
