import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { PracticeFollowups } from '@/components/learning/teaching-analysis/PracticeFollowups'
import { exampleAssignment } from '@/components/learning/teaching-analysis/sample'
import { initI18n } from '@/i18n/init'
import { ApiError } from '@/shared/api/errors'
import type { SavedTeachingReport } from '@/lib/teaching-analysis-api'
import * as api from '@/lib/teaching-followups-api'

vi.mock('@/lib/teaching-followups-api', async original => ({
  ...(await original<typeof api>()),
  listTeachingFollowups: vi.fn(), getTeachingFollowup: vi.fn(), saveTeachingFollowup: vi.fn(),
  getTeachingFollowupRevisions: vi.fn(), listTeachingFollowupAttempts: vi.fn(),
  saveTeachingFollowupAttempt: vi.fn(), voidTeachingFollowupAttempt: vi.fn(),
}))
initI18n('en')

const reportId = 'efc43d95-2054-412d-814f-54c548b7a777'
const setId = '4bdc326c-2c22-4407-a4c7-1627ce191e4c'
const report = (change: Partial<SavedTeachingReport> = {}): SavedTeachingReport => ({
  report_id: reportId, revision: 1, status: 'confirmed', assignment: exampleAssignment('en'),
  analysis: {
    summary: 'Review unlike fraction units.',
    items: exampleAssignment('en').items.map(item => ({ question_id: item.question_id, result: 'ungraded', observation: 'Review the working.', evidence: [] })),
    priorities: [{
      knowledge_point: 'Fraction addition', observation: 'The denominator is added.', hypothesis: 'The units may be unclear.',
      alternative_explanation: 'A rule may have been recalled incorrectly.', teaching_action: 'Use equal units.',
      follow_up_question: 'Calculate 1/4 + 1/6 and show your working.', reference_guidance: 'Compare common units before adding.',
      evidence_status: 'needs_check', evidence: [],
    }], limitations: ['Synthetic worksheet only.'],
  }, source_fingerprint: 'a'.repeat(64), teacher_notes: '', created_at: 1, updated_at: 2,
  ...change,
})

const followup = (change: Partial<api.SavedFollowup> = {}): api.SavedFollowup => ({
  followup_id: setId, report_id: reportId, report_revision: 1, priority_index: 0,
  title: 'Fraction follow-up', questions: [{ question_id: 'F1', question: 'Calculate 1/4 + 1/6 and show your working.', reference_answer: '5/12', rubric: 'Use a common denominator.' }],
  revision: 1, student_ref: report().assignment.student_ref, assignment_ref: report().assignment.assignment_ref,
  subject: report().assignment.subject, grade: report().assignment.grade, source_fingerprint: 'a'.repeat(64),
  knowledge_point: 'Fraction addition', created_at: 10, updated_at: 10, ...change,
})

function attempt(change: Partial<api.SavedFollowupAttempt> = {}): api.SavedFollowupAttempt {
  const source = followup()
  return {
    attempt_id: '31755899-a857-4605-b0fb-c51e62410fbd', followup_id: source.followup_id,
    followup_revision: source.revision, report_id: source.report_id, report_revision: source.report_revision,
    priority_index: source.priority_index, question_id: 'F1', question_snapshot: source.questions[0],
    student_answer: '5/12', student_work: '3/12 + 2/12 = 5/12', answer_status: 'present',
    assistance: 'independent', teacher_result: 'correct', teacher_feedback: 'Independent transfer check.',
    student_ref: source.student_ref, assignment_ref: source.assignment_ref, subject: source.subject,
    grade: source.grade, source_fingerprint: source.source_fingerprint, knowledge_point: source.knowledge_point,
    created_at: 100, voided_at: null, void_reason: null, ...change,
  }
}

let stored: api.SavedFollowup
let attemptSequence: number

