'use client'

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ClipboardCheck, FileText, RefreshCw } from 'lucide-react'
import { Button, Dialog, EmptyState, InlineAlert, Skeleton, StatusChip } from '@/shared/ui'
import { isApiError } from '@/shared/api/errors'
import type { SavedTeachingReport, TeachingEvidence, TeachingItemFinding, TeachingPriority } from '@/lib/teaching-analysis-api'
import type { SavedFollowupAttempt } from '@/lib/teaching-followups-api'
import {
  getStudentCaseTimeline, getTeachingReportRevision,
  type StudentCaseReportSnapshot, type StudentCaseSourceState, type StudentCaseTimeline,
  type StudentCaseTimelineCounts, type StudentCaseTimelineEvent,
} from '@/lib/teaching-student-cases-api'
import { RubricSnapshotView } from './RubricSnapshotView'
import { SourceProvenanceView } from './SourceProvenanceView'

const PAGE_SIZE = 20
const assistanceOrder = ['independent', 'assisted', 'unknown'] as const
const resultOrder = ['correct', 'partial', 'incorrect', 'ungraded'] as const
type ReadRequest = { kind: 'first' | 'more'; cursor: string | null; sequence: number }
type TimelineIssue = { kind: 'network' | 'dataset' | 'case' | 'invalid'; request: ReadRequest['kind'] }
type ReportTarget = { reportId: string; revision: number }

export interface StudentEvidenceTimelineProps {
  caseId: string
  workspaceId: string
  refreshKey?: number
  onReloadCase?: () => void
  onSourceStates?: (states: StudentCaseSourceState[]) => void
}

const sourceKey = (reportId: string, revision: number) => `${reportId}:${revision}`
function distinctEvents(events: StudentCaseTimelineEvent[]) {
  const seen = new Set<string>()
  return events.filter(event => { if (seen.has(event.event_id)) return false; seen.add(event.event_id); return true })
}

function RecordedTime({ value, lastRead = false }: { value: number; lastRead?: boolean }) {
  const { t, i18n } = useTranslation()
  const date = new Date(value * 1000)
  if (!Number.isFinite(value) || !Number.isFinite(date.getTime())) return <span>{t('teaching.caseTimeline.unknownTime')}</span>
  return <time dateTime={date.toISOString()}>{t(lastRead ? 'teaching.caseTimeline.lastRead' : 'teaching.caseTimeline.recordedAt', { time: date.toLocaleString(i18n.language) })}</time>
}

function SourceBadge({ source }: { source?: StudentCaseSourceState }) {
  const { t } = useTranslation()
  if (!source) return null
  return <StatusChip tone={source.status === 'current' ? 'neutral' : 'warning'}>{t(source.status === 'current' ? 'teaching.caseTimeline.sourceCurrent' : source.status === 'stale' ? 'teaching.caseTimeline.sourceStale' : 'teaching.caseTimeline.sourceUnavailable')}</StatusChip>
}

function SourceWarnings({ states }: { states: StudentCaseSourceState[] }) {
  const { t } = useTranslation()
  const warnings = states.filter(source => source.status !== 'current')
  if (!warnings.length) return null
  return <section className="mt-4" aria-label={t('teaching.caseTimeline.sourceTitle')}>
    <InlineAlert tone="warning" title={t('teaching.caseTimeline.sourceTitle')}>
      <ul className="space-y-3">{warnings.map(source => <li key={sourceKey(source.report_id, source.report_revision)}>
        <p className="font-medium">{source.assignment_ref || t('teaching.caseTimeline.unknownSource')} · {t('teaching.caseTimeline.reportVersion', { n: source.report_revision })}</p>
        <p className="mt-1 leading-6">{source.status === 'unavailable'
          ? t('teaching.caseTimeline.unavailableHint', { n: source.report_revision })
          : source.latest_revision !== null ? t('teaching.caseTimeline.staleHint', { pinned: source.report_revision, latest: source.latest_revision }) : t('teaching.caseTimeline.staleWithoutVersion')}</p>
      </li>)}</ul>
    </InlineAlert>
  </section>
}

