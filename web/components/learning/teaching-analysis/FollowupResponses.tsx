'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Field, StatusChip } from '@/shared/ui'
import type {
  FollowupQuestion, SavedFollowup, SavedFollowupAttempt, SaveFollowupAttemptRequest,
} from '@/lib/teaching-followups-api'
import { controlClass } from './AssignmentEditor'
import { useTeachingDraftSlot } from './TeachingDrafts'
import { followupResponseSlot, isFollowupResponseDraft, sameFollowupQuestion, type FollowupResponseDraft } from '@/lib/teaching-followup-drafts'

function emptyAttempt(set: SavedFollowup, question: FollowupQuestion): SaveFollowupAttemptRequest {
  return {
    attempt_id: crypto.randomUUID(), followup_revision: set.revision, question_id: question.question_id,
    student_answer: null, student_work: null, answer_status: 'unknown', assistance: 'unknown',
    teacher_result: 'ungraded', teacher_feedback: '',
  }
}

function hasResponse(value: SaveFollowupAttemptRequest) {
  return value.answer_status === 'confirmed_blank' || Boolean(value.student_answer?.trim() || value.student_work?.trim() || value.teacher_feedback.trim())
}

function hasDraftChanges(value: SaveFollowupAttemptRequest) {
  return Boolean(value.student_answer?.trim() || value.student_work?.trim() || value.teacher_feedback.trim()) ||
    value.answer_status !== 'unknown' || value.assistance !== 'unknown' || value.teacher_result !== 'ungraded'
}

export function FollowupQuestionSnapshot({ question, guidanceExpanded = false }: { question: FollowupQuestion; guidanceExpanded?: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="min-w-0 text-sm">
      <p className="font-medium">{question.question_id}</p>
      <p className="mt-1 whitespace-pre-wrap break-words leading-6">{question.question}</p>
      {(question.reference_answer || question.rubric) && (guidanceExpanded ? <div className="mt-3 text-muted-foreground">
        {question.reference_answer && <p className="whitespace-pre-wrap break-words">{question.reference_answer}</p>}
        {question.rubric && <p className="mt-2 whitespace-pre-wrap break-words">{question.rubric}</p>}
      </div> : <details className="mt-3 rounded-lg bg-muted/40 p-3">
        <summary className="cursor-pointer text-xs font-medium">{t('teaching.followups.questionSnapshot')}</summary>
        {question.reference_answer && <p className="mt-2 whitespace-pre-wrap break-words">{question.reference_answer}</p>}
        {question.rubric && <p className="mt-2 whitespace-pre-wrap break-words text-muted-foreground">{question.rubric}</p>}
      </details>)}
    </div>
  )
}

