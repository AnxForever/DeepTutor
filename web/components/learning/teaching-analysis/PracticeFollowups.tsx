'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ClipboardList, History, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Button, Dialog, Field, InlineAlert, StatusChip } from '@/shared/ui'
import { isApiError } from '@/shared/api/errors'
import type { SavedTeachingReport } from '@/lib/teaching-analysis-api'
import {
  getTeachingFollowup, getTeachingFollowupRevisions, listTeachingFollowupAttempts,
  listTeachingFollowups, saveTeachingFollowup, saveTeachingFollowupAttempt, voidTeachingFollowupAttempt,
  type SaveFollowupRequest, type SavedFollowup, type SavedFollowupAttempt,
  type SaveFollowupAttemptRequest,
} from '@/lib/teaching-followups-api'
import { controlClass } from './AssignmentEditor'
import { FollowupQuestionSnapshot, FollowupResponseForm, FollowupResponseHistory } from './FollowupResponses'
import { WorksheetActions } from './WorksheetActions'
import { useTeachingDraftControls, useTeachingDraftSlot } from './TeachingDrafts'
import { followupResponseSlot, followupWorkspaceSlot, isFollowupWorkspaceDraft, sameSavedFollowup, type FollowupWorkspaceDraft } from '@/lib/teaching-followup-drafts'

type Operation = 'load' | 'save' | 'attempt' | 'void' | 'history'
type Replacement = { kind: 'create'; priorityIndex: number } | { kind: 'load'; id: string } | { kind: 'edit' } | { kind: 'discard' }

interface PracticeFollowupsProps {
  report: SavedTeachingReport
  workspaceId: string
  canCreate?: boolean
  onDirtyChange?: (dirty: boolean) => void
  onReloadReport?: () => void
}

/** Saved question versions and new responses stay separate from report edits. */
export function PracticeFollowups({ report, workspaceId, canCreate = true, onDirtyChange, onReloadReport }: PracticeFollowupsProps) {
  return <FollowupWorkspace key={`${workspaceId}:${report.report_id}:${report.revision}`} report={report} workspaceId={workspaceId} canCreate={canCreate} onDirtyChange={onDirtyChange} onReloadReport={onReloadReport} />
}

