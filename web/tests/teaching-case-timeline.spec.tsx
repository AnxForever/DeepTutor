import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import { StudentEvidenceTimeline } from '@/components/learning/teaching-analysis/StudentEvidenceTimeline'
import { exampleAssignment } from '@/components/learning/teaching-analysis/sample'
import type { SavedTeachingReport } from '@/lib/teaching-analysis-api'
import type { SavedFollowupAttempt } from '@/lib/teaching-followups-api'
import { initI18n } from '@/i18n/init'
import { ApiError } from '@/shared/api/errors'
import * as api from '@/lib/teaching-student-cases-api'

vi.mock('@/lib/teaching-student-cases-api', async original => ({
  ...(await original<typeof api>()), getStudentCaseTimeline: vi.fn(), getTeachingReportRevision: vi.fn(), saveStudentCase: vi.fn(),
}))
initI18n('en')
const caseId = 'e54cf98e-35e7-4f72-8d8b-727a9300db3a'
const reportId = 'efc43d95-2054-412d-814f-54c548b7a777'
const missingId = 'd41a3621-33ad-4431-9dfd-3d90732c0c13'
const attemptId = '31755899-a857-4605-b0fb-c51e62410fbd'
const otherAttemptId = '1d9242c4-aa8b-4eef-887a-259bd6c010b6'
const assistance = ['independent', 'assisted', 'unknown'] as const
const results = ['correct', 'partial', 'incorrect', 'ungraded'] as const
const jointCounts = [[2, 1, 1, 0], [5, 0, 2, 1], [0, 0, 0, 3]]
const translated = (key: string) => String(i18n.t(key))

