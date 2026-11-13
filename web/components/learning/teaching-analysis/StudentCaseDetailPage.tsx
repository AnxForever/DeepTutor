'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, Download, Users } from 'lucide-react'
import { Button, Dialog, InlineAlert, StatusChip } from '@/shared/ui'
import { isApiError } from '@/shared/api/errors'
import { scopedUrl } from '@/lib/workspace-scope'
import { TEACHING_ANALYSIS_HOME } from '@/lib/teaching-analysis-api'
import { getStudentCase, saveStudentCase, STUDENT_CASES_HOME, type SavedStudentCase, type StudentCaseSourceState, type SaveStudentCaseRequest } from '@/lib/teaching-student-cases-api'
import { editorForStudentCase, isStudentCaseDraft, studentCaseEditorSlot, type StudentCaseDraft } from '@/lib/teaching-student-case-drafts'
import { LearningShell, LearningSkeleton } from '../LearningShell'
import { StudentCaseAccess } from './StudentCaseAccess'
import { StudentCaseFields } from './StudentCaseFields'
import { StudentCaseHistory } from './StudentCaseHistory'
import { StudentCaseReportPicker } from './StudentCaseReportPicker'
import { StudentEvidenceTimeline } from './StudentEvidenceTimeline'
import { useTeachingDraftSlot } from './TeachingDrafts'

export default function StudentCaseDetailPage({ caseId }: { caseId: string }) {
  return <StudentCaseAccess caseId={caseId}>{workspaceId => <StudentCaseDetail key={`${workspaceId}:${caseId}`} caseId={caseId} workspaceId={workspaceId} />}</StudentCaseAccess>
}

