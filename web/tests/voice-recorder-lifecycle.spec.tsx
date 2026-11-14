import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useVoiceRecorder } from '@/hooks/useVoiceRecorder'
import { apiFetch } from '@/lib/api'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(), apiUrl: (path: string) => path }))
const instances: FakeRecorder[] = []
class FakeTrack extends EventTarget { stop = vi.fn(); end() { this.dispatchEvent(new Event('ended')) } }
const tracks: FakeTrack[] = []
function stream() { const track = new FakeTrack(); tracks.push(track); return { getTracks: () => [track] } as unknown as MediaStream }
class FakeRecorder {
  state: RecordingState = 'inactive'
  mimeType = 'audio/webm;codecs=opus'
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  start = vi.fn(() => { this.state = 'recording' })
  stop = vi.fn(() => { this.state = 'inactive'; queueMicrotask(() => { this.data(new Blob(['audio'])); this.onstop?.() }) })
  data(data: Blob) { this.ondataavailable?.({ data } as BlobEvent) }
  constructor() { instances.push(this) }
}
beforeEach(() => {
  instances.length = 0; tracks.length = 0; vi.clearAllMocks()
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream()) } })
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({ text: ' Spoken words ' }) } as Response)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
it('keeps the old chat signature idle until an explicit click, then sends one multipart clip on stop', async () => {
  const transcript = vi.fn()
  const { result } = renderHook(() => useVoiceRecorder(transcript))
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled(); expect(apiFetch).not.toHaveBeenCalled()
  await act(async () => { await result.current.start() })
  expect(result.current.state).toBe('recording')
  act(() => result.current.stop())
  await waitFor(() => expect(transcript).toHaveBeenCalledWith('Spoken words'))
  expect(apiFetch).toHaveBeenCalledOnce()
  const [url, init] = vi.mocked(apiFetch).mock.calls[0]
  expect(url).toBe('/api/voice/stt')
  const file = (init!.body as FormData).get('file') as File
  expect(file.type).toBe('audio/webm'); expect(file.name).toBe('recording.webm')
  expect(tracks[0].stop.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(apiFetch).mock.invocationCallOrder[0])
})
it.each(['cancel', 'unmount'] as const)('stops hardware without transcribing on %s', async action => {
  const transcript = vi.fn(); const view = renderHook(() => useVoiceRecorder(transcript))
  await act(async () => { await view.result.current.start() })
  if (action === 'cancel') act(() => view.result.current.cancel()); else view.unmount()
  await act(async () => { await Promise.resolve() })
  expect(tracks[0].stop).toHaveBeenCalled(); expect(apiFetch).not.toHaveBeenCalled(); expect(transcript).not.toHaveBeenCalled()
})
it('discards a nonempty recording when MediaRecorder stops externally without the child choosing to finish', async () => {
  const prepareAudio = vi.fn(async (audio: Blob) => audio); const transcribe = vi.fn(async () => 'Must not be accepted'); const transcript = vi.fn()
  const view = renderHook(() => useVoiceRecorder(transcript, { prepareAudio, transcribe }))
  await act(async () => { await view.result.current.start() })
  await act(async () => { instances[0].state = 'inactive'; instances[0].data(new Blob(['device interrupted audio'])); await instances[0].onstop?.() })
  expect(prepareAudio).not.toHaveBeenCalled(); expect(transcribe).not.toHaveBeenCalled(); expect(transcript).not.toHaveBeenCalled()
  expect(tracks[0].stop).toHaveBeenCalled(); expect(view.result.current.state).toBe('idle'); expect(view.result.current.errorCode).toBe('recording_failed')
})
it('cancels a device-ended stream and releases the microphone without preparing or uploading its partial clip', async () => {
  const prepareAudio = vi.fn(async (audio: Blob) => audio); const transcribe = vi.fn(async () => 'No upload')
  const view = renderHook(() => useVoiceRecorder(vi.fn(), { prepareAudio, transcribe }))
  await act(async () => { await view.result.current.start() })
  await act(async () => { instances[0].data(new Blob(['partial clip'])); tracks[0].end(); await Promise.resolve() })
  expect(tracks[0].stop).toHaveBeenCalled(); expect(view.result.current.state).toBe('idle'); expect(view.result.current.errorCode).toBe('recording_failed')
  expect(prepareAudio).not.toHaveBeenCalled(); expect(transcribe).not.toHaveBeenCalled()
})
it('guards a double start synchronously and stops a late permission stream after leaving', async () => {
  let release!: (value: MediaStream) => void
  vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(() => new Promise(resolve => { release = resolve }))
  const view = renderHook(() => useVoiceRecorder(vi.fn()))
  act(() => { void view.result.current.start(); void view.result.current.start() })
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce()
  expect(view.result.current.state).toBe('requesting')
  view.unmount(); const late = stream()
  await act(async () => release(late))
  expect(tracks[0].stop).toHaveBeenCalled(); expect(instances).toHaveLength(0); expect(apiFetch).not.toHaveBeenCalled()
})
it('aborts preparation without uploading and ignores its late result after a scope change', async () => {
  let release!: (audio: Blob) => void
  let preparationSignal!: AbortSignal
  const prepareAudio = vi.fn((_audio, signal: AbortSignal) => { preparationSignal = signal; return new Promise<Blob>(resolve => { release = resolve }) })
  const transcribe = vi.fn(async () => 'Do not accept this')
  const transcript = vi.fn()
  const view = renderHook(({ scopeKey }) => useVoiceRecorder(transcript, { scopeKey, prepareAudio, transcribe }), { initialProps: { scopeKey: 'account-a:task:Q1' } })
  await act(async () => { await view.result.current.start(); view.result.current.stop() })
  await waitFor(() => expect(view.result.current.state).toBe('preparing'))
  expect(tracks[0].stop).toHaveBeenCalled()
  view.rerender({ scopeKey: 'account-b:task:Q2' })
  expect(preparationSignal.aborted).toBe(true)
  await act(async () => release(new Blob(['wav'], { type: 'audio/wav' })))
  expect(transcribe).not.toHaveBeenCalled(); expect(transcript).not.toHaveBeenCalled()
})
it('cancels an in-flight upload when the page becomes hidden without appending late words', async () => {
  let release!: (text: string) => void; let signal!: AbortSignal
  const transcribe = vi.fn((_audio, context: { signal: AbortSignal }) => { signal = context.signal; return new Promise<string>(resolve => { release = resolve }) })
  const transcript = vi.fn(); const view = renderHook(() => useVoiceRecorder(transcript, { transcribe }))
  await act(async () => { await view.result.current.start(); view.result.current.stop() })
  await waitFor(() => expect(transcribe).toHaveBeenCalledOnce())
  Object.defineProperty(document, 'hidden', { configurable: true, value: true })
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(signal.aborted).toBe(true)
  await act(async () => release('Late transcription'))
  expect(transcript).not.toHaveBeenCalled(); expect(view.result.current.state).toBe('idle')
})
it('ends the consented recording at its duration limit but never starts capture from a timer', async () => {
  vi.useFakeTimers(); const transcript = vi.fn()
  const view = renderHook(() => useVoiceRecorder(transcript, { maxDurationMs: 1000 }))
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled()
  await act(async () => { await view.result.current.start(); await vi.advanceTimersByTimeAsync(1000) })
  expect(transcript).toHaveBeenCalledOnce(); expect(tracks[0].stop).toHaveBeenCalled()
})
it('rejects oversized compressed capture before preparation or upload', async () => {
  const prepareAudio = vi.fn(async (audio: Blob) => audio); const transcribe = vi.fn(async () => 'text')
  const view = renderHook(() => useVoiceRecorder(vi.fn(), { maxBytes: 4, prepareAudio, transcribe }))
  await act(async () => { await view.result.current.start() })
  act(() => instances[0].data(new Blob(['too large'])))
  expect(view.result.current.errorCode).toBe('recording_too_large'); expect(tracks[0].stop).toHaveBeenCalled()
  expect(prepareAudio).not.toHaveBeenCalled(); expect(transcribe).not.toHaveBeenCalled()
})
