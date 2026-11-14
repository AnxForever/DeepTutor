export const STUDENT_RECORDING_MS = 25_000
export const STUDENT_COMPRESSED_MAX_BYTES = 4 * 1024 * 1024
export const STUDENT_WAV_MAX_BYTES = 1024 * 1024
const SAMPLE_RATE = 16_000
const aborted = () => new DOMException('Recording cancelled', 'AbortError')

function interruptible<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted())
  return new Promise((resolve, reject) => {
    const stop = () => reject(aborted())
    signal.addEventListener('abort', stop, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop)).catch(() => {})
  })
}
/** Canonical PCM16 WAV; no compressed clip or raw audio enters local drafts. */
export function studentTaskWav(samples: Float32Array): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const word = (offset: number, value: string) => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)) }
  word(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); word(8, 'WAVE'); word(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); word(36, 'data'); view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index++) { const sample = Number.isFinite(samples[index]) ? Math.max(-1, Math.min(1, samples[index])) : 0; view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true) }
  return new Blob([buffer], { type: 'audio/wav' })
}
export async function prepareStudentTaskAudio(audio: Blob, signal: AbortSignal): Promise<Blob> {
  if (signal.aborted) throw aborted()
  if (!audio.size || audio.size > STUDENT_COMPRESSED_MAX_BYTES) throw new Error('recording_size')
  const AudioContextType = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextType || typeof OfflineAudioContext === 'undefined') throw new Error('audio_processing_unavailable')
  const context = new AudioContextType()
  let source: AudioBufferSourceNode | null = null
  let closed = false
  const close = () => { if (closed) return; closed = true; try { source?.stop(); source?.disconnect() } catch { /* Rendering may already have ended. */ } void context.close().catch(() => {}) }
  signal.addEventListener('abort', close, { once: true })
  try {
    const bytes = await interruptible(audio.arrayBuffer(), signal)
    const decoded = await interruptible(context.decodeAudioData(bytes), signal)
    if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > 30) throw new Error('recording_duration')
    const frameCount = Math.ceil(decoded.duration * SAMPLE_RATE)
    if (44 + frameCount * 2 > STUDENT_WAV_MAX_BYTES) throw new Error('recording_size')
    const renderer = new OfflineAudioContext(1, frameCount, SAMPLE_RATE)
    source = renderer.createBufferSource(); source.buffer = decoded; source.connect(renderer.destination); source.start()
    const output = await interruptible(renderer.startRendering(), signal)
    if (signal.aborted) throw aborted()
    const wav = studentTaskWav(output.getChannelData(0))
    if (wav.size > STUDENT_WAV_MAX_BYTES) throw new Error('recording_size')
    return wav
  } finally { signal.removeEventListener('abort', close); close() }
}