function StudentCaseDetail({ caseId, workspaceId }: { caseId: string; workspaceId: string }) {
  const { t } = useTranslation()
  const [saved, setSaved] = useState<SavedStudentCase | null>(null)
  const [editor, setEditor] = useState<SaveStudentCaseRequest>(() => ({ case_id: caseId, expected_revision: 0, label: '', subject: null, archived: false, report_refs: [] }))
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState(false)
  const [reloadConfirmation, setReloadConfirmation] = useState(false)
  const [archiveConfirmation, setArchiveConfirmation] = useState<boolean | null>(null)
  const [sourceStates, setSourceStates] = useState<StudentCaseSourceState[]>([])
  const restoredOrEdited = useRef(false)
  const readController = useRef<AbortController | null>(null)
  const writeController = useRef<AbortController | null>(null)
  const readSequence = useRef(0)
  const alive = useRef(true)
  const snapshot = useMemo<StudentCaseDraft>(() => ({ kind: 'student-case-editor', version: 1, editor }), [editor])
  const { clear: clearLocalDraft } = useTeachingDraftSlot({ slot: studentCaseEditorSlot(caseId), value: snapshot, dirty, validate: (value): value is StudentCaseDraft => isStudentCaseDraft(value) && value.editor.case_id === caseId, onRestore: value => { restoredOrEdited.current = true; setEditor(value.editor); setDirty(true); setNotice('') } })
  const staleCase = conflict || Boolean(saved && editor.expected_revision !== saved.revision)
  const disabled = loading || saving
  const archivedReadOnly = Boolean(saved?.archived)

  useEffect(() => { alive.current = true; return () => { alive.current = false; readController.current?.abort(); writeController.current?.abort() } }, [])
  const load = useCallback(async (replace: boolean) => {
    readController.current?.abort()
    const controller = new AbortController(); readController.current = controller
    const sequence = ++readSequence.current
    setLoading(true); setError('')
    try {
      const value = await getStudentCase(caseId, workspaceId, controller.signal)
      if (controller.signal.aborted || !alive.current || sequence !== readSequence.current) return
      if (replace) await clearLocalDraft()
      if (controller.signal.aborted || !alive.current || sequence !== readSequence.current) return
      setSaved(value); setSourceStates([])
      if (replace || !restoredOrEdited.current) {
        restoredOrEdited.current = false; setEditor(editorForStudentCase(value)); setDirty(false); setConflict(false); setNotice('')
      }
      setReloadConfirmation(false)
    } catch (reason) {
      if (!controller.signal.aborted && alive.current) setError(t(isApiError(reason) && reason.status === 404 ? 'teaching.cases.notFound' : 'teaching.cases.loadFailed'))
    } finally { if (!controller.signal.aborted && alive.current && sequence === readSequence.current) setLoading(false) }
  }, [caseId, workspaceId, clearLocalDraft, t])
  useEffect(() => { void load(false); return () => readController.current?.abort() }, [load])
  function update(value: SaveStudentCaseRequest) { restoredOrEdited.current = true; setEditor(value); setDirty(true); setNotice('') }
  function requestReload() { if (dirty) setReloadConfirmation(true); else void load(true) }

  async function save(archive?: boolean) {
    if (writeController.current || !saved || staleCase) return
    if (!editor.label.trim() || Array.from(editor.label).length > 200) { setError(t('teaching.cases.required')); return }
    const payload = archive === undefined ? editor : { ...editor, archived: archive }
    const controller = new AbortController(); writeController.current = controller
    readController.current?.abort(); readSequence.current++
    setSaving(true); setError(''); setNotice('')
    try {
      const value = await saveStudentCase(payload, workspaceId, controller.signal)
      if (controller.signal.aborted || !alive.current) return
      restoredOrEdited.current = false; setSaved(value); setEditor(editorForStudentCase(value)); setDirty(false); setConflict(false); setSourceStates([]); setArchiveConfirmation(null)
      setNotice(t('teaching.cases.saved', { n: value.revision }))
      try { await clearLocalDraft() } catch { if (alive.current) setError(t('teaching.cases.savedLocalPending')) }
    } catch (reason) {
      if (!controller.signal.aborted && alive.current) {
        setArchiveConfirmation(null)
        const sourceConflict = isApiError(reason) && reason.code === 'teaching_case_source_changed'
        if (isApiError(reason) && reason.status === 409 && !sourceConflict) setConflict(true)
        setError(t(sourceConflict ? 'teaching.cases.sourceConflict' : 'teaching.cases.saveFailed'))
      }
    } finally { if (writeController.current === controller) writeController.current = null; if (!controller.signal.aborted && alive.current) setSaving(false) }
  }
  function exportDraft() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = `student-case-${caseId}.json`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return <LearningShell back={false} title={saved?.label || editor.label || t('teaching.cases.metadata')} subtitle={t('teaching.cases.detailSubtitle')} icon={Users} action={<div className="flex flex-wrap gap-2"><Link className="inline-flex min-h-8 items-center rounded-lg border border-border px-3 text-xs hover:bg-muted" href={scopedUrl(STUDENT_CASES_HOME, workspaceId)}>{t('teaching.cases.title')}</Link><Link className="inline-flex min-h-8 items-center rounded-lg border border-border px-3 text-xs hover:bg-muted" href={scopedUrl(TEACHING_ANALYSIS_HOME, workspaceId)}>{t('teaching.cases.workbench')}</Link></div>}>
    <div className="mb-5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{t('teaching.cases.code', { id: caseId.slice(0, 8) })}</span>{saved && <StatusChip>{t('teaching.revision', { n: saved.revision })}</StatusChip>}{saved?.archived && <StatusChip>{t('teaching.cases.archived')}</StatusChip>}{dirty && <StatusChip tone="warning">{t('teaching.cases.unsaved')}</StatusChip>}</div>
    {error && <InlineAlert tone="danger" className="mb-4" action={!saved ? <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void load(false)}>{t('Retry')}</Button> : undefined}>{error}</InlineAlert>}
    {notice && <InlineAlert className="mb-4">{notice}</InlineAlert>}
    {archivedReadOnly && <InlineAlert className="mb-4">{t('teaching.cases.archivedReadonly')}</InlineAlert>}
    {staleCase && <InlineAlert tone="warning" className="mb-4" action={<Button variant="secondary" size="sm" disabled={disabled} onClick={requestReload}>{t('teaching.cases.reload')}</Button>}>{t('teaching.cases.conflict')}</InlineAlert>}
    {!saved && !dirty ? (loading ? <LearningSkeleton count={2} /> : null) : <>
      <section aria-label={t('teaching.cases.metadata')} className="rounded-xl border border-border bg-card p-4 sm:p-5"><StudentCaseFields value={editor} disabled={disabled || archivedReadOnly} onChange={update} /></section>
      <StudentCaseReportPicker workspaceId={workspaceId} reportRefs={editor.report_refs} sourceStates={sourceStates} disabled={disabled || archivedReadOnly} onChange={report_refs => update({ ...editor, report_refs })} />
      <div className="mt-5 flex flex-wrap gap-2"><Button loading={saving} disabled={disabled || archivedReadOnly || !saved || staleCase || !dirty} onClick={() => void save()}>{t('teaching.cases.save')}</Button><Button size="sm" variant="ghost" icon={<Download size={14} />} onClick={exportDraft}>{t('teaching.cases.export')}</Button>{saved && <Button size="sm" variant="secondary" icon={<Archive size={14} />} disabled={disabled || staleCase} onClick={() => setArchiveConfirmation(!saved.archived)}>{t(saved.archived ? 'teaching.cases.unarchive' : 'teaching.cases.archive')}</Button>}</div>
    </>}
    {saved && <>
      <StudentCaseHistory caseId={caseId} revision={saved.revision} workspaceId={workspaceId} />
      {dirty && <p className="mt-6 text-xs text-muted-foreground">{t('teaching.cases.savedLinksOnly')}</p>}
      <StudentEvidenceTimeline key={`${workspaceId}:${caseId}:${saved.revision}`} caseId={caseId} workspaceId={workspaceId} refreshKey={saved.revision} onSourceStates={setSourceStates} onReloadCase={requestReload} />
    </>}
    <Dialog open={reloadConfirmation} onClose={() => setReloadConfirmation(false)} title={t('teaching.cases.replaceTitle')} closeLabel={t('Close')} busy={loading} footer={<><Button size="sm" variant="secondary" disabled={loading} onClick={() => setReloadConfirmation(false)}>{t('Cancel')}</Button><Button size="sm" loading={loading} onClick={() => void load(true)}>{t('teaching.cases.replaceConfirm')}</Button></>}><p className="text-sm text-muted-foreground">{t('teaching.cases.replaceHint')}</p></Dialog>
    <Dialog open={archiveConfirmation !== null} onClose={() => setArchiveConfirmation(null)} title={t(archiveConfirmation ? 'teaching.cases.archiveTitle' : 'teaching.cases.unarchiveTitle')} closeLabel={t('Close')} busy={saving} footer={<><Button size="sm" variant="secondary" disabled={saving} onClick={() => setArchiveConfirmation(null)}>{t('Cancel')}</Button><Button size="sm" loading={saving} disabled={staleCase || loading} onClick={() => void save(archiveConfirmation ?? undefined)}>{t(archiveConfirmation ? 'teaching.cases.saveArchive' : 'teaching.cases.saveUnarchive')}</Button></>}><p className="text-sm text-muted-foreground">{t(archiveConfirmation ? 'teaching.cases.archiveHint' : 'teaching.cases.unarchiveHint')}</p></Dialog>
  </LearningShell>
}