function FollowupWorkspace({ report, workspaceId, canCreate, onDirtyChange, onReloadReport }: Required<Pick<PracticeFollowupsProps, 'report' | 'workspaceId' | 'canCreate'>> & Pick<PracticeFollowupsProps, 'onDirtyChange' | 'onReloadReport'>) {
  const { t } = useTranslation()
  const [sets, setSets] = useState<SavedFollowup[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState(false)
  const [listVersion, setListVersion] = useState(0)
  const [selected, setSelected] = useState<SavedFollowup | null>(null)
  const [draft, setDraft] = useState<SaveFollowupRequest | null>(null)
  const [draftDirty, setDraftDirty] = useState(false)
  const [attemptDirty, setAttemptDirty] = useState<Record<string, boolean>>({})
  const [attempts, setAttempts] = useState<SavedFollowupAttempt[]>([])
  const [attemptsLoading, setAttemptsLoading] = useState(false)
  const [attemptsError, setAttemptsError] = useState(false)
  const [attemptsVersion, setAttemptsVersion] = useState(0)
  const [versions, setVersions] = useState<SavedFollowup[] | null>(null)
  const [busy, setBusy] = useState<Operation | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState<'source' | 'followup' | null>(null)
  const [replacement, setReplacement] = useState<Replacement | null>(null)
  const [voidTarget, setVoidTarget] = useState<SavedFollowupAttempt | null>(null)
  const [voidReason, setVoidReason] = useState('')
  const [voidError, setVoidError] = useState('')
  const [selectionVerified, setSelectionVerified] = useState(true)
  const [checkingSelection, setCheckingSelection] = useState(false)
  const [verificationTarget, setVerificationTarget] = useState<SavedFollowup | null>(null)
  const [verificationRetry, setVerificationRetry] = useState(0)
  const controllerRef = useRef<AbortController | null>(null)
  const listReadRef = useRef(0)
  const attemptReadRef = useRef(0)
  const mountedRef = useRef(true)
  const selectedId = selected?.followup_id
  const selectedRevision = selected?.revision
  const allowed = canCreate && report.status === 'confirmed'
  const dirty = draftDirty || Object.values(attemptDirty).some(Boolean) || Boolean(voidTarget && voidReason.trim())
  const disabled = busy !== null || checkingSelection
  const sourceChanged = Boolean((draft || selected) && (draft || selected)!.report_revision !== report.revision)
  const anchorsMatch = selected && selected.student_ref === report.assignment.student_ref && selected.assignment_ref === report.assignment.assignment_ref && selected.subject === report.assignment.subject && selected.knowledge_point === report.analysis.priorities[selected.priority_index]?.knowledge_point
  const workspaceSlot = followupWorkspaceSlot(report.report_id, report.revision)
  const localDraft = useMemo<FollowupWorkspaceDraft>(() => ({
    kind: 'followup-workspace', version: 1, report_id: report.report_id, report_revision: report.revision,
    draft, selected, void_target: voidTarget, void_reason: voidReason,
  }), [draft, report.report_id, report.revision, selected, voidReason, voidTarget])
  const { clearSlot } = useTeachingDraftControls()
  useTeachingDraftSlot<FollowupWorkspaceDraft>({
    slot: workspaceSlot, value: localDraft, dirty,
    validate: (value): value is FollowupWorkspaceDraft => isFollowupWorkspaceDraft(value) && value.report_id === report.report_id && value.report_revision === report.revision,
    onRestore(value) {
      setDraft(value.draft)
      setDraftDirty(value.draft !== null)
      setSelected(value.selected)
      setVoidTarget(value.void_target)
      setVoidReason(value.void_reason)
      setVoidError('')
      setAttempts([])
      setVersions(null)
      setConflict(null)
      setError('')
      setNotice('')
      setSelectionVerified(value.selected === null)
      setCheckingSelection(value.selected !== null)
      setVerificationTarget(value.selected)
    },
  })

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; controllerRef.current?.abort() }
  }, [])

  useEffect(() => {
    if (!verificationTarget) return
    // Restoration can run from a layout registration before mount effects.
    // Own this read in an effect so StrictMode replay aborts the old read and
    // starts a fresh one, rather than leaving an aborted action lock behind.
    const controller = new AbortController()
    let alive = true
    const current = () => alive && !controller.signal.aborted
    setCheckingSelection(true)
    setError('')
    void getTeachingFollowup(verificationTarget.followup_id, workspaceId, controller.signal).then(value => {
      if (!current()) return
      if (!sameSavedFollowup(verificationTarget, value)) {
        setConflict('followup')
        setError(t('teaching.followups.restoreCheckFailed'))
        return
      }
      setSelected(value)
      setSelectionVerified(true)
      setCheckingSelection(false)
      setVerificationTarget(null)
      setConflict(null)
    }).catch(() => {
      if (current()) { setConflict(null); setError(t('teaching.followups.restoreCheckFailed')) }
    }).finally(() => { if (current()) setCheckingSelection(false) })
    return () => { alive = false; controller.abort() }
  }, [verificationTarget, verificationRetry, workspaceId, t])

  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  useEffect(() => {
    const controller = new AbortController()
    const read = ++listReadRef.current
    setLoading(true)
    void listTeachingFollowups(report.report_id, workspaceId, controller.signal).then(result => {
      if (!controller.signal.aborted && listReadRef.current === read) { setSets(result); setListError(false) }
    }).catch(() => {
      if (!controller.signal.aborted && listReadRef.current === read) setListError(true)
    }).finally(() => {
      if (!controller.signal.aborted && listReadRef.current === read) setLoading(false)
    })
    return () => controller.abort()
  }, [report.report_id, workspaceId, listVersion])

  useEffect(() => {
    if (!selectedId) return
    const controller = new AbortController()
    const read = ++attemptReadRef.current
    setAttemptsLoading(true)
    setAttemptsError(false)
    void listTeachingFollowupAttempts(selectedId, workspaceId, controller.signal).then(result => {
      if (!controller.signal.aborted && attemptReadRef.current === read) setAttempts(result)
    }).catch(() => {
      if (!controller.signal.aborted && attemptReadRef.current === read) setAttemptsError(true)
    }).finally(() => {
      if (!controller.signal.aborted && attemptReadRef.current === read) setAttemptsLoading(false)
    })
    return () => controller.abort()
  }, [selectedId, selectedRevision, workspaceId, attemptsVersion])

  const updateAttemptDirty = useCallback((questionId: string, value: boolean) => {
    setAttemptDirty(previous => previous[questionId] === value ? previous : { ...previous, [questionId]: value })
  }, [])

  function begin(operation: Operation): AbortController | null {
    if (controllerRef.current) return null
    const controller = new AbortController()
    controllerRef.current = controller
    setBusy(operation)
    setError('')
    setNotice('')
    return controller
  }

  function active(controller: AbortController) { return mountedRef.current && !controller.signal.aborted }
  function finish(controller: AbortController) {
    if (controllerRef.current === controller) controllerRef.current = null
    if (active(controller)) setBusy(null)
  }
  function failure(reason: unknown, controller: AbortController) {
    if (!active(controller)) return
    if (isApiError(reason) && reason.status === 409) setConflict(reason.code === 'teaching_followup_source_changed' ? 'source' : 'followup')
    setError(reason instanceof Error ? reason.message : t('teaching.followups.failed'))
  }
  function chooseSaved(value: SavedFollowup) {
    setSelected(value)
    setSelectionVerified(true)
    setCheckingSelection(false)
    setVerificationTarget(null)
    setDraft(null)
    setDraftDirty(false)
    setAttemptDirty({})
    setAttempts([])
    setAttemptsVersion(value => value + 1)
    setVersions(null)
    setConflict(null)
    setError('')
    // This GET or save is newer than any pending list read. Keep the visible
    // library row in sync with the exact revision opened in the editor.
    listReadRef.current++
    setLoading(false)
    setListError(false)
    setSets(previous => [value, ...previous.filter(set => set.followup_id !== value.followup_id)])
  }

  async function clearPendingLocalDrafts() {
    const slots = [workspaceSlot, ...(selected?.questions.map(question => followupResponseSlot(selected.followup_id, selected.revision, question.question_id)) ?? [])]
    await Promise.all(slots.map(slot => clearSlot(slot)))
  }

  async function load(id: string, discardPending = false) {
    const controller = begin('load')
    if (!controller) return
    try {
      const value = await getTeachingFollowup(id, workspaceId, controller.signal)
      if (discardPending && active(controller)) {
        try { await clearPendingLocalDrafts() } catch {
          if (active(controller)) setError(t('teaching.followups.localClearFailed'))
          return
        }
      }
      if (active(controller)) chooseSaved(value)
    } catch (reason) { failure(reason, controller) } finally { finish(controller) }
  }

  function perform(action: Replacement) {
    setReplacement(null)
    setError('')
    setNotice('')
    if (action.kind === 'load') { void load(action.id); return }
    if (action.kind === 'discard') { setDraft(null); setDraftDirty(false); return }
    if (!allowed) return
    if (action.kind === 'edit') {
      if (!selected || !anchorsMatch || !selectionVerified) return
      setDraft({
        followup_id: selected.followup_id, expected_revision: selected.revision,
        report_id: selected.report_id, report_revision: report.revision,
        priority_index: selected.priority_index, title: selected.title,
        questions: selected.questions.map(question => ({ ...question })),
      })
      setDraftDirty(false)
      setConflict(null)
      setVersions(null)
      return
    }
    const priority = report.analysis.priorities[action.priorityIndex]
    if (!priority?.follow_up_question.trim()) return
    setSelected(null)
    setAttempts([])
    setAttemptDirty({})
    setVersions(null)
    setDraft({
      followup_id: crypto.randomUUID(), expected_revision: 0,
      report_id: report.report_id, report_revision: report.revision, priority_index: action.priorityIndex,
      title: t('teaching.followups.defaultTitle', { topic: priority.knowledge_point }),
      questions: [{ question_id: 'F1', question: priority.follow_up_question, reference_answer: null, rubric: priority.reference_guidance || null }],
    })
    setDraftDirty(true)
    setConflict(null)
  }
  async function discardAndPerform(action: Replacement) {
    if (action.kind === 'load') { setReplacement(null); await load(action.id, true); return }
    const controller = begin('load')
    if (!controller) return
    try {
      await clearPendingLocalDrafts()
      if (active(controller)) perform(action)
    } catch {
      if (active(controller)) { setReplacement(null); setError(t('teaching.followups.localClearFailed')) }
    } finally { finish(controller) }
  }
  function request(action: Replacement) {
    if (disabled) return
    if (dirty) setReplacement(action)
    else perform(action)
  }
  function updateDraft(next: SaveFollowupRequest) { setDraft(next); setDraftDirty(true); setNotice(''); setError('') }

  async function saveQuestions() {
    if (!draft || !allowed || sourceChanged || conflict || (selected && !selectionVerified)) return
    const ids = draft.questions.map(question => question.question_id.trim())
    if (!draft.title.trim() || draft.title.length > 300 || !draft.questions.length || draft.questions.length > 3 ||
      new Set(ids).size !== ids.length || draft.questions.some(question => !question.question_id.trim() || !question.question.trim())) {
      setError(t('teaching.followups.invalidSet')); return
    }
    const controller = begin('save')
    if (!controller) return
    try {
      const value = await saveTeachingFollowup(draft, workspaceId, controller.signal)
      if (!active(controller)) return
      chooseSaved(value)
      setNotice(t('teaching.followups.saved'))
    } catch (reason) { failure(reason, controller) } finally { finish(controller) }
  }

  async function recordResponse(payload: SaveFollowupAttemptRequest): Promise<SavedFollowupAttempt | null> {
    if (!selected || !selectionVerified) return null
    const controller = begin('attempt')
    if (!controller) return null
    try {
      const value = await saveTeachingFollowupAttempt(selected.followup_id, payload, workspaceId, controller.signal)
      if (!active(controller)) return null
      attemptReadRef.current++
      setAttemptsLoading(false)
      setAttemptsError(false)
      setAttempts(previous => [value, ...previous.filter(attempt => attempt.attempt_id !== value.attempt_id)])
      return value
    } catch (reason) { failure(reason, controller); return null } finally { finish(controller) }
  }

  async function showVersions() {
    if (!selected) return
    if (versions) { setVersions(null); return }
    const controller = begin('history')
    if (!controller) return
    try {
      const result = await getTeachingFollowupRevisions(selected.followup_id, workspaceId, controller.signal)
      if (active(controller)) setVersions(result)
    } catch (reason) { failure(reason, controller) } finally { finish(controller) }
  }

  async function voidResponse() {
    if (!voidTarget || !selected || !selectionVerified) return
    if (!voidReason.trim()) { setVoidError(t('teaching.followups.voidReasonRequired')); return }
    const controller = begin('void')
    if (!controller) return
    setVoidError('')
    try {
      const value = await voidTeachingFollowupAttempt(selected.followup_id, voidTarget.attempt_id, voidReason.trim(), workspaceId, controller.signal)
      if (!active(controller)) return
      attemptReadRef.current++
      setAttemptsLoading(false)
      setAttemptsError(false)
      setAttempts(previous => previous.map(attempt => attempt.attempt_id === value.attempt_id ? value : attempt))
      setVoidTarget(null)
      setVoidReason('')
      setNotice(t('teaching.followups.voidSaved'))
    } catch (reason) {
      failure(reason, controller)
      if (active(controller)) setVoidError(reason instanceof Error ? reason.message : t('teaching.followups.failed'))
    } finally { finish(controller) }
  }

  return (
    <section className="mt-8 border-t border-border pt-7" aria-labelledby="teaching-followups-title">
      <div className="flex items-center gap-2"><ClipboardList size={19} className="text-primary" aria-hidden /><h2 id="teaching-followups-title" className="text-lg font-semibold">{t('teaching.followups.title')}</h2></div>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('teaching.followups.hint')}</p>
      {!allowed && <InlineAlert tone="warning" className="mt-4">{t('teaching.followups.reportMustBeConfirmed')}</InlineAlert>}
      <div className="mt-4 flex flex-wrap gap-2">
        {report.analysis.priorities.map((priority, index) => <Button key={index} variant="secondary" size="sm" disabled={disabled || !allowed || !priority.follow_up_question.trim()} onClick={() => request({ kind: 'create', priorityIndex: index })}>{t('teaching.followups.makeFromTopic', { topic: priority.knowledge_point })}</Button>)}
        {!report.analysis.priorities.length && <p className="text-sm text-muted-foreground">{t('teaching.followups.noPriority')}</p>}
      </div>
      <details className="mt-5 rounded-xl border border-border p-4" open={sets.length > 0 ? true : undefined}>
        <summary className="cursor-pointer text-sm font-medium">{t('teaching.followups.savedSets', { n: sets.length })}</summary>
        {loading ? <p className="mt-3 text-sm text-muted-foreground">{t('teaching.followups.loading')}</p> : !sets.length ? <p className="mt-3 text-sm text-muted-foreground">{t('teaching.followups.noSavedSets')}</p> : <ul className="mt-3 grid gap-2">{sets.map(set => <li key={set.followup_id}><button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50" disabled={disabled} aria-pressed={selected?.followup_id === set.followup_id} onClick={() => request({ kind: 'load', id: set.followup_id })}><span>{set.title}</span><span className="text-xs text-muted-foreground">{t('teaching.revision', { n: set.revision })}</span></button></li>)}</ul>}
      </details>
      {listError && <InlineAlert className="mt-4" tone="warning" action={<Button variant="ghost" size="sm" onClick={() => setListVersion(value => value + 1)}>{t('Retry')}</Button>}>{t('teaching.followups.listFailed')}</InlineAlert>}
      {error && <InlineAlert className="mt-4" tone="danger">{error}</InlineAlert>}
      {notice && <InlineAlert className="mt-4" tone="success">{notice}</InlineAlert>}
      {checkingSelection && <p role="status" className="mt-4 text-sm text-muted-foreground">{t('teaching.followups.restoreCheck')}</p>}
      {verificationTarget && !selectionVerified && !voidTarget && <Button className="mt-3" variant="secondary" size="sm" disabled={busy !== null} onClick={() => setVerificationRetry(value => value + 1)}>{t('teaching.followups.retryVerification')}</Button>}
      {conflict && <InlineAlert className="mt-4" tone="warning" action={conflict === 'source'
        ? onReloadReport && <Button variant="secondary" size="sm" disabled={disabled} onClick={onReloadReport}>{t('teaching.followups.reloadSourceReport')}</Button>
        : selected && <Button variant="secondary" size="sm" disabled={disabled} onClick={() => request({ kind: 'load', id: selected.followup_id })}>{t('teaching.followups.reloadLatest')}</Button>}>{t('teaching.followups.conflict')}</InlineAlert>}
      {sourceChanged && <InlineAlert className="mt-4" tone="warning">{t('teaching.followups.sourceChanged', { n: (draft || selected)!.report_revision })}</InlineAlert>}
      {draft && <div className="mt-5 rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">{t('teaching.followups.source', { student: report.assignment.student_ref, assignment: report.assignment.assignment_ref, n: draft.report_revision })}</p>{draftDirty && <StatusChip>{t('teaching.followups.unsavedPractice')}</StatusChip>}</div>
        <Field className="mt-4" label={t('teaching.followups.titleLabel')}><input className={controlClass} maxLength={300} disabled={disabled} value={draft.title} onChange={event => updateDraft({ ...draft, title: event.target.value })} /></Field>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">{t('teaching.followups.referenceHint')}</p>
        <div className="mt-4 grid gap-4">{draft.questions.map((question, index) => <fieldset key={index} disabled={disabled} className="grid gap-3 rounded-xl border border-border p-3 sm:grid-cols-2">
          <Field label={t('teaching.followups.questionId', { n: index + 1 })}><input className={controlClass} maxLength={128} value={question.question_id} onChange={event => updateDraft({ ...draft, questions: draft.questions.map((row, i) => i === index ? { ...row, question_id: event.target.value } : row) })} /></Field>
          <Field className="sm:col-span-2" label={t('teaching.followups.questionText', { n: index + 1 })}><textarea className={controlClass} rows={3} maxLength={6000} value={question.question} onChange={event => updateDraft({ ...draft, questions: draft.questions.map((row, i) => i === index ? { ...row, question: event.target.value } : row) })} /></Field>
          <Field label={t('teaching.followups.referenceAnswer', { n: index + 1 })}><textarea className={controlClass} rows={2} maxLength={6000} value={question.reference_answer ?? ''} onChange={event => updateDraft({ ...draft, questions: draft.questions.map((row, i) => i === index ? { ...row, reference_answer: event.target.value || null } : row) })} /></Field>
          <Field label={t('teaching.followups.rubric', { n: index + 1 })}><textarea className={controlClass} rows={2} maxLength={4000} value={question.rubric ?? ''} onChange={event => updateDraft({ ...draft, questions: draft.questions.map((row, i) => i === index ? { ...row, rubric: event.target.value || null } : row) })} /></Field>
          <Button size="sm" variant="ghost" className="justify-self-start" disabled={draft.questions.length === 1} icon={<Trash2 size={14} />} onClick={() => updateDraft({ ...draft, questions: draft.questions.filter((_, i) => i !== index) })}>{t('teaching.followups.removeQuestion', { n: index + 1 })}</Button>
        </fieldset>)}</div>
        <Button className="mt-4" size="sm" variant="secondary" disabled={disabled || draft.questions.length >= 3} icon={<Plus size={14} />} onClick={() => {
          let next = 1
          while (draft.questions.some(question => question.question_id === `F${next}`)) next++
          updateDraft({ ...draft, questions: [...draft.questions, { question_id: `F${next}`, question: '', reference_answer: null, rubric: null }] })
        }}>{t('teaching.followups.addQuestion')}</Button>
        <div className="mt-5 flex flex-wrap gap-2"><Button loading={busy === 'save'} disabled={disabled || !allowed || sourceChanged || Boolean(conflict) || Boolean(selected && !selectionVerified)} onClick={() => void saveQuestions()}>{t('teaching.followups.save')}</Button><Button variant="ghost" disabled={disabled} onClick={() => request({ kind: 'discard' })}>{t('teaching.followups.cancelEdit')}</Button></div>
      </div>}
      {selected && !draft && <div className="mt-6">
        <WorksheetActions key={`${workspaceId}:${selected.followup_id}:${selected.revision}`} followup={selected} workspaceId={workspaceId} disabled={disabled || !selectionVerified} />
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-base font-semibold">{selected.title}</h3><p className="mt-1 text-xs text-muted-foreground">{t('teaching.followups.source', { student: selected.student_ref, assignment: selected.assignment_ref, n: selected.report_revision })} · {t('teaching.revision', { n: selected.revision })}</p></div><div className="flex flex-wrap gap-2"><Button variant="secondary" size="sm" icon={<Pencil size={14} />} disabled={disabled || !allowed || !anchorsMatch || !selectionVerified} onClick={() => request({ kind: 'edit' })}>{t('teaching.followups.editSet')}</Button><Button variant="ghost" size="sm" icon={<History size={14} />} disabled={disabled} onClick={() => void showVersions()}>{t(versions ? 'teaching.followups.hideRevisions' : 'teaching.followups.revisions')}</Button></div></div>
        {versions && <section className="mt-4 rounded-xl border border-border p-4" aria-label={t('teaching.followups.revisions')}>{versions.map(version => <details key={version.revision} className="border-b border-border/60 py-3 last:border-b-0"><summary className="cursor-pointer text-sm font-medium">{t('teaching.revision', { n: version.revision })} · {version.title}</summary><div className="mt-3 grid gap-4">{version.questions.map(question => <FollowupQuestionSnapshot key={question.question_id} question={question} />)}</div></details>)}</section>}
        <h4 className="mb-2 mt-5 text-sm font-semibold">{t('teaching.followups.attemptsTitle')}</h4>
        <p className="mb-4 text-sm leading-6 text-muted-foreground">{t('teaching.followups.attemptsHint')}</p>
        <div className="grid gap-4">{selected.questions.map(question => <FollowupResponseForm key={`${selected.followup_id}:${selected.revision}:${question.question_id}`} set={selected} question={question} disabled={busy !== null} canSubmit={selectionVerified && !checkingSelection} onSubmit={recordResponse} onDirtyChange={updateAttemptDirty} onReset={() => { setError(''); setNotice('') }} />)}</div>
        <Button className="mt-5" variant="ghost" size="sm" icon={<RefreshCw size={14} />} disabled={disabled || attemptsLoading} onClick={() => setAttemptsVersion(value => value + 1)}>{t('teaching.followups.refreshAnswers')}</Button>
        {attemptsLoading && <p role="status" className="mt-3 text-sm text-muted-foreground">{t('teaching.followups.loading')}</p>}
        {attemptsError && <InlineAlert className="mt-3" tone="warning">{t('teaching.followups.listFailed')}</InlineAlert>}
        <FollowupResponseHistory attempts={attempts} disabled={disabled || !selectionVerified} onVoid={attempt => { setVoidTarget(attempt); setVoidReason(''); setVoidError('') }} />
      </div>}
      <Dialog open={replacement !== null} title={t('teaching.followups.dirtyDialogTitle')} onClose={() => { if (!disabled) setReplacement(null) }} busy={disabled} footer={<><Button variant="secondary" disabled={disabled} onClick={() => setReplacement(null)}>{t('Cancel')}</Button><Button disabled={disabled} onClick={() => { if (replacement) void discardAndPerform(replacement) }}>{t('teaching.followups.discard')}</Button></>}><p className="text-sm leading-6 text-muted-foreground">{t('teaching.followups.dirtyDialogHint')}</p></Dialog>
      <Dialog open={voidTarget !== null} title={t('teaching.followups.voidTitle')} onClose={() => { if (!disabled) { setVoidTarget(null); setVoidReason(''); setVoidError('') } }} busy={busy === 'void'} footer={<><Button variant="secondary" disabled={disabled} onClick={() => { setVoidTarget(null); setVoidReason(''); setVoidError('') }}>{t('Cancel')}</Button>{verificationTarget && !selectionVerified && <Button variant="secondary" disabled={busy !== null} onClick={() => setVerificationRetry(value => value + 1)}>{t('teaching.followups.retryVerification')}</Button>}<Button variant="danger" loading={busy === 'void'} disabled={disabled || !selectionVerified} onClick={() => void voidResponse()}>{t('teaching.followups.voidConfirm')}</Button></>}>
        <p className="mb-4 text-sm leading-6 text-muted-foreground">{t('teaching.followups.voidHint')}</p>
        <Field label={t('teaching.followups.voidReason')} error={voidError || undefined}><textarea className={controlClass} rows={3} maxLength={2000} disabled={disabled} value={voidReason} onChange={event => { setVoidReason(event.target.value); setVoidError('') }} /></Field>
      </Dialog>
    </section>
  )
}
