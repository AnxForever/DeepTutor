import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { StrictMode, useMemo, useState } from 'react'
import { PracticeFollowups } from '@/components/learning/teaching-analysis/PracticeFollowups'
import { TeachingDraftProvider, useTeachingDraftSlot } from '@/components/learning/teaching-analysis/TeachingDrafts'
import { exampleAssignment } from '@/components/learning/teaching-analysis/sample'
import {
  followupResponseSlot, followupWorkspaceSlot, isFollowupResponseDraft, isFollowupWorkspaceDraft,
  sameSavedFollowup, type FollowupResponseDraft, type FollowupWorkspaceDraft,
} from '@/lib/teaching-followup-drafts'
import type { TeachingDraftRecord, TeachingDraftRepository, TeachingDraftScope } from '@/lib/teaching-drafts'
import type { SavedTeachingReport } from '@/lib/teaching-analysis-api'
import { initI18n } from '@/i18n/init'
import * as api from '@/lib/teaching-followups-api'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/lib/teaching-followups-api', async original => ({
  ...(await original<typeof api>()), listTeachingFollowups: vi.fn(), getTeachingFollowup: vi.fn(), saveTeachingFollowup: vi.fn(),
  getTeachingFollowupRevisions: vi.fn(), listTeachingFollowupAttempts: vi.fn(), saveTeachingFollowupAttempt: vi.fn(), voidTeachingFollowupAttempt: vi.fn(),
}))
initI18n('en')
const scope = { accountId: 'teacher-a', workspaceId: 'class-a' }
const reportId = 'efc43d95-2054-412d-814f-54c548b7a777'
const setId = '4bdc326c-2c22-4407-a4c7-1627ce191e4c'
const attemptId = '31755899-a857-4605-b0fb-c51e62410fbd'
const workspaceSlot = followupWorkspaceSlot(reportId, 1)
const responseSlot = followupResponseSlot(setId, 1, 'F1')

function report(): SavedTeachingReport {
  const assignment = exampleAssignment('en')
  return {
    report_id: reportId, revision: 1, status: 'confirmed', assignment, teacher_notes: '', source_fingerprint: 'a'.repeat(64), created_at: 1, updated_at: 1,
    analysis: { summary: 'Synthetic fraction work.', items: assignment.items.map(item => ({ question_id: item.question_id, result: 'ungraded', observation: 'Review the work.', evidence: [] })), priorities: [{ knowledge_point: 'Fraction addition', observation: 'Check units.', hypothesis: 'Units may be unclear.', alternative_explanation: 'Check the recalled rule.', teaching_action: 'Explain equal units.', follow_up_question: 'Calculate 1/4 + 1/6.', reference_guidance: 'Use a common denominator.', evidence_status: 'needs_check', evidence: [] }], limitations: [] },
  }
}
function set(change: Partial<api.SavedFollowup> = {}): api.SavedFollowup {
  const source = report()
  return {
    followup_id: setId, report_id: reportId, report_revision: 1, priority_index: 0, title: 'Fraction follow-up', revision: 1,
    questions: [{ question_id: 'F1', question: 'Calculate 1/4 + 1/6.', reference_answer: '5/12', rubric: 'Use a common denominator.' }],
    student_ref: source.assignment.student_ref, assignment_ref: source.assignment.assignment_ref, subject: source.assignment.subject, grade: source.assignment.grade,
    source_fingerprint: source.source_fingerprint, knowledge_point: 'Fraction addition', created_at: 10, updated_at: 10, ...change,
  }
}
const pendingResponse = (): api.SaveFollowupAttemptRequest => ({ attempt_id: attemptId, followup_revision: 1, question_id: 'F1', student_answer: '5/12', student_work: '3/12 + 2/12 = 5/12', answer_status: 'present', assistance: 'independent', teacher_result: 'correct', teacher_feedback: 'Teacher note still awaiting submission.' })
function workspace(change: Partial<FollowupWorkspaceDraft> = {}): FollowupWorkspaceDraft {
  return { kind: 'followup-workspace', version: 1, report_id: reportId, report_revision: 1, draft: null, selected: set(), void_target: null, void_reason: '', ...change }
}
function response(change: Partial<FollowupResponseDraft> = {}): FollowupResponseDraft {
  return { kind: 'followup-response', version: 1, followup_id: setId, followup_revision: 1, question_id: 'F1', question_snapshot: set().questions[0], payload: pendingResponse(), ...change }
}
function row(slot: string, value: unknown): TeachingDraftRecord { return { ...scope, slot, version: 1, value, updatedAt: 1 } }

