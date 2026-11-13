import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import TeachingAnalysisPage from '@/components/learning/teaching-analysis/TeachingAnalysisPage'
import { assignmentCsvTemplate, exampleAssignment } from '@/components/learning/teaching-analysis/sample'
import { reportMarkdown } from '@/components/learning/teaching-analysis/AnalysisReport'
import { TeachingAnalysisEntry } from '@/components/learning/teaching-analysis/TeachingAnalysisEntry'
import { initI18n } from '@/i18n/init'
import { ApiError } from '@/shared/api/errors'
import * as api from '@/lib/teaching-analysis-api'
import * as rubrics from '@/lib/teaching-rubrics-api'

const current = vi.hoisted(() => ({ workspace: 'class-a', admin: true, authEnabled: true, statusAvailable: true, moduleAvailable: true }))
vi.mock('@/hooks/useAuthStatus', () => ({ useAuthStatus: () => ({ loading: false, enabled: current.authEnabled, isAdmin: current.admin, statusAvailable: current.statusAvailable, userId: 'teacher' }) }))
vi.mock('@/hooks/useActiveWorkspaceId', () => ({ useActiveWorkspaceId: () => current.workspace }))
vi.mock('@/hooks/useModules', () => ({ useModules: () => ({ available: () => current.moduleAvailable }) }))
vi.mock('@/components/learning/teaching-analysis/PracticeFollowups', async () => {
  const { useEffect } = await import('react')
  return { PracticeFollowups: function PracticeFollowups({ onDirtyChange, canCreate, onReloadReport }: { onDirtyChange?: (value: boolean) => void; canCreate: boolean; onReloadReport?: () => void }) {
    useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])
    return <div data-testid="practice-parent-integration" data-can-create={canCreate}><button onClick={() => onDirtyChange?.(true)}>Enter unsaved practice</button><button onClick={onReloadReport}>Reload source report from practice</button></div>
  } }
})
vi.mock('next/navigation', () => ({ usePathname: () => '/learning/teaching-analysis' }))
// Storage/navigation recovery has a native IndexedDB harness of its own.
vi.mock('@/components/learning/teaching-analysis/TeachingDrafts', () => ({
  TeachingDraftProvider: ({ children }: { children: React.ReactNode }) => children,
  useTeachingDraftControls: () => ({ clearAll: async () => {} }),
  useTeachingDraftSlot: () => ({ clear: async () => {} }),
  useTeachingDraftNavigationBlocker: () => {},
}))
vi.mock('@/lib/teaching-analysis-api', async original => ({
  ...(await original<typeof api>()),
  previewTeachingAssignment: vi.fn(), analyzeTeachingAssignment: vi.fn(), saveTeachingReport: vi.fn(),
  listTeachingReports: vi.fn(), getTeachingReport: vi.fn(), getTeachingReportRevisions: vi.fn(),
}))
vi.mock('@/lib/teaching-rubrics-api', async original => ({
  ...(await original<typeof rubrics>()), listTeachingRubrics: vi.fn(), saveTeachingRubric: vi.fn(), listTeachingRubricRevisions: vi.fn(),
}))
initI18n('en')

const assignment = () => exampleAssignment('en')
const report = (): api.ReportContent => ({
  summary: 'Check how the student handles unlike denominators.',
  items: assignment().items.map(item => ({
    question_id: item.question_id,
    result: item.question_id === 'Q1' ? 'correct' : 'incorrect',
    observation: item.question_id === 'Q1' ? 'This result is correct.' : 'The working adds both denominators.',
    evidence: [{ question_id: item.question_id, field: 'student_work', quote: item.student_work! }],
  })),
  priorities: [{
    knowledge_point: 'Fraction addition', observation: 'Q2 and Q3 add both denominators.', hypothesis: 'The student may be combining unlike units.',
    alternative_explanation: 'The student may have recalled an unsuitable rule.', teaching_action: 'Use equal-sized fraction strips.',
    follow_up_question: 'Is one half plus one third greater than one half?', reference_guidance: 'Ask the student to explain the units.',
    evidence_status: 'supported', evidence: [{ question_id: 'Q2', field: 'student_work', quote: '(1+1)/(2+3) = 2/5' }],
  }], limitations: ['Only this worksheet was reviewed.'],
})
const generated = () => ({ analysis: report(), source_fingerprint: 'a'.repeat(64) })
const rubric = (): rubrics.RubricTemplate => ({ template_id: 'b6a63f0f-e0cb-4ca8-b2cc-4d8b7d07d448', revision: 1, name: 'Fraction units', subject: 'Mathematics', grade: 'Grade 5', criteria: 'Explain common units before adding.', created_at: 1, updated_at: 1 })
const persisted = (update: Partial<api.SavedTeachingReport> = {}): api.SavedTeachingReport => ({
  report_id: 'efc43d95-2054-412d-814f-54c548b7a777', revision: 1, status: 'confirmed', assignment: assignment(), analysis: report(),
  source_fingerprint: 'a'.repeat(64), teacher_notes: '', created_at: 1, updated_at: 2, ...update,
})

