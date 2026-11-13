'use client'

import { useTranslation } from 'react-i18next'
import { Button, StatusChip } from '@/shared/ui'
import type { AssignmentInput } from '@/lib/teaching-analysis-api'

/** Original signed fragments remain unchanged when a teacher corrects a field. */
export function SourceProvenanceView({ assignment, disabled = false, onClear }: { assignment: AssignmentInput; disabled?: boolean; onClear?: () => void }) {
  const { t } = useTranslation()
  const provenance = assignment.document_provenance
  if (!provenance) return null
  return <details className="mt-4 rounded-xl border border-border bg-card p-4">
    <summary className="cursor-pointer text-sm font-medium">{t('teaching.documentSource.title', { filename: provenance.filename })}</summary>
    <p className="mt-2 text-xs leading-5 text-muted-foreground">{t('teaching.documentSource.hint')}</p>
    <div className="mt-3 grid gap-3">
      {provenance.fields.map((source, index) => {
        const item = assignment.items.find(row => row.question_id === source.question_id)
        const original = source.citations.map(citation => citation.quote).join('\n')
        const changed = !item || item[source.field] !== original
        return <article key={index} className="rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
            <span>{source.question_id} · {t(`teaching.documentSource.field.${source.field}`)}</span>
            {changed && <StatusChip tone="warning">{t(item ? 'teaching.documentSource.edited' : 'teaching.documentSource.removed')}</StatusChip>}
          </div>
          {source.citations.map((citation, i) => <blockquote key={i} className="mt-2 whitespace-pre-wrap break-words border-l-2 border-primary/30 bg-muted/40 px-3 py-2 text-sm leading-6"><p className="mb-1 text-xs text-muted-foreground">{citation.locator}</p>{citation.quote}</blockquote>)}
        </article>
      })}
    </div>
    {onClear && <Button size="sm" variant="ghost" className="mt-3" disabled={disabled} onClick={onClear}>{t('teaching.documentSource.clear')}</Button>}
  </details>
}