function EvaluationCounts({ counts }: { counts: StudentCaseTimelineCounts }) {
  const { t } = useTranslation()
  const outcomes = new Map(counts.attempt_outcomes.map(bucket => [`${bucket.assistance}:${bucket.teacher_result}`, bucket.count]))
  return <section className="mt-5 rounded-xl border border-border p-4" aria-label={t('teaching.caseTimeline.outcomesTitle')}>
    <dl className="mb-5 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
      <div><dt className="text-xs text-muted-foreground">{t('teaching.caseTimeline.linkedReports')}</dt><dd className="mt-1 font-semibold tabular-nums">{counts.linked_reports}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{t('teaching.caseTimeline.confirmedReports')}</dt><dd className="mt-1 font-semibold tabular-nums">{counts.confirmed_report_count}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{t('teaching.caseTimeline.practiceResponses')}</dt><dd className="mt-1 font-semibold tabular-nums">{counts.attempts}</dd></div>
    </dl>
    <h4 className="text-sm font-semibold">{t('teaching.caseTimeline.outcomesTitle')}</h4>
    <div className="mt-3 max-w-full overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs" aria-label={t('teaching.caseTimeline.outcomesTitle')}>
        <caption className="mb-3 text-left text-xs leading-5 text-muted-foreground">{t('teaching.caseTimeline.outcomesCaption')}</caption>
        <thead><tr className="border-b border-border"><th scope="col" className="px-2 py-2 font-medium">{t('teaching.caseTimeline.helpUsed')}</th>{resultOrder.map(result => <th key={result} scope="col" className="px-2 py-2 text-center font-medium">{t(`teaching.result.${result}`)}</th>)}</tr></thead>
        <tbody>{assistanceOrder.map(assistance => <tr key={assistance} className="border-b border-border/60 last:border-b-0"><th scope="row" className="px-2 py-3 font-medium">{t(`teaching.assistanceStatus.${assistance}`)}</th>{resultOrder.map(result => <td key={result} className="px-2 py-3 text-center tabular-nums">{outcomes.get(`${assistance}:${result}`) ?? '—'}</td>)}</tr>)}</tbody>
      </table>
    </div>
    <p className="mt-3 text-xs leading-5 text-muted-foreground">{t('teaching.caseTimeline.excludedVoided', { n: counts.voided_attempts })}</p>
  </section>
}

function Quotes({ evidence }: { evidence: TeachingEvidence[] }) {
  const { t } = useTranslation()
  return <div className="mt-3 grid gap-2">{evidence.map((entry, index) => <blockquote key={index} className="border-l-2 border-primary/30 bg-muted/40 px-3 py-2 text-sm leading-6">
    <p className="mb-1 text-xs font-medium text-muted-foreground">{entry.question_id} · {t(entry.field === 'student_work' ? 'teaching.caseTimeline.studentWork' : 'teaching.caseTimeline.studentAnswer')}</p>
    <p className="whitespace-pre-wrap break-words">{entry.quote}</p>
  </blockquote>)}</div>
}

function Observations({ items }: { items: TeachingItemFinding[] }) {
  const { t } = useTranslation()
  return <details className="mt-4 rounded-lg border border-border/70 p-3">
    <summary className="cursor-pointer text-sm font-medium">{t('teaching.caseTimeline.observations')}</summary>
    {!items.length && <p className="mt-3 text-sm text-muted-foreground">{t('teaching.caseTimeline.noObservations')}</p>}
    <div className="mt-3 grid gap-3">{items.map(item => <div key={item.question_id} className="border-t border-border/60 pt-3">
      <div className="flex flex-wrap items-center gap-2"><h5 className="text-sm font-medium">{item.question_id}</h5><StatusChip>{t('teaching.caseTimeline.reportObservation')} · {t(`teaching.result.${item.result}`)}</StatusChip></div>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{item.observation}</p>
      <Quotes evidence={item.evidence} />
    </div>)}</div>
  </details>
}

