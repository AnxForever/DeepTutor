'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ArrowRight, BookOpenCheck, CheckCircle2 } from 'lucide-react'
import Markdown from '@/components/common/MarkdownRenderer'
import { useStudentTaskBuffer } from '@/hooks/useStudentTaskBuffer'
import { downloadStudentTaskBuffer, type StudentTaskBuffer, type StudentTaskOperation } from '@/lib/student-task-buffers'
import { draftUuid } from '@/lib/teaching-draft-validation'
import { getStudentTask, saveStudentTaskProgress, studentTasksRoute, submitStudentTask, type StudentTaskView, type TaskResponse } from '@/lib/student-tasks-api'
import { randomUuid } from '@/lib/random-uuid'
import { ApiError } from '@/shared/api/errors'
import { Button, Dialog, Field, InlineAlert, StatusChip } from '@/shared/ui'
import { LearningShell, LearningSkeleton } from '../LearningShell'
import { StudentTaskAccess } from './StudentTaskAccess'
import { TaskTranslations } from '../TaskTranslations'
import StudentTaskVoiceControls, { appendedStudentAnswer } from './StudentTaskVoiceControls'
import type { StudentVoiceCandidate } from '@/lib/student-task-voice-api'
import { useStudentTaskHints, type StudentTaskHintsController } from '@/hooks/useStudentTaskHints'
import StudentTaskHints from './StudentTaskHints'

const responseLabel = (response: TaskResponse) => response.response_status === 'answered' ? 'studentTasks.answered' : response.response_status === 'needs_help' ? 'studentTasks.helpMarked' : 'studentTasks.unanswered'
const copyResponses = (responses: TaskResponse[]) => responses.map(response => ({ ...response }))

export default function StudentTaskPlayerPage({ taskId }: { taskId: string }) {
  return <TaskTranslations><StudentTaskAccess>{accountId => <TaskLoader key={`${accountId}:${taskId}`} taskId={taskId} accountId={accountId} />}</StudentTaskAccess></TaskTranslations>
}
function TaskLoader({ taskId, accountId }: { taskId: string; accountId: string }) {
  const { t } = useTranslation()
  const [task, setTask] = useState<StudentTaskView | null>(null)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!draftUuid(taskId)) return
    const controller = new AbortController()
    void getStudentTask(taskId, controller.signal).then(value => { if (!controller.signal.aborted) { if (value.task_id === taskId) setTask(value); else setFailed(true) } }).catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => controller.abort()
  }, [taskId, retry])
  if (!draftUuid(taskId) || failed) return <LearningShell back={false} title={t('studentTasks.title')} subtitle="" icon={BookOpenCheck}><InlineAlert tone="warning" action={draftUuid(taskId) && <Button variant="secondary" onClick={() => { setFailed(false); setRetry(value => value + 1) }}>{t('studentTasks.retry')}</Button>}>{t('studentTasks.unavailable')}</InlineAlert><TaskBackLink /></LearningShell>
  if (!task) return <LearningShell back={false} title={t('studentTasks.title')} subtitle={t('studentTasks.loading')} icon={BookOpenCheck}><LearningSkeleton count={1} /></LearningShell>
  return <StudentTaskPlayer key={task.task_id} initialTask={task} accountId={accountId} />
}
function TaskBackLink() {
  const { t } = useTranslation()
  return <Link href={studentTasksRoute()} prefetch={false} className="inline-flex min-h-12 items-center gap-2 text-base text-muted-foreground hover:text-foreground"><ArrowLeft size={18} aria-hidden />{t('studentTasks.back')}</Link>
}
export function StudentTaskQuestionText({ content }: { content: string }) { return <Markdown content={content} learningTextSize={18} enableMath enableCode={false} enableMermaid={false} enableImages={false} allowHtml={false} /> }

