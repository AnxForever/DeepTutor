'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useTranslation } from 'react-i18next'
import { ClipboardCheck, Download, FileUp, History, Plus, Sparkles } from 'lucide-react'
import { Button, Dialog, Field, InlineAlert, StatusChip } from '@/shared/ui'
import { isApiError } from '@/shared/api/errors'
import { useAuthStatus } from '@/hooks/useAuthStatus'
import { useActiveWorkspaceId } from '@/hooks/useActiveWorkspaceId'
import { scopedUrl } from '@/lib/workspace-scope'
import {
  analyzeTeachingAssignment, getTeachingReport, getTeachingReportRevisions,
  listTeachingReports, previewTeachingAssignment, saveTeachingReport,
  type AssignmentInput, type ReportContent, type SavedTeachingReport,
  type TeachingReportSummary,
} from '@/lib/teaching-analysis-api'
import { LearningShell, LearningSkeleton } from '../LearningShell'
import { AssignmentEditor, controlClass } from './AssignmentEditor'
import { AnalysisReport, reportMarkdown } from './AnalysisReport'
import { assignmentCsvTemplate, emptyAssignment, exampleAssignment } from './sample'
import { ReportHistory } from './ReportHistory'
import { RubricLibrary } from './RubricLibrary'
import { PracticeFollowups } from './PracticeFollowups'
import { TeachingDraftProvider, useTeachingDraftControls, useTeachingDraftSlot } from './TeachingDrafts'
import { isPrimaryTeachingDraft, type PrimaryTeachingDraft } from '@/lib/teaching-draft-validation'
import { DocumentImportPanel } from './DocumentImportPanel'
import { STUDENT_CASES_HOME } from '@/lib/teaching-student-cases-api'

type Operation = 'import' | 'analyze' | 'save' | 'load' | 'history'
type Replacement = { kind: 'new' | 'example' } | { kind: 'load'; id: string } | { kind: 'import'; file: File; fromPaste?: boolean } | { kind: 'document'; assignment: AssignmentInput }

function textSize(value: unknown): number {
  if (typeof value === 'string') return Array.from(value).length
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + textSize(item), 0)
  if (value && typeof value === 'object') return Object.values(value).reduce<number>((sum, item) => sum + textSize(item), 0)
  return 0
}

/** Object key order is not a change to a restored source snapshot. */
function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameJsonValue(value, right[index]))
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameJsonValue(a[key], b[key]))
}
const normalizedDraftAssignment = (value: AssignmentInput): AssignmentInput => ({ ...value, rubric_template: value.rubric_template ?? null, document_provenance: value.document_provenance ?? null })

function validationKey(assignment: AssignmentInput): string | null {
  if (!assignment.student_ref.trim() || !assignment.assignment_ref.trim() || !assignment.subject.trim()) return 'teaching.requiredScope'
  if (assignment.items.length > 40) return 'teaching.itemLimit'
  if (assignment.items.some(item => !item.question_id.trim() || !item.question.trim())) return 'teaching.requiredItems'
  if (new Set(assignment.items.map(item => item.question_id.trim())).size !== assignment.items.length) return 'teaching.duplicateIds'
  if (textSize(assignment) > 60000) return 'teaching.textLimit'
  return null
}

export default function TeachingAnalysisPage() {
  const auth = useAuthStatus()
  const workspaceId = useActiveWorkspaceId()
  const { t } = useTranslation()
  if (auth.loading) return <LearningShell title={t('teaching.title')} subtitle={t('teaching.subtitle')}><LearningSkeleton count={2} /></LearningShell>
  const identityUnavailable = !auth.statusAvailable || (auth.enabled && !auth.userId)
  if (identityUnavailable || (auth.enabled && !auth.isAdmin)) return (
    <LearningShell title={t('teaching.title')} subtitle={t('teaching.subtitle')} icon={ClipboardCheck}>
      <InlineAlert tone="warning">{t(identityUnavailable ? 'teaching.accessUnavailable' : 'teaching.adminOnly')}</InlineAlert>
    </LearningShell>
  )
  return <TeachingDraftProvider key={`${auth.userId ?? 'local'}:${workspaceId}`} accountId={auth.userId ?? 'local-admin'} workspaceId={workspaceId}><TeachingAnalysisWorkspace workspaceId={workspaceId} /></TeachingDraftProvider>
}