function savedReport(change: Partial<SavedTeachingReport> = {}): SavedTeachingReport {
  const assignment = {
    ...exampleAssignment('en'), student_ref: 'Historical student alias', assignment_ref: 'Worksheet Tuesday',
    rubric_template: { template_id: '163a8505-236e-4e67-b206-7235178824ee', revision: 3, name: 'Unit reasoning', subject: 'Mathematics', grade: 'Grade 5', criteria: 'Explain common units and justify equivalence.' },
  }
  return {
    report_id: reportId, revision: 2, status: 'confirmed', assignment, teacher_notes: 'The teacher reviewed this exact saved version.', source_fingerprint: 'a'.repeat(64), created_at: 100, updated_at: 200,
    analysis: {
      summary: 'The working combines unlike fraction units.',
      items: assignment.items.map(item => ({ question_id: item.question_id, result: item.question_id === 'Q1' ? 'correct' : item.question_id === 'Q2' ? 'incorrect' : 'ungraded', observation: `Pinned observation for ${item.question_id}.`, evidence: [{ question_id: item.question_id, field: 'student_work', quote: item.student_work! }] })),
      priorities: [{ knowledge_point: 'Unlike fraction units', observation: 'Q2 adds both denominators.', hypothesis: 'Unit confusion is possible.', alternative_explanation: 'A recalled rule may be inappropriate.', teaching_action: 'Compare equal-sized strips.', follow_up_question: 'Explain the units before adding 1/4 and 1/6.', reference_guidance: 'Ask for a new independent explanation.', evidence_status: 'needs_check', evidence: [{ question_id: 'Q2', field: 'student_work', quote: assignment.items[1].student_work! }] }],
      limitations: ['Only the supplied worksheet supports this observation.'],
    }, ...change,
  }
}
function reportEvent(): api.StudentCaseTimelineEvent {
  const report = savedReport()
  return { kind: 'report', event_id: `report:${reportId}:2`, recorded_at: report.updated_at, report_snapshot: { report_id: reportId, report_revision: 2, student_ref: report.assignment.student_ref, assignment_ref: report.assignment.assignment_ref, subject: report.assignment.subject, summary: report.analysis.summary, items: report.analysis.items, priorities: report.analysis.priorities } }
}
function response(change: Partial<SavedFollowupAttempt> = {}): SavedFollowupAttempt {
  return {
    attempt_id: attemptId, followup_id: '4bdc326c-2c22-4407-a4c7-1627ce191e4c', followup_revision: 1, report_id: reportId, report_revision: 2, priority_index: 0,
    question_id: 'F1', question_snapshot: { question_id: 'F1', question: 'Explain 1/4 + 1/6 using equal units.', reference_answer: '5/12', rubric: 'Explain a common denominator.' },
    student_answer: '5/12', student_work: '3/12 + 2/12 = 5/12', answer_status: 'present', assistance: 'assisted', teacher_result: 'correct', teacher_feedback: 'Needed a common denominator prompt.',
    student_ref: 'Historical student alias', assignment_ref: 'Worksheet Tuesday', subject: 'Mathematics', grade: 'Grade 5', source_fingerprint: 'a'.repeat(64), knowledge_point: 'Unlike fraction units', created_at: 300, voided_at: null, void_reason: null, ...change,
  }
}
function attemptEvent(change: Partial<SavedFollowupAttempt> = {}): api.StudentCaseTimelineEvent {
  const attempt = response(change)
  return { kind: 'attempt', event_id: `attempt:${attempt.attempt_id}`, recorded_at: attempt.created_at, attempt }
}
function counts(change: Partial<api.StudentCaseTimelineCounts> = {}): api.StudentCaseTimelineCounts {
  return {
    linked_reports: 2, available_reports: 1, unavailable_reports: 1, confirmed_report_count: 1, stale_source_count: 1, report_items: 3,
    report_results: { correct: 1, partial: 0, incorrect: 1, ungraded: 1 }, attempts: 15, voided_attempts: 2,
    attempt_results: { correct: 7, partial: 1, incorrect: 3, ungraded: 4 }, attempt_assistance: { independent: 4, assisted: 8, unknown: 3 },
    attempt_outcomes: assistance.flatMap((help, index) => results.map((result, resultIndex) => ({ assistance: help, teacher_result: result, count: jointCounts[index][resultIndex] }))), total_events: 16, ...change,
  }
}
function page(change: Partial<api.StudentCaseTimeline> = {}): api.StudentCaseTimeline {
  return {
    case_id: caseId, case_revision: 1, case_label: 'Current anonymous case label', archived: false, counts: counts(), generated_at: 400, next_cursor: 'opaque-cursor-1',
    source_states: [
      { report_id: reportId, report_revision: 2, status: 'stale', latest_revision: 4, student_ref: 'Historical student alias', assignment_ref: 'Worksheet Tuesday', message: null },
      { report_id: missingId, report_revision: 1, status: 'unavailable', latest_revision: null, student_ref: null, assignment_ref: null, message: null },
    ], events: [attemptEvent(), reportEvent()], ...change,
  }
}
function missingSourceAttempt() {
  return attemptEvent({ attempt_id: otherAttemptId, report_id: missingId, report_revision: 1, question_id: 'F9', question_snapshot: { question_id: 'F9', question: 'An older source question.', reference_answer: null, rubric: null }, teacher_result: 'ungraded', assistance: 'unknown', answer_status: 'unknown', student_answer: null, student_work: null, teacher_feedback: 'The original response was not supplied.', created_at: 100, student_ref: 'Older source alias', assignment_ref: 'Older worksheet' })
}
const timelineList = () => screen.getByRole('list', { name: 'Teaching evidence timeline' })
async function ready() { await screen.findByRole('heading', { name: 'Worksheet Tuesday' }) }
function openExact() { fireEvent.click(within(screen.getByRole('heading', { name: 'Worksheet Tuesday' }).closest('li')!).getByRole('button', { name: 'View original questions · Report version 2' })) }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getStudentCaseTimeline).mockReset().mockResolvedValue(page())
  vi.mocked(api.getTeachingReportRevision).mockReset().mockResolvedValue(savedReport())
})

