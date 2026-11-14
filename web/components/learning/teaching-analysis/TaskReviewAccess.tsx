'use client'

import { useCallback, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStatus } from '@/hooks/useAuthStatus'
import { useActiveWorkspaceId } from '@/hooks/useActiveWorkspaceId'
import { draftUuid } from '@/lib/teaching-draft-validation'
import { InlineAlert } from '@/shared/ui'
import { LearningShell, LearningSkeleton } from '../LearningShell'
import { TeachingDraftProvider } from './TeachingDrafts'

export function TaskReviewAccess({ taskId, children }: { taskId: string; children: (workspaceId: string, canWrite: boolean) => ReactNode }) {
  const auth = useAuthStatus(); const workspaceId = useActiveWorkspaceId(); const { t } = useTranslation()
  const acceptsSlot = useCallback((slot: string) => typeof slot === 'string' && slot.startsWith(`task-review:${taskId}:`), [taskId])
  if (auth.loading) return <LearningShell back={false} title={t('teacherTaskReviews.title')} subtitle={t('teacherTaskReviews.loading')}><LearningSkeleton count={2} /></LearningShell>
  const unavailable = !auth.statusAvailable || auth.enabled && !auth.userId
  if (unavailable || auth.enabled && !auth.isAdmin || !draftUuid(taskId)) return <LearningShell back={false} title={t('teacherTaskReviews.title')} subtitle=""><InlineAlert tone="warning">{t(unavailable ? 'teaching.accessUnavailable' : auth.enabled && !auth.isAdmin ? 'teaching.adminOnly' : 'teacherTaskReviews.invalidSource')}</InlineAlert></LearningShell>
  return <TeachingDraftProvider key={`${auth.userId ?? 'local-admin'}:${workspaceId}:task-review:${taskId}`} accountId={auth.userId ?? 'local-admin'} workspaceId={workspaceId} namespace={`task-review:${taskId}`} acceptsSlot={acceptsSlot}>{children(workspaceId, auth.enabled && auth.authenticated && auth.isAdmin && Boolean(auth.userId))}</TeachingDraftProvider>
}
