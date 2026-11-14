'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTeachingDraftSlot } from '@/components/learning/teaching-analysis/TeachingDrafts'
import { cloneReviewDraft, draftMatchesTask, editorForTaskReview, isSavedTaskReview, isTaskReviewDraft, reviewMatchesTask, reviewText, sameReviewContent, taskReviewSlot, type PendingTaskReview, type TaskReviewDraft } from '@/lib/task-review-drafts'
import { getTaskReviewRevision, getTaskReviewState, saveTaskReview, withdrawTaskReview, type SavedTaskReview, type TaskReviewEditor, type TaskReviewState } from '@/lib/task-reviews-api'
import type { TeacherStudentTask } from '@/lib/teacher-student-tasks-api'
import { randomUuid } from '@/lib/random-uuid'
import { isApiError } from '@/shared/api/errors'

type ReviewAction = { controller: AbortController; pending: PendingTaskReview; acknowledgement: SavedTaskReview | null }
const freshDraft = (task: TeacherStudentTask, review: SavedTaskReview | null): TaskReviewDraft => ({ kind: 'task-review-editor', version: 1, task_id: task.task_id, submission_id: task.submission!.submission_id, editor: editorForTaskReview(task, review), editing: review === null, withdraw_reason: '', withdrawing: false, pending: null, acknowledged: null })
export function validReviewState(state: TaskReviewState, task: TeacherStudentTask) {
  return state.task_id === task.task_id && state.submission_id === (task.submission?.submission_id ?? null) && (state.current_review === null || isSavedTaskReview(state.current_review) && reviewMatchesTask(state.current_review, task))
}
function matchesAcknowledgement(value: SavedTaskReview, pending: PendingTaskReview, task: TeacherStudentTask) {
  if (!isSavedTaskReview(value) || !reviewMatchesTask(value, task) || value.request_id !== pending.body.request_id || value.revision !== pending.body.expected_revision + 1) return false
  return pending.kind === 'save' ? value.status === 'confirmed' && sameReviewContent(value, pending.body) : value.status === 'withdrawn' && value.change_reason === pending.body.reason
}

