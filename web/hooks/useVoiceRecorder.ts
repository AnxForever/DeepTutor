"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch, apiUrl } from "@/lib/api";
import { stripAudioMimeParameters } from "@/lib/voice-mime";

export type RecorderState = 'idle' | 'requesting' | 'recording' | 'preparing' | 'transcribing';
export type RecorderErrorCode = 'unsupported' | 'permission_denied' | 'recording_failed' | 'recording_too_large' | 'prepare_failed' | 'transcription_failed' | 'empty_transcript';
export interface VoiceRecorderOptions {
  scopeKey?: string;
  maxDurationMs?: number;
  maxBytes?: number;
  prepareAudio?: (audio: Blob, signal: AbortSignal) => Promise<Blob>;
  transcribe?: (audio: Blob, context: { signal: AbortSignal; filename: string }) => Promise<string>;
}
type Capture = { recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; bytes: number; timer: ReturnType<typeof setTimeout> | null; finishRequested: boolean; detach: () => void };
const stopTracks = (stream: MediaStream) => stream.getTracks().forEach(track => track.stop());
async function defaultTranscribe(audio: Blob, { signal, filename }: { signal: AbortSignal; filename: string }): Promise<string> {
  const form = new FormData(); form.append('file', audio, filename);
  const resp = await apiFetch(apiUrl('/api/voice/stt'), { method: 'POST', body: form, signal });
  if (!resp.ok) {
    const detail = await resp.json().catch(() => null) as { detail?: unknown } | null;
    throw new Error(typeof detail?.detail === 'string' ? detail.detail : `Transcription failed (HTTP ${resp.status}).`);
  }
  const data = await resp.json() as { text?: string };
  return data.text ?? '';
}

