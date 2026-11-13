'use client'

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, InlineAlert } from '@/shared/ui'
import { getStudentCaseRevisions, type SavedStudentCase } from '@/lib/teaching-student-cases-api'

export function StudentCaseHistory({ caseId, revision, workspaceId }: { caseId: string; revision: number; workspaceId: string }) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const [versions, setVersions] = useState<SavedStudentCase[]>([])
  const [failed, setFailed] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void getStudentCaseRevisions(caseId, workspaceId, controller.signal).then(value => {
      if (!controller.signal.aborted) { setVersions(value); setFailed(false) }
    }).catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => controller.abort()
  }, [open, caseId, revision, workspaceId, refresh])
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="mt-6 rounded-xl border border-border p-4">
    <summary className="cursor-pointer text-sm font-semibold">{t('teaching.cases.history')}</summary>
    {failed && <InlineAlert tone="warning" className="mt-3" action={<Button size="sm" variant="ghost" onClick={() => setRefresh(value => value + 1)}>{t('Retry')}</Button>}>{t('teaching.cases.historyFailed')}</InlineAlert>}
    {versions.length >= 100 && <p className="mt-3 text-xs text-muted-foreground">{t('teaching.cases.history100')}</p>}
    {versions.map(version => <details key={version.revision} className="mt-3 border-t border-border/60 pt-3">
      <summary className="cursor-pointer text-sm">{t('teaching.revision', { n: version.revision })} · {version.label} · {t(version.archived ? 'teaching.cases.archived' : 'teaching.cases.active')}</summary>
      <p className="mt-2 text-xs text-muted-foreground">{version.subject || t('teaching.cases.noSubject')} · {t('teaching.cases.savedAt', { time: new Date(version.updated_at * 1000).toLocaleString(i18n.language) })}</p>
      <h4 className="mt-3 text-xs font-medium">{t('teaching.cases.historyPins')}</h4>
      {version.report_refs.length ? <ul className="mt-2 space-y-1 text-xs text-muted-foreground">{version.report_refs.map(ref => <li key={ref.report_id}>{t('teaching.cases.pin', { id: ref.report_id, n: ref.report_revision })}</li>)}</ul> : <p className="mt-2 text-xs text-muted-foreground">{t('teaching.cases.noneLinked')}</p>}
    </details>)}
  </details>
}