function memoryRepository(initial: TeachingDraftRecord[]) {
  const rows = new Map(initial.map(record => [JSON.stringify([record.accountId, record.workspaceId, record.slot]), structuredClone(record)]))
  const key = (current: TeachingDraftScope, slot: string) => JSON.stringify([current.accountId, current.workspaceId, slot])
  const repository: TeachingDraftRepository = {
    read: vi.fn(async current => Array.from(rows.values()).filter(record => record.accountId === current.accountId && record.workspaceId === current.workspaceId).map(record => structuredClone(record))),
    write: vi.fn(async (current, slot, value) => { rows.set(key(current, slot), { ...current, slot, version: 1, value: structuredClone(value), updatedAt: Date.now() }) }),
    clear: vi.fn(async (current, slot) => { rows.delete(key(current, slot)) }),
  }
  return { repository, rows, get: (slot: string) => rows.get(key(scope, slot)) }
}
function mount(repository: TeachingDraftRepository) {
  return render(<TeachingDraftProvider {...scope} repository={repository}><PracticeFollowups report={report()} workspaceId={scope.workspaceId} /></TeachingDraftProvider>)
}
function MountAfterPrimaryRestore() {
  type ContextDraft = { version: 1; show: boolean }
  const [show, setShow] = useState(false)
  const value = useMemo<ContextDraft>(() => ({ version: 1, show }), [show])
  useTeachingDraftSlot<ContextDraft>({
    slot: 'primary', value, dirty: false,
    validate: (candidate): candidate is ContextDraft => Boolean(candidate && typeof candidate === 'object' && (candidate as ContextDraft).version === 1 && typeof (candidate as ContextDraft).show === 'boolean'),
    onRestore: restored => setShow(restored.show),
  })
  return show ? <PracticeFollowups report={report()} workspaceId={scope.workspaceId} /> : <p>The source report context has not been restored yet.</p>
}
function mountStrict(repository: TeachingDraftRepository) {
  return render(<StrictMode><TeachingDraftProvider {...scope} repository={repository}><MountAfterPrimaryRestore /></TeachingDraftProvider></StrictMode>)
}
async function restore() {
  const button = await screen.findByRole('button', { name: 'Restore local draft' })
  await act(async () => { fireEvent.click(button); await Promise.resolve() })
}
async function readyResponse() {
  await waitFor(() => expect(screen.getByLabelText('F1 · Student answer')).toHaveValue('5/12'))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Record response · F1' })).toBeEnabled())
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.listTeachingFollowups).mockResolvedValue([set()])
  vi.mocked(api.getTeachingFollowup).mockResolvedValue(set())
  vi.mocked(api.listTeachingFollowupAttempts).mockResolvedValue([])
  vi.mocked(api.getTeachingFollowupRevisions).mockResolvedValue([set()])
  vi.mocked(api.saveTeachingFollowup).mockImplementation(async payload => { const { expected_revision, ...content } = payload; return set({ ...content, revision: expected_revision + 1 }) })
  vi.mocked(api.saveTeachingFollowupAttempt).mockImplementation(async (_id, payload) => ({
    ...payload, followup_id: setId, report_id: reportId, report_revision: 1, priority_index: 0, question_snapshot: set().questions[0],
    student_ref: set().student_ref, assignment_ref: set().assignment_ref, subject: set().subject, grade: set().grade, knowledge_point: set().knowledge_point,
    source_fingerprint: 'a'.repeat(64), created_at: 100, voided_at: null, void_reason: null,
  }))
})

it('validates incomplete practice edits without accepting broken identities or invalid response states', () => {
  const draft = workspace({ selected: null, draft: { followup_id: setId, expected_revision: 0, report_id: reportId, report_revision: 1, priority_index: 0, title: '', questions: [{ question_id: '', question: '', reference_answer: null, rubric: null }] } })
  expect(isFollowupWorkspaceDraft(draft)).toBe(true)
  expect(sameSavedFollowup(structuredClone(set()), set())).toBe(true)
  expect(isFollowupWorkspaceDraft({ ...draft, version: 2 })).toBe(false)
  expect(isFollowupWorkspaceDraft({ ...draft, hidden: () => 'not JSON' })).toBe(false)
  expect(isFollowupWorkspaceDraft(workspace({ report_id: '8db2cc43-4bd2-4307-948f-bf29b1218da8' }))).toBe(false)
  expect(isFollowupResponseDraft(response())).toBe(true)
  expect(isFollowupResponseDraft(response({ question_id: 'F2' }))).toBe(false)
  expect(isFollowupResponseDraft(response({ payload: { ...pendingResponse(), answer_status: 'unknown', student_answer: null, teacher_result: 'correct' } }))).toBe(false)
  expect(isFollowupResponseDraft(response({ payload: { ...pendingResponse(), answer_status: 'confirmed_blank', student_answer: null, student_work: null, teacher_result: 'ungraded' } }))).toBe(false)
})