function StudentTaskPlayer({ initialTask, accountId }: { initialTask: StudentTaskView; accountId: string }) {
  const { t, i18n } = useTranslation()
  const [task, setTask] = useState(initialTask)
  const [responses, setResponses] = useState(() => copyResponses(initialTask.submission?.responses ?? initialTask.progress.responses))
  const [index, setIndex] = useState(initialTask.progress.current_question_index)
  const [dirty, setDirty] = useState(false)
  const [operation, setOperation] = useState<StudentTaskOperation | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<'save' | 'submit' | 'changed' | 'revoked' | 'reload' | null>(null)
  const [serverSaved, setServerSaved] = useState(false)
  const [clearPending, setClearPending] = useState(false)
  const [reloadDialog, setReloadDialog] = useState(false)
  const [discardDialog, setDiscardDialog] = useState(false)
  const [restoreMismatch, setRestoreMismatch] = useState(false)
  const [baseRevision, setBaseRevision] = useState(initialTask.progress.revision)
  const [baseTaskRevision, setBaseTaskRevision] = useState(initialTask.task_revision)
  const [voiceCandidate, setVoiceCandidate] = useState<StudentVoiceCandidate | null>(null)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const request = useRef<AbortController | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current?.abort() } }, [])
  const value = useMemo<StudentTaskBuffer>(() => ({ kind: 'student-task-buffer', version: 1, taskId: task.task_id, taskRevision: baseTaskRevision, baseRevision, questionIds: task.questions.map(question => question.question_id), currentQuestionIndex: operation?.kind === 'progress' ? operation.body.current_question_index : index, responses, operation, voiceCandidate }), [task, baseTaskRevision, baseRevision, index, responses, operation, voiceCandidate])
  const buffer = useStudentTaskBuffer({ accountId, taskId: task.task_id, value, dirty: dirty || operation !== null, onRestore: restored => {
    if (restored.questionIds.join('\u0000') !== task.questions.map(question => question.question_id).join('\u0000')) { setRestoreMismatch(true); return }
    setResponses(copyResponses(restored.responses)); setIndex(restored.currentQuestionIndex); setBaseRevision(restored.baseRevision); setBaseTaskRevision(restored.taskRevision); setVoiceCandidate(restored.voiceCandidate ?? null); setOperation(restored.operation); setDirty(true); setServerSaved(false); setReviewing(restored.operation?.kind === 'submit')
    setError(restored.operation ? restored.operation.kind === 'submit' ? 'submit' : 'save' : restored.baseRevision !== task.progress.revision || Boolean(restored.voiceCandidate && restored.taskRevision !== task.task_revision) ? 'changed' : null)
  } })
  const submitted = task.submission !== null
  const revoked = task.status === 'revoked' || error === 'revoked'
  const blocked = busy || operation !== null || clearPending || buffer.phase === 'reading' || buffer.phase === 'pending' || error === 'changed' || restoreMismatch
  const baseEditable = !submitted && !revoked && !blocked
  const editable = baseEditable && !voiceBusy && voiceCandidate === null
  const currentQuestion = task.questions[index]
  const currentResponse = responses[index]
  const hints = useStudentTaskHints({ accountId, taskId: task.task_id, questionId: currentQuestion.question_id, questionIds: task.questions.map(question => question.question_id), disabled: !baseEditable || voiceBusy || voiceCandidate !== null, readOnly: submitted || revoked || reviewing })
  const canAdvance = editable && !hints.busy

  function editAnswer(answer: string) {
    if (!editable) return
    setResponses(previous => previous.map((response, position) => position === index ? { ...response, answer: answer.trim() ? answer : null, response_status: answer.trim() ? 'answered' : 'unanswered' } : response)); setDirty(true); setServerSaved(false); setError(null)
  }
  function needsHelp() {
    if (!editable) return
    setResponses(previous => previous.map((response, position) => position === index ? { ...response, response_status: response.response_status === 'needs_help' ? response.answer?.trim() ? 'answered' : 'unanswered' : 'needs_help' } : response)); setDirty(true); setServerSaved(false); setError(null)
  }
  function adopt(saved: StudentTaskView) {
    setTask(saved); setBaseRevision(saved.progress.revision); setBaseTaskRevision(saved.task_revision); setVoiceCandidate(null); setResponses(copyResponses(saved.submission?.responses ?? saved.progress.responses)); setIndex(saved.progress.current_question_index); setOperation(null); setDirty(false); setError(null); setRestoreMismatch(false); setServerSaved(!saved.submission)
  }
  function updateVoiceCandidate(candidate: StudentVoiceCandidate | null) { setVoiceCandidate(candidate); setDirty(true); setServerSaved(false) }
  function acceptVoiceCandidate() {
    if (!baseEditable || voiceBusy || !voiceCandidate || voiceCandidate.task_id !== task.task_id || voiceCandidate.task_revision !== task.task_revision || voiceCandidate.basis_progress_revision !== baseRevision || voiceCandidate.question_id !== currentQuestion.question_id) return
    const accepted = appendedStudentAnswer(currentResponse, voiceCandidate.text)
    if (!accepted) return
    setResponses(previous => previous.map((response, position) => position === index ? accepted : response)); setVoiceCandidate(null); setDirty(true); setServerSaved(false)
  }
  async function clearAfterAcknowledgment() {
    try { await buffer.clear(); if (alive.current) setClearPending(false) }
    catch { if (alive.current) setClearPending(true) }
  }
  async function execute(next: StudentTaskOperation) {
    if (request.current || submitted || revoked) return
    const controller = new AbortController(); request.current = controller; setBusy(true); setError(null); setOperation(next)
    const captured: StudentTaskBuffer = { ...value, operation: next, baseRevision: next.body.expected_revision, responses: copyResponses(next.body.responses), currentQuestionIndex: next.kind === 'progress' ? next.body.current_question_index : index }
    // Persist the exact request id and payload before a possibly ambiguous POST.
    // A storage failure remains visible; an explicit server save can still work.
    try { await buffer.flush(captured) } catch { /* The local failure is shown by the buffer. */ }
    try {
      const saved = next.kind === 'progress' ? await saveStudentTaskProgress(task.task_id, next.body, controller.signal) : await submitStudentTask(task.task_id, next.body, controller.signal)
      if (controller.signal.aborted || !alive.current) return
      if (saved.task_id !== task.task_id) throw new Error('Task response did not match')
      adopt(saved); if (next.kind === 'progress') setReviewing(next.reviewAfter)
      await clearAfterAcknowledgment()
    } catch (reason) {
      if (controller.signal.aborted || !alive.current) return
      const code = reason instanceof ApiError ? reason.code : ''
      setError(code === 'teaching_student_task_revoked' ? 'revoked' : reason instanceof ApiError && reason.status === 409 ? 'changed' : next.kind === 'submit' ? 'submit' : 'save')
    } finally { if (request.current === controller) request.current = null; if (!controller.signal.aborted && alive.current) setBusy(false) }
  }
  function saveAndMove(nextIndex: number, reviewAfter = false) {
    if (!canAdvance) return
    if ((nextIndex >= index || reviewAfter) && currentResponse.response_status === 'unanswered') return
    const next: StudentTaskOperation = { kind: 'progress', body: { request_id: randomUuid(), expected_revision: baseRevision, current_question_index: nextIndex, responses: copyResponses(responses) }, reviewAfter }
    void execute(next)
  }
  function finish() {
    if (!canAdvance) return
    const missing = responses.findIndex(response => response.response_status === 'unanswered')
    if (missing !== -1) { setIndex(missing); setReviewing(false); setDirty(true); setServerSaved(false); return }
    void execute({ kind: 'submit', body: { submission_id: randomUuid(), expected_revision: baseRevision, responses: copyResponses(responses) } })
  }
  async function reloadSaved() {
    if (request.current) return
    const controller = new AbortController(); request.current = controller; setBusy(true)
    try {
      const saved = await getStudentTask(task.task_id, controller.signal)
      if (controller.signal.aborted || !alive.current) return
      if (saved.task_id !== task.task_id) throw new Error('Task response did not match')
      await buffer.discard()
      if (!alive.current) return
      adopt(saved); setReviewing(false); setReloadDialog(false); setClearPending(false)
    } catch { if (!controller.signal.aborted && alive.current) { setError('reload'); setReloadDialog(false) } }
    finally { if (request.current === controller) request.current = null; if (!controller.signal.aborted && alive.current) setBusy(false) }
  }
  async function discardLocal() {
    try { await buffer.discard(); if (alive.current) { setDiscardDialog(false); setRestoreMismatch(false) } } catch { /* Keep the local record and the dialog available. */ }
  }
  const retryOperation = operation !== null && (error === 'save' || error === 'submit')
  return <LearningShell back={false} title={task.title} subtitle={<span className="text-base leading-7">{task.instructions}</span>} icon={BookOpenCheck} className="student-task-page">
    <div className="mx-auto max-w-2xl">
      <TaskBackLink />
      {buffer.pending && <InlineAlert className="mb-5 mt-3" tone={buffer.validPending ? 'info' : 'warning'} title={t('studentTasks.localAvailable')}><p>{t('studentTasks.localTime', { time: new Date(buffer.pending.updatedAt).toLocaleString(i18n.language) })}</p>{!buffer.validPending && <p className="mt-2">{t('studentTasks.localInvalid')}</p>}<div className="mt-3 flex flex-wrap gap-2">{buffer.validPending && !submitted && !revoked && <Button size="lg" onClick={buffer.restore}>{t('studentTasks.restore')}</Button>}<Button variant="secondary" onClick={() => setDiscardDialog(true)}>{t('studentTasks.discard')}</Button><Button variant="ghost" onClick={() => downloadStudentTaskBuffer(buffer.pending?.value, task.task_id)}>{t('studentTasks.download')}</Button></div></InlineAlert>}
      {buffer.error && <InlineAlert tone="warning" className="my-4"><p>{t(buffer.error === 'conflict' ? 'studentTasks.localConflict' : 'studentTasks.localFailed')}</p><div className="mt-3 flex flex-wrap gap-2"><Button variant="secondary" onClick={() => void buffer.retry().catch(() => {})}>{t('studentTasks.retryLocal')}</Button><Button variant="ghost" onClick={() => downloadStudentTaskBuffer(value, task.task_id)}>{t('studentTasks.download')}</Button></div></InlineAlert>}
      {clearPending && <InlineAlert tone="warning" className="my-4" action={<Button variant="secondary" disabled={busy} onClick={() => void clearAfterAcknowledgment()}>{t('studentTasks.retryClear')}</Button>}>{t('studentTasks.localClearFailed')}</InlineAlert>}
      {(error || restoreMismatch) && <InlineAlert tone="warning" className="my-4"><p>{t(restoreMismatch ? 'studentTasks.localInvalid' : error === 'changed' ? 'studentTasks.changed' : error === 'revoked' ? 'studentTasks.revokedHint' : error === 'submit' ? 'studentTasks.submitFailed' : error === 'reload' ? 'studentTasks.unavailable' : 'studentTasks.saveFailed')}</p><div className="mt-3 flex flex-wrap gap-2">{retryOperation && <Button size="lg" loading={busy} onClick={() => void execute(operation!)}>{t(operation!.kind === 'submit' ? 'studentTasks.retrySubmit' : 'studentTasks.retrySave')}</Button>}{(error === 'changed' || restoreMismatch || error === 'reload') && <Button variant="secondary" disabled={busy} onClick={() => setReloadDialog(true)}>{t('studentTasks.reload')}</Button>}<Button variant="ghost" onClick={() => downloadStudentTaskBuffer(value, task.task_id)}>{t('studentTasks.download')}</Button></div></InlineAlert>}
      {submitted ? <section className="mt-5 rounded-2xl border border-success/25 bg-success-surface p-6 sm:p-8"><CheckCircle2 size={36} aria-hidden className="mb-4 text-success" /><h2 className="text-2xl font-semibold">{t('studentTasks.doneTitle')}</h2><p className="mt-3 text-base leading-7">{t('studentTasks.doneHint')}</p>{revoked && <p className="mt-3 text-sm text-muted-foreground">{t('studentTasks.revoked')}</p>}<AnswerReview task={task} responses={task.submission!.responses} hints={hints} /></section> : revoked ? <section className="mt-5 rounded-2xl border border-border bg-card p-6"><h2 className="text-xl font-semibold">{t('studentTasks.revoked')}</h2><p className="mt-3 leading-7 text-muted-foreground">{t('studentTasks.revokedHint')}</p><AnswerReview task={task} responses={responses} hints={hints} /></section> : reviewing ? <section className="mt-4 rounded-2xl border border-border bg-card p-6 sm:p-8"><h2 className="text-2xl font-semibold">{t('studentTasks.reviewTitle')}</h2><p className="mt-3 text-base leading-7 text-muted-foreground">{t('studentTasks.reviewHint')}</p><AnswerReview task={task} responses={responses} hints={hints} /><div className="mt-7 flex flex-wrap gap-3"><Button size="lg" disabled={!canAdvance} loading={busy} onClick={finish}>{t('studentTasks.finish')}</Button><Button size="lg" variant="secondary" disabled={!canAdvance} onClick={() => { setReviewing(false); setServerSaved(false) }}>{t('studentTasks.checkAnswers')}</Button></div></section> : <section className="mt-4 rounded-2xl border border-border bg-card p-5 sm:p-8" aria-label={t('studentTasks.progress', { current: index + 1, total: task.questions.length })}>
        <p aria-live="polite" className="mb-3 text-base font-medium text-muted-foreground">{t('studentTasks.progress', { current: index + 1, total: task.questions.length })}</p><progress className="mb-6 h-2 w-full accent-primary" max={task.questions.length} value={index + 1} aria-label={t('studentTasks.progress', { current: index + 1, total: task.questions.length })} />
        <div className="mb-7 break-words text-lg leading-8"><StudentTaskQuestionText content={currentQuestion.question} /></div>
        <StudentTaskHints hints={hints} questionId={currentQuestion.question_id} disabled={!baseEditable} voiceBlocked={voiceBusy || voiceCandidate !== null} />
        {currentResponse.response_status === 'needs_help' ? <><InlineAlert className="mb-4">{t('studentTasks.helpMarked')}</InlineAlert>{currentResponse.answer !== null && <Field label={t('studentTasks.answer')}><textarea id="student-task-answer" readOnly className="mt-1 min-h-32 w-full resize-y rounded-xl border border-border bg-muted/30 p-4 text-lg leading-8 text-foreground outline-none focus:ring-2 focus:ring-ring" rows={4} value={currentResponse.answer} /></Field>}</> : <Field label={t('studentTasks.answer')}><textarea id="student-task-answer" className="mt-1 min-h-32 w-full resize-y rounded-xl border border-border bg-background p-4 text-lg leading-8 text-foreground outline-none focus:ring-2 focus:ring-ring disabled:opacity-60" rows={4} maxLength={6000} disabled={!editable} value={currentResponse.answer ?? ''} placeholder={t('studentTasks.answerPlaceholder')} onChange={event => editAnswer(event.target.value)} /></Field>}
        <Button className="mt-4" size="lg" variant="secondary" disabled={!editable} aria-pressed={currentResponse.response_status === 'needs_help'} onClick={needsHelp}>{t(currentResponse.response_status === 'needs_help' ? 'studentTasks.editAnswer' : 'studentTasks.needsHelp')}</Button>
        {currentResponse.response_status === 'unanswered' && <p className="mt-4 text-sm leading-6 text-muted-foreground">{t('studentTasks.unansweredHint')}</p>}
        <StudentTaskVoiceControls key={`${accountId}:${task.task_id}:${task.task_revision}:${currentQuestion.question_id}`} accountId={accountId} taskId={task.task_id} taskRevision={task.task_revision} progressRevision={baseRevision} questionId={currentQuestion.question_id} locale={i18n.language.startsWith('zh') ? 'zh' : 'en'} currentResponse={currentResponse} disabled={!baseEditable || hints.busy} candidate={voiceCandidate} onCandidateChange={updateVoiceCandidate} onAccept={acceptVoiceCandidate} onBusyChange={setVoiceBusy} />
        <div className="mt-8 flex flex-wrap justify-between gap-3"><Button size="lg" variant="ghost" disabled={!canAdvance || index === 0} icon={<ArrowLeft size={18} />} onClick={() => saveAndMove(index - 1)}>{t('studentTasks.previous')}</Button><Button size="lg" disabled={!canAdvance || currentResponse.response_status === 'unanswered'} loading={busy} icon={<ArrowRight size={18} />} onClick={() => saveAndMove(Math.min(index + 1, task.questions.length - 1), index === task.questions.length - 1)}>{t(index === task.questions.length - 1 ? 'studentTasks.review' : 'studentTasks.next')}</Button></div>
      </section>}
      {serverSaved && !submitted && <p role="status" className="mt-4 text-sm text-muted-foreground">{t('studentTasks.serverSaved')}</p>}
      {(dirty || operation) && !buffer.error && !buffer.pending && <p role="status" className="mt-4 text-sm text-muted-foreground">{t(buffer.localSaved ? 'studentTasks.localSaved' : 'studentTasks.localSaving')}</p>}
    </div>
    <Dialog open={reloadDialog} title={t('studentTasks.reloadTitle')} busy={busy} onClose={() => { if (!busy) setReloadDialog(false) }} footer={<><Button variant="secondary" disabled={busy} onClick={() => setReloadDialog(false)}>{t('studentTasks.cancel')}</Button><Button loading={busy} onClick={() => void reloadSaved()}>{t('studentTasks.reload')}</Button></>}><p className="leading-7">{t('studentTasks.reloadHint')}</p><Button className="mt-3" variant="ghost" onClick={() => downloadStudentTaskBuffer(value, task.task_id)}>{t('studentTasks.download')}</Button></Dialog>
    <Dialog open={discardDialog} title={t('studentTasks.reloadTitle')} onClose={() => setDiscardDialog(false)} footer={<><Button variant="secondary" onClick={() => setDiscardDialog(false)}>{t('studentTasks.cancel')}</Button><Button onClick={() => void discardLocal()}>{t('studentTasks.discard')}</Button></>}><p className="leading-7">{t('studentTasks.reloadHint')}</p>{buffer.error && <p role="alert" className="mt-3 text-destructive">{t('studentTasks.localFailed')}</p>}</Dialog>
  </LearningShell>
}
function AnswerReview({ task, responses, hints }: { task: StudentTaskView; responses: TaskResponse[]; hints: StudentTaskHintsController }) {
  const { t } = useTranslation()
  return <ol className="mt-6 space-y-5">{task.questions.map((question, index) => { const response = responses.find(item => item.question_id === question.question_id)!; return <li key={question.question_id} className="border-t border-border pt-5"><p className="mb-2 text-sm text-muted-foreground">{t('studentTasks.progress', { current: index + 1, total: task.questions.length })}</p><StudentTaskQuestionText content={question.question} /><StatusChip className="mt-3">{t(responseLabel(response))}</StatusChip>{response.answer !== null && <p className="mt-3 whitespace-pre-wrap break-words text-lg leading-8">{response.answer}</p>}<StudentTaskHints hints={hints} questionId={question.question_id} readOnly /></li> })}</ol>
}
