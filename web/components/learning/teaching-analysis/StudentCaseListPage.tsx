'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, Plus, Users } from 'lucide-react'
import { Button, InlineAlert, StatusChip } from '@/shared/ui'
import { scopedUrl } from '@/lib/workspace-scope'
import { TEACHING_ANALYSIS_HOME } from '@/lib/teaching-analysis-api'
import { listStudentCases, saveStudentCase, studentCaseRoute, type SavedStudentCase, type StudentCaseSummary } from '@/lib/teaching-student-cases-api'
import { isStudentCaseDraft, newStudentCaseEditor, type StudentCaseDraft } from '@/lib/teaching-student-case-drafts'
import { LearningShell, LearningSkeleton } from '../LearningShell'
import { StudentCaseAccess } from './StudentCaseAccess'
import { StudentCaseFields } from './StudentCaseFields'
import { useTeachingDraftSlot } from './TeachingDrafts'

const PAGE_SIZE = 50
export default function StudentCaseListPage() { return <StudentCaseAccess>{workspaceId => <StudentCaseList workspaceId={workspaceId} />}</StudentCaseAccess> }

function StudentCaseList({ workspaceId }: { workspaceId: string }) {
  const { t, i18n } = useTranslation()
  const [archived, setArchived] = useState(false)
  const [rows, setRows] = useState<StudentCaseSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [creating, setCreating] = useState(false)
  const [editor, setEditor] = useState(newStudentCaseEditor)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pendingCreated, setPendingCreated] = useState<SavedStudentCase | null>(null)
  const nextOffset = useRef(0)
  const read = useRef<AbortController | null>(null)
  const write = useRef<AbortController | null>(null)
  const requestSequence = useRef(0)
  const alive = useRef(true)
  const draft = useMemo<StudentCaseDraft>(() => ({ kind: 'student-case-editor', version: 1, editor }), [editor])
  const { clear } = useTeachingDraftSlot({ slot: 'student-case-create', value: draft, dirty, validate: isStudentCaseDraft, onRestore: value => { setEditor(value.editor); setDirty(true); setCreating(true); setError('') } })
  useEffect(() => { alive.current = true; return () => { alive.current = false; read.current?.abort(); write.current?.abort() } }, [])
  const load = useCallback(async (append: boolean) => {
    read.current?.abort()
    const controller = new AbortController()
    read.current = controller
    const sequence = ++requestSequence.current
    const offset = append ? nextOffset.current : 0
    setLoading(true); setListError(false)
    try {
      const page = await listStudentCases({ archived, limit: PAGE_SIZE, offset }, workspaceId, controller.signal)
      if (controller.signal.aborted || sequence !== requestSequence.current || !alive.current) return
      setRows(previous => {
        const merged = new Map((append ? previous : []).map(row => [row.case_id, row]))
        for (const row of page) if (!merged.has(row.case_id) || merged.get(row.case_id)!.revision <= row.revision) merged.set(row.case_id, row)
        return Array.from(merged.values())
      })
      nextOffset.current = offset + page.length
      setHasMore(page.length === PAGE_SIZE)
    } catch { if (!controller.signal.aborted && alive.current) setListError(true) }
    finally { if (!controller.signal.aborted && sequence === requestSequence.current && alive.current) setLoading(false) }
  }, [archived, workspaceId])
  useEffect(() => { void load(false); return () => read.current?.abort() }, [load, refresh])

  async function create() {
    if (write.current) return
    if (pendingCreated) {
      setSaving(true)
      try { await clear(); if (alive.current) { setEditor(newStudentCaseEditor()); setDirty(false); setCreating(false); setPendingCreated(null); setError('') } }
      catch { if (alive.current) setError(t('teaching.cases.savedLocalPending')) }
      finally { if (alive.current) setSaving(false) }
      return
    }
    if (!editor.label.trim() || Array.from(editor.label).length > 200) { setError(t('teaching.cases.required')); return }
    const controller = new AbortController(); write.current = controller; setSaving(true); setError('')
    try {
      const saved = await saveStudentCase(editor, workspaceId, controller.signal)
      if (controller.signal.aborted || !alive.current) return
      setPendingCreated(saved); setDirty(false); setNotice(t('teaching.cases.saved', { n: saved.revision }))
      const summary: StudentCaseSummary = { case_id: saved.case_id, revision: saved.revision, label: saved.label, subject: saved.subject, archived: saved.archived, report_count: saved.report_refs.length, created_at: saved.created_at, updated_at: saved.updated_at }
      setArchived(saved.archived); setRows(previous => archived === saved.archived ? [summary, ...previous.filter(row => row.case_id !== saved.case_id)] : [summary]); setRefresh(value => value + 1)
      try {
        await clear()
        if (controller.signal.aborted || !alive.current) return
        setEditor(newStudentCaseEditor()); setDirty(false); setCreating(false); setPendingCreated(null)
      } catch { if (alive.current) setError(t('teaching.cases.savedLocalPending')) }
    } catch { if (!controller.signal.aborted && alive.current) setError(t('teaching.cases.createFailed')) }
    finally { if (write.current === controller) write.current = null; if (!controller.signal.aborted && alive.current) setSaving(false) }
  }

  return <LearningShell back={false} title={t('teaching.cases.title')} subtitle={t('teaching.cases.subtitle')} icon={Users} action={<div className="flex flex-wrap gap-2"><Link className="inline-flex min-h-8 items-center rounded-lg border border-border px-3 text-xs hover:bg-muted" href={scopedUrl(TEACHING_ANALYSIS_HOME, workspaceId)}>{t('teaching.cases.workbench')}</Link><Button size="sm" icon={<Plus size={14} />} onClick={() => setCreating(true)}>{t('teaching.cases.new')}</Button></div>}>
    <details open={creating} onToggle={event => setCreating(event.currentTarget.open)} className="mb-6 rounded-xl border border-border bg-card p-4 sm:p-5">
      <summary className="cursor-pointer text-sm font-semibold">{t('teaching.cases.new')}</summary>
      <div className="mt-4"><StudentCaseFields value={editor} disabled={saving || pendingCreated !== null} onChange={value => { setEditor(value); setDirty(true); setNotice('') }} />{error && <InlineAlert tone="danger" className="mt-3">{error}</InlineAlert>}<div className="mt-4 flex flex-wrap gap-3"><Button size="sm" loading={saving} onClick={() => void create()}>{t(pendingCreated ? 'teaching.cases.retryCleanup' : 'teaching.cases.create')}</Button>{pendingCreated && <Link href={studentCaseRoute(pendingCreated.case_id, workspaceId)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center text-sm text-primary underline underline-offset-2">{t('teaching.cases.openCreated')}</Link>}</div></div>
    </details>
    {notice && <InlineAlert className="mb-4">{notice}</InlineAlert>}
    <div className="mb-4 flex gap-2" role="group" aria-label={t('teaching.cases.title')}>
      {[false, true].map(value => <Button key={String(value)} size="sm" variant={archived === value ? 'primary' : 'ghost'} aria-pressed={archived === value} onClick={() => { if (archived !== value) { setRows([]); setArchived(value); nextOffset.current = 0 } }}>{t(value ? 'teaching.cases.archived' : 'teaching.cases.active')}</Button>)}
    </div>
    {listError && <InlineAlert tone="warning" className="mb-4" action={<Button size="sm" variant="ghost" onClick={() => void load(rows.length > 0)}>{t('Retry')}</Button>}>{t('teaching.cases.listFailed')}</InlineAlert>}
    {loading && !rows.length ? <LearningSkeleton count={3} /> : <div className="grid gap-3">{rows.map(row => <Link key={row.case_id} href={studentCaseRoute(row.case_id, workspaceId)} className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"><span className="min-w-0 flex-1"><span className="block break-words text-base font-semibold">{row.label}</span><span className="mt-1 block text-xs text-muted-foreground">{row.subject || t('teaching.cases.noSubject')} · {t('teaching.cases.code', { id: row.case_id.slice(0, 8) })}</span><span className="mt-2 block text-xs text-muted-foreground">{t('teaching.cases.savedAt', { time: new Date(row.updated_at * 1000).toLocaleString(i18n.language) })}</span></span><span className="flex shrink-0 items-center gap-3"><StatusChip>{t('teaching.cases.pinCount', { n: row.report_count })}</StatusChip>{row.archived && <StatusChip>{t('teaching.cases.archived')}</StatusChip>}<ArrowUpRight size={16} aria-hidden /></span></Link>)}</div>}
    {!loading && !listError && !rows.length && <p className="py-8 text-sm text-muted-foreground">{t('teaching.cases.none')}</p>}
    {hasMore && <Button className="mt-5" variant="secondary" size="sm" loading={loading} onClick={() => void load(true)}>{t('teaching.cases.loadMore')}</Button>}
  </LearningShell>
}