beforeEach(() => {
  vi.clearAllMocks()
  stored = followup()
  attemptSequence = 0
  vi.mocked(api.listTeachingFollowups).mockResolvedValue([])
  vi.mocked(api.getTeachingFollowup).mockImplementation(async () => stored)
  vi.mocked(api.saveTeachingFollowup).mockImplementation(async payload => {
    const { expected_revision, ...content } = payload
    stored = followup({ ...content, revision: expected_revision + 1, updated_at: 20 })
    return stored
  })
  vi.mocked(api.listTeachingFollowupAttempts).mockResolvedValue([])
  vi.mocked(api.getTeachingFollowupRevisions).mockImplementation(async () => [stored])
  vi.mocked(api.saveTeachingFollowupAttempt).mockImplementation(async (_id, payload) => {
    attemptSequence++
    return attempt({ ...payload, followup_revision: stored.revision, question_snapshot: stored.questions.find(question => question.question_id === payload.question_id)!, created_at: 100 + attemptSequence })
  })
  vi.mocked(api.voidTeachingFollowupAttempt).mockImplementation(async (_id, id, reason) => attempt({ attempt_id: id, voided_at: 200, void_reason: reason }))
})

async function openSaved(props: Partial<Parameters<typeof PracticeFollowups>[0]> = {}) {
  vi.mocked(api.listTeachingFollowups).mockResolvedValue([stored])
  const view = render(<PracticeFollowups report={report()} workspaceId="class-a" {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /Fraction follow-up/ }))
  await screen.findByRole('heading', { name: 'Record a new response' })
  await screen.findByText('No responses recorded for this practice yet.')
  return view
}

async function startDraft() {
  render(<PracticeFollowups report={report()} workspaceId="class-a" />)
  await screen.findByText('No practice saved for this report yet.')
  fireEvent.click(screen.getByRole('button', { name: 'Prepare practice · Fraction addition' }))
}

