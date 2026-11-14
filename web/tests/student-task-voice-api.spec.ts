import { beforeEach, expect, it, vi } from 'vitest'
import { requestJson } from '@/shared/api/client'
import { getStudentSpeechText, getStudentVoiceCapabilities, transcribeStudentTaskAudio } from '@/lib/student-task-voice-api'

vi.mock('@/shared/api/client', () => ({ requestJson: vi.fn(async () => ({})) }))
const TASK = '11111111-1111-4111-8111-111111111111'
const REQUEST = '22222222-2222-4222-8222-222222222222'
beforeEach(() => { vi.clearAllMocks(); window.history.replaceState({}, '', '/learning/tasks?dt_workspace=teacher-private') })
it('keeps every voice request account-global and sends no arbitrary speech text, model or provider selection', async () => {
  await getStudentVoiceCapabilities(TASK, 'Q1', 'zh')
  await getStudentSpeechText(TASK, 'Q1', 'zh')
  const audio = new Blob(['canonical wav'], { type: 'audio/wav' })
  const signal = new AbortController().signal
  await transcribeStudentTaskAudio(TASK, 'Q1', REQUEST, 3, audio, signal)
  const calls = vi.mocked(requestJson).mock.calls
  for (const [input] of calls) {
    const url = new URL(String(input), window.location.origin)
    expect(url.searchParams.get('dt_workspace')).toBe('')
    expect(url.searchParams.get('question_id')).toBe('Q1')
    for (const key of ['text', 'source', 'voice', 'model', 'url']) expect(url.searchParams.has(key)).toBe(false)
  }
  const post = new URL(String(calls[2][0]), window.location.origin)
  expect(post.searchParams.has('locale')).toBe(false)
  expect(post.searchParams.get('request_id')).toBe(REQUEST); expect(post.searchParams.get('expected_revision')).toBe('3')
  expect(calls[2][1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: audio, signal })
})