beforeEach(() => {
  vi.clearAllMocks()
  current.workspace = 'class-a'; current.admin = true; current.authEnabled = true; current.statusAvailable = true; current.moduleAvailable = true
  vi.mocked(api.listTeachingReports).mockResolvedValue([])
  vi.mocked(api.previewTeachingAssignment).mockResolvedValue(assignment())
  vi.mocked(api.analyzeTeachingAssignment).mockResolvedValue(generated())
  vi.mocked(api.saveTeachingReport).mockImplementation(async value => persisted({ ...value, revision: value.expected_revision + 1 }))
  vi.mocked(api.getTeachingReport).mockResolvedValue(persisted())
  vi.mocked(api.getTeachingReportRevisions).mockResolvedValue([persisted()])
  vi.mocked(rubrics.listTeachingRubrics).mockResolvedValue([rubric()])
})

async function loadExampleAndAnalyze() {
  fireEvent.click(screen.getByRole('button', { name: 'Try a synthetic example' }))
  await screen.findByDisplayValue('example-student-A')
  expect(api.analyzeTeachingAssignment).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Material checked · Generate suggestions' }))
  await screen.findByRole('heading', { name: 'Teaching report' })
}

it('does not request student reports or offer analysis to non-admin or unverified accounts', () => {
  current.admin = false
  const view = render(<TeachingAnalysisPage />)
  expect(screen.getByText(/available to administrators/)).toBeVisible()
  expect(api.listTeachingReports).not.toHaveBeenCalled()
  expect(api.analyzeTeachingAssignment).not.toHaveBeenCalled()
  current.admin = true; current.statusAvailable = false
  view.rerender(<TeachingAnalysisPage />)
  expect(screen.getByText(/Access could not be verified/)).toBeVisible()
  expect(api.listTeachingReports).not.toHaveBeenCalled()
})

it('previews a file without analyzing, lets the teacher correct it, and preserves explicit blank semantics', async () => {
  render(<TeachingAnalysisPage />)
  fireEvent.change(screen.getByLabelText('Choose assignment file'), { target: { files: [new File(['data'], 'work.csv')] } })
  await screen.findByText(/Material preview is ready/)
  expect(api.previewTeachingAssignment).toHaveBeenCalledWith(expect.any(File), 'class-a', expect.any(AbortSignal))
  expect(api.analyzeTeachingAssignment).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Item 1 · Answer status'), { target: { value: 'confirmed_blank' } })
  expect(screen.getByLabelText('Item 1 · Student answer')).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Material checked · Generate suggestions' }))
  await waitFor(() => expect(api.analyzeTeachingAssignment).toHaveBeenCalled())
  const input = vi.mocked(api.analyzeTeachingAssignment).mock.calls[0][0]
  expect(input.items[0]).toMatchObject({ answer_status: 'confirmed_blank', student_answer: '', student_work: '' })
  expect(api.saveTeachingReport).not.toHaveBeenCalled()
})

