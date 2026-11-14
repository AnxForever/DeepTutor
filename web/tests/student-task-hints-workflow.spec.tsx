import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import StudentTaskPlayerPage from '@/components/learning/student-tasks/StudentTaskPlayerPage'
import type { StudentTaskVoiceControlsProps } from '@/components/learning/student-tasks/StudentTaskVoiceControls'
import { initI18n } from '@/i18n/init'
import translations from '@/locales/en/tasks.json'
import { ApiError } from '@/shared/api/errors'
import { waitForStudentTaskBufferWrites } from '@/lib/student-task-buffers'
import * as tasks from '@/lib/student-tasks-api'
import * as hintsApi from '@/lib/student-task-hints-api'

const current = vi.hoisted(() => ({ actor: 'learner-a', router: { push: vi.fn() } }))
vi.mock('next/navigation', () => ({ useRouter: () => current.router, usePathname: () => '/learning/tasks' }))
vi.mock('next/link', () => ({ default: ({ href, prefetch, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean }) => { void prefetch; return <a href={href} {...props} /> } }))
vi.mock('@/hooks/useAuthStatus', () => ({ useAuthStatus: () => ({ loading: false, enabled: true, authenticated: true, isAdmin: false, userId: current.actor, statusAvailable: true, preset: 'learner', learningPolicy: { allowedSurfaces: ['tasks'] } }) }))
vi.mock('@/components/learning/TaskTranslations', () => ({ TaskTranslations: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('@/components/common/MarkdownRenderer', () => ({ default: ({ content }: { content: string }) => <div>{content}</div> }))
vi.mock('@/lib/student-tasks-api', async original => ({ ...(await original<typeof tasks>()), getStudentTask: vi.fn(), saveStudentTaskProgress: vi.fn(), submitStudentTask: vi.fn() }))
vi.mock('@/lib/student-task-hints-api', async original => ({ ...(await original<typeof hintsApi>()), getStudentTaskHints: vi.fn(), revealStudentTaskHint: vi.fn() }))
vi.mock('@/components/learning/student-tasks/StudentTaskVoiceControls', async original => ({ ...(await original<typeof import('@/components/learning/student-tasks/StudentTaskVoiceControls')>()), default: (props: StudentTaskVoiceControlsProps) => <section><button disabled={props.disabled} onClick={() => props.onBusyChange(true)}>Start simulated recording</button><button onClick={() => props.onBusyChange(false)}>Cancel simulated recording</button><button disabled={props.disabled || props.candidate !== null} onClick={() => props.onCandidateChange({ version: 1, task_id: props.taskId, task_revision: props.taskRevision, question_id: props.questionId, request_id: '33333333-3333-4333-8333-333333333333', basis_progress_revision: props.progressRevision, requires_confirmation: true, text: 'Unconfirmed spoken words' })}>Make simulated candidate</button>{props.candidate && <><input aria-label="Pending spoken candidate" value={props.candidate.text} readOnly /><button disabled={props.disabled} onClick={props.onAccept}>Accept simulated candidate</button><button onClick={() => props.onCandidateChange(null)}>Discard simulated candidate</button></>}</section> }))
const i18n = initI18n('en'); i18n.addResourceBundle('en', 'app', translations, true, true)
const label = (key: string) => i18n.t(`studentTaskHints.${key}`)
const TASK = '11111111-1111-4111-8111-111111111111'
const OTHER_TASK = '22222222-2222-4222-8222-222222222222'
const clues = ['Look at the two denominators.', 'Try using six equal parts.', 'Rewrite each fraction before adding.']
let server: tasks.StudentTaskView
let hints: hintsApi.StudentTaskHintsState
let actorNumber = 0
const state = (first = 0, second = 0, taskId = TASK): hintsApi.StudentTaskHintsState => ({ task_id: taskId, hint_revision: first + second, questions: [{ question_id: 'Q1', total: 3, revealed: clues.slice(0, first).map((text, index) => ({ level: index + 1, text, revealed_at: index + 1 })) }, { question_id: 'Q2', total: 1, revealed: second ? [{ level: 1, text: 'Second question clue.', revealed_at: 4 }] : [] }] })
const fixture = (): tasks.StudentTaskView => ({ task_id: TASK, task_revision: 1, title: 'A short task', instructions: '', status: 'pending', issued_at: 1, questions: [{ question_id: 'Q1', question: 'First question' }, { question_id: 'Q2', question: 'Second question' }], progress: { revision: 0, current_question_index: 0, saved_at: null, responses: [{ question_id: 'Q1', response_status: 'unanswered', answer: null, assistance: 'unknown' }, { question_id: 'Q2', response_status: 'unanswered', answer: null, assistance: 'unknown' }] }, submission: null })
async function reveal(id: string, body: hintsApi.RevealStudentHintRequest) {
  if (body.expected_hint_revision !== hints.hint_revision) throw new ApiError({ code: 'teaching_student_task_changed', message: 'Hint revision changed', status: 409, retryable: false, scope: 'network' })
  const question = hints.questions.find(value => value.question_id === body.question_id)!
  const level = question.revealed.length + 1
  hints = { ...hints, task_id: id, hint_revision: hints.hint_revision + 1, questions: hints.questions.map(value => value.question_id === body.question_id ? { ...value, revealed: [...value.revealed, { level, text: body.question_id === 'Q1' ? clues[level - 1] : 'Second question clue.', revealed_at: level }] } : value) }
  return structuredClone(hints)
}
beforeAll(() => { vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange) })
beforeEach(() => {
  vi.clearAllMocks(); current.actor = `hint-learner-${++actorNumber}`; server = fixture(); hints = state()
  for (const method of [tasks.getStudentTask, tasks.saveStudentTaskProgress, tasks.submitStudentTask, hintsApi.getStudentTaskHints, hintsApi.revealStudentTaskHint]) vi.mocked(method).mockReset()
  vi.mocked(tasks.getStudentTask).mockImplementation(async id => ({ ...structuredClone(server), task_id: id }))
  vi.mocked(tasks.saveStudentTaskProgress).mockImplementation(async (_id, body) => { server = { ...server, task_revision: 2, status: 'in_progress', progress: { revision: body.expected_revision + 1, current_question_index: body.current_question_index, responses: structuredClone(body.responses), saved_at: 2 } }; return structuredClone(server) })
  vi.mocked(tasks.submitStudentTask).mockImplementation(async (_id, body) => { server = { ...server, status: 'submitted', task_revision: 3, submission: { task_id: TASK, submission_id: body.submission_id, submitted_at: 3, responses: structuredClone(body.responses) } }; return structuredClone(server) })
  vi.mocked(hintsApi.getStudentTaskHints).mockImplementation(async id => ({ ...structuredClone(hints), task_id: id }))
  vi.mocked(hintsApi.revealStudentTaskHint).mockImplementation(reveal)
})
afterEach(async () => { cleanup(); await waitForStudentTaskBufferWrites(current.actor, TASK); await waitForStudentTaskBufferWrites(current.actor, OTHER_TASK) })
async function openPlayer() { const view = render(<StudentTaskPlayerPage taskId={TASK} />); await waitFor(() => expect(screen.getByLabelText('My answer')).toBeEnabled()); await waitFor(() => expect(screen.getByRole('button', { name: hints.questions[0].revealed.length ? label('next') : label('first') })).toBeEnabled()); return view }

it('opens exactly one hint per explicit click and keeps the live answer, status and answer CAS untouched', async () => {
  await openPlayer(); const answer = screen.getByLabelText('My answer')
  fireEvent.change(answer, { target: { value: 'My unsaved partial solution.' } })
  expect(screen.queryByText(clues[0])).toBeNull(); expect(screen.queryByText(clues[2])).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: label('first') }))
  await screen.findByText(clues[0]); expect(screen.queryByText(clues[1])).toBeNull()
  expect(screen.getByLabelText('My answer')).toBe(answer); expect(answer).toHaveValue('My unsaved partial solution.')
  expect(tasks.saveStudentTaskProgress).not.toHaveBeenCalled(); expect(tasks.submitStudentTask).not.toHaveBeenCalled()
  await waitFor(() => expect(screen.getByRole('button', { name: label('next') })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: label('next') })); await screen.findByText(clues[1])
  await waitFor(() => expect(screen.getByRole('button', { name: label('next') })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: label('next') })); await screen.findByText(clues[2])
  expect(screen.queryByRole('button', { name: label('next') })).toBeNull(); expect(screen.getByText(label('finished'))).toBeVisible()
  expect(screen.getByRole('button', { name: "I don't know yet" })).toBeEnabled()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save and continue' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Save and continue' })); await screen.findByText('Second question')
  expect(vi.mocked(tasks.saveStudentTaskProgress).mock.calls[0][1]).toMatchObject({ expected_revision: 0, responses: [{ question_id: 'Q1', response_status: 'answered', answer: 'My unsaved partial solution.', assistance: 'unknown' }, { question_id: 'Q2', response_status: 'unanswered', answer: null, assistance: 'unknown' }] })
})
it('keeps typing available during a hint POST while blocking task navigation and voice start', async () => {
  let release!: (value: hintsApi.StudentTaskHintsState) => void
  vi.mocked(hintsApi.revealStudentTaskHint).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  await openPlayer(); fireEvent.change(screen.getByLabelText('My answer'), { target: { value: 'Before opening' } })
  fireEvent.click(screen.getByRole('button', { name: label('first') })); await waitFor(() => expect(hintsApi.revealStudentTaskHint).toHaveBeenCalledOnce())
  expect(screen.getByLabelText('My answer')).toBeEnabled(); expect(screen.getByRole('button', { name: 'Save and continue' })).toBeDisabled(); expect(screen.getByRole('button', { name: 'Start simulated recording' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('My answer'), { target: { value: 'Typed while the hint was loading' } })
  await act(async () => release(state(1)))
  expect(screen.getByLabelText('My answer')).toHaveValue('Typed while the hint was loading'); expect(screen.getByRole('button', { name: 'Save and continue' })).toBeEnabled()
})
it.each(['post', 'reconciliation'] as const)('lets the child leave a never-resolving hint %s and continue the task without changing answers', async phase => {
  let release!: (value: hintsApi.StudentTaskHintsState) => void
  if (phase === 'post') vi.mocked(hintsApi.revealStudentTaskHint).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  else {
    vi.mocked(hintsApi.revealStudentTaskHint).mockRejectedValueOnce(new Error('Response lost'))
    vi.mocked(hintsApi.getStudentTaskHints).mockResolvedValueOnce(state()).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  }
  await openPlayer(); fireEvent.change(screen.getByLabelText('My answer'), { target: { value: 'I can keep trying.' } }); fireEvent.click(screen.getByRole('button', { name: label('first') }))
  await waitFor(() => expect(hintsApi.revealStudentTaskHint).toHaveBeenCalledOnce())
  if (phase === 'reconciliation') await waitFor(() => expect(hintsApi.getStudentTaskHints).toHaveBeenCalledTimes(2))
  const signal = vi.mocked(hintsApi.revealStudentTaskHint).mock.calls[0][2]!
  fireEvent.click(screen.getByRole('button', { name: label('tryAlone') }))
  expect(signal.aborted).toBe(true); expect(screen.getByLabelText('My answer')).toHaveValue('I can keep trying.'); expect(screen.getByLabelText('My answer')).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Start simulated recording' })).toBeEnabled(); expect(screen.queryByRole('button', { name: label('first') })).toBeNull()
  fireEvent.change(screen.getByLabelText('My answer'), { target: { value: 'My latest thought.' } }); fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
  await screen.findByText('Second question'); expect(vi.mocked(tasks.saveStudentTaskProgress).mock.calls[0][1].responses[0].answer).toBe('My latest thought.')
  await act(async () => release(state(1)))
  expect(screen.queryByText(clues[0])).toBeNull(); expect(hintsApi.revealStudentTaskHint).toHaveBeenCalledOnce()
})
it('checks the saved prefix after cancellation and ignores an old reply while a new explicit reveal is pending', async () => {
  let releaseOld!: (value: hintsApi.StudentTaskHintsState) => void; let releaseNew!: (value: hintsApi.StudentTaskHintsState) => void
  vi.mocked(hintsApi.revealStudentTaskHint).mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve })).mockImplementationOnce(() => new Promise(resolve => { releaseNew = resolve }))
  await openPlayer(); fireEvent.change(screen.getByLabelText('My answer'), { target: { value: 'Keep this current answer.' } }); fireEvent.click(screen.getByRole('button', { name: label('first') }))
  await screen.findByRole('button', { name: label('tryAlone') }); fireEvent.click(screen.getByRole('button', { name: label('tryAlone') }))
  hints = state(1); fireEvent.click(screen.getByRole('button', { name: label('refresh') }))
  await screen.findByText(clues[0]); expect(hintsApi.revealStudentTaskHint).toHaveBeenCalledOnce(); expect(screen.queryByText(clues[1])).toBeNull()
  await waitFor(() => expect(screen.getByRole('button', { name: label('next') })).toBeEnabled()); fireEvent.click(screen.getByRole('button', { name: label('next') }))
  await waitFor(() => expect(hintsApi.revealStudentTaskHint).toHaveBeenCalledTimes(2))
  await act(async () => releaseOld(state(1)))
  expect(screen.getByRole('button', { name: 'Save and continue' })).toBeDisabled(); expect(screen.getByRole('button', { name: label('tryAlone') })).toBeVisible()
  await act(async () => releaseNew(state(2)))
  expect(screen.getByText(clues[1])).toBeVisible(); expect(screen.getByRole('button', { name: 'Save and continue' })).toBeEnabled(); expect(screen.getByLabelText('My answer')).toHaveValue('Keep this current answer.')
})
it('does not block writing when the initial hint GET fails', async () => {
  vi.mocked(hintsApi.getStudentTaskHints).mockRejectedValueOnce(new Error('Offline'))
  render(<StudentTaskPlayerPage taskId={TASK} />); await screen.findByText(label('unavailable'))
  await waitFor(() => expect(screen.getByLabelText('My answer')).toBeEnabled())
  fireEvent.change(screen.getByLabelText('My answer'), { target: { value: 'I can keep writing.' } })
  expect(screen.getByRole('button', { name: 'Save and continue' })).toBeEnabled(); expect(hintsApi.revealStudentTaskHint).not.toHaveBeenCalled()
})
it('blocks new reveals during recording or an unconfirmed candidate and keeps the candidate after a hint GET', async () => {
  let release!: (value: hintsApi.StudentTaskHintsState) => void
  vi.mocked(hintsApi.getStudentTaskHints).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  render(<StudentTaskPlayerPage taskId={TASK} />); await waitFor(() => expect(screen.getByLabelText('My answer')).toBeEnabled())
  fireEvent.change(screen.getByLabelText('My answer'), { target: { value: 'Typed part' } })
  fireEvent.click(screen.getByRole('button', { name: 'Start simulated recording' }))
  await act(async () => release(state()))
  expect(screen.getByRole('button', { name: label('first') })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel simulated recording' })); fireEvent.click(screen.getByRole('button', { name: 'Make simulated candidate' }))
  expect(screen.getByLabelText('Pending spoken candidate')).toHaveValue('Unconfirmed spoken words'); expect(screen.getByRole('button', { name: label('first') })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Accept simulated candidate' }))
  expect(screen.getByLabelText('My answer')).toHaveValue('Typed part\nUnconfirmed spoken words'); expect(screen.getByRole('button', { name: label('first') })).toBeEnabled()
  expect(hintsApi.revealStudentTaskHint).not.toHaveBeenCalled()
})
it('reconciles an unknown POST with GET before offering an explicit retry of the same UUID and payload', async () => {
  vi.mocked(hintsApi.revealStudentTaskHint).mockRejectedValueOnce(new Error('Response lost'))
  await openPlayer(); fireEvent.change(screen.getByLabelText('My answer'), { target: { value: 'Keep me' } }); fireEvent.click(screen.getByRole('button', { name: label('first') }))
  await screen.findByRole('button', { name: label('retry') })
  expect(hintsApi.getStudentTaskHints).toHaveBeenCalledTimes(2); expect(hintsApi.revealStudentTaskHint).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: label('retry') })); await screen.findByText(clues[0])
  const calls = vi.mocked(hintsApi.revealStudentTaskHint).mock.calls
  expect(calls[1][1]).toEqual(calls[0][1]); expect(hints.hint_revision).toBe(1); expect(screen.queryByText(clues[1])).toBeNull(); expect(screen.getByLabelText('My answer')).toHaveValue('Keep me')
})
it('keeps an unconfirmed candidate and its basis when an authoritative hint GET resolves later', async () => {
  let release!: (value: hintsApi.StudentTaskHintsState) => void
  vi.mocked(hintsApi.getStudentTaskHints).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  render(<StudentTaskPlayerPage taskId={TASK} />); await waitFor(() => expect(screen.getByLabelText('My answer')).toBeEnabled())
  fireEvent.change(screen.getByLabelText('My answer'), { target: { value: 'Existing typed work' } }); fireEvent.click(screen.getByRole('button', { name: 'Make simulated candidate' }))
  const candidate = screen.getByLabelText('Pending spoken candidate')
  await act(async () => release(state(1)))
  expect(screen.getByLabelText('Pending spoken candidate')).toBe(candidate); expect(candidate).toHaveValue('Unconfirmed spoken words'); expect(screen.getByRole('button', { name: label('next') })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Accept simulated candidate' }))
  expect(screen.getByLabelText('My answer')).toHaveValue('Existing typed work\nUnconfirmed spoken words')
  fireEvent.click(screen.getByRole('button', { name: 'Save and continue' })); await screen.findByText('Second question')
  expect(vi.mocked(tasks.saveStudentTaskProgress).mock.calls[0][1].expected_revision).toBe(0)
})
it('recovers a committed hint after a lost acknowledgement without opening the next hint automatically', async () => {
  vi.mocked(hintsApi.revealStudentTaskHint).mockImplementationOnce(async (id, body) => { await reveal(id, body); throw new Error('Acknowledgement lost') })
  await openPlayer(); fireEvent.click(screen.getByRole('button', { name: label('first') }))
  await screen.findByText(label('recovered')); expect(screen.getByText(clues[0])).toBeVisible(); expect(screen.queryByText(clues[1])).toBeNull()
  expect(hintsApi.revealStudentTaskHint).toHaveBeenCalledOnce(); expect(screen.queryByRole('button', { name: label('retry') })).toBeNull()
})
it('recovers a committed hint from authoritative GET after remount without replaying an old POST or touching the answer buffer', async () => {
  vi.mocked(hintsApi.revealStudentTaskHint).mockImplementationOnce(async (id, body) => { await reveal(id, body); return new Promise(() => {}) })
  const view = await openPlayer(); fireEvent.change(screen.getByLabelText('My answer'), { target: { value: 'My saved local thought.' } }); fireEvent.click(screen.getByRole('button', { name: label('first') }))
  await waitFor(() => expect(hints.hint_revision).toBe(1)); view.unmount()
  render(<StudentTaskPlayerPage taskId={TASK} />); fireEvent.click(await screen.findByRole('button', { name: 'Restore my writing' }))
  expect(await screen.findByText(clues[0])).toBeVisible(); expect(screen.getByLabelText('My answer')).toHaveValue('My saved local thought.'); expect(screen.queryByText(clues[1])).toBeNull()
  expect(hintsApi.revealStudentTaskHint).toHaveBeenCalledOnce(); expect(tasks.saveStudentTaskProgress).not.toHaveBeenCalled(); expect(tasks.submitStudentTask).not.toHaveBeenCalled()
})
it('uses a fresh authoritative prefix after stale CAS and waits for another manual click', async () => {
  vi.mocked(hintsApi.revealStudentTaskHint).mockImplementationOnce(async () => { hints = state(1); throw new ApiError({ code: 'teaching_student_task_changed', message: 'Conflict', status: 409, retryable: false, scope: 'network' }) })
  await openPlayer(); fireEvent.click(screen.getByRole('button', { name: label('first') }))
  await screen.findByText(label('changed')); expect(hintsApi.revealStudentTaskHint).toHaveBeenCalledOnce(); expect(screen.getByText(clues[0])).toBeVisible(); expect(screen.queryByText(clues[1])).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: label('next') })); await screen.findByText(clues[1])
  const calls = vi.mocked(hintsApi.revealStudentTaskHint).mock.calls
  expect(calls[1][1].request_id).not.toBe(calls[0][1].request_id); expect(calls[1][1].expected_hint_revision).toBe(1)
})
it('does not confuse another question advancing the global hint revision with opening this question', async () => {
  vi.mocked(hintsApi.revealStudentTaskHint).mockImplementationOnce(async () => { hints = state(0, 1); throw new ApiError({ code: 'teaching_student_task_changed', message: 'Conflict', status: 409, retryable: false, scope: 'network' }) })
  await openPlayer(); fireEvent.click(screen.getByRole('button', { name: label('first') })); await screen.findByText(label('changed'))
  expect(screen.queryByText(clues[0])).toBeNull(); expect(screen.queryByText('Second question clue.')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: label('first') })); await screen.findByText(clues[0])
  expect(vi.mocked(hintsApi.revealStudentTaskHint).mock.calls[1][1]).toMatchObject({ question_id: 'Q1', expected_hint_revision: 1 })
  expect(hints.questions[0].revealed).toHaveLength(1); expect(hints.questions[1].revealed).toHaveLength(1)
})
it('retains already opened hints when POST and reconciliation both fail and refreshes without another POST', async () => {
  hints = state(1); await openPlayer()
  // This task already has a prefix, so the available action is the next hint.
  await screen.findByText(clues[0]); vi.mocked(hintsApi.revealStudentTaskHint).mockRejectedValueOnce(new Error('Offline')); vi.mocked(hintsApi.getStudentTaskHints).mockRejectedValueOnce(new Error('Still offline'))
  fireEvent.click(screen.getByRole('button', { name: label('next') })); await screen.findByRole('button', { name: label('retry') })
  expect(screen.getByText(clues[0])).toBeVisible(); hints = state(2)
  fireEvent.click(screen.getByRole('button', { name: label('refresh') })); await screen.findByText(clues[1])
  expect(hintsApi.revealStudentTaskHint).toHaveBeenCalledOnce(); expect(screen.queryByText(clues[2])).toBeNull()
})
it('keeps help status and partial work unchanged by hint use', async () => {
  await openPlayer(); fireEvent.change(screen.getByLabelText('My answer'), { target: { value: 'My partial work.' } }); fireEvent.click(screen.getByRole('button', { name: "I don't know yet" })); fireEvent.click(screen.getByRole('button', { name: label('first') }))
  await screen.findByText(clues[0]); expect(screen.getByLabelText('My answer')).toHaveValue('My partial work.'); expect(screen.getByLabelText('My answer')).toHaveAttribute('readonly')
  fireEvent.click(screen.getByRole('button', { name: 'Save and continue' })); await screen.findByText('Second question')
  expect(vi.mocked(tasks.saveStudentTaskProgress).mock.calls[0][1].responses[0]).toEqual({ question_id: 'Q1', response_status: 'needs_help', answer: 'My partial work.', assistance: 'unknown' })
})
it('does not display a late hint from a previous account or task', async () => {
  let release!: (value: hintsApi.StudentTaskHintsState) => void
  vi.mocked(hintsApi.getStudentTaskHints).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const view = render(<StudentTaskPlayerPage taskId={TASK} />); await waitFor(() => expect(screen.getByLabelText('My answer')).toBeEnabled())
  const oldSignal = vi.mocked(hintsApi.getStudentTaskHints).mock.calls[0][1]!
  current.actor = `other-actor-${actorNumber}`; view.rerender(<StudentTaskPlayerPage taskId={OTHER_TASK} />)
  await waitFor(() => expect(hintsApi.getStudentTaskHints).toHaveBeenCalledWith(OTHER_TASK, expect.any(AbortSignal)))
  expect(oldSignal.aborted).toBe(true); await act(async () => release(state(1)))
  expect(screen.queryByText(clues[0])).toBeNull(); expect(hintsApi.revealStudentTaskHint).not.toHaveBeenCalled()
})
it.each(['submitted', 'revoked'] as const)('shows only the opened prefix readonly for a %s task', async status => {
  hints = state(1); server.status = status
  if (status === 'submitted') server.submission = { task_id: TASK, submission_id: OTHER_TASK, submitted_at: 3, responses: server.progress.responses }
  render(<StudentTaskPlayerPage taskId={TASK} />); await screen.findByText(clues[0])
  expect(screen.queryByText(clues[1])).toBeNull(); expect(screen.queryByRole('button', { name: label('next') })).toBeNull(); expect(screen.queryByRole('button', { name: label('first') })).toBeNull(); expect(hintsApi.revealStudentTaskHint).not.toHaveBeenCalled()
})
it('renders teacher text as plain text and exposes no future hint content', async () => {
  hints = state(1); hints.questions[0].revealed[0].text = '<img src="https://untrusted.invalid/image"><script>bad()</script>'
  const view = render(<StudentTaskPlayerPage taskId={TASK} />); await screen.findByText(hints.questions[0].revealed[0].text)
  expect(view.container.querySelector('img')).toBeNull(); expect(view.container.querySelector('script')).toBeNull(); expect(screen.queryByText(clues[1])).toBeNull()
})
