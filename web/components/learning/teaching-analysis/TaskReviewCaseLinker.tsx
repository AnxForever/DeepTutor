'use client'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, Field, InlineAlert } from '@/shared/ui'
import type { TeacherStudentTask } from '@/lib/teacher-student-tasks-api'
import type { SavedTaskReview } from '@/lib/task-reviews-api'
import { getStudentCase, listStudentCases, studentCaseRoute, type SavedStudentCase, type StudentCaseSummary } from '@/lib/teaching-student-cases-api'
import { cloneCaseEvidenceLinks, cloneCaseEvidenceRequest, getCaseTaskReviewEvidence, type CaseReviewEvidenceView, type SaveCaseReviewEvidence } from '@/lib/teaching-case-review-api'
import { isTaskReviewCaseDraft, taskReviewCaseSlot, type ReviewLinkTarget, type TaskReviewCaseDraft } from '@/lib/teaching-case-review-drafts'
import { useCaseReviewEvidenceWrite } from '@/hooks/useCaseReviewEvidenceWrite'
import { useAuthStatus } from '@/hooks/useAuthStatus'
import { useTeachingDraftSlot } from './TeachingDrafts'
import { controlClass } from './AssignmentEditor'
import { TaskTranslations } from '../TaskTranslations'

export interface TaskReviewCaseLinkerProps { task: TeacherStudentTask; review: SavedTaskReview; workspaceId: string; disabled?: boolean; onDirtyChange?: (dirty: boolean) => void }
export function TaskReviewCaseLinker(props: TaskReviewCaseLinkerProps) { const auth = useAuthStatus(); const canWrite = !auth.loading && auth.statusAvailable && auth.enabled && auth.authenticated && auth.isAdmin && Boolean(auth.userId); return <TaskTranslations compact><CaseLinker key={`${props.workspaceId}:${props.task.task_id}`} {...props} canWrite={canWrite} /></TaskTranslations> }