it('requires an explicitly confirmed report for new questions without hiding saved responses', async () => {
  await openSaved({ report: report({ status: 'draft' }), canCreate: false })
  expect(screen.getByRole('button', { name: 'Prepare practice · Fraction addition' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Revise practice questions' })).toBeDisabled()
  expect(screen.getByText(/Save and confirm the current report/)).toBeVisible()
  expect(screen.getByLabelText('F1 · Student answer')).toBeVisible()
  expect(api.saveTeachingFollowup).not.toHaveBeenCalled()
})

it('copies the suggested check as a reviewed draft, keeps the answer empty and allows at most three questions', async () => {
  await startDraft()
  expect(screen.getByLabelText('Practice item 1 · Question')).toHaveValue(report().analysis.priorities[0].follow_up_question)
  expect(screen.getByLabelText('Practice item 1 · Reference answer (optional)')).toHaveValue('')
  expect(screen.getByLabelText('Practice item 1 · Marking guidance (optional)')).toHaveValue(report().analysis.priorities[0].reference_guidance)
  expect(api.saveTeachingFollowup).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Add a practice question' }))
  fireEvent.change(screen.getByLabelText('Practice item 2 · Question'), { target: { value: 'Explain why unlike fraction units need a common denominator.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add a practice question' }))
  fireEvent.change(screen.getByLabelText('Practice item 3 · Question'), { target: { value: 'Compute 1/3 + 1/8.' } })
  expect(screen.getByRole('button', { name: 'Add a practice question' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Questions checked · Save practice' }))
  await screen.findByText('Practice saved. New responses will use this question version.')
  const payload = vi.mocked(api.saveTeachingFollowup).mock.calls[0][0]
  expect(payload).toMatchObject({ expected_revision: 0, report_id: reportId, report_revision: 1, priority_index: 0 })
  expect(payload.questions).toHaveLength(3)
  expect(payload.questions[0].reference_answer).toBeNull()
  expect(api.saveTeachingFollowup).toHaveBeenCalledWith(payload, 'class-a', expect.any(AbortSignal))
})

it('retains a failed practice draft and retries the same identity and content', async () => {
  vi.mocked(api.saveTeachingFollowup).mockRejectedValueOnce(new Error('Practice storage unavailable'))
  await startDraft()
  fireEvent.change(screen.getByLabelText('Practice title'), { target: { value: 'Teacher-reviewed local title' } })
  fireEvent.click(screen.getByRole('button', { name: 'Questions checked · Save practice' }))
  await screen.findByText('Practice storage unavailable')
  expect(screen.getByLabelText('Practice title')).toHaveValue('Teacher-reviewed local title')
  fireEvent.click(screen.getByRole('button', { name: 'Questions checked · Save practice' }))
  await screen.findByText('Practice saved. New responses will use this question version.')
  expect(vi.mocked(api.saveTeachingFollowup).mock.calls[0][0]).toEqual(vi.mocked(api.saveTeachingFollowup).mock.calls[1][0])
})

it('preserves edits on a source or question-version conflict instead of replacing local questions', async () => {
  vi.mocked(api.saveTeachingFollowup).mockRejectedValueOnce(new ApiError({ code: 'http_409', message: 'Source report changed', status: 409, retryable: false, scope: 'network' }))
  await startDraft()
  fireEvent.change(screen.getByLabelText('Practice item 1 · Question'), { target: { value: 'Keep this local variation.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Questions checked · Save practice' }))
  await screen.findByText(/The report or practice has a newer saved version/)
  expect(screen.getByLabelText('Practice item 1 · Question')).toHaveValue('Keep this local variation.')
  expect(screen.getByRole('button', { name: 'Questions checked · Save practice' })).toBeDisabled()
})

it('revises a stable concern against a newer confirmed source report while keeping the set identity', async () => {
  await openSaved({ report: report({ revision: 2 }) })
  expect(screen.getByText(/This practice uses source report version 1/)).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Revise practice questions' }))
  fireEvent.change(screen.getByLabelText('Practice item 1 · Question'), { target: { value: 'A reviewed new question.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Questions checked · Save practice' }))
  await screen.findByText('Practice saved. New responses will use this question version.')
  expect(vi.mocked(api.saveTeachingFollowup).mock.calls[0][0]).toMatchObject({ followup_id: setId, expected_revision: 1, report_id: reportId, report_revision: 2 })
})

it('does not rebind a saved set to another student and displays the original source of past responses', async () => {
  const changedReport = report({ revision: 2, assignment: { ...report().assignment, student_ref: 'Different synthetic student' } })
  vi.mocked(api.listTeachingFollowupAttempts).mockResolvedValue([attempt()])
  vi.mocked(api.listTeachingFollowups).mockResolvedValue([stored])
  render(<PracticeFollowups report={changedReport} workspaceId="class-a" />)
  fireEvent.click(await screen.findByRole('button', { name: /Fraction follow-up/ }))
  const history = await screen.findByRole('region', { name: 'Response history (1)' })
  expect(screen.getByRole('button', { name: 'Revise practice questions' })).toBeDisabled()
  expect(within(history).getByText(/example-student-A.*example-fractions-01.*Source report version 1/)).toBeVisible()
  expect(within(history).queryByText(/Different synthetic student/)).toBeNull()
  expect(screen.getByRole('button', { name: 'Prepare practice · Fraction addition' })).toBeEnabled()
})

it('records actual work with explicit teacher review, retries the same attempt and preserves each later attempt', async () => {
  vi.mocked(api.saveTeachingFollowupAttempt).mockRejectedValueOnce(new Error('Response storage unavailable'))
  await openSaved()
  fireEvent.change(screen.getByLabelText('F1 · Student working'), { target: { value: '3/12 + 2/12 = 5/12' } })
  expect(screen.getByLabelText('F1 · Response status')).toHaveValue('present')
  expect(screen.getByLabelText('F1 · Teacher evaluation')).toHaveValue('ungraded')
  fireEvent.change(screen.getByLabelText('F1 · Help used'), { target: { value: 'assisted' } })
  fireEvent.change(screen.getByLabelText('F1 · Teacher evaluation'), { target: { value: 'correct' } })
  fireEvent.click(screen.getByRole('button', { name: 'Record response · F1' }))
  await screen.findByText('Response storage unavailable')
  expect(screen.getByLabelText('F1 · Student working')).toHaveValue('3/12 + 2/12 = 5/12')
  fireEvent.click(screen.getByRole('button', { name: 'Record response · F1' }))
  await screen.findByRole('region', { name: 'Response history (1)' })
  const calls = vi.mocked(api.saveTeachingFollowupAttempt).mock.calls
  expect(calls[0][1]).toEqual(calls[1][1])
  expect(calls[1][1]).toMatchObject({ answer_status: 'present', student_answer: null, student_work: '3/12 + 2/12 = 5/12', assistance: 'assisted', teacher_result: 'correct' })
  expect(screen.getByLabelText('F1 · Student working')).toHaveValue('')
  fireEvent.change(screen.getByLabelText('F1 · Student answer'), { target: { value: '5/12' } })
  fireEvent.change(screen.getByLabelText('F1 · Help used'), { target: { value: 'independent' } })
  fireEvent.click(screen.getByRole('button', { name: 'Record response · F1' }))
  await screen.findByRole('region', { name: 'Response history (2)' })
  const allCalls = vi.mocked(api.saveTeachingFollowupAttempt).mock.calls
  expect(allCalls[2][1].attempt_id).not.toBe(allCalls[1][1].attempt_id)
  expect(allCalls[2][1].teacher_result).toBe('ungraded')
})

it('keeps a confirmed blank ungraded with explicit empty values and an unknown response distinct', async () => {
  await openSaved()
  expect(screen.getByLabelText('F1 · Teacher evaluation')).toBeDisabled()
  fireEvent.change(screen.getByLabelText('F1 · Response status'), { target: { value: 'confirmed_blank' } })
  expect(screen.getByLabelText('F1 · Student answer')).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Record response · F1' }))
  await screen.findByRole('region', { name: 'Response history (1)' })
  expect(vi.mocked(api.saveTeachingFollowupAttempt).mock.calls[0][1]).toMatchObject({ answer_status: 'confirmed_blank', student_answer: '', student_work: '', teacher_result: 'ungraded' })
  expect(screen.getByLabelText('F1 · Response status')).toHaveValue('unknown')
  fireEvent.change(screen.getByLabelText('F1 · Teacher feedback'), { target: { value: 'The response was not supplied with this worksheet.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Record response · F1' }))
  await screen.findByRole('region', { name: 'Response history (2)' })
  expect(vi.mocked(api.saveTeachingFollowupAttempt).mock.calls[1][1]).toMatchObject({ answer_status: 'unknown', student_answer: null, student_work: null, teacher_result: 'ungraded' })
})

it('shows immutable old question versions and voids a record without erasing its answer or teacher review', async () => {
  stored = followup({ revision: 2, questions: [{ question_id: 'F1', question: 'Current revised question.', reference_answer: 'Revised key.', rubric: 'Revised rubric.' }] })
  vi.mocked(api.listTeachingFollowups).mockResolvedValue([stored])
  vi.mocked(api.listTeachingFollowupAttempts).mockResolvedValue([attempt({ teacher_feedback: 'Keep the original teacher note.' })])
  vi.mocked(api.getTeachingFollowupRevisions).mockResolvedValue([stored, followup()])
  render(<PracticeFollowups report={report()} workspaceId="class-a" />)
  fireEvent.click(await screen.findByRole('button', { name: /Fraction follow-up/ }))
  const history = await screen.findByRole('region', { name: 'Response history (1)' })
  fireEvent.click(within(history).getByText('Question and marking guidance used for this response'))
  expect(within(history).getByText('Calculate 1/4 + 1/6 and show your working.')).toBeVisible()
  expect(within(history).queryByText('Current revised question.')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Question version history' }))
  const questionVersions = await screen.findByRole('region', { name: 'Question version history' })
  expect(within(questionVersions).getByText('Current revised question.')).toBeInTheDocument()
  expect(within(questionVersions).getByText('Calculate 1/4 + 1/6 and show your working.')).toBeInTheDocument()
  fireEvent.click(within(history).getByRole('button', { name: 'Void this record' }))
  const dialog = screen.getByRole('dialog', { name: 'Void a response record' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm void' }))
  expect(api.voidTeachingFollowupAttempt).not.toHaveBeenCalled()
  fireEvent.change(within(dialog).getByLabelText('Reason for voiding'), { target: { value: 'The reference key needs correction.' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm void' }))
  await screen.findByText('The record was voided; its original response is preserved.')
  expect(within(history).getByText('Voided')).toBeVisible()
  expect(within(history).getByText('Teacher evaluation · Correct in this item')).toHaveClass('line-through')
  expect(within(history).getByText(/3\/12 \+ 2\/12 = 5\/12/)).toBeVisible()
  expect(api.voidTeachingFollowupAttempt).toHaveBeenCalledWith(setId, attempt().attempt_id, 'The reference key needs correction.', 'class-a', expect.any(AbortSignal))
})

it('reports all local unsaved work to the parent and requires confirmation before replacing it', async () => {
  const onDirty = vi.fn()
  await openSaved({ onDirtyChange: onDirty })
  fireEvent.change(screen.getByLabelText('F1 · Student answer'), { target: { value: 'Local response to keep.' } })
  await waitFor(() => expect(onDirty).toHaveBeenLastCalledWith(true))
  fireEvent.click(screen.getByRole('button', { name: 'Prepare practice · Fraction addition' }))
  const dialog = screen.getByRole('dialog', { name: 'Replace unsaved practice work?' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(screen.getByLabelText('F1 · Student answer')).toHaveValue('Local response to keep.')
  fireEvent.click(screen.getByRole('button', { name: 'Record response · F1' }))
  await screen.findByRole('region', { name: 'Response history (1)' })
  await waitFor(() => expect(onDirty).toHaveBeenLastCalledWith(false))
  fireEvent.click(screen.getByRole('button', { name: 'Void this record' }))
  fireEvent.change(screen.getByLabelText('Reason for voiding'), { target: { value: 'Unsaved local reason.' } })
  await waitFor(() => expect(onDirty).toHaveBeenLastCalledWith(true))
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Void a response record' })).getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(onDirty).toHaveBeenLastCalledWith(false))
})

it('aborts old-scope loading and refuses late responses after the report or workspace changes', async () => {
  let resolveOld!: (value: api.SavedFollowup[]) => void
  vi.mocked(api.listTeachingFollowups).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
  const onDirty = vi.fn()
  const view = render(<PracticeFollowups report={report()} workspaceId="class-a" onDirtyChange={onDirty} />)
  const signal = vi.mocked(api.listTeachingFollowups).mock.calls[0][2]!
  view.rerender(<PracticeFollowups report={report({ revision: 2 })} workspaceId="class-b" onDirtyChange={onDirty} />)
  expect(signal.aborted).toBe(true)
  await screen.findByText('No practice saved for this report yet.')
  await act(async () => resolveOld([followup()]))
  expect(screen.queryByRole('button', { name: /Fraction follow-up/ })).toBeNull()
  expect(api.listTeachingFollowups).toHaveBeenLastCalledWith(reportId, 'class-b', expect.any(AbortSignal))
})

it('ignores a late response save after a workspace switch', async () => {
  let resolveOld!: (value: api.SavedFollowupAttempt) => void
  vi.mocked(api.saveTeachingFollowupAttempt).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
  const view = await openSaved()
  fireEvent.change(screen.getByLabelText('F1 · Student answer'), { target: { value: '5/12' } })
  fireEvent.click(screen.getByRole('button', { name: 'Record response · F1' }))
  const signal = vi.mocked(api.saveTeachingFollowupAttempt).mock.calls[0][3]!
  vi.mocked(api.listTeachingFollowups).mockResolvedValue([])
  view.rerender(<PracticeFollowups report={report()} workspaceId="class-b" />)
  expect(signal.aborted).toBe(true)
  await act(async () => resolveOld(attempt()))
  await screen.findByText('No practice saved for this report yet.')
  expect(screen.queryByRole('region', { name: 'Response history (1)' })).toBeNull()
})

it('pins real API requests to the explicit workspace and preserves nullable defaults', async () => {
  const real = await vi.importActual<typeof api>('@/lib/teaching-followups-api')
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([followup()]), { status: 200 }))
  const controller = new AbortController()
  const sets = await real.listTeachingFollowups(reportId, 'class-b', controller.signal)
  expect(sets[0].questions[0]).toMatchObject({ reference_answer: '5/12', rubric: 'Use a common denominator.' })
  const [url, options] = fetcher.mock.calls[0]
  expect(String(url)).toContain(`report_id=${reportId}`)
  expect(String(url)).toContain('dt_workspace=class-b')
  expect(options).toMatchObject({ signal: controller.signal, credentials: 'include', cache: 'no-store' })
})

it('does not let a slow initial list erase a newly saved practice set', async () => {
  let resolveList!: (value: api.SavedFollowup[]) => void
  vi.mocked(api.listTeachingFollowups).mockImplementationOnce(() => new Promise(resolve => { resolveList = resolve }))
  render(<PracticeFollowups report={report()} workspaceId="class-a" />)
  fireEvent.click(screen.getByRole('button', { name: 'Prepare practice · Fraction addition' }))
  fireEvent.click(screen.getByRole('button', { name: 'Questions checked · Save practice' }))
  await screen.findByText('Practice saved. New responses will use this question version.')
  await act(async () => resolveList([]))
  expect(screen.getByRole('button', { name: /Fraction addition · Follow-up practice/ })).toBeVisible()
  expect(screen.queryByText('No practice saved for this report yet.')).toBeNull()
})

it('does not let a slow response-list read erase a newly recorded response', async () => {
  let resolveAttempts!: (value: api.SavedFollowupAttempt[]) => void
  vi.mocked(api.listTeachingFollowups).mockResolvedValue([stored])
  vi.mocked(api.listTeachingFollowupAttempts).mockImplementationOnce(() => new Promise(resolve => { resolveAttempts = resolve }))
  render(<PracticeFollowups report={report()} workspaceId="class-a" />)
  fireEvent.click(await screen.findByRole('button', { name: /Fraction follow-up/ }))
  await screen.findByRole('heading', { name: 'Record a new response' })
  fireEvent.change(screen.getByLabelText('F1 · Student answer'), { target: { value: '5/12' } })
  fireEvent.click(screen.getByRole('button', { name: 'Record response · F1' }))
  await screen.findByRole('region', { name: 'Response history (1)' })
  await act(async () => resolveAttempts([]))
  expect(screen.getByRole('region', { name: 'Response history (1)' })).toBeVisible()
})

it('does not let a slow refresh undo a just-saved void receipt', async () => {
  vi.mocked(api.listTeachingFollowups).mockResolvedValue([stored])
  let resolveRefresh!: (value: api.SavedFollowupAttempt[]) => void
  // The pending refresh follows the initial successful history read.
  vi.mocked(api.listTeachingFollowupAttempts).mockReset().mockResolvedValueOnce([attempt()]).mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve }))
  render(<PracticeFollowups report={report()} workspaceId="class-a" />)
  fireEvent.click(await screen.findByRole('button', { name: /Fraction follow-up/ }))
  await screen.findByRole('region', { name: 'Response history (1)' })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh responses' }))
  fireEvent.click(screen.getByRole('button', { name: 'Void this record' }))
  fireEvent.change(screen.getByLabelText('Reason for voiding'), { target: { value: 'The key was mistaken.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Confirm void' }))
  await screen.findByText('The record was voided; its original response is preserved.')
  await act(async () => resolveRefresh([attempt()]))
  expect(screen.getByText('Voided')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Void this record' })).toBeNull()
})

it('marks a response clean again when all entered content and evaluation settings return to their defaults', async () => {
  const onDirty = vi.fn()
  await openSaved({ onDirtyChange: onDirty })
  fireEvent.change(screen.getByLabelText('F1 · Student answer'), { target: { value: '5/12' } })
  fireEvent.change(screen.getByLabelText('F1 · Student working'), { target: { value: '3/12 + 2/12' } })
  fireEvent.change(screen.getByLabelText('F1 · Teacher feedback'), { target: { value: 'Review this response.' } })
  fireEvent.change(screen.getByLabelText('F1 · Help used'), { target: { value: 'independent' } })
  fireEvent.change(screen.getByLabelText('F1 · Teacher evaluation'), { target: { value: 'correct' } })
  await waitFor(() => expect(onDirty).toHaveBeenLastCalledWith(true))
  fireEvent.change(screen.getByLabelText('F1 · Student answer'), { target: { value: '' } })
  fireEvent.change(screen.getByLabelText('F1 · Student working'), { target: { value: '' } })
  fireEvent.change(screen.getByLabelText('F1 · Teacher feedback'), { target: { value: '' } })
  expect(onDirty).toHaveBeenLastCalledWith(true)
  fireEvent.change(screen.getByLabelText('F1 · Help used'), { target: { value: 'unknown' } })
  await waitFor(() => expect(onDirty).toHaveBeenLastCalledWith(false))
  expect(screen.getByLabelText('F1 · Response status')).toHaveValue('unknown')
  expect(screen.getByLabelText('F1 · Teacher evaluation')).toHaveValue('ungraded')
  expect(api.saveTeachingFollowupAttempt).not.toHaveBeenCalled()
})

it('clears only an unsubmitted response after failure, preserves saved history and starts a new submission identity', async () => {
  const onDirty = vi.fn()
  vi.mocked(api.listTeachingFollowups).mockResolvedValue([stored])
  vi.mocked(api.listTeachingFollowupAttempts).mockResolvedValue([attempt()])
  vi.mocked(api.saveTeachingFollowupAttempt).mockRejectedValueOnce(new Error('Temporary response failure'))
  render(<PracticeFollowups report={report()} workspaceId="class-a" onDirtyChange={onDirty} />)
  fireEvent.click(await screen.findByRole('button', { name: /Fraction follow-up/ }))
  const history = await screen.findByRole('region', { name: 'Response history (1)' })
  const originalHistory = history.textContent
  fireEvent.change(screen.getByLabelText('F1 · Student answer'), { target: { value: 'A new response that has not been saved.' } })
  fireEvent.change(screen.getByLabelText('F1 · Teacher feedback'), { target: { value: 'Local feedback to discard.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Record response · F1' }))
  await screen.findByText('Temporary response failure')
  const failedSubmissionId = vi.mocked(api.saveTeachingFollowupAttempt).mock.calls[0][1].attempt_id
  fireEvent.click(screen.getByRole('button', { name: 'Clear this response' }))
  await waitFor(() => expect(onDirty).toHaveBeenLastCalledWith(false))
  expect(screen.getByLabelText('F1 · Student answer')).toHaveValue('')
  expect(screen.getByLabelText('F1 · Teacher feedback')).toHaveValue('')
  expect(screen.queryByText('Temporary response failure')).toBeNull()
  expect(history.textContent).toBe(originalHistory)
  expect(api.voidTeachingFollowupAttempt).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('F1 · Student answer'), { target: { value: 'A separate new response.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Record response · F1' }))
  await screen.findByRole('region', { name: 'Response history (2)' })
  expect(vi.mocked(api.saveTeachingFollowupAttempt).mock.calls[1][1].attempt_id).not.toBe(failedSubmissionId)
})

it('updates the visible library row after an explicit reload of a newer practice revision', async () => {
  vi.mocked(api.saveTeachingFollowup).mockRejectedValueOnce(new ApiError({ code: 'http_409', message: 'Practice was revised elsewhere', status: 409, retryable: false, scope: 'network' }))
  await openSaved()
  fireEvent.click(screen.getByRole('button', { name: 'Revise practice questions' }))
  fireEvent.change(screen.getByLabelText('Practice title'), { target: { value: 'Local title to keep until confirmed discard.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Questions checked · Save practice' }))
  await screen.findByText(/The report or practice has a newer saved version/)
  stored = followup({ revision: 3, title: 'Latest remote practice title' })
  fireEvent.click(screen.getByRole('button', { name: 'Reload latest practice' }))
  const dialog = screen.getByRole('dialog', { name: 'Replace unsaved practice work?' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Discard and continue' }))
  expect(await screen.findByRole('button', { name: /Latest remote practice title.*Revision 3/ })).toBeVisible()
  expect(screen.queryByRole('button', { name: /Fraction follow-up.*Revision 1/ })).toBeNull()
  expect(screen.getByRole('heading', { name: 'Latest remote practice title' })).toBeVisible()
})

it('offers the parent source-report reload for a source conflict without discarding the practice draft itself', async () => {
  const onReloadReport = vi.fn()
  vi.mocked(api.saveTeachingFollowup).mockRejectedValueOnce(new ApiError({ code: 'teaching_followup_source_changed', message: 'Source report changed', status: 409, retryable: false, scope: 'network' }))
  render(<PracticeFollowups report={report()} workspaceId="class-a" onReloadReport={onReloadReport} />)
  await screen.findByText('No practice saved for this report yet.')
  fireEvent.click(screen.getByRole('button', { name: 'Prepare practice · Fraction addition' }))
  fireEvent.change(screen.getByLabelText('Practice item 1 · Question'), { target: { value: 'Unsaved practice that needs an explicit discard decision.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Questions checked · Save practice' }))
  const reload = await screen.findByRole('button', { name: 'Reload source report' })
  expect(screen.queryByRole('button', { name: 'Reload latest practice' })).toBeNull()
  fireEvent.click(reload)
  expect(onReloadReport).toHaveBeenCalledTimes(1)
  expect(screen.getByLabelText('Practice item 1 · Question')).toHaveValue('Unsaved practice that needs an explicit discard decision.')
  expect(api.getTeachingFollowup).not.toHaveBeenCalled()
})
