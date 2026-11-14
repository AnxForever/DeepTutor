import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import StudentTaskPlayerPage from '@/components/learning/student-tasks/StudentTaskPlayerPage'
import { initI18n } from '@/i18n/init'
import translations from '@/locales/en/tasks.json'
import { prepareStudentTaskAudio } from '@/lib/student-task-audio'
import * as tasks from '@/lib/student-tasks-api'
import * as voice from '@/lib/student-task-voice-api'
import { waitForStudentTaskBufferWrites } from '@/lib/student-task-buffers'

const current = vi.hoisted(() => ({ actor: 'learner-a', router: { push: vi.fn() } }))
vi.mock('next/navigation', () => ({ useRouter: () => current.router, usePathname: () => '/learning/tasks' }))
vi.mock('next/link', () => ({ default: ({ href, prefetch, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean }) => { void prefetch; return <a href={href} {...props} /> } }))
vi.mock('@/hooks/useAuthStatus', () => ({ useAuthStatus: () => ({ loading: false, enabled: true, authenticated: true, isAdmin: false, userId: current.actor, statusAvailable: true, preset: 'learner', learningPolicy: { allowedSurfaces: ['tasks'] } }) }))
vi.mock('@/components/learning/TaskTranslations', () => ({ TaskTranslations: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('@/components/common/MarkdownRenderer', () => ({ default: ({ content }: { content: string }) => <div>{content}</div> }))
vi.mock('@/lib/student-tasks-api', async original => ({ ...(await original<typeof tasks>()), getStudentTask: vi.fn(), saveStudentTaskProgress: vi.fn(), submitStudentTask: vi.fn() }))
vi.mock('@/lib/student-task-voice-api', async original => ({ ...(await original<typeof voice>()), getStudentVoiceCapabilities: vi.fn(), getStudentSpeechText: vi.fn(), transcribeStudentTaskAudio: vi.fn() }))
vi.mock('@/lib/student-task-audio', async original => ({ ...(await original<typeof import('@/lib/student-task-audio')>()), prepareStudentTaskAudio: vi.fn(async () => new Blob(['canonical wav'], { type: 'audio/wav' })) }))
const i18n = initI18n('en'); i18n.addResourceBundle('en', 'app', translations, true, true)
const voiceLabel = (key: string) => i18n.t(`studentTaskVoice.${key}`)
const TASK = '11111111-1111-4111-8111-111111111111'
const OTHER_TASK = '22222222-2222-4222-8222-222222222222'
let server: tasks.StudentTaskView
let actorNumber = 0
const draftDatabase = new IDBFactory()
let microphone: ReturnType<typeof vi.fn<() => Promise<MediaStream>>>
let tracks: Array<{ stop: ReturnType<typeof vi.fn> }>
let voices: SpeechSynthesisVoice[]
let synth: { speak: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; getVoices: () => SpeechSynthesisVoice[]; addEventListener: () => void; removeEventListener: () => void }
class Recorder {
  state: RecordingState = 'inactive'; mimeType = 'audio/webm;codecs=opus'
  ondataavailable: ((event: BlobEvent) => void) | null = null; onstop: (() => void) | null = null; onerror: (() => void) | null = null
  start() { this.state = 'recording' }
  stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['recording']) } as BlobEvent); this.onstop?.() }) }
}
function mediaStream() { const track = { stop: vi.fn() }; tracks.push(track); return { getTracks: () => [track] } as unknown as MediaStream }
const fixture = (): tasks.StudentTaskView => ({ task_id: TASK, task_revision: 1, title: 'Two short questions', instructions: '', status: 'pending', issued_at: 1, questions: [{ question_id: 'Q1', question: 'First question' }, { question_id: 'Q2', question: 'Second question' }], progress: { revision: 0, current_question_index: 0, saved_at: null, responses: [{ question_id: 'Q1', response_status: 'unanswered', answer: null, assistance: 'unknown' }, { question_id: 'Q2', response_status: 'unanswered', answer: null, assistance: 'unknown' }] }, submission: null })
const capabilities = (taskId = TASK, questionId = 'Q1'): voice.StudentVoiceCapabilities => ({ task_id: taskId, task_revision: server.task_revision, question_id: questionId, read_aloud: { available: true, reason: null, locale: 'en' }, transcription: { available: true, reason: null }, limits: { max_upload_bytes: 1048576, max_audio_seconds: 30, max_recording_seconds: 25, max_transcript_chars: 6000 } })
beforeEach(() => {
  vi.clearAllMocks(); current.actor = `voice-learner-${++actorNumber}`; server = fixture(); tracks = []
  for (const method of [voice.getStudentVoiceCapabilities, voice.getStudentSpeechText, voice.transcribeStudentTaskAudio, tasks.getStudentTask, tasks.saveStudentTaskProgress, tasks.submitStudentTask]) vi.mocked(method).mockReset()
  microphone = vi.fn(async () => mediaStream())
  vi.stubGlobal('indexedDB', draftDatabase); vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: microphone } }); vi.stubGlobal('MediaRecorder', Recorder)
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  voices = [{ localService: true, lang: 'en-US', name: 'Local voice' } as SpeechSynthesisVoice]
  synth = { speak: vi.fn(), cancel: vi.fn(), getVoices: () => voices, addEventListener: () => {}, removeEventListener: () => {} }
  vi.stubGlobal('speechSynthesis', synth); vi.stubGlobal('SpeechSynthesisUtterance', class { text: string; constructor(text: string) { this.text = text } })
  vi.mocked(tasks.getStudentTask).mockImplementation(async id => ({ ...structuredClone(server), task_id: id }))
  vi.mocked(tasks.saveStudentTaskProgress).mockImplementation(async (_id, request) => { server = { ...server, status: 'in_progress', task_revision: 2, progress: { revision: request.expected_revision + 1, current_question_index: request.current_question_index, responses: structuredClone(request.responses), saved_at: 2 } }; return structuredClone(server) })
  vi.mocked(voice.getStudentVoiceCapabilities).mockImplementation(async (id, qid) => capabilities(id, qid))
  vi.mocked(voice.getStudentSpeechText).mockImplementation(async (id, qid, locale) => ({ task_id: id, task_revision: server.task_revision, question_id: qid, text: 'Server-prepared question words.', locale }))
  vi.mocked(voice.transcribeStudentTaskAudio).mockImplementation(async (id, qid, requestId, basis) => ({ task_id: id, task_revision: server.task_revision, question_id: qid, request_id: requestId, basis_progress_revision: basis, text: 'Words I said.', requires_confirmation: true }))
})
afterEach(async () => { cleanup(); await waitForStudentTaskBufferWrites(current.actor, TASK); await waitForStudentTaskBufferWrites(current.actor, OTHER_TASK); await act(async () => { await Promise.resolve() }); vi.unstubAllGlobals() })
async function openPlayer() { const view = render(<StudentTaskPlayerPage taskId={TASK} />); await waitFor(() => expect(screen.getByLabelText('My answer')).toBeEnabled()); await waitFor(() => expect(screen.getByRole('button', { name: voiceLabel('record') })).toBeEnabled()); return view }
async function record() { fireEvent.click(screen.getByRole('button', { name: voiceLabel('record') })); await screen.findByRole('button', { name: voiceLabel('stopRecording') }); fireEvent.click(screen.getByRole('button', { name: voiceLabel('stopRecording') })); await screen.findByLabelText(voiceLabel('candidateLabel')); await waitFor(() => expect(screen.getByRole('button', { name: voiceLabel('accept') })).toBeEnabled()) }
it('keeps recording disabled without teacher opt-in and leaves typing available', async () => {
  vi.mocked(voice.getStudentVoiceCapabilities).mockImplementation(async () => ({ ...capabilities(), transcription: { available: false, reason: 'task_voice_input_disabled' } }))
  render(<StudentTaskPlayerPage taskId={TASK} />)
  await screen.findByText(voiceLabel('inputUnavailable'))
  expect(screen.getByRole('button', { name: voiceLabel('record') })).toBeDisabled(); await waitFor(() => expect(screen.getByLabelText('My answer')).toBeEnabled()); expect(microphone).not.toHaveBeenCalled()
})
it('rechecks permission before opening the microphone and does not reuse an older available capability', async () => {
  await openPlayer()
  vi.mocked(voice.getStudentVoiceCapabilities).mockResolvedValue({ ...capabilities(), transcription: { available: false, reason: 'task_voice_input_disabled' } })
  fireEvent.click(screen.getByRole('button', { name: voiceLabel('record') }))
  await screen.findByText(voiceLabel('inputUnavailable'))
  expect(microphone).not.toHaveBeenCalled(); expect(voice.transcribeStudentTaskAudio).not.toHaveBeenCalled()
})
it('shows a separate editable transcript and only appends after explicit acceptance without changing help or assistance', async () => {
  server.progress.responses[0] = { question_id: 'Q1', response_status: 'needs_help', answer: 'Typed partial answer.', assistance: 'assisted' }
  render(<StudentTaskPlayerPage taskId={TASK} />)
  await waitFor(() => expect(screen.getByRole('button', { name: voiceLabel('record') })).toBeEnabled())
  await record()
  expect(screen.getByLabelText('My answer')).toHaveValue('Typed partial answer.')
  expect(screen.getByRole('button', { name: 'Save and continue' })).toBeDisabled()
  expect(tasks.saveStudentTaskProgress).not.toHaveBeenCalled(); expect(tasks.submitStudentTask).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText(voiceLabel('candidateLabel')), { target: { value: 'Corrected spoken words.' } })
  fireEvent.click(screen.getByRole('button', { name: voiceLabel('accept') }))
  expect(screen.getByLabelText('My answer')).toHaveValue('Typed partial answer.\nCorrected spoken words.')
  expect(screen.getByLabelText('My answer')).toHaveAttribute('readonly')
  fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
  await screen.findByText('Second question')
  expect(vi.mocked(tasks.saveStudentTaskProgress).mock.calls[0][1].responses[0]).toEqual({ question_id: 'Q1', response_status: 'needs_help', answer: 'Typed partial answer.\nCorrected spoken words.', assistance: 'assisted' })
  const call = vi.mocked(voice.transcribeStudentTaskAudio).mock.calls[0]
  expect(call.slice(0, 4)).toEqual([TASK, 'Q1', expect.any(String), 0]); expect(call[4].type).toBe('audio/wav')
  expect(prepareStudentTaskAudio).toHaveBeenCalledOnce(); expect(tracks[0].stop).toHaveBeenCalled()
})
it('discards a candidate without touching the typed answer or saving a response', async () => {
  await openPlayer(); fireEvent.change(screen.getByLabelText('My answer'), { target: { value: 'Keep exactly this writing.' } }); await record()
  fireEvent.click(screen.getByRole('button', { name: voiceLabel('discard') }))
  expect(screen.getByLabelText('My answer')).toHaveValue('Keep exactly this writing.'); expect(screen.getByLabelText('My answer')).toBeEnabled()
  expect(tasks.saveStudentTaskProgress).not.toHaveBeenCalled(); expect(tasks.submitStudentTask).not.toHaveBeenCalled()
})
it('requires editing an overlong merge instead of truncating the original answer or candidate', async () => {
  server.progress.responses[0] = { question_id: 'Q1', response_status: 'answered', answer: 'A'.repeat(5995), assistance: 'unknown' }
  vi.mocked(voice.transcribeStudentTaskAudio).mockImplementation(async (id, qid, requestId, basis) => ({ task_id: id, task_revision: 1, question_id: qid, request_id: requestId, basis_progress_revision: basis, text: '1234567', requires_confirmation: true }))
  await openPlayer(); fireEvent.click(screen.getByRole('button', { name: voiceLabel('record') })); fireEvent.click(await screen.findByRole('button', { name: voiceLabel('stopRecording') })); await screen.findByLabelText(voiceLabel('candidateLabel'))
  expect(screen.getByRole('button', { name: voiceLabel('accept') })).toBeDisabled(); expect(screen.getByLabelText('My answer')).toHaveValue('A'.repeat(5995))
  fireEvent.change(screen.getByLabelText(voiceLabel('candidateLabel')), { target: { value: '1234' } }); fireEvent.click(screen.getByRole('button', { name: voiceLabel('accept') }))
  expect(screen.getByLabelText('My answer')).toHaveValue(`${'A'.repeat(5995)}\n1234`); expect(tasks.saveStudentTaskProgress).not.toHaveBeenCalled()
})
it('restores only the candidate for review after immediate remount and never records or accepts automatically', async () => {
  const view = await openPlayer(); fireEvent.change(screen.getByLabelText('My answer'), { target: { value: 'Existing writing.' } }); await record()
  fireEvent.change(screen.getByLabelText(voiceLabel('candidateLabel')), { target: { value: 'Pending corrected words.' } }); view.unmount()
  render(<StudentTaskPlayerPage taskId={TASK} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Restore my writing' }))
  expect(await screen.findByLabelText(voiceLabel('candidateLabel'))).toHaveValue('Pending corrected words.')
  expect(screen.getByLabelText('My answer')).toHaveValue('Existing writing.')
  expect(microphone).toHaveBeenCalledOnce(); expect(voice.transcribeStudentTaskAudio).toHaveBeenCalledOnce(); expect(synth.speak).not.toHaveBeenCalled(); expect(tasks.saveStudentTaskProgress).not.toHaveBeenCalled()
})
it('cancels a late permission response when the actor and task change, without uploading to the new scope', async () => {
  let release!: (value: MediaStream) => void; microphone.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const view = await openPlayer(); fireEvent.click(screen.getByRole('button', { name: voiceLabel('record') }))
  await waitFor(() => expect(microphone).toHaveBeenCalledOnce())
  current.actor = `other-actor-${actorNumber}`; view.rerender(<StudentTaskPlayerPage taskId={OTHER_TASK} />)
  await screen.findByText('First question'); await act(async () => release(mediaStream()))
  expect(tracks[0].stop).toHaveBeenCalled(); expect(voice.transcribeStudentTaskAudio).not.toHaveBeenCalled()
})
it('keeps the typed answer after cancellation and ignores a late transcription', async () => {
  let release!: (value: voice.StudentTranscriptionCandidate) => void
  vi.mocked(voice.transcribeStudentTaskAudio).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  await openPlayer(); fireEvent.change(screen.getByLabelText('My answer'), { target: { value: 'Still my own words.' } }); fireEvent.click(screen.getByRole('button', { name: voiceLabel('record') })); fireEvent.click(await screen.findByRole('button', { name: voiceLabel('stopRecording') }))
  await waitFor(() => expect(voice.transcribeStudentTaskAudio).toHaveBeenCalledOnce())
  const [id, qid, requestId, basis, , signal] = vi.mocked(voice.transcribeStudentTaskAudio).mock.calls[0]
  fireEvent.click(screen.getByRole('button', { name: voiceLabel('cancel') })); expect(signal!.aborted).toBe(true)
  await act(async () => release({ task_id: id, task_revision: 1, question_id: qid, request_id: requestId, basis_progress_revision: basis, text: 'Late words', requires_confirmation: true }))
  expect(screen.queryByLabelText(voiceLabel('candidateLabel'))).toBeNull(); expect(screen.getByLabelText('My answer')).toHaveValue('Still my own words.'); expect(screen.getByLabelText('My answer')).toBeEnabled()
})
it('offers candidate listening only as an explicit local action without speech-text or cloud synthesis requests', async () => {
  await openPlayer(); await record()
  expect(synth.speak).not.toHaveBeenCalled(); fireEvent.change(screen.getByLabelText(voiceLabel('candidateLabel')), { target: { value: 'Corrected words to hear.' } })
  fireEvent.click(screen.getByRole('button', { name: voiceLabel('listenCandidate') }))
  expect(voice.getStudentSpeechText).not.toHaveBeenCalled(); expect(synth.speak).toHaveBeenCalledOnce()
  expect(synth.speak.mock.calls[0][0]).toMatchObject({ text: 'Corrected words to hear.', voice: { localService: true } })
})
it('does not read a question using a nonlocal device voice and still permits typing', async () => {
  voices = [{ localService: false, lang: 'en-US', name: 'Remote voice' } as SpeechSynthesisVoice]
  await openPlayer()
  expect(screen.getByRole('button', { name: voiceLabel('listen') })).toBeDisabled(); expect(screen.getByLabelText('My answer')).toBeEnabled(); expect(voice.getStudentSpeechText).not.toHaveBeenCalled()
})
it('does not open the microphone if fresh task revision metadata no longer matches the displayed task', async () => {
  await openPlayer(); vi.mocked(voice.getStudentVoiceCapabilities).mockResolvedValue({ ...capabilities(), task_revision: 2 })
  fireEvent.click(screen.getByRole('button', { name: voiceLabel('record') }))
  await screen.findByText(voiceLabel('stale'))
  expect(microphone).not.toHaveBeenCalled(); await waitFor(() => expect(screen.getByLabelText('My answer')).toBeEnabled())
})
