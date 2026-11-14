'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getStudentSpeechText, type StudentVoiceLocale } from '@/lib/student-task-voice-api'

export function matchingLocalVoice(voices: SpeechSynthesisVoice[], locale: StudentVoiceLocale): SpeechSynthesisVoice | null {
  return voices.find(voice => voice.localService === true && voice.lang.toLowerCase().split(/[-_]/)[0] === locale) ?? null
}
let activeSpeech: { owner: object; stop: () => void } | null = null
export function useStudentQuestionSpeech({ scopeKey, taskId, taskRevision, questionId, locale }: { scopeKey: string; taskId: string; taskRevision: number; questionId: string; locale: StudentVoiceLocale }) {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [state, setState] = useState<'idle' | 'loading' | 'speaking'>('idle')
  const [target, setTarget] = useState<'question' | 'candidate' | null>(null)
  const [error, setError] = useState<'unavailable' | 'failed' | null>(null)
  const mounted = useRef(false)
  const owner = useRef({})
  const generation = useRef(0)
  const source = useRef(scopeKey); source.current = scopeKey
  const request = useRef<AbortController | null>(null)
  const utterance = useRef<SpeechSynthesisUtterance | null>(null)
  const stop = useCallback(() => {
    generation.current++; request.current?.abort(); request.current = null
    if (utterance.current) { utterance.current.onend = null; utterance.current.onerror = null; utterance.current = null }
    if (activeSpeech?.owner === owner.current) { window.speechSynthesis?.cancel(); activeSpeech = null }
    if (mounted.current) { setState('idle'); setTarget(null) }
  }, [])
  useEffect(() => {
    mounted.current = true
    const read = () => setVoices(window.speechSynthesis?.getVoices() ?? [])
    read(); window.speechSynthesis?.addEventListener?.('voiceschanged', read)
    const hidden = () => { if (document.hidden) stop() }
    document.addEventListener('visibilitychange', hidden)
    return () => { mounted.current = false; stop(); window.speechSynthesis?.removeEventListener?.('voiceschanged', read); document.removeEventListener('visibilitychange', hidden) }
  }, [stop])
  useEffect(() => () => stop(), [scopeKey, stop])
  const speak = useCallback(async () => {
    activeSpeech?.stop(); stop()
    setError(null)
    const voice = matchingLocalVoice(window.speechSynthesis?.getVoices() ?? [], locale)
    if (!voice || typeof SpeechSynthesisUtterance === 'undefined') { setError('unavailable'); return }
    const token = ++generation.current
    const capturedScope = scopeKey
    const controller = new AbortController(); request.current = controller
    activeSpeech = { owner: owner.current, stop }; setTarget('question'); setState('loading')
    const current = () => mounted.current && generation.current === token && source.current === capturedScope && !controller.signal.aborted
    try {
      const result = await getStudentSpeechText(taskId, questionId, locale, controller.signal)
      if (!current()) return
      if (result.task_id !== taskId || result.question_id !== questionId || result.task_revision !== taskRevision || result.locale !== locale || !result.text.trim() || voice.localService !== true) throw new Error('Speech source changed')
      const speech = new SpeechSynthesisUtterance(result.text)
      speech.voice = voice; speech.lang = voice.lang
      speech.onend = () => { if (current()) stop() }
      speech.onerror = () => { if (current()) { setError('failed'); stop() } }
      utterance.current = speech; setState('speaking'); window.speechSynthesis.speak(speech)
    } catch { if (current()) { setError('failed'); stop() } }
  }, [scopeKey, taskId, taskRevision, questionId, locale, stop])
  const speakCandidate = useCallback((text: string) => {
    activeSpeech?.stop(); stop(); setError(null)
    const voice = matchingLocalVoice(window.speechSynthesis?.getVoices() ?? [], locale)
    if (!voice || typeof SpeechSynthesisUtterance === 'undefined' || !text.trim() || Array.from(text).length > 6000) { setError('unavailable'); return }
    const token = ++generation.current; const capturedScope = scopeKey
    const current = () => mounted.current && generation.current === token && source.current === capturedScope
    const speech = new SpeechSynthesisUtterance(text)
    speech.voice = voice; speech.lang = voice.lang
    speech.onend = () => { if (current()) stop() }
    speech.onerror = () => { if (current()) { setError('failed'); stop() } }
    utterance.current = speech; activeSpeech = { owner: owner.current, stop }; setTarget('candidate'); setState('speaking')
    try { window.speechSynthesis.speak(speech) } catch { setError('failed'); stop() }
  }, [locale, scopeKey, stop])
  return { state, target, error, localAvailable: typeof SpeechSynthesisUtterance !== 'undefined' && matchingLocalVoice(voices, locale) !== null, speak, speakCandidate, stop }
}
