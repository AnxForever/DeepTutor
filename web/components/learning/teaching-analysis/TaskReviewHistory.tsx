'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { listTaskReviewRevisions, type SavedTaskReview } from '@/lib/task-reviews-api'
import { isSavedTaskReview, reviewMatchesTask } from '@/lib/task-review-drafts'
import type { TeacherStudentTask } from '@/lib/teacher-student-tasks-api'
import { Button, InlineAlert, StatusChip } from '@/shared/ui'

export function TaskReviewSnapshot({ value }: { value: SavedTaskReview }) {
  const { t, i18n } = useTranslation()
  return <div className="mt-3 grid gap-3 text-sm"><StatusChip tone={value.status === 'withdrawn' ? 'warning' : 'neutral'}>{t(`teacherTaskReviews.${value.status}`)}</StatusChip><p className="text-xs text-muted-foreground">{t('teacherTaskReviews.reviewer', { id: value.reviewer_user_id })} · {t('teacherTaskReviews.recordedAt', { time: new Date(value.recorded_at * 1000).toLocaleString(i18n.language) })}</p>{value.items.map(item => <div key={item.question_id} className="rounded-lg border border-border p-3"><p className="text-xs font-medium">{item.question_id} · {t(`teaching.result.${item.result}`)}</p><p className="mt-2 whitespace-pre-wrap break-words leading-7">{item.feedback || t('teaching.notProvided')}</p></div>)}<div><p className="text-xs text-muted-foreground">{t('teacherTaskReviews.summary')}</p><p className="mt-1 whitespace-pre-wrap break-words leading-7">{value.summary || t('teaching.notProvided')}</p></div><div><p className="text-xs text-muted-foreground">{t('teacherTaskReviews.changeReason')}</p><p className="mt-1 whitespace-pre-wrap break-words leading-7">{value.change_reason || t('teaching.notProvided')}</p></div></div>
}
export function TaskReviewHistory({ task, revision, workspaceId }: { task: TeacherStudentTask; revision: number; workspaceId: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false); const [rows, setRows] = useState<SavedTaskReview[]>([]); const [loading, setLoading] = useState(false); const [failed, setFailed] = useState(false); const [hasMore, setHasMore] = useState(false)
  const next = useRef(0); const read = useRef<AbortController | null>(null)
  const load = useCallback(async (append: boolean) => {
    read.current?.abort(); const controller = new AbortController(); read.current = controller; setLoading(true); setFailed(false)
    const offset = append ? next.current : 0
    try { const values = await listTaskReviewRevisions(task.task_id, { limit: 20, offset }, workspaceId, controller.signal); if (controller.signal.aborted) return; if (!values.every(value => isSavedTaskReview(value) && reviewMatchesTask(value, task))) throw new Error('Review history source mismatch'); setRows(previous => Array.from(new Map([...(append ? previous : []), ...values].map(value => [value.revision, value])).values()).sort((a, b) => b.revision - a.revision)); next.current = offset + values.length; setHasMore(values.length === 20) }
    catch { if (!controller.signal.aborted) setFailed(true) }
    finally { if (!controller.signal.aborted) setLoading(false) }
  }, [task, workspaceId])
  useEffect(() => { if (open) void load(false); return () => read.current?.abort() }, [open, revision, load])
  return <details className="mt-7 rounded-xl border border-border p-4" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary className="cursor-pointer text-sm font-semibold">{t('teacherTaskReviews.history')}</summary>{open && <><p className="mt-3 text-xs leading-6 text-muted-foreground">{t('teacherTaskReviews.historyReadonly')}</p>{failed && <InlineAlert className="mt-3" tone="warning" action={<Button variant="secondary" size="sm" onClick={() => void load(rows.length > 0)}>{t('Retry')}</Button>}>{t('teacherTaskReviews.historyFailed')}</InlineAlert>}{loading && <p role="status" className="mt-3 text-sm">{t('Loading…')}</p>}{!loading && !failed && !rows.length && <p className="mt-3 text-sm text-muted-foreground">{t('teacherTaskReviews.historyEmpty')}</p>}{rows.map(value => <details key={value.revision} className="mt-3 border-t border-border pt-3"><summary className="cursor-pointer text-sm font-medium">{t('teacherTaskReviews.version', { n: value.revision })} · {t(`teacherTaskReviews.${value.status}`)}</summary><TaskReviewSnapshot value={value} /></details>)}{hasMore && <Button className="mt-4" variant="secondary" loading={loading} onClick={() => void load(true)}>{t('teacherTaskReviews.historyMore')}</Button>}</>}</details>
}
