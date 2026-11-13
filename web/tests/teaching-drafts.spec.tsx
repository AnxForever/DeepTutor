import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { TeachingDraftProvider, useTeachingDraftControls, useTeachingDraftNavigationBlocker, useTeachingDraftSlot } from '@/components/learning/teaching-analysis/TeachingDrafts'
import { createTeachingDraftRepository, type TeachingDraftRepository } from '@/lib/teaching-drafts'
import { initI18n } from '@/i18n/init'

const navigate = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: navigate }) }))
initI18n('en')
const scope = { accountId: 'teacher-a', workspaceId: 'class-a' }
let repository: TeachingDraftRepository
type TestDraft = { version: 1; text: string }
const validate = (value: unknown): value is TestDraft => Boolean(value && typeof value === 'object' && (value as TestDraft).version === 1 && typeof (value as TestDraft).text === 'string')
function Editor({ block = false }: { block?: boolean }) {
  const [text, setText] = useState('')
  const value = useMemo<TestDraft>(() => ({ version: 1, text }), [text])
  useTeachingDraftSlot({ slot: 'primary', value, dirty: Boolean(text), validate, onRestore: restored => setText(restored.text) })
  useTeachingDraftNavigationBlocker('unfinished-response', block)
  return <><input aria-label="Local material" value={text} onChange={event => setText(event.target.value)} /><Link href="/settings/llm">Model settings</Link></>
}
async function ready() { await waitFor(() => expect(document.querySelector('[inert]')).toBeNull()) }
beforeEach(async () => {
  if (repository) await repository.read(scope).catch(() => {})
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  navigate.mockReset()
  repository = createTeachingDraftRepository()
})
afterEach(() => vi.useRealTimers())

it('isolates native IndexedDB records by exact account, workspace and slot', async () => {
  await repository.write(scope, 'primary', { student_ref: 'Student A', text: 'Own work' })
  await repository.write(scope, 'rubric-editor', { text: 'Own standard' })
  expect(await repository.read({ ...scope, accountId: 'teacher-b' })).toEqual([])
  expect(await repository.read({ ...scope, workspaceId: 'class-b' })).toEqual([])
  expect((await repository.read(scope)).map(record => record.slot).sort()).toEqual(['primary', 'rubric-editor'])
})

it('serializes clear behind pending writes and prevents an old writer from resurrecting a cleared slot', async () => {
  const old = repository.write(scope, 'primary', { text: 'Old material' })
  const clear = repository.clear(scope, 'primary')
  await Promise.all([old, clear])
  expect(await repository.read(scope)).toEqual([])
  const next = repository.write(scope, 'primary', { text: 'New material' })
  await next
  expect((await repository.read(scope))[0].value).toEqual({ text: 'New material' })
})

it('flushes the source scope before navigating to model settings and offers explicit restoration on return', async () => {
  const view = render(<TeachingDraftProvider {...scope} repository={repository}><Editor /></TeachingDraftProvider>)
  await ready()
  fireEvent.change(screen.getByLabelText('Local material'), { target: { value: 'Prepared worksheet' } })
  fireEvent.click(screen.getByRole('link', { name: 'Model settings' }))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/settings/llm'))
  expect((await repository.read(scope))[0].value).toEqual({ version: 1, text: 'Prepared worksheet' })
  view.unmount()
  render(<TeachingDraftProvider {...scope} repository={repository}><Editor /></TeachingDraftProvider>)
  await screen.findByText('A local teaching draft is available')
  expect(screen.getByLabelText('Local material')).toHaveValue('')
  fireEvent.click(screen.getByRole('button', { name: 'Restore local draft' }))
  expect(screen.getByLabelText('Local material')).toHaveValue('Prepared worksheet')
  expect(navigate).toHaveBeenCalledTimes(1)
})

