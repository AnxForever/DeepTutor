'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpenCheck } from 'lucide-react'
import { useAuthStatus } from '@/hooks/useAuthStatus'
import { studentTaskAccess } from '@/lib/student-task-access'
import { Button, InlineAlert } from '@/shared/ui'
import { LearningShell, LearningSkeleton } from '../LearningShell'

export function StudentTaskAccess({ children }: { children: (accountId: string) => ReactNode }) {
  const auth = useAuthStatus()
  const { t } = useTranslation()
  if (auth.loading) return <LearningShell back={false} title={t('studentTasks.title')} subtitle={t('studentTasks.loading')} icon={BookOpenCheck}><LearningSkeleton count={2} /></LearningShell>
  if (!auth.statusAvailable || (auth.enabled && !auth.userId)) return <LearningShell back={false} title={t('studentTasks.title')} subtitle="" icon={BookOpenCheck}><InlineAlert tone="warning" action={<Button variant="secondary" onClick={() => window.location.reload()}>{t('studentTasks.retry')}</Button>}>{t('studentTasks.accessUnavailable')}</InlineAlert></LearningShell>
  if (!auth.enabled || auth.isAdmin) return <LearningShell back={false} title={t('studentTasks.setupTitle')} subtitle={t('studentTasks.setupHint')} icon={BookOpenCheck}><div className="flex flex-wrap gap-3"><Link href="/admin/users" className="inline-flex min-h-12 items-center rounded-xl bg-primary px-5 text-base font-medium text-primary-foreground">{t('studentTasks.setup')}</Link><Link href="/learning/teaching-analysis" className="inline-flex min-h-12 items-center rounded-xl border border-border px-5 text-base font-medium">{t('studentTasks.teacherHome')}</Link></div></LearningShell>
  if (!studentTaskAccess(auth)) return <LearningShell back={false} title={t('studentTasks.title')} subtitle="" icon={BookOpenCheck}><InlineAlert tone="warning">{t('studentTasks.learnerOnly')}</InlineAlert></LearningShell>
  return <div key={auth.userId!}>{children(auth.userId!)}</div>
}