it('shows pinned report observations, exact quotes and manual practice evaluation as different evidence kinds', async () => {
  const onSources = vi.fn()
  render(<StudentEvidenceTimeline caseId={caseId} workspaceId="class-a" refreshKey={1} onSourceStates={onSources} />)
  await ready()
  expect(api.getStudentCaseTimeline).toHaveBeenCalledWith(caseId, { limit: 20 }, 'class-a', expect.any(AbortSignal))
  const report = screen.getByRole('heading', { name: 'Worksheet Tuesday' }).closest('li')!
  fireEvent.click(within(report).getByText('Item observations and exact response quotes'))
  expect(within(report).getByText('Report observation · Correct in this item')).toBeVisible()
  expect(within(report).getAllByText('(1+1)/(2+3) = 2/5').length).toBeGreaterThan(0)
  expect(screen.getByText('Teacher evaluation · Correct in this item')).toBeVisible()
  expect(within(timelineList()).getByText(translated('teaching.assistanceStatus.assisted'))).toBeVisible()
  expect(screen.getAllByText(/Source labels: Historical student alias/).length).toBeGreaterThan(0)
  expect(screen.queryByText(/Source labels: Current anonymous case label/)).toBeNull()
  expect(onSources).toHaveBeenCalledWith(page().source_states)
  expect(api.saveStudentCase).not.toHaveBeenCalled()
})

it('renders the provided assistance-by-result joint buckets, not marginal totals or averages', async () => {
  render(<StudentEvidenceTimeline caseId={caseId} workspaceId="class-a" refreshKey={1} />)
  await ready()
  const table = screen.getByRole('table', { name: 'Teacher evaluations by help used' })
  for (let index = 0; index < assistance.length; index++) {
    const row = within(table).getByRole('rowheader', { name: translated(`teaching.assistanceStatus.${assistance[index]}`) }).closest('tr')!
    expect(within(row).getAllByRole('cell').map(cell => cell.textContent)).toEqual(jointCounts[index].map(String))
  }
  expect(screen.getByText('Showing 2 of 16 records')).toBeVisible()
  expect(screen.getByText(/2 voided response records are excluded/)).toBeVisible()
  expect(screen.queryByRole('progressbar')).toBeNull()
  expect(document.body.textContent).not.toMatch(/\d+\s*%/)
})

it('labels recording time instead of claiming when learning took place', async () => {
  render(<StudentEvidenceTimeline caseId={caseId} workspaceId="class-a" refreshKey={1} />)
  await ready()
  expect(screen.getByText(/Times are recording times, not the dates/)).toBeVisible()
  expect(document.querySelector(`time[datetime="${new Date(200_000).toISOString()}"]`)).toHaveTextContent('Recorded:')
  expect(document.querySelector(`time[datetime="${new Date(300_000).toISOString()}"]`)).toHaveTextContent('Recorded:')
})

it('keeps stale and missing source states visible without replacing the pinned report by a newer version', async () => {
  vi.mocked(api.getStudentCaseTimeline).mockResolvedValue(page({ events: [missingSourceAttempt(), reportEvent()] }))
  render(<StudentEvidenceTimeline caseId={caseId} workspaceId="class-a" refreshKey={1} />)
  await ready()
  expect(screen.getByText(/Source version 4 also exists/)).toBeVisible()
  expect(screen.getByText(/Linked report version 1 cannot currently be read/)).toBeVisible()
  expect(screen.getByText(/Source labels: Older source alias.*Older worksheet/)).toBeVisible()
  expect(within(timelineList()).getAllByRole('listitem')).toHaveLength(2)
  openExact()
  await screen.findByRole('dialog', { name: 'Original material · Report version 2' })
  await waitFor(() => expect(api.getTeachingReportRevision).toHaveBeenCalledWith(reportId, 2, 'class-a', expect.any(AbortSignal)))
  expect(api.getTeachingReportRevision).not.toHaveBeenCalledWith(reportId, 4, expect.anything(), expect.anything())
})

it('loads the full exact report version read-only, including original questions, assistance, criteria and limits', async () => {
  render(<StudentEvidenceTimeline caseId={caseId} workspaceId="class-a" refreshKey={1} />)
  await ready()
  openExact()
  const dialog = screen.getByRole('dialog', { name: 'Original material · Report version 2' })
  await within(dialog).findByText(savedReport().assignment.items[0].question)
  expect(within(dialog).getByText('Explain common units and justify equivalence.')).toBeInTheDocument()
  expect(within(dialog).getByText('Only the supplied worksheet supports this observation.')).toBeInTheDocument()
  expect(within(dialog).queryByRole('textbox')).toBeNull()
  expect(within(dialog).queryByRole('button', { name: /Apply|Save|Edit/ })).toBeNull()
  expect(api.saveStudentCase).not.toHaveBeenCalled()
})

