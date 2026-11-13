import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { StudentCaseReportPicker } from '@/components/learning/teaching-analysis/StudentCaseReportPicker'
import { initI18n } from '@/i18n/init'
import * as reportsApi from '@/lib/teaching-analysis-api'
import * as casesApi from '@/lib/teaching-student-cases-api'

vi.mock('@/lib/teaching-analysis-api', async original => ({
  ...(await original<typeof reportsApi>()),
  listTeachingReports: vi.fn(),
  getTeachingReportRevisions: vi.fn(),
  getTeachingReport: vi.fn(),
}))
vi.mock('@/lib/teaching-student-cases-api', async original => ({
  ...(await original<typeof casesApi>()),
  getTeachingReportRevision: vi.fn(),
}))

initI18n('en').addResourceBundle(
  'en',
  'app',
  {
    'teaching.cases.chooseReportVersion': 'Choose saved version · {{id}}',
    'teaching.cases.reportHistory100':
      'Showing up to the latest 100 saved revisions for this report. Only confirmed versions can be selected.',
    'teaching.cases.recentReports': 'Recent reports',
    'teaching.cases.browseReports': 'Add or change a report',
  },
  true,
  true
)

const REPORT_A = '16263eb3-fce5-4119-8ecb-2abc94c0e057'
const REPORT_B = 'cc3462ba-cd7a-4f19-8dd7-dd3133db23cf'
function summary(
  overrides: Partial<reportsApi.TeachingReportSummary> = {}
): reportsApi.TeachingReportSummary {
  return {
    report_id: REPORT_A,
    revision: 2,
    status: 'confirmed',
    student_ref: 'Original Student A',
    assignment_ref: 'Fractions quiz',
    subject: 'Mathematics',
    updated_at: 2,
    ...overrides,
  }
}
function saved(
  revision = 1,
  overrides: Partial<reportsApi.SavedTeachingReport> = {}
): reportsApi.SavedTeachingReport {
  return {
    report_id: REPORT_A,
    revision,
    status: 'confirmed',
    created_at: 1,
    updated_at: revision,
    teacher_notes: '',
    source_fingerprint: 'a'.repeat(64),
    assignment: {
      student_ref: 'Historical Student A',
      assignment_ref: 'Original fractions quiz',
      subject: 'Mathematics',
      grade: 'Grade 5',
      teacher_context: '',
      rubric_template: null,
      document_provenance: null,
      items: [
        {
          question_id: 'Q1',
          question: 'Original question: 1/2 + 1/3 = ?',
          student_answer: '5/6',
          student_work: null,
          reference_answer: '5/6',
          rubric: 'Use a common denominator.',
          knowledge_points: [],
          source_locator: 'Line 7',
          answer_status: 'present',
          transcription_status: 'confirmed',
          assistance: 'independent',
        },
      ],
    },
    analysis: {
      summary: `Original report ${revision}`,
      items: [
        {
          question_id: 'Q1',
          result: 'correct',
          observation: 'The common denominator was used.',
          evidence: [{ question_id: 'Q1', field: 'student_answer', quote: '5/6' }],
        },
      ],
      priorities: [],
      limitations: [],
    },
    ...overrides,
  }
}
const pinned = (revision = 1): casesApi.StudentCaseReportRef[] => [
  { report_id: REPORT_A, report_revision: revision },
]
const props = () => ({
  workspaceId: 'class-a',
  reportRefs: [] as casesApi.StudentCaseReportRef[],
  onChange: vi.fn(),
  disabled: false,
})

async function openLibrary() {
  const library = screen.getByText('Add or change a report').closest('details')!
  await act(async () => {
    library.open = true
    fireEvent(library, new Event('toggle'))
  })
  return library
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(reportsApi.listTeachingReports).mockResolvedValue([summary()])
  vi.mocked(reportsApi.getTeachingReportRevisions).mockResolvedValue([saved(2), saved(1)])
  vi.mocked(casesApi.getTeachingReportRevision).mockResolvedValue(saved(1))
})

it('shows original report identity and links only after a teacher selects its displayed confirmed version', async () => {
  const input = props()
  render(<StudentCaseReportPicker {...input} />)
  await openLibrary()
  const select = await screen.findByRole('button', {
    name: 'Select Original Student A · Fractions quiz · Mathematics · Revision 2 · 16263eb3',
  })
  expect(reportsApi.listTeachingReports).toHaveBeenCalledWith('class-a', expect.any(AbortSignal))
  expect(screen.getByText('Original Student A · Fractions quiz')).toBeInTheDocument()
  expect(screen.getByText(/^Mathematics · Revision 2 · 16263eb3$/)).toBeInTheDocument()
  expect(input.onChange).not.toHaveBeenCalled()
  fireEvent.click(select)
  expect(input.onChange).toHaveBeenCalledExactlyOnceWith(pinned(2))
})

