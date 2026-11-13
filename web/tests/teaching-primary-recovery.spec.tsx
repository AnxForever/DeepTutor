import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import TeachingAnalysisPage from '@/components/learning/teaching-analysis/TeachingAnalysisPage'
import { exampleAssignment } from '@/components/learning/teaching-analysis/sample'
import { createTeachingDraftRepository, teachingDraftRepository, type TeachingDraftRepository } from '@/lib/teaching-drafts'
import { isPrimaryTeachingDraft, type PrimaryTeachingDraft } from '@/lib/teaching-draft-validation'
import { initI18n } from '@/i18n/init'
import { ApiError } from '@/shared/api/errors'
import * as api from '@/lib/teaching-analysis-api'

const route = vi.hoisted(() => ({ push: vi.fn(), account: 'teacher-a' as string | null, workspace: 'class-a', verified: true }))
const localStore = vi.hoisted(() => ({ current: null as TeachingDraftRepository | null }))
vi.mock('@/lib/teaching-drafts', async original => {
  const actual = await original<typeof import('@/lib/teaching-drafts')>()
  return { ...actual, teachingDraftRepository: {
    read: (...args: Parameters<TeachingDraftRepository['read']>) => localStore.current!.read(...args),
    write: (...args: Parameters<TeachingDraftRepository['write']>) => localStore.current!.write(...args),
    clear: (...args: Parameters<TeachingDraftRepository['clear']>) => localStore.current!.clear(...args),
  } }
})
vi.mock('next/navigation', () => ({ usePathname: () => '/learning/teaching-analysis', useRouter: () => ({ push: route.push }) }))
vi.mock('@/hooks/useAuthStatus', () => ({ useAuthStatus: () => ({ loading: false, enabled: true, isAdmin: true, statusAvailable: route.verified, userId: route.account }) }))
vi.mock('@/hooks/useActiveWorkspaceId', () => ({ useActiveWorkspaceId: () => route.workspace }))
vi.mock('@/components/learning/teaching-analysis/PracticeFollowups', () => ({ PracticeFollowups: ({ canCreate, onDirtyChange }: { canCreate: boolean; onDirtyChange?: (dirty: boolean) => void }) => <div data-testid="verified-practice-context" data-can-create={canCreate}><button onClick={() => onDirtyChange?.(true)}>Child pending edit</button></div> }))
vi.mock('@/lib/teaching-analysis-api', async original => ({ ...(await original<typeof api>()), listTeachingReports: vi.fn(), analyzeTeachingAssignment: vi.fn(), saveTeachingReport: vi.fn(), getTeachingReport: vi.fn() }))
vi.mock('@/lib/teaching-rubrics-api', () => ({ listTeachingRubrics: async () => [], rubricSnapshot: (value: unknown) => value }))
initI18n('en')
const scope = { accountId: 'teacher-a', workspaceId: 'class-a' }
const assignment = () => exampleAssignment('en')
const report = (): api.ReportContent => ({ summary: 'A local reviewed summary.', items: assignment().items.map(item => ({ question_id: item.question_id, result: 'ungraded', observation: 'Needs checking.', evidence: [] })), priorities: [], limitations: ['Only this material.'] })
const saved = (): api.SavedTeachingReport => ({ report_id: '072ca306-40ea-4bd0-aae2-e686a28e9501', revision: 1, status: 'confirmed', assignment: assignment(), analysis: report(), source_fingerprint: 'a'.repeat(64), teacher_notes: 'Teacher note', created_at: 1, updated_at: 1 })
const snapshot = (): PrimaryTeachingDraft => ({ kind: 'teaching-primary', version: 1, assignment: assignment(), analysis: report(), fingerprint: 'a'.repeat(64), reportId: saved().report_id, saved: saved(), baseRevision: 1, teacherNotes: 'Unsent note', pasted: '', editing: false })
async function ready() { await waitFor(() => expect(document.querySelector('[inert]')).toBeNull()) }
beforeEach(async () => {
  if (localStore.current) await localStore.current.read(scope).catch(() => {})
  vi.clearAllMocks(); vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  localStore.current = createTeachingDraftRepository()
  route.account = 'teacher-a'; route.workspace = 'class-a'; route.verified = true
  vi.mocked(api.listTeachingReports).mockResolvedValue([])
  vi.mocked(api.getTeachingReport).mockResolvedValue(saved())
  vi.mocked(api.analyzeTeachingAssignment).mockRejectedValue(new ApiError({ code: 'teaching_model_not_configured', message: 'Missing model', status: 503, retryable: false, scope: 'network' }))
  vi.mocked(api.saveTeachingReport).mockImplementation(async request => ({ ...saved(), ...request, revision: request.expected_revision + 1 }))
})