it('rejects a mismatched exact-version response and retries the requested revision instead of falling back to latest', async () => {
  vi.mocked(api.getTeachingReportRevision).mockResolvedValueOnce(savedReport({ revision: 4, analysis: { ...savedReport().analysis, summary: 'WRONG_LATEST_VERSION_CONTENT' } }))
  render(<StudentEvidenceTimeline caseId={caseId} workspaceId="class-a" refreshKey={1} />)
  await ready()
  openExact()
  const dialog = screen.getByRole('dialog')
  await within(dialog).findByText(/The returned report does not match the requested saved version/)
  expect(within(dialog).queryByText('WRONG_LATEST_VERSION_CONTENT')).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Retry this report version' }))
  await within(dialog).findByText(savedReport().assignment.items[0].question)
  expect(vi.mocked(api.getTeachingReportRevision).mock.calls.map(call => call[1])).toEqual([2, 2])
})

it('retains a missing exact-version error and never asks for a latest report implicitly', async () => {
  vi.mocked(api.getTeachingReportRevision).mockRejectedValueOnce(new ApiError({ code: 'http_404', message: 'Missing old version', retryable: false, scope: 'network', status: 404 }))
  render(<StudentEvidenceTimeline caseId={caseId} workspaceId="class-a" refreshKey={1} />)
  await ready()
  openExact()
  const dialog = screen.getByRole('dialog')
  await within(dialog).findByText(/No latest-version fallback has been substituted/)
  expect(api.getTeachingReportRevision).toHaveBeenCalledTimes(1)
  expect(within(dialog).queryByRole('textbox')).toBeNull()
})

it('appends server-ordered pages once per event identity and retries a failed page with the same cursor', async () => {
  vi.mocked(api.getStudentCaseTimeline).mockRejectedValueOnce(new Error('Temporary read failure')).mockResolvedValueOnce(page())
  render(<StudentEvidenceTimeline caseId={caseId} workspaceId="class-a" refreshKey={1} />)
  await screen.findByText(/Evidence could not be loaded/)
  fireEvent.click(screen.getAllByRole('button', { name: 'Refresh evidence' })[0])
  await ready()
  vi.mocked(api.getStudentCaseTimeline).mockRejectedValueOnce(new Error('Temporary page failure'))
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier records' }))
  await screen.findByText(/Earlier records could not be loaded/)
  expect(within(timelineList()).getAllByRole('listitem')).toHaveLength(2)
  vi.mocked(api.getStudentCaseTimeline).mockResolvedValueOnce(page({ events: [reportEvent(), missingSourceAttempt()], next_cursor: null }))
  fireEvent.click(screen.getAllByRole('button', { name: 'Retry loading earlier records' })[0])
  await screen.findByText('Showing 3 of 16 records')
  expect(within(timelineList()).getAllByRole('listitem')).toHaveLength(3)
  const calls = vi.mocked(api.getStudentCaseTimeline).mock.calls
  expect(calls[2][1].cursor).toBe('opaque-cursor-1')
  expect(calls[3][1].cursor).toBe('opaque-cursor-1')
})

it('freezes stale pagination on dataset conflict and refreshes explicitly without adopting another case revision', async () => {
  render(<StudentEvidenceTimeline caseId={caseId} workspaceId="class-a" refreshKey={1} />)
  await ready()
  vi.mocked(api.getStudentCaseTimeline).mockRejectedValueOnce(new ApiError({ code: 'timeline_changed', message: 'Dataset changed', status: 409, retryable: false, scope: 'network' }))
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier records' }))
  await screen.findByText(/The evidence or a source state has changed/)
  expect(screen.getByRole('button', { name: 'Load earlier records' })).toBeDisabled()
  expect(within(timelineList()).getAllByRole('listitem')).toHaveLength(2)
  vi.mocked(api.getStudentCaseTimeline).mockResolvedValueOnce(page({ next_cursor: null }))
  fireEvent.click(screen.getAllByRole('button', { name: 'Refresh evidence' })[0])
  await waitFor(() => expect(screen.queryByText(/The evidence or a source state has changed/)).toBeNull())
  expect(vi.mocked(api.getStudentCaseTimeline).mock.calls.at(-1)![1]).toEqual({ limit: 20 })
})