it('keeps draft-current reports discoverable and permits only their older confirmed versions', async () => {
  vi.mocked(reportsApi.listTeachingReports).mockResolvedValue([
    summary({ revision: 3, status: 'draft' }),
  ])
  vi.mocked(reportsApi.getTeachingReportRevisions).mockResolvedValue([
    saved(3, { status: 'draft' }),
    saved(2),
    saved(1),
  ])
  const input = props()
  render(<StudentCaseReportPicker {...input} />)
  await openLibrary()
  fireEvent.click(await screen.findByRole('button', { name: 'Choose saved version · 16263eb3' }))
  const history = screen.getByRole('dialog', { name: 'Revision history' })
  await within(history).findByRole('button', { name: /Select Historical Student A.*Revision 1/ })
  expect(within(history).queryByRole('button', { name: /Select.*Revision 3/ })).toBeNull()
  expect(reportsApi.getTeachingReportRevisions).toHaveBeenCalledWith(
    REPORT_A,
    'class-a',
    expect.any(AbortSignal)
  )
  expect(input.onChange).not.toHaveBeenCalled()
  fireEvent.click(
    within(history).getByRole('button', { name: /Select Historical Student A.*Revision 1/ })
  )
  expect(input.onChange).toHaveBeenCalledExactlyOnceWith(pinned(1))
})

it('retains an older pinned version through refresh and requires confirmation to replace that version', async () => {
  const input = { ...props(), reportRefs: pinned(1) }
  render(<StudentCaseReportPicker {...input} />)
  await openLibrary()
  const select = await screen.findByRole('button', {
    name: /Select Original Student A.*Revision 2/,
  })
  expect(screen.getByText('Report 16263eb3 · Revision 1')).toBeInTheDocument()
  expect(input.onChange).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh report choices' }))
  await waitFor(() => expect(reportsApi.listTeachingReports).toHaveBeenCalledTimes(2))
  expect(input.onChange).not.toHaveBeenCalled()
  fireEvent.click(select)
  const dialog = screen.getByRole('dialog', { name: 'Change the pinned report version?' })
  expect(input.onChange).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(input.onChange).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /Select Original Student A.*Revision 2/ }))
  fireEvent.click(
    within(screen.getByRole('dialog', { name: 'Change the pinned report version?' })).getByRole(
      'button',
      { name: 'Use this report version' }
    )
  )
  expect(input.onChange).toHaveBeenCalledExactlyOnceWith(pinned(2))
})

it('reads and displays the exact pinned source without fetching the latest version or editing the case', async () => {
  const input = { ...props(), reportRefs: pinned(1) }
  render(<StudentCaseReportPicker {...input} />)
  fireEvent.click(await screen.findByRole('button', { name: 'View pinned version · 16263eb3' }))
  const dialog = screen.getByRole('dialog', { name: 'Original material · Report version 1' })
  await within(dialog).findByText('Historical Student A · Original fractions quiz · Mathematics')
  expect(casesApi.getTeachingReportRevision).toHaveBeenCalledWith(
    REPORT_A,
    1,
    'class-a',
    expect.any(AbortSignal)
  )
  expect(within(dialog).getByText('Original question: 1/2 + 1/3 = ?')).toBeInTheDocument()
  expect(reportsApi.getTeachingReport).not.toHaveBeenCalled()
  expect(input.onChange).not.toHaveBeenCalled()
})

it('keeps an unavailable old pin and never substitutes a newer source after an exact-version failure', async () => {
  vi.mocked(casesApi.getTeachingReportRevision).mockRejectedValue(new Error('404'))
  const input = {
    ...props(),
    reportRefs: pinned(1),
    sourceStates: [
      {
        report_id: REPORT_A,
        report_revision: 1,
        status: 'unavailable' as const,
        latest_revision: 2,
        student_ref: null,
        assignment_ref: null,
        message: null,
      },
    ],
  }
  render(<StudentCaseReportPicker {...input} />)
  await openLibrary()
  await screen.findByRole('button', { name: /Select Original Student A.*Revision 2/ })
  expect(screen.getByText('Pinned source unavailable · link kept')).toBeInTheDocument()
  expect(screen.queryByText('Newer source version exists · pinned version kept')).toBeNull()
  fireEvent.click(await screen.findByRole('button', { name: 'View pinned version · 16263eb3' }))
  await screen.findByText(
    'That exact report version could not be loaded. A later version has not been substituted.'
  )
  expect(input.onChange).not.toHaveBeenCalled()
  expect(reportsApi.getTeachingReport).not.toHaveBeenCalled()
  expect(casesApi.getTeachingReportRevision).toHaveBeenCalledTimes(1)
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
  fireEvent.click(screen.getByRole('button', { name: 'Remove link · 16263eb3' }))
  expect(input.onChange).toHaveBeenCalledExactlyOnceWith([])
})