function TeachingAnalysisWorkspace({ workspaceId }: { workspaceId: string }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language.startsWith('zh') ? 'zh' : 'en'
  const [assignment, setAssignment] = useState<AssignmentInput>(emptyAssignment)
  const [analysis, setAnalysis] = useState<ReportContent | null>(null)
  const [fingerprint, setFingerprint] = useState('')
  const [reportId, setReportId] = useState<string>(() => crypto.randomUUID())
  const [saved, setSaved] = useState<SavedTeachingReport | null>(null)
  const [status, setStatus] = useState<'draft' | 'confirmed'>('draft')
  const [teacherNotes, setTeacherNotes] = useState('')
  const [editing, setEditing] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [rubricDirty, setRubricDirty] = useState(false)
  const [followupDirty, setFollowupDirty] = useState(false)
  const [documentDirty, setDocumentDirty] = useState(false)
  const [childEpoch, setChildEpoch] = useState(0)
  const [invalidated, setInvalidated] = useState(false)
  const [busy, setBusy] = useState<Operation | null>(null)
  const [error, setError] = useState('')
  const [needsModel, setNeedsModel] = useState(false)
  const [needsRubric, setNeedsRubric] = useState(false)
  const [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState(false)
  const [pasted, setPasted] = useState('')
  const [reports, setReports] = useState<TeachingReportSummary[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState(false)
  const [listRevision, setListRevision] = useState(0)
  const [history, setHistory] = useState<SavedTeachingReport[] | null>(null)
  const [replacement, setReplacement] = useState<Replacement | null>(null)
  const [reportScroll, setReportScroll] = useState(0)
  const [restoredBase, setRestoredBase] = useState(false)
  const [baseVerified, setBaseVerified] = useState(false)
  const [baseCheckFailed, setBaseCheckFailed] = useState(false)
  const [baseCheckAttempt, setBaseCheckAttempt] = useState(0)
  const controllerRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const fileRef = useRef<HTMLInputElement>(null)
  const draftControls = useTeachingDraftControls()
  const primary = useMemo<PrimaryTeachingDraft>(() => ({ kind: 'teaching-primary', version: 1, assignment, analysis, fingerprint, reportId, saved, baseRevision: saved?.revision ?? 0, teacherNotes, pasted, editing, primaryDirty: dirty }), [assignment, analysis, fingerprint, reportId, saved, teacherNotes, pasted, editing, dirty])
  const latestEditing = useRef({ assignment, analysis, teacherNotes, dirty })
  useLayoutEffect(() => { latestEditing.current = { assignment, analysis, teacherNotes, dirty } }, [assignment, analysis, teacherNotes, dirty])
  const primaryDraft = useTeachingDraftSlot({ slot: 'primary', value: primary, dirty: dirty || Boolean(pasted.trim()) || followupDirty || documentDirty, validate: isPrimaryTeachingDraft, onRestore: value => {
    setAssignment(normalizedDraftAssignment(value.assignment)); setAnalysis(value.analysis); setFingerprint(value.fingerprint); setReportId(value.reportId); setSaved(value.saved ? { ...value.saved, assignment: normalizedDraftAssignment(value.saved.assignment) } : null)
    setTeacherNotes(value.teacherNotes); setPasted(value.pasted); setEditing(value.editing); setStatus(value.primaryDirty === false ? (value.saved?.status ?? 'draft') : 'draft'); setDirty(value.primaryDirty !== false); setConflict(false); setInvalidated(false); setRestoredBase(Boolean(value.saved)); setBaseVerified(false); setBaseCheckFailed(false)
  } })
  const verificationId = restoredBase ? saved?.report_id : undefined
  const verificationRevision = saved?.revision
  const verificationFingerprint = saved?.source_fingerprint
  useEffect(() => {
    if (!verificationId) return
    const controller = new AbortController()
    void getTeachingReport(verificationId, workspaceId, controller.signal).then(current => {
      if (controller.signal.aborted) return
      if (current.revision !== verificationRevision || current.source_fingerprint !== verificationFingerprint) { setConflict(true); setBaseVerified(false); setRestoredBase(false); setStatus('draft'); setBaseCheckFailed(false); return }
      const latest = latestEditing.current
      setSaved(current); setBaseVerified(true); setRestoredBase(false); setBaseCheckFailed(false)
      if (!latest.dirty && (!sameJsonValue(latest.assignment, current.assignment) || !sameJsonValue(latest.analysis, current.analysis) || latest.teacherNotes !== current.teacher_notes)) { setDirty(true); setStatus('draft') }
      else if (!latest.dirty) setStatus(current.status)
    }).catch(() => { if (!controller.signal.aborted) { setBaseVerified(false); setBaseCheckFailed(true) } })
    return () => controller.abort()
  }, [verificationId, verificationRevision, verificationFingerprint, workspaceId, baseCheckAttempt])

  const serverConflict = Boolean(dirty && saved && reports.some(row => row.report_id === saved.report_id && row.revision > saved.revision))

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      controllerRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void listTeachingReports(workspaceId, controller.signal).then(result => {
      if (controller.signal.aborted) return
      setReports(result)
      setListError(false)
    }).catch(() => {
      if (!controller.signal.aborted) setListError(true)
    }).finally(() => {
      if (!controller.signal.aborted) setListLoading(false)
    })
    return () => controller.abort()
  }, [workspaceId, listRevision])

  useEffect(() => {
    if (!dirty && !rubricDirty && !followupDirty && !documentDirty && !pasted.trim()) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, rubricDirty, followupDirty, documentDirty, pasted])

  useEffect(() => {
    if (!reportScroll) return
    const frame = requestAnimationFrame(() => {
      const title = document.getElementById('teaching-report-title')
      title?.scrollIntoView?.({ block: 'start' })
      title?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [reportScroll])

  function begin(operation: Operation): AbortController | null {
    if (controllerRef.current) return null
    const controller = new AbortController()
    controllerRef.current = controller
    setBusy(operation)
    setError('')
    setNeedsModel(false)
    setNeedsRubric(false)
    setNotice('')
    return controller
  }
  function finish(controller: AbortController) {
    if (controllerRef.current === controller) controllerRef.current = null
    if (mountedRef.current && !controller.signal.aborted) setBusy(null)
  }
  function fail(reason: unknown, controller: AbortController) {
    if (!mountedRef.current || controller.signal.aborted) return
    if (isApiError(reason) && reason.code === 'teaching_model_not_configured') {
      setNeedsModel(true)
      setError(t('teaching.modelNotConfigured'))
      return
    }
    if (isApiError(reason) && reason.code === 'teaching_rubric_unavailable') {
      setNeedsRubric(true)
      setError(t('teaching.rubric.unavailable'))
      return
    }
    if (isApiError(reason) && reason.code === 'teaching_document_source_invalid') { setError(t('teaching.documentSource.invalid')); return }
    setError(reason instanceof Error ? reason.message : t('teaching.requestFailed'))
  }
  function updateAssignment(value: AssignmentInput) {
    if (JSON.stringify(value) === JSON.stringify(assignment)) return
    setAssignment(value)
    if (analysis) setInvalidated(true)
    setAnalysis(null)
    setFingerprint('')
    setStatus('draft')
    setDirty(true)
    setHistory(null)
    setNotice('')
    setError('')
  }
  function updateReport(value: ReportContent) {
    setAnalysis(value)
    setStatus('draft')
    setDirty(true)
    setNotice('')
  }
  function reset(value: AssignmentInput, synthetic = false) {
    setChildEpoch(current => current + 1)
    setAssignment(value)
    setAnalysis(null)
    setFingerprint('')
    setSaved(null)
    setReportId(crypto.randomUUID())
    setStatus('draft')
    setTeacherNotes('')
    setEditing(false)
    setDirty(synthetic)
    setInvalidated(false)
    setConflict(false)
    setHistory(null)
    setPasted('')
    setNotice(synthetic ? t('teaching.syntheticNotice') : '')
    setError('')
    setBaseVerified(false); setRestoredBase(false); setBaseCheckFailed(false)
  }
  function applySaved(value: SavedTeachingReport) {
    setAssignment(value.assignment)
    setAnalysis(value.analysis)
    setFingerprint(value.source_fingerprint)
    setSaved(value)
    setReportId(value.report_id)
    setStatus(value.status)
    setTeacherNotes(value.teacher_notes)
    setEditing(false)
    setDirty(false)
    setInvalidated(false)
    setConflict(false)
    setHistory(null)
    setNotice('')
    setBaseVerified(true); setRestoredBase(false); setBaseCheckFailed(false)
  }
  async function importFile(file: File) {
    const controller = begin('import')
    if (!controller) return
    try {
      const value = await previewTeachingAssignment(file, workspaceId, controller.signal)
      if (!controller.signal.aborted && mountedRef.current) {
        await draftControls.clearAll()
        reset(value)
        setDirty(true)
        setNotice(t('teaching.previewReady'))
      }
    } catch (reason) { fail(reason, controller) } finally { finish(controller) }
  }
  async function loadReport(id: string) {
    const controller = begin('load')
    if (!controller) return
    try {
      const value = await getTeachingReport(id, workspaceId, controller.signal)
      if (!controller.signal.aborted && mountedRef.current) {
        await draftControls.clearAll()
        setChildEpoch(current => current + 1)
        applySaved(value)
      }
    } catch (reason) { fail(reason, controller) } finally { finish(controller) }
  }
  async function performReplacement(value: Replacement) {
    setReplacement(null)
    if (value.kind === 'new' || value.kind === 'example' || value.kind === 'document') {
      const controller = begin('load')
      if (!controller) return
      try {
        await draftControls.clearAll()
        if (!controller.signal.aborted && mountedRef.current) {
          if (value.kind === 'document') {
            reset({ ...value.assignment, student_ref: assignment.student_ref, assignment_ref: assignment.assignment_ref || value.assignment.document_provenance?.filename || value.assignment.assignment_ref, subject: assignment.subject, grade: assignment.grade, teacher_context: assignment.teacher_context, rubric_template: assignment.rubric_template })
            setDirty(true); setNotice(t('teaching.documents.applied'))
          } else reset(value.kind === 'new' ? emptyAssignment() : exampleAssignment(language), value.kind === 'example')
        }
      } catch { setError(t('teaching.drafts.failed')) } finally { finish(controller) }
    }
    else if (value.kind === 'import') void importFile(value.file)
    else if (value.kind === 'load') void loadReport(value.id)
  }
  function requestReplacement(value: Replacement) {
    if (dirty || rubricDirty || followupDirty || (documentDirty && value.kind !== 'document') || (pasted.trim() && !(value.kind === 'import' && value.fromPaste))) setReplacement(value)
    else void performReplacement(value)
  }
  async function generate() {
    const invalid = validationKey(assignment)
    if (invalid) { setError(t(invalid)); return }
    const controller = begin('analyze')
    if (!controller) return
    try {
      const value = await analyzeTeachingAssignment(assignment, language, workspaceId, controller.signal)
      if (controller.signal.aborted || !mountedRef.current) return
      setAnalysis(value.analysis)
      setFingerprint(value.source_fingerprint)
      setStatus('draft')
      setEditing(false)
      setDirty(true)
      setInvalidated(false)
      setHistory(null)
      setNotice(t('teaching.generatedNotice'))
      setReportScroll(value => value + 1)
    } catch (reason) { fail(reason, controller) } finally { finish(controller) }
  }
  async function save(nextStatus: 'draft' | 'confirmed') {
    if (!analysis || !fingerprint || conflict || serverConflict || followupDirty) return
    const controller = begin('save')
    if (!controller) return
    try {
      const value = await saveTeachingReport({
        report_id: reportId, expected_revision: saved?.revision ?? 0,
        assignment, analysis, source_fingerprint: fingerprint, status: nextStatus, teacher_notes: teacherNotes,
      }, workspaceId, controller.signal)
      if (controller.signal.aborted || !mountedRef.current) return
      applySaved(value)
      if (!pasted.trim() && !followupDirty && !documentDirty) void primaryDraft.clear().catch(() => {})
      setNotice(t(nextStatus === 'confirmed' ? 'teaching.confirmedSaved' : 'teaching.draftSaved'))
      setListRevision(value => value + 1)
    } catch (reason) {
      if (!controller.signal.aborted && isApiError(reason) && reason.status === 409) setConflict(true)
      fail(reason, controller)
    } finally { finish(controller) }
  }
  async function showHistory() {
    if (!saved) return
    if (history) { setHistory(null); return }
    const controller = begin('history')
    if (!controller) return
    try {
      const value = await getTeachingReportRevisions(saved.report_id, workspaceId, controller.signal)
      if (!controller.signal.aborted && mountedRef.current) setHistory(value)
    } catch (reason) { fail(reason, controller) } finally { finish(controller) }
  }
  function download() {
    if (!analysis) return
    const content = reportMarkdown(assignment, analysis, teacherNotes, {
      title: t('teaching.reportTitle'), status: `${t(`teaching.status.${status}`)}${dirty ? ` · ${t('teaching.unsaved')}` : ''}`,
      source: t('teaching.sourceEvidence'), priorities: t('teaching.priorities'), limitations: t('teaching.limitations'), notes: t('teaching.notes'),
    })
    const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `teaching-report-${assignment.assignment_ref.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0,80) || 'assignment'}.md`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([assignmentCsvTemplate(language)], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'assignment-template.csv'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const disabled = busy !== null
  const sourceDisabled = disabled || followupDirty
  return (
    <LearningShell title={t('teaching.title')} subtitle={t('teaching.subtitle')} icon={ClipboardCheck} action={<div className="flex flex-wrap gap-2"><Link href={scopedUrl(STUDENT_CASES_HOME, workspaceId)} className="inline-flex min-h-8 items-center rounded-lg border border-border px-3 text-xs hover:bg-muted">{t('teaching.cases.open')}</Link><Button size="sm" variant="secondary" icon={<Plus size={14} />} disabled={disabled} onClick={() => requestReplacement({ kind: 'new' })}>{t('teaching.new')}</Button></div>}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground" aria-label={t('teaching.workflow')}>
        <span>1 · {t('teaching.importTitle')}</span><span>2 · {t('teaching.materialTitle')}</span><span>3 · {t('teaching.reportTitle')}</span>
        <span className="ml-auto"><StatusChip tone={status === 'confirmed' && !dirty ? 'success' : 'neutral'}>{t(`teaching.status.${status}`)}</StatusChip>{saved && <span className="ml-2">{t('teaching.revision', { n: saved.revision })}</span>}{dirty && <span className="ml-2">{t('teaching.unsaved')}</span>}</span>
      </div>
      <p className="mb-5 mt-3 text-xs leading-5 text-muted-foreground">{t('teaching.scopeNote')}</p>
      {listError && <InlineAlert tone="warning" className="mb-4" action={<Button variant="ghost" size="sm" onClick={() => setListRevision(x => x + 1)}>{t('Retry')}</Button>}>{t('teaching.listFailed')}</InlineAlert>}
      <details className="mb-5 rounded-xl border border-border px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium">{t('teaching.savedReports', { n: reports.length })}</summary>
        {listLoading ? <p className="mt-3 text-sm text-muted-foreground">{t('Loading…')}</p> : !reports.length ? <p className="mt-3 text-sm text-muted-foreground">{t('teaching.noSavedReports')}</p> : <ul className="mt-3 divide-y divide-border">{reports.map(report => <li key={report.report_id}><button type="button" disabled={disabled} className="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg py-3 text-left text-sm hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50" onClick={() => requestReplacement({ kind: 'load', id: report.report_id })}><span>{report.student_ref} · {report.assignment_ref}</span><span className="text-xs text-muted-foreground">{t(`teaching.status.${report.status}`)} · {t('teaching.revision', { n: report.revision })}</span></button></li>)}</ul>}
      </details>
      <DocumentImportPanel key={`${workspaceId}:${childEpoch}`} workspaceId={workspaceId} disabled={sourceDisabled} onDirtyChange={setDocumentDirty} appliedSignature={assignment.document_provenance?.signature} onApply={value => requestReplacement({ kind: 'document', assignment: value })} />
      <section className="rounded-xl border border-border bg-card p-4 sm:p-5" aria-labelledby="teaching-import-title">
        <h2 id="teaching-import-title" className="text-base font-semibold">{t('teaching.importTitle')}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('teaching.importHint')}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" icon={<FileUp size={15} />} disabled={disabled} onClick={() => fileRef.current?.click()}>{t('teaching.chooseFile')}</Button>
          <Button variant="secondary" size="sm" icon={<Download size={15} />} onClick={downloadTemplate}>{t('teaching.csvTemplate')}</Button>
          <input ref={fileRef} type="file" accept=".json,.csv,.tsv,application/json,text/csv,text/tab-separated-values" className="sr-only" aria-label={t('teaching.chooseFile')} disabled={disabled} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) requestReplacement({ kind: 'import', file }) }} />
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => requestReplacement({ kind: 'example' })}>{t('teaching.loadExample')}</Button>
        </div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{t('teaching.csvTemplateHint')}</p>
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-muted-foreground">{t('teaching.pasteJson')}</summary>
          <Field className="mt-3" label={t('teaching.jsonLabel')}><textarea className={`${controlClass} font-mono text-xs`} rows={6} value={pasted} disabled={disabled} onChange={e => setPasted(e.target.value)} /></Field>
          <Button className="mt-2" variant="secondary" size="sm" disabled={disabled || !pasted.trim()} onClick={() => requestReplacement({ kind: 'import', fromPaste: true, file: new File([pasted], 'assignment.json', { type: 'application/json' }) })}>{t('teaching.previewJson')}</Button>
        </details>
      </section>
      {notice && <InlineAlert className="mt-4">{notice}</InlineAlert>}
      {error && <InlineAlert tone="danger" className="mt-4" action={needsModel ? <Link href={scopedUrl('/settings/llm', workspaceId)} className="text-sm font-medium underline underline-offset-2">{t('teaching.configureModel')}</Link> : needsRubric ? <Button size="sm" variant="secondary" onClick={() => { const library = document.getElementById('teaching-rubric-library'); if (library instanceof HTMLDetailsElement) { library.open = true; library.scrollIntoView?.({ block: 'start' }); library.querySelector<HTMLElement>('summary')?.focus() } }}>{t('teaching.rubric.reselect')}</Button> : undefined}>{error}</InlineAlert>}
      {invalidated && <InlineAlert tone="warning" className="mt-4">{t('teaching.invalidated')}</InlineAlert>}
      {(conflict || serverConflict) && <InlineAlert tone="warning" className="mt-4" action={<Button variant="secondary" size="sm" disabled={disabled} onClick={() => requestReplacement({ kind: 'load', id: reportId })}>{t('teaching.reloadSaved')}</Button>}>{t('teaching.conflict')}</InlineAlert>}
      {followupDirty && <InlineAlert tone="warning" className="mt-4">{t('teaching.followupEditsPending')}</InlineAlert>}
      <AssignmentEditor assignment={assignment} disabled={sourceDisabled} onChange={updateAssignment} afterContext={<RubricLibrary key={childEpoch} workspaceId={workspaceId} subject={assignment.subject} grade={assignment.grade} applied={assignment.rubric_template} disabled={sourceDisabled} onDirtyChange={setRubricDirty} onApply={rubric_template => updateAssignment({ ...assignment, rubric_template })} />} />
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button icon={<Sparkles size={16} />} loading={busy === 'analyze'} disabled={sourceDisabled} onClick={() => void generate()}>{t(analysis ? 'teaching.regenerate' : 'teaching.generate')}</Button>
        <p className="max-w-lg text-xs leading-5 text-muted-foreground">{t('teaching.generateHint')}</p>
      </div>
      {busy && <p role="status" className="mt-3 text-sm text-muted-foreground">{t(`teaching.busy.${busy}`)}</p>}
      {saved?.status === 'confirmed' && dirty && <InlineAlert tone="warning" className="mt-4">{t('teaching.reconfirmation')}</InlineAlert>}
      {analysis && <>
        <AnalysisReport analysis={analysis} assignment={assignment} editing={editing} disabled={disabled} onEdit={() => setEditing(value => !value)} onChange={updateReport} />
        <Field className="mt-6" label={t('teaching.notes')}><textarea className={controlClass} rows={3} disabled={disabled} value={teacherNotes} onChange={e => { setTeacherNotes(e.target.value); setDirty(true); setStatus('draft'); setNotice('') }} /></Field>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" disabled={disabled || conflict || serverConflict || followupDirty || (!dirty && saved !== null)} loading={busy === 'save'} onClick={() => void save('draft')}>{t('teaching.saveDraft')}</Button>
          <Button disabled={disabled || conflict || serverConflict || followupDirty || (!dirty && saved?.status === 'confirmed')} onClick={() => void save('confirmed')}>{t('teaching.confirmSave')}</Button>
          <Button variant="ghost" disabled={disabled} icon={<Download size={15} />} onClick={download}>{t('teaching.download')}</Button>
          {saved && <Button variant="ghost" disabled={disabled} icon={<History size={15} />} onClick={() => void showHistory()}>{t(history ? 'teaching.hideHistory' : 'teaching.history')}</Button>}
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">{t('teaching.confirmHint')}</p>
      </>}
      {restoredBase && !baseCheckFailed && <div role="status" className="mt-4 flex flex-wrap items-center gap-3 text-sm text-muted-foreground"><p>{t('teaching.drafts.checkingBase')}</p><Button size="sm" variant="ghost" onClick={() => setBaseCheckAttempt(value => value + 1)}>{t('teaching.drafts.retryBase')}</Button></div>}
      {baseCheckFailed && <InlineAlert tone="warning" className="mt-4" action={<Button size="sm" variant="secondary" onClick={() => { setBaseCheckFailed(false); setBaseCheckAttempt(value => value + 1) }}>{t('teaching.drafts.retryBase')}</Button>}>{t('teaching.drafts.baseUnavailable')}</InlineAlert>}
      {saved && <PracticeFollowups key={`${workspaceId}:${saved.report_id}:${saved.revision}:${childEpoch}`} report={saved} workspaceId={workspaceId} canCreate={baseVerified && saved.status === 'confirmed' && sameJsonValue(assignment, saved.assignment)} onDirtyChange={setFollowupDirty} onReloadReport={() => requestReplacement({ kind: 'load', id: saved.report_id })} />}
      {history && <ReportHistory versions={history} />}
      <Dialog open={replacement !== null} onClose={() => setReplacement(null)} title={t('teaching.replaceTitle')} footer={<><Button variant="secondary" onClick={() => setReplacement(null)}>{t('Cancel')}</Button><Button onClick={() => { if (replacement) performReplacement(replacement) }}>{t('teaching.replaceConfirm')}</Button></>}>
        <p className="text-sm leading-6 text-muted-foreground">{t(replacement?.kind === 'document' ? 'teaching.documents.replaceAssignmentHint' : 'teaching.replaceHint')}</p>
      </Dialog>
    </LearningShell>
  )
}
