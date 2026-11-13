'use client'

import Link from 'next/link'
import { ClipboardCheck, ArrowUpRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuthStatus } from '@/hooks/useAuthStatus'
import { useModules } from '@/hooks/useModules'
import { TEACHING_ANALYSIS_HOME } from '@/lib/teaching-analysis-api'
import { scopedUrl } from '@/lib/workspace-scope'
import { OverviewRow } from '@/components/sidebar/NavigationPrimitives'

/** The administrator workflow stays separate from personal mastery activities. */
export function TeachingAnalysisEntry({ compact = false }: { compact?: boolean }) {
  const auth = useAuthStatus()
  const inventory = useModules()
  const { t } = useTranslation()
  if (auth.loading || !auth.statusAvailable || (auth.enabled && !auth.isAdmin) || !inventory.available(TEACHING_ANALYSIS_HOME)) return null
  if (compact) return <OverviewRow href={scopedUrl(TEACHING_ANALYSIS_HOME)} label={t('teaching.title')} icon={ClipboardCheck} />
  return (
    <Link href={scopedUrl(TEACHING_ANALYSIS_HOME)} prefetch={false} className="mt-5 flex flex-wrap items-center gap-4 rounded-xl border border-border bg-card p-5 text-foreground transition-colors hover:border-primary/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
      <ClipboardCheck size={22} className="shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{t('teaching.title')}</span><span className="mt-1 block text-sm leading-6 text-muted-foreground">{t('teaching.entryHint')}</span></span>
      <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">{t('teaching.open')}<ArrowUpRight size={14} aria-hidden /></span>
    </Link>
  )
}
