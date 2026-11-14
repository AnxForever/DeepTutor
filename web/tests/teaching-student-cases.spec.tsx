import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import StudentCaseListPage from '@/components/learning/teaching-analysis/StudentCaseListPage'
import StudentCaseDetailPage from '@/components/learning/teaching-analysis/StudentCaseDetailPage'
import { initI18n } from '@/i18n/init'
import { ApiError } from '@/shared/api/errors'
import * as api from '@/lib/teaching-student-cases-api'
import * as reports from '@/lib/teaching-analysis-api'

const current = vi.hoisted(() => ({ workspace: 'class-a', admin: true, accountId: 'teacher-a' as string | null, clear: vi.fn() }))
vi.mock('next/navigation', () => ({ usePathname: () => '/learning/teaching-analysis/students' }))
// Browser QA exercises Next navigation. These component tests do not need its
// background IntersectionObserver/idle prefetch state for 101 independent links.
vi.mock('next/link', () => ({ default: ({ href, prefetch, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean }) => { void prefetch; return <a href={href} {...props} /> } }))
vi.mock('@/hooks/useActiveWorkspaceId', () => ({ useActiveWorkspaceId: () => current.workspace }))
vi.mock('@/hooks/useAuthStatus', () => ({ useAuthStatus: () => ({ loading: false, enabled: true, statusAvailable: true, isAdmin: current.admin, userId: current.accountId }) }))
vi.mock('@/components/learning/teaching-analysis/TeachingDrafts', () => ({
  TeachingDraftProvider: ({ children }: { children: React.ReactNode }) => children,
  acceptsStudentCaseCreateSlot: (slot: string) => slot === 'student-case-create',
  useTeachingDraftSlot: () => ({ clear: current.clear }),
  useTeachingDraftControls: () => ({ clearAll: current.clear, clearSlot: current.clear }),
}))
vi.mock('@/components/learning/teaching-analysis/StudentEvidenceTimeline', () => ({ StudentEvidenceTimeline: ({ refreshKey, onReloadCase }: { refreshKey: number; onReloadCase?: () => void }) => <section aria-label="Evidence timeline" data-revision={refreshKey}><button onClick={onReloadCase}>Reload case from timeline</button></section> }))
vi.mock('@/lib/teaching-student-cases-api', async original => ({ ...(await original<typeof api>()), listStudentCases: vi.fn(), getStudentCase: vi.fn(), saveStudentCase: vi.fn(), getStudentCaseRevisions: vi.fn(), getTeachingReportRevision: vi.fn() }))
vi.mock('@/lib/teaching-analysis-api', async original => ({ ...(await original<typeof reports>()), listTeachingReports: vi.fn(), getTeachingReportRevisions: vi.fn() }))
initI18n('en')
const CASE_A = '11111111-1111-4111-8111-111111111111'
const CASE_B = '22222222-2222-4222-8222-222222222222'
const REPORT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const saved = (changes: Partial<api.SavedStudentCase> = {}): api.SavedStudentCase => ({ case_id: CASE_A, revision: 1, label: 'Student A', subject: null, archived: false, report_refs: [], created_at: 1, updated_at: 1, ...changes })
const summary = (value = saved()): api.StudentCaseSummary => ({ case_id: value.case_id, revision: value.revision, label: value.label, subject: value.subject, archived: value.archived, report_count: value.report_refs.length, created_at: value.created_at, updated_at: value.updated_at })
const report = (changes: Partial<reports.TeachingReportSummary> = {}): reports.TeachingReportSummary => ({ report_id: REPORT_A, revision: 1, status: 'confirmed', student_ref: 'Historical student code', assignment_ref: 'English worksheet', subject: 'English', updated_at: 1, ...changes })
beforeEach(() => {
  vi.clearAllMocks(); current.admin = true; current.accountId = 'teacher-a'; current.workspace = 'class-a'
  current.clear.mockResolvedValue(undefined)
  vi.mocked(api.listStudentCases).mockResolvedValue([])
  vi.mocked(api.getStudentCase).mockResolvedValue(saved())
  vi.mocked(api.saveStudentCase).mockImplementation(async request => saved({ ...request, revision: request.expected_revision + 1 }))
  vi.mocked(api.getStudentCaseRevisions).mockResolvedValue([saved()])
  vi.mocked(reports.listTeachingReports).mockResolvedValue([report()])
})
afterEach(async () => {
  // jsdom queues native <details> toggle events as macrotasks, including a
  // controlled close after a successful save. Settle them before global cleanup.
  await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)) })
})