export function FollowupResponseForm({ set, question, disabled, canSubmit = true, onSubmit, onDirtyChange, onReset }: {
  set: SavedFollowup
  question: FollowupQuestion
  disabled: boolean
  canSubmit?: boolean
  onSubmit: (payload: SaveFollowupAttemptRequest) => Promise<SavedFollowupAttempt | null>
  onDirtyChange: (questionId: string, dirty: boolean) => void
  onReset?: () => void
}) {
  const { t } = useTranslation()
  const [form, setForm] = useState(() => emptyAttempt(set, question))
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [working, setWorking] = useState<'record' | 'clear' | null>(null)
  const submittedRef = useRef<string | null>(null)
  const submittingRef = useRef(false)
  const alive = useRef(true)
  const questionId = question.question_id
  const controlsDisabled = disabled || working !== null
  const dirty = hasDraftChanges(form)
  const responseDraft = useMemo<FollowupResponseDraft>(() => ({
    kind: 'followup-response', version: 1, followup_id: set.followup_id, followup_revision: set.revision,
    question_id: questionId, question_snapshot: question, payload: form,
  }), [form, question, questionId, set.followup_id, set.revision])
  const slot = useTeachingDraftSlot<FollowupResponseDraft>({
    slot: followupResponseSlot(set.followup_id, set.revision, questionId), value: responseDraft, dirty,
    validate: (value): value is FollowupResponseDraft => isFollowupResponseDraft(value) && value.followup_id === set.followup_id && value.followup_revision === set.revision && value.question_id === questionId && sameFollowupQuestion(value.question_snapshot, question),
    onRestore(value) {
      setForm(value.payload)
      // Whether a past request reached the server is unknown. Keep this UUID
      // for an unchanged retry, and use a new intent if the teacher edits it.
      submittedRef.current = JSON.stringify(value.payload)
      setError('')
      setNotice(t('teaching.followups.responseRestored'))
    },
  })

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    // Hydration can precede StrictMode's effect cleanup. Reassert the actual
    // form state on every setup so a replay cannot make pending input clean.
    onDirtyChange(questionId, dirty)
    return () => onDirtyChange(questionId, false)
  }, [dirty, onDirtyChange, questionId])

  function update(change: Partial<SaveFollowupAttemptRequest>) {
    const next = { ...form, ...change }
    // A retry keeps its submission identity. Editing a failed submission is a
    // different explicit submission intent, never an overwrite of the old one.
    if (submittedRef.current && JSON.stringify(next) !== submittedRef.current) {
      next.attempt_id = crypto.randomUUID()
      submittedRef.current = null
    }
    setForm(next)
    setError('')
    setNotice('')
  }

  async function clearResponse() {
    if (controlsDisabled || submittingRef.current) return
    submittingRef.current = true
    setWorking('clear')
    try {
      await slot.clear()
      if (!alive.current) return
      setForm(emptyAttempt(set, question))
      submittedRef.current = null
      setError('')
      setNotice('')
      onReset?.()
    } catch {
      if (alive.current) setError(t('teaching.followups.localClearFailed'))
    } finally { submittingRef.current = false; if (alive.current) setWorking(null) }
  }

  function updateText(field: 'student_answer' | 'student_work', text: string) {
    const next = { ...form, [field]: text.trim() ? text : null }
    const present = Boolean(next.student_answer?.trim() || next.student_work?.trim())
    update({ [field]: next[field], answer_status: present ? 'present' : 'unknown', ...(!present ? { teacher_result: 'ungraded' } : {}) })
  }

  async function submit() {
    if (!canSubmit || controlsDisabled || submittingRef.current) return
    if (!hasResponse(form)) { setError(t('teaching.followups.attemptMissing')); return }
    if ((form.answer_status !== 'present' && form.teacher_result !== 'ungraded') ||
      (form.answer_status === 'present' && !form.student_answer?.trim() && !form.student_work?.trim())) {
      setError(t('teaching.followups.attemptInvalid')); return
    }
    submittingRef.current = true
    setWorking('record')
    submittedRef.current = JSON.stringify(form)
    try {
      const saved = await onSubmit(form)
      if (!saved) return
      try { await slot.clear() } catch {
        if (alive.current) setError(t('teaching.followups.recordedLocalPending'))
        return
      }
      if (!alive.current) return
      setForm(emptyAttempt(set, question))
      submittedRef.current = null
      setNotice(t('teaching.followups.recorded'))
      setError('')
    } finally { submittingRef.current = false; if (alive.current) setWorking(null) }
  }

  return (
    <article className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <FollowupQuestionSnapshot question={question} />
      <fieldset disabled={controlsDisabled} className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label={t('teaching.followups.answerStatus', { id: questionId })}>
          <select className={controlClass} value={form.answer_status} onChange={event => {
            const answer_status = event.target.value as SaveFollowupAttemptRequest['answer_status']
            update({ answer_status, ...(answer_status === 'confirmed_blank' ? { student_answer: '', student_work: '', teacher_result: 'ungraded' } : answer_status === 'unknown' ? { student_answer: null, student_work: null, teacher_result: 'ungraded' } : {}) })
          }}>
            {(['present', 'confirmed_blank', 'unknown'] as const).map(value => <option key={value} value={value}>{t(`teaching.answerStatus.${value}`)}</option>)}
          </select>
        </Field>
        <Field label={t('teaching.followups.assistance', { id: questionId })}>
          <select className={controlClass} value={form.assistance} onChange={event => update({ assistance: event.target.value as SaveFollowupAttemptRequest['assistance'] })}>
            {(['independent', 'assisted', 'unknown'] as const).map(value => <option key={value} value={value}>{t(`teaching.assistanceStatus.${value}`)}</option>)}
          </select>
        </Field>
        <Field label={t('teaching.followups.answer', { id: questionId })}>
          <textarea className={controlClass} rows={2} maxLength={6000} disabled={form.answer_status === 'confirmed_blank'} value={form.student_answer ?? ''} onChange={event => updateText('student_answer', event.target.value)} />
        </Field>
        <Field label={t('teaching.followups.work', { id: questionId })}>
          <textarea className={controlClass} rows={2} maxLength={8000} disabled={form.answer_status === 'confirmed_blank'} value={form.student_work ?? ''} onChange={event => updateText('student_work', event.target.value)} />
        </Field>
        <Field label={t('teaching.followups.teacherResult', { id: questionId })}>
          <select className={controlClass} disabled={form.answer_status !== 'present'} value={form.teacher_result} onChange={event => update({ teacher_result: event.target.value as SaveFollowupAttemptRequest['teacher_result'] })}>
            {(['ungraded', 'correct', 'partial', 'incorrect'] as const).map(value => <option key={value} value={value}>{t(`teaching.result.${value}`)}</option>)}
          </select>
        </Field>
        <Field label={t('teaching.followups.teacherFeedback', { id: questionId })}>
          <textarea className={controlClass} rows={2} maxLength={4000} value={form.teacher_feedback} onChange={event => update({ teacher_feedback: event.target.value })} />
        </Field>
      </fieldset>
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="mt-3 text-sm text-success-foreground">{notice}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" loading={working === 'record'} disabled={controlsDisabled || !canSubmit} onClick={() => void submit()}>{t('teaching.followups.record', { id: questionId })}</Button>
        <Button size="sm" variant="ghost" loading={working === 'clear'} disabled={controlsDisabled} onClick={() => void clearResponse()}>{t('teaching.followups.clearResponse')}</Button>
      </div>
    </article>
  )
}

