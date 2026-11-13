'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, InlineAlert, StatusChip } from '@/shared/ui'
import {
  getTeachingReportRevisions,
  listTeachingReports,
  type SavedTeachingReport,
  type TeachingReportSummary,
} from '@/lib/teaching-analysis-api'
import {
  getTeachingReportRevision,
  type StudentCaseReportRef,
  type StudentCaseSourceState,
} from '@/lib/teaching-student-cases-api'
import { ReportHistory } from './ReportHistory'

export interface StudentCaseReportPickerProps {
  workspaceId: string
  reportRefs: StudentCaseReportRef[]
  onChange: (refs: StudentCaseReportRef[]) => void
  disabled: boolean
  sourceStates?: StudentCaseSourceState[]
}

type ReportChoice = Pick<
  TeachingReportSummary,
  'report_id' | 'revision' | 'student_ref' | 'assignment_ref' | 'subject'
>
type Viewer =
  | {
      kind: 'preview'
      reportId: string
      revision: number
      value: SavedTeachingReport | null
      loading: boolean
      failed: boolean
    }
  | {
      kind: 'history'
      reportId: string
      versions: SavedTeachingReport[]
      loading: boolean
      failed: boolean
    }

const sameReport = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()
const shortId = (id: string) => id.slice(0, 8)

/** Report labels are reviewed by the teacher, never used as an identity join. */
export function StudentCaseReportPicker({ workspaceId, ...props }: StudentCaseReportPickerProps) {
  return <ScopedReportPicker key={workspaceId} workspaceId={workspaceId} {...props} />
}

