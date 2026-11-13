'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BookCheck, History, Plus } from 'lucide-react'
import { Button, Dialog, Field, InlineAlert, StatusChip } from '@/shared/ui'
import { isApiError } from '@/shared/api/errors'
import {
  listTeachingRubrics, listTeachingRubricRevisions, rubricSnapshot, saveTeachingRubric,
  type RubricSnapshot, type RubricTemplate, type SaveRubricRequest,
} from '@/lib/teaching-rubrics-api'
import { controlClass } from './AssignmentEditor'
import { RubricSnapshotView } from './RubricSnapshotView'
import { useTeachingDraftSlot } from './TeachingDrafts'
import { draftObject, draftText, draftUuid } from '@/lib/teaching-draft-validation'

type RubricEditorDraft = { kind: 'rubric-editor'; version: 1; editor: SaveRubricRequest }
function validRubricDraft(value: unknown): value is RubricEditorDraft {
  if (!draftObject(value) || value.kind !== 'rubric-editor' || value.version !== 1 || !draftObject(value.editor)) return false
  const editor = value.editor
  return draftUuid(editor.template_id) && Number.isSafeInteger(editor.expected_revision) && Number(editor.expected_revision) >= 0 && draftText(editor.name, 200) && draftText(editor.subject, 200) && draftText(editor.grade, 200) && draftText(editor.criteria, 6000)
}

export interface RubricLibraryProps {
  workspaceId: string
  subject: string
  grade: string
  applied: RubricSnapshot | null
  disabled: boolean
  onApply: (snapshot: RubricSnapshot | null) => void
  onDirtyChange?: (dirty: boolean) => void
}

function newTemplate(subject: string, grade: string): SaveRubricRequest {
  return { template_id: crypto.randomUUID(), expected_revision: 0, name: '', subject, grade, criteria: '' }
}
const editorFor = (template: RubricSnapshot): SaveRubricRequest => ({
  template_id: template.template_id, expected_revision: template.revision,
  name: template.name, subject: template.subject, grade: template.grade, criteria: template.criteria,
})

/** Library saves and explicit application are independent teacher decisions. */
export function RubricLibrary({ workspaceId, ...props }: RubricLibraryProps) {
  return <ScopedRubricLibrary key={workspaceId} workspaceId={workspaceId} {...props} />
}

