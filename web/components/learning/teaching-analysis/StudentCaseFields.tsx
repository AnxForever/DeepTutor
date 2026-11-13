'use client'

import { useTranslation } from 'react-i18next'
import { Field } from '@/shared/ui'
import type { SaveStudentCaseRequest } from '@/lib/teaching-student-cases-api'
import { controlClass } from './AssignmentEditor'

export function StudentCaseFields({ value, disabled, onChange }: { value: SaveStudentCaseRequest; disabled: boolean; onChange: (value: SaveStudentCaseRequest) => void }) {
  const { t } = useTranslation()
  return <fieldset disabled={disabled} className="grid min-w-0 gap-4 sm:grid-cols-2">
    <Field label={t('teaching.cases.label')} hint={t('teaching.cases.labelHint')}><input className={controlClass} maxLength={200} autoComplete="off" value={value.label} onChange={event => onChange({ ...value, label: event.target.value })} /></Field>
    <Field label={t('teaching.cases.subject')} hint={t('teaching.cases.subjectHint')}><input className={controlClass} maxLength={200} value={value.subject ?? ''} onChange={event => onChange({ ...value, subject: event.target.value || null })} /></Field>
  </fieldset>
}