function Concerns({ priorities }: { priorities: TeachingPriority[] }) {
  const { t } = useTranslation()
  const parts = [
    ['observation', 'teaching.caseTimeline.reportObservation'], ['hypothesis', 'teaching.caseTimeline.hypothesis'],
    ['alternative_explanation', 'teaching.caseTimeline.alternative'], ['teaching_action', 'teaching.caseTimeline.teachingAction'],
    ['follow_up_question', 'teaching.caseTimeline.followUp'], ['reference_guidance', 'teaching.caseTimeline.guidance'],
  ] as const
  return <div className="mt-4">
    <h4 className="text-sm font-medium">{t('teaching.caseTimeline.concerns')}</h4>
    {!priorities.length && <p className="mt-2 text-sm text-muted-foreground">{t('teaching.caseTimeline.noConcerns')}</p>}
    <div className="mt-2 grid gap-2">{priorities.map((priority, index) => <details key={index} className="rounded-lg border border-border/70 p-3"><summary className="cursor-pointer text-sm font-medium">{priority.knowledge_point}<span className="ml-2"><StatusChip tone={priority.evidence_status === 'needs_check' ? 'warning' : 'neutral'}>{t(`teaching.evidenceStatus.${priority.evidence_status}`)}</StatusChip></span></summary><dl className="mt-3 grid gap-3">{parts.map(([field, label]) => <div key={field}><dt className="text-xs text-muted-foreground">{t(label)}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{priority[field] || t('teaching.notProvided')}</dd></div>)}</dl><Quotes evidence={priority.evidence} /></details>)}</div>
  </div>
}

function ReportCard({ snapshot, source, onOpen }: { snapshot: StudentCaseReportSnapshot; source?: StudentCaseSourceState; onOpen: () => void }) {
  const { t } = useTranslation()
  return <>
    <div className="flex flex-wrap items-start justify-between gap-3"><h4 className="text-base font-semibold">{snapshot.assignment_ref || t('teaching.caseTimeline.unknownSource')}</h4><SourceBadge source={source} /></div>
    <p className="mt-2 text-xs leading-5 text-muted-foreground">{t('teaching.caseTimeline.originalLabels', { student: snapshot.student_ref, assignment: snapshot.assignment_ref })} · {snapshot.subject} · {t('teaching.caseTimeline.reportVersion', { n: snapshot.report_revision })}</p>
    <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6">{snapshot.summary}</p>
    <Observations items={snapshot.items} />
    <Concerns priorities={snapshot.priorities} />
    <Button className="mt-4" variant="secondary" size="sm" onClick={onOpen}>{t('teaching.caseTimeline.viewExactReport', { n: snapshot.report_revision })}</Button>
  </>
}

