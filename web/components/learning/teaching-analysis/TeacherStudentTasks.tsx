'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Send } from 'lucide-react'
import { Button, Dialog, Field, InlineAlert, StatusChip } from '@/shared/ui'
import { isApiError } from '@/shared/api/errors'
import { scopedUrl } from '@/lib/workspace-scope'
import { getTeachingReport } from '@/lib/teaching-analysis-api'
import { getTeachingFollowup, type SavedFollowup } from '@/lib/teaching-followups-api'
import { sameSavedFollowup } from '@/lib/teaching-followup-drafts'
import {
  getStudentTaskRecipients, getTeacherStudentTask, issueStudentTask, listTeacherStudentTasks, revokeStudentTask,
  isStudentTaskPublishDraft, sameStudentTaskIntent, studentTaskPublishSlot, studentVisibleTaskPreview,
  cloneQuestionHints, cloneStudentTaskIssue, sameQuestionHints, validQuestionHintPlan, validTaskHintText,
  type IssueStudentTaskRequest, type StudentTaskPublishDraft, type StudentTaskSetup, type TeacherStudentTask, type TeacherStudentTaskSummary, type TaskQuestionHints,
} from '@/lib/teacher-student-tasks-api'
import { useTeachingDraftSlot } from './TeachingDrafts'
import { controlClass } from './AssignmentEditor'
import { TaskTranslations } from '../TaskTranslations'
import Link from 'next/link'

const SETUP_DOC = 'https://github.com/AnxForever/DeepTutor/blob/teacher-diagnostics/docs-for-dev/STUDENT_TASKS.md'
const PAGE_SIZE = 20

function HintPlanEditor({ source, plan, disabled, onChange }: { source: SavedFollowup; plan?: TaskQuestionHints[]; disabled: boolean; onChange: (questionId: string, hints: string[]) => void }) {
  const { t } = useTranslation()
  return <details className="mt-4 rounded-xl border border-border p-4">
    <summary className="cursor-pointer text-sm font-medium">{t('teacherTaskHints.editorTitle')}</summary>
    <p className="mt-3 text-xs leading-5 text-muted-foreground">{t('teacherTaskHints.editorHint')}</p><p className="mt-2 text-xs leading-5 text-muted-foreground">{t('teacherTaskHints.templateHint')}</p>
    <div className="mt-4 grid gap-4">{source.questions.map(question => {
      const hints = plan?.find(entry => entry.question_id === question.question_id)?.hints ?? []
      return <fieldset key={question.question_id} className="min-w-0 rounded-lg border border-border p-3" disabled={disabled}>
        <legend className="px-1 text-xs font-medium">{question.question_id}</legend><p className="whitespace-pre-wrap break-words text-sm leading-6">{question.question}</p>
        {hints.map((hint, level) => <div className="mt-3" key={level}><Field label={t('teacherTaskHints.field', { id: question.question_id, n: level + 1 })} error={!hint.trim() ? t('teacherTaskHints.empty') : !validTaskHintText(hint) ? t('teacherTaskHints.invalid') : undefined}><textarea className={controlClass} rows={2} maxLength={600} value={hint} onChange={event => onChange(question.question_id, hints.map((value, index) => index === level ? event.target.value : value))} /></Field><div className="mt-1 flex items-center justify-between gap-2"><p className="text-xs tabular-nums text-muted-foreground">{Array.from(hint).length}/600</p><Button size="sm" variant="ghost" onClick={() => onChange(question.question_id, hints.filter((_, index) => index !== level))}>{t('teacherTaskHints.remove', { id: question.question_id, n: level + 1 })}</Button></div></div>)}
        <Button className="mt-3" size="sm" variant="secondary" disabled={disabled || hints.length >= 3} onClick={() => onChange(question.question_id, [...hints, ''])}>{t('teacherTaskHints.add', { id: question.question_id })}</Button>
      </fieldset>
    })}</div>
  </details>
}

