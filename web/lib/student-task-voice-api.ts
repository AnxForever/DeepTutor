import { requestJson } from '@/shared/api/client'
import { scopedUrl } from './workspace-scope'
import type { components } from '@/contracts/generated/api'

type Complete<T> = T extends readonly (infer Item)[] ? Complete<Item>[] : T extends object ? { -readonly [Key in keyof T]-?: Complete<T[Key]> } : T
export type StudentVoiceCapabilities = Complete<components['schemas']['TaskVoiceCapabilities']>
export type StudentSpeechText = Complete<components['schemas']['TaskSpeechTextResponse']>
export type StudentTranscriptionCandidate = Complete<components['schemas']['TaskVoiceTranscriptCandidate']>
export type StudentVoiceLocale = StudentSpeechText['locale']
export interface StudentVoiceCandidate extends StudentTranscriptionCandidate { version: 1 }

const endpoint = (taskId: string, path: string, params: Record<string, string>) => scopedUrl(`/api/student-tasks/${encodeURIComponent(taskId)}/${path}?${new URLSearchParams(params)}`, '')
export function getStudentVoiceCapabilities(taskId: string, questionId: string, locale: StudentVoiceLocale, signal?: AbortSignal) { return requestJson<StudentVoiceCapabilities>(endpoint(taskId, 'voice-capabilities', { question_id: questionId, locale }), { cache: 'no-store', signal }) }
export function getStudentSpeechText(taskId: string, questionId: string, locale: StudentVoiceLocale, signal?: AbortSignal) { return requestJson<StudentSpeechText>(endpoint(taskId, 'speech-text', { question_id: questionId, locale }), { cache: 'no-store', signal }) }
export function transcribeStudentTaskAudio(taskId: string, questionId: string, requestId: string, expectedRevision: number, audio: Blob, signal?: AbortSignal) {
  return requestJson<StudentTranscriptionCandidate>(endpoint(taskId, 'transcribe', { question_id: questionId, request_id: requestId, expected_revision: String(expectedRevision) }), { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: audio, signal })
}