it('keeps unknown structures in IndexedDB until an explicit discard', async () => {
  const unsupported = { version: 500, text: 'Keep this record' }
  await repository.write(scope, 'primary', unsupported)
  render(<TeachingDraftProvider {...scope} repository={repository}><Editor /></TeachingDraftProvider>)
  await screen.findByText('A local teaching draft is available')
  fireEvent.click(screen.getByRole('button', { name: 'Restore local draft' }))
  await screen.findByText(/unknown version or unsupported structure/)
  expect((await repository.read(scope))[0].value).toEqual(unsupported)
  expect(screen.getByRole('button', { name: 'Export draft JSON' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Discard local draft' }))
  await waitFor(async () => expect(await repository.read(scope)).toEqual([]))
})

it('blocks SPA navigation for child edits that do not yet have a restorable slot', async () => {
  const view = render(<TeachingDraftProvider {...scope} repository={repository}><Editor block /></TeachingDraftProvider>)
  await ready()
  fireEvent.click(screen.getByRole('link', { name: 'Model settings' }))
  await screen.findByText(/Practice or response edits have not been saved/)
  expect(navigate).not.toHaveBeenCalled()
  view.rerender(<TeachingDraftProvider {...scope} repository={repository}><Editor /></TeachingDraftProvider>)
  fireEvent.click(screen.getByRole('link', { name: 'Model settings' }))
  await waitFor(() => expect(navigate).toHaveBeenCalledOnce())
})

it('keeps edits and prevents leaving when storage fails, including the workspace-switch flush promise', async () => {
  const failing: TeachingDraftRepository = { read: async () => [], clear: async () => {}, write: vi.fn(async () => { throw new DOMException('Full', 'QuotaExceededError') }) }
  render(<TeachingDraftProvider {...scope} repository={failing}><Editor /></TeachingDraftProvider>)
  await ready()
  fireEvent.change(screen.getByLabelText('Local material'), { target: { value: 'Keep the prepared material' } })
  fireEvent.click(screen.getByRole('link', { name: 'Model settings' }))
  await screen.findByText(/Local draft storage is unavailable/)
  expect(navigate).not.toHaveBeenCalled()
  expect(screen.getByLabelText('Local material')).toHaveValue('Keep the prepared material')
  const pending: Promise<void>[] = []
  act(() => window.dispatchEvent(new CustomEvent('deeptutor:before-workspace-switch', { detail: pending })))
  expect(pending).toHaveLength(1)
  await act(async () => { await expect(pending[0]).rejects.toThrow('Full') })
})

it('does not overwrite any existing draft after an IndexedDB read failure', async () => {
  const write = vi.fn(async () => {})
  const unavailable: TeachingDraftRepository = { read: async () => { throw new Error('IDB blocked') }, write, clear: async () => {} }
  render(<TeachingDraftProvider {...scope} repository={unavailable}><Editor /></TeachingDraftProvider>)
  await screen.findByText(/Local draft storage is unavailable/)
  fireEvent.change(screen.getByLabelText('Local material'), { target: { value: 'New unpersisted material' } })
  fireEvent.click(screen.getByRole('link', { name: 'Model settings' }))
  await act(async () => { await Promise.resolve() })
  expect(write).not.toHaveBeenCalled()
  expect(navigate).not.toHaveBeenCalled()
})

it('captures the source identity before queued work and does not poison the queue after a quota error', async () => {
  const moving = { ...scope }
  const pending = repository.write(moving, 'primary', { text: 'Source scope' })
  moving.workspaceId = 'destination'
  await pending
  expect((await repository.read(scope))[0].value).toEqual({ text: 'Source scope' })
  expect(await repository.read(moving)).toEqual([])
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError') })
  await expect(repository.write(scope, 'primary', { text: 'Cannot fit' })).rejects.toThrow('Quota exceeded')
  await repository.write(scope, 'primary', { text: 'Retry succeeded' })
  expect((await repository.read(scope))[0].value).toEqual({ text: 'Retry succeeded' })
})

it('never labels new typing saved when an older write completes and waits for the latest write before leaving', async () => {
  const completions: Array<() => void> = []
  const delayed: TeachingDraftRepository = { read: async () => [], clear: async () => {}, write: vi.fn(() => new Promise<void>(resolve => completions.push(resolve))) }
  render(<TeachingDraftProvider {...scope} repository={delayed}><Editor /></TeachingDraftProvider>)
  await ready()
  vi.useFakeTimers()
  fireEvent.change(screen.getByLabelText('Local material'), { target: { value: 'First text' } })
  await act(async () => { await vi.advanceTimersByTimeAsync(250) })
  expect(completions).toHaveLength(1)
  fireEvent.change(screen.getByLabelText('Local material'), { target: { value: 'Second text' } })
  await act(async () => completions[0]())
  expect(screen.queryByText(/Draft saved on this device/)).toBeNull()
  await act(async () => { fireEvent.click(screen.getByRole('link', { name: 'Model settings' })); await Promise.resolve() })
  expect(completions).toHaveLength(2)
  expect(navigate).not.toHaveBeenCalled()
  await act(async () => completions[1]())
  expect(navigate).toHaveBeenCalledWith('/settings/llm')
  expect(screen.getByText(/Draft saved on this device/)).toBeInTheDocument()
  expect(delayed.write).toHaveBeenLastCalledWith(scope, 'primary', { version: 1, text: 'Second text' })
})

it('rejects another window overwriting a draft and rejects an old writer after an explicit clear', async () => {
  const otherWindow = createTeachingDraftRepository()
  await repository.write(scope, 'primary', { text: 'Original' })
  await otherWindow.read(scope)
  await repository.write(scope, 'primary', { text: 'Window A newer edit' })
  await expect(otherWindow.write(scope, 'primary', { text: 'Stale B edit' })).rejects.toThrow(/another window/)
  expect((await repository.read(scope))[0].value).toEqual({ text: 'Window A newer edit' })
  await otherWindow.read(scope)
  await otherWindow.clear(scope, 'primary')
  await expect(repository.write(scope, 'primary', { text: 'Cannot resurrect A' })).rejects.toThrow(/another window/)
  expect(await otherWindow.read(scope)).toEqual([])
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('deeptutor-teaching-drafts')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const transaction = db.transaction('drafts', 'readwrite')
      transaction.objectStore('drafts').delete([scope.accountId, scope.workspaceId, 'primary'])
      transaction.oncomplete = () => { db.close(); resolve() }
      transaction.onerror = () => reject(transaction.error)
    }
  })
  await expect(otherWindow.write(scope, 'primary', { text: 'Missing record is not permission to recreate' })).rejects.toThrow(/another window/)
})