function HintHistory({ task, date }: { task: TeacherStudentTask; date: (value: number | null) => string }) {
  const { t } = useTranslation()
  const plan = task.question_hints ?? []
  const usage = task.submission ? task.submission.hint_usage ?? null : task.hint_usage ?? []
  return <details className="mt-4 rounded-xl border border-border p-3"><summary className="cursor-pointer text-sm font-medium">{t('teacherTaskHints.historyTitle')}</summary>
    <p className="mt-3 text-xs leading-5 text-muted-foreground">{t('teacherTaskHints.historyHint')}</p>
    <p className="mt-2 text-xs leading-5 text-muted-foreground">{t(task.submission ? usage === null ? 'teacherTaskHints.legacyUsage' : 'teacherTaskHints.finalUsage' : 'teacherTaskHints.currentUsage')}</p>
    {!plan.length && <p className="mt-3 text-sm text-muted-foreground">{t('teacherTaskHints.noPlan')}</p>}
    <div className="mt-3 grid gap-3">{plan.map(entry => <section key={entry.question_id} className="rounded-lg border border-border p-3"><h5 className="text-sm font-medium">{entry.question_id}</h5><ol className="mt-3 grid gap-3">{entry.hints.map((hint, index) => {
      const revealed = usage?.find(value => value.question_id === entry.question_id)?.revealed.find(value => value.level === index + 1)
      return <li key={index}><p className="text-xs font-medium">{t('teacherTaskHints.level', { n: index + 1 })}</p><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{hint}</p>{usage !== null && <p className="mt-1 text-xs text-muted-foreground">{revealed ? t('teacherTaskHints.unlockedAt', { time: date(revealed.revealed_at) }) : t('teacherTaskHints.notUnlocked')}</p>}</li>
    })}</ol></section>)}</div>
  </details>
}

export interface TeacherStudentTasksProps {
  followup: SavedFollowup
  workspaceId: string
  disabled?: boolean
  canPublish?: boolean
  onDirtyChange?: (dirty: boolean) => void
  onReloadReport?: () => void
  onReloadFollowup?: () => void
}

export function TeacherStudentTasks({ followup, workspaceId, ...props }: TeacherStudentTasksProps) {
  return <TaskTranslations compact><ScopedTeacherTasks key={`${workspaceId}:${followup.followup_id}`} followup={followup} workspaceId={workspaceId} {...props} /></TaskTranslations>
}