it('allows opening confirmed version choices for a pinned report outside the recent library', async () => {
  vi.mocked(reportsApi.listTeachingReports).mockResolvedValue([
    summary({ report_id: REPORT_B, student_ref: 'Recent Student B' }),
  ])
  const input = { ...props(), reportRefs: pinned(1) }
  render(<StudentCaseReportPicker {...input} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Choose saved version · 16263eb3' }))
  const history = screen.getByRole('dialog', { name: 'Revision history' })
  await within(history).findByRole('button', { name: /Select Historical Student A.*Revision 2/ })
  expect(reportsApi.getTeachingReportRevisions).toHaveBeenCalledWith(
    REPORT_A,
    'class-a',
    expect.any(AbortSignal)
  )
  expect(input.onChange).not.toHaveBeenCalled()
  fireEvent.click(
    within(history).getByRole('button', { name: /Select Historical Student A.*Revision 2/ })
  )
  expect(
    screen.getByRole('dialog', { name: 'Change the pinned report version?' })
  ).toBeInTheDocument()
  expect(input.onChange).not.toHaveBeenCalled()
})

it('keeps a historical pin when its version-choice request fails instead of adopting a recent report', async () => {
  vi.mocked(reportsApi.listTeachingReports).mockResolvedValue([summary({ report_id: REPORT_B })])
  vi.mocked(reportsApi.getTeachingReportRevisions).mockRejectedValue(
    new Error('Unavailable history')
  )
  const input = { ...props(), reportRefs: pinned(1) }
  render(<StudentCaseReportPicker {...input} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Choose saved version · 16263eb3' }))
  await within(screen.getByRole('dialog', { name: 'Revision history' })).findByText(
    'That exact report version could not be loaded. A later version has not been substituted.'
  )
  expect(input.onChange).not.toHaveBeenCalled()
  expect(screen.getByText('Report 16263eb3 · Revision 1')).toBeInTheDocument()
  expect(casesApi.getTeachingReportRevision).not.toHaveBeenCalled()
  expect(reportsApi.getTeachingReport).not.toHaveBeenCalled()
})

it('rejects a wrong-version preview response rather than presenting it as the pinned version', async () => {
  vi.mocked(casesApi.getTeachingReportRevision).mockResolvedValue(saved(2))
  const input = { ...props(), reportRefs: pinned(1) }
  render(<StudentCaseReportPicker {...input} />)
  fireEvent.click(await screen.findByRole('button', { name: 'View pinned version · 16263eb3' }))
  await screen.findByText(
    'That exact report version could not be loaded. A later version has not been substituted.'
  )
  expect(screen.queryByText('Original report 2')).toBeNull()
  expect(input.onChange).not.toHaveBeenCalled()
})

it('limits new report links to twenty while permitting an explicit version replacement without duplicates', async () => {
  const refs = [
    ...pinned(1),
    ...Array.from({ length: 19 }, (_, index) => ({
      report_id: `${String(index + 1).padStart(8, '0')}-7654-4321-abcd-112233445566`,
      report_revision: 1,
    })),
  ]
  vi.mocked(reportsApi.listTeachingReports).mockResolvedValue([
    summary(),
    summary({
      report_id: REPORT_B,
      student_ref: 'Student B',
      assignment_ref: 'Science quiz',
      subject: 'Science',
      revision: 1,
    }),
  ])
  const input = { ...props(), reportRefs: refs }
  render(<StudentCaseReportPicker {...input} />)
  await openLibrary()
  expect(await screen.findByRole('button', { name: /Select Student B.*Revision 1/ })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: /Select Original Student A.*Revision 2/ }))
  fireEvent.click(
    within(screen.getByRole('dialog', { name: 'Change the pinned report version?' })).getByRole(
      'button',
      { name: 'Use this report version' }
    )
  )
  const result = input.onChange.mock.calls[0][0] as casesApi.StudentCaseReportRef[]
  expect(result).toHaveLength(20)
  expect(new Set(result.map(ref => ref.report_id)).size).toBe(20)
  expect(result[0]).toEqual(pinned(2)[0])
  expect(result.slice(1)).toEqual(refs.slice(1))
})

