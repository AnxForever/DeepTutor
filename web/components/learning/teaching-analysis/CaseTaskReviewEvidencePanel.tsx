'use client'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, InlineAlert, StatusChip } from '@/shared/ui'
import { scopedUrl } from '@/lib/workspace-scope'
import { cloneCaseEvidenceLinks, cloneCaseEvidenceRequest, getCaseTaskReviewEvidence, sameCaseEvidenceLinks, type CaseReviewEvidenceSourceState, type CaseReviewEvidenceView } from '@/lib/teaching-case-review-api'
import { caseReviewEvidenceSlot, isCaseEvidencePanelDraft, type CaseEvidencePanelDraft } from '@/lib/teaching-case-review-drafts'
import { useCaseReviewEvidenceWrite } from '@/hooks/useCaseReviewEvidenceWrite'
import { useAuthStatus } from '@/hooks/useAuthStatus'
import { useTeachingDraftSlot } from './TeachingDrafts'
import { TaskTranslations } from '../TaskTranslations'

export interface CaseTaskReviewEvidencePanelProps { caseId: string; workspaceId: string; caseRevision: number; caseLabel: string; disabled?: boolean; onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void; onReloadCase?: () => void }
export function CaseTaskReviewEvidencePanel(props: CaseTaskReviewEvidencePanelProps) { const auth = useAuthStatus(); const canWrite = !auth.loading && auth.statusAvailable && auth.enabled && auth.authenticated && auth.isAdmin && Boolean(auth.userId); return <TaskTranslations compact><EvidencePanel key={`${props.workspaceId}:${props.caseId}`} {...props} canWrite={canWrite} /></TaskTranslations> }

function EvidenceQuestions({ source }: { source: CaseReviewEvidenceSourceState | undefined }) {
  const { t, i18n } = useTranslation()
  if (!source?.questions.length) return <p className="mt-3 text-sm text-muted-foreground">{t('caseTaskReviews.unavailableQuestions')}</p>
  return <div className="mt-3 grid gap-4">{source.questions.map(question => <section key={question.question_id} className="rounded-lg border border-border p-3"><h5 className="text-sm font-medium">{question.question_id}</h5><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{question.question}</p><div className="mt-3 flex flex-wrap gap-2"><StatusChip>{t('caseTaskReviews.assessment')} · {t(`teaching.result.${question.result}`)}</StatusChip><StatusChip>{t(`teaching.assistanceStatus.${question.assistance}`)}</StatusChip><StatusChip>{t(`teacherTasks.response.${question.response_status}`)}</StatusChip></div><blockquote className="mt-3 whitespace-pre-wrap break-words border-l-2 border-primary/30 bg-muted/30 p-3 text-sm leading-6">{question.answer ?? t('teaching.notProvided')}</blockquote>{question.feedback && <div className="mt-3"><p className="text-xs text-muted-foreground">{t('caseTaskReviews.feedback')}</p><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{question.feedback}</p></div>}
    {question.hint_usage === null ? <p className="mt-3 text-xs leading-5 text-muted-foreground">{t('caseTaskReviews.hintsUnknown')}</p> : !question.hint_usage.length ? <p className="mt-3 text-xs leading-5 text-muted-foreground">{t('caseTaskReviews.noHints')}</p> : <ul className="mt-3 grid gap-2">{question.hint_usage.map(hint => <li key={hint.level} className="rounded-lg bg-muted/30 p-3"><p className="text-xs font-medium text-muted-foreground">{t('caseTaskReviews.usedHint', { n: hint.level, time: new Date(hint.revealed_at * 1000).toLocaleString(i18n.language) })}</p><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{hint.text}</p></li>)}</ul>}
  </section>)}</div>
}

