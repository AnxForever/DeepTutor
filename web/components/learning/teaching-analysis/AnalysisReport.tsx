'use client'

import { useTranslation } from 'react-i18next'
import { ArrowUpRight, Pencil } from 'lucide-react'
import { Button, Field, InlineAlert, StatusChip } from '@/shared/ui'
import type { AssignmentInput, ReportContent, TeachingEvidence, TeachingPriority } from '@/lib/teaching-analysis-api'
import { controlClass, questionAnchor } from './AssignmentEditor'
import { RubricSnapshotView } from './RubricSnapshotView'
import { SourceProvenanceView } from './SourceProvenanceView'

function Evidence({ evidence, assignment }: { evidence: TeachingEvidence[]; assignment: AssignmentInput }) {
  const { t } = useTranslation()
  return (
    <div className="mt-3 grid gap-2" aria-label={t('teaching.sourceEvidence')}>
      {evidence.map((entry, index) => {
        const source = assignment.items.find(item => item.question_id === entry.question_id)
        return (
          <blockquote key={index} className="border-l-2 border-primary/30 bg-muted/40 px-3 py-2 text-sm">
            <a className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline" href={`#${questionAnchor(entry.question_id)}`} onClick={() => {
              const target = document.getElementById(questionAnchor(entry.question_id))
              if (target instanceof HTMLDetailsElement) target.open = true
            }}>
              {entry.question_id}<ArrowUpRight size={12} aria-hidden />
            </a>
            <span className="ml-2 text-xs text-muted-foreground">{source?.source_locator} · {t(`teaching.evidenceField.${entry.field}`)}</span>
            <p className="mt-1 whitespace-pre-wrap break-words">{entry.quote}</p>
          </blockquote>
        )
      })}
    </div>
  )
}

const priorityFields = ['observation', 'hypothesis', 'alternative_explanation', 'teaching_action', 'follow_up_question', 'reference_guidance'] as const

