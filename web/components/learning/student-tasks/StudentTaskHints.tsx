'use client'

import { useTranslation } from 'react-i18next'
import { Lightbulb } from 'lucide-react'
import { Button, InlineAlert } from '@/shared/ui'
import type { StudentTaskHintsController } from '@/hooks/useStudentTaskHints'

export default function StudentTaskHints({ hints, questionId, disabled = false, voiceBlocked = false, readOnly = false }: { hints: StudentTaskHintsController; questionId: string; disabled?: boolean; voiceBlocked?: boolean; readOnly?: boolean }) {
  const { t } = useTranslation()
  const question = hints.state?.questions.find(value => value.question_id === questionId)
  if (question?.total === 0 && !hints.message) return null
  if (readOnly && question?.revealed.length === 0) return null
  const remaining = question ? question.revealed.length < question.total : false
  const unavailable = hints.message === 'unavailable' || hints.message === 'retry'
  return <section aria-label={t('studentTaskHints.title')} className="my-5 rounded-xl border border-border bg-muted/20 p-4 sm:p-5">
    {hints.loading && !question && <p role="status" className="text-sm text-muted-foreground">{t('studentTaskHints.loading')}</p>}
    {question && <><h3 className="text-base font-semibold">{t('studentTaskHints.title')}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{t('studentTaskHints.usageNote')}</p><ol className="mt-3 grid gap-3">{question.revealed.map(hint => <li key={hint.level} className="rounded-lg border border-border bg-background p-3"><p className="text-sm font-medium text-muted-foreground">{t('studentTaskHints.level', { level: hint.level })}</p><p className="mt-1 whitespace-pre-wrap break-words text-lg leading-8">{hint.text}</p></li>)}</ol><p className="mt-3 text-sm text-muted-foreground">{t('studentTaskHints.opened', { count: question.revealed.length, total: question.total })}</p></>}
    {hints.message && <InlineAlert className="mt-3" tone={unavailable ? 'warning' : 'info'}>{t(`studentTaskHints.${hints.message === 'retry' ? 'retryHint' : hints.message}`)}</InlineAlert>}
    {!readOnly && <div className="mt-3 flex flex-wrap gap-2">{remaining && !hints.pendingRetry && !hints.denied && <Button size="lg" variant="secondary" icon={<Lightbulb size={18} />} loading={hints.busy} disabled={disabled || voiceBlocked || hints.busy || hints.loading || hints.requiresRefresh} onClick={hints.reveal}>{t(question?.revealed.length ? 'studentTaskHints.next' : 'studentTaskHints.first')}</Button>}{hints.pendingRetry && <Button size="lg" variant="secondary" disabled={disabled || voiceBlocked || hints.busy || hints.loading} loading={hints.busy} onClick={hints.retry}>{t('studentTaskHints.retry')}</Button>}</div>}
    {(unavailable || hints.requiresRefresh) && <Button className="mt-3" variant="ghost" disabled={hints.busy || hints.loading} onClick={() => void hints.reconcile()}>{t('studentTaskHints.refresh')}</Button>}
    {hints.busy && <p role="status" className="mt-3 text-sm text-muted-foreground">{t('studentTaskHints.opening')}</p>}
    {hints.busy && <Button className="mt-3" size="lg" variant="secondary" onClick={hints.tryAlone}>{t('studentTaskHints.tryAlone')}</Button>}
    {!readOnly && remaining && voiceBlocked && <p className="mt-3 text-sm leading-6 text-muted-foreground">{t('studentTaskHints.voiceBlocked')}</p>}
    {!readOnly && question && question.total > 0 && !remaining && <p className="mt-3 text-sm leading-6 text-muted-foreground">{t('studentTaskHints.finished')}</p>}
  </section>
}