it('preserves prepared material across the real missing-model settings navigation without another model call', async () => {
  const view = render(<TeachingAnalysisPage />)
  await ready()
  fireEvent.click(screen.getByRole('button', { name: 'Try a synthetic example' }))
  await screen.findByDisplayValue('example-student-A')
  fireEvent.click(screen.getByRole('button', { name: 'Material checked · Generate suggestions' }))
  fireEvent.click(await screen.findByRole('link', { name: 'Configure a chat model' }))
  await waitFor(() => expect(route.push).toHaveBeenCalledWith('/settings/llm?dt_workspace=class-a'))
  const records = await teachingDraftRepository.read(scope)
  expect(isPrimaryTeachingDraft(records.find(record => record.slot === 'primary')?.value)).toBe(true)
  view.unmount()
  render(<TeachingAnalysisPage />)
  await screen.findByText('A local teaching draft is available')
  expect(screen.getByLabelText('Student label')).toHaveValue('')
  fireEvent.click(screen.getByRole('button', { name: 'Restore local draft' }))
  expect(screen.getByLabelText('Student label')).toHaveValue('example-student-A')
  expect(screen.getByLabelText('Item 1 · Student answer')).toHaveValue('3/5')
  expect(api.analyzeTeachingAssignment).toHaveBeenCalledTimes(1)
  expect(api.saveTeachingReport).not.toHaveBeenCalled()
})

it('restores local edits as a draft and preserves a stale CAS base when the server has a newer revision', async () => {
  await teachingDraftRepository.write(scope, 'primary', snapshot())
  vi.mocked(api.listTeachingReports).mockResolvedValue([{ report_id: saved().report_id, revision: 2, status: 'confirmed', student_ref: 'Student A', assignment_ref: 'Work', subject: 'Math', updated_at: 2 }])
  vi.mocked(api.getTeachingReport).mockResolvedValue({ ...saved(), revision: 2 })
  render(<TeachingAnalysisPage />)
  await screen.findByText('A local teaching draft is available')
  fireEvent.click(screen.getByRole('button', { name: 'Restore local draft' }))
  await screen.findByText(/A newer version was saved elsewhere/)
  expect(screen.getByLabelText('Teacher notes')).toHaveValue('Unsent note')
  expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled()
  expect(screen.getByText('Draft · needs review')).toBeInTheDocument()
  const restored = (await teachingDraftRepository.read(scope))[0].value as PrimaryTeachingDraft
  expect(restored.fingerprint).toBe('a'.repeat(64))
  expect(restored.baseRevision).toBe(1)
  expect(api.analyzeTeachingAssignment).not.toHaveBeenCalled()
  expect(api.saveTeachingReport).not.toHaveBeenCalled()
})

it('never reads another account draft or reads storage before identity is verified', async () => {
  await teachingDraftRepository.write(scope, 'primary', snapshot())
  route.verified = false
  const view = render(<TeachingAnalysisPage />)
  expect(screen.queryByText('A local teaching draft is available')).toBeNull()
  route.verified = true; route.account = 'teacher-b'
  view.rerender(<TeachingAnalysisPage />)
  await ready()
  expect(screen.queryByText('A local teaching draft is available')).toBeNull()
  expect(screen.getByLabelText('Student label')).toHaveValue('')
  expect((await teachingDraftRepository.read(scope))).toHaveLength(1)
})

it('rejects malformed report structures without deleting the original local record', async () => {
  const invalid = { ...snapshot(), analysis: { summary: 'Missing fields' } }
  await teachingDraftRepository.write(scope, 'primary', invalid)
  render(<TeachingAnalysisPage />)
  await screen.findByText('A local teaching draft is available')
  fireEvent.click(screen.getByRole('button', { name: 'Restore local draft' }))
  await screen.findByText(/unknown version or unsupported structure/)
  expect((await teachingDraftRepository.read(scope))[0].value).toEqual(invalid)
  expect(api.analyzeTeachingAssignment).not.toHaveBeenCalled()
})