function EvidencePanel({ caseId, workspaceId, caseRevision, caseLabel, disabled = false, onDirtyChange, onBusyChange, onReloadCase, canWrite }: CaseTaskReviewEvidencePanelProps & { canWrite: boolean }) {
  const { t, i18n } = useTranslation()
  const empty = (): CaseEvidencePanelDraft => ({ kind: 'case-review-evidence', version: 1, case_id: caseId, mutation: null, identity_checked: false })
  const [draft, setDraft] = useState(empty)
  const [expanded, setExpanded] = useState(false)
  const [view, setView] = useState<CaseReviewEvidenceView | null>(null)
  const [nonce, setNonce] = useState(0)
  const [settled, setSettled] = useState<string | null>(null)
  const [readError, setReadError] = useState(false)
  const [caseChanged, setCaseChanged] = useState(false)
  const [confirmation, setConfirmation] = useState(false)
  const [clearError, setClearError] = useState(false)
  const [notice, setNotice] = useState(false)
  const alive = useRef(true)
  const knownHead = useRef(0)
  const dirty = draft.mutation !== null
  const readKey = `${caseRevision}:${nonce}`
  const loading = expanded && settled !== readKey
  const slot = useTeachingDraftSlot({ slot: caseReviewEvidenceSlot(caseId), value: draft, dirty, validate: (value): value is CaseEvidencePanelDraft => isCaseEvidencePanelDraft(value) && value.case_id.toLowerCase() === caseId.toLowerCase(), onRestore(value) { setDraft({ ...value, mutation: value.mutation ? { ...value.mutation, payload: cloneCaseEvidenceRequest(value.mutation.payload), submitted_payload: value.mutation.submitted_payload ? cloneCaseEvidenceRequest(value.mutation.submitted_payload) : null } : null, identity_checked: false }); setExpanded(true); setNonce(value => value + 1) } })
  const writer = useCaseReviewEvidenceWrite({ caseId, workspaceId, mutation: draft.mutation, clear: slot.clear,
    onHead: value => { if (value.case_revision !== caseRevision) { setCaseChanged(true); return } const revision = value.overlay?.revision ?? 0; if (revision >= knownHead.current) { knownHead.current = revision; setView(value) } },
    onSent: payload => setDraft(value => ({ ...value, mutation: value.mutation ? { ...value.mutation, submitted_payload: payload } : null })),
    onAcknowledged: requestId => setDraft(value => ({ ...value, mutation: value.mutation ? { ...value.mutation, acknowledged_request_id: requestId } : null })),
    onKeepAcknowledged: requestId => setDraft(value => value.mutation?.acknowledged_request_id === requestId ? { ...value } : value),
    onCleared: requestId => { setDraft(value => value.mutation?.acknowledged_request_id === requestId ? empty() : value); setNotice(true); setNonce(value => value + 1) },
  })
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false) }, [dirty, onDirtyChange])
  useEffect(() => { onBusyChange?.(writer.posting); return () => onBusyChange?.(false) }, [writer.posting, onBusyChange])
  useEffect(() => {
    if (!expanded) return
    const controller = new AbortController(); let active = true
    void getCaseTaskReviewEvidence(caseId, workspaceId, controller.signal).then(value => {
      if (!active || controller.signal.aborted) return
      if (value.case_id.toLowerCase() !== caseId.toLowerCase() || value.case_revision !== caseRevision) { setCaseChanged(true); return }
      if ((value.overlay?.revision ?? 0) < knownHead.current) { setReadError(true); return }
      knownHead.current = value.overlay?.revision ?? 0
      setView(value); setReadError(false); setCaseChanged(false)
    }).catch(() => { if (active && !controller.signal.aborted) setReadError(true) }).finally(() => { if (active && !controller.signal.aborted) setSettled(readKey) })
    return () => { active = false; controller.abort() }
  }, [expanded, caseId, workspaceId, caseRevision, readKey])
  const staleBase = Boolean(draft.mutation && view && (draft.mutation.payload.expected_case_revision !== view.case_revision || draft.mutation.payload.expected_revision !== (view.overlay?.revision ?? 0)))
  const deletionOnly = !draft.mutation || Boolean(view && draft.mutation.payload.links.every(link => view.overlay?.links.some(original => sameCaseEvidenceLinks([original], [link]))))
  const stale = caseChanged || Boolean(view && view.case_revision !== caseRevision) || staleBase || !deletionOnly
  function toggleRemoval(submissionId: string, remove: boolean) {
    if (!canWrite || !view || disabled || writer.posting || writer.acknowledged || stale || loading) return
    const links = cloneCaseEvidenceLinks(draft.mutation?.payload.links ?? view.overlay?.links ?? [])
    const kept = new Set(links.map(link => link.submission_id))
    if (remove) kept.delete(submissionId); else kept.add(submissionId)
    const next = cloneCaseEvidenceLinks((view.overlay?.links ?? []).filter(link => kept.has(link.submission_id)))
    if (sameCaseEvidenceLinks(next, view.overlay?.links ?? [])) { setDraft(empty()); writer.clearError(); return }
    setDraft({ ...draft, identity_checked: false, mutation: { payload: { request_id: crypto.randomUUID(), expected_revision: view.overlay?.revision ?? 0, expected_case_revision: view.case_revision, identity_confirmed: true, links: next }, submitted_payload: null, acknowledged_request_id: null } }); writer.clearError(); setNotice(false)
  }
  async function clear(refresh: boolean) {
    try { await slot.clear(); if (!alive.current) return; setDraft(empty()); setClearError(false); setConfirmation(false); writer.clearError(); if (refresh) setNonce(value => value + 1) }
    catch { if (alive.current) setClearError(true) }
  }
  function requestRefresh() { if (dirty) setConfirmation(true); else setNonce(value => value + 1) }
  return <details className="mt-7 rounded-xl border border-border bg-card p-4 sm:p-5" open={expanded} onToggle={event => { const value = event.currentTarget.open; if (value !== expanded) { setExpanded(value); if (value) setNonce(value => value + 1) } }}>
    <summary className="cursor-pointer text-base font-semibold">{t('caseTaskReviews.title')}</summary>
    {expanded && <div className="mt-4" aria-busy={loading}>
      <p className="text-sm leading-6 text-muted-foreground">{t('caseTaskReviews.hint')}</p><p className="mt-2 break-all text-xs text-muted-foreground">{t('caseTaskReviews.caseIdentity', { label: caseLabel, id: caseId })}</p><p className="mt-2 text-xs text-muted-foreground">{t('caseTaskReviews.readonlyVersion')}</p>
      {!canWrite && <InlineAlert className="mt-3" tone="warning"><p>{t('caseTaskReviews.authRequired')}</p><a className="mt-2 inline-block font-medium text-primary underline" href="https://github.com/AnxForever/DeepTutor/blob/teacher-diagnostics/docs-for-dev/STUDENT_TASKS.md" target="_blank" rel="noopener noreferrer">{t('caseTaskReviews.setup')}</a></InlineAlert>}
      <Button className="mt-3" size="sm" variant="secondary" disabled={disabled || writer.posting} onClick={requestRefresh}>{t('caseTaskReviews.refresh')}</Button>
      {loading && <p role="status" className="mt-3 text-sm">{t('caseTaskReviews.loading')}</p>}{readError && <InlineAlert className="mt-3" tone="warning" action={<Button size="sm" variant="secondary" onClick={() => setNonce(value => value + 1)}>{t('caseTaskReviews.retry')}</Button>}>{t('caseTaskReviews.loadFailed')}</InlineAlert>}
      {stale && <InlineAlert className="mt-3" tone="warning" action={onReloadCase && <Button size="sm" variant="secondary" disabled={disabled || writer.posting} onClick={onReloadCase}>{t('caseTaskReviews.reloadCase')}</Button>}>{t('caseTaskReviews.staleDraft')}</InlineAlert>}
      {view && <><p className="mt-4 break-all text-xs text-muted-foreground">{t(view.overlay?.recipient_user_id ? 'caseTaskReviews.boundUid' : 'caseTaskReviews.unbound', { id: view.overlay?.recipient_user_id })}</p>{view.case_archived && <InlineAlert className="mt-3">{t('caseTaskReviews.archived')}</InlineAlert>}
        <section className="mt-5 rounded-xl border border-border p-3" aria-label={t('caseTaskReviews.focusTitle')}><h4 className="text-sm font-semibold">{t('caseTaskReviews.focusTitle')}</h4><p className="mt-2 text-xs leading-5 text-muted-foreground">{t('caseTaskReviews.focusHint')}</p>{view.focus_cards.length > 0 && <div className="mt-3 max-w-full overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr className="border-b border-border">{['focusPoint','focusQuestions','needsTeaching','independentCheck','ungraded','independentCorrect','requestedHelp'].map(key => <th key={key} scope="col" className="px-2 py-3 font-medium">{t(`caseTaskReviews.${key}`)}</th>)}</tr></thead><tbody>{view.focus_cards.map((focus, index) => <tr key={index} className="border-b border-border/60"><th scope="row" className="px-2 py-3 font-medium">{focus.subject || t('teaching.notProvided')} · {focus.knowledge_point || t('teaching.notProvided')}</th>{[focus.question_count,focus.needs_teaching,focus.needs_independent_check,focus.ungraded,focus.independent_correct,focus.requested_help].map((count, column) => <td key={column} className="px-2 py-3 text-center tabular-nums">{count}</td>)}</tr>)}</tbody></table></div>}<p className="mt-3 text-xs leading-5 text-muted-foreground">{t('caseTaskReviews.helpHint')}</p></section>
        {!view.overlay?.links.length && <p className="mt-4 text-sm text-muted-foreground">{t('caseTaskReviews.empty')}</p>}
        <div className="mt-5 grid gap-4">{view.overlay?.links.map(link => {
          const source = view.source_states.find(value => value.task_id === link.task_id && value.submission_id === link.submission_id && value.review_revision === link.review_revision)
          const removed = Boolean(draft.mutation && !draft.mutation.payload.links.some(value => value.submission_id === link.submission_id))
          return <article key={link.submission_id} className="min-w-0 rounded-xl border border-border p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold">{source?.subject || t('teaching.notProvided')} · {source?.knowledge_point || t('teaching.notProvided')}</h4><StatusChip tone={source?.status === 'current' ? 'neutral' : 'warning'}>{t(`caseTaskReviews.source.${source?.status ?? 'unavailable'}`)}</StatusChip></div><p className="mt-2 break-all text-xs text-muted-foreground">{link.task_id} · {link.submission_id} · {t('caseTaskReviews.reviewVersion', { n: link.review_revision })}</p>{source?.recipient_user_id && <p className="mt-2 break-all text-xs">{t('caseTaskReviews.learnerUid', { id: source.recipient_user_id })}</p>}{source?.report_revision && <p className="mt-2 text-xs text-muted-foreground">{t('caseTaskReviews.reportVersion', { n: source.report_revision })} · {source.report_id}</p>}{source?.latest_review_revision && source.latest_review_revision !== link.review_revision && <p className="mt-2 text-xs text-muted-foreground">{t('caseTaskReviews.newer', { pinned: link.review_revision, latest: source.latest_review_revision })}</p>}{source?.recorded_at != null && <p className="mt-2 text-xs text-muted-foreground">{source.reviewer_user_id} · {new Date(source.recorded_at * 1000).toLocaleString(i18n.language)}</p>}{source?.status !== 'current' && <InlineAlert className="mt-3" tone="warning">{t('caseTaskReviews.excluded')}</InlineAlert>}
            <details className="mt-3"><summary className="cursor-pointer text-sm font-medium">{t('caseTaskReviews.openReview')}</summary><EvidenceQuestions source={source} /></details>
            {link.teacher_observation && <div className="mt-3"><p className="text-xs text-muted-foreground">{t('caseTaskReviews.observation')}</p><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{link.teacher_observation}</p></div>}{link.next_teaching_action && <div className="mt-3"><p className="text-xs text-muted-foreground">{t('caseTaskReviews.nextAction')}</p><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{link.next_teaching_action}</p></div>}
            <Link className="mt-3 inline-block text-xs font-medium text-primary underline" href={scopedUrl(`/learning/teaching-analysis/student-tasks/${encodeURIComponent(link.task_id)}/review`, workspaceId)}>{t('caseTaskReviews.openReview')}</Link><label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 accent-primary" checked={removed} disabled={!canWrite || disabled || writer.posting || writer.acknowledged || stale || loading} onChange={event => toggleRemoval(link.submission_id, event.target.checked)} />{t('caseTaskReviews.remove')}</label>
          </article>
        })}</div>
      </>}
      {dirty && <><label className="mt-4 flex items-start gap-2 text-sm leading-6"><input type="checkbox" className="mt-1 accent-primary" checked={draft.identity_checked} disabled={!canWrite || disabled || writer.posting || writer.acknowledged || stale || loading} onChange={event => setDraft(value => ({ ...value, identity_checked: event.target.checked }))} />{t('caseTaskReviews.removalCheck')}</label><div className="mt-4 flex flex-wrap gap-2">{canWrite && <Button size="sm" loading={writer.posting} disabled={disabled || writer.posting || writer.acknowledged || stale || loading || !draft.identity_checked} onClick={() => void writer.submit()}>{t('caseTaskReviews.saveRemovals')}</Button>}{canWrite && draft.mutation?.submitted_payload && !writer.acknowledged && <Button size="sm" variant="secondary" disabled={disabled || writer.posting || (!staleBase && !deletionOnly)} onClick={() => void writer.submit()}>{t('caseTaskReviews.retrySame')}</Button>}<Button size="sm" variant="ghost" disabled={writer.posting} onClick={() => void clear(false)}>{t('caseTaskReviews.clearDraft')}</Button></div></>}
      {writer.error && <InlineAlert className="mt-3" tone="warning">{t('caseTaskReviews.saveFailed')}</InlineAlert>}{(notice || writer.acknowledged) && <InlineAlert className="mt-3" tone="success">{t('caseTaskReviews.saved')}</InlineAlert>}{writer.acknowledged && writer.cleanupError && <InlineAlert className="mt-3" tone="warning" action={<Button size="sm" onClick={writer.retryCleanup}>{t('caseTaskReviews.retryCleanup')}</Button>}>{t('caseTaskReviews.cleanupFailed')}</InlineAlert>}{clearError && <InlineAlert className="mt-3" tone="warning">{t('caseTaskReviews.clearFailed')}</InlineAlert>}
      {writer.posting && <Button className="mt-3" size="sm" variant="secondary" onClick={writer.stopWaiting}>{t('caseTaskReviews.stopRequest')}</Button>}
      <Dialog open={confirmation} title={t('caseTaskReviews.replaceTitle')} closeLabel={t('Close')} onClose={() => setConfirmation(false)} footer={<><Button variant="secondary" onClick={() => setConfirmation(false)}>{t('Cancel')}</Button><Button onClick={() => void clear(true)}>{t('caseTaskReviews.discard')}</Button></>}><p className="text-sm leading-6">{t('caseTaskReviews.replaceHint')}</p></Dialog>
    </div>}
  </details>
}
