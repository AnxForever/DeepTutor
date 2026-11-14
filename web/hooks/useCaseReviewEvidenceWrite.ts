'use client'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cloneCaseEvidenceRequest, matchesCaseEvidenceReceipt, saveCaseTaskReviewEvidence, type SaveCaseReviewEvidence, type CaseReviewEvidenceView } from '@/lib/teaching-case-review-api'
import type { CaseEvidenceMutation } from '@/lib/teaching-case-review-drafts'

export function useCaseReviewEvidenceWrite(options: { caseId: string | null; workspaceId: string; recipient?: string; mutation: CaseEvidenceMutation | null; clear: () => Promise<void>; onHead?: (view: CaseReviewEvidenceView) => void; onSent: (payload: SaveCaseReviewEvidence) => void; onAcknowledged: (requestId: string) => void; onCleared: (requestId: string) => void; onKeepAcknowledged: (requestId: string) => void }) {
  const callbacks = useRef(options)
  useLayoutEffect(() => { callbacks.current = options }, [options])
  const [error, setError] = useState(false)
  const [cleanupError, setCleanupError] = useState(false)
  const [cleanupRetry, setCleanupRetry] = useState(0)
  const [operation, setOperation] = useState<string | null>(null)
  const pending = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const scope = `${options.workspaceId}:${options.caseId ?? ''}`
  const acknowledged = options.mutation?.acknowledged_request_id
  const clearDraft = options.clear
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current?.abort(); pending.current = null } }, [scope])
  useEffect(() => {
    if (!acknowledged) return
    let active = true
    void clearDraft().then(() => { if (active && mounted.current) callbacks.current.onCleared(acknowledged) }).catch(() => { if (active && mounted.current) { setCleanupError(true); callbacks.current.onKeepAcknowledged(acknowledged) } })
    return () => { active = false }
  }, [acknowledged, cleanupRetry, clearDraft, scope])
  async function submit() {
    const current = callbacks.current
    if (!current.caseId || !current.mutation || current.mutation.acknowledged_request_id || pending.current) return
    const body = cloneCaseEvidenceRequest(current.mutation.payload)
    const controller = new AbortController(); pending.current = controller; setOperation(scope); setError(false); current.onSent(cloneCaseEvidenceRequest(body))
    try {
      const view = await saveCaseTaskReviewEvidence(current.caseId, body, current.workspaceId, controller.signal)
      if (!mounted.current || controller.signal.aborted) return
      if (!matchesCaseEvidenceReceipt(view, current.caseId, body, current.recipient)) { setError(true); return }
      setCleanupError(false); current.onHead?.(view); current.onAcknowledged(body.request_id)
    } catch { if (mounted.current && !controller.signal.aborted) setError(true) }
    finally { if (pending.current === controller) pending.current = null; if (mounted.current && !controller.signal.aborted) setOperation(null) }
  }
  return { submit, posting: operation === scope, error, cleanupError, acknowledged: Boolean(acknowledged), stopWaiting() { pending.current?.abort(); pending.current = null; setOperation(null); setError(true) }, retryCleanup() { setCleanupError(false); setCleanupRetry(value => value + 1) }, clearError() { setError(false) } }
}
