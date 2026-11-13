'use client'

import { useCallback, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStatus } from '@/hooks/useAuthStatus'
import { useActiveWorkspaceId } from '@/hooks/useActiveWorkspaceId'
import { draftUuid } from '@/lib/teaching-draft-validation'
import { InlineAlert } from '@/shared/ui'
import { LearningShell, LearningSkeleton } from '../LearningShell'
import { acceptsStudentCaseCreateSlot, TeachingDraftProvider } from './TeachingDrafts'

export function StudentCaseAccess({ caseId, children }: { caseId?: string; children: (workspaceId: string) => ReactNode }) {
  const auth = useAuthStatus()
  const workspaceId = useActiveWorkspaceId()
  const { t } = useTranslation()
  const acceptsSlot = useCallback((slot: string) => typeof slot === 'string' && (caseId ? slot.startsWith(`student-case:${caseId}:`) : acceptsStudentCaseCreateSlot(slot)), [caseId])
  if (auth.loading) return <LearningShell title={t('teaching.cases.title')} subtitle={t('teaching.cases.subtitle')}><LearningSkeleton count={2} /></LearningShell>
  const unavailable = !auth.statusAvailable || (auth.enabled && !auth.userId)
  if (unavailable || (auth.enabled && !auth.isAdmin) || (caseId !== undefined && !draftUuid(caseId))) return <LearningShell title={t('teaching.cases.title')} subtitle={t('teaching.cases.subtitle')}><InlineAlert tone="warning">{t(unavailable ? 'teaching.accessUnavailable' : auth.enabled && !auth.isAdmin ? 'teaching.adminOnly' : 'teaching.cases.invalidId')}</InlineAlert></LearningShell>
  const namespace = caseId ? `student-case:${caseId}` : 'student-case-create'
  return <TeachingDraftProvider key={`${auth.userId ?? 'local-admin'}:${workspaceId}:${namespace}`} accountId={auth.userId ?? 'local-admin'} workspaceId={workspaceId} namespace={namespace} acceptsSlot={acceptsSlot}>{children(workspaceId)}</TeachingDraftProvider>
}
