'use client'

import { Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import { Button, Field, InlineAlert, StatusChip } from '@/shared/ui'
import type { AssignmentInput, AssignmentItem } from '@/lib/teaching-analysis-api'
import { emptyAssignmentItem } from './sample'
import { SourceProvenanceView } from './SourceProvenanceView'

export const controlClass = 'w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring disabled:opacity-60'
export const questionAnchor = (id: string) => `teaching-item-${encodeURIComponent(id)}`

export function AssignmentEditor({ assignment, disabled, onChange, afterContext }: {
  assignment: AssignmentInput
  disabled: boolean
  onChange: (value: AssignmentInput) => void
  afterContext?: ReactNode
}) {
  const { t } = useTranslation()
  const updateItem = (index: number, update: Partial<AssignmentItem>) => {
    onChange({ ...assignment, items: assignment.items.map((item, i) => i === index ? { ...item, ...update } : item) })
  }
  const setText = (key: 'student_ref' | 'assignment_ref' | 'subject' | 'grade' | 'teacher_context', value: string) => onChange({ ...assignment, [key]: value })
  return (
    <section aria-labelledby="teaching-material-title" className="mt-7">
      <div className="mb-4">
        <h2 id="teaching-material-title" className="text-base font-semibold">{t('teaching.materialTitle')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('teaching.materialHint')}</p>
      </div>
      <fieldset disabled={disabled} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Field label={t('teaching.studentLabel')} hint={t('teaching.studentHint')}>
          <input className={controlClass} value={assignment.student_ref} onChange={e => setText('student_ref', e.target.value)} autoComplete="off" />
        </Field>
        <Field label={t('teaching.assignmentLabel')}>
          <input className={controlClass} value={assignment.assignment_ref} onChange={e => setText('assignment_ref', e.target.value)} />
        </Field>
        <Field label={t('teaching.subject')}>
          <input className={controlClass} value={assignment.subject} onChange={e => setText('subject', e.target.value)} />
        </Field>
        <Field label={t('teaching.grade')}>
          <input className={controlClass} value={assignment.grade} onChange={e => setText('grade', e.target.value)} />
        </Field>
        <Field label={t('teaching.context')} className="sm:col-span-2">
          <textarea className={controlClass} rows={2} value={assignment.teacher_context} onChange={e => setText('teacher_context', e.target.value)} />
        </Field>
      </fieldset>
      {afterContext}
      <SourceProvenanceView assignment={assignment} disabled={disabled} onClear={() => onChange({ ...assignment, document_provenance: null })} />
      <div className="mt-5 grid gap-3">
        {assignment.items.map((item, index) => (
          <details key={index} open={index === 0 ? true : undefined} className="rounded-xl border border-border bg-card" id={questionAnchor(item.question_id)}>
            <summary className="cursor-pointer rounded-xl px-4 py-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
              <span className="ml-1 font-semibold">{item.question_id || t('teaching.unnamedItem')}</span>
              <span className="ml-3 inline-block max-w-[55%] truncate align-bottom text-muted-foreground">{item.question || t('teaching.emptyQuestion')}</span>
              <span className="ml-2"><StatusChip tone={item.answer_status === 'unknown' || item.transcription_status === 'uncertain' ? 'warning' : 'neutral'}>{t(`teaching.answerStatus.${item.answer_status}`)}</StatusChip></span>
            </summary>
            <fieldset disabled={disabled} className="grid min-w-0 gap-4 border-t border-border/60 p-4 sm:grid-cols-2">
              {assignment.document_provenance && item.transcription_status === 'uncertain' && <InlineAlert tone="warning" className="sm:col-span-2" action={<Button size="sm" variant="secondary" disabled={disabled} onClick={() => updateItem(index, { transcription_status: 'confirmed' })}>{t('teaching.documents.confirmItem')}</Button>}>{t('teaching.documents.itemNeedsReview')}</InlineAlert>}
              <Field label={t('teaching.questionId', { n: index + 1 })}>
                <input className={controlClass} value={item.question_id} onChange={e => updateItem(index, { question_id: e.target.value })} />
              </Field>
              <Field label={t('teaching.question', { n: index + 1 })} className="sm:col-span-2">
                <textarea className={controlClass} rows={2} value={item.question} onChange={e => updateItem(index, { question: e.target.value })} />
              </Field>
              <Field label={t('teaching.answerState', { n: index + 1 })} hint={t('teaching.answerStateHint')}>
                <select className={controlClass} value={item.answer_status} onChange={e => {
                  const answer_status = e.target.value as AssignmentItem['answer_status']
                  updateItem(index, { answer_status, ...(answer_status === 'confirmed_blank' ? { student_answer: '', student_work: '' } : answer_status === 'unknown' ? { student_answer: null } : {}) })
                }}>
                  {(['present', 'confirmed_blank', 'unknown'] as const).map(status => <option key={status} value={status}>{t(`teaching.answerStatus.${status}`)}</option>)}
                </select>
              </Field>
              <Field label={t('teaching.studentAnswer', { n: index + 1 })}>
                <textarea className={controlClass} rows={2} disabled={item.answer_status === 'confirmed_blank'} value={item.student_answer ?? ''} onChange={e => {
                  const value = e.target.value
                  updateItem(index, { student_answer: value || null, answer_status: value.trim() ? 'present' : item.student_work?.trim() && item.answer_status === 'present' ? 'present' : 'unknown' })
                }} />
              </Field>
              <Field label={t('teaching.studentWork', { n: index + 1 })}>
                <textarea className={controlClass} rows={2} disabled={item.answer_status === 'confirmed_blank'} value={item.student_work ?? ''} onChange={e => {
                  const value = e.target.value
                  updateItem(index, { student_work: value || null, ...(!value.trim() && !item.student_answer?.trim() ? { answer_status: 'unknown' as const } : value.trim() && item.answer_status === 'unknown' && item.transcription_status !== 'uncertain' ? { answer_status: 'present' as const } : {}) })
                }} />
              </Field>
              <Field label={t('teaching.reference', { n: index + 1 })}>
                <textarea className={controlClass} rows={2} value={item.reference_answer ?? ''} onChange={e => updateItem(index, { reference_answer: e.target.value || null })} />
              </Field>
              <details className="rounded-lg bg-muted/30 p-3 sm:col-span-2">
                <summary className="cursor-pointer text-sm font-medium text-muted-foreground">{t('teaching.moreItemInfo', { n: index + 1 })}</summary>
                <div className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2">
                  <Field label={t('teaching.source', { n: index + 1 })}>
                    <input className={controlClass} maxLength={500} placeholder={t('teaching.sourcePlaceholder')} value={item.source_locator} onChange={e => updateItem(index, { source_locator: e.target.value })} />
                  </Field>
                  <Field label={t('teaching.knowledge', { n: index + 1 })} hint={t('teaching.knowledgeHint')}>
                    <input key={JSON.stringify(item.knowledge_points)} className={controlClass} defaultValue={item.knowledge_points.join(', ')} onBlur={e => updateItem(index, { knowledge_points: e.target.value.split(/[,，;；]/).map(x => x.trim()).filter(Boolean) })} />
                  </Field>
                  <Field label={t('teaching.transcription', { n: index + 1 })}>
                    <select className={controlClass} value={item.transcription_status} onChange={e => updateItem(index, { transcription_status: e.target.value as AssignmentItem['transcription_status'] })}>
                      {(['confirmed', 'uncertain', 'not_applicable'] as const).map(status => <option key={status} value={status}>{t(`teaching.transcriptionStatus.${status}`)}</option>)}
                    </select>
                  </Field>
                  <Field label={t('teaching.assistance', { n: index + 1 })}>
                    <select className={controlClass} value={item.assistance} onChange={e => updateItem(index, { assistance: e.target.value as AssignmentItem['assistance'] })}>
                      {(['independent', 'assisted', 'unknown'] as const).map(status => <option key={status} value={status}>{t(`teaching.assistanceStatus.${status}`)}</option>)}
                    </select>
                  </Field>
                  <Field label={t('teaching.rubric', { n: index + 1 })} className="sm:col-span-2">
                    <textarea className={controlClass} rows={2} value={item.rubric ?? ''} onChange={e => updateItem(index, { rubric: e.target.value || null })} />
                  </Field>
                </div>
              </details>
              <div className="sm:col-span-2">
                <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={() => onChange({ ...assignment, items: assignment.items.filter((_, i) => i !== index) })}>{t('teaching.removeItem', { n: index + 1 })}</Button>
              </div>
            </fieldset>
          </details>
        ))}
      </div>
      <Button className="mt-4" size="sm" variant="secondary" disabled={disabled || assignment.items.length >= 40} icon={<Plus size={15} />} onClick={() => {
        let next = assignment.items.length + 1
        while (assignment.items.some(item => item.question_id === `Q${next}`)) next++
        onChange({ ...assignment, items: [...assignment.items, emptyAssignmentItem(next)] })
      }}>{t('teaching.addItem')}</Button>
    </section>
  )
}
