'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useTranslation } from 'react-i18next'
import { FileText, FileUp, Sparkles, Trash2 } from 'lucide-react'
import { Button, Dialog, Field, InlineAlert } from '@/shared/ui'
import { isApiError } from '@/shared/api/errors'
import { scopedUrl } from '@/lib/workspace-scope'
import type { AssignmentInput } from '@/lib/teaching-analysis-api'
import { draftObject, draftText } from '@/lib/teaching-draft-validation'
import {
  extractTeachingDocument, isDocumentExtraction, isDocumentPreview, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_TEXT,
  previewTeachingDocument, sameLocatedDocument, isSerializableDocumentState,
  type DocumentExtraction, type DocumentPreview,
} from '@/lib/teaching-documents-api'
import { useTeachingDraftSlot } from './TeachingDrafts'
import { controlClass } from './AssignmentEditor'
import { DocumentSourceReview } from './DocumentSourceReview'

export interface DocumentImportDraft {
  kind: 'document-import'
  version: 1
  pasted: string
  preview: DocumentPreview | null
  extraction: DocumentExtraction | null
  source_kind: 'file' | 'paste' | null
  preview_pasted: string | null
  requires_preview: boolean
}

function emptyDraft(): DocumentImportDraft {
  return { kind: 'document-import', version: 1, pasted: '', preview: null, extraction: null, source_kind: null, preview_pasted: null, requires_preview: false }
}

/** Restores data only; signatures and permission are still checked by the API. */
export function isDocumentImportDraft(value: unknown): value is DocumentImportDraft {
  if (!isSerializableDocumentState(value) || !draftObject(value) || value.kind !== 'document-import' || value.version !== 1 || !draftText(value.pasted, MAX_DOCUMENT_BYTES) ||
    typeof value.requires_preview !== 'boolean' || !['file', 'paste', null].includes(value.source_kind as 'file' | 'paste' | null) ||
    !(value.preview === null || isDocumentPreview(value.preview)) || !(value.extraction === null || isDocumentExtraction(value.extraction))) return false
  const allowed = ['kind', 'version', 'pasted', 'preview', 'extraction', 'source_kind', 'preview_pasted', 'requires_preview']
  if (Object.keys(value).some(key => !allowed.includes(key))) return false
  if (value.preview === null) return value.extraction === null && value.source_kind === null && value.preview_pasted === null && value.requires_preview === false
  if (value.source_kind === null || (value.source_kind === 'paste' ? !draftText(value.preview_pasted, MAX_DOCUMENT_TEXT) || !value.preview_pasted.trim() : value.preview_pasted !== null)) return false
  return value.extraction === null || sameLocatedDocument(value.preview.document, value.extraction.document)
}

interface DocumentImportPanelProps {
  workspaceId: string
  disabled: boolean
  onApply: (assignment: AssignmentInput) => void
  onDirtyChange?: (dirty: boolean) => void
  appliedSignature?: string
}

type ReadSource = { kind: 'file'; file: File } | { kind: 'paste'; text: string }

export function DocumentImportPanel({ workspaceId, ...props }: DocumentImportPanelProps) {
  return <ScopedDocumentImportPanel key={workspaceId} workspaceId={workspaceId} {...props} />
}