function ScopedRubricLibrary({ workspaceId, subject, grade, applied, disabled, onApply, onDirtyChange }: RubricLibraryProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [templates, setTemplates] = useState<RubricTemplate[]>([])
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [editor, setEditor] = useState<SaveRubricRequest>(() => newTemplate(subject, grade))
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<'save' | 'history' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState(false)
  const [history, setHistory] = useState<RubricTemplate[] | null>(null)
  const [replacement, setReplacement] = useState<SaveRubricRequest | null>(null)
  const pending = useRef<AbortController | null>(null)
  const listSequence = useRef(0)
  const alive = useRef(true)
  const localDraft = useMemo<RubricEditorDraft>(() => ({ kind: 'rubric-editor', version: 1, editor }), [editor])
  useTeachingDraftSlot({ slot: 'rubric-editor', value: localDraft, dirty, validate: validRubricDraft, onRestore: value => { setEditor(value.editor); setDirty(true); setExpanded(true); setNotice('') } })

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; pending.current?.abort() }
  }, [])

  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  useEffect(() => {
    if (!expanded) return
    const controller = new AbortController()
    const sequence = ++listSequence.current
    void listTeachingRubrics(workspaceId, controller.signal).then(value => {
      if (controller.signal.aborted || sequence !== listSequence.current) return
      setTemplates(current => {
        const latest = new Map(value.map(template => [template.template_id, template]))
        for (const template of current) {
          if ((latest.get(template.template_id)?.revision ?? 0) < template.revision) latest.set(template.template_id, template)
        }
        return Array.from(latest.values())
      })
      setListError(false)
    }).catch(() => {
      if (!controller.signal.aborted && sequence === listSequence.current) setListError(true)
    }).finally(() => {
      if (!controller.signal.aborted && sequence === listSequence.current) setLoading(false)
    })
    return () => controller.abort()
  }, [expanded, refresh, workspaceId])

  const selected = templates.find(template => template.template_id === editor.template_id)
  const appliedLatest = applied && templates.find(template => template.template_id === applied.template_id)
  const canApplyEditor = selected && selected.revision === editor.expected_revision && !dirty && !conflict
  const controlsDisabled = disabled || busy !== null

  function loadEditor(value: SaveRubricRequest) {
    setEditor(value)
    setDirty(false)
    setConflict(false)
    setError('')
    setNotice('')
    setHistory(null)
    setReplacement(null)
  }
  function replaceEditor(value: SaveRubricRequest) {
    if (dirty) setReplacement(value)
    else loadEditor(value)
  }
  function change(key: 'name' | 'subject' | 'grade' | 'criteria', value: string) {
    setEditor(current => ({ ...current, [key]: value }))
    setDirty(true)
    setNotice('')
  }
  async function save() {
    if (!editor.name.trim() || !editor.criteria.trim()) { setError(t('teaching.rubric.required')); return }
    if (pending.current || conflict) return
    const controller = new AbortController()
    pending.current = controller
    setBusy('save'); setError(''); setNotice('')
    // Invalidate any older library fetch so it cannot roll back a successful save.
    const sequence = ++listSequence.current
    try {
      const value = await saveTeachingRubric(editor, workspaceId, controller.signal)
      if (controller.signal.aborted || !alive.current) return
      setTemplates(current => [value, ...current.filter(row => row.template_id !== value.template_id)])
      setEditor(editorFor(value)); setDirty(false); setConflict(false); setHistory(null)
      setNotice(t('teaching.rubric.saved', { n: value.revision }))
      setRefresh(current => current + 1)
    } catch (reason) {
      if (controller.signal.aborted || !alive.current) return
      if (isApiError(reason) && reason.status === 409) { setConflict(true); setRefresh(value => value + 1) }
      setError(reason instanceof Error ? reason.message : t('teaching.requestFailed'))
    } finally {
      if (pending.current === controller) pending.current = null
      if (alive.current && !controller.signal.aborted) {
        setBusy(null)
        if (sequence === listSequence.current) setLoading(false)
      }
    }
  }
  async function showHistory() {
    if (!selected || pending.current) return
    if (history) { setHistory(null); return }
    const controller = new AbortController()
    pending.current = controller; setBusy('history'); setError('')
    try {
      const value = await listTeachingRubricRevisions(selected.template_id, workspaceId, controller.signal)
      if (!controller.signal.aborted && alive.current) setHistory(value)
    } catch (reason) {
      if (!controller.signal.aborted && alive.current) setError(reason instanceof Error ? reason.message : t('teaching.requestFailed'))
    } finally {
      if (pending.current === controller) pending.current = null
      if (!controller.signal.aborted && alive.current) setBusy(null)
    }
  }

  return (
    <details id="teaching-rubric-library" open={expanded} className="mt-4 rounded-xl border border-border bg-card px-4 py-3" onToggle={event => {
      const open = event.currentTarget.open
      if (open && !expanded) {
        setLoading(true)
        if (!dirty && editor.expected_revision === 0) setEditor(current => ({ ...current, subject, grade }))
      }
      setExpanded(open)
    }}>
      <summary className="cursor-pointer text-sm font-medium">{t('teaching.rubric.title')}{applied && <span className="ml-2 text-xs font-normal text-muted-foreground">{applied.name} · {t('teaching.revision', { n: applied.revision })}</span>}</summary>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">{t('teaching.rubric.hint')}</p>
      {applied ? <div className="mt-3"><StatusChip tone="info">{t('teaching.rubric.applied')}</StatusChip><RubricSnapshotView snapshot={applied} /><Button className="mt-2" size="sm" variant="ghost" disabled={controlsDisabled} onClick={() => onApply(null)}>{t('teaching.rubric.clear')}</Button>{appliedLatest && appliedLatest.revision > applied.revision && <InlineAlert className="mt-2" action={<Button size="sm" variant="secondary" disabled={controlsDisabled} onClick={() => onApply(rubricSnapshot(appliedLatest))}>{t('teaching.rubric.applyLatest', { n: appliedLatest.revision })}</Button>}>{t('teaching.rubric.newVersion', { name: applied.name, old: applied.revision, latest: appliedLatest.revision })}</InlineAlert>}</div> : <p className="mt-3 text-xs text-muted-foreground">{t('teaching.rubric.noneApplied')}</p>}
      {listError && <InlineAlert className="mt-3" tone="warning" action={<Button variant="ghost" size="sm" onClick={() => { setLoading(true); setRefresh(value => value + 1) }}>{t('Retry')}</Button>}>{t('teaching.rubric.listFailed')}</InlineAlert>}
      {loading && <p role="status" className="mt-3 text-sm text-muted-foreground">{t('teaching.rubric.loading')}</p>}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <Field label={t('teaching.rubric.choose')} className="min-w-0 flex-1">
          <select className={controlClass} disabled={controlsDisabled || loading} value={selected?.template_id ?? ''} onChange={e => {
            const value = templates.find(template => template.template_id === e.target.value)
            replaceEditor(value ? editorFor(value) : newTemplate(subject, grade))
          }}>
            <option value="">{t('teaching.rubric.newTemplate')}</option>
            {templates.map(template => <option key={template.template_id} value={template.template_id}>{template.name} · {t('teaching.revision', { n: template.revision })}{template.subject ? ` · ${template.subject}` : ''}</option>)}
          </select>
        </Field>
        <Button size="sm" variant="secondary" icon={<Plus size={14} />} disabled={controlsDisabled} onClick={() => replaceEditor(newTemplate(subject, grade))}>{t('teaching.rubric.newTemplate')}</Button>
      </div>
      {editor.expected_revision > 0 && <p className="mt-2 text-xs text-muted-foreground">{t('teaching.rubric.editingVersion', { n: editor.expected_revision })}</p>}
      <fieldset disabled={controlsDisabled} className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2">
        <Field label={t('teaching.rubric.name')} className="sm:col-span-2"><input className={controlClass} maxLength={200} value={editor.name} onChange={e => change('name', e.target.value)} /></Field>
        <Field label={t('teaching.rubric.subject')}><input className={controlClass} maxLength={200} value={editor.subject} onChange={e => change('subject', e.target.value)} /></Field>
        <Field label={t('teaching.rubric.grade')}><input className={controlClass} maxLength={200} value={editor.grade} onChange={e => change('grade', e.target.value)} /></Field>
        <Field label={t('teaching.rubric.criteria')} hint={t('teaching.rubric.criteriaHint')} className="sm:col-span-2"><textarea className={controlClass} rows={5} maxLength={6000} value={editor.criteria} onChange={e => change('criteria', e.target.value)} /></Field>
      </fieldset>
      {error && <InlineAlert tone="danger" className="mt-3">{error}</InlineAlert>}
      {(conflict || (selected && selected.revision > editor.expected_revision)) && <InlineAlert tone="warning" className="mt-3" action={selected && selected.revision > editor.expected_revision ? <Button size="sm" variant="secondary" disabled={controlsDisabled} onClick={() => replaceEditor(editorFor(selected))}>{t('teaching.reloadSaved')}</Button> : undefined}>{t('teaching.rubric.conflict')}</InlineAlert>}
      {notice && <InlineAlert className="mt-3">{notice}</InlineAlert>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" loading={busy === 'save'} disabled={controlsDisabled || conflict || (!dirty && editor.expected_revision > 0)} onClick={() => void save()}>{t('teaching.rubric.save')}</Button>
        <Button size="sm" icon={<BookCheck size={14} />} disabled={controlsDisabled || !canApplyEditor} onClick={() => { if (canApplyEditor) onApply(rubricSnapshot(selected)) }}>{t('teaching.rubric.apply')}</Button>
        {selected && <Button size="sm" variant="ghost" icon={<History size={14} />} disabled={controlsDisabled} onClick={() => void showHistory()}>{t(history ? 'teaching.hideHistory' : 'teaching.rubric.history')}</Button>}
        {conflict && <Button size="sm" variant="secondary" disabled={controlsDisabled} onClick={() => { setEditor(current => ({ ...current, template_id: crypto.randomUUID(), expected_revision: 0 })); setConflict(false); setDirty(true); setError('') }}>{t('teaching.rubric.saveCopy')}</Button>}
      </div>
      {dirty && <p className="mt-2 text-xs text-muted-foreground">{t('teaching.rubric.unsavedHint')}</p>}
      {history && <section className="mt-4" aria-label={t('teaching.rubric.history')}><h3 className="text-sm font-semibold">{t('teaching.rubric.history')}</h3>{history.map(version => <div key={version.revision} className="mt-2"><RubricSnapshotView snapshot={version} /><Button size="sm" variant="ghost" disabled={controlsDisabled} onClick={() => onApply(rubricSnapshot(version))}>{t('teaching.rubric.applyVersion', { n: version.revision })}</Button></div>)}</section>}
      <Dialog open={replacement !== null} onClose={() => setReplacement(null)} title={t('teaching.rubric.replaceTitle')} closeLabel={t('Close')} footer={<><Button size="sm" variant="secondary" onClick={() => setReplacement(null)}>{t('Cancel')}</Button><Button size="sm" onClick={() => { if (replacement) loadEditor(replacement) }}>{t('teaching.rubric.replaceConfirm')}</Button></>}><p className="text-sm text-muted-foreground">{t('teaching.rubric.replaceHint')}</p></Dialog>
    </details>
  )
}