it('restores an unsaved question draft with its original identity without saving or approving it', async () => {
  const pending = workspace({ selected: null, draft: { followup_id: setId, expected_revision: 0, report_id: reportId, report_revision: 1, priority_index: 0, title: 'Unfinished local practice', questions: [{ question_id: 'F1', question: 'A teacher variation still being reviewed.', reference_answer: null, rubric: null }] } })
  const memory = memoryRepository([row(workspaceSlot, pending)])
  mount(memory.repository)
  await restore()
  expect(await screen.findByLabelText('Practice title')).toHaveValue('Unfinished local practice')
  expect(api.saveTeachingFollowup).not.toHaveBeenCalled()
  expect(api.getTeachingFollowup).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Questions checked · Save practice' }))
  await screen.findByText('Practice saved. New responses will use this question version.')
  expect(vi.mocked(api.saveTeachingFollowup).mock.calls[0][0].followup_id).toBe(setId)
  await waitFor(() => expect(memory.get(workspaceSlot)).toBeUndefined())
})

it('stages selected-practice and response restoration, verifies the saved version and retains the attempt UUID', async () => {
  const memory = memoryRepository([row(workspaceSlot, workspace()), row(responseSlot, response())])
  mount(memory.repository)
  await restore()
  await readyResponse()
  expect(screen.getByLabelText('F1 · Teacher feedback')).toHaveValue(pendingResponse().teacher_feedback)
  expect(api.getTeachingFollowup).toHaveBeenCalledWith(setId, 'class-a', expect.any(AbortSignal))
  expect(api.saveTeachingFollowup).not.toHaveBeenCalled()
  expect(api.saveTeachingFollowupAttempt).not.toHaveBeenCalled()
  expect(screen.getByText(/A local pending response was restored/)).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Record response · F1' }))
  await screen.findByRole('region', { name: 'Response history (1)' })
  expect(vi.mocked(api.saveTeachingFollowupAttempt).mock.calls[0][1]).toEqual(pendingResponse())
  await waitFor(() => expect(memory.get(responseSlot)).toBeUndefined())
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(memory.get(responseSlot)).toBeUndefined()
})

it('does not use a cached saved question as authorization or silently replace a stale pending answer', async () => {
  const memory = memoryRepository([row(workspaceSlot, workspace()), row(responseSlot, response())])
  vi.mocked(api.getTeachingFollowup).mockResolvedValue(set({ revision: 2, questions: [{ ...set().questions[0], question: 'A different saved version.' }] }))
  mount(memory.repository)
  await restore()
  await waitFor(() => expect(screen.getByLabelText('F1 · Student answer')).toHaveValue('5/12'))
  await screen.findByText(/The restored questions could not be matched to the current saved version/)
  expect(screen.getByRole('button', { name: 'Record response · F1' })).toBeDisabled()
  expect(api.saveTeachingFollowupAttempt).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Retry question verification' }))
  await waitFor(() => expect(api.getTeachingFollowup).toHaveBeenCalledTimes(2))
  await screen.findByText(/The restored questions could not be matched to the current saved version/)
  expect(screen.getByRole('button', { name: 'Record response · F1' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Reload latest practice' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Replace unsaved practice work?' })).getByRole('button', { name: 'Cancel' }))
  expect(screen.getByLabelText('F1 · Student answer')).toHaveValue('5/12')
  expect(memory.get(responseSlot)).toBeDefined()
})

