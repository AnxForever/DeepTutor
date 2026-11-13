import { requestJson } from '@/shared/api/client'
import { scopedUrl } from '@/lib/workspace-scope'
import type { components } from '@/contracts/generated/api'

const ROOT = '/api/teaching-analysis'

type Mutable<T> = T extends readonly (infer Item)[] ? Mutable<Item>[] : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T
type Schema<Name extends keyof components['schemas']> = Mutable<components['schemas'][Name]>

export type FollowupQuestion = Required<Schema<'FollowupQuestion'>>
export type SaveFollowupRequest = Omit<Required<Schema<'SaveFollowupRequest'>>, 'questions'> & { questions: FollowupQuestion[] }
export type SavedFollowup = Omit<Schema<'SavedFollowup'>, 'questions'> & { questions: FollowupQuestion[] }
export type SaveFollowupAttemptRequest = Required<Schema<'SaveFollowupAttemptRequest'>>
export type SavedFollowupAttempt = Omit<Required<Schema<'SavedFollowupAttempt'>>, 'question_snapshot'> & { question_snapshot: FollowupQuestion }

function normalizeQuestion(value: Schema<'FollowupQuestion'>): FollowupQuestion {
  return { ...value, reference_answer: value.reference_answer ?? null, rubric: value.rubric ?? null }
}

function normalizeSet(value: Schema<'SavedFollowup'>): SavedFollowup {
  return { ...value, questions: value.questions.map(normalizeQuestion) }
}

function normalizeAttempt(value: Schema<'SavedFollowupAttempt'>): SavedFollowupAttempt {
  return {
    ...value, question_snapshot: normalizeQuestion(value.question_snapshot),
    student_answer: value.student_answer ?? null, student_work: value.student_work ?? null,
    voided_at: value.voided_at ?? null, void_reason: value.void_reason ?? null,
  }
}

function endpoint(path: string, workspaceId: string) {
  return scopedUrl(`${ROOT}${path}`, workspaceId)
}

function json(body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  }
}

export async function listTeachingFollowups(reportId: string, workspaceId: string, signal?: AbortSignal) {
  return (await requestJson<Schema<'SavedFollowup'>[]>(endpoint(`/followups?report_id=${encodeURIComponent(reportId)}`, workspaceId), { cache: 'no-store', signal })).map(normalizeSet)
}

export async function getTeachingFollowup(followupId: string, workspaceId: string, signal?: AbortSignal) {
  return normalizeSet(await requestJson<Schema<'SavedFollowup'>>(endpoint(`/followups/${encodeURIComponent(followupId)}`, workspaceId), { cache: 'no-store', signal }))
}

export async function saveTeachingFollowup(payload: SaveFollowupRequest, workspaceId: string, signal?: AbortSignal) {
  return normalizeSet(await requestJson<Schema<'SavedFollowup'>>(endpoint('/followups', workspaceId), json(payload, signal)))
}

export async function getTeachingFollowupRevisions(followupId: string, workspaceId: string, signal?: AbortSignal) {
  return (await requestJson<Schema<'SavedFollowup'>[]>(endpoint(`/followups/${encodeURIComponent(followupId)}/revisions`, workspaceId), { cache: 'no-store', signal })).map(normalizeSet)
}

export async function listTeachingFollowupAttempts(followupId: string, workspaceId: string, signal?: AbortSignal) {
  return (await requestJson<Schema<'SavedFollowupAttempt'>[]>(endpoint(`/followups/${encodeURIComponent(followupId)}/attempts`, workspaceId), { cache: 'no-store', signal })).map(normalizeAttempt)
}

export async function saveTeachingFollowupAttempt(followupId: string, payload: SaveFollowupAttemptRequest, workspaceId: string, signal?: AbortSignal) {
  return normalizeAttempt(await requestJson<Schema<'SavedFollowupAttempt'>>(endpoint(`/followups/${encodeURIComponent(followupId)}/attempts`, workspaceId), json(payload, signal)))
}

export async function voidTeachingFollowupAttempt(followupId: string, attemptId: string, reason: string, workspaceId: string, signal?: AbortSignal) {
  return normalizeAttempt(await requestJson<Schema<'SavedFollowupAttempt'>>(endpoint(`/followups/${encodeURIComponent(followupId)}/attempts/${encodeURIComponent(attemptId)}/void`, workspaceId), json({ reason }, signal)))
}