/** Explicit capture with optional transport; cancelling never transcribes. */
export function useVoiceRecorder(onTranscript: (text: string) => void, options: VoiceRecorderOptions = {}) {
  const [state, setState] = useState<RecorderState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<RecorderErrorCode | null>(null);
  const captureRef = useRef<Capture | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const starting = useRef(false);
  const stateRef = useRef<RecorderState>('idle');
  const scope = useRef(options.scopeKey); scope.current = options.scopeKey;
  const latest = useRef({ onTranscript, options }); latest.current = { onTranscript, options };
  const stage = useCallback((next: RecorderState) => { stateRef.current = next; if (mounted.current) setState(next); }, []);
  const fail = useCallback((code: RecorderErrorCode, message: string) => { if (mounted.current) { setErrorCode(code); setError(message); } }, []);
  const cancel = useCallback(() => {
    generation.current += 1; starting.current = false;
    controllerRef.current?.abort(); controllerRef.current = null;
    const capture = captureRef.current; captureRef.current = null;
    if (capture) {
      if (capture.timer !== null) clearTimeout(capture.timer);
      capture.detach();
      capture.recorder.ondataavailable = null; capture.recorder.onstop = null; capture.recorder.onerror = null;
      if (capture.recorder.state !== 'inactive') { try { capture.recorder.stop(); } catch { /* Already ended. */ } }
      stopTracks(capture.stream); capture.chunks = [];
    }
    stage('idle');
    if (mounted.current) { setError(null); setErrorCode(null); }
  }, [stage]);
  const stop = useCallback(() => {
    const capture = captureRef.current;
    if (!capture || stateRef.current !== 'recording') return;
    if (capture.finishRequested) return;
    if (capture.recorder.state === 'inactive') { cancel(); fail('recording_failed', 'Recording ended before it was finished.'); return; }
    if (capture.timer !== null) clearTimeout(capture.timer);
    capture.timer = null;
    // Only this user/consented-duration path authorizes preparation and upload.
    capture.finishRequested = true;
    try { capture.recorder.stop(); } catch { cancel(); fail('recording_failed', 'Recording failed.'); return; }
    // Final ondataavailable/onstop are queued. Stop hardware before decoding.
    stopTracks(capture.stream);
  }, [cancel, fail]);
  const start = useCallback(async () => {
    if (starting.current || stateRef.current !== 'idle') return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { fail('unsupported', 'Recording is not supported in this browser.'); return; }
    starting.current = true;
    const gen = ++generation.current;
    const capturedScope = scope.current;
    const settings = { ...latest.current.options };
    const controller = new AbortController(); controllerRef.current = controller;
    const current = () => mounted.current && gen === generation.current && capturedScope === scope.current && !controller.signal.aborted;
    setError(null); setErrorCode(null); stage('requesting');
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { if (current()) { fail('permission_denied', 'Microphone permission denied.'); starting.current = false; stage('idle'); } return; }
    if (!current()) { stopTracks(stream); return; }
    let recorder: MediaRecorder;
    try { recorder = new MediaRecorder(stream); }
    catch { stopTracks(stream); starting.current = false; fail('recording_failed', 'Recording could not start.'); stage('idle'); return; }
    const capture: Capture = { recorder, stream, chunks: [], bytes: 0, timer: null, finishRequested: false, detach: () => {} };
    captureRef.current = capture;
    const ended = () => { if (current() && !capture.finishRequested) { cancel(); fail('recording_failed', 'Recording was interrupted.'); } };
    stream.getTracks().forEach(track => track.addEventListener?.('ended', ended));
    capture.detach = () => stream.getTracks().forEach(track => track.removeEventListener?.('ended', ended));
    recorder.ondataavailable = event => {
      if (!current() || !event.data?.size) return;
      capture.bytes += event.data.size;
      if (settings.maxBytes && capture.bytes > settings.maxBytes) { cancel(); fail('recording_too_large', 'The recording is too large. Try a shorter answer.'); return; }
      capture.chunks.push(event.data);
    };
    recorder.onerror = () => { if (current()) { cancel(); fail('recording_failed', 'Recording failed.'); } };
    recorder.onstop = async () => {
      if (capture.timer !== null) clearTimeout(capture.timer);
      capture.detach();
      if (!current()) { stopTracks(stream); return; }
      if (!capture.finishRequested) { cancel(); fail('recording_failed', 'Recording was interrupted.'); return; }
      stopTracks(stream);
      const mimeType = stripAudioMimeParameters(recorder.mimeType);
      let audio = new Blob(capture.chunks, { type: mimeType }); capture.chunks = [];
      if (!audio.size) { fail('empty_transcript', 'No audio was recorded.'); stage('idle'); captureRef.current = null; return; }
      let preparing = Boolean(settings.prepareAudio);
      try {
        if (settings.prepareAudio) { stage('preparing'); audio = await settings.prepareAudio(audio, controller.signal); }
        if (!current()) return;
        preparing = false; stage('transcribing');
        const extension = audio.type.includes('wav') ? 'wav' : audio.type.includes('ogg') ? 'ogg' : audio.type.includes('mp4') ? 'mp4' : 'webm';
        const text = (await (settings.transcribe ?? defaultTranscribe)(audio, { signal: controller.signal, filename: `recording.${extension}` })).trim();
        if (!current()) return;
        if (text) latest.current.onTranscript(text); else fail('empty_transcript', 'No speech was recognized.');
      } catch (reason) { if (current()) fail(preparing ? 'prepare_failed' : 'transcription_failed', reason instanceof Error ? reason.message : 'Transcription failed.'); }
      finally { if (current()) { captureRef.current = null; controllerRef.current = null; stage('idle'); } }
    };
    try {
      recorder.start(250); starting.current = false; stage('recording');
      if (settings.maxDurationMs) capture.timer = setTimeout(() => { if (current()) stop(); }, settings.maxDurationMs);
    } catch { cancel(); fail('recording_failed', 'Recording could not start.'); }
  }, [cancel, fail, stage, stop]);
  const toggle = useCallback(() => { if (stateRef.current === 'recording') stop(); else if (stateRef.current === 'idle') void start(); }, [start, stop]);
  useEffect(() => {
    mounted.current = true;
    const hidden = () => { if (document.hidden) cancel(); };
    document.addEventListener('visibilitychange', hidden);
    return () => { mounted.current = false; cancel(); document.removeEventListener('visibilitychange', hidden); };
  }, [cancel]);
  useEffect(() => () => cancel(), [options.scopeKey, cancel]);
  return { state, error, errorCode, toggle, start, stop, cancel };
}