it('clears discarded old response slots before switching to a new practice draft and does not restore orphans later', async () => {
  const memory = memoryRepository([row(workspaceSlot, workspace()), row(responseSlot, response())])
  const first = mount(memory.repository)
  await restore()
  await readyResponse()
  fireEvent.click(screen.getByRole('button', { name: 'Prepare practice · Fraction addition' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Replace unsaved practice work?' })).getByRole('button', { name: 'Discard and continue' }))
  await screen.findByLabelText('Practice title')
  expect(memory.get(responseSlot)).toBeUndefined()
  await waitFor(() => expect((memory.get(workspaceSlot)?.value as FollowupWorkspaceDraft)?.draft).not.toBeNull())
  first.unmount()
  mount(memory.repository)
  await restore()
  expect(await screen.findByLabelText('Practice title')).toBeVisible()
  expect(screen.queryByLabelText('F1 · Student answer')).toBeNull()
  expect(screen.queryByText(/Other saved edits are waiting/)).toBeNull()
})

it('retains a normal unmount response draft instead of treating navigation as a discard', async () => {
  const memory = memoryRepository([row(workspaceSlot, workspace()), row(responseSlot, response())])
  const first = mount(memory.repository)
  await restore()
  await readyResponse()
  fireEvent.change(screen.getByLabelText('F1 · Student answer'), { target: { value: 'Final keystroke before leaving.' } })
  first.unmount()
  await waitFor(() => expect((memory.get(responseSlot)?.value as FollowupResponseDraft)?.payload.student_answer).toBe('Final keystroke before leaving.'))
  mount(memory.repository)
  await restore()
  await waitFor(() => expect(screen.getByLabelText('F1 · Student answer')).toHaveValue('Final keystroke before leaving.'))
  expect(api.saveTeachingFollowupAttempt).not.toHaveBeenCalled()
})

it('preserves a stable recorded submission when local draft cleanup fails and clears only that draft on retry', async () => {
  const memory = memoryRepository([row(workspaceSlot, workspace()), row(responseSlot, response())])
  const originalClear = memory.repository.clear
  let fail = true
  memory.repository.clear = vi.fn(async (current, slot) => {
    if (slot === responseSlot && fail) { fail = false; throw new Error('Draft delete unavailable') }
    await originalClear(current, slot)
  })
  mount(memory.repository)
  await restore()
  await readyResponse()
  fireEvent.click(screen.getByRole('button', { name: 'Record response · F1' }))
  await screen.findByRole('region', { name: 'Response history (1)' })
  await screen.findByText(/Response recorded, but its local draft could not be cleared/)
  expect(screen.getByLabelText('F1 · Student answer')).toHaveValue('5/12')
  expect(memory.get(responseSlot)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Clear this response' }))
  await waitFor(() => expect(screen.getByLabelText('F1 · Student answer')).toHaveValue(''))
  expect(memory.get(responseSlot)).toBeUndefined()
  expect(screen.getByRole('region', { name: 'Response history (1)' })).toBeVisible()
  expect(api.saveTeachingFollowupAttempt).toHaveBeenCalledTimes(1)
})

it('restarts restored-set verification when StrictMode replays a newly hydrated practice mount', async () => {
  const memory = memoryRepository([row('primary', { version: 1, show: true }), row(workspaceSlot, workspace()), row(responseSlot, response())])
  const signals: AbortSignal[] = []
  let completedReads = 0
  vi.mocked(api.getTeachingFollowup).mockImplementation((_id, _workspace, signal) => new Promise((resolve, reject) => {
    if (signal) signals.push(signal)
    const timer = setTimeout(() => { completedReads++; resolve(set()) }, 20)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Verification aborted', 'AbortError')) }, { once: true })
  }))
  mountStrict(memory.repository)
  await restore()
  await readyResponse()
  expect(completedReads).toBeGreaterThan(0)
  expect(signals).not.toHaveLength(0)
  expect(api.saveTeachingFollowupAttempt).not.toHaveBeenCalled()
  expect((memory.get(responseSlot)!.value as FollowupResponseDraft).payload.attempt_id).toBe(attemptId)
})

it('lets the teacher retry a failed version check without discarding or resubmitting the pending response', async () => {
  const memory = memoryRepository([row(workspaceSlot, workspace()), row(responseSlot, response())])
  vi.mocked(api.getTeachingFollowup).mockRejectedValueOnce(new Error('Temporary version read failure'))
  mount(memory.repository)
  await restore()
  await screen.findByText(/The restored questions could not be matched to the current saved version/)
  expect(screen.getByLabelText('F1 · Student answer')).toHaveValue('5/12')
  expect(screen.getByRole('button', { name: 'Record response · F1' })).toBeDisabled()
  expect(screen.queryByText(/The report or practice has a newer saved version/)).toBeNull()
  expect(api.saveTeachingFollowupAttempt).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Retry question verification' }))
  await readyResponse()
  expect(api.getTeachingFollowup).toHaveBeenCalledTimes(2)
  expect((memory.get(responseSlot)!.value as FollowupResponseDraft).payload.attempt_id).toBe(attemptId)
  fireEvent.click(screen.getByRole('button', { name: 'Record response · F1' }))
  await screen.findByRole('region', { name: 'Response history (1)' })
  expect(vi.mocked(api.saveTeachingFollowupAttempt).mock.calls[0][1].attempt_id).toBe(attemptId)
})

it('can restart a pending verification and ignores the late aborted read without bypassing the current-version check', async () => {
  let finishOld!: (value: api.SavedFollowup) => void
  const memory = memoryRepository([row(workspaceSlot, workspace()), row(responseSlot, response())])
  vi.mocked(api.getTeachingFollowup).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
  mount(memory.repository)
  await restore()
  const oldSignal = vi.mocked(api.getTeachingFollowup).mock.calls[0][2]!
  expect(screen.getByRole('button', { name: 'Record response · F1' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Retry question verification' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Retry question verification' }))
  await readyResponse()
  expect(oldSignal.aborted).toBe(true)
  await act(async () => finishOld(set({ revision: 2 })))
  expect(screen.getByRole('button', { name: 'Record response · F1' })).toBeEnabled()
  expect(screen.getByLabelText('F1 · Student answer')).toHaveValue('5/12')
  expect(api.saveTeachingFollowupAttempt).not.toHaveBeenCalled()
})

it('keeps verification retry reachable inside a restored void dialog without losing its reason or voiding automatically', async () => {
  const source = set()
  const target: api.SavedFollowupAttempt = {
    ...pendingResponse(), followup_id: setId, report_id: reportId, report_revision: 1, priority_index: 0,
    question_snapshot: source.questions[0], student_ref: source.student_ref, assignment_ref: source.assignment_ref,
    subject: source.subject, grade: source.grade, source_fingerprint: source.source_fingerprint, knowledge_point: source.knowledge_point,
    created_at: 100, voided_at: null, void_reason: null,
  }
  const reason = 'Keep this local review reason while checking the question version.'
  const memory = memoryRepository([row(workspaceSlot, workspace({ void_target: target, void_reason: reason }))])
  vi.mocked(api.listTeachingFollowupAttempts).mockResolvedValue([target])
  vi.mocked(api.getTeachingFollowup).mockRejectedValueOnce(new Error('Temporary version read failure'))
  mount(memory.repository)
  await restore()
  const dialog = await screen.findByRole('dialog', { name: 'Void a response record' })
  expect(within(dialog).getByLabelText('Reason for voiding')).toHaveValue(reason)
  expect(within(dialog).getByRole('button', { name: 'Confirm void' })).toBeDisabled()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Retry question verification' }))
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Confirm void' })).toBeEnabled())
  expect(within(dialog).getByLabelText('Reason for voiding')).toHaveValue(reason)
  expect(api.voidTeachingFollowupAttempt).not.toHaveBeenCalled()
})

it('requires explicit discard after StrictMode hydration of an old-version response, preserving its identity when cancelled', async () => {
  const memory = memoryRepository([row('primary', { version: 1, show: true }), row(workspaceSlot, workspace()), row(responseSlot, response())])
  const latest = set({ revision: 2, questions: [{ ...set().questions[0], question: 'A newly reviewed question version.' }] })
  vi.mocked(api.getTeachingFollowup).mockResolvedValue(latest)
  mountStrict(memory.repository)
  await restore()
  await waitFor(() => expect(screen.getByLabelText('F1 · Student answer')).toHaveValue('5/12'))
  await screen.findByText(/The restored questions could not be matched to the current saved version/)
  fireEvent.click(screen.getByRole('button', { name: 'Reload latest practice' }))
  const cancelDialog = screen.getByRole('dialog', { name: 'Replace unsaved practice work?' })
  fireEvent.click(within(cancelDialog).getByRole('button', { name: 'Cancel' }))
  expect(screen.getByLabelText('F1 · Student answer')).toHaveValue('5/12')
  expect((memory.get(responseSlot)!.value as FollowupResponseDraft).payload.attempt_id).toBe(attemptId)
  expect((memory.get(responseSlot)!.value as FollowupResponseDraft).question_snapshot.question).toBe(set().questions[0].question)
  fireEvent.click(screen.getByRole('button', { name: 'Reload latest practice' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Replace unsaved practice work?' })).getByRole('button', { name: 'Discard and continue' }))
  await waitFor(() => expect(screen.getByLabelText('F1 · Student answer')).toHaveValue(''))
  expect(screen.getByText(latest.questions[0].question)).toBeVisible()
  expect(memory.get(responseSlot)).toBeUndefined()
  expect(api.saveTeachingFollowupAttempt).not.toHaveBeenCalled()
})
