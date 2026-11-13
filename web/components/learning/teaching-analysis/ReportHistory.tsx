'use client'

import { useTranslation } from 'react-i18next'
import type { SavedTeachingReport } from '@/lib/teaching-analysis-api'
import { RubricSnapshotView } from './RubricSnapshotView'
import { SourceProvenanceView } from './SourceProvenanceView'

/** Historical quotes refer to their own saved assignment, never the current editor. */
export function ReportHistory({ versions }: { versions: SavedTeachingReport[] }) {
  const { t } = useTranslation()
  return (
    <section className="mt-6 rounded-xl border border-border p-4" aria-label={t('teaching.history')}>
      <h3 className="mb-3 font-semibold">{t('teaching.history')}</h3>
      {versions.map(version => (
        <details key={version.revision} className="border-t border-border/60 py-3">
          <summary className="cursor-pointer text-sm">{t('teaching.revision', { n: version.revision })} · {t(`teaching.status.${version.status}`)}</summary>
          <p className="mt-2 text-xs text-muted-foreground">{version.assignment.student_ref} · {version.assignment.assignment_ref} · {version.assignment.subject}</p>
          <p className="mt-2 whitespace-pre-wrap text-sm">{version.analysis.summary}</p>
          {version.assignment.rubric_template && <RubricSnapshotView snapshot={version.assignment.rubric_template} />}
          <SourceProvenanceView assignment={version.assignment} />
          <details className="mt-3 rounded-lg bg-muted/40 p-3">
            <summary className="cursor-pointer text-sm font-medium">{t('teaching.savedMaterial')}</summary>
            {version.assignment.items.map(item => <div key={item.question_id} className="mt-3 border-t border-border/60 pt-3 text-sm"><p className="font-medium">{item.question_id} · {item.source_locator}</p><p className="mt-1 whitespace-pre-wrap">{item.question}</p><p className="mt-1 text-xs text-muted-foreground">{t(`teaching.answerStatus.${item.answer_status}`)} · {t(`teaching.assistanceStatus.${item.assistance}`)}</p><blockquote className="mt-1 whitespace-pre-wrap border-l-2 border-border pl-3">{item.student_answer ?? t('teaching.answerStatus.unknown')}{item.student_work ? `\n${item.student_work}` : ''}</blockquote>{item.reference_answer && <p className="mt-2 whitespace-pre-wrap">{t('teaching.priorityView.reference_guidance')}: {item.reference_answer}</p>}</div>)}
          </details>
          <h4 className="mt-4 text-sm font-semibold">{t('teaching.itemReview')}</h4>
          {version.analysis.items.map(item => <div key={item.question_id} className="mt-3 border-l-2 border-border pl-3 text-sm"><p className="font-medium">{item.question_id} · {t(`teaching.result.${item.result}`)}</p><p className="whitespace-pre-wrap">{item.observation}</p>{item.evidence.map((entry, i) => <blockquote key={i} className="mt-1 whitespace-pre-wrap text-muted-foreground">{entry.quote}</blockquote>)}</div>)}
          <h4 className="mt-4 text-sm font-semibold">{t('teaching.priorities')}</h4>
          {version.analysis.priorities.map((priority, index) => <article key={index} className="mt-3 rounded-lg border border-border/70 p-3"><h5 className="text-sm font-semibold">{priority.knowledge_point}</h5><p className="mt-1 text-xs text-muted-foreground">{t(`teaching.evidenceStatus.${priority.evidence_status}`)}</p><dl className="mt-3 grid gap-3">{(['observation', 'hypothesis', 'alternative_explanation', 'teaching_action', 'follow_up_question', 'reference_guidance'] as const).map(key => <div key={key}><dt className="text-xs text-muted-foreground">{t(`teaching.priorityView.${key}`)}</dt><dd className="mt-1 whitespace-pre-wrap text-sm">{priority[key] || t('teaching.notProvided')}</dd></div>)}</dl>{priority.evidence.map((entry, i) => <blockquote key={i} className="mt-3 whitespace-pre-wrap border-l-2 border-border pl-3 text-sm text-muted-foreground">{entry.question_id} · {version.assignment.items.find(item => item.question_id === entry.question_id)?.source_locator}{'\n'}{entry.quote}</blockquote>)}</article>)}
          {version.analysis.limitations.length > 0 && <><h4 className="mt-4 text-sm font-semibold">{t('teaching.limitations')}</h4><ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{version.analysis.limitations.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
          {version.teacher_notes && <><h4 className="mt-4 text-sm font-semibold">{t('teaching.notes')}</h4><p className="mt-2 whitespace-pre-wrap text-sm">{version.teacher_notes}</p></>}
        </details>
      ))}
    </section>
  )
}