it('marks manual answers present, clears them to unknown, and does not require a source location', async () => {
  render(<TeachingAnalysisPage />)
  fireEvent.change(screen.getByLabelText('Student label'), { target: { value: 'Student A' } })
  fireEvent.change(screen.getByLabelText('Assignment label'), { target: { value: 'Worksheet 1' } })
  fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Mathematics' } })
  fireEvent.change(screen.getByLabelText('Item 1 · Question'), { target: { value: '2 + 2 = ?' } })
  fireEvent.change(screen.getByLabelText('Item 1 · Student answer'), { target: { value: '4' } })
  expect(screen.getByLabelText('Item 1 · Answer status')).toHaveValue('present')
  fireEvent.change(screen.getByLabelText('Item 1 · Student answer'), { target: { value: '' } })
  expect(screen.getByLabelText('Item 1 · Answer status')).toHaveValue('unknown')
  fireEvent.change(screen.getByLabelText('Item 1 · Student answer'), { target: { value: '4' } })
  fireEvent.click(screen.getByRole('button', { name: 'Material checked · Generate suggestions' }))
  await waitFor(() => expect(api.analyzeTeachingAssignment).toHaveBeenCalled())
  expect(vi.mocked(api.analyzeTeachingAssignment).mock.calls[0][0].items[0]).toMatchObject({ student_answer: '4', answer_status: 'present', source_locator: '' })
})

it('invalidates findings when source material changes and keeps source quotes read-only', async () => {
  render(<TeachingAnalysisPage />)
  await loadExampleAndAnalyze()
  const evidence = screen.getAllByRole('link', { name: 'Q2' })
  expect(evidence[0]).toHaveAttribute('href', '#teaching-item-Q2')
  fireEvent.click(evidence[0])
  expect(document.getElementById('teaching-item-Q2')).toHaveAttribute('open')
  fireEvent.click(screen.getByRole('button', { name: 'Edit report draft' }))
  expect(screen.getByLabelText('Report summary')).toHaveValue(report().summary)
  expect(screen.queryByRole('textbox', { name: 'Original answer evidence' })).toBeNull()
  fireEvent.change(screen.getByLabelText('Item 1 · Student answer'), { target: { value: '4/5' } })
  expect(screen.getByText(/Previous findings no longer apply/)).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Confirm and save report' })).toBeNull()
  expect(api.saveTeachingReport).not.toHaveBeenCalled()
})