it('clears the saved primary slot without deleting an unfinished marking-standard editor', async () => {
  vi.mocked(api.analyzeTeachingAssignment).mockResolvedValue({ analysis: report(), source_fingerprint: 'a'.repeat(64) })
  render(<TeachingAnalysisPage />)
  await ready()
  fireEvent.click(screen.getByRole('button', { name: 'Try a synthetic example' }))
  await screen.findByDisplayValue('example-student-A')
  fireEvent.click(screen.getByRole('button', { name: 'Material checked · Generate suggestions' }))
  await screen.findByRole('heading', { name: 'Teaching report' })
  const library = document.getElementById('teaching-rubric-library') as HTMLDetailsElement
  await act(async () => { library.open = true; fireEvent(library, new Event('toggle')) })
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Saved marking standards' })).toBeEnabled())
  fireEvent.change(screen.getByLabelText('Marking guidance'), { target: { value: 'Unfinished standard to keep.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
  await screen.findByText('Draft saved in this workspace.')
  await waitFor(async () => {
    const records = await teachingDraftRepository.read(scope)
    expect(records.some(record => record.slot === 'primary')).toBe(false)
    expect(records.find(record => record.slot === 'rubric-editor')?.value).toMatchObject({ editor: { criteria: 'Unfinished standard to keep.' } })
  })
})

it('does not fall back to local-admin drafts when an authenticated status has no account ID', async () => {
  await teachingDraftRepository.write({ ...scope, accountId: 'local-admin' }, 'primary', snapshot())
  const read = vi.spyOn(teachingDraftRepository, 'read')
  route.account = null
  render(<TeachingAnalysisPage />)
  expect(screen.getByText(/Access could not be verified/)).toBeVisible()
  expect(read).not.toHaveBeenCalled()
  expect(api.listTeachingReports).not.toHaveBeenCalled()
})

it('offers retry after restored source verification fails and keeps all local fields', async () => {
  await teachingDraftRepository.write(scope, 'primary', { ...snapshot(), primaryDirty: false, teacherNotes: saved().teacher_notes })
  vi.mocked(api.getTeachingReport).mockRejectedValueOnce(new TypeError('Connection interrupted')).mockResolvedValue(saved())
  render(<StrictMode><TeachingAnalysisPage /></StrictMode>)
  await screen.findByText('A local teaching draft is available')
  fireEvent.click(screen.getByRole('button', { name: 'Restore local draft' }))
  await screen.findByText(/last saved source report could not be verified/)
  const retry = screen.getByRole('button', { name: 'Retry source report verification' })
  expect(screen.getByTestId('verified-practice-context')).toHaveAttribute('data-can-create', 'false')
  expect(screen.getByLabelText('Teacher notes')).toHaveValue('Teacher note')
  fireEvent.click(retry)
  await waitFor(() => expect(screen.getByTestId('verified-practice-context')).toHaveAttribute('data-can-create', 'true'))
  expect(screen.getByLabelText('Item 1 · Student answer')).toHaveValue('3/5')
  expect(api.getTeachingReport).toHaveBeenCalledTimes(2)
  expect(api.analyzeTeachingAssignment).not.toHaveBeenCalled()
  expect(api.saveTeachingReport).not.toHaveBeenCalled()
})

it('treats reordered cached JSON keys as the same verified source', async () => {
  const reordered = Object.fromEntries(Object.entries(assignment()).reverse()) as api.AssignmentInput
  await teachingDraftRepository.write(scope, 'primary', { ...snapshot(), assignment: reordered, saved: { ...saved(), assignment: reordered }, primaryDirty: false, teacherNotes: saved().teacher_notes })
  render(<TeachingAnalysisPage />)
  await screen.findByText('A local teaching draft is available')
  fireEvent.click(screen.getByRole('button', { name: 'Restore local draft' }))
  await waitFor(() => expect(screen.getByTestId('verified-practice-context')).toHaveAttribute('data-can-create', 'true'))
  expect(screen.getByText('Teacher confirmed')).toBeInTheDocument()
  expect(api.analyzeTeachingAssignment).not.toHaveBeenCalled()
})

it('does not abort parent source verification when a restored child reports pending edits', async () => {
  let complete!: (report: api.SavedTeachingReport) => void
  await teachingDraftRepository.write(scope, 'primary', { ...snapshot(), primaryDirty: false, teacherNotes: saved().teacher_notes })
  vi.mocked(api.getTeachingReport).mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  render(<StrictMode><TeachingAnalysisPage /></StrictMode>)
  await screen.findByText('A local teaching draft is available')
  fireEvent.click(screen.getByRole('button', { name: 'Restore local draft' }))
  await waitFor(() => expect(api.getTeachingReport).toHaveBeenCalledOnce())
  const signal = vi.mocked(api.getTeachingReport).mock.calls[0][2]!
  fireEvent.click(screen.getByRole('button', { name: 'Child pending edit' }))
  expect(signal.aborted).toBe(false)
  expect(api.getTeachingReport).toHaveBeenCalledOnce()
  await act(async () => complete(saved()))
  await waitFor(() => expect(screen.getByTestId('verified-practice-context')).toHaveAttribute('data-can-create', 'true'))
  expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled()
})

it('can restart a stalled parent verification without replacing restored material', async () => {
  await teachingDraftRepository.write(scope, 'primary', { ...snapshot(), primaryDirty: false, teacherNotes: saved().teacher_notes })
  vi.mocked(api.getTeachingReport).mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(saved())
  render(<StrictMode><TeachingAnalysisPage /></StrictMode>)
  await screen.findByText('A local teaching draft is available')
  fireEvent.click(screen.getByRole('button', { name: 'Restore local draft' }))
  await waitFor(() => expect(api.getTeachingReport).toHaveBeenCalledOnce())
  const oldRequest = vi.mocked(api.getTeachingReport).mock.calls[0][2]!
  fireEvent.click(screen.getByRole('button', { name: 'Retry source report verification' }))
  await waitFor(() => expect(screen.getByTestId('verified-practice-context')).toHaveAttribute('data-can-create', 'true'))
  expect(oldRequest.aborted).toBe(true)
  expect(screen.getByLabelText('Teacher notes')).toHaveValue('Teacher note')
  expect(api.getTeachingReport).toHaveBeenCalledTimes(2)
  expect(api.analyzeTeachingAssignment).not.toHaveBeenCalled()
})
