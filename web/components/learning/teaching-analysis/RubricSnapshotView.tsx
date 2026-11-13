'use client'

import { useTranslation } from 'react-i18next'
import type { RubricSnapshot } from '@/lib/teaching-rubrics-api'

export function RubricSnapshotView({ snapshot }: { snapshot: RubricSnapshot }) {
  const { t } = useTranslation()
  return (
    <details className="mt-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">{t('teaching.rubric.usedVersion', { name: snapshot.name, n: snapshot.revision })}</summary>
      <p className="mt-2 text-xs text-muted-foreground">{[snapshot.subject, snapshot.grade].filter(Boolean).join(' · ')}</p>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{snapshot.criteria}</p>
    </details>
  )
}
