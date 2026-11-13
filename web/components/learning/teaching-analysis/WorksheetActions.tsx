'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Printer } from 'lucide-react'
import { Button, InlineAlert } from '@/shared/ui'
import type { SavedFollowup } from '@/lib/teaching-followups-api'
import { fetchTeachingWorksheet } from '@/lib/teaching-worksheets-api'

/** Export only an explicitly saved question version, never an unsaved editor. */
export function WorksheetActions({ followup, workspaceId, disabled = false }: { followup: SavedFollowup; workspaceId: string; disabled?: boolean }) {
  const { t, i18n } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<AbortController | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; pending.current?.abort() }
  }, [followup.followup_id, followup.revision, workspaceId])

  async function exportVersion(audience: 'student' | 'teacher', format: 'html' | 'markdown') {
    if (pending.current || disabled) return
    const popup = format === 'html' ? window.open('about:blank', '_blank') : null
    if (format === 'html' && !popup) { setError(t('teaching.worksheets.popupBlocked')); return }
    if (popup) { popup.opener = null; popup.document.body.textContent = t('teaching.worksheets.preparing') }
    const controller = new AbortController()
    pending.current = controller; setBusy(true); setError('')
    try {
      const blob = await fetchTeachingWorksheet(followup.followup_id, followup.revision, audience, format, i18n.language.startsWith('zh') ? 'zh' : 'en', workspaceId, controller.signal)
      if (controller.signal.aborted || !alive.current) { popup?.close(); return }
      const url = URL.createObjectURL(blob)
      if (popup && !popup.closed) popup.location.href = url
      else if (format === 'markdown') {
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `worksheet-${audience}-${followup.followup_id}-r${followup.revision}.md`
        anchor.click()
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (reason) {
      popup?.close()
      if (alive.current && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : t('teaching.worksheets.failed'))
    } finally {
      if (pending.current === controller) pending.current = null
      if (alive.current) setBusy(false)
    }
  }

  return <section className="mt-4 rounded-xl border border-border bg-muted/30 p-4" aria-label={t('teaching.worksheets.title')}>
    <h4 className="text-sm font-semibold">{t('teaching.worksheets.title')}</h4>
    <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('teaching.worksheets.hint', { n: followup.revision })}</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" icon={<Printer size={14} />} disabled={disabled || busy} onClick={() => void exportVersion('student', 'html')}>{t('teaching.worksheets.studentPrint')}</Button>
      <Button size="sm" variant="ghost" icon={<Download size={14} />} disabled={disabled || busy} onClick={() => void exportVersion('student', 'markdown')}>{t('teaching.worksheets.studentDownload')}</Button>
    </div>
    <details className="mt-3 text-xs">
      <summary className="cursor-pointer font-medium">{t('teaching.worksheets.teacherEdition')}</summary>
      <p className="mt-2 leading-5 text-muted-foreground">{t('teaching.worksheets.teacherWarning')}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => void exportVersion('teacher', 'html')}>{t('teaching.worksheets.teacherPrint')}</Button>
        <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => void exportVersion('teacher', 'markdown')}>{t('teaching.worksheets.teacherDownload')}</Button>
      </div>
    </details>
    {error && <InlineAlert tone="warning" className="mt-3">{error}</InlineAlert>}
  </section>
}