it('does not mutate selection when disabled and does not overwrite a parent change from an older confirmation dialog', async () => {
  const input = { ...props(), reportRefs: pinned(1) }
  const view = render(<StudentCaseReportPicker {...input} disabled />)
  await openLibrary()
  expect(
    await screen.findByRole('button', { name: /Select Original Student A.*Revision 2/ })
  ).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Remove link · 16263eb3' }))
  expect(input.onChange).not.toHaveBeenCalled()
  view.rerender(<StudentCaseReportPicker {...input} />)
  fireEvent.click(screen.getByRole('button', { name: /Select Original Student A.*Revision 2/ }))
  expect(
    screen.getByRole('dialog', { name: 'Change the pinned report version?' })
  ).toBeInTheDocument()
  view.rerender(<StudentCaseReportPicker {...input} reportRefs={pinned(3)} />)
  expect(screen.queryByRole('dialog', { name: 'Change the pinned report version?' })).toBeNull()
  expect(input.onChange).not.toHaveBeenCalled()
})

it('allows an archived readonly case to inspect its exact pinned material while mutation controls stay disabled', async () => {
  const input = { ...props(), reportRefs: pinned(1), disabled: true }
  render(<StudentCaseReportPicker {...input} />)
  const preview = await screen.findByRole('button', { name: 'View pinned version · 16263eb3' })
  expect(preview).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Remove link · 16263eb3' })).toBeDisabled()
  fireEvent.click(preview)
  const dialog = screen.getByRole('dialog', { name: 'Original material · Report version 1' })
  await within(dialog).findByText('Historical Student A · Original fractions quiz · Mathematics')
  expect(casesApi.getTeachingReportRevision).toHaveBeenCalledWith(
    REPORT_A,
    1,
    'class-a',
    expect.any(AbortSignal)
  )
  expect(input.onChange).not.toHaveBeenCalled()
})

it('aborts previous-workspace choices and ignores their late response', async () => {
  let finish!: (value: reportsApi.TeachingReportSummary[]) => void
  vi.mocked(reportsApi.listTeachingReports).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const input = props()
  const view = render(<StudentCaseReportPicker {...input} />)
  const signal = vi.mocked(reportsApi.listTeachingReports).mock.calls[0][1]!
  vi.mocked(reportsApi.listTeachingReports).mockResolvedValue([
    summary({ report_id: REPORT_B, student_ref: 'Workspace B student' }),
  ])
  view.rerender(<StudentCaseReportPicker {...input} workspaceId="class-b" />)
  await openLibrary()
  expect(signal.aborted).toBe(true)
  await screen.findByText('Workspace B student · Fractions quiz')
  await act(async () => finish([summary()]))
  expect(screen.queryByText('Original Student A · Fractions quiz')).toBeNull()
  expect(input.onChange).not.toHaveBeenCalled()
})

it('starts with a collapsed bounded candidate library while pinned-source preview stays accessible', async () => {
  const input = { ...props(), reportRefs: pinned(1) }
  render(<StudentCaseReportPicker {...input} />)
  const library = screen.getByText('Add or change a report').closest('details')!
  await screen.findByText('Original Student A · Fractions quiz')
  expect(library).not.toHaveAttribute('open')
  const candidate = within(library).getByText(
    'Select Original Student A · Fractions quiz · Mathematics · Revision 2 · 16263eb3'
  )
  expect(candidate).not.toBeVisible()
  expect(screen.getByRole('button', { name: 'View pinned version · 16263eb3' })).toBeEnabled()
  expect(input.onChange).not.toHaveBeenCalled()
  await openLibrary()
  expect(candidate).toBeVisible()
  expect(within(library).getByRole('region', { name: 'Recent reports' })).toHaveClass(
    'max-h-[28rem]',
    'overflow-y-auto'
  )
  expect(input.onChange).not.toHaveBeenCalled()
})

it('aborts an old source preview when switching workspaces and does not carry that source into the new page', async () => {
  let finish!: (value: reportsApi.SavedTeachingReport) => void
  vi.mocked(casesApi.getTeachingReportRevision).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const input = { ...props(), reportRefs: pinned(1) }
  const view = render(<StudentCaseReportPicker {...input} />)
  fireEvent.click(await screen.findByRole('button', { name: 'View pinned version · 16263eb3' }))
  const signal = vi.mocked(casesApi.getTeachingReportRevision).mock.calls[0][3]!
  view.rerender(<StudentCaseReportPicker {...input} reportRefs={[]} workspaceId="class-b" />)
  expect(signal.aborted).toBe(true)
  await act(async () => finish(saved(1)))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByText('Original question: 1/2 + 1/3 = ?')).toBeNull()
  expect(input.onChange).not.toHaveBeenCalled()
})