it('requires a verified admin account before reading cases or mounting a draft editor', () => {
  current.admin = false
  const view = render(<StudentCaseListPage />)
  expect(screen.getByText(/available to administrators/)).toBeVisible()
  expect(api.listStudentCases).not.toHaveBeenCalled()
  current.admin = true; current.accountId = null
  view.rerender(<StudentCaseListPage />)
  expect(screen.getByText(/Access could not be verified/)).toBeVisible()
  expect(api.listStudentCases).not.toHaveBeenCalled()
})

it('keeps same-name cases distinct and loads student 101 instead of silently capping the list', async () => {
  const all = Array.from({ length: 101 }, (_, index) => summary(saved({ case_id: `${(index + 1).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`, label: 'Same student code' })))
  vi.mocked(api.listStudentCases).mockImplementation(async query => all.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 50)))
  const { container } = render(<StudentCaseListPage />)
  const caseLinks = () => Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href^="/learning/teaching-analysis/students/"]'))
  await waitFor(() => expect(caseLinks()).toHaveLength(50), { timeout: 5000 })
  fireEvent.click(screen.getByRole('button', { name: 'Load more cases' }))
  await waitFor(() => expect(caseLinks()).toHaveLength(100), { timeout: 5000 })
  fireEvent.click(screen.getByRole('button', { name: 'Load more cases' }))
  await waitFor(() => expect(caseLinks()).toHaveLength(101), { timeout: 5000 })
  expect(new Set(caseLinks().map(link => link.getAttribute('href'))).size).toBe(101)
  expect(screen.getAllByText('Same student code')).toHaveLength(101)
  expect(api.listStudentCases).toHaveBeenLastCalledWith({ archived: false, limit: 50, offset: 100 }, 'class-a', expect.any(AbortSignal))
}, 15000)

it('preserves a new-case draft while changing the archive filter and retries creation with the same UUID', async () => {
  vi.mocked(api.saveStudentCase).mockRejectedValueOnce(new Error('Network interrupted'))
  render(<StudentCaseListPage />)
  const form = screen.getByText('New student case', { selector: 'summary' }).closest('details')!
  await act(async () => { form.open = true; fireEvent(form, new Event('toggle')) })
  fireEvent.change(screen.getByLabelText('Student code'), { target: { value: 'Student A' } })
  fireEvent.click(screen.getByRole('button', { name: 'Archived cases' }))
  await waitFor(() => expect(api.listStudentCases).toHaveBeenLastCalledWith(expect.objectContaining({ archived: true, offset: 0 }), 'class-a', expect.any(AbortSignal)))
  expect(screen.getByLabelText('Student code')).toHaveValue('Student A')
  fireEvent.click(screen.getByRole('button', { name: 'Create case' }))
  await screen.findByText(/case could not be saved/)
  fireEvent.click(screen.getByRole('button', { name: 'Create case' }))
  await screen.findByText(/Case revision 1 saved/)
  const calls = vi.mocked(api.saveStudentCase).mock.calls
  expect(calls[0][0]).toEqual(calls[1][0])
  expect(calls[1][0]).toMatchObject({ expected_revision: 0, label: 'Student A', subject: null, report_refs: [] })
})

