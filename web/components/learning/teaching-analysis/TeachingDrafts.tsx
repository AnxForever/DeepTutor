'use client'

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useRouter } from 'next/navigation'
import { Button, InlineAlert } from '@/shared/ui'
import { TeachingDraftConflict, teachingDraftRepository, type TeachingDraftRecord, type TeachingDraftRepository, type TeachingDraftScope } from '@/lib/teaching-drafts'
import { isPlainTeachingJson } from '@/lib/teaching-draft-validation'

type Registration = { value: unknown; dirty: boolean; validate: (value: unknown) => boolean; restore: (value: unknown) => void }
interface DraftContext {
  register(slot: string, value: Registration): () => void
  update(slot: string, value: Registration): void
  clear(slot: string): Promise<void>
  clearAll(): Promise<void>
  block(slot: string, dirty: boolean): () => void
}
const Context = createContext<DraftContext | null>(null)

export function TeachingDraftProvider({ accountId, workspaceId, children, repository = teachingDraftRepository }: TeachingDraftScope & { children: ReactNode; repository?: TeachingDraftRepository }) {
  const { t } = useTranslation()
  const router = useRouter()
  const scope = useMemo(() => ({ accountId, workspaceId }), [accountId, workspaceId])
  const registrations = useRef(new Map<string, Registration>())
  const blockers = useRef(new Set<string>())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const operations = useRef(new Set<Promise<void>>())
  const versions = useRef(new Map<string, number>())
  const persisted = useRef(new Map<string, number>())
  const failedSlots = useRef(new Set<string>())
  const pendingRecovery = useRef(new Map<string, TeachingDraftRecord>())
  const restoreRequested = useRef(false)
  const clearedSnapshots = useRef(new Map<string, unknown>())
  const cleanupSnapshots = useRef(new Map<string, unknown>())
  const knownDirty = useRef(new Map<string, boolean>())
  const committedSnapshots = useRef(new Map<string, unknown>())
  const readyRef = useRef(false)
  const mounted = useRef(true)
  const [loading, setLoading] = useState(true)
  const [recovery, setRecovery] = useState<TeachingDraftRecord[]>([])
  const [failure, setFailure] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [localSaved, setLocalSaved] = useState(false)
  const [readRevision, setReadRevision] = useState(0)
  const [hasRestored, setHasRestored] = useState(false)
  const [conflict, setConflict] = useState(false)

  const cleanupWrite = useCallback((slot: string, registration: Registration) => {
    if (!readyRef.current || pendingRecovery.current.has(slot) || !registration.dirty || !isPlainTeachingJson(registration.value)) return
    const snapshot = registration.value
    if (clearedSnapshots.current.get(slot) === snapshot || cleanupSnapshots.current.get(slot) === snapshot || committedSnapshots.current.get(slot) === snapshot) return
    cleanupSnapshots.current.set(slot, snapshot)
    // No destination URL lookup and no setState: this survives SPA unmount.
    const operation = repository.write(scope, slot, snapshot)
    operations.current.add(operation)
    void operation.finally(() => operations.current.delete(operation)).catch(() => {})
  }, [repository, scope])

  const track = useCallback((slot: string, operation: Promise<void>, committed?: () => void) => {
    operations.current.add(operation)
    if (mounted.current) setLocalSaved(false)
    void operation.then(() => { committed?.(); failedSlots.current.delete(slot) }, reason => { failedSlots.current.add(slot); if (mounted.current && reason instanceof TeachingDraftConflict) setConflict(true) }).finally(() => {
      operations.current.delete(operation)
      if (!mounted.current) return
      const dirty = Array.from(registrations.current).filter(([, registration]) => registration.dirty)
      setFailure(failedSlots.current.size > 0)
      if (!failedSlots.current.size) setConflict(false)
      setLocalSaved(blockers.current.size === 0 && dirty.length > 0 && timers.current.size === 0 && operations.current.size === 0 && dirty.every(([key]) => persisted.current.get(key) === versions.current.get(key)))
    })
    return operation
  }, [])
  const write = useCallback((slot: string) => {
    const registration = registrations.current.get(slot)
    if (!readyRef.current || pendingRecovery.current.has(slot) || !registration?.dirty) return Promise.resolve()
    const version = versions.current.get(slot) ?? 0
    const snapshot = registration.value
    try {
      if (!isPlainTeachingJson(snapshot)) throw new Error('Unsupported draft data')
      return track(slot, repository.write(scope, slot, snapshot), () => { persisted.current.set(slot, version); committedSnapshots.current.set(slot, snapshot) })
    } catch (reason) { return track(slot, Promise.reject(reason)) }
  }, [repository, scope, track])
  const flush = useCallback(async () => {
    for (;;) {
      if (blockers.current.size) { if (mounted.current) setBlocked(true); throw new Error('Unregistered edits') }
      if (!readyRef.current || pendingRecovery.current.size) throw new Error('Draft restoration pending')
      await Promise.all(Array.from(failedSlots.current).filter(slot => slot !== 'storage-read' && !registrations.current.get(slot)?.dirty).map(slot => track(slot, repository.clear(scope, slot))))
      for (const timer of timers.current.values()) clearTimeout(timer)
      timers.current.clear()
      await Promise.all([...operations.current, ...Array.from(registrations.current.keys(), write)])
      if (blockers.current.size) { if (mounted.current) setBlocked(true); throw new Error('Unregistered edits') }
      if (Array.from(registrations.current).every(([slot, registration]) => !registration.dirty || persisted.current.get(slot) === versions.current.get(slot))) return
    }
  }, [repository, scope, track, write])

  useEffect(() => {
    mounted.current = true
    const scheduled = timers.current
    const activeRegistrations = registrations.current
    let alive = true
    void repository.read(scope).then(records => {
      if (!alive) return
      setRecovery(records)
      pendingRecovery.current = new Map(records.map(record => [record.slot, record]))
      failedSlots.current.delete('storage-read')
      setFailure(failedSlots.current.size > 0)
      readyRef.current = records.length === 0
      if (readyRef.current) for (const slot of registrations.current.keys()) void write(slot).catch(() => {})
    }).catch(() => { if (alive) { failedSlots.current.add('storage-read'); setFailure(true); readyRef.current = false } }).finally(() => { if (alive) setLoading(false) })
    return () => {
      alive = false; mounted.current = false
      for (const timer of scheduled.values()) clearTimeout(timer)
      scheduled.clear()
      for (const [slot, registration] of activeRegistrations) cleanupWrite(slot, registration)
    }
  }, [repository, scope, readRevision, write, cleanupWrite])

  useEffect(() => {
    const switchWorkspace = (event: Event) => { (event as CustomEvent<Promise<void>[]>).detail.push(flush()) }
    const warn = (event: BeforeUnloadEvent) => { if (Array.from(registrations.current.values()).some(value => value.dirty)) { event.preventDefault(); event.returnValue = '' } }
    const pagehide = () => { for (const [slot, registration] of registrations.current) cleanupWrite(slot, registration) }
    const navigate = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
      if (!link || link.download || link.target === '_blank') return
      const destination = new URL(link.href, window.location.origin)
      if (destination.origin !== window.location.origin || (destination.pathname === window.location.pathname && destination.search === window.location.search)) return
      event.preventDefault(); event.stopPropagation()
      void flush().then(() => router.push(`${destination.pathname}${destination.search}${destination.hash}`)).catch(() => {})
    }
    window.addEventListener('deeptutor:before-workspace-switch', switchWorkspace)
    window.addEventListener('beforeunload', warn)
    window.addEventListener('pagehide', pagehide)
    document.addEventListener('click', navigate, true)
    return () => { window.removeEventListener('deeptutor:before-workspace-switch', switchWorkspace); window.removeEventListener('beforeunload', warn); window.removeEventListener('pagehide', pagehide); document.removeEventListener('click', navigate, true) }
  }, [cleanupWrite, flush, router])

  const clear = useCallback(async (slot: string, discardPending = false) => {
    if ((!readyRef.current || pendingRecovery.current.has(slot)) && !discardPending) throw new Error('Draft restoration pending')
    const timer = timers.current.get(slot)
    if (timer) clearTimeout(timer)
    timers.current.delete(slot)
    const snapshot = registrations.current.get(slot)?.value
    clearedSnapshots.current.set(slot, snapshot)
    versions.current.set(slot, (versions.current.get(slot) ?? 0) + 1)
    persisted.current.delete(slot)
    committedSnapshots.current.delete(slot)
    try { await track(slot, repository.clear(scope, slot)) } catch (reason) { if (clearedSnapshots.current.get(slot) === snapshot) clearedSnapshots.current.delete(slot); throw reason }
    if (pendingRecovery.current.delete(slot) && mounted.current) setRecovery(Array.from(pendingRecovery.current.values()))
  }, [repository, scope, track])
  const update = useCallback((slot: string, registration: Registration) => {
    const priorDirty = knownDirty.current.get(slot) ?? false
    registrations.current.set(slot, registration)
    knownDirty.current.set(slot, registration.dirty)
    versions.current.set(slot, (versions.current.get(slot) ?? 0) + 1)
    if (registration.dirty || priorDirty) setLocalSaved(false)
    const timer = timers.current.get(slot)
    if (timer) clearTimeout(timer)
    timers.current.delete(slot)
    if (!readyRef.current || pendingRecovery.current.has(slot)) return
    if (registration.dirty) timers.current.set(slot, setTimeout(() => { timers.current.delete(slot); void write(slot).catch(() => {}) }, 250))
    else if (priorDirty) void clear(slot).catch(() => {})
  }, [clear, write])
  const hydrate = useCallback((slot: string) => {
    const record = pendingRecovery.current.get(slot)
    const registration = registrations.current.get(slot)
    if (!record || !registration) return
    try {
      if (record.version !== 1 || record.accountId !== scope.accountId || record.workspaceId !== scope.workspaceId || !isPlainTeachingJson(record.value) || !registration.validate(record.value)) { setInvalid(true); return }
    } catch { setInvalid(true); return }
    pendingRecovery.current.delete(slot)
    registration.restore(record.value)
    setRecovery(Array.from(pendingRecovery.current.values()))
  }, [scope])
  const value = useMemo<DraftContext>(() => ({
    update, clear,
    async clearAll() { if (!readyRef.current || pendingRecovery.current.size) throw new Error('Draft restoration pending'); await Promise.all(Array.from(registrations.current.keys(), slot => clear(slot))) },
    register(slot, registration) { registrations.current.set(slot, registration); if (restoreRequested.current) hydrate(slot); return () => { const current = registrations.current.get(slot); if (current) cleanupWrite(slot, current); registrations.current.delete(slot); knownDirty.current.delete(slot) } },
    block(slot, dirty) { if (dirty) { blockers.current.add(slot); setLocalSaved(false) } else { blockers.current.delete(slot); setBlocked(false) } return () => { blockers.current.delete(slot) } },
  }), [clear, cleanupWrite, hydrate, update])

  function restore() {
    restoreRequested.current = true
    setHasRestored(true)
    readyRef.current = true
    setInvalid(false); setLocalSaved(false)
    for (const slot of registrations.current.keys()) hydrate(slot)
  }
  async function discard() {
    try {
      await Promise.all(recovery.map(record => clear(record.slot, true)))
      readyRef.current = true; setRecovery([]); setInvalid(false); setLocalSaved(false); setHasRestored(true)
      for (const slot of registrations.current.keys()) void write(slot).catch(() => {})
    } catch { setFailure(true) }
  }
  function download() {
    const records = recovery.length ? recovery : Array.from(registrations.current, ([slot, registration]) => ({ ...scope, slot, version: 1, value: registration.value }))
    const url = URL.createObjectURL(new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'teaching-local-drafts.json'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <Context.Provider value={value}>
    <div className="space-y-2 px-6 pt-3">
      {failure && <InlineAlert tone="warning" action={<><Button size="sm" variant="secondary" onClick={() => { if (failedSlots.current.has('storage-read')) setReadRevision(x => x + 1); else void flush().catch(() => {}) }}>{t('Retry')}</Button><Button size="sm" variant="ghost" onClick={download}>{t('teaching.drafts.export')}</Button></>}>{t(conflict ? 'teaching.drafts.conflict' : 'teaching.drafts.failed')}</InlineAlert>}
      {blocked && <InlineAlert tone="warning">{t('teaching.drafts.blocked')}</InlineAlert>}
      {recovery.length > 0 && <InlineAlert tone="warning" title={t('teaching.drafts.available')}><p>{t(invalid ? 'teaching.drafts.invalid' : hasRestored ? 'teaching.drafts.pending' : 'teaching.drafts.restoreHint')}</p><p className="mt-1 text-xs">{t('teaching.drafts.updated', { time: new Date(Math.max(...recovery.map(record => Number(record.updatedAt) || 0))).toLocaleString() })}</p><div className="mt-3 flex flex-wrap gap-2"><Button size="sm" onClick={restore}>{t('teaching.drafts.restore')}</Button><Button size="sm" variant="secondary" onClick={() => void discard()}>{t('teaching.drafts.discard')}</Button><Button size="sm" variant="ghost" onClick={download}>{t('teaching.drafts.export')}</Button></div></InlineAlert>}
      {!failure && !loading && !recovery.length && localSaved && <p role="status" className="text-xs text-muted-foreground">{t('teaching.drafts.localSaved')}</p>}
    </div>
    <div className="min-h-0 flex-1" inert={loading || (recovery.length > 0 && !hasRestored)}>{children}</div>
  </Context.Provider>
}

export function useTeachingDraftSlot<T>({ slot, value, dirty, validate, onRestore }: { slot: string; value: T; dirty: boolean; validate: (value: unknown) => value is T; onRestore: (value: T) => void }) {
  const context = useContext(Context)
  const current = useRef({ value, dirty, validate, onRestore })
  useLayoutEffect(() => { current.current = { value, dirty, validate, onRestore } }, [value, dirty, validate, onRestore])
  useLayoutEffect(() => context?.register(slot, {
    get value() { return current.current.value }, get dirty() { return current.current.dirty },
    validate: candidate => current.current.validate(candidate), restore: candidate => current.current.onRestore(candidate as T),
  }), [context, slot])
  useLayoutEffect(() => {
    context?.update(slot, { get value() { return current.current.value }, get dirty() { return current.current.dirty }, validate: candidate => current.current.validate(candidate), restore: candidate => current.current.onRestore(candidate as T) })
  }, [context, slot, value, dirty])
  return { clear: useCallback(() => context?.clear(slot) ?? Promise.resolve(), [context, slot]) }
}

/** Until a child has a restorable snapshot, leaving must not discard its work. */
export function useTeachingDraftNavigationBlocker(slot: string, dirty: boolean) {
  const context = useContext(Context)
  useEffect(() => context?.block(slot, dirty), [context, slot, dirty])
}

export function useTeachingDraftControls() {
  const context = useContext(Context)
  return { clearAll: context?.clearAll ?? (() => Promise.resolve()), clearSlot: context?.clear ?? (() => Promise.resolve()) }
}