it('refuses a first page with changed case pins and requests a parent-confirmed case reload', async () => {
  const onReloadCase = vi.fn()
  const onSources = vi.fn()
  vi.mocked(api.getStudentCaseTimeline).mockResolvedValueOnce(page({ case_revision: 2, events: [{ ...reportEvent(), report_snapshot: { ...(reportEvent() as Extract<api.StudentCaseTimelineEvent, { kind: 'report' }>).report_snapshot, summary: 'UNACCEPTED_NEW_PINS' } } as api.StudentCaseTimelineEvent] }))
  render(<StudentEvidenceTimeline caseId={caseId} workspaceId="class-a" refreshKey={1} onReloadCase={onReloadCase} onSourceStates={onSources} />)
  await screen.findByText(/This student record has a different saved version/)
  expect(screen.queryByText('UNACCEPTED_NEW_PINS')).toBeNull()
  expect(screen.queryByRole('table')).toBeNull()
  expect(onSources).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Reload student record' }))
  expect(onReloadCase).toHaveBeenCalledTimes(1)
  expect(api.getStudentCaseTimeline).toHaveBeenCalledTimes(1)
})

it('resets and aborts requests on workspace or saved-case revision changes, ignoring late old pages', async () => {
  let finishOld!: (value: api.StudentCaseTimeline) => void
  vi.mocked(api.getStudentCaseTimeline).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
  const onSources = vi.fn()
  const view = render(<StudentEvidenceTimeline caseId={caseId} workspaceId="class-a" refreshKey={1} onSourceStates={onSources} />)
  const signal = vi.mocked(api.getStudentCaseTimeline).mock.calls[0][3]!
  vi.mocked(api.getStudentCaseTimeline).mockResolvedValueOnce(page({ case_revision: 2 }))
  view.rerender(<StudentEvidenceTimeline caseId={caseId} workspaceId="class-b" refreshKey={2} onSourceStates={onSources} />)
  expect(signal.aborted).toBe(true)
  await ready()
  await act(async () => finishOld(page({ events: [attemptEvent({ student_answer: 'OLD_SCOPE_RESPONSE' })] })))
  expect(screen.queryByText('OLD_SCOPE_RESPONSE')).toBeNull()
  expect(onSources).toHaveBeenCalledTimes(1)
  expect(api.getStudentCaseTimeline).toHaveBeenLastCalledWith(caseId, { limit: 20 }, 'class-b', expect.any(AbortSignal))
})

it('does not let a pending old page overwrite a later explicit refresh', async () => {
  let finishMore!: (value: api.StudentCaseTimeline) => void
  let finishFresh!: (value: api.StudentCaseTimeline) => void
  render(<StudentEvidenceTimeline caseId={caseId} workspaceId="class-a" refreshKey={1} />)
  await ready()
  vi.mocked(api.getStudentCaseTimeline).mockImplementationOnce(() => new Promise(resolve => { finishMore = resolve }))
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier records' }))
  const oldSignal = vi.mocked(api.getStudentCaseTimeline).mock.calls[1][3]!
  vi.mocked(api.getStudentCaseTimeline).mockImplementationOnce(() => new Promise(resolve => { finishFresh = resolve }))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh evidence' }))
  expect(oldSignal.aborted).toBe(true)
  await act(async () => finishMore(page({ events: [attemptEvent({ teacher_feedback: 'OLD_PAGE_MUST_NOT_APPEAR' })], next_cursor: null })))
  expect(screen.queryByText('OLD_PAGE_MUST_NOT_APPEAR')).toBeNull()
  expect(screen.getByRole('button', { name: 'Load earlier records' })).toBeDisabled()
  await act(async () => finishFresh(page({ events: [missingSourceAttempt()], next_cursor: null })))
  expect(screen.queryByRole('heading', { name: 'Worksheet Tuesday' })).toBeNull()
  expect(screen.getByText(/Source labels: Older source alias/)).toBeVisible()
})