export function FollowupResponseHistory({ attempts, disabled, onVoid }: {
  attempts: SavedFollowupAttempt[]
  disabled: boolean
  onVoid: (attempt: SavedFollowupAttempt) => void
}) {
  const { t, i18n } = useTranslation()
  const date = (timestamp: number) => new Date(timestamp * 1000).toLocaleString(i18n.language)
  return (
    <section className="mt-6" aria-label={t('teaching.followups.attemptHistory', { n: attempts.length })}>
      <h4 className="text-sm font-semibold">{t('teaching.followups.attemptHistory', { n: attempts.length })}</h4>
      {!attempts.length && <p className="mt-3 text-sm text-muted-foreground">{t('teaching.followups.noAttempts')}</p>}
      <ol className="mt-3 grid gap-3">
        {attempts.map(attempt => (
          <li key={attempt.attempt_id} className="rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h5 className="text-sm font-medium">{t('teaching.followups.attemptVersion', { id: attempt.question_id, n: attempt.followup_revision })}</h5>
              <time className="text-xs text-muted-foreground" dateTime={new Date(attempt.created_at * 1000).toISOString()}>{date(attempt.created_at)}</time>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t('teaching.followups.source', { student: attempt.student_ref, assignment: attempt.assignment_ref, n: attempt.report_revision })}</p>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              {attempt.voided_at !== null && <StatusChip tone="warning">{t('teaching.followups.voided')}</StatusChip>}
              <StatusChip tone={attempt.voided_at !== null ? 'neutral' : attempt.teacher_result === 'correct' ? 'success' : 'neutral'} className={attempt.voided_at !== null ? 'line-through' : undefined}>
                {t('teaching.followups.teacherReviewLabel')} · {t(`teaching.result.${attempt.teacher_result}`)}
              </StatusChip>
              <StatusChip>{t(`teaching.answerStatus.${attempt.answer_status}`)}</StatusChip>
              <StatusChip>{t(`teaching.assistanceStatus.${attempt.assistance}`)}</StatusChip>
            </div>
            <blockquote className="mt-3 whitespace-pre-wrap break-words border-l-2 border-primary/30 bg-muted/40 px-3 py-2 text-sm leading-6">
              {attempt.answer_status === 'confirmed_blank' ? t('teaching.answerStatus.confirmed_blank') : attempt.student_answer ?? t('teaching.answerStatus.unknown')}
              {attempt.student_work ? `\n${attempt.student_work}` : ''}
            </blockquote>
            {attempt.teacher_feedback && <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6">{attempt.teacher_feedback}</p>}
            {attempt.voided_at !== null && <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">{t('teaching.followups.voidReason')}: {attempt.void_reason}</p>}
            <details className="mt-3 rounded-lg bg-muted/40 p-3">
              <summary className="cursor-pointer text-xs font-medium">{t('teaching.followups.questionSnapshot')}</summary>
              <div className="mt-3"><FollowupQuestionSnapshot question={attempt.question_snapshot} guidanceExpanded /></div>
            </details>
            {attempt.voided_at === null && <Button className="mt-3" variant="ghost" size="sm" disabled={disabled} onClick={() => onVoid(attempt)}>{t('teaching.followups.void')}</Button>}
          </li>
        ))}
      </ol>
    </section>
  )
}
