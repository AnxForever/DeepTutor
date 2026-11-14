import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareStudentTaskAudio, studentTaskWav } from '@/lib/student-task-audio'

let duration = 1.25
let decode: ReturnType<typeof vi.fn>
let close: ReturnType<typeof vi.fn>
let offline: ReturnType<typeof vi.fn<(channels: number, frames: number, rate: number) => void>>
let source: { buffer: unknown; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }
beforeEach(() => {
  duration = 1.25; close = vi.fn(async () => {}); decode = vi.fn(async () => ({ duration })); offline = vi.fn()
  source = { buffer: null, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() }
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('AudioContext', class { decodeAudioData = decode; close = close })
  vi.stubGlobal('OfflineAudioContext', class { destination = {}; frames: number; constructor(channels: number, frames: number, rate: number) { offline(channels, frames, rate); this.frames = frames } createBufferSource() { return source } async startRendering() { return { getChannelData: () => new Float32Array(this.frames) } } })
})
afterEach(() => vi.unstubAllGlobals())
it('writes a canonical little-endian mono PCM16 16 kHz WAV without clipping or changing sample count', async () => {
  const wav = studentTaskWav(new Float32Array([-1, 0, 1, 2, Number.NaN]))
  const view = new DataView(await wav.arrayBuffer())
  expect(wav.type).toBe('audio/wav'); expect(wav.size).toBe(54)
  expect(view.getUint16(20, true)).toBe(1); expect(view.getUint16(22, true)).toBe(1); expect(view.getUint32(24, true)).toBe(16000); expect(view.getUint16(34, true)).toBe(16)
  expect(Array.from({ length: 5 }, (_, index) => view.getInt16(44 + index * 2, true))).toEqual([-32768, 0, 32767, 32767, 0])
})
it('decodes the complete compressed blob and resamples all its audio to canonical WAV', async () => {
  const audio = new Blob(['all compressed bytes'], { type: 'audio/webm' })
  const wav = await prepareStudentTaskAudio(audio, new AbortController().signal)
  expect((decode.mock.calls[0][0] as ArrayBuffer).byteLength).toBe(audio.size)
  expect(offline).toHaveBeenCalledWith(1, 20000, 16000)
  expect(wav.size).toBe(44 + 20000 * 2)
  expect(source.start).toHaveBeenCalledOnce(); expect(source.disconnect).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce()
})
it('rejects decoded audio longer than 30 seconds instead of truncating it before upload', async () => {
  duration = 30.1
  await expect(prepareStudentTaskAudio(new Blob(['clip']), new AbortController().signal)).rejects.toThrow('recording_duration')
  expect(offline).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce()
})
it('closes owned decoding resources on cancellation and ignores a late decode result', async () => {
  let release!: (audio: { duration: number }) => void
  decode.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const controller = new AbortController()
  const pending = prepareStudentTaskAudio(new Blob(['clip']), controller.signal)
  await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce())
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  release({ duration: 1 })
  expect(offline).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce()
})
