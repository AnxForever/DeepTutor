'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, Square, Volume2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useVoiceRecorder } from '@/hooks/useVoiceRecorder'
import { useStudentQuestionSpeech } from '@/hooks/useStudentQuestionSpeech'
import { prepareStudentTaskAudio, STUDENT_COMPRESSED_MAX_BYTES, STUDENT_RECORDING_MS } from '@/lib/student-task-audio'
import { getStudentVoiceCapabilities, transcribeStudentTaskAudio, type StudentTranscriptionCandidate, type StudentVoiceCandidate, type StudentVoiceCapabilities, type StudentVoiceLocale } from '@/lib/student-task-voice-api'
import type { TaskResponse } from '@/lib/student-tasks-api'
import { randomUuid } from '@/lib/random-uuid'
import { Button, Field, InlineAlert } from '@/shared/ui'

export interface StudentTaskVoiceControlsProps {
  accountId: string; taskId: string; taskRevision: number; progressRevision: number; questionId: string; locale: StudentVoiceLocale
  currentResponse: TaskResponse; disabled: boolean; candidate: StudentVoiceCandidate | null
  onCandidateChange: (candidate: StudentVoiceCandidate | null) => void
  onAccept: () => void
  onBusyChange: (busy: boolean) => void
}
export function appendedStudentAnswer(current: TaskResponse, text: string): TaskResponse | null {
  if (!text.trim()) return null
  const answer = current.answer ? `${current.answer}\n${text}` : text
  if (Array.from(answer).length > 6000) return null
  return { ...current, answer, response_status: current.response_status === 'needs_help' ? 'needs_help' : 'answered' }
}
export default function StudentTaskVoiceControls({ accountId, taskId, taskRevision, progressRevision, questionId, locale, currentResponse, disabled, candidate, onCandidateChange, onAccept, onBusyChange }: StudentTaskVoiceControlsProps) {
  const { t } = useTranslation()
  const scopeKey = JSON.stringify([accountId, taskId, taskRevision, questionId, locale])
  const scope = useRef(scopeKey); scope.current = scopeKey
  const mounted = useRef(false)
  const checks = useRef<AbortController | null>(null)
  const checkingRef = useRef(false)
  const [checking, setChecking] = useState(false)
  const [caps, setCaps] = useState<StudentVoiceCapabilities | null>(null)
  const [capsFailed, setCapsFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const [recordError, setRecordError] = useState(false)
  const [sourceChanged, setSourceChanged] = useState(false)
  const capture = useRef<{ scope: string; requestId: string; basis: number } | null>(null)
  const recognized = useRef<StudentTranscriptionCandidate | null>(null)
  const speech = useStudentQuestionSpeech({ scopeKey, taskId, taskRevision, questionId, locale })
  const recorder = useVoiceRecorder(() => {
    const result = recognized.current
    if (!result || !capture.current || capture.current.scope !== scope.current) return
    onCandidateChange({ version: 1, ...result })
  }, { scopeKey, maxDurationMs: STUDENT_RECORDING_MS, maxBytes: STUDENT_COMPRESSED_MAX_BYTES, prepareAudio: prepareStudentTaskAudio, transcribe: async (audio, { signal }) => {
    const source = capture.current
    if (!source || source.scope !== scope.current) throw new DOMException('Cancelled', 'AbortError')
    const result = await transcribeStudentTaskAudio(taskId, questionId, source.requestId, source.basis, audio, signal)
    if (signal.aborted || source.scope !== scope.current || result.task_id !== taskId || result.question_id !== questionId || result.task_revision !== taskRevision || result.request_id !== source.requestId || result.basis_progress_revision !== source.basis || result.requires_confirmation !== true || typeof result.text !== 'string' || Array.from(result.text).length > 6000) throw new Error('Transcription source changed')
    recognized.current = result
    return result.text
  } })
  const busy = checking || recorder.state !== 'idle'
  const { cancel: cancelRecording } = recorder
  const { stop: stopSpeech } = speech
  useEffect(() => { onBusyChange(busy) }, [busy, onBusyChange])
  useEffect(() => () => onBusyChange(false), [onBusyChange])
  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    const source = scopeKey
    void getStudentVoiceCapabilities(taskId, questionId, locale, controller.signal).then(value => {
      if (!controller.signal.aborted && source === scope.current) {
        if (value.task_id === taskId && value.question_id === questionId && value.task_revision === taskRevision) { setCaps(value); setCapsFailed(false) }
        else setSourceChanged(true)
      }
    }).catch(() => { if (!controller.signal.aborted && source === scope.current) setCapsFailed(true) })
    return () => { mounted.current = false; controller.abort(); checks.current?.abort() }
  }, [taskId, questionId, taskRevision, locale, scopeKey, retry])
  const cancel = useCallback(() => { checks.current?.abort(); checkingRef.current = false; setChecking(false); cancelRecording(); recognized.current = null; capture.current = null; onBusyChange(false) }, [cancelRecording, onBusyChange])
  useEffect(() => { if (disabled) { cancel(); stopSpeech() } }, [disabled, cancel, stopSpeech])
  useEffect(() => { cancel(); stopSpeech() }, [scopeKey, cancel, stopSpeech])
  useEffect(() => {
    const hidden = () => { if (document.hidden) { cancel(); stopSpeech() } }
    document.addEventListener('visibilitychange', hidden)
    return () => document.removeEventListener('visibilitychange', hidden)
  }, [cancel, stopSpeech])
  async function begin(replacing = false) {
    if (disabled || sourceChanged || document.hidden || checkingRef.current || recorder.state !== 'idle' || (candidate && !replacing)) return
    onBusyChange(true)
    speech.stop(); recorder.cancel(); setRecordError(false)
    if (replacing) onCandidateChange(null)
    checkingRef.current = true; setChecking(true)
    const source = scopeKey
    const controller = new AbortController(); checks.current?.abort(); checks.current = controller
    try {
      const fresh = await getStudentVoiceCapabilities(taskId, questionId, locale, controller.signal)
      if (!mounted.current || document.hidden || controller.signal.aborted || source !== scope.current) return
      setCaps(fresh); setCapsFailed(false)
      if (fresh.task_id !== taskId || fresh.question_id !== questionId || fresh.task_revision !== taskRevision) { setSourceChanged(true); return }
      if (!fresh.transcription.available) return
      capture.current = { scope: source, requestId: randomUuid(), basis: progressRevision }; recognized.current = null
      await recorder.start()
    } catch { if (!controller.signal.aborted && mounted.current) { setCapsFailed(true); setRecordError(true) } }
    finally { if (!controller.signal.aborted && mounted.current && source === scope.current) { checkingRef.current = false; setChecking(false) } }
  }
  const transcriptAvailable = caps?.transcription.available === true
  const support = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined'
  const textError = candidate && !candidate.text.trim() ? 'studentTaskVoice.emptyCandidate' : candidate && !appendedStudentAnswer(currentResponse, candidate.text) ? 'studentTaskVoice.lengthLimit' : null
  const recorderMessage = recorder.errorCode === 'permission_denied' ? 'studentTaskVoice.permissionDenied' : recorder.errorCode === 'unsupported' ? 'studentTaskVoice.deviceUnsupported' : recorder.errorCode === 'recording_too_large' ? 'studentTaskVoice.recordTooLarge' : recorder.errorCode === 'empty_transcript' ? 'studentTaskVoice.noSpeech' : recorder.errorCode === 'prepare_failed' ? 'studentTaskVoice.prepareFailed' : 'studentTaskVoice.recordFailed'
  return <section className="mt-6 rounded-xl border border-border bg-muted/20 p-4 sm:p-5" aria-label={t('studentTaskVoice.title')}>
    <div className="flex flex-wrap gap-3"><Button size="lg" variant="secondary" icon={speech.state === 'idle' ? <Volume2 size={18} /> : <Square size={18} />} disabled={disabled || sourceChanged || busy || (!speech.localAvailable || !caps?.read_aloud.available) && speech.state === 'idle'} onClick={() => { if (speech.state === 'idle') void speech.speak(); else speech.stop() }}>{t(speech.state === 'idle' ? 'studentTaskVoice.listen' : 'studentTaskVoice.stopListening')}</Button>
      {!candidate && !busy && <Button size="lg" variant="secondary" icon={<Mic size={18} />} disabled={disabled || sourceChanged || !transcriptAvailable || !support} onClick={() => void begin()}>{t('studentTaskVoice.record')}</Button>}
      {recorder.state === 'recording' && <Button size="lg" icon={<Square size={18} />} onClick={recorder.stop}>{t('studentTaskVoice.stopRecording')}</Button>}
      {busy && <Button size="lg" variant="secondary" icon={<X size={18} />} onClick={cancel}>{t('studentTaskVoice.cancel')}</Button>}
    </div>
    {speech.state === 'loading' && <p role="status" className="mt-3 text-sm text-muted-foreground">{t('studentTaskVoice.preparingSpeech')}</p>}
    {!speech.localAvailable && <p className="mt-3 text-sm leading-6 text-muted-foreground">{t('studentTaskVoice.localVoiceUnavailable')}</p>}
    {speech.localAvailable && caps && !caps.read_aloud.available && <p className="mt-3 text-sm leading-6 text-muted-foreground">{t('studentTaskVoice.speechUnavailable')}</p>}
    {speech.error && <InlineAlert tone="warning" className="mt-3">{t('studentTaskVoice.speechFailed')}</InlineAlert>}
    {busy && <p role="status" className="mt-4 text-base leading-7">{t(recorder.state === 'recording' ? 'studentTaskVoice.recording' : recorder.state === 'requesting' || checking ? 'studentTaskVoice.requesting' : 'studentTaskVoice.processing')}</p>}
    {!busy && !candidate && transcriptAvailable && support && <p className="mt-3 text-sm leading-6 text-muted-foreground">{t('studentTaskVoice.recordHint')}</p>}
    {!busy && !candidate && !support && <p className="mt-3 text-sm leading-6 text-muted-foreground">{t('studentTaskVoice.deviceUnsupported')}</p>}
    {!busy && caps && !transcriptAvailable && <p className="mt-3 text-sm leading-6 text-muted-foreground">{t(caps.transcription.reason === 'task_voice_input_disabled' ? 'studentTaskVoice.inputUnavailable' : 'studentTaskVoice.transcriptionUnavailable')}</p>}
    {(capsFailed || recordError) && <InlineAlert tone="warning" className="mt-3" action={<Button variant="secondary" disabled={busy} onClick={() => setRetry(value => value + 1)}>{t('studentTaskVoice.retryReadiness')}</Button>}>{t('studentTaskVoice.readinessFailed')}</InlineAlert>}
    {recorder.error && <InlineAlert tone="warning" className="mt-3">{t(recorderMessage)}</InlineAlert>}
    {sourceChanged && <InlineAlert tone="warning" className="mt-3">{t('studentTaskVoice.stale')}</InlineAlert>}
    {candidate && <div className="mt-5"><h3 className="text-lg font-semibold">{t('studentTaskVoice.candidateTitle')}</h3><p className="mb-4 mt-2 text-sm leading-6 text-muted-foreground">{t('studentTaskVoice.candidateHint')}</p><Field label={t('studentTaskVoice.candidateLabel')} error={textError ? t(textError) : undefined}><textarea className="min-h-28 w-full rounded-xl border border-border bg-background p-3 text-lg leading-8 outline-none focus:ring-2 focus:ring-ring" rows={4} maxLength={6000} value={candidate.text} disabled={disabled || busy} onChange={event => { speech.stop(); onCandidateChange({ ...candidate, text: event.target.value }) }} /></Field><div className="mt-4 flex flex-wrap gap-3"><Button size="lg" disabled={disabled || sourceChanged || busy || Boolean(textError)} onClick={onAccept}>{t('studentTaskVoice.accept')}</Button><Button size="lg" variant="secondary" disabled={busy} onClick={() => { speech.stop(); onCandidateChange(null) }}>{t('studentTaskVoice.discard')}</Button><Button size="lg" variant="ghost" disabled={disabled || sourceChanged || busy || !support || !transcriptAvailable} onClick={() => void begin(true)}>{t('studentTaskVoice.recordAgain')}</Button><Button size="lg" variant="ghost" icon={<Volume2 size={18} />} disabled={disabled || busy || !speech.localAvailable || !candidate.text.trim()} onClick={() => { if (speech.target === 'candidate' && speech.state !== 'idle') speech.stop(); else speech.speakCandidate(candidate.text) }}>{t(speech.target === 'candidate' && speech.state !== 'idle' ? 'studentTaskVoice.stopListening' : 'studentTaskVoice.listenCandidate')}</Button></div></div>}
  </section>
}