function CaseLinker({ task, review, workspaceId, disabled = false, onDirtyChange, canWrite }: TaskReviewCaseLinkerProps & { canWrite: boolean }) {
  const { t } = useTranslation()
  const context = (): ReviewLinkTarget => ({ task_id: task.task_id, submission_id: review.submission_id, review_revision: review.revision, recipient_user_id: task.recipient_user_id, report_id: task.source_snapshot.report_id, report_revision: task.source_snapshot.report_revision, source_fingerprint: task.source_snapshot.source_fingerprint, question_ids: review.items.map(item => item.question_id) })
  const empty = (caseId: string | null = null): TaskReviewCaseDraft => ({ kind: 'task-review-case-link', version: 1, target: context(), case_id: caseId, case_label: '', mutation: null, identity_checked: false })
  const [draft, setDraft] = useState(empty)
  const [cases, setCases] = useState<StudentCaseSummary[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState(false)
  const [offset, setOffset] = useState(0)
  const [moreCases, setMoreCases] = useState(false)
  const [listNonce, setListNonce] = useState(0)
  const [savedCase, setSavedCase] = useState<SavedStudentCase | null>(null)
  const [view, setView] = useState<CaseReviewEvidenceView | null>(null)
  const [loading, setLoading] = useState(false)
  const [readError, setReadError] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [replacement, setReplacement] = useState<{ caseId: string | null } | null>(null)
  const [clearError, setClearError] = useState(false)
  const [notice, setNotice] = useState(false)
  const alive = useRef(true)
  const knownHeads = useRef(new Map<string, number>())
  const dirty = draft.case_id !== null
  const slot = useTeachingDraftSlot({
    slot: taskReviewCaseSlot(task.task_id), value: draft, dirty,
    validate: (value): value is TaskReviewCaseDraft => isTaskReviewCaseDraft(value) && value.target.task_id.toLowerCase() === task.task_id.toLowerCase() && value.target.submission_id.toLowerCase() === review.submission_id.toLowerCase() && value.target.recipient_user_id === task.recipient_user_id && value.target.source_fingerprint === task.source_snapshot.source_fingerprint && value.target.report_id.toLowerCase() === task.source_snapshot.report_id.toLowerCase() && value.target.report_revision === task.source_snapshot.report_revision && value.target.question_ids.every(id => task.source_snapshot.questions.some(question => question.question_id === id)),
    onRestore(value) { setDraft({ ...value, mutation: value.mutation ? { ...value.mutation, payload: cloneCaseEvidenceRequest(value.mutation.payload), submitted_payload: value.mutation.submitted_payload ? cloneCaseEvidenceRequest(value.mutation.submitted_payload) : null } : null, identity_checked: false }); setLoading(value.case_id !== null); setSavedCase(null); setView(null); setReadError(false); setNonce(value => value + 1) },
  })
  const writer = useCaseReviewEvidenceWrite({ caseId: draft.case_id, workspaceId, recipient: draft.target.recipient_user_id, mutation: draft.mutation, clear: slot.clear,
    onHead: evidence => { const revision = evidence.overlay?.revision ?? 0; if (revision >= (knownHeads.current.get(evidence.case_id) ?? 0)) { knownHeads.current.set(evidence.case_id, revision); setView(evidence) } },
    onSent: payload => setDraft(value => ({ ...value, mutation: value.mutation ? { ...value.mutation, submitted_payload: payload } : null })),
    onAcknowledged: requestId => setDraft(value => ({ ...value, mutation: value.mutation ? { ...value.mutation, acknowledged_request_id: requestId } : null })),
    onKeepAcknowledged: requestId => setDraft(value => value.mutation?.acknowledged_request_id === requestId ? { ...value } : value),
    onCleared: requestId => { setDraft(value => value.mutation?.acknowledged_request_id === requestId ? empty() : value); setNotice(true) },
  })
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false) }, [dirty, onDirtyChange])
  useEffect(() => {
    if (!canWrite) return
    const controller = new AbortController(); let active = true
    void listStudentCases({ limit: 50, offset, archived: false }, workspaceId, controller.signal).then(values => {
      if (!active || controller.signal.aborted) return
      setCases(previous => Array.from(new Map((offset ? [...previous, ...values] : values).map(value => [value.case_id, value])).values())); setMoreCases(values.length === 50); setListError(false)
    }).catch(() => { if (active && !controller.signal.aborted) setListError(true) }).finally(() => { if (active && !controller.signal.aborted) setListLoading(false) })
    return () => { active = false; controller.abort() }
  }, [offset, listNonce, workspaceId, canWrite])
  useEffect(() => {
    if (!draft.case_id) return
    const caseId = draft.case_id; const controller = new AbortController(); let active = true
    void Promise.all([getStudentCase(caseId, workspaceId, controller.signal), getCaseTaskReviewEvidence(caseId, workspaceId, controller.signal)]).then(([selected, evidence]) => {
      if (!active || controller.signal.aborted) return
      if (selected.case_id !== caseId || evidence.case_id !== caseId || selected.revision !== evidence.case_revision) { setReadError(true); return }
      if ((evidence.overlay?.revision ?? 0) < (knownHeads.current.get(caseId) ?? 0)) { setReadError(true); return }
      knownHeads.current.set(caseId, evidence.overlay?.revision ?? 0)
      setSavedCase(selected); setView(evidence); setReadError(false)
      setDraft(previous => {
        if (previous.case_id !== caseId || previous.mutation) return previous
        const links = cloneCaseEvidenceLinks(evidence.overlay?.links ?? [])
        const existing = links.findIndex(link => link.submission_id.toLowerCase() === previous.target.submission_id.toLowerCase())
        const prior = existing >= 0 ? links[existing] : null
        const link = { task_id: previous.target.task_id, submission_id: previous.target.submission_id, review_revision: previous.target.review_revision, question_ids: prior?.question_ids.filter(id => previous.target.question_ids.includes(id)) ?? [...previous.target.question_ids], teacher_observation: prior?.teacher_observation ?? '', next_teaching_action: prior?.next_teaching_action ?? '' }
        if (existing >= 0) links[existing] = link
        else if (links.length < 20) links.push(link)
        else return { ...previous, case_label: selected.label, mutation: null }
        return { ...previous, case_label: selected.label, mutation: { payload: { request_id: crypto.randomUUID(), expected_revision: evidence.overlay?.revision ?? 0, expected_case_revision: selected.revision, identity_confirmed: true, links }, submitted_payload: null, acknowledged_request_id: null } }
      })
    }).catch(() => { if (active && !controller.signal.aborted) setReadError(true) }).finally(() => { if (active && !controller.signal.aborted) setLoading(false) })
    return () => { active = false; controller.abort() }
  }, [draft.case_id, workspaceId, nonce])
  const link = draft.mutation?.payload.links.find(value => value.submission_id.toLowerCase() === draft.target.submission_id.toLowerCase())
  const pinPresent = savedCase?.report_refs.some(pin => pin.report_id.toLowerCase() === draft.target.report_id.toLowerCase() && pin.report_revision === draft.target.report_revision)
  const boundOther = Boolean(view?.overlay?.links.length && view.overlay.recipient_user_id !== draft.target.recipient_user_id)
  const sourceChanged = review.status !== 'confirmed' || review.revision !== draft.target.review_revision || task.status === 'revoked' || task.submission?.submission_id !== draft.target.submission_id || review.recipient_user_id !== task.recipient_user_id
  const staleBase = Boolean(draft.mutation && view && (draft.mutation.payload.expected_case_revision !== view.case_revision || draft.mutation.payload.expected_revision !== (view.overlay?.revision ?? 0)))
  const valid = Boolean(link && link.question_ids.length && link.question_ids.length <= 3 && Array.from(link.teacher_observation).length <= 2000 && Array.from(link.next_teaching_action).length <= 2000)
  const canSave = canWrite && !disabled && !writer.posting && !writer.acknowledged && !loading && !readError && savedCase && !savedCase.archived && pinPresent && !boundOther && !sourceChanged && !staleBase && valid && draft.identity_checked
  function updateLink(change: Partial<NonNullable<typeof link>>) {
    if (!canWrite || disabled || writer.posting || writer.acknowledged) return
    writer.clearError(); setNotice(false)
    setDraft(value => !value.mutation ? value : { ...value, identity_checked: false, mutation: { payload: { ...value.mutation.payload, request_id: crypto.randomUUID(), links: value.mutation.payload.links.map(entry => entry.submission_id.toLowerCase() === value.target.submission_id.toLowerCase() ? { ...entry, ...change, question_ids: change.question_ids ? [...change.question_ids] : [...entry.question_ids] } : entry) }, submitted_payload: null, acknowledged_request_id: null } })
  }
  async function clearAndSelect(caseId: string | null) {
    try { if (dirty) await slot.clear(); if (!alive.current) return; setDraft(empty(caseId)); setSavedCase(null); setView(null); setLoading(caseId !== null); setReadError(false); setNotice(false); setClearError(false); setReplacement(null); setNonce(value => value + 1); writer.clearError() }
    catch { if (alive.current) setClearError(true) }
  }
  function select(caseId: string | null) { if (dirty) setReplacement({ caseId }); else void clearAndSelect(caseId) }
  return <section className="mt-6 rounded-xl border border-border bg-card p-4" aria-label={t('caseTaskReviews.linkTitle')}>
    <h3 className="text-base font-semibold">{t('caseTaskReviews.linkTitle')}</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">{t('caseTaskReviews.linkHint')}</p>
    {!canWrite && <InlineAlert className="mt-3" tone="warning"><p>{t('caseTaskReviews.authRequired')}</p><a className="mt-2 inline-block font-medium text-primary underline" href="https://github.com/AnxForever/DeepTutor/blob/teacher-diagnostics/docs-for-dev/STUDENT_TASKS.md" target="_blank" rel="noopener noreferrer">{t('caseTaskReviews.setup')}</a></InlineAlert>}
    <p className="mt-3 break-all text-xs font-medium">{t('caseTaskReviews.learnerUid', { id: draft.target.recipient_user_id })} · {t('caseTaskReviews.reviewVersion', { n: draft.target.review_revision })}</p>
    <Field className="mt-4" label={t('caseTaskReviews.caseField')}><select className={controlClass} value={draft.case_id ?? ''} disabled={!canWrite || disabled || writer.posting || writer.acknowledged || listLoading} onChange={event => select(event.target.value || null)}><option value="">{t('caseTaskReviews.chooseCase')}</option>{draft.case_id && !cases.some(value => value.case_id === draft.case_id) && <option value={draft.case_id}>{draft.case_label || draft.case_id}</option>}{cases.map(value => <option key={value.case_id} value={value.case_id}>{t('caseTaskReviews.caseIdentity', { label: value.label, id: value.case_id })}</option>)}</select></Field>
    {listLoading && canWrite && <p role="status" className="mt-3 text-sm">{t('caseTaskReviews.loading')}</p>}{listError && <InlineAlert className="mt-3" tone="warning" action={<Button size="sm" onClick={() => { setListLoading(true); setListNonce(value => value + 1) }}>{t('caseTaskReviews.retry')}</Button>}>{t('caseTaskReviews.listFailed')}</InlineAlert>}
    {moreCases && <Button className="mt-3" size="sm" variant="secondary" disabled={listLoading} onClick={() => { setListLoading(true); setOffset(value => value + 50) }}>{t('caseTaskReviews.moreCases')}</Button>}
    {draft.case_id && <><p className="mt-3 break-all text-xs">{t('caseTaskReviews.caseIdentity', { label: savedCase?.label ?? draft.case_label, id: draft.case_id })}</p>{loading && <p role="status" className="mt-3 text-sm">{t('caseTaskReviews.loading')}</p>}{readError && <InlineAlert className="mt-3" tone="warning" action={<Button size="sm" variant="secondary" onClick={() => { setLoading(true); setReadError(false); setNonce(value => value + 1) }}>{t('caseTaskReviews.retry')}</Button>}>{t('caseTaskReviews.loadFailed')}</InlineAlert>}
      {view && <p className="mt-2 break-all text-xs text-muted-foreground">{t(view.overlay?.recipient_user_id ? 'caseTaskReviews.boundUid' : 'caseTaskReviews.unbound', { id: view.overlay?.recipient_user_id })}</p>}
      {boundOther && <InlineAlert className="mt-3" tone="warning">{t('caseTaskReviews.boundOther')}</InlineAlert>}{savedCase?.archived && <InlineAlert className="mt-3" tone="warning">{t('caseTaskReviews.archived')}</InlineAlert>}
      {savedCase && !pinPresent && <InlineAlert className="mt-3" tone="warning">{t('caseTaskReviews.missingPin')} · {t('caseTaskReviews.reportVersion', { n: draft.target.report_revision })}</InlineAlert>}
      <Link className="mt-3 inline-block text-sm font-medium text-primary underline" href={studentCaseRoute(draft.case_id, workspaceId)}>{t('caseTaskReviews.openCase')}</Link>
      {(sourceChanged || staleBase) && <InlineAlert className="mt-3" tone="warning">{t('caseTaskReviews.staleDraft')}</InlineAlert>}
      {!link && view && <InlineAlert className="mt-3" tone="warning">{t('caseTaskReviews.limit')}</InlineAlert>}
      {link && <fieldset className="mt-4 grid gap-3" disabled={!canWrite || disabled || writer.posting || writer.acknowledged}><legend className="text-sm font-medium">{t('caseTaskReviews.questionChoice')}</legend>{draft.target.question_ids.map(id => <label key={id} className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 accent-primary" checked={link.question_ids.includes(id)} onChange={event => updateLink({ question_ids: event.target.checked ? [...link.question_ids, id] : link.question_ids.filter(value => value !== id) })} /><span>{id} · {task.source_snapshot.questions.find(question => question.question_id === id)?.question}</span></label>)}<Field label={t('caseTaskReviews.observation')}><textarea className={controlClass} rows={2} maxLength={2000} value={link.teacher_observation} onChange={event => updateLink({ teacher_observation: event.target.value })} /></Field><Field label={t('caseTaskReviews.nextAction')}><textarea className={controlClass} rows={2} maxLength={2000} value={link.next_teaching_action} onChange={event => updateLink({ next_teaching_action: event.target.value })} /></Field></fieldset>}
      <label className="mt-4 flex items-start gap-2 text-sm leading-6"><input type="checkbox" className="mt-1 accent-primary" checked={draft.identity_checked} disabled={!canWrite || disabled || writer.posting || writer.acknowledged || loading || !pinPresent || boundOther || sourceChanged || staleBase || !valid || savedCase?.archived} onChange={event => setDraft(value => ({ ...value, identity_checked: event.target.checked }))} />{t('caseTaskReviews.identityCheck')}</label>
      <div className="mt-4 flex flex-wrap gap-2">{canWrite && <Button size="sm" disabled={!canSave} loading={writer.posting} onClick={() => void writer.submit()}>{t('caseTaskReviews.saveLink')}</Button>}{canWrite && draft.mutation?.submitted_payload && !writer.acknowledged && <Button size="sm" variant="secondary" disabled={disabled || writer.posting} onClick={() => void writer.submit()}>{t('caseTaskReviews.retrySame')}</Button>}<Button size="sm" variant="ghost" disabled={writer.posting} onClick={() => void clearAndSelect(null)}>{t('caseTaskReviews.clearDraft')}</Button><Button size="sm" variant="ghost" disabled={disabled || writer.posting} onClick={() => select(draft.case_id)}>{t('caseTaskReviews.refresh')}</Button></div>
      {writer.posting && <Button className="mt-3" size="sm" variant="secondary" onClick={writer.stopWaiting}>{t('caseTaskReviews.stopRequest')}</Button>}
    </>}
    {writer.error && <InlineAlert className="mt-3" tone="warning">{t('caseTaskReviews.saveFailed')}</InlineAlert>}{(notice || writer.acknowledged) && <InlineAlert className="mt-3" tone="success">{t('caseTaskReviews.saved')}</InlineAlert>}{writer.acknowledged && writer.cleanupError && <InlineAlert className="mt-3" tone="warning" action={<Button size="sm" onClick={writer.retryCleanup}>{t('caseTaskReviews.retryCleanup')}</Button>}>{t('caseTaskReviews.cleanupFailed')}</InlineAlert>}{clearError && <InlineAlert className="mt-3" tone="warning">{t('caseTaskReviews.clearFailed')}</InlineAlert>}
    <Dialog open={replacement !== null} title={t('caseTaskReviews.replaceTitle')} closeLabel={t('Close')} onClose={() => setReplacement(null)} footer={<><Button variant="secondary" onClick={() => setReplacement(null)}>{t('Cancel')}</Button><Button onClick={() => { if (replacement) void clearAndSelect(replacement.caseId) }}>{t('caseTaskReviews.discard')}</Button></>}><p className="text-sm leading-6">{t('caseTaskReviews.replaceHint')}</p></Dialog>
  </section>
}
