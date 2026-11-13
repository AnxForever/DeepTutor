'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, BookOpenCheck, CheckCircle2 } from 'lucide-react'
import { listStudentTasks, studentTasksRoute, type StudentTaskSummary } from '@/lib/student-tasks-api'
import { Button, InlineAlert, StatusChip } from '@/shared/ui'
import { LearningEmptyState, LearningShell, LearningSkeleton } from '../LearningShell'
import { StudentTaskAccess } from './StudentTaskAccess'
import { TaskTranslations } from '../TaskTranslations'

const PAGE_SIZE = 30
export default function StudentTaskListPage() { return <TaskTranslations><StudentTaskAccess>{accountId => <StudentTaskList key={accountId} />}</StudentTaskAccess></TaskTranslations> }
function StudentTaskList() {
  const { t } = useTranslation()
  const [state, setState] = useState<'active' | 'history'>('active')
  const [rows, setRows] = useState<StudentTaskSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const read = useRef<AbortController | null>(null)
  const sequence = useRef(0)
  const nextOffset = useRef(0)
  const load = useCallback(async (append = false) => {
    read.current?.abort()
    const controller = new AbortController(); read.current = controller
    const current = ++sequence.current
    const offset = append ? nextOffset.current : 0
    setLoading(true); setFailed(false)
    try {
      const page = await listStudentTasks({ state, limit: PAGE_SIZE, offset }, controller.signal)
      if (controller.signal.aborted || current !== sequence.current) return
      setRows(previous => Array.from(new Map([...(append ? previous : []), ...page].map(row => [row.task_id, row])).values()))
      nextOffset.current = offset + page.length; setHasMore(page.length === PAGE_SIZE)
    } catch { if (!controller.signal.aborted && current === sequence.current) setFailed(true) }
    finally { if (!controller.signal.aborted && current === sequence.current) setLoading(false) }
  }, [state])
  useEffect(() => { void load(); return () => read.current?.abort() }, [load])
  const first = state === 'active' ? rows.find(row => row.status === 'pending' || row.status === 'in_progress') : null
  return <LearningShell back={false} title={t('studentTasks.title')} subtitle={t('studentTasks.subtitle')} icon={BookOpenCheck} className="student-task-page">
    <div className="mx-auto max-w-2xl">
      <div className="mb-6 flex flex-wrap gap-2" role="group" aria-label={t('studentTasks.title')}>{(['active', 'history'] as const).map(value => <Button key={value} size="lg" variant={state === value ? 'primary' : 'secondary'} aria-pressed={state === value} onClick={() => { if (value !== state) { setRows([]); nextOffset.current = 0; setState(value) } }}>{t(`studentTasks.${value}`)}</Button>)}</div>
      {failed && <InlineAlert tone="warning" className="mb-5" action={<Button variant="secondary" onClick={() => void load(rows.length > 0)}>{t('studentTasks.retry')}</Button>}>{t('studentTasks.listFailed')}</InlineAlert>}
      {loading && !rows.length ? <LearningSkeleton count={2} /> : <>
        {first && <section className="mb-5 rounded-2xl border border-primary/25 bg-primary/5 p-6 sm:p-8"><p className="text-sm text-muted-foreground">{t(`studentTasks.${first.status === 'in_progress' ? 'inProgress' : 'pending'}`)}</p><h2 className="mt-2 break-words text-2xl font-semibold leading-snug">{first.title}</h2><p className="mt-2 text-base text-muted-foreground">{t('studentTasks.questionCount', { count: first.question_count })}</p><Link href={studentTasksRoute(first.task_id)} prefetch={false} className="mt-6 inline-flex min-h-14 items-center justify-center gap-3 rounded-xl bg-primary px-6 text-lg font-semibold text-primary-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">{t(first.status === 'in_progress' ? 'studentTasks.continue' : 'studentTasks.start')}<ArrowRight size={22} aria-hidden /></Link></section>}
        <div className="grid gap-3">{rows.filter(row => row.task_id !== first?.task_id).map(row => <Link key={row.task_id} href={studentTasksRoute(row.task_id)} prefetch={false} className="flex min-w-0 items-center justify-between gap-4 rounded-2xl border border-border bg-card p-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"><span className="min-w-0 flex-1"><span className="block break-words text-lg font-semibold">{row.title}</span><span className="mt-2 block text-sm text-muted-foreground">{t('studentTasks.questionCount', { count: row.question_count })}</span><StatusChip className="mt-3">{t(row.status === 'in_progress' ? 'studentTasks.inProgress' : `studentTasks.${row.status}`)}</StatusChip></span>{row.status === 'submitted' ? <CheckCircle2 size={24} aria-hidden className="shrink-0 text-success" /> : <ArrowRight size={24} aria-hidden className="shrink-0 text-muted-foreground" />}</Link>)}</div>
        {!rows.length && !failed && <LearningEmptyState title={t(state === 'active' ? 'studentTasks.none' : 'studentTasks.noHistory')} icon={<BookOpenCheck size={32} />} />}
      </>}
      {hasMore && <Button className="mt-6 w-full" size="lg" variant="secondary" loading={loading} onClick={() => void load(true)}>{t('studentTasks.loadMore')}</Button>}
    </div>
  </LearningShell>
}