function AttemptCard({ attempt, source, onOpen }: { attempt: SavedFollowupAttempt; source?: StudentCaseSourceState; onOpen: () => void }) {
  const { t } = useTranslation()
  return <>
    <div className="flex flex-wrap items-start justify-between gap-3"><h4 className="text-sm font-semibold">{t('teaching.caseTimeline.questionVersion', { id: attempt.question_id, n: attempt.followup_revision })}</h4><SourceBadge source={source} /></div>
    <p className="mt-2 text-xs leading-5 text-muted-foreground">{t('teaching.caseTimeline.originalLabels', { student: attempt.student_ref, assignment: attempt.assignment_ref })} · {attempt.subject} · {t('teaching.caseTimeline.reportVersion', { n: attempt.report_revision })}</p>
    <p className="mt-3 text-sm font-medium">{attempt.knowledge_point}</p>
    <div className="mt-3 flex flex-wrap gap-2">
      {attempt.voided_at !== null && <StatusChip tone="warning">{t('teaching.followups.voided')}</StatusChip>}
      <StatusChip tone={attempt.voided_at !== null ? 'neutral' : attempt.teacher_result === 'correct' ? 'success' : 'neutral'} className={attempt.voided_at !== null ? 'line-through' : undefined}>{t('teaching.caseTimeline.teacherEvaluation')} · {t(`teaching.result.${attempt.teacher_result}`)}</StatusChip>
      <StatusChip>{t(`teaching.assistanceStatus.${attempt.assistance}`)}</StatusChip>
      <StatusChip>{t(`teaching.answerStatus.${attempt.answer_status}`)}</StatusChip>
    </div>
    <details className="mt-4 rounded-lg border border-border/70 p-3"><summary className="cursor-pointer text-sm font-medium">{t('teaching.caseTimeline.responseDetails')}</summary><dl className="mt-3 grid gap-3">
      <div><dt className="text-xs text-muted-foreground">{t('teaching.caseTimeline.question')}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{attempt.question_snapshot.question}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{t('teaching.caseTimeline.studentAnswer')}</dt><dd className="mt-1 whitespace-pre-wrap break-words border-l-2 border-primary/30 bg-muted/40 px-3 py-2 text-sm leading-6">{attempt.answer_status === 'confirmed_blank' ? t('teaching.answerStatus.confirmed_blank') : attempt.student_answer ?? t('teaching.notProvided')}</dd></div>
      {attempt.student_work !== null && <div><dt className="text-xs text-muted-foreground">{t('teaching.caseTimeline.studentWork')}</dt><dd className="mt-1 whitespace-pre-wrap break-words border-l-2 border-primary/30 bg-muted/40 px-3 py-2 text-sm leading-6">{attempt.student_work}</dd></div>}
      {attempt.question_snapshot.reference_answer !== null && <div><dt className="text-xs text-muted-foreground">{t('teaching.caseTimeline.referenceAnswer')}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{attempt.question_snapshot.reference_answer}</dd></div>}
      {attempt.question_snapshot.rubric !== null && <div><dt className="text-xs text-muted-foreground">{t('teaching.caseTimeline.markingGuidance')}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{attempt.question_snapshot.rubric}</dd></div>}
      {attempt.teacher_feedback && <div><dt className="text-xs text-muted-foreground">{t('teaching.caseTimeline.teacherFeedback')}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{attempt.teacher_feedback}</dd></div>}
    </dl></details>
    <Button className="mt-4" variant="ghost" size="sm" onClick={onOpen}>{t('teaching.caseTimeline.viewExactReport', { n: attempt.report_revision })}</Button>
  </>
}

