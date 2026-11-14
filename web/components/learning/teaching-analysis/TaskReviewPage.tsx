'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ClipboardCheck, Download } from 'lucide-react'
import { getTeacherStudentTask, type TeacherStudentTask } from '@/lib/teacher-student-tasks-api'
import { getTaskReviewState, type TaskReviewState } from '@/lib/task-reviews-api'
import { useTaskReviewEditor, validReviewState } from '@/hooks/useTaskReviewEditor'
import { scopedUrl } from '@/lib/workspace-scope'
import { Button, Dialog, Field, InlineAlert, StatusChip } from '@/shared/ui'
import { LearningShell, LearningSkeleton } from '../LearningShell'
import { TaskTranslations } from '../TaskTranslations'
import { TaskReviewAccess } from './TaskReviewAccess'
import { TaskReviewFields } from './TaskReviewFields'
import { TaskReviewHistory } from './TaskReviewHistory'
import { TaskReviewCaseLinker } from './TaskReviewCaseLinker'
import { controlClass } from './AssignmentEditor'

export default function TaskReviewPage({ taskId }: { taskId: string }) {
  return <TaskTranslations><TaskReviewAccess taskId={taskId}>{(workspaceId, canWrite) => <ReviewLoader key={`${workspaceId}:${taskId}`} taskId={taskId} workspaceId={workspaceId} canWrite={canWrite} />}</TaskReviewAccess></TaskTranslations>
}
function ReviewLoader({ taskId, workspaceId, canWrite }: { taskId: string; workspaceId: string; canWrite: boolean }) {
  const { t } = useTranslation()
  const [data, setData] = useState<{ task: TeacherStudentTask; state: TaskReviewState } | null>(null)
  const [issue, setIssue] = useState<'sourceFailed' | 'invalidSource' | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void Promise.allSettled([getTeacherStudentTask(taskId, workspaceId, controller.signal), getTaskReviewState(taskId, workspaceId, controller.signal)]).then(([task, state]) => {
      if (controller.signal.aborted) return
      if (task.status !== 'fulfilled' || state.status !== 'fulfilled') { setIssue('sourceFailed'); return }
      if (task.value.task_id !== taskId || !validReviewState(state.value, task.value) || task.value.submission && task.value.submission.task_id !== taskId) { setIssue('invalidSource'); return }
      setData({ task: task.value, state: state.value }); setIssue(null)
    })
    return () => controller.abort()
  }, [taskId, workspaceId, retry])
  if (!data || issue) return <LearningShell back={false} title={t('teacherTaskReviews.title')} subtitle={t('teacherTaskReviews.loading')} icon={ClipboardCheck}>
    {issue ? <InlineAlert tone="warning" action={<Button variant="secondary" onClick={() => { setIssue(null); setRetry(value => value + 1) }}>{t('Retry')}</Button>}>{t(`teacherTaskReviews.${issue}`)}</InlineAlert> : <LearningSkeleton count={2} />}
  </LearningShell>
  if (!data.task.submission) return <LearningShell back={false} title={t('teacherTaskReviews.title')} subtitle={data.task.title} icon={ClipboardCheck}><InlineAlert>{t('teacherTaskReviews.noSubmission')}</InlineAlert></LearningShell>
  return <ReviewWorkspace task={data.task} initial={data.state} workspaceId={workspaceId} canWrite={canWrite} />
}
function ReviewWorkspace({ task, initial, workspaceId, canWrite }: { task: TeacherStudentTask; initial: TaskReviewState; workspaceId: string; canWrite: boolean }) {
  const { t, i18n } = useTranslation()
  const editor = useTaskReviewEditor(task, initial, workspaceId, canWrite)
  const { draft, head } = editor
  const pending = draft.pending !== null
  const conflict = editor.conflict || editor.error === 'conflict'
  // The linker's own unsaved selection locks review actions, not the linker.
  const canLink = canWrite && head?.status === 'confirmed' && editor.headVerified && !editor.dirty && editor.busy === null && !draft.pending && !draft.acknowledged && !draft.editing && !conflict
  const newerLinkSource = editor.linkerReview && (editor.linkerReview.revision !== head?.revision || editor.linkerReview.status !== head?.status)
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json;charset=utf-8' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `task-review-${task.task_id.slice(0, 8)}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  const error = editor.error && !['conflict', 'headUnverified'].includes(editor.error) ? editor.error : null
  return <LearningShell back={false} title={t('teacherTaskReviews.title')} subtitle={t('teacherTaskReviews.subtitle')} icon={ClipboardCheck} action={<Link href={scopedUrl('/learning/teaching-analysis', workspaceId)} className="inline-flex min-h-10 items-center rounded-xl border border-border px-4 text-sm">{t('teacherTaskReviews.back')}</Link>}>
    <div className="mb-5 flex flex-wrap items-center gap-2"><StatusChip>{draft.editor.expected_revision ? t('teacherTaskReviews.version', { n: draft.editor.expected_revision }) : t('teacherTaskReviews.new')}</StatusChip>{head && <StatusChip tone={head.status === 'withdrawn' ? 'warning' : 'neutral'}>{t(`teacherTaskReviews.${head.status}`)}</StatusChip>}<StatusChip>{t(`teacherTasks.status.${initial.task_status}`)}</StatusChip></div>
    <section className="mb-6 rounded-xl border border-border bg-card p-4 sm:p-5" aria-label={t('teacherTaskReviews.original')}>
      <h2 className="text-lg font-semibold">{task.title}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{t('teacherTaskReviews.originalHint')}</p>
      <p className="mt-3 break-words text-xs text-muted-foreground">{t('teacherTaskReviews.account', { id: task.recipient_user_id })}</p><p className="mt-1 text-xs text-muted-foreground">{t('teacherTaskReviews.submittedAt', { time: new Date(task.submission!.submitted_at * 1000).toLocaleString(i18n.language) })}</p><p className="mt-3 text-sm"><span className="text-muted-foreground">{t('teacherTaskReviews.knowledgePoint')} · </span>{task.source_snapshot.knowledge_point || t('teacherTaskReviews.notLabelled')}</p>
    </section>
    {!canWrite && <InlineAlert className="mb-4">{t('teacherTaskReviews.authRequired')}</InlineAlert>}
    {editor.notice && <InlineAlert className="mb-4" tone="success">{t(`teacherTaskReviews.${editor.notice.key}`, { n: editor.notice.revision })}</InlineAlert>}
    {error && <InlineAlert className="mb-4" tone="warning">{t(`teacherTaskReviews.${error}`)}</InlineAlert>}
    {editor.cleanupFailed && <InlineAlert className="mb-4" tone="warning" action={<Button size="sm" variant="secondary" onClick={editor.retryCleanup}>{t('teacherTaskReviews.retryCleanup')}</Button>}>{t('teacherTaskReviews.savedLocalPending')}</InlineAlert>}
    {conflict && <InlineAlert className="mb-4" tone="warning" action={<Button variant="secondary" disabled={editor.busy !== null || editor.linkerDirty} onClick={editor.requestReload}>{t('teacherTaskReviews.reload')}</Button>}>{t('teacherTaskReviews.conflict')}</InlineAlert>}
    {!editor.headVerified && <InlineAlert className="mb-4" tone="warning" action={<Button variant="secondary" disabled={editor.busy !== null || editor.linkerDirty} onClick={() => void editor.checkLatest()}>{t('teacherTaskReviews.checkLatest')}</Button>}>{t('teacherTaskReviews.headUnverified')}</InlineAlert>}
    {editor.linkerDirty && <InlineAlert className="mb-4">{t('teacherTaskReviews.linkerPending')}</InlineAlert>}
    <TaskReviewFields task={task} value={draft.editor} disabled={!canWrite || !draft.editing || editor.locked} onChange={editor.update} />
    <p className="mt-5 text-xs leading-6 text-muted-foreground">{t('teacherTaskReviews.teacherOnly')}</p>
    <div className="mt-4 flex flex-wrap gap-3">
      {canWrite && (draft.editing ? <><Button loading={editor.busy === 'save'} disabled={editor.locked || !editor.headVerified || conflict} onClick={editor.save}>{t('teacherTaskReviews.save')}</Button>{head && <Button variant="secondary" disabled={editor.busy !== null || pending || editor.linkerDirty} onClick={editor.requestReload}>{t('teacherTaskReviews.cancelEdit')}</Button>}</> : <Button disabled={editor.locked || !editor.headVerified || conflict} onClick={editor.startEditing}>{t(head?.status === 'withdrawn' ? 'teacherTaskReviews.restore' : 'teacherTaskReviews.edit')}</Button>)}
      {canWrite && head?.status === 'confirmed' && <Button variant="secondary" disabled={editor.locked || editor.dirty || draft.editing || !editor.headVerified || conflict} onClick={editor.openWithdraw}>{t('teacherTaskReviews.withdraw')}</Button>}
      <Button variant="ghost" icon={<Download size={15} />} onClick={download}>{t('teacherTaskReviews.export')}</Button>
    </div>
    {(pending || draft.acknowledged && !editor.headVerified) && <div className="mt-3 flex flex-wrap gap-3">{canWrite && pending && <Button variant="secondary" loading={editor.busy === draft.pending?.kind} disabled={editor.busy !== null || editor.linkerDirty} onClick={editor.retry}>{t('teacherTaskReviews.retry')}</Button>}<Button variant="secondary" disabled={editor.busy !== null || editor.linkerDirty} onClick={() => void editor.checkReceipt()}>{t('teacherTaskReviews.checkReceipt')}</Button><Button variant="ghost" disabled={editor.busy !== null || editor.linkerDirty} onClick={editor.requestReload}>{t('teacherTaskReviews.reload')}</Button></div>}
    {editor.busy && !draft.withdrawing && <Button className="mt-3" variant="secondary" onClick={editor.stopWaiting}>{t('teacherTaskReviews.stopRequest')}</Button>}
    {editor.linkerReview && <section className="mt-7">{newerLinkSource && <InlineAlert tone="warning" className="mb-3">{t('teacherTaskReviews.linkerSourceChanged')}</InlineAlert>}<TaskReviewCaseLinker task={task} review={editor.linkerReview} workspaceId={workspaceId} disabled={!canLink || editor.linkerReview.status !== 'confirmed'} onDirtyChange={editor.onLinkerDirtyChange} /></section>}
    <TaskReviewHistory task={task} revision={head?.revision ?? 0} workspaceId={workspaceId} />
    <Dialog open={editor.reloadOpen} title={t('teacherTaskReviews.replaceTitle')} closeLabel={t('Close')} busy={editor.busy === 'reload'} onClose={() => editor.setReloadOpen(false)} footer={<><Button variant="secondary" disabled={editor.busy !== null} onClick={() => editor.setReloadOpen(false)}>{t('teacherTaskReviews.keepEditing')}</Button><Button loading={editor.busy === 'reload'} disabled={editor.linkerDirty} onClick={() => void editor.reload()}>{t('teacherTaskReviews.reload')}</Button></>}>
      <p className="text-sm leading-7">{t('teacherTaskReviews.replaceHint')}</p><Button className="mt-3" variant="ghost" onClick={download}>{t('teacherTaskReviews.export')}</Button>{editor.error && <p role="alert" className="mt-3 text-sm text-destructive">{t(`teacherTaskReviews.${editor.error}`)}</p>}{editor.busy && <Button className="mt-3" variant="secondary" onClick={editor.stopWaiting}>{t('teacherTaskReviews.stopRequest')}</Button>}
    </Dialog>
    <Dialog open={canWrite && draft.withdrawing} title={t('teacherTaskReviews.withdrawTitle')} closeLabel={t('Close')} busy={editor.busy !== null} onClose={editor.closeWithdraw} footer={<><Button variant="secondary" disabled={editor.busy !== null || pending} onClick={editor.closeWithdraw}>{t('Cancel')}</Button><Button variant="danger" loading={editor.busy === 'withdraw'} disabled={editor.busy !== null || pending || editor.linkerDirty} onClick={editor.withdraw}>{t('teacherTaskReviews.withdrawConfirm')}</Button></>}>
      <p className="text-sm leading-7">{t('teacherTaskReviews.withdrawHint')}</p><Field className="mt-4" label={t('teacherTaskReviews.withdrawReason')}><textarea className={controlClass} rows={3} maxLength={2000} value={draft.withdraw_reason} disabled={editor.busy !== null || pending} onChange={event => editor.setWithdrawReason(event.target.value)} /></Field>{editor.error && <InlineAlert className="mt-3" tone="warning">{t(`teacherTaskReviews.${editor.error}`)}</InlineAlert>}{pending && <div className="mt-3 flex flex-wrap gap-2"><Button variant="secondary" disabled={editor.busy !== null} onClick={editor.retry}>{t('teacherTaskReviews.retry')}</Button><Button variant="secondary" disabled={editor.busy !== null} onClick={() => void editor.checkReceipt()}>{t('teacherTaskReviews.checkReceipt')}</Button><Button variant="ghost" disabled={editor.busy !== null} onClick={editor.requestReload}>{t('teacherTaskReviews.reload')}</Button></div>}{editor.busy && <Button className="mt-3" variant="secondary" onClick={editor.stopWaiting}>{t('teacherTaskReviews.stopRequest')}</Button>}
    </Dialog>
  </LearningShell>
}