export function useTaskReviewEditor(task: TeacherStudentTask, initial: TaskReviewState, workspaceId: string, canWrite = true) {
  const [head, setHead] = useState(initial.current_review)
  const headRef = useRef(head)
  const [headVerified, setHeadVerified] = useState(true)
  const [draft, setDraft] = useState(() => freshDraft(task, initial.current_review))
  const draftRef = useRef(draft); draftRef.current = draft
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<'save' | 'withdraw' | 'check' | 'reload' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ key: string; revision: number } | null>(null)
  const [ackVerified, setAckVerified] = useState(false)
  const [cleanupFailed, setCleanupFailed] = useState(false)
  const [cleanupNonce, setCleanupNonce] = useState(0)
  const [reloadOpen, setReloadOpen] = useState(false)
  const [linkerDirty, setLinkerDirty] = useState(false)
  const linkerDirtyRef = useRef(false)
  const [linkerReview, setLinkerReview] = useState<SavedTaskReview | null>(initial.current_review)
  const alive = useRef(true)
  const action = useRef<ReviewAction | null>(null)
  const read = useRef<AbortController | null>(null)
  const restored = useRef<TaskReviewDraft | null>(null)
  const [restoreNonce, setRestoreNonce] = useState(0)
  const { clear } = useTeachingDraftSlot({ slot: taskReviewSlot(task.task_id, task.submission!.submission_id), value: draft, dirty: dirty || draft.pending !== null || draft.acknowledged !== null || Boolean(draft.withdraw_reason), validate: (value): value is TaskReviewDraft => isTaskReviewDraft(value) && draftMatchesTask(value, task), onRestore(value) {
    const captured = cloneReviewDraft(value); restored.current = captured
    setDraft(captured); setDirty(true); setAckVerified(false); setCleanupFailed(false); setNotice(null); setError(value.pending ? 'pending' : null); setRestoreNonce(value => value + 1)
  } })
  useEffect(() => { alive.current = true; return () => { alive.current = false; action.current?.controller.abort(); read.current?.abort() } }, [])
  const applyHead = useCallback((state: TaskReviewState) => {
    if (!validReviewState(state, task) || (headRef.current && (!state.current_review || state.current_review.revision < headRef.current.revision))) throw new Error('Review state did not match')
    headRef.current = state.current_review; setHead(state.current_review); setHeadVerified(true)
    if (!linkerDirtyRef.current) setLinkerReview(state.current_review)
    return state.current_review
  }, [task])
  const onLinkerDirtyChange = useCallback((value: boolean) => {
    linkerDirtyRef.current = value; setLinkerDirty(value)
    if (!value) setLinkerReview(headRef.current)
  }, [])
  function finishAcknowledgement(value: SavedTaskReview, latest: TaskReviewState | null) {
    let current = headRef.current
    if (latest && (!validReviewState(latest, task) || !latest.current_review || latest.current_review.revision < value.revision || current && latest.current_review.revision < current.revision)) latest = null
    if (latest) current = applyHead(latest)
    else {
      setHeadVerified(false)
      if (!current || current.revision < value.revision) { current = value; headRef.current = value; setHead(value); if (!linkerDirtyRef.current) setLinkerReview(value) }
    }
    const newer = Boolean(current && current.revision > value.revision)
    setDraft(previous => ({ ...previous, editor: editorForTaskReview(task, value), pending: null, acknowledged: cloneReviewDraft(value), editing: false, withdrawing: false, withdraw_reason: '' }))
    setDirty(newer); setAckVerified(true); setCleanupFailed(false); setError(latest ? null : 'headUnverified'); setNotice({ key: newer ? 'savedNewer' : 'saved', revision: value.revision })
  }
  useEffect(() => {
    const acknowledged = draft.acknowledged
    if (!acknowledged || !ackVerified || head?.revision !== acknowledged.revision) return
    let mounted = true
    void clear().then(() => { if (mounted && alive.current) { setDraft(previous => ({ ...previous, acknowledged: null })); setDirty(false); setCleanupFailed(false) } }).catch(() => {
      if (mounted && alive.current) { setCleanupFailed(true); setDraft(previous => ({ ...previous })) }
    })
    return () => { mounted = false }
    // Acknowledgement identity owns cleanup; changing text cannot create a POST.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.acknowledged?.request_id, ackVerified, head?.revision, cleanupNonce, clear])
  useEffect(() => {
    if (restoreNonce === 0 || !restored.current) return
    const value = restored.current
    const expected = value.acknowledged?.revision ?? (value.pending ? value.pending.body.expected_revision + 1 : null)
    if (expected === null) return
    const controller = new AbortController(); read.current?.abort(); read.current = controller
    void getTaskReviewRevision(task.task_id, expected, workspaceId, controller.signal).then(async saved => {
      if (controller.signal.aborted || !alive.current) return
      const matching = value.pending ? matchesAcknowledgement(saved, value.pending, task) : value.acknowledged && isSavedTaskReview(saved) && reviewMatchesTask(saved, task) && JSON.stringify(saved) === JSON.stringify(value.acknowledged)
      if (!matching) return
      let latest: TaskReviewState | null = null
      try { latest = await getTaskReviewState(task.task_id, workspaceId, controller.signal) } catch { /* Keep the verified exact receipt, without inventing a current head. */ }
      if (!controller.signal.aborted && alive.current) finishAcknowledgement(saved, latest)
    }).catch(() => { /* Keep an unconfirmed local request available for explicit retry. */ })
    return () => controller.abort()
    // Recovery verifies only its captured request/version, never a new save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreNonce])

  const conflict = draft.editor.expected_revision !== (head?.revision ?? 0)
  const locked = busy !== null || draft.pending !== null || draft.acknowledged !== null || linkerDirty
  function update(editor: TaskReviewEditor) { if (!draft.editing || locked) return; setDraft(previous => ({ ...previous, editor })); setDirty(true); setError(null); setNotice(null) }
  function validation(editor: TaskReviewEditor) {
    return reviewText(editor.summary, 3000) && reviewText(editor.change_reason, 2000) && (editor.expected_revision === 0 || Boolean(editor.change_reason.trim())) && editor.items.every(item => reviewText(item.feedback, 2000) && (item.result === 'ungraded' || Boolean(task.submission!.responses.find(response => response.question_id === item.question_id)?.answer?.trim())))
  }
  async function perform(pending: PendingTaskReview) {
    if (!canWrite || action.current || linkerDirtyRef.current) return
    const operation: ReviewAction = { controller: new AbortController(), pending: cloneReviewDraft(pending), acknowledgement: null }
    action.current = operation; read.current?.abort(); setBusy(pending.kind); setError(null); setNotice(null); setDraft(previous => ({ ...previous, pending: operation.pending }))
    const active = () => alive.current && action.current === operation && !operation.controller.signal.aborted
    try {
      const value = pending.kind === 'save' ? await saveTaskReview(task.task_id, operation.pending.body as SaveBody, workspaceId, operation.controller.signal) : await withdrawTaskReview(task.task_id, operation.pending.body as WithdrawBody, workspaceId, operation.controller.signal)
      if (!active()) return
      if (!matchesAcknowledgement(value, operation.pending, task)) throw new Error('Invalid acknowledgement')
      operation.acknowledgement = value
      let latest: TaskReviewState | null = null
      try { latest = await getTaskReviewState(task.task_id, workspaceId, operation.controller.signal); if (!validReviewState(latest, task) || !latest.current_review || latest.current_review.revision < value.revision) latest = null } catch { /* Receipt remains confirmed even if the latest head cannot be read. */ }
      if (active()) finishAcknowledgement(value, latest)
    } catch (reason) { if (active()) setError(isApiError(reason) && reason.status === 409 ? 'conflict' : 'pending') }
    finally { if (action.current === operation) { action.current = null; if (alive.current) setBusy(null) } }
  }
  function save() {
    if (!canWrite || locked || !draft.editing || !headVerified || conflict) return
    if (!validation(draft.editor)) { setError('validation'); return }
    void perform({ kind: 'save', body: { ...cloneReviewDraft(draft.editor), request_id: randomUuid(), submission_id: task.submission!.submission_id } })
  }
  function stopWaiting() {
    const operation = action.current
    if (!operation) { if (read.current) { read.current.abort(); read.current = null; setBusy(null); setError(draftRef.current.pending ? 'pending' : 'headUnverified') } return }
    action.current = null; operation.controller.abort(); setBusy(null)
    if (operation.acknowledgement) finishAcknowledgement(operation.acknowledgement, null)
    else setError('pending')
  }
  async function checkReceipt() {
    if (action.current || linkerDirtyRef.current) return
    const pending = draftRef.current.pending
    const acknowledged = draftRef.current.acknowledged
    if (!pending && !acknowledged) return
    const controller = new AbortController(); read.current?.abort(); read.current = controller; setBusy('check'); setError(null)
    try {
      const version = acknowledged?.revision ?? pending!.body.expected_revision + 1
      const saved = await getTaskReviewRevision(task.task_id, version, workspaceId, controller.signal)
      if (controller.signal.aborted || !alive.current) return
      const matches = pending ? matchesAcknowledgement(saved, pending, task) : acknowledged && JSON.stringify(saved) === JSON.stringify(acknowledged)
      if (!matches) throw new Error('No matching receipt')
      let state: TaskReviewState | null = null
      try { state = await getTaskReviewState(task.task_id, workspaceId, controller.signal) } catch { /* Keep the verified receipt and require a fresh head check. */ }
      if (!controller.signal.aborted && alive.current) finishAcknowledgement(saved, state)
    } catch { if (!controller.signal.aborted && alive.current) setError('receiptNotFound') }
    finally { if (!controller.signal.aborted && alive.current) setBusy(null) }
  }
  async function checkLatest() {
    if (action.current || linkerDirtyRef.current) return
    const controller = new AbortController(); read.current?.abort(); read.current = controller; setBusy('check'); setError(null)
    try { const state = await getTaskReviewState(task.task_id, workspaceId, controller.signal); if (!controller.signal.aborted && alive.current) applyHead(state) }
    catch { if (!controller.signal.aborted && alive.current) { setHeadVerified(false); setError('headUnverified') } }
    finally { if (!controller.signal.aborted && alive.current) setBusy(null) }
  }
  async function reload() {
    if (action.current || linkerDirtyRef.current) return
    const controller = new AbortController(); read.current?.abort(); read.current = controller; setBusy('reload'); setError(null)
    try {
      const state = await getTaskReviewState(task.task_id, workspaceId, controller.signal)
      if (controller.signal.aborted || !alive.current) return
      if (!validReviewState(state, task)) throw new Error('Review source changed')
      await clear()
      if (controller.signal.aborted || !alive.current) return
      const value = applyHead(state); setDraft(freshDraft(task, value)); setDirty(false); setAckVerified(false); setCleanupFailed(false); setNotice(null); setReloadOpen(false)
    } catch { if (!controller.signal.aborted && alive.current) { setError('sourceFailed'); setReloadOpen(false) } }
    finally { if (!controller.signal.aborted && alive.current) setBusy(null) }
  }
  function requestReload() { if (linkerDirty) { setError('linkerPending'); return } if (dirty || draft.pending || draft.acknowledged || draft.withdraw_reason) { setDraft(previous => ({ ...previous, withdrawing: false })); setReloadOpen(true) } else void reload() }
  function startEditing() { if (!canWrite || locked || !headVerified) return; setDraft(freshDraft(task, head)); setDraft(previous => ({ ...previous, editing: true })); setDirty(false); setError(null); setNotice(null) }
  function openWithdraw() { if (!canWrite || locked || dirty || draft.editing || head?.status !== 'confirmed' || !headVerified || conflict) return; setDraft(previous => ({ ...previous, withdrawing: true, withdraw_reason: '' })); setError(null) }
  function setWithdrawReason(reason: string) { if (busy || draft.pending) return; setDraft(previous => ({ ...previous, withdraw_reason: reason })); setDirty(true); setError(null) }
  function closeWithdraw() { if (busy || draft.pending) return; setDraft(previous => ({ ...previous, withdrawing: false, withdraw_reason: '' })); setDirty(false); setError(null) }
  function withdraw() { if (!canWrite || busy || linkerDirty || !head || head.status !== 'confirmed' || !draft.withdraw_reason.trim() || !reviewText(draft.withdraw_reason, 2000) || conflict) { setError('validation'); return } void perform({ kind: 'withdraw', body: { request_id: randomUuid(), expected_revision: head.revision, reason: draft.withdraw_reason } }) }
  return { draft, head, headVerified, dirty, busy, error, notice, conflict, locked, cleanupFailed, reloadOpen, setReloadOpen, update, save, retry: () => { if (draft.pending) void perform(draft.pending) }, stopWaiting, checkReceipt, checkLatest, requestReload, reload, startEditing, openWithdraw, closeWithdraw, setWithdrawReason, withdraw, retryCleanup: () => setCleanupNonce(value => value + 1), linkerDirty, linkerReview, onLinkerDirtyChange }
}
type SaveBody = Extract<PendingTaskReview, { kind: 'save' }>['body']
type WithdrawBody = Extract<PendingTaskReview, { kind: 'withdraw' }>['body']
