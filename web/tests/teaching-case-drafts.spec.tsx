import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useMemo, useState } from 'react'
import { TeachingDraftProvider, acceptsStudentCaseCreateSlot, useTeachingDraftControls, useTeachingDraftSlot } from '@/components/learning/teaching-analysis/TeachingDrafts'
import { createTeachingDraftRepository, type TeachingDraftRepository } from '@/lib/teaching-drafts'
import { initI18n } from '@/i18n/init'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
initI18n('en')
const scope = { accountId: 'teacher-a', workspaceId: 'class-a' }
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const slotA = `student-case:${A}:editor`
const slotB = `student-case:${B}:editor`
const acceptsA = (slot: string) => typeof slot === 'string' && slot.startsWith(`student-case:${A}:`)
const acceptsB = (slot: string) => typeof slot === 'string' && slot.startsWith(`student-case:${B}:`)
type Value = { version: 1; text: string }
const validate = (value: unknown): value is Value => Boolean(value && typeof value === 'object' && (value as Value).version === 1 && typeof (value as Value).text === 'string')
let repository: TeachingDraftRepository
function Editor({ slot }: { slot: string }) {
  const [text, setText] = useState('')
  const value = useMemo<Value>(() => ({ version: 1, text }), [text])
  useTeachingDraftSlot({ slot, value, dirty: Boolean(text), validate, onRestore: value => setText(value.text) })
  const controls = useTeachingDraftControls()
  return <><input aria-label="Case editor" value={text} onChange={event => setText(event.target.value)} /><button onClick={async () => { await controls.clearSlot(slot); setText('') }}>Discard editor</button></>
}
beforeEach(async () => {
  if (repository) await repository.read(scope).catch(() => {})
  vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  repository = createTeachingDraftRepository()
})
async function recover() { await screen.findByText('A local teaching draft is available'); fireEvent.click(screen.getByRole('button', { name: 'Restore local draft' })) }

it('case A recovery, save and discard never consume case B or workbench records; B restores explicitly on return', async () => {
  await repository.write(scope, slotA, { version: 1, text: 'A local label and pins' })
  await repository.write(scope, slotB, { version: 1, text: 'B pending changes' })
  await repository.write(scope, 'primary', { version: 1, text: 'Prepared assignment' })
  const view = render(<TeachingDraftProvider {...scope} namespace={`student-case:${A}`} acceptsSlot={acceptsA} repository={repository}><Editor slot={slotA} /></TeachingDraftProvider>)
  await recover()
  expect(screen.getByLabelText('Case editor')).toHaveValue('A local label and pins')
  expect(screen.queryByText(/main draft was restored/)).toBeNull()
  fireEvent.change(screen.getByLabelText('Case editor'), { target: { value: 'A new label' } })
  const pending: Promise<void>[] = []
  act(() => window.dispatchEvent(new CustomEvent('deeptutor:before-workspace-switch', { detail: pending })))
  await act(async () => { await Promise.all(pending) })
  expect((await repository.read(scope)).find(record => record.slot === slotB)?.value).toEqual({ version: 1, text: 'B pending changes' })
  fireEvent.click(screen.getByRole('button', { name: 'Discard editor' }))
  await waitFor(() => expect(screen.getByLabelText('Case editor')).toHaveValue(''))
  expect((await repository.read(scope)).find(record => record.slot === slotB)?.value).toEqual({ version: 1, text: 'B pending changes' })
  expect((await repository.read(scope)).find(record => record.slot === 'primary')?.value).toEqual({ version: 1, text: 'Prepared assignment' })
  view.unmount()
  render(<TeachingDraftProvider {...scope} namespace={`student-case:${B}`} acceptsSlot={acceptsB} repository={repository}><Editor slot={slotB} /></TeachingDraftProvider>)
  await recover()
  expect(screen.getByLabelText('Case editor')).toHaveValue('B pending changes')
})

it('the workbench ignores student-case namespaces rather than presenting them as orphaned drafts', async () => {
  await repository.write(scope, slotB, { version: 1, text: 'Student B draft' })
  await repository.write(scope, 'student-case-create', { version: 1, text: 'New case draft' })
  await repository.write(scope, 'primary', { version: 1, text: 'Workbench material' })
  render(<TeachingDraftProvider {...scope} repository={repository}><Editor slot="primary" /></TeachingDraftProvider>)
  await recover()
  expect(screen.getByLabelText('Case editor')).toHaveValue('Workbench material')
  expect(screen.queryByText(/waiting for their related editor/)).toBeNull()
  const pending: Promise<void>[] = []
  act(() => window.dispatchEvent(new CustomEvent('deeptutor:before-workspace-switch', { detail: pending })))
  await act(async () => { await Promise.all(pending) })
  expect((await repository.read(scope)).find(record => record.slot === slotB)?.value).toEqual({ version: 1, text: 'Student B draft' })
})

it('discarding a create-case recovery only clears that exact page slot', async () => {
  await repository.write(scope, slotA, { version: 1, text: 'Case A preserved' })
  await repository.write(scope, 'primary', { version: 1, text: 'Workbench preserved' })
  await repository.write(scope, 'student-case-create', { version: 1, text: 'Discard this new case' })
  render(<TeachingDraftProvider {...scope} namespace="student-case-create" acceptsSlot={acceptsStudentCaseCreateSlot} repository={repository}><Editor slot="student-case-create" /></TeachingDraftProvider>)
  await screen.findByText('A local teaching draft is available')
  fireEvent.click(screen.getByRole('button', { name: 'Discard local draft' }))
  await waitFor(async () => expect((await repository.read(scope)).some(record => record.slot === 'student-case-create')).toBe(false))
  const preserved = await repository.read(scope)
  expect(preserved.map(record => record.slot).sort()).toEqual(['primary', slotA].sort())
})