function ExactReport({ report }: { report: SavedTeachingReport }) {
  const { t } = useTranslation()
  const assignment = report.assignment
  return <div>
    <p className="text-xs leading-5 text-muted-foreground">{t('teaching.caseTimeline.exactHint')}</p>
    <p className="mt-3 text-sm font-medium">{t('teaching.caseTimeline.originalLabels', { student: assignment.student_ref, assignment: assignment.assignment_ref })}</p>
    <p className="mt-1 text-xs text-muted-foreground">{[assignment.subject, assignment.grade].filter(Boolean).join(' · ')} · <RecordedTime value={report.updated_at} /></p>
    <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-6">{report.analysis.summary}</p>
    {assignment.rubric_template && <RubricSnapshotView snapshot={assignment.rubric_template} />}
    <div className="mt-4 grid gap-3">{assignment.items.map((item, index) => <details key={item.question_id} open={index === 0 ? true : undefined} className="rounded-xl border border-border p-3"><summary className="cursor-pointer text-sm font-medium">{item.question_id}</summary><div className="mt-3 flex flex-wrap gap-2"><StatusChip>{t(`teaching.answerStatus.${item.answer_status}`)}</StatusChip><StatusChip>{t(`teaching.assistanceStatus.${item.assistance}`)}</StatusChip><StatusChip tone={item.transcription_status === 'uncertain' ? 'warning' : 'neutral'}>{t(`teaching.transcriptionStatus.${item.transcription_status}`)}</StatusChip></div><dl className="mt-4 grid gap-3">
      {([
        ['question', 'teaching.caseTimeline.question'], ['student_answer', 'teaching.caseTimeline.studentAnswer'],
        ['student_work', 'teaching.caseTimeline.studentWork'], ['reference_answer', 'teaching.caseTimeline.referenceAnswer'],
        ['rubric', 'teaching.caseTimeline.markingGuidance'], ['source_locator', 'teaching.caseTimeline.sourceLocation'],
      ] as const).map(([field, key]) => <div key={field}><dt className="text-xs text-muted-foreground">{t(key)}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{item.answer_status === 'confirmed_blank' && (field === 'student_answer' || field === 'student_work') ? t('teaching.answerStatus.confirmed_blank') : item[field] || t('teaching.notProvided')}</dd></div>)}
    </dl></details>)}</div>
    <SourceProvenanceView assignment={assignment} />
    <Observations items={report.analysis.items} />
    <Concerns priorities={report.analysis.priorities} />
    {report.analysis.limitations.length > 0 && <InlineAlert className="mt-4" tone="warning" title={t('teaching.caseTimeline.scopeLimitations')}><ul className="list-disc space-y-1 pl-4">{report.analysis.limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul></InlineAlert>}
    {report.teacher_notes && <div className="mt-4"><h4 className="text-sm font-medium">{t('teaching.notes')}</h4><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{report.teacher_notes}</p></div>}
  </div>
}

export function StudentEvidenceTimeline({ caseId, workspaceId, refreshKey, ...props }: StudentEvidenceTimelineProps) {
  return <ScopedTimeline key={`${workspaceId}:${caseId}:${refreshKey ?? 'current'}`} caseId={caseId} workspaceId={workspaceId} refreshKey={refreshKey} {...props} />
}

function ScopedTimeline({ caseId, workspaceId, refreshKey, onReloadCase, onSourceStates }: StudentEvidenceTimelineProps) {
  const { t } = useTranslation()
  const id = useId()
  const [page, setPage] = useState<StudentCaseTimeline | null>(null)
  const [events, setEvents] = useState<StudentCaseTimelineEvent[]>([])
  const [request, setRequest] = useState<ReadRequest>({ kind: 'first', cursor: null, sequence: 0 })
  const [busy, setBusy] = useState<'first' | 'refresh' | 'more' | null>('first')
  const [issue, setIssue] = useState<TimelineIssue | null>(null)
  const [target, setTarget] = useState<ReportTarget | null>(null)
  const [exact, setExact] = useState<SavedTeachingReport | null>(null)
  const [exactLoading, setExactLoading] = useState(false)
  const [exactIssue, setExactIssue] = useState<'unavailable' | 'invalid' | null>(null)
  const [exactRetry, setExactRetry] = useState(0)
  const requestController = useRef<AbortController | null>(null)
  const exactController = useRef<AbortController | null>(null)
  const pending = useRef(true)
  const anchorRevision = useRef<number | null>(refreshKey ?? null)
  const statesCallback = useRef(onSourceStates)
  useLayoutEffect(() => { statesCallback.current = onSourceStates }, [onSourceStates])

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    const active = () => alive && !controller.signal.aborted
    requestController.current = controller
    pending.current = true
    void getStudentCaseTimeline(caseId, { limit: PAGE_SIZE, ...(request.cursor ? { cursor: request.cursor } : {}) }, workspaceId, controller.signal).then(result => {
      if (!active()) return
      if (result.case_id !== caseId) { setIssue({ kind: 'invalid', request: request.kind }); return }
      if ((refreshKey !== undefined && result.case_revision !== refreshKey) || (request.kind === 'more' && result.case_revision !== anchorRevision.current)) { setIssue({ kind: 'case', request: request.kind }); return }
      if (request.kind === 'more' && result.next_cursor === request.cursor) { setIssue({ kind: 'invalid', request: request.kind }); return }
      anchorRevision.current = result.case_revision
      setPage(result)
      setEvents(previous => distinctEvents(request.kind === 'more' ? [...previous, ...result.events] : result.events))
      statesCallback.current?.(result.source_states)
    }).catch(reason => {
      if (!active()) return
      setIssue({ kind: isApiError(reason) && reason.status === 409 ? 'dataset' : 'network', request: request.kind })
    }).finally(() => {
      if (!active()) return
      pending.current = false
      setBusy(null)
    })
    return () => { alive = false; controller.abort() }
  }, [caseId, refreshKey, request, workspaceId])

  useEffect(() => {
    if (!target) return
    const controller = new AbortController()
    let alive = true
    const active = () => alive && !controller.signal.aborted
    exactController.current = controller
    void getTeachingReportRevision(target.reportId, target.revision, workspaceId, controller.signal).then(value => {
      if (!active()) return
      if (value.report_id !== target.reportId || value.revision !== target.revision || value.status !== 'confirmed') { setExactIssue('invalid'); return }
      setExact(value)
    }).catch(() => { if (active()) setExactIssue('unavailable') }).finally(() => { if (active()) setExactLoading(false) })
    return () => { alive = false; controller.abort(); if (exactController.current === controller) exactController.current = null }
  }, [target, exactRetry, workspaceId])

  function refresh() {
    requestController.current?.abort()
    pending.current = true
    setBusy(page ? 'refresh' : 'first')
    setIssue(null)
    setRequest(previous => ({ kind: 'first', cursor: null, sequence: previous.sequence + 1 }))
  }
  function more() {
    if (pending.current || !page?.next_cursor || issue?.kind === 'case' || issue?.kind === 'dataset' || issue?.kind === 'invalid') return
    pending.current = true
    setBusy('more')
    setIssue(null)
    setRequest(previous => ({ kind: 'more', cursor: page.next_cursor, sequence: previous.sequence + 1 }))
  }
  function openReport(reportId: string, revision: number) {
    exactController.current?.abort()
    setExact(null)
    setExactIssue(null)
    setExactLoading(true)
    setTarget({ reportId, revision })
  }
  function closeReport() { exactController.current?.abort(); setTarget(null); setExact(null); setExactIssue(null); setExactLoading(false) }
  function retryReport() { exactController.current?.abort(); setExactLoading(true); setExactIssue(null); setExactRetry(value => value + 1) }
  const sources = new Map(page?.source_states.map(source => [sourceKey(source.report_id, source.report_revision), source]) ?? [])
  const moreBlocked = issue?.kind === 'case' || issue?.kind === 'dataset' || issue?.kind === 'invalid'
  const issueText = issue?.kind === 'case' ? 'teaching.caseTimeline.caseChanged' : issue?.kind === 'dataset' ? 'teaching.caseTimeline.datasetChanged' : issue?.kind === 'invalid' ? 'teaching.caseTimeline.invalidPage' : issue?.request === 'more' ? 'teaching.caseTimeline.moreFailed' : 'teaching.caseTimeline.loadFailed'

  return (
    <section className="mt-7 min-w-0 border-t border-border pt-6" aria-labelledby={`student-evidence-${id}`} aria-busy={busy !== null}>
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 id={`student-evidence-${id}`} className="text-lg font-semibold">{t('teaching.caseTimeline.title')}</h3><Button variant="secondary" size="sm" icon={<RefreshCw size={14} />} onClick={refresh}>{t('teaching.caseTimeline.refresh')}</Button></div>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{t('teaching.caseTimeline.hint')}</p>
      {page && <p className="mt-2 text-xs text-muted-foreground"><RecordedTime value={page.generated_at} lastRead /></p>}
      {busy && <p role="status" className="mt-4 text-sm text-muted-foreground">{t(busy === 'more' ? 'teaching.caseTimeline.loadingMore' : busy === 'refresh' ? 'teaching.caseTimeline.refreshing' : 'teaching.caseTimeline.loading')}</p>}
      {!page && busy && <div className="mt-4 grid gap-3"><Skeleton className="h-20 w-full" /><Skeleton className="h-32 w-full" /></div>}
      {issue && <InlineAlert className="mt-4" tone="warning" action={issue.kind === 'case' ? onReloadCase && <Button variant="secondary" size="sm" onClick={onReloadCase}>{t('teaching.caseTimeline.reloadCase')}</Button> : issue.request === 'more' && issue.kind === 'network' ? <Button variant="secondary" size="sm" disabled={busy !== null} onClick={more}>{t('teaching.caseTimeline.retryMore')}</Button> : <Button variant="secondary" size="sm" onClick={refresh}>{t('teaching.caseTimeline.refresh')}</Button>}>{t(issueText)}</InlineAlert>}
      {page && <>
        {page.archived && <InlineAlert className="mt-4">{t('teaching.caseTimeline.archived')}</InlineAlert>}
        <SourceWarnings states={page.source_states} />
        <EvaluationCounts counts={page.counts} />
        {!events.length && !busy && <EmptyState compact title={t('teaching.caseTimeline.emptyTitle')} description={t(!page.counts.linked_reports ? 'teaching.caseTimeline.emptyUnlinked' : page.counts.unavailable_reports ? 'teaching.caseTimeline.emptyUnavailable' : 'teaching.caseTimeline.emptyRecords')} />}
        <ol className="mt-6 grid gap-5" aria-label={t('teaching.caseTimeline.title')}>
          {events.map(event => {
            const reportId = event.kind === 'report' ? event.report_snapshot.report_id : event.attempt.report_id
            const revision = event.kind === 'report' ? event.report_snapshot.report_revision : event.attempt.report_revision
            return <li key={event.event_id} className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3"><span className="inline-flex items-center gap-2 text-xs font-medium text-muted-foreground">{event.kind === 'report' ? <FileText size={15} aria-hidden /> : <ClipboardCheck size={15} aria-hidden />}{t(event.kind === 'report' ? 'teaching.caseTimeline.reportKind' : 'teaching.caseTimeline.attemptKind')}</span><span className="text-xs text-muted-foreground"><RecordedTime value={event.recorded_at} /></span></div>
              {event.kind === 'report' ? <ReportCard snapshot={event.report_snapshot} source={sources.get(sourceKey(reportId, revision))} onOpen={() => openReport(reportId, revision)} /> : <AttemptCard attempt={event.attempt} source={sources.get(sourceKey(reportId, revision))} onOpen={() => openReport(reportId, revision)} />}
            </li>
          })}
        </ol>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3"><p role="status" className="text-xs text-muted-foreground">{t('teaching.caseTimeline.loaded', { n: events.length, total: page.counts.total_events })}</p>{page.next_cursor && <Button variant="secondary" size="sm" disabled={busy !== null || moreBlocked} loading={busy === 'more'} onClick={more}>{t(issue?.kind === 'network' && issue.request === 'more' ? 'teaching.caseTimeline.retryMore' : 'teaching.caseTimeline.more')}</Button>}</div>
      </>}
      <Dialog open={target !== null} title={t('teaching.caseTimeline.exactTitle', { n: target?.revision ?? '' })} size="xl" closeLabel={t('Close')} onClose={closeReport} footer={<Button variant="secondary" onClick={closeReport}>{t('Close')}</Button>}>
        {exactLoading && <p role="status" className="text-sm text-muted-foreground">{t('teaching.caseTimeline.exactLoading')}</p>}
        {exactIssue && <InlineAlert tone="warning" action={<Button variant="secondary" size="sm" disabled={exactLoading} onClick={retryReport}>{t('teaching.caseTimeline.retryExact')}</Button>}>{t(exactIssue === 'invalid' ? 'teaching.caseTimeline.exactInvalid' : 'teaching.caseTimeline.exactUnavailable')}</InlineAlert>}
        {exact && target && exact.report_id === target.reportId && exact.revision === target.revision && exact.status === 'confirmed' && !exactIssue && <ExactReport report={exact} />}
      </Dialog>
    </section>
  )
}
