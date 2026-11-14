'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getStudentTaskHints, revealStudentTaskHint, validStudentTaskHints, type RevealStudentHintRequest, type StudentTaskHintsState } from '@/lib/student-task-hints-api'
import { randomUuid } from '@/lib/random-uuid'
import { isApiError } from '@/shared/api/errors'

type HintMessage = 'unavailable' | 'retry' | 'changed' | 'recovered' | null
type PendingHint = { body: RevealStudentHintRequest; beforeCount: number; source: string }
export interface StudentTaskHintsOptions { accountId: string; taskId: string; questionId: string; questionIds: string[]; disabled?: boolean; readOnly?: boolean }
export function useStudentTaskHints({ accountId, taskId, questionId, questionIds, disabled = false, readOnly = false }: StudentTaskHintsOptions) {
  const owner = JSON.stringify([accountId, taskId])
  const idsKey = JSON.stringify(questionIds)
  const source = JSON.stringify([owner, questionId, idsKey, readOnly])
  const current = useRef({ source, disabled, readOnly }); current.current = { source, disabled, readOnly }
  const mounted = useRef(false)
  const read = useRef<AbortController | null>(null)
  const action = useRef<AbortController | null>(null)
  const pending = useRef<PendingHint | null>(null)
  const latest = useRef<{ owner: string; value: StudentTaskHintsState } | null>(null)
  const [record, setRecord] = useState<typeof latest.current>(null)
  const [loadingFor, setLoadingFor] = useState<string | null>(source)
  const [postingFor, setPostingFor] = useState<string | null>(null)
  const [message, setMessage] = useState<{ source: string; kind: HintMessage }>({ source, kind: null })
  const [refreshRequiredFor, setRefreshRequiredFor] = useState<string | null>(null)
  const [deniedFor, setDeniedFor] = useState<string | null>(null)
  const active = useCallback((controller: AbortController) => mounted.current && current.current.source === source && !controller.signal.aborted, [source])
  const say = useCallback((kind: HintMessage) => setMessage({ source, kind }), [source])
  const accept = useCallback((value: StudentTaskHintsState): StudentTaskHintsState => {
    if (!validStudentTaskHints(value, taskId, JSON.parse(idsKey) as string[])) throw new Error('Hint response did not match the task')
    const previous = latest.current
    if (previous?.owner === owner && previous.value.hint_revision > value.hint_revision) return previous.value
    const next = { owner, value }; latest.current = next; setRecord(next)
    return value
  }, [taskId, idsKey, owner])
  const readState = useCallback(async (controller: AbortController) => {
    const value = await getStudentTaskHints(taskId, controller.signal)
    return active(controller) ? accept(value) : null
  }, [taskId, active, accept])
  const reconcile = useCallback(async () => {
    if (action.current) return
    read.current?.abort()
    const controller = new AbortController(); read.current = controller
    setLoadingFor(source)
    try {
      const value = await readState(controller)
      if (!value || !active(controller)) return
      setRefreshRequiredFor(null)
      const intent = pending.current
      if (intent?.source === source) {
        const count = value.questions.find(question => question.question_id === intent.body.question_id)?.revealed.length ?? 0
        if (count > intent.beforeCount) { pending.current = null; say('recovered') } else say('retry')
      } else say(null)
    } catch { if (active(controller)) { setRefreshRequiredFor(source); say(pending.current ? 'retry' : 'unavailable') } }
    finally { if (active(controller)) setLoadingFor(null); if (read.current === controller) read.current = null }
  }, [source, readState, active, say])
  useEffect(() => {
    mounted.current = true; pending.current = null
    void reconcile()
    return () => { mounted.current = false; read.current?.abort(); action.current?.abort(); read.current = null; action.current = null; pending.current = null }
  }, [source, reconcile])

  const send = useCallback(async (intent: PendingHint) => {
    if (action.current || current.current.source !== source || current.current.disabled || current.current.readOnly) return
    read.current?.abort(); read.current = null; setLoadingFor(null)
    const controller = new AbortController(); action.current = controller; pending.current = intent
    setPostingFor(source); say(null)
    try {
      const value = await revealStudentTaskHint(taskId, intent.body, controller.signal)
      if (!active(controller)) return
      accept(value); pending.current = null; setRefreshRequiredFor(null); say(null)
    } catch (reason) {
      if (!active(controller)) return
      const conflict = isApiError(reason) && reason.status === 409
      if (conflict) pending.current = null
      // A lost acknowledgement is checked with GET, never another automatic POST.
      try {
        const value = await readState(controller)
        if (!value || !active(controller)) return
        const count = value.questions.find(question => question.question_id === intent.body.question_id)?.revealed.length ?? 0
        setRefreshRequiredFor(null)
        if (conflict) {
          const unavailable = (isApiError(reason) && reason.code === 'teaching_student_task_revoked') || value.hint_revision === intent.body.expected_hint_revision && count === intent.beforeCount
          if (unavailable) setDeniedFor(source)
          say(unavailable ? 'unavailable' : 'changed')
        } else if (count > intent.beforeCount) { pending.current = null; say('recovered') }
        else say('retry')
      } catch { if (active(controller)) { setRefreshRequiredFor(source); say(conflict ? 'unavailable' : 'retry') } }
    } finally { if (active(controller)) setPostingFor(null); if (action.current === controller) action.current = null }
  }, [source, taskId, active, accept, readState, say])

  const state = record?.owner === owner ? record.value : null
  const question = state?.questions.find(value => value.question_id === questionId) ?? null
  const busy = postingFor === source
  const loading = loadingFor === source
  const pendingRetry = pending.current?.source === source
  const reveal = useCallback(() => {
    const state = latest.current?.owner === owner ? latest.current.value : null
    const question = state?.questions.find(value => value.question_id === questionId)
    if (!state || !question || question.revealed.length >= question.total || pending.current || refreshRequiredFor === source || deniedFor === source || loadingFor === source) return
    void send({ body: { question_id: questionId, request_id: randomUuid(), expected_hint_revision: state.hint_revision }, beforeCount: question.revealed.length, source })
  }, [owner, questionId, source, refreshRequiredFor, deniedFor, loadingFor, send])
  const retry = useCallback(() => { const intent = pending.current; if (intent?.source === source) void send(intent) }, [source, send])
  const tryAlone = useCallback(() => {
    const controller = action.current
    if (!controller || current.current.source !== source) return
    action.current = null; controller.abort(); setPostingFor(null)
    setRefreshRequiredFor(source); say('retry')
  }, [source, say])
  return { state, question, busy, loading, pendingRetry, message: message.source === source ? message.kind : null, requiresRefresh: refreshRequiredFor === source, denied: deniedFor === source, reveal, retry, reconcile, tryAlone }
}
export type StudentTaskHintsController = ReturnType<typeof useStudentTaskHints>
