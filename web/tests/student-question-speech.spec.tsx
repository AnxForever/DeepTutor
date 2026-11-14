import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { matchingLocalVoice, useStudentQuestionSpeech } from '@/hooks/useStudentQuestionSpeech'
import { getStudentSpeechText } from '@/lib/student-task-voice-api'

vi.mock('@/lib/student-task-voice-api', () => ({ getStudentSpeechText: vi.fn() }))
const TASK = '11111111-1111-4111-8111-111111111111'
const local = { name: 'Local English', lang: 'en-US', localService: true } as SpeechSynthesisVoice
let voices: SpeechSynthesisVoice[]
let synth: { speak: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; getVoices: () => SpeechSynthesisVoice[]; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> }
class Utterance { text: string; lang = ''; voice: SpeechSynthesisVoice | null = null; onend: (() => void) | null = null; onerror: (() => void) | null = null; constructor(text: string) { this.text = text } }
const props = { scopeKey: 'learner-a:task:Q1:en', taskId: TASK, taskRevision: 1, questionId: 'Q1', locale: 'en' as const }
beforeEach(() => {
  vi.clearAllMocks(); voices = [local]
  synth = { speak: vi.fn(), cancel: vi.fn(), getVoices: () => voices, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  vi.stubGlobal('speechSynthesis', synth); vi.stubGlobal('SpeechSynthesisUtterance', Utterance)
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  vi.mocked(getStudentSpeechText).mockResolvedValue({ task_id: TASK, task_revision: 1, question_id: 'Q1', text: 'One half plus one third.', locale: 'en' })
})
afterEach(() => vi.unstubAllGlobals())
it('never starts reading automatically and only selects a matching localService voice', async () => {
  const view = renderHook(() => useStudentQuestionSpeech(props))
  expect(synth.speak).not.toHaveBeenCalled(); expect(getStudentSpeechText).not.toHaveBeenCalled()
  await act(async () => view.result.current.speak())
  const utterance = synth.speak.mock.calls[0][0] as Utterance
  expect(utterance.text).toBe('One half plus one third.'); expect(utterance.voice).toBe(local)
  expect(getStudentSpeechText).toHaveBeenCalledWith(TASK, 'Q1', 'en', expect.any(AbortSignal))
})
it('does not use a remote or wrong-language voice as a fallback', async () => {
  voices = [{ ...local, localService: false }, { ...local, lang: 'zh-CN' }]
  expect(matchingLocalVoice(voices, 'en')).toBeNull()
  const view = renderHook(() => useStudentQuestionSpeech(props))
  expect(view.result.current.localAvailable).toBe(false)
  await act(async () => view.result.current.speak())
  expect(synth.speak).not.toHaveBeenCalled(); expect(getStudentSpeechText).not.toHaveBeenCalled()
})
it('aborts source text lookup and ignores its late response after changing account or question', async () => {
  let release!: (value: Awaited<ReturnType<typeof getStudentSpeechText>>) => void
  vi.mocked(getStudentSpeechText).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const view = renderHook(args => useStudentQuestionSpeech(args), { initialProps: props })
  act(() => { void view.result.current.speak() })
  const signal = vi.mocked(getStudentSpeechText).mock.calls[0][3]!
  view.rerender({ ...props, scopeKey: 'learner-b:task:Q2:en', questionId: 'Q2' })
  expect(signal.aborted).toBe(true)
  await act(async () => release({ task_id: TASK, task_revision: 1, question_id: 'Q1', text: 'Old question', locale: 'en' }))
  expect(synth.speak).not.toHaveBeenCalled()
})
it('reads only the explicitly reviewed candidate locally without any API and stops it before leaving', async () => {
  const view = renderHook(() => useStudentQuestionSpeech(props))
  act(() => view.result.current.speakCandidate('My own corrected words.'))
  expect(getStudentSpeechText).not.toHaveBeenCalled()
  expect((synth.speak.mock.calls[0][0] as Utterance).voice?.localService).toBe(true)
  expect((synth.speak.mock.calls[0][0] as Utterance).text).toBe('My own corrected words.')
  view.unmount(); expect(synth.cancel).toHaveBeenCalled()
})
it('stops local speech on a hidden page and handles asynchronous voice availability', async () => {
  voices = []
  const view = renderHook(() => useStudentQuestionSpeech(props))
  expect(view.result.current.localAvailable).toBe(false)
  voices = [local]
  act(() => synth.addEventListener.mock.calls.find(([event]) => event === 'voiceschanged')![1]())
  await waitFor(() => expect(view.result.current.localAvailable).toBe(true))
  await act(async () => view.result.current.speak())
  Object.defineProperty(document, 'hidden', { configurable: true, value: true })
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(view.result.current.state).toBe('idle'); expect(synth.cancel).toHaveBeenCalled()
})