it('keeps a failed save retryable with the same report identity and only announces successful saves', async () => {
  vi.mocked(api.saveTeachingReport).mockRejectedValueOnce(new Error('Storage unavailable'))
  render(<TeachingAnalysisPage />)
  await loadExampleAndAnalyze()
  fireEvent.click(screen.getByRole('button', { name: 'Edit report draft' }))
  fireEvent.change(screen.getByLabelText('Report summary'), { target: { value: 'Teacher-reviewed local summary' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
  await screen.findByText('Storage unavailable')
  expect(screen.getByLabelText('Report summary')).toHaveValue('Teacher-reviewed local summary')
  expect(screen.queryByText('Draft saved in this workspace.')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
  await screen.findByText('Draft saved in this workspace.')
  const calls = vi.mocked(api.saveTeachingReport).mock.calls
  expect(calls[0][0]).toEqual(calls[1][0])
  expect(calls[1][0]).toMatchObject({ expected_revision: 0, status: 'draft', analysis: { summary: 'Teacher-reviewed local summary' } })
})

it('downgrades edited confirmed reports to draft and preserves local edits on revision conflicts', async () => {
  vi.mocked(api.listTeachingReports).mockResolvedValue([{ report_id: persisted().report_id, revision: 1, status: 'confirmed', student_ref: 'Student A', assignment_ref: 'Worksheet 1', subject: 'Math', updated_at: 1 }])
  vi.mocked(api.saveTeachingReport).mockRejectedValue(new ApiError({ code: 'http_409', message: 'Report changed', status: 409, retryable: false, scope: 'network' }))
  render(<TeachingAnalysisPage />)
  fireEvent.click(await screen.findByRole('button', { name: /Student A · Worksheet 1/ }))
  await screen.findByRole('heading', { name: 'Teaching report' })
  fireEvent.click(screen.getByRole('button', { name: 'Edit report draft' }))
  fireEvent.change(screen.getByLabelText('Report summary'), { target: { value: 'Local revision to keep' } })
  expect(screen.getByText(/It is a draft again/)).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
  await screen.findByText(/A newer version was saved elsewhere/)
  expect(screen.getByLabelText('Report summary')).toHaveValue('Local revision to keep')
  expect(api.saveTeachingReport).toHaveBeenCalledWith(expect.objectContaining({ expected_revision: 1, status: 'draft' }), 'class-a', expect.any(AbortSignal))
  expect(screen.getByRole('button', { name: 'Confirm and save report' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved version' }))
  const dialog = screen.getByRole('dialog', { name: 'Replace unsaved work?' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(screen.getByLabelText('Report summary')).toHaveValue('Local revision to keep')
})

it('aborts analysis on workspace switches and ignores late responses from the old scope', async () => {
  let finish!: (value: api.AnalysisResult) => void
  vi.mocked(api.analyzeTeachingAssignment).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const view = render(<TeachingAnalysisPage />)
  fireEvent.click(screen.getByRole('button', { name: 'Try a synthetic example' }))
  await screen.findByDisplayValue('example-student-A')
  fireEvent.click(screen.getByRole('button', { name: 'Material checked · Generate suggestions' }))
  const signal = vi.mocked(api.analyzeTeachingAssignment).mock.calls[0][3]!
  current.workspace = 'class-b'
  view.rerender(<TeachingAnalysisPage />)
  expect(signal.aborted).toBe(true)
  await act(async () => finish(generated()))
  expect(screen.queryByRole('heading', { name: 'Teaching report' })).toBeNull()
  expect(screen.getByLabelText('Student label')).toHaveValue('')
  expect(api.listTeachingReports).toHaveBeenLastCalledWith('class-b', expect.any(AbortSignal))
})

it('exports source quotes, scope and explicit draft status without implying a saved report', () => {
  const markdown = reportMarkdown(assignment(), report(), 'Check again next lesson.', { title: 'Teaching report', status: 'Draft · Unsaved changes', source: 'Source', priorities: 'Priorities', limitations: 'Limits', notes: 'Notes' })
  expect(markdown).toContain('Draft · Unsaved changes')
  expect(markdown).toContain('example-student-A / example-fractions-01')
  expect(markdown).toContain('> (1+1)/(2+3) = 2/5')
  expect(markdown).toContain('Check again next lesson.')
})

it('offers model setup for an unconfigured model without discarding the assignment', async () => {
  vi.mocked(api.analyzeTeachingAssignment).mockRejectedValueOnce(new ApiError({ code: 'teaching_model_not_configured', message: 'Missing model', status: 503, retryable: false, scope: 'network' }))
  render(<TeachingAnalysisPage />)
  fireEvent.click(screen.getByRole('button', { name: 'Try a synthetic example' }))
  await screen.findByDisplayValue('example-student-A')
  fireEvent.click(screen.getByRole('button', { name: 'Material checked · Generate suggestions' }))
  expect(await screen.findByRole('link', { name: 'Configure a chat model' })).toHaveAttribute('href', '/settings/llm?dt_workspace=class-a')
  expect(screen.getByLabelText('Student label')).toHaveValue('example-student-A')
  expect(screen.getByLabelText('Item 1 · Student answer')).toHaveValue('3/5')
  expect(api.saveTeachingReport).not.toHaveBeenCalled()
})

it('hides the entry for non-admin accounts and disabled modules while retaining the admin entry', () => {
  current.admin = false
  const view = render(<TeachingAnalysisEntry />)
  expect(screen.queryByRole('link')).toBeNull()
  current.admin = true; current.moduleAvailable = false
  view.rerender(<TeachingAnalysisEntry />)
  expect(screen.queryByRole('link')).toBeNull()
  current.moduleAvailable = true
  view.rerender(<TeachingAnalysisEntry />)
  expect(screen.getByRole('link', { name: /Teaching analysis/ })).toHaveAttribute('href', '/learning/teaching-analysis?dt_workspace=')
})

it('provides an Excel-compatible header-only CSV template and keeps optional item information folded', async () => {
  const csv = assignmentCsvTemplate('zh')
  expect(csv.charCodeAt(0)).toBe(0xFEFF)
  expect(csv.slice(1).trim()).toBe('学生代号,作业代号,学科,题号,题干,学生作答,解题过程,参考答案,评分标准')
  expect(csv.trim().split(/\r?\n/)).toHaveLength(1)
  render(<TeachingAnalysisPage />)
  expect(screen.getByRole('button', { name: 'Download CSV template' })).toBeVisible()
  const more = screen.getByText('Item 1 · More information (optional)').closest('details')
  expect(more).not.toHaveAttribute('open')
  fireEvent.click(screen.getByText('Item 1 · More information (optional)'))
  expect(screen.getByLabelText('Item 1 · Source location (optional)')).toBeVisible()
  await screen.findByText('No reports saved in this workspace yet.')
})

it('shows historic teaching actions and source material without linking old evidence to the editor', async () => {
  render(<TeachingAnalysisPage />)
  await loadExampleAndAnalyze()
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
  await screen.findByText('Draft saved in this workspace.')
  fireEvent.click(screen.getByRole('button', { name: 'Revision history' }))
  const history = await screen.findByRole('region', { name: 'Revision history' })
  expect(within(history).getByText('Use equal-sized fraction strips.')).toBeInTheDocument()
  expect(within(history).getByText('Is one half plus one third greater than one half?')).toBeInTheDocument()
  expect(within(history).getByText('Only this worksheet was reviewed.')).toBeInTheDocument()
  expect(within(history).getByText('Material saved with this revision')).toBeInTheDocument()
  expect(within(history).queryByRole('link', { hidden: true })).toBeNull()
})

it('invalidates the report only when a saved marking-standard snapshot is explicitly applied or removed', async () => {
  render(<TeachingAnalysisPage />)
  await loadExampleAndAnalyze()
  const library = document.getElementById('teaching-rubric-library') as HTMLDetailsElement
  await act(async () => { library.open = true; fireEvent(library, new Event('toggle')) })
  const selector = screen.getByRole('combobox', { name: 'Saved marking standards' })
  await waitFor(() => expect(selector).toBeEnabled())
  fireEvent.change(selector, { target: { value: rubric().template_id } })
  expect(screen.getByRole('heading', { name: 'Teaching report' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Apply to this assignment' }))
  expect(screen.queryByRole('heading', { name: 'Teaching report' })).toBeNull()
  expect(screen.getByText(/Previous findings no longer apply/)).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Material checked · Generate suggestions' }))
  await screen.findByRole('heading', { name: 'Teaching report' })
  expect(vi.mocked(api.analyzeTeachingAssignment).mock.calls[1][0].rubric_template).toEqual(rubrics.rubricSnapshot(rubric()))
  fireEvent.click(screen.getByRole('button', { name: 'Remove from this assignment' }))
  expect(screen.queryByRole('heading', { name: 'Teaching report' })).toBeNull()
})

it('protects unsaved marking-standard edits when starting a new analysis', async () => {
  render(<TeachingAnalysisPage />)
  const library = document.getElementById('teaching-rubric-library') as HTMLDetailsElement
  await act(async () => { library.open = true; fireEvent(library, new Event('toggle')) })
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Saved marking standards' })).toBeEnabled())
  fireEvent.change(screen.getByLabelText('Marking guidance'), { target: { value: 'Local unsaved criteria.' } })
  fireEvent.click(screen.getByRole('button', { name: 'New analysis' }))
  const dialog = screen.getByRole('dialog', { name: 'Replace unsaved work?' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(screen.getByLabelText('Marking guidance')).toHaveValue('Local unsaved criteria.')
  const unload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unload)
  expect(unload.defaultPrevented).toBe(true)
})

it('protects child practice edits without changing the confirmed report status', async () => {
  vi.mocked(api.listTeachingReports).mockResolvedValue([{ report_id: persisted().report_id, revision: 1, status: 'confirmed', student_ref: 'Student A', assignment_ref: 'Worksheet 1', subject: 'Math', updated_at: 1 }])
  render(<TeachingAnalysisPage />)
  fireEvent.click(await screen.findByRole('button', { name: /Student A · Worksheet 1/ }))
  await screen.findByRole('heading', { name: 'Teaching report' })
  expect(screen.getByTestId('practice-parent-integration')).toHaveAttribute('data-can-create', 'true')
  const library = document.getElementById('teaching-rubric-library') as HTMLDetailsElement
  await act(async () => { library.open = true; fireEvent(library, new Event('toggle')) })
  const selector = screen.getByRole('combobox', { name: 'Saved marking standards' })
  await waitFor(() => expect(selector).toBeEnabled())
  fireEvent.change(selector, { target: { value: rubric().template_id } })
  fireEvent.click(screen.getByRole('button', { name: 'Enter unsaved practice' }))
  expect(screen.getByText('Teacher confirmed')).toBeInTheDocument()
  expect(screen.getByLabelText('Item 1 · Student answer')).toBeDisabled()
  expect(screen.getByLabelText('Student label')).toBeDisabled()
  const apply = screen.getByRole('button', { name: 'Apply to this assignment' })
  expect(apply).toBeDisabled()
  fireEvent.click(apply)
  expect(screen.getByRole('heading', { name: 'Teaching report' })).toBeInTheDocument()
  expect(api.analyzeTeachingAssignment).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'New analysis' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Replace unsaved work?' })).getByRole('button', { name: 'Cancel' }))
  fireEvent.click(screen.getByRole('button', { name: 'Edit report draft' }))
  fireEvent.change(screen.getByLabelText('Report summary'), { target: { value: 'An edited summary.' } })
  expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled()
  expect(screen.getByText(/Save or discard the open practice edits/)).toBeVisible()
})

it('keeps material intact and offers standard review when a saved rubric version is unavailable', async () => {
  vi.mocked(api.analyzeTeachingAssignment).mockRejectedValueOnce(new ApiError({ code: 'teaching_rubric_unavailable', message: 'Rubric unavailable', status: 422, retryable: false, scope: 'network' }))
  render(<TeachingAnalysisPage />)
  fireEvent.click(screen.getByRole('button', { name: 'Try a synthetic example' }))
  await screen.findByDisplayValue('example-student-A')
  fireEvent.click(screen.getByRole('button', { name: 'Material checked · Generate suggestions' }))
  const review = await screen.findByRole('button', { name: 'Review marking standard' })
  expect(screen.getByLabelText('Item 1 · Student answer')).toHaveValue('3/5')
  fireEvent.click(review)
  expect(document.getElementById('teaching-rubric-library')).toHaveAttribute('open')
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Saved marking standards' })).toBeEnabled())
  expect(api.saveTeachingReport).not.toHaveBeenCalled()
})

it('asks before reloading a changed source report and loads its current content', async () => {
  vi.mocked(api.listTeachingReports).mockResolvedValue([{ report_id: persisted().report_id, revision: 1, status: 'confirmed', student_ref: 'Student A', assignment_ref: 'Worksheet 1', subject: 'Math', updated_at: 1 }])
  vi.mocked(api.getTeachingReport).mockResolvedValueOnce(persisted()).mockResolvedValueOnce(persisted({ revision: 2, analysis: { ...report(), summary: 'Current source report from the server.' } }))
  render(<TeachingAnalysisPage />)
  fireEvent.click(await screen.findByRole('button', { name: /Student A · Worksheet 1/ }))
  await screen.findByRole('heading', { name: 'Teaching report' })
  fireEvent.click(screen.getByRole('button', { name: 'Enter unsaved practice' }))
  fireEvent.click(screen.getByRole('button', { name: 'Reload source report from practice' }))
  expect(api.getTeachingReport).toHaveBeenCalledTimes(1)
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Replace unsaved work?' })).getByRole('button', { name: 'Replace current work' }))
  await screen.findByText('Current source report from the server.')
  expect(api.getTeachingReport).toHaveBeenLastCalledWith(persisted().report_id, 'class-a', expect.any(AbortSignal))
  await waitFor(() => expect(screen.getByLabelText('Item 1 · Student answer')).toBeEnabled())
})

it('rebuilds child editors after an explicit reload even when report ID and revision are unchanged', async () => {
  vi.mocked(api.listTeachingReports).mockResolvedValue([{ report_id: persisted().report_id, revision: 1, status: 'confirmed', student_ref: 'Student A', assignment_ref: 'Worksheet 1', subject: 'Math', updated_at: 1 }])
  render(<TeachingAnalysisPage />)
  fireEvent.click(await screen.findByRole('button', { name: /Student A · Worksheet 1/ }))
  await screen.findByRole('heading', { name: 'Teaching report' })
  const previousEditor = screen.getByTestId('practice-parent-integration')
  fireEvent.click(screen.getByRole('button', { name: 'Enter unsaved practice' }))
  fireEvent.click(screen.getByRole('button', { name: 'Reload source report from practice' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Replace unsaved work?' })).getByRole('button', { name: 'Replace current work' }))
  await waitFor(() => expect(api.getTeachingReport).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(screen.getByTestId('practice-parent-integration')).not.toBe(previousEditor))
  await waitFor(() => expect(screen.getByLabelText('Item 1 · Student answer')).toBeEnabled())
})