function ScopedDocumentImportPanel({ workspaceId, disabled, onApply, onDirtyChange, appliedSignature }: DocumentImportPanelProps) {
  const { t, i18n } = useTranslation()
  const [state, setState] = useState<DocumentImportDraft>(emptyDraft)
  const [busy, setBusy] = useState<'preview' | 'extract' | 'clear' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [needsModel, setNeedsModel] = useState(false)
  const [reviewed, setReviewed] = useState(false)
  const [view, setView] = useState<'source' | 'extracted'>('source')
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const [replacement, setReplacement] = useState<ReadSource | null>(null)
  const [clearing, setClearing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const alive = useRef(true)
  const id = useId()
  const sourceHeadingId = `document-source-${id}`
  const extractionHeadingId = `document-extracted-${id}`
  const language = i18n.language.startsWith('zh') ? 'zh' : 'en'
  const pastedCount = useMemo(() => Array.from(state.pasted).length, [state.pasted])
  const pastedChanged = state.source_kind === 'paste' && state.pasted !== state.preview_pasted
  const pendingPaste = Boolean(state.pasted.trim() && (state.source_kind !== 'paste' || pastedChanged))
  const signature = (state.extraction?.assignment as AssignmentInput & { document_provenance?: { signature?: string } } | undefined)?.document_provenance?.signature
  const applied = Boolean(signature && signature === appliedSignature)
  const dirty = pendingPaste || Boolean(state.preview && !applied)
  const controlsDisabled = disabled || busy !== null
  const issues = Array.from(new Set([...(state.preview?.document.warnings ?? []), ...(state.extraction?.warnings ?? [])]))
  const canExtract = Boolean(state.preview && !state.requires_preview && !pastedChanged)
  const canApply = Boolean(state.extraction?.assignment.items.length && !state.requires_preview && !pastedChanged)
  const sourceId = (blockId: string) => `document-${id}-${blockId}`

  const slot = useTeachingDraftSlot<DocumentImportDraft>({
    slot: 'document-import', value: state, dirty, validate: isDocumentImportDraft,
    onRestore(value) {
      setState(value)
      setReviewed(false)
      setNeedsModel(false)
      setError('')
      setNotice(t('teaching.documents.restoreNotice'))
      setHighlighted(null)
      setView(value.extraction ? 'extracted' : 'source')
    },
  })

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; controllerRef.current?.abort() }
  }, [])
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  useEffect(() => {
    if (!highlighted) return
    const frame = requestAnimationFrame(() => {
      const block = document.getElementById(`document-${id}-${highlighted}`)
      block?.scrollIntoView?.({ block: 'nearest' })
      block?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [highlighted, id, view])

  function begin(operation: 'preview' | 'extract' | 'clear'): AbortController | null {
    if (controllerRef.current || disabled) return null
    const controller = new AbortController()
    controllerRef.current = controller
    setBusy(operation)
    setError('')
    setNotice('')
    setNeedsModel(false)
    return controller
  }
  function active(controller: AbortController) { return alive.current && !controller.signal.aborted }
  function finish(controller: AbortController) {
    if (controllerRef.current === controller) controllerRef.current = null
    if (active(controller)) setBusy(null)
  }
  function fail(reason: unknown, controller: AbortController) {
    if (!active(controller)) return
    if (isApiError(reason) && reason.code === 'teaching_model_not_configured') { setNeedsModel(true); setError(t('teaching.documents.modelMissing')); return }
    if (isApiError(reason) && reason.code === 'teaching_document_token_invalid') {
      setState(current => ({ ...current, requires_preview: true }))
      setReviewed(false)
      setError('')
      return
    }
    setError(isApiError(reason) && reason.code === 'teaching_document_response_invalid' ? t('teaching.documents.invalidResponse') : reason instanceof Error ? reason.message : t('teaching.documents.failed'))
  }

  function updatePaste(text: string) {
    if (Array.from(text).length > MAX_DOCUMENT_BYTES) { setError(t('teaching.documents.draftTooLarge')); return }
    setState(current => ({ ...current, pasted: text }))
    setReviewed(false)
    setError('')
    setNotice('')
  }

  function checkSource(source: ReadSource): boolean {
    if (source.kind === 'file') {
      if (!/\.(txt|md|docx)$/i.test(source.file.name)) { setError(t('teaching.documents.invalidFile')); return false }
      if (source.file.size > MAX_DOCUMENT_BYTES) { setError(t('teaching.documents.fileTooLarge')); return false }
      return true
    }
    if (!source.text.trim()) { setError(t('teaching.documents.emptyText')); return false }
    if (Array.from(source.text).length > MAX_DOCUMENT_TEXT) { setError(t('teaching.documents.textTooLong')); return false }
    return true
  }
  function requestPreview(source: ReadSource, refreshing = false) {
    if (controlsDisabled || !checkSource(source)) return
    if (state.preview && !refreshing) setReplacement(source)
    else void read(source)
  }
  async function read(source: ReadSource) {
    if (!checkSource(source)) return
    const controller = begin('preview')
    if (!controller) return
    try {
      const file = source.kind === 'file' ? source.file : new File([source.text], t('teaching.documents.pastedFilename'), { type: 'text/plain' })
      const preview = await previewTeachingDocument(file, workspaceId, controller.signal)
      if (!active(controller)) return
      setState(current => ({ ...current, preview, extraction: null, source_kind: source.kind, preview_pasted: source.kind === 'paste' ? source.text : null, requires_preview: false }))
      setReviewed(false)
      setHighlighted(null)
      setView('source')
      setNotice(t('teaching.documents.sourceReady'))
    } catch (reason) { fail(reason, controller) } finally { finish(controller) }
  }
  async function extract() {
    if (!state.preview || !canExtract || controlsDisabled) return
    const preview = state.preview
    const controller = begin('extract')
    if (!controller) return
    try {
      const extraction = await extractTeachingDocument(preview, language, workspaceId, controller.signal)
      if (!active(controller)) return
      setState(current => ({ ...current, extraction }))
      setReviewed(false)
      setView('extracted')
      setHighlighted(null)
    } catch (reason) { fail(reason, controller) } finally { finish(controller) }
  }
  async function clearDocument() {
    const controller = begin('clear')
    if (!controller) return
    try {
      await slot.clear()
      if (!active(controller)) return
      setState(emptyDraft())
      setReviewed(false)
      setClearing(false)
      setHighlighted(null)
      setView('source')
    } catch {
      if (active(controller)) { setError(t('teaching.documents.clearFailed')); setClearing(false) }
    } finally { finish(controller) }
  }
  function apply() {
    if (!state.extraction || !canApply || controlsDisabled) return
    const assignment = state.extraction.assignment
    onApply({ ...assignment, items: assignment.items.map(item => ({ ...item, transcription_status: reviewed ? 'confirmed' : 'uncertain' })) })
  }
  function refreshOriginal() {
    if (state.source_kind === 'paste') requestPreview({ kind: 'paste', text: state.pasted }, true)
    else inputRef.current?.click()
  }
  function selectView(next: 'source' | 'extracted') { setView(next) }

  return (
    <section className="mt-5 rounded-xl border border-border bg-card p-4 sm:p-5" aria-labelledby={`document-import-title-${id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 id={`document-import-title-${id}`} className="flex items-center gap-2 text-base font-semibold"><FileText size={18} className="text-primary" aria-hidden />{t('teaching.documents.title')}</h3><p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{t('teaching.documents.hint')}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{t('teaching.documents.limits')}</p></div>{(state.preview || state.pasted) && <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} disabled={controlsDisabled} onClick={() => setClearing(true)}>{t('teaching.documents.clear')}</Button>}</div>
      <div className="mt-4"><Button variant="secondary" size="sm" icon={<FileUp size={15} />} disabled={controlsDisabled} onClick={() => inputRef.current?.click()}>{t('teaching.documents.chooseFile')}</Button><input ref={inputRef} className="sr-only" type="file" accept=".txt,.md,.docx,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document" aria-label={t('teaching.documents.chooseFile')} disabled={controlsDisabled} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) requestPreview({ kind: 'file', file }) }} /></div>
      <Field className="mt-4" label={t('teaching.documents.pasteText')} hint={t('teaching.documents.pasteHint')}><textarea className={controlClass} rows={5} disabled={controlsDisabled} value={state.pasted} onChange={event => updatePaste(event.target.value)} /></Field>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3"><Button size="sm" variant="secondary" disabled={controlsDisabled || !state.pasted.trim()} loading={busy === 'preview'} onClick={() => requestPreview({ kind: 'paste', text: state.pasted })}>{t('teaching.documents.readText')}</Button><p className={`text-xs ${pastedCount > MAX_DOCUMENT_TEXT ? 'text-destructive' : 'text-muted-foreground'}`}>{t('teaching.documents.characters', { n: pastedCount })}</p></div>
      {error && <InlineAlert tone="danger" className="mt-4" action={needsModel ? <Link className="font-medium underline underline-offset-2" href={scopedUrl('/settings/llm', workspaceId)}>{t('teaching.documents.configureModel')}</Link> : undefined}>{error}</InlineAlert>}
      {notice && <InlineAlert className="mt-4">{notice}</InlineAlert>}
      {state.requires_preview && <InlineAlert className="mt-4" tone="warning" action={<Button variant="secondary" size="sm" disabled={controlsDisabled} onClick={refreshOriginal}>{t('teaching.documents.readAgain')}</Button>}>{t('teaching.documents.needsRead')}</InlineAlert>}
      {pastedChanged && <InlineAlert tone="warning" className="mt-4">{t('teaching.documents.changedPaste')}</InlineAlert>}
      {applied && !pastedChanged && <InlineAlert tone="success" className="mt-4">{t('teaching.documents.applied')}</InlineAlert>}
      {state.preview && <div className="mt-5 flex flex-wrap items-center gap-3"><Button icon={<Sparkles size={15} />} loading={busy === 'extract'} disabled={controlsDisabled || !canExtract} onClick={() => void extract()}>{t(state.extraction ? 'teaching.documents.extractAgain' : 'teaching.documents.extract')}</Button><p className="max-w-xl text-xs leading-5 text-muted-foreground">{t('teaching.documents.extractHint')}</p></div>}
      {busy && <p role="status" className="mt-3 text-sm text-muted-foreground">{t(busy === 'preview' ? 'teaching.documents.reading' : busy === 'extract' ? 'teaching.documents.extracting' : 'Loading…')}</p>}
      <div className="mt-5 flex gap-2 lg:hidden" role="tablist" aria-label={t('teaching.documents.reviewView')}>
        {(['source', 'extracted'] as const).map(next => <button key={next} type="button" role="tab" aria-selected={view === next} aria-controls={next === 'source' ? sourceHeadingId : extractionHeadingId} tabIndex={view === next ? 0 : -1} data-document-tab={next} className={`rounded-lg border px-3 py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring ${view === next ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`} onClick={() => selectView(next)} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
          event.preventDefault()
          const destination = next === 'source' ? 'extracted' : 'source'
          selectView(destination)
          event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-document-tab="${destination}"]`)?.focus()
        }}>{t(`teaching.documents.${next}`)}</button>)}
      </div>
      <DocumentSourceReview preview={state.preview} extraction={state.extraction} view={view} highlighted={highlighted} sourceId={sourceId} sourceHeadingId={sourceHeadingId} extractionHeadingId={extractionHeadingId} onCitation={blockId => { setHighlighted(blockId); setView('source') }} />
      {issues.length > 0 && <InlineAlert className="mt-4" tone="warning" title={t('teaching.documents.warnings')}><ul className="list-disc space-y-1 pl-4">{issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></InlineAlert>}
      {state.extraction && <div className="mt-5 border-t border-border pt-4">
        <p className="mb-3 text-xs leading-5 text-muted-foreground">{t('teaching.requiredScope')}</p>
        <label className="flex items-start gap-2 text-sm leading-6"><input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-primary" disabled={controlsDisabled || !canApply} checked={reviewed} onChange={event => setReviewed(event.target.checked)} /><span>{t('teaching.documents.reviewCheckbox')}</span></label>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{t(reviewed ? 'teaching.documents.reviewHint' : 'teaching.documents.unreviewedHint')}</p>
        <Button className="mt-4" disabled={controlsDisabled || !canApply} onClick={apply}>{t(reviewed ? 'teaching.documents.applyReviewed' : 'teaching.documents.apply')}</Button>
      </div>}
      <Dialog open={replacement !== null} title={t('teaching.documents.replaceTitle')} busy={busy === 'preview'} onClose={() => { if (!busy) setReplacement(null) }} footer={<><Button variant="secondary" disabled={busy !== null} onClick={() => setReplacement(null)}>{t('Cancel')}</Button><Button disabled={controlsDisabled} onClick={() => { if (replacement) { const next = replacement; setReplacement(null); void read(next) } }}>{t('teaching.documents.replaceConfirm')}</Button></>}><p className="text-sm leading-6 text-muted-foreground">{t('teaching.documents.replaceHint')}</p></Dialog>
      <Dialog open={clearing} title={t('teaching.documents.clearTitle')} busy={busy === 'clear'} onClose={() => { if (!busy) setClearing(false) }} footer={<><Button variant="secondary" disabled={busy !== null} onClick={() => setClearing(false)}>{t('Cancel')}</Button><Button variant="danger" disabled={controlsDisabled} loading={busy === 'clear'} onClick={() => void clearDocument()}>{t('teaching.documents.clearConfirm')}</Button></>}><p className="text-sm leading-6 text-muted-foreground">{t('teaching.documents.clearHint')}</p></Dialog>
    </section>
  )
}