function ScopedReportPicker({
  workspaceId,
  reportRefs,
  onChange,
  disabled,
  sourceStates = [],
}: StudentCaseReportPickerProps) {
  const { t } = useTranslation()
  const [reports, setReports] = useState<TeachingReportSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [listFailed, setListFailed] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [replacement, setReplacement] = useState<{
    choice: ReportChoice
    oldRevision: number
  } | null>(null)
  const [viewer, setViewer] = useState<Viewer | null>(null)
  const viewerRequest = useRef<AbortController | null>(null)
  const viewerSequence = useRef(0)

  useEffect(() => {
    const controller = new AbortController()
    void listTeachingReports(workspaceId, controller.signal)
      .then(value => {
        if (controller.signal.aborted) return
        setReports(value)
        setListFailed(false)
      })
      .catch(() => {
        if (!controller.signal.aborted) setListFailed(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [workspaceId, refresh])

  useEffect(() => () => viewerRequest.current?.abort(), [])

  function choose(choice: ReportChoice) {
    if (disabled) return
    const current = reportRefs.find(ref => sameReport(ref.report_id, choice.report_id))
    if (current?.report_revision === choice.revision) return
    if (current) {
      closeViewer()
      setReplacement({ choice, oldRevision: current.report_revision })
      return
    }
    if (reportRefs.length >= 20) return
    onChange([...reportRefs, { report_id: choice.report_id, report_revision: choice.revision }])
    closeViewer()
  }

  function confirmReplacement() {
    if (disabled || !replacement) return
    const current = reportRefs.find(ref => sameReport(ref.report_id, replacement.choice.report_id))
    // A changed parent editor must not be overwritten by an older open dialog.
    if (current?.report_revision === replacement.oldRevision) {
      onChange(
        reportRefs.map(ref =>
          sameReport(ref.report_id, current.report_id)
            ? {
                report_id: replacement.choice.report_id,
                report_revision: replacement.choice.revision,
              }
            : ref
        )
      )
    }
    setReplacement(null)
  }

  function closeViewer() {
    viewerSequence.current += 1
    viewerRequest.current?.abort()
    setViewer(null)
  }

  async function preview(ref: StudentCaseReportRef) {
    viewerRequest.current?.abort()
    const controller = new AbortController()
    viewerRequest.current = controller
    const sequence = ++viewerSequence.current
    setViewer({
      kind: 'preview',
      reportId: ref.report_id,
      revision: ref.report_revision,
      value: null,
      loading: true,
      failed: false,
    })
    try {
      const report = await getTeachingReportRevision(
        ref.report_id,
        ref.report_revision,
        workspaceId,
        controller.signal
      )
      if (controller.signal.aborted || sequence !== viewerSequence.current) return
      if (
        !sameReport(report.report_id, ref.report_id) ||
        report.revision !== ref.report_revision ||
        report.status !== 'confirmed'
      )
        throw new Error('Saved report mismatch')
      setViewer({
        kind: 'preview',
        reportId: ref.report_id,
        revision: ref.report_revision,
        value: report,
        loading: false,
        failed: false,
      })
    } catch {
      if (!controller.signal.aborted && sequence === viewerSequence.current)
        setViewer({
          kind: 'preview',
          reportId: ref.report_id,
          revision: ref.report_revision,
          value: null,
          loading: false,
          failed: true,
        })
    }
  }

  async function history(reportId: string) {
    if (disabled) return
    viewerRequest.current?.abort()
    const controller = new AbortController()
    viewerRequest.current = controller
    const sequence = ++viewerSequence.current
    setViewer({ kind: 'history', reportId, versions: [], loading: true, failed: false })
    try {
      const versions = await getTeachingReportRevisions(reportId, workspaceId, controller.signal)
      if (controller.signal.aborted || sequence !== viewerSequence.current) return
      setViewer({
        kind: 'history',
        reportId,
        versions: versions.filter(
          version => sameReport(version.report_id, reportId) && version.status === 'confirmed'
        ),
        loading: false,
        failed: false,
      })
    } catch {
      if (!controller.signal.aborted && sequence === viewerSequence.current)
        setViewer({ kind: 'history', reportId, versions: [], loading: false, failed: true })
    }
  }

  function choiceLabel(choice: ReportChoice) {
    return t('teaching.cases.selectReport', {
      student: choice.student_ref,
      assignment: choice.assignment_ref,
      subject: choice.subject,
      n: choice.revision,
      id: shortId(choice.report_id),
    })
  }

  function choiceButton(choice: ReportChoice) {
    const pin = reportRefs.find(ref => sameReport(ref.report_id, choice.report_id))
    return (
      <Button
        size="sm"
        variant="secondary"
        disabled={
          disabled || pin?.report_revision === choice.revision || (!pin && reportRefs.length >= 20)
        }
        onClick={() => choose(choice)}
      >
        {choiceLabel(choice)}
      </Button>
    )
  }

  return (
    <section
      className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5"
      aria-label={t('teaching.cases.links')}
    >
      <div>
        <h2 className="text-base font-semibold">{t('teaching.cases.links')}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {t('teaching.cases.linkHint')}
        </p>
      </div>
      {!reportRefs.length && (
        <p className="text-sm text-muted-foreground">{t('teaching.cases.noneLinked')}</p>
      )}
      <ul className="space-y-3">
        {reportRefs.map(ref => {
          const state = sourceStates.find(
            source =>
              sameReport(source.report_id, ref.report_id) &&
              source.report_revision === ref.report_revision
          )
          const latest = reports.find(report => sameReport(report.report_id, ref.report_id))
          const exactSummary = latest?.revision === ref.report_revision ? latest : undefined
          const status =
            state?.status === 'unavailable'
              ? 'unavailable'
              : latest && latest.revision > ref.report_revision
                ? 'stale'
                : state?.status
          return (
            <li key={ref.report_id} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="break-words text-sm font-medium">
                  {t('teaching.cases.pin', { id: shortId(ref.report_id), n: ref.report_revision })}
                </p>
                {status && (
                  <StatusChip tone={status === 'current' ? 'neutral' : 'warning'}>
                    {t(`teaching.cases.${status === 'unavailable' ? 'unavailable' : status}`)}
                  </StatusChip>
                )}
              </div>
              {(state?.student_ref || exactSummary) && (
                <p className="mt-1 break-words text-sm text-muted-foreground">
                  {state?.student_ref ?? exactSummary?.student_ref} ·{' '}
                  {state?.assignment_ref ?? exactSummary?.assignment_ref}
                  {exactSummary?.subject ? ` · ${exactSummary.subject}` : ''}
                </p>
              )}
              {!status && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('teaching.cases.sourcePending')}
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => void preview(ref)}>
                  {t('teaching.cases.viewPin', { id: shortId(ref.report_id) })}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => void history(ref.report_id)}
                >
                  {t('teaching.cases.chooseReportVersion', { id: shortId(ref.report_id) })}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => {
                    if (!disabled)
                      onChange(reportRefs.filter(pin => !sameReport(pin.report_id, ref.report_id)))
                  }}
                >
                  {t('teaching.cases.removePin', { id: shortId(ref.report_id) })}
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
      {reportRefs.length >= 20 && (
        <InlineAlert tone="warning">{t('teaching.cases.maxPins')}</InlineAlert>
      )}
      <details className="border-t border-border pt-4">
        <summary className="cursor-pointer rounded-lg text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
          {t('teaching.cases.browseReports')}
        </summary>
        <div className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">{t('teaching.cases.recentReports')}</h3>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || loading}
              onClick={() => {
                setLoading(true)
                setRefresh(value => value + 1)
              }}
            >
              {t('teaching.cases.refreshReports')}
            </Button>
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {t('teaching.cases.pickerHint')}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t('teaching.cases.latest100')}
          </p>
        </div>
        {listFailed && (
          <InlineAlert tone="warning">{t('teaching.cases.reportsFailed')}</InlineAlert>
        )}
        {loading && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('Loading...')}
          </p>
        )}
        {!loading && !listFailed && !reports.length && (
          <p className="text-sm text-muted-foreground">{t('teaching.cases.noReports')}</p>
        )}
        <div
          className="mt-4 max-h-[28rem] space-y-3 overflow-y-auto overscroll-contain pr-1"
          tabIndex={0}
          role="region"
          aria-label={t('teaching.cases.recentReports')}
        >
          {reports.map(report => {
            const pin = reportRefs.find(ref => sameReport(ref.report_id, report.report_id))
            return (
              <article key={report.report_id} className="rounded-lg border border-border p-3">
                <p className="break-words text-sm font-medium">
                  {report.student_ref} · {report.assignment_ref}
                </p>
                <p className="mt-1 break-words text-xs text-muted-foreground">
                  {report.subject} · {t('teaching.revision', { n: report.revision })} ·{' '}
                  {shortId(report.report_id)}
                </p>
                <StatusChip
                  className="mt-2"
                  tone={report.status === 'confirmed' ? 'neutral' : 'warning'}
                >
                  {t(`teaching.status.${report.status}`)}
                </StatusChip>
                {pin && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t('teaching.cases.alreadyPinned', { n: pin.report_revision })}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {report.status === 'confirmed' && choiceButton(report)}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => void history(report.report_id)}
                  >
                    {t('teaching.cases.chooseReportVersion', { id: shortId(report.report_id) })}
                  </Button>
                </div>
              </article>
            )
          })}
        </div>
      </details>
      <Dialog
        open={Boolean(
          replacement &&
          reportRefs.some(
            ref =>
              sameReport(ref.report_id, replacement.choice.report_id) &&
              ref.report_revision === replacement.oldRevision
          )
        )}
        onClose={() => setReplacement(null)}
        title={t('teaching.cases.changePinTitle')}
        closeLabel={t('Close')}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setReplacement(null)}>
              {t('Cancel')}
            </Button>
            <Button size="sm" disabled={disabled} onClick={confirmReplacement}>
              {t('teaching.cases.changePinConfirm')}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-6 text-muted-foreground">
          {t('teaching.cases.changePinHint', {
            old: replacement?.oldRevision,
            next: replacement?.choice.revision,
          })}
        </p>
        {replacement && (
          <p className="mt-3 break-words text-sm">{choiceLabel(replacement.choice)}</p>
        )}
      </Dialog>
      <Dialog
        open={viewer !== null}
        onClose={closeViewer}
        title={
          viewer?.kind === 'preview'
            ? t('teaching.caseTimeline.exactTitle', { n: viewer.revision })
            : t('teaching.history')
        }
        closeLabel={t('Close')}
        size="xl"
      >
        {viewer?.loading && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('Loading...')}
          </p>
        )}
        {viewer?.failed && (
          <InlineAlert
            tone="warning"
            action={
              <Button
                size="sm"
                variant="secondary"
                disabled={viewer.kind === 'history' && disabled}
                onClick={() => {
                  if (viewer.kind === 'preview')
                    void preview({ report_id: viewer.reportId, report_revision: viewer.revision })
                  else void history(viewer.reportId)
                }}
              >
                {t('Retry')}
              </Button>
            }
          >
            {t('teaching.cases.previewFailed')}
          </InlineAlert>
        )}
        {viewer?.kind === 'preview' && viewer.value && <ReportHistory versions={[viewer.value]} />}
        {viewer?.kind === 'history' && !viewer.loading && !viewer.failed && (
          <>
            <p className="text-xs leading-5 text-muted-foreground">
              {t('teaching.cases.reportHistory100')}
            </p>
            {!viewer.versions.length && (
              <p className="mt-3 text-sm text-muted-foreground">{t('teaching.cases.noReports')}</p>
            )}
            <div className="mt-3 space-y-3">
              {viewer.versions.map(version => {
                const choice = {
                  report_id: version.report_id,
                  revision: version.revision,
                  student_ref: version.assignment.student_ref,
                  assignment_ref: version.assignment.assignment_ref,
                  subject: version.assignment.subject,
                }
                return (
                  <article key={version.revision} className="rounded-lg border border-border p-3">
                    <p className="break-words text-sm">
                      {version.assignment.student_ref} · {version.assignment.assignment_ref} ·{' '}
                      {version.assignment.subject} ·{' '}
                      {t('teaching.revision', { n: version.revision })} ·{' '}
                      {shortId(version.report_id)}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {choiceButton(choice)}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={disabled}
                        onClick={() =>
                          void preview({
                            report_id: version.report_id,
                            report_revision: version.revision,
                          })
                        }
                      >
                        {t('teaching.cases.viewPin', { id: shortId(version.report_id) })}
                      </Button>
                    </div>
                  </article>
                )
              })}
            </div>
          </>
        )}
      </Dialog>
    </section>
  )
}