it('aborts a closed exact-report read and never shows it under a later report target', async () => {
  let finishOld!: (value: SavedTeachingReport) => void
  vi.mocked(api.getStudentCaseTimeline).mockResolvedValueOnce(page({ events: [reportEvent(), missingSourceAttempt()] }))
  vi.mocked(api.getTeachingReportRevision).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
  render(<StudentEvidenceTimeline caseId={caseId} workspaceId="class-a" refreshKey={1} />)
  await ready()
  openExact()
  const oldSignal = vi.mocked(api.getTeachingReportRevision).mock.calls[0][3]!
  fireEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' })[0])
  expect(oldSignal.aborted).toBe(true)
  const second = savedReport({ report_id: missingId, revision: 1, assignment: { ...savedReport().assignment, assignment_ref: 'Second fixed source', items: [{ ...savedReport().assignment.items[0], question: 'SECOND_EXACT_SOURCE_ONLY' }] } })
  vi.mocked(api.getTeachingReportRevision).mockResolvedValueOnce(second)
  fireEvent.click(screen.getByRole('button', { name: 'View original questions · Report version 1' }))
  const secondDialog = screen.getByRole('dialog', { name: 'Original material · Report version 1' })
  await within(secondDialog).findByText('SECOND_EXACT_SOURCE_ONLY')
  await act(async () => finishOld(savedReport({ analysis: { ...savedReport().analysis, summary: 'LATE_OLD_EXACT_SOURCE' } })))
  expect(within(secondDialog).queryByText('LATE_OLD_EXACT_SOURCE')).toBeNull()
  expect(within(secondDialog).getByText('SECOND_EXACT_SOURCE_ONLY')).toBeVisible()
})

it('does not invent report events when only unavailable sources or no links exist', async () => {
  const zero = counts({ linked_reports: 0, available_reports: 0, unavailable_reports: 0, confirmed_report_count: 0, stale_source_count: 0, report_items: 0, report_results: { correct: 0, partial: 0, incorrect: 0, ungraded: 0 }, attempts: 0, voided_attempts: 0, attempt_results: { correct: 0, partial: 0, incorrect: 0, ungraded: 0 }, attempt_assistance: { independent: 0, assisted: 0, unknown: 0 }, attempt_outcomes: assistance.flatMap(help => results.map(result => ({ assistance: help, teacher_result: result, count: 0 }))), total_events: 0 })
  vi.mocked(api.getStudentCaseTimeline).mockResolvedValueOnce(page({ counts: zero, source_states: [], events: [], next_cursor: null }))
  const view = render(<StudentEvidenceTimeline caseId={caseId} workspaceId="class-a" refreshKey={1} />)
  await screen.findByText(/Select and save an explicitly reviewed report version/)
  expect(within(timelineList()).queryAllByRole('listitem')).toHaveLength(0)
  vi.mocked(api.getStudentCaseTimeline).mockResolvedValueOnce(page({ case_revision: 2, counts: { ...zero, linked_reports: 1, unavailable_reports: 1 }, source_states: [page().source_states[1]], events: [], next_cursor: null }))
  view.rerender(<StudentEvidenceTimeline caseId={caseId} workspaceId="class-a" refreshKey={2} />)
  await screen.findByText(/The linked report versions are currently unavailable/)
  expect(within(timelineList()).queryAllByRole('listitem')).toHaveLength(0)
})

it('survives StrictMode effect replay with a new read and no stuck loading or automatic mutations', async () => {
  vi.mocked(api.getStudentCaseTimeline).mockImplementationOnce((_id, _query, _workspace, signal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })))
  render(<StrictMode><StudentEvidenceTimeline caseId={caseId} workspaceId="class-a" refreshKey={1} /></StrictMode>)
  await ready()
  expect(vi.mocked(api.getStudentCaseTimeline).mock.calls[0][3]!.aborted).toBe(true)
  expect(screen.getByRole('button', { name: 'Load earlier records' })).toBeEnabled()
  expect(api.saveStudentCase).not.toHaveBeenCalled()
})