function ScopedTeacherTasks({ followup, workspaceId, disabled = false, canPublish = true, onDirtyChange, onReloadReport, onReloadFollowup }: TeacherStudentTasksProps) {
  const { t, i18n } = useTranslation()
  const initialTitle = useRef(t('teacherTasks.defaultTitle'))
  const emptyDraft = (source: SavedFollowup = followup): StudentTaskPublishDraft => ({
    kind: 'student-task-publish', version: 1, source,
    payload: { task_id: crypto.randomUUID(), followup_id: source.followup_id, followup_revision: source.revision, recipient_user_id: '', title: initialTitle.current, instructions: '' },
    reviewed: false, submitted_payload: null, acknowledged_task_id: null, revoke: null,
  })
  const [draft, setDraft] = useState(() => emptyDraft())
  const [expanded, setExpanded] = useState(false)
  const [setup, setSetup] = useState<StudentTaskSetup | null>(null)
  const [setupLoading, setSetupLoading] = useState(true)
  const [setupError, setSetupError] = useState(false)
  const [sourceValid, setSourceValid] = useState(false)
  const [sourceIssue, setSourceIssue] = useState<'changed' | 'failed' | null>(null)
  const [loadNonce, setLoadNonce] = useState(0)
  const [restored, setRestored] = useState(false)
  const [tasks, setTasks] = useState<TeacherStudentTaskSummary[]>([])
  const [listRequest, setListRequest] = useState({ offset: 0, nonce: 0 })
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [nextOffset, setNextOffset] = useState(0)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [task, setTask] = useState<TeacherStudentTask | null>(null)
  const [taskLoading, setTaskLoading] = useState(false)
  const [taskError, setTaskError] = useState(false)
  const [taskNonce, setTaskNonce] = useState(0)
  const [working, setWorking] = useState<'publish' | 'recover' | 'revoke' | 'clear' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [revokeError, setRevokeError] = useState('')
  const [cleanupError, setCleanupError] = useState(false)
  const [cleanupNonce, setCleanupNonce] = useState(0)
  const action = useRef<AbortController | null>(null)
  const setupRead = useRef<AbortController | null>(null)
  const listRead = useRef<AbortController | null>(null)
  const taskRead = useRef<AbortController | null>(null)
  const rebaseRevokeOnRead = useRef(false)
  const alive = useRef(true)
  const callbacks = useRef(onDirtyChange)
  useLayoutEffect(() => { callbacks.current = onDirtyChange }, [onDirtyChange])
  const form = draft.payload
  const source = draft.source
  const sourceVersionChanged = !sameSavedFollowup(source, followup)
  const acknowledged = draft.acknowledged_task_id
  const restoreBlocked = restored && (setupLoading || !setup || !sourceValid)
  const dirty = Boolean(form.recipient_user_id || form.title !== initialTitle.current || form.instructions || form.question_hints?.length || draft.reviewed || draft.submitted_payload || acknowledged || draft.revoke?.reason || restoreBlocked)
  const slot = useTeachingDraftSlot({
    slot: studentTaskPublishSlot(followup.followup_id), value: draft, dirty,
    validate: (value): value is StudentTaskPublishDraft => isStudentTaskPublishDraft(value) && value.source.followup_id === followup.followup_id,
    onRestore(value) {
      setDraft({ ...value, payload: cloneStudentTaskIssue(value.payload), submitted_payload: value.submitted_payload === null ? null : cloneStudentTaskIssue(value.submitted_payload), reviewed: false })
      setExpanded(true); setRestored(true); setSetup(null); setSetupLoading(true); setSourceValid(false); setSetupError(false); setSourceIssue(null)
      setLoadNonce(value => value + 1); setListLoading(true); setTaskId(value.revoke?.task_id ?? null); setTask(null); setTaskLoading(value.revoke !== null)
      setError(''); setNotice(t('teacherTasks.restored')); setCleanupError(false)
    },
  })
  const clearDraft = slot.clear
  const preview = useMemo(() => studentVisibleTaskPreview(source, form.title, form.instructions, form.question_hints), [source, form.title, form.instructions, form.question_hints])
  const hintsValid = validQuestionHintPlan(form.question_hints ?? [], source)
  const recipient = setup?.recipients.find(value => value.user_id === form.recipient_user_id)
  const locked = disabled || working !== null || Boolean(acknowledged)
  const publishBlocked = locked || !canPublish || sourceVersionChanged || !sourceValid || setupLoading || !setup?.enabled || !recipient?.can_receive || !draft.reviewed || !hintsValid || Boolean(sourceIssue)

  useEffect(() => { alive.current = true; return () => { alive.current = false; action.current?.abort() } }, [])
  useEffect(() => { callbacks.current?.(dirty); return () => callbacks.current?.(false) }, [dirty, onDirtyChange])
  useEffect(() => {
    if (!expanded) return
    const controller = new AbortController(); setupRead.current = controller
    let mounted = true
    const current = () => mounted && !controller.signal.aborted
    void Promise.allSettled([
      getStudentTaskRecipients(workspaceId, controller.signal),
      getTeachingFollowup(source.followup_id, workspaceId, controller.signal),
      getTeachingReport(source.report_id, workspaceId, controller.signal),
    ]).then(([recipients, savedSet, report]) => {
      if (!current()) return
      if (recipients.status === 'fulfilled') { setSetup(recipients.value); setSetupError(false) } else setSetupError(true)
      if (savedSet.status === 'fulfilled' && report.status === 'fulfilled') {
        const matches = sameSavedFollowup(source, savedSet.value) && report.value.status === 'confirmed' && report.value.revision === source.report_revision && report.value.source_fingerprint === source.source_fingerprint
        setSourceValid(matches); setSourceIssue(matches ? null : 'changed')
      } else { setSourceValid(false); setSourceIssue('failed') }
      setSetupLoading(false)
    })
    return () => { mounted = false; controller.abort() }
  }, [expanded, followup, source, workspaceId, loadNonce])

  useEffect(() => {
    if (!expanded) return
    const controller = new AbortController(); listRead.current = controller
    let mounted = true
    void listTeacherStudentTasks(followup.followup_id, { limit: PAGE_SIZE, offset: listRequest.offset }, workspaceId, controller.signal).then(values => {
      if (!mounted || controller.signal.aborted) return
      setTasks(previous => {
        const rows = listRequest.offset === 0 ? values : [...previous, ...values]
        return Array.from(new Map(rows.map(row => [row.task_id, row])).values())
      })
      setNextOffset(listRequest.offset + values.length); setHasMore(values.length === PAGE_SIZE); setListError(false)
    }).catch(() => { if (mounted && !controller.signal.aborted) setListError(true) }).finally(() => { if (mounted && !controller.signal.aborted) setListLoading(false) })
    return () => { mounted = false; controller.abort() }
  }, [expanded, followup.followup_id, workspaceId, listRequest])

  useEffect(() => {
    if (!taskId) return
    const controller = new AbortController(); taskRead.current = controller
    let mounted = true
    void getTeacherStudentTask(taskId, workspaceId, controller.signal).then(value => {
      if (!mounted || controller.signal.aborted) return
      if (value.task_id !== taskId || value.followup_id !== followup.followup_id || value.source_snapshot.followup_id !== value.followup_id || value.source_snapshot.revision !== value.followup_revision) { setTaskError(true); return }
      setTask(value); setTaskError(false)
      if (rebaseRevokeOnRead.current) {
        setDraft(previous => previous.revoke?.task_id === value.task_id ? { ...previous, revoke: { ...previous.revoke, expected_revision: value.task_revision } } : previous)
        rebaseRevokeOnRead.current = false
      }
    }).catch(() => { if (mounted && !controller.signal.aborted) setTaskError(true) }).finally(() => { if (mounted && !controller.signal.aborted) setTaskLoading(false) })
    return () => { mounted = false; controller.abort() }
  }, [taskId, taskNonce, workspaceId, followup.followup_id])

  useEffect(() => {
    if (!acknowledged) return
    let mounted = true
    // The acknowledged snapshot has reached the hook's layout registration.
    // Failed local cleanup must never turn a server acknowledgement into a new POST.
    void clearDraft().then(() => {
      if (!mounted || !alive.current) return
      setDraft(emptyDraft(source)); setRestored(false); setCleanupError(false); setNotice(t('teacherTasks.published'))
    }).catch(() => {
      if (mounted && alive.current) {
        setCleanupError(true)
        // A failed clear cancelled the provider's write timer. Re-register the
        // acknowledgement so ordinary navigation still preserves that receipt.
        setDraft(previous => ({ ...previous }))
      }
    })
    return () => { mounted = false }
    // The acknowledged intent, not an editor object, owns this cleanup attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acknowledged, cleanupNonce, clearDraft])

  function refreshSetup() { setupRead.current?.abort(); setSetupLoading(true); setSetupError(false); setSourceValid(false); setSourceIssue(null); setLoadNonce(value => value + 1) }
  function refreshList() { listRead.current?.abort(); setListLoading(true); setListError(false); setListRequest(value => ({ offset: 0, nonce: value.nonce + 1 })) }
  function update(change: Partial<IssueStudentTaskRequest>, invalidateIdentity = false) {
    if (locked) return
    const next = cloneStudentTaskIssue({ ...form, ...change })
    const changedIntent = invalidateIdentity || (draft.submitted_payload !== null && !sameStudentTaskIntent(next, draft.submitted_payload))
    setDraft({ ...draft, payload: changedIntent ? { ...next, task_id: crypto.randomUUID() } : next, submitted_payload: changedIntent ? null : draft.submitted_payload, reviewed: false })
    setError(''); setNotice('')
  }
  function updateHints(questionId: string, hints: string[]) {
    const plan = cloneQuestionHints(form.question_hints)
    const existing = plan.findIndex(entry => entry.question_id === questionId)
    if (!hints.length) { if (existing >= 0) plan.splice(existing, 1) }
    else if (existing >= 0) plan[existing] = { question_id: questionId, hints: [...hints] }
    else plan.push({ question_id: questionId, hints: [...hints] })
    if (!sameQuestionHints(form.question_hints, plan)) update({ question_hints: plan }, true)
  }
  async function clearForm() {
    if (locked || action.current) return
    setWorking('clear')
    try { await clearDraft(); if (alive.current) { setDraft(emptyDraft()); setRestored(false); setError(''); setNotice(''); refreshSetup() } }
    catch { if (alive.current) setError(t('teacherTasks.clearFailed')) }
    finally { if (alive.current) setWorking(null) }
  }
  async function publish() {
    if (action.current || acknowledged || disabled || !canPublish || sourceVersionChanged || setupLoading || !sourceValid || !setup?.enabled || sourceIssue) return
    if (!recipient?.can_receive) { setError(t('teacherTasks.invalidRecipient')); return }
    if (!form.title.trim() || [...form.title].length > 200) { setError(t('teacherTasks.invalidTitle')); return }
    if ([...form.instructions].length > 1000) { setError(t('teacherTasks.invalidInstructions')); return }
    if (!hintsValid) { setError(t('teacherTaskHints.invalid')); return }
    if (!draft.reviewed) { setError(t('teacherTasks.reviewRequired')); return }
    const payload = cloneStudentTaskIssue(form)
    const controller = new AbortController(); action.current = controller
    setWorking('publish'); setError(''); setNotice(''); setDraft(value => ({ ...value, submitted_payload: cloneStudentTaskIssue(payload) }))
    try {
      const value = await issueStudentTask(payload, workspaceId, controller.signal)
      if (!alive.current || controller.signal.aborted) return
      if (!matchesIssue(value, payload)) throw new Error(t('teacherTasks.invalidAcknowledgement'))
      setDraft(value => ({ ...value, acknowledged_task_id: payload.task_id })); setNotice(t('teacherTasks.published')); refreshList()
    } catch (reason) {
      if (alive.current && !controller.signal.aborted) {
        if (isApiError(reason) && reason.code === 'teaching_student_task_source_changed') { setSourceIssue('changed'); setSourceValid(false) }
        setError(reason instanceof Error ? reason.message : t('teacherTasks.failed'))
      }
    } finally { if (action.current === controller) action.current = null; if (alive.current && !controller.signal.aborted) setWorking(null) }
  }
  function matchesIssue(value: TeacherStudentTask, payload: IssueStudentTaskRequest) {
    return value.task_id === payload.task_id && value.followup_id === payload.followup_id && value.followup_revision === payload.followup_revision && value.recipient_user_id === payload.recipient_user_id && value.title === payload.title && value.instructions === payload.instructions && sameQuestionHints(value.question_hints, payload.question_hints) && sameSavedFollowup(value.source_snapshot, source)
  }
  async function recoverPublication() {
    const payload = draft.submitted_payload
    if (!payload || action.current || acknowledged || disabled) return
    const controller = new AbortController(); action.current = controller; setWorking('recover'); setError('')
    try {
      const value = await getTeacherStudentTask(payload.task_id, workspaceId, controller.signal)
      if (!alive.current || controller.signal.aborted) return
      if (!matchesIssue(value, payload)) throw new Error(t('teacherTasks.invalidAcknowledgement'))
      setDraft(previous => ({ ...previous, acknowledged_task_id: payload.task_id })); setNotice(t('teacherTasks.receiptRecovered', { status: t(`teacherTasks.status.${value.status}`) })); refreshList()
    } catch { if (alive.current && !controller.signal.aborted) setError(t('teacherTasks.receiptUnconfirmed')) }
    finally { if (action.current === controller) action.current = null; if (alive.current && !controller.signal.aborted) setWorking(null) }
  }
  function openTask(id: string, recheckRevocation = false) { taskRead.current?.abort(); rebaseRevokeOnRead.current = recheckRevocation; setTask(null); setTaskError(false); setTaskLoading(true); setTaskId(id); setTaskNonce(value => value + 1) }
  function closeTask() { taskRead.current?.abort(); setTaskId(null); setTask(null); setTaskError(false); setTaskLoading(false) }
  async function revoke() {
    if (!draft.revoke || !task || action.current || disabled || taskLoading || task.task_id !== draft.revoke.task_id || task.task_revision !== draft.revoke.expected_revision || task.status === 'revoked') return
    if (!draft.revoke.reason.trim()) { setRevokeError(t('teacherTasks.reasonRequired')); return }
    const controller = new AbortController(); action.current = controller; setWorking('revoke'); setRevokeError('')
    const target = draft.revoke
    try {
      const value = await revokeStudentTask(target.task_id, { expected_revision: target.expected_revision, reason: target.reason.trim() }, workspaceId, controller.signal)
      if (!alive.current || controller.signal.aborted) return
      if (value.task_id !== target.task_id || value.status !== 'revoked') throw new Error(t('teacherTasks.revokeFailed'))
      setTask(value); setTasks(previous => previous.map(row => row.task_id === value.task_id ? value : row)); setDraft(value => ({ ...value, revoke: null })); setNotice(t('teacherTasks.revoked'))
    } catch (reason) { if (alive.current && !controller.signal.aborted) setRevokeError(reason instanceof Error ? reason.message : t('teacherTasks.revokeFailed')) }
    finally { if (action.current === controller) action.current = null; if (alive.current && !controller.signal.aborted) setWorking(null) }
  }
  const date = (value: number | null) => value === null || !Number.isFinite(value) ? t('teacherTasks.unknownTime') : new Date(value * 1000).toLocaleString(i18n.language)
  const detail = task && task.task_id === taskId ? task : null

  return <details className="my-5 rounded-xl border border-border bg-card p-4" open={expanded} onToggle={event => {
    const open = event.currentTarget.open
    if (open !== expanded) { setExpanded(open); if (open) { setSetupLoading(true); setSourceValid(false); setListLoading(true) } }
  }}>
    <summary className="cursor-pointer text-sm font-semibold">{t('teacherTasks.title')}</summary>
    {expanded && <div className="mt-4">
      <p className="text-sm leading-6 text-muted-foreground">{t('teacherTasks.hint')}</p>
      {!canPublish && <InlineAlert className="mt-3" tone="warning">{t('teacherTasks.sourceBlocked')}</InlineAlert>}
      {sourceVersionChanged && <InlineAlert className="mt-3" tone="warning">{t('teacherTasks.draftSourceVersion', { draft: source.revision, current: followup.revision })}</InlineAlert>}
      {setupLoading && <div className="mt-3 flex flex-wrap items-center gap-2"><p role="status" className="text-sm text-muted-foreground">{t('teacherTasks.loading')}</p><Button size="sm" variant="ghost" disabled={working !== null} onClick={refreshSetup}>{t('teacherTasks.retry')}</Button></div>}
      {setupError && <InlineAlert className="mt-3" tone="warning" action={<Button size="sm" variant="secondary" onClick={refreshSetup}>{t('teacherTasks.retry')}</Button>}>{t('teacherTasks.loadFailed')}</InlineAlert>}
      {setup && !setup.enabled && <InlineAlert className="mt-3" tone="warning" title={t('teacherTasks.setup')}><p>{t(setup.reason === 'unsupported_identity_backend' ? 'teacherTasks.unsupportedIdentity' : 'teacherTasks.authRequired')}</p><a className="mt-2 inline-block font-medium text-primary underline" href={SETUP_DOC} target="_blank" rel="noopener noreferrer">{t('teacherTasks.setup')}</a></InlineAlert>}
      {setup?.enabled && !setup.recipients.some(value => value.can_receive) && <InlineAlert className="mt-3" action={<a href={scopedUrl('/admin/users', workspaceId)} className="font-medium text-primary underline">{t('teacherTasks.manageAccounts')}</a>}>{t('teacherTasks.noRecipients')}</InlineAlert>}
      {sourceIssue && <InlineAlert className="mt-3" tone="warning" action={<div className="flex flex-wrap gap-2">{sourceIssue === 'failed' ? <Button size="sm" variant="secondary" onClick={refreshSetup}>{t('teacherTasks.retry')}</Button> : <>{onReloadReport && <Button size="sm" variant="secondary" disabled={locked} onClick={onReloadReport}>{t('teacherTasks.reloadSource')}</Button>}{onReloadFollowup && <Button size="sm" variant="secondary" disabled={locked} onClick={onReloadFollowup}>{t('teacherTasks.reloadPractice')}</Button>}</>}</div>}>{t(sourceIssue === 'changed' ? 'teacherTasks.sourceChanged' : 'teacherTasks.sourceCheckFailed')}</InlineAlert>}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label={t('teacherTasks.recipient')} hint={t('teacherTasks.recipientHint')}><select className={controlClass} disabled={locked || setupLoading || !setup?.enabled} value={form.recipient_user_id} onChange={event => update({ recipient_user_id: event.target.value })}><option value="">{t('teacherTasks.chooseRecipient')}</option>{setup?.recipients.map(value => <option key={value.user_id} value={value.user_id} disabled={!value.can_receive}>{t('teacherTasks.recipientIdentity', { name: value.username, id: value.user_id })}{!value.can_receive ? ` · ${value.reason || t('teacherTasks.recipientUnavailable')}` : ''}</option>)}</select></Field>
        <Field label={t('teacherTasks.titleLabel')}><input className={controlClass} maxLength={200} value={form.title} disabled={locked} onChange={event => update({ title: event.target.value })} /></Field>
        <Field className="sm:col-span-2" label={t('teacherTasks.instructions')}><textarea className={controlClass} rows={2} maxLength={1000} disabled={locked} value={form.instructions} onChange={event => update({ instructions: event.target.value })} /></Field>
      </div>
      {form.recipient_user_id && <p className="mt-3 text-xs text-muted-foreground">{t('teacherTasks.recipientIdentity', { name: recipient?.username ?? t('teacherTasks.unavailableAccount'), id: form.recipient_user_id })}{recipient?.can_receive === false && ` · ${recipient.reason || t('teacherTasks.recipientUnavailable')}`}</p>}
      <HintPlanEditor source={source} plan={form.question_hints} disabled={locked} onChange={updateHints} />
      <section className="mt-4 rounded-xl border border-border bg-muted/20 p-4" aria-label={t('teacherTasks.previewTitle')}>
        <h4 className="text-sm font-semibold">{t('teacherTasks.previewTitle')}</h4><p className="mt-1 text-xs leading-5 text-muted-foreground">{t('teacherTasks.previewHint')}</p>
        <p className="mt-3 whitespace-pre-wrap break-words font-medium">{preview.title}</p>{preview.instructions && <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{preview.instructions}</p>}
        <ol className="mt-3 grid gap-3">{preview.questions.map(question => <li key={question.question_id}><p className="text-xs font-medium text-muted-foreground">{question.question_id}</p><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{question.question}</p>{preview.question_hints?.find(entry => entry.question_id === question.question_id) && <div className="mt-3 rounded-lg border border-border p-3"><p className="text-xs font-medium">{t('teacherTaskHints.previewTitle')}</p><ol className="mt-2 grid gap-2">{preview.question_hints.find(entry => entry.question_id === question.question_id)!.hints.map((hint, level) => <li key={level}><p className="text-xs text-muted-foreground">{t('teacherTaskHints.level', { n: level + 1 })}</p><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{hint}</p></li>)}</ol></div>}</li>)}</ol>
      </section>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">{t('teacherTasks.privacyHint')}</p>
      {!hintsValid && <InlineAlert className="mt-3" tone="warning">{t('teacherTaskHints.invalid')}</InlineAlert>}
      <label className="mt-4 flex items-start gap-2 text-sm leading-6"><input className="mt-1 accent-primary" type="checkbox" checked={draft.reviewed} disabled={locked || setupLoading || !sourceValid || !setup?.enabled || !hintsValid} onChange={event => setDraft(value => ({ ...value, reviewed: event.target.checked }))} />{t('teacherTasks.reviewed')}</label>
      <div className="mt-4 flex flex-wrap gap-2"><Button size="sm" icon={<Send size={14} />} disabled={publishBlocked} loading={working === 'publish'} onClick={() => void publish()}>{t('teacherTasks.publish')}</Button><Button size="sm" variant="ghost" disabled={locked} onClick={() => void clearForm()}>{t('teacherTasks.clear')}</Button></div>
      {draft.submitted_payload && !acknowledged && <Button className="mt-3" size="sm" variant="secondary" disabled={disabled || working !== null} loading={working === 'recover'} onClick={() => void recoverPublication()}>{t('teacherTasks.checkReceipt')}</Button>}
      {error && <InlineAlert className="mt-3" tone="warning">{error}</InlineAlert>}{notice && <InlineAlert className="mt-3" tone="success">{notice}</InlineAlert>}
      {acknowledged && <InlineAlert className="mt-3" tone={cleanupError ? 'warning' : 'success'} action={cleanupError && <Button size="sm" variant="secondary" onClick={() => { setCleanupError(false); setCleanupNonce(value => value + 1) }}>{t('teacherTasks.retryCleanup')}</Button>}>{t(cleanupError ? 'teacherTasks.cleanupFailed' : 'teacherTasks.cleanupPending')}</InlineAlert>}
      <details className="mt-5 border-t border-border pt-4"><summary className="cursor-pointer text-sm font-medium">{t('teacherTasks.listTitle', { n: tasks.length })}</summary><p className="mt-3 text-xs leading-5 text-muted-foreground">{t('teacherTasks.listHint')}</p>
        <Button className="mt-3" size="sm" variant="ghost" icon={<RefreshCw size={14} />} disabled={listLoading} onClick={refreshList}>{t('teacherTasks.refresh')}</Button>
        {listLoading && <p role="status" className="mt-3 text-sm text-muted-foreground">{t('teacherTasks.loading')}</p>}{listError && <InlineAlert className="mt-3" tone="warning">{t('teacherTasks.listFailed')}</InlineAlert>}
        {!listLoading && !listError && !tasks.length && <p className="mt-3 text-sm text-muted-foreground">{t('teacherTasks.noTasks')}</p>}
        <ul className="mt-3 grid max-h-96 gap-3 overflow-y-auto">{tasks.map(row => <li key={row.task_id} className="rounded-lg border border-border p-3"><div className="flex flex-wrap justify-between gap-2"><p className="text-sm font-medium">{row.title}</p><StatusChip tone={row.status === 'submitted' ? 'success' : row.status === 'revoked' ? 'warning' : 'neutral'}>{t(`teacherTasks.status.${row.status}`)}</StatusChip></div><p className="mt-1 break-words text-xs text-muted-foreground">{t('teacherTasks.recipientIdentity', { name: setup?.recipients.find(value => value.user_id === row.recipient_user_id)?.username ?? t('teacherTasks.unavailableAccount'), id: row.recipient_user_id })}</p><p className="mt-1 text-xs text-muted-foreground">{t('teacherTasks.practiceVersion', { n: row.followup_revision })} · {t('teacherTasks.issuedAt', { time: date(row.issued_at) })}</p><Button className="mt-2" size="sm" variant="secondary" disabled={working !== null} onClick={() => openTask(row.task_id)}>{t('teacherTasks.view')}</Button></li>)}</ul>
        {hasMore && <Button className="mt-3" size="sm" variant="secondary" disabled={listLoading} onClick={() => { setListLoading(true); setListRequest(value => ({ offset: nextOffset, nonce: value.nonce + 1 })) }}>{t('teacherTasks.more')}</Button>}
      </details>
      <Dialog open={taskId !== null && draft.revoke === null} title={t('teacherTasks.detailTitle')} size="lg" closeLabel={t('Close')} onClose={closeTask} footer={<Button variant="secondary" onClick={closeTask}>{t('Close')}</Button>}>
        {taskLoading && <p role="status">{t('teacherTasks.detailLoading')}</p>}{taskError && <InlineAlert tone="warning" action={<Button size="sm" onClick={() => { if (taskId) openTask(taskId) }}>{t('teacherTasks.retry')}</Button>}>{t('teacherTasks.detailFailed')}</InlineAlert>}
        {detail && !taskError && <><p className="text-xs leading-5 text-muted-foreground">{t('teacherTasks.readOnly')}</p><h4 className="mt-3 font-semibold">{detail.title}</h4><p className="mt-2 break-words text-xs text-muted-foreground">{t('teacherTasks.recipientIdentity', { name: setup?.recipients.find(value => value.user_id === detail.recipient_user_id)?.username ?? t('teacherTasks.unavailableAccount'), id: detail.recipient_user_id })}</p><p className="mt-1 text-xs text-muted-foreground">{t('teacherTasks.sourceVersion', { report: detail.source_snapshot.report_revision, practice: detail.followup_revision })}</p><StatusChip className="mt-3">{t(`teacherTasks.status.${detail.status}`)}</StatusChip>{detail.instructions && <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6">{detail.instructions}</p>}
          {detail.submission ? <section className="mt-4" aria-label={t('teacherTasks.finalAnswers')}><h4 className="text-sm font-semibold">{t('teacherTasks.finalAnswers')}</h4><p className="mt-1 text-xs text-muted-foreground">{t('teacherTasks.submittedAt', { time: date(detail.submission.submitted_at) })}</p><ol className="mt-3 grid gap-3">{detail.submission.responses.map(response => <li key={response.question_id} className="rounded-lg border border-border p-3"><p className="text-xs font-medium">{response.question_id}</p><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{detail.source_snapshot.questions.find(question => question.question_id === response.question_id)?.question}</p><div className="mt-2 flex flex-wrap gap-2"><StatusChip tone={response.response_status === 'needs_help' ? 'warning' : 'neutral'}>{t(`teacherTasks.response.${response.response_status}`)}</StatusChip><StatusChip>{t(`teaching.assistanceStatus.${response.assistance}`)}</StatusChip></div><p className="mt-3 text-xs text-muted-foreground">{t('teacherTasks.answer')}</p><p className="mt-1 whitespace-pre-wrap break-words border-l-2 border-primary/30 pl-3 text-sm leading-6">{response.answer ?? t('teaching.notProvided')}</p></li>)}</ol></section> : <InlineAlert className="mt-4">{t('teacherTasks.notSubmitted')}</InlineAlert>}
          {!detail.submission && <ol className="mt-4 grid gap-3">{detail.source_snapshot.questions.map(({ question_id, question }) => <li key={question_id} className="rounded-lg border border-border p-3"><p className="text-xs font-medium">{question_id}</p><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{question}</p></li>)}</ol>}
          <HintHistory task={detail} date={date} />
          {detail.submission && <Link href={scopedUrl(`/learning/teaching-analysis/student-tasks/${encodeURIComponent(detail.task_id)}/review`, workspaceId)} prefetch={false} className="mt-4 inline-flex min-h-10 items-center rounded-xl border border-border px-4 text-sm font-medium">{t('teacherTaskReviews.open')}</Link>}
          {detail.revoke_reason && <p className="mt-4 whitespace-pre-wrap break-words text-sm">{t('teacherTasks.revokeReason')}：{detail.revoke_reason}</p>}{detail.status !== 'revoked' && <Button className="mt-4" size="sm" variant="danger" disabled={disabled || working !== null || Boolean(acknowledged)} onClick={() => { setDraft(value => ({ ...value, revoke: { task_id: detail.task_id, expected_revision: detail.task_revision, reason: '' } })); setRevokeError('') }}>{t('teacherTasks.revoke')}</Button>}</>}
      </Dialog>
      <Dialog open={draft.revoke !== null} title={t('teacherTasks.revokeTitle')} closeLabel={t('Close')} busy={working === 'revoke'} onClose={() => { if (working === null) setDraft(value => ({ ...value, revoke: null })) }} footer={<><Button variant="secondary" disabled={working !== null} onClick={() => setDraft(value => ({ ...value, revoke: null }))}>{t('Cancel')}</Button><Button variant="danger" loading={working === 'revoke'} disabled={disabled || working !== null || taskLoading || !detail || detail.task_revision !== draft.revoke?.expected_revision || detail.status === 'revoked'} onClick={() => void revoke()}>{t('teacherTasks.revokeConfirm')}</Button></>}>
        <p className="text-sm leading-6">{t('teacherTasks.revokeHint')}</p><Field className="mt-4" label={t('teacherTasks.revokeReason')} error={revokeError || undefined}><textarea className={controlClass} rows={3} maxLength={2000} disabled={working !== null} value={draft.revoke?.reason ?? ''} onChange={event => { const reason = event.target.value; setDraft(value => ({ ...value, revoke: value.revoke ? { ...value.revoke, reason } : null })); setRevokeError('') }} /></Field>
        {(taskError || revokeError || (detail && detail.task_revision !== draft.revoke?.expected_revision)) && <InlineAlert className="mt-3" tone="warning" action={<Button size="sm" variant="secondary" disabled={working !== null} onClick={() => { if (draft.revoke) { setRevokeError(''); openTask(draft.revoke.task_id, true) } }}>{t('teacherTasks.refreshTask')}</Button>}>{t('teacherTasks.revokeChanged')}</InlineAlert>}
      </Dialog>
    </div>}
  </details>
}
