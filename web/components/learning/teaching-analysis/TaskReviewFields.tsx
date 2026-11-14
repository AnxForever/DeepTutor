'use client'

import { useTranslation } from 'react-i18next'
import Markdown from '@/components/common/MarkdownRenderer'
import type { TaskReviewEditor } from '@/lib/task-reviews-api'
import type { TeacherStudentTask } from '@/lib/teacher-student-tasks-api'
import { Field, InlineAlert, StatusChip } from '@/shared/ui'
import { controlClass } from './AssignmentEditor'

const results = ['correct', 'partial', 'incorrect', 'ungraded'] as const
function SourceText({ text }: { text: string | null | undefined }) { const { t } = useTranslation(); return text ? <Markdown content={text} allowHtml={false} enableImages={false} enableMermaid={false} enableCode={false} /> : <span>{t('teaching.notProvided')}</span> }
export function TaskReviewFields({ task, value, disabled, onChange }: { task: TeacherStudentTask; value: TaskReviewEditor; disabled: boolean; onChange: (value: TaskReviewEditor) => void }) {
  const { t } = useTranslation()
  const submission = task.submission!
  const usage = submission.hint_usage ?? null
  return <div className="grid gap-5">{task.source_snapshot.questions.map(question => {
    const response = submission.responses.find(entry => entry.question_id === question.question_id)!
    const review = value.items.find(entry => entry.question_id === question.question_id)!
    const actualAnswer = Boolean(response.answer?.trim())
    const hints = task.question_hints?.find(entry => entry.question_id === question.question_id)?.hints ?? []
    const unlocked = usage?.find(entry => entry.question_id === question.question_id)?.revealed ?? []
    const update = (change: Partial<typeof review>) => onChange({ ...value, items: value.items.map(entry => entry.question_id === question.question_id ? { ...entry, ...change } : entry) })
    return <section key={question.question_id} aria-label={question.question_id} className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5"><h3 className="text-base font-semibold">{question.question_id}</h3><dl className="mt-3 grid gap-4"><div><dt className="text-xs font-medium text-muted-foreground">{t('teacherTaskReviews.question')}</dt><dd className="mt-1 break-words text-sm leading-7"><SourceText text={question.question} /></dd></div><div><dt className="text-xs font-medium text-muted-foreground">{t('teacherTaskReviews.answer')}</dt><dd className="mt-1 whitespace-pre-wrap break-words border-l-2 border-primary/30 bg-muted/30 p-3 text-sm leading-7">{response.answer ?? t('teaching.notProvided')}</dd></div></dl><div className="mt-3 flex flex-wrap gap-2"><StatusChip>{t(`teacherTasks.response.${response.response_status}`)}</StatusChip><StatusChip>{t(`teaching.assistanceStatus.${response.assistance}`)}</StatusChip></div>
      <details className="mt-4 rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">{t('teacherTaskReviews.reference')} · {t('teacherTaskReviews.rubric')}</summary><dl className="mt-3 grid gap-3 text-sm leading-7"><div><dt className="text-xs text-muted-foreground">{t('teacherTaskReviews.reference')}</dt><dd><SourceText text={question.reference_answer} /></dd></div><div><dt className="text-xs text-muted-foreground">{t('teacherTaskReviews.rubric')}</dt><dd><SourceText text={question.rubric} /></dd></div></dl></details>
      <details className="mt-3 rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">{t('teacherTaskReviews.hints')}</summary><p className="mt-2 text-xs leading-6 text-muted-foreground">{t(usage === null ? 'teacherTaskReviews.hintUnknown' : unlocked.length ? 'teacherTaskReviews.hintUsed' : 'teacherTaskReviews.noHintUsed', { count: unlocked.length })}</p>{hints.length > 0 && <ol className="mt-2 grid gap-2">{hints.map((hint, index) => <li key={index}><p className="text-xs font-medium text-muted-foreground">{t('teacherTaskReviews.hintLevel', { level: index + 1 })}</p><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-7">{hint}</p></li>)}</ol>}</details>
      {!actualAnswer && <InlineAlert className="mt-4">{t('teacherTaskReviews.blankUngraded')}</InlineAlert>}
      <div className="mt-5 grid gap-4 sm:grid-cols-[minmax(140px,0.35fr)_1fr]"><Field label={`${t('teacherTaskReviews.result')} · ${question.question_id}`}><select className={controlClass} value={review.result} disabled={disabled} onChange={event => update({ result: event.target.value as typeof review.result })}>{results.map(result => <option key={result} value={result} disabled={!actualAnswer && result !== 'ungraded'}>{t(`teaching.result.${result}`)}</option>)}</select></Field><Field label={`${t('teacherTaskReviews.feedback')} · ${question.question_id}`}><textarea className={controlClass} rows={3} maxLength={2000} value={review.feedback} disabled={disabled} onChange={event => update({ feedback: event.target.value })} /></Field></div>
    </section>
  })}<Field label={t('teacherTaskReviews.summary')}><textarea className={controlClass} rows={3} maxLength={3000} value={value.summary} disabled={disabled} onChange={event => onChange({ ...value, summary: event.target.value })} /></Field><Field label={t('teacherTaskReviews.changeReason')} hint={t('teacherTaskReviews.reasonHint')}><textarea className={controlClass} rows={2} maxLength={2000} value={value.change_reason} disabled={disabled} onChange={event => onChange({ ...value, change_reason: event.target.value })} /></Field></div>
}