it('restores registered editors first and hydrates a child slot when its editor mounts', async () => {
  function Child() {
    const [text, setText] = useState('')
    const value = useMemo<TestDraft>(() => ({ version: 1, text }), [text])
    useTeachingDraftSlot({ slot: 'late-child', value, dirty: Boolean(text), validate, onRestore: value => setText(value.text) })
    return <input aria-label="Restored child" value={text} readOnly />
  }
  function Parent() {
    const [show, setShow] = useState(false)
    const value = useMemo<TestDraft>(() => ({ version: 1, text: 'parent' }), [])
    useTeachingDraftSlot({ slot: 'primary', value, dirty: false, validate, onRestore: () => setShow(true) })
    return show ? <Child /> : <p>Parent only</p>
  }
  await repository.write(scope, 'primary', { version: 1, text: 'parent' })
  await repository.write(scope, 'late-child', { version: 1, text: 'Unsubmitted response' })
  await repository.write(scope, 'unknown-future-slot', { version: 99, text: 'Keep for export' })
  render(<TeachingDraftProvider {...scope} repository={repository}><Parent /></TeachingDraftProvider>)
  await screen.findByText('A local teaching draft is available')
  fireEvent.click(screen.getByRole('button', { name: 'Restore local draft' }))
  await waitFor(() => expect(screen.getByLabelText('Restored child')).toHaveValue('Unsubmitted response'))
  expect(screen.getByText(/main draft was restored/)).toBeInTheDocument()
  expect((await repository.read(scope)).some(record => record.slot === 'unknown-future-slot')).toBe(true)
})

it('writes the latest snapshot on immediate SPA unmount before its timer, under the captured source scope', async () => {
  const originalUrl = window.location.href
  const view = render(<TeachingDraftProvider {...scope} repository={repository}><Editor /></TeachingDraftProvider>)
  await ready()
  fireEvent.change(screen.getByLabelText('Local material'), { target: { value: 'Last 250ms of typing' } })
  view.unmount()
  window.history.replaceState({}, '', '/settings/llm?dt_workspace=destination')
  try {
    expect((await repository.read(scope))[0].value).toEqual({ version: 1, text: 'Last 250ms of typing' })
    expect(await repository.read({ ...scope, workspaceId: 'destination' })).toEqual([])
  } finally { window.history.replaceState({}, '', originalUrl) }
})

it('does not resurrect a dirty child after its explicit clear and unmount', async () => {
  function Host() {
    const [show, setShow] = useState(true)
    const controls = useTeachingDraftControls()
    return <>{show && <Editor />}<button onClick={async () => { await controls.clearSlot('primary'); setShow(false) }}>Discard editor</button></>
  }
  render(<TeachingDraftProvider {...scope} repository={repository}><Host /></TeachingDraftProvider>)
  await ready()
  fireEvent.change(screen.getByLabelText('Local material'), { target: { value: 'Explicitly discarded' } })
  fireEvent.click(screen.getByRole('button', { name: 'Discard editor' }))
  await waitFor(() => expect(screen.queryByLabelText('Local material')).toBeNull())
  expect(await repository.read(scope)).toEqual([])
})

it('retries writing the latest input after a write error without rereading an older cache', async () => {
  const read = vi.fn(async () => [])
  const write = vi.fn(async () => {})
  write.mockRejectedValueOnce(new DOMException('Full', 'QuotaExceededError'))
  const storage: TeachingDraftRepository = { read, write, clear: async () => {} }
  render(<TeachingDraftProvider {...scope} repository={storage}><Editor /></TeachingDraftProvider>)
  await ready()
  fireEvent.change(screen.getByLabelText('Local material'), { target: { value: 'First failed text' } })
  fireEvent.click(screen.getByRole('link', { name: 'Model settings' }))
  await screen.findByText(/Local draft storage is unavailable/)
  fireEvent.change(screen.getByLabelText('Local material'), { target: { value: 'Newer text to keep' } })
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText(/Draft saved on this device/)
  expect(read).toHaveBeenCalledOnce()
  expect(write).toHaveBeenLastCalledWith(scope, 'primary', { version: 1, text: 'Newer text to keep' })
  expect(screen.getByLabelText('Local material')).toHaveValue('Newer text to keep')
  expect(navigate).not.toHaveBeenCalled()
})