it('acknowledges server creation even if local cleanup fails and retries only the local cleanup', async () => {
  current.clear.mockRejectedValueOnce(new Error('IDB blocked')).mockResolvedValue(undefined)
  render(<StudentCaseListPage />)
  const form = screen.getByText('New student case', { selector: 'summary' }).closest('details')!
  await act(async () => { form.open = true; fireEvent(form, new Event('toggle')) })
  fireEvent.change(screen.getByLabelText('Student code'), { target: { value: 'Created student' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create case' }))
  await screen.findByText(/case was saved, but its local draft could not be cleared/)
  expect(screen.getByLabelText('Student code')).toBeDisabled()
  expect(screen.getByRole('link', { name: 'Open saved case in a new tab' })).toHaveAttribute('target', '_blank')
  expect(api.saveStudentCase).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Retry local draft cleanup' }))
  await waitFor(() => expect(screen.getByLabelText('Student code')).toHaveValue(''))
  expect(api.saveStudentCase).toHaveBeenCalledOnce()
  expect(current.clear).toHaveBeenCalledTimes(2)
  expect(vi.mocked(api.listStudentCases).mock.calls.length).toBeGreaterThan(1)
})

it('does not auto-match report names and keeps unsaved pins out of the timeline until save', async () => {
  render(<StudentCaseDetailPage caseId={CASE_A} />)
  const select = await screen.findByRole('button', { name: /Select Historical student code · English worksheet · English · Revision 1/ })
  expect(api.saveStudentCase).not.toHaveBeenCalled()
  fireEvent.click(select)
  expect(screen.getByRole('region', { name: 'Evidence timeline' })).toHaveAttribute('data-revision', '1')
  fireEvent.click(screen.getByRole('button', { name: 'Save case and report links' }))
  await screen.findByText(/Case revision 2 saved/)
  expect(api.saveStudentCase).toHaveBeenCalledWith(expect.objectContaining({ case_id: CASE_A, expected_revision: 1, report_refs: [{ report_id: REPORT_A, report_revision: 1 }] }), 'class-a', expect.any(AbortSignal))
  expect(screen.getByRole('region', { name: 'Evidence timeline' })).toHaveAttribute('data-revision', '2')
})

it('keeps an old pin until an explicit version change is confirmed', async () => {
  vi.mocked(api.getStudentCase).mockResolvedValue(saved({ report_refs: [{ report_id: REPORT_A, report_revision: 1 }] }))
  vi.mocked(reports.listTeachingReports).mockResolvedValue([report({ revision: 2 })])
  render(<StudentCaseDetailPage caseId={CASE_A} />)
  fireEvent.click(await screen.findByRole('button', { name: /Select Historical student code .* Revision 2/ }))
  const dialog = screen.getByRole('dialog', { name: 'Change the pinned report version?' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(screen.getByRole('button', { name: 'Save case and report links' })).toBeDisabled()
  expect(api.saveStudentCase).not.toHaveBeenCalled()
})

it('lets the teacher fix a report-source conflict without discarding metadata edits or reloading the case', async () => {
  vi.mocked(api.saveStudentCase).mockRejectedValueOnce(new ApiError({ code: 'teaching_case_source_changed', message: 'Source changed', status: 409, retryable: false, scope: 'network' }))
  render(<StudentCaseDetailPage caseId={CASE_A} />)
  const select = await screen.findByRole('button', { name: /Select Historical student code/ })
  fireEvent.change(screen.getByLabelText('Student code'), { target: { value: 'Renamed student' } })
  fireEvent.click(select)
  fireEvent.click(screen.getByRole('button', { name: 'Save case and report links' }))
  await screen.findByText(/selected report version is no longer linkable/)
  expect(screen.getByLabelText('Student code')).toHaveValue('Renamed student')
  expect(screen.queryByRole('button', { name: 'Reload saved case' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Remove link · aaaaaaaa' }))
  expect(screen.getByRole('button', { name: 'Save case and report links' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Save case and report links' }))
  await screen.findByText(/Case revision 2 saved/)
  expect(api.getStudentCase).toHaveBeenCalledOnce()
  expect(vi.mocked(api.saveStudentCase).mock.calls[1][0]).toMatchObject({ label: 'Renamed student', expected_revision: 1, report_refs: [] })
})

it('preserves editor contents on case CAS conflicts and requires confirmation to reload from the timeline', async () => {
  vi.mocked(api.saveStudentCase).mockRejectedValueOnce(new ApiError({ code: 'teaching_case_changed', message: 'Case changed', status: 409, retryable: false, scope: 'network' }))
  render(<StudentCaseDetailPage caseId={CASE_A} />)
  await screen.findByRole('region', { name: 'Evidence timeline' })
  fireEvent.change(screen.getByLabelText('Student code'), { target: { value: 'Keep local label' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save case and report links' }))
  await screen.findByText(/newer case revision exists/)
  expect(screen.getByLabelText('Student code')).toHaveValue('Keep local label')
  expect(screen.getByRole('button', { name: 'Save case and report links' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Reload case from timeline' }))
  const dialog = screen.getByRole('dialog', { name: 'Replace unsaved case changes?' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(screen.getByLabelText('Student code')).toHaveValue('Keep local label')
  expect(api.getStudentCase).toHaveBeenCalledOnce()
})

it('archives explicitly with pending edits, exposes read-only history and restores before further editing', async () => {
  render(<StudentCaseDetailPage caseId={CASE_A} />)
  await screen.findByRole('region', { name: 'Evidence timeline' })
  fireEvent.change(screen.getByLabelText('Student code'), { target: { value: 'Reviewed student' } })
  fireEvent.click(screen.getByRole('button', { name: 'Archive case' }))
  expect(api.saveStudentCase).not.toHaveBeenCalled()
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Archive this case?' })).getByRole('button', { name: 'Save changes and archive' }))
  await screen.findByText(/Case revision 2 saved/)
  expect(screen.getByLabelText('Student code')).toBeDisabled()
  expect(vi.mocked(api.saveStudentCase).mock.calls[0][0]).toMatchObject({ label: 'Reviewed student', archived: true, expected_revision: 1 })
  const history = screen.getByText('Case revision history', { selector: 'summary' }).closest('details')!
  await act(async () => { history.open = true; fireEvent(history, new Event('toggle')) })
  await screen.findByText('Report links saved with this revision')
  expect(api.getStudentCaseRevisions).toHaveBeenCalledWith(CASE_A, 'class-a', expect.any(AbortSignal))
  fireEvent.click(screen.getByRole('button', { name: 'Restore case to active list' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Restore this case?' })).getByRole('button', { name: 'Save changes and restore' }))
  await screen.findByText(/Case revision 3 saved/)
  expect(screen.getByLabelText('Student code')).toBeEnabled()
})

it('shows archive failure outside the closed dialog and never folds its rejected status into a later normal save', async () => {
  vi.mocked(api.saveStudentCase).mockRejectedValueOnce(new Error('Network interrupted'))
  render(<StudentCaseDetailPage caseId={CASE_A} />)
  await screen.findByRole('region', { name: 'Evidence timeline' })
  fireEvent.change(screen.getByLabelText('Student code'), { target: { value: 'Pending label' } })
  fireEvent.click(screen.getByRole('button', { name: 'Archive case' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Archive this case?' })).getByRole('button', { name: 'Save changes and archive' }))
  expect(await screen.findByText('The case could not be saved. Your changes are still here.')).toBeVisible()
  expect(screen.queryByRole('dialog', { name: 'Archive this case?' })).toBeNull()
  expect(screen.getByLabelText('Student code')).toHaveValue('Pending label')
  fireEvent.click(screen.getByRole('button', { name: 'Save case and report links' }))
  await screen.findByText(/Case revision 2 saved/)
  expect(vi.mocked(api.saveStudentCase).mock.calls[1][0]).toMatchObject({ archived: false, label: 'Pending label', expected_revision: 1 })
})

it('aborts a previous case read and never writes its response into another case editor', async () => {
  let finish!: (value: api.SavedStudentCase) => void
  vi.mocked(api.getStudentCase).mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue(saved({ case_id: CASE_B, label: 'Student B' }))
  const view = render(<StudentCaseDetailPage caseId={CASE_A} />)
  await waitFor(() => expect(api.getStudentCase).toHaveBeenCalledOnce())
  const oldSignal = vi.mocked(api.getStudentCase).mock.calls[0][2]!
  view.rerender(<StudentCaseDetailPage caseId={CASE_B} />)
  await screen.findByDisplayValue('Student B')
  expect(oldSignal.aborted).toBe(true)
  await act(async () => finish(saved()))
  expect(screen.getByLabelText('Student code')).toHaveValue('Student B')
  expect(api.getStudentCase).toHaveBeenLastCalledWith(CASE_B, 'class-a', expect.any(AbortSignal))
})
