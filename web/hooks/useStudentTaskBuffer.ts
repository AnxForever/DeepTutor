'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { TeachingDraftConflict, type TeachingDraftRecord, type TeachingDraftRepository } from '@/lib/teaching-drafts'
import { createStudentTaskBufferRepository, isStudentTaskBuffer, trackStudentTaskBufferWrite, waitForStudentTaskBufferWrites, type StudentTaskBuffer } from '@/lib/student-task-buffers'

export function useStudentTaskBuffer({ accountId, taskId, value, dirty, onRestore, repository: suppliedRepository }: {
  accountId: string
  taskId: string
  value: StudentTaskBuffer
  dirty: boolean
  onRestore: (value: StudentTaskBuffer) => void
  repository?: TeachingDraftRepository
}) {
  const router = useRouter()
  const owner = useMemo(() => ({ accountId, taskId, repository: createStudentTaskBufferRepository() }), [accountId, taskId])
  const repository = suppliedRepository ?? owner.repository
  const scope = useMemo(() => ({ accountId, workspaceId: '' }), [accountId])
  const slot = `student-task:${taskId}`
  const [phase, setPhase] = useState<'reading' | 'ready' | 'pending' | 'read-error'>('reading')
  const [pending, setPending] = useState<TeachingDraftRecord | null>(null)
  const [error, setError] = useState<'storage' | 'conflict' | null>(null)
  const [localSaved, setLocalSaved] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(false)
  const initialized = useRef(false)
  const candidate = useRef<TeachingDraftRecord | null>(null)
  const snapshot = useRef({ value, dirty })
  snapshot.current = { value, dirty }
  const suppressed = useRef<string | null>(null)
  const committed = useRef<string | null>(null)
  const operations = useRef(new Set<Promise<void>>())
  const restoring = useRef(onRestore)
  restoring.current = onRestore

  const stopTimer = useCallback(() => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null }, [])
  const reportFailure = useCallback((reason: unknown) => { if (mounted.current) { setError(reason instanceof TeachingDraftConflict ? 'conflict' : 'storage'); setLocalSaved(false) } }, [])
  const persist = useCallback(async (override?: StudentTaskBuffer, silent = false) => {
    stopTimer()
    const captured = override ?? snapshot.current.value
    const serialized = JSON.stringify(captured)
    if (!override && (!snapshot.current.dirty || suppressed.current === serialized || committed.current === serialized || candidate.current)) return
    if (!initialized.current) throw new Error('Local buffer was not read')
    if (candidate.current) throw new Error('Choose whether to restore the local buffer first')
    if (!isStudentTaskBuffer(captured) || captured.taskId !== taskId) throw new Error('Invalid task buffer')
    if (!silent && mounted.current) { setLocalSaved(false); setError(null) }
    const operation = trackStudentTaskBufferWrite(accountId, taskId, repository.write(scope, slot, captured))
    operations.current.add(operation)
    try {
      await operation
      committed.current = serialized
      if (JSON.stringify(snapshot.current.value) === serialized) {
        stopTimer()
        if (!silent && mounted.current && operations.current.size === 1) setLocalSaved(true)
      }
    } catch (reason) { if (!silent) reportFailure(reason); throw reason }
    finally { operations.current.delete(operation) }
  }, [repository, scope, slot, accountId, taskId, reportFailure, stopTimer])
  const flush = useCallback(async (override?: StudentTaskBuffer) => {
    if (!initialized.current && snapshot.current.dirty) throw new Error('Local buffer unavailable')
    await persist(override)
    await Promise.all(Array.from(operations.current))
  }, [persist])
  const clear = useCallback(async (adoptCurrent = false) => {
    stopTimer()
    suppressed.current = JSON.stringify(snapshot.current.value)
    if (mounted.current) setLocalSaved(false)
    try {
      if (adoptCurrent) await repository.read(scope)
      if (!initialized.current && !adoptCurrent) throw new Error('Local buffer unavailable')
      const operation = trackStudentTaskBufferWrite(accountId, taskId, repository.clear(scope, slot))
      operations.current.add(operation)
      try { await operation } finally { operations.current.delete(operation) }
      initialized.current = true; candidate.current = null; committed.current = null
      if (mounted.current) { setPending(null); setPhase('ready'); setError(null) }
    } catch (reason) { reportFailure(reason); throw reason }
  }, [repository, scope, slot, accountId, taskId, reportFailure, stopTimer])
  const read = useCallback(async (alive: () => boolean) => {
    if (alive()) { setPhase('reading'); setError(null) }
    try {
      await waitForStudentTaskBufferWrites(accountId, taskId)
      const records = await repository.read(scope)
      if (!alive()) return
      initialized.current = true
      const found = records.find(record => record.slot === slot) ?? null
      candidate.current = found; setPending(found); setPhase(found ? 'pending' : 'ready')
    } catch (reason) { if (alive()) { initialized.current = false; setPhase('read-error'); reportFailure(reason) } }
  }, [repository, scope, slot, accountId, taskId, reportFailure])

  useEffect(() => {
    mounted.current = true
    let active = true
    void read(() => active)
    const beforeSwitch = (event: Event) => { const promises = (event as CustomEvent<Promise<void>[]>).detail; if (Array.isArray(promises)) promises.push(flush()) }
    const beforeUnload = (event: BeforeUnloadEvent) => { if (snapshot.current.dirty && (committed.current !== JSON.stringify(snapshot.current.value) || operations.current.size > 0)) { event.preventDefault(); event.returnValue = '' } }
    const pageHide = () => { void persist(undefined, true).catch(() => {}) }
    window.addEventListener('deeptutor:before-workspace-switch', beforeSwitch)
    window.addEventListener('beforeunload', beforeUnload)
    window.addEventListener('pagehide', pageHide)
    return () => {
      active = false; mounted.current = false; stopTimer()
      window.removeEventListener('deeptutor:before-workspace-switch', beforeSwitch)
      window.removeEventListener('beforeunload', beforeUnload)
      window.removeEventListener('pagehide', pageHide)
      // Capture the source account/task now, including the last 250 ms of input.
      void persist(undefined, true).catch(() => {})
    }
  }, [read, flush, persist, stopTimer])
  useEffect(() => {
    stopTimer()
    if (phase !== 'ready' || !dirty) return
    const serialized = JSON.stringify(value)
    if (serialized === suppressed.current || serialized === committed.current) return
    setLocalSaved(false)
    timer.current = setTimeout(() => { timer.current = null; void persist().catch(() => {}) }, 250)
    return stopTimer
  }, [value, dirty, phase, persist, stopTimer])
  useEffect(() => {
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href]')
      if (!anchor || anchor.target || anchor.hasAttribute('download')) return
      const target = new URL(anchor.href, window.location.href)
      if (target.origin !== window.location.origin || target.href === window.location.href || !snapshot.current.dirty) return
      event.preventDefault(); event.stopPropagation()
      void flush().then(() => { if (mounted.current) router.push(`${target.pathname}${target.search}${target.hash}`) }).catch(reportFailure)
    }
    document.addEventListener('click', click, true)
    return () => document.removeEventListener('click', click, true)
  }, [flush, reportFailure, router])

  return {
    phase, pending, error, localSaved: localSaved && committed.current === JSON.stringify(value) && timer.current === null && operations.current.size === 0,
    validPending: pending !== null && pending.version === 1 && isStudentTaskBuffer(pending.value) && pending.value.taskId === taskId && JSON.stringify(pending.value.questionIds) === JSON.stringify(value.questionIds),
    restore() { if (candidate.current?.version === 1 && isStudentTaskBuffer(candidate.current.value) && candidate.current.value.taskId === taskId && JSON.stringify(candidate.current.value.questionIds) === JSON.stringify(snapshot.current.value.questionIds)) { const restored = candidate.current.value; candidate.current = null; setPending(null); setPhase('ready'); suppressed.current = null; restoring.current(restored) } },
    discard: () => clear(true), clear: () => clear(), flush,
    retry: async () => { if (!initialized.current) await read(() => mounted.current); else await flush() },
  }
}