export function AnalysisReport({ analysis, assignment, editing, disabled, onEdit, onChange }: {
  analysis: ReportContent
  assignment: AssignmentInput
  editing: boolean
  disabled: boolean
  onEdit: () => void
  onChange: (report: ReportContent) => void
}) {
  const { t } = useTranslation()
  const updatePriority = (index: number, key: keyof TeachingPriority, value: string) => onChange({ ...analysis, priorities: analysis.priorities.map((priority, i) => i === index ? { ...priority, [key]: value } : priority) })
  return (
    <section aria-labelledby="teaching-report-title" className="mt-8 border-t border-border pt-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="teaching-report-title" tabIndex={-1} className="text-lg font-semibold">{t('teaching.reportTitle')}</h2>
        <Button variant="secondary" size="sm" icon={<Pencil size={14} />} onClick={onEdit} disabled={disabled}>{t(editing ? 'teaching.finishEditing' : 'teaching.editReport')}</Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t('teaching.evidenceReadOnly')}</p>
      {assignment.rubric_template && <RubricSnapshotView snapshot={assignment.rubric_template} />}
      <SourceProvenanceView assignment={assignment} />
      <div className="mt-4 rounded-xl border border-border bg-card p-4 sm:p-5">
        {editing ? <Field label={t('teaching.summary')}><textarea className={controlClass} disabled={disabled} rows={3} value={analysis.summary} onChange={e => onChange({ ...analysis, summary: e.target.value })} /></Field> : <p className="whitespace-pre-wrap text-sm leading-6">{analysis.summary}</p>}
      </div>
      <h3 className="mb-3 mt-6 text-sm font-semibold">{t('teaching.itemReview')}</h3>
      <div className="grid gap-3">
        {analysis.items.map((item, index) => (
          <article key={item.question_id} className="rounded-xl border border-border p-4">
            <div className="flex items-center gap-3">
              <h4 className="text-sm font-semibold">{item.question_id}</h4>
              <StatusChip tone={item.result === 'correct' ? 'success' : item.result === 'ungraded' ? 'warning' : 'neutral'}>{t(`teaching.result.${item.result}`)}</StatusChip>
            </div>
            {editing ? <Field className="mt-3" label={t('teaching.itemObservation', { id: item.question_id })}><textarea className={controlClass} disabled={disabled} rows={2} value={item.observation} onChange={e => onChange({ ...analysis, items: analysis.items.map((value, i) => i === index ? { ...value, observation: e.target.value } : value) })} /></Field> : <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{item.observation}</p>}
            <Evidence evidence={item.evidence} assignment={assignment} />
          </article>
        ))}
      </div>
      <h3 className="mb-3 mt-6 text-sm font-semibold">{t('teaching.priorities')}</h3>
      {!analysis.priorities.length && <p className="text-sm text-muted-foreground">{t('teaching.noPriority')}</p>}
      <div className="grid gap-4">
        {analysis.priorities.map((priority, index) => (
          <article key={index} className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h4 className="text-base font-semibold">{index + 1}. {priority.knowledge_point}</h4>
              <StatusChip tone={priority.evidence_status === 'needs_check' ? 'warning' : 'info'}>{t(`teaching.evidenceStatus.${priority.evidence_status}`)}</StatusChip>
            </div>
            <Evidence evidence={priority.evidence} assignment={assignment} />
            <dl className="mt-4 grid gap-4 sm:grid-cols-2">
              {priorityFields.map(key => (
                <div key={key} className={key === 'teaching_action' || key === 'follow_up_question' ? 'sm:col-span-2' : ''}>
                  {editing ? <Field label={t(`teaching.priority.${key}`, { n: index + 1 })}><textarea className={controlClass} disabled={disabled} rows={2} value={priority[key]} onChange={e => updatePriority(index, key, e.target.value)} /></Field> : <><dt className="text-xs font-medium text-muted-foreground">{t(`teaching.priorityView.${key}`)}</dt><dd className="mt-1 whitespace-pre-wrap text-sm leading-6">{priority[key] || t('teaching.notProvided')}</dd></>}
                </div>
              ))}
            </dl>
          </article>
        ))}
      </div>
      {analysis.limitations.length > 0 && <InlineAlert tone="warning" title={t('teaching.limitations')} className="mt-5"><ul className="list-disc space-y-1 pl-4">{analysis.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></InlineAlert>}
    </section>
  )
}

export function reportMarkdown(assignment: AssignmentInput, analysis: ReportContent, notes: string, labels: {
  title: string; status: string; source: string; priorities: string; limitations: string; notes: string
}) {
  const lines = [`# ${labels.title}`, '', labels.status, '', `${assignment.student_ref} / ${assignment.assignment_ref}`, `${assignment.subject} · ${assignment.grade}`, '', analysis.summary, '']
  if (assignment.rubric_template) lines.push(`## ${assignment.rubric_template.name} · v${assignment.rubric_template.revision}`, '', assignment.rubric_template.criteria, '')
  for (const finding of analysis.items) {
    const item = assignment.items.find(row => row.question_id === finding.question_id)
    lines.push(`## ${finding.question_id} · ${finding.result}`, '', finding.observation, '', `${labels.source}: ${item?.source_locator ?? ''}`, '')
    for (const evidence of finding.evidence) lines.push(...evidence.quote.split('\n').map(line => `> ${line}`), '')
  }
  lines.push(`## ${labels.priorities}`, '')
  for (const priority of analysis.priorities) {
    lines.push(`### ${priority.knowledge_point}`, '', priority.observation, '', priority.hypothesis, '', priority.alternative_explanation, '', priority.teaching_action, '', priority.follow_up_question, '', priority.reference_guidance, '')
    for (const evidence of priority.evidence) lines.push(`${evidence.question_id}:`, ...evidence.quote.split('\n').map(line => `> ${line}`), '')
  }
  lines.push(`## ${labels.limitations}`, '', ...analysis.limitations.map(item => `- ${item}`), '', `## ${labels.notes}`, '', notes)
  return lines.join('\n')
}
