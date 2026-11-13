import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useStudentTaskBuffer } from '@/hooks/useStudentTaskBuffer'
import { createStudentTaskBufferRepository, isStudentTaskBuffer, type StudentTaskBuffer } from '@/lib/student-task-buffers'
import { createTeachingDraftRepository, type TeachingDraftRepository } from '@/lib/teaching-drafts'

const navigation = vi.hoisted(() => ({ router: { push: vi.fn() } }))
vi.mock('next/navigation', () => ({ useRouter: () => navigation.router }))
vi.mock('next/link', () => ({ default: ({ href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => <a href={href} {...props} /> }))
const TASK = '11111111-1111-4111-8111-111111111111'
const scope = { accountId: 'learner-a', workspaceId: '' }
const slot = `student-task:${TASK}`
const sample = (answer = 'My writing'): StudentTaskBuffer => ({ kind: 'student-task-buffer', version: 1, taskId: TASK, taskRevision: 1, baseRevision: 0, questionIds: ['Q1'], currentQuestionIndex: 0, responses: [{ question_id: 'Q1', response_status: 'answered', answer, assistance: 'unknown' }], operation: null })
let repository: TeachingDraftRepository
function Editor({ repo = repository, label = 'Editor' }: { repo?: TeachingDraftRepository; label?: string }) {
  const [answer, setAnswer] = useState('')
  const [dirty, setDirty] = useState(false)
  const value = useMemo(() => answer ? sample(answer) : { ...sample(), responses: [{ question_id: 'Q1', response_status: 'unanswered' as const, answer: null, assistance: 'unknown' as const }] }, [answer])
  const buffer = useStudentTaskBuffer({ ...scope, taskId: TASK, value, dirty, repository: repo, onRestore: restored => { setAnswer(restored.responses[0].answer ?? ''); setDirty(true) } })
  return <section aria-label={label}><input aria-label="Answer" value={answer} onChange={event => { setAnswer(event.target.value); setDirty(true) }} /><span>{buffer.phase}</span>{buffer.localSaved && <span>Local saved</span>}{buffer.error && <span>{buffer.error}</span>}<button onClick={() => void buffer.flush().catch(() => {})}>Flush</button><button onClick={() => void buffer.retry().catch(() => {})}>Retry</button><button onClick={buffer.restore}>Restore</button><button onClick={() => void buffer.discard().then(() => setDirty(false)).catch(() => {})}>Discard</button><Link href="/settings">Settings</Link>{buffer.pending && <span>{buffer.validPending ? 'Recoverable' : 'Unsupported'}</span>}</section>
}
beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange); repository = createTeachingDraftRepository('student-buffer-test'); navigation.router.push.mockReset() })
afterEach(async () => { cleanup(); vi.useRealTimers(); await repository.read(scope) })
async function ready() { await screen.findByText('ready') }
it('keeps a dedicated student database separate from teacher drafts with the same identity and slot', async () => {
  const teacher = createTeachingDraftRepository()
  await teacher.write(scope, slot, { teacherOnly: 'Unrelated material' })
  await repository.write(scope, slot, sample())
  expect((await teacher.read(scope))[0].value).toEqual({ teacherOnly: 'Unrelated material' })
  expect((await repository.read(scope))[0].value).toEqual(sample())
  expect(await repository.read({ ...scope, workspaceId: 'teacher-private' })).toEqual([])
})
it('validates full ordered question responses, request payloads, status semantics and plain JSON', () => {
  expect(isStudentTaskBuffer(sample())).toBe(true)
  expect(isStudentTaskBuffer({ ...sample(), version: 2 })).toBe(false)
  expect(isStudentTaskBuffer({ ...sample(), questionIds: ['DifferentQ'] })).toBe(false)
  expect(isStudentTaskBuffer({ ...sample(), responses: [{ question_id: 'Q1', response_status: 'needs_help', answer: 'A partial attempt', assistance: 'unknown' }] })).toBe(true)
  expect(isStudentTaskBuffer({ ...sample(), responses: [{ question_id: 'Q1', response_status: 'needs_help', answer: null, assistance: 'unknown' }] })).toBe(true)
  expect(isStudentTaskBuffer({ ...sample(), responses: [{ question_id: 'Q1', response_status: 'needs_help', answer: '  ', assistance: 'unknown' }] })).toBe(false)
  expect(isStudentTaskBuffer({ ...sample(), responses: [{ question_id: 'Q1', response_status: 'unanswered', answer: 'A partial attempt', assistance: 'unknown' }] })).toBe(false)
  expect(isStudentTaskBuffer({ ...sample(), responses: [{ ...sample().responses[0], teacher_result: 'correct' }] })).toBe(false)
  expect(isStudentTaskBuffer({ ...sample(), operation: { kind: 'submit', body: { submission_id: TASK, expected_revision: 0, responses: sample('Different answer').responses } } })).toBe(false)
  expect(isStudentTaskBuffer({ ...sample(), attachment: new Blob(['Not plain JSON']) })).toBe(false)
})
it('does not advance a retained writer CAS when another task or a duplicate mounted task reads the inbox', async () => {
  const actor = { accountId: 'independent-task-writers', workspaceId: '' }
  const taskA = createStudentTaskBufferRepository()
  const taskB = createStudentTaskBufferRepository()
  const newlyMountedA = createStudentTaskBufferRepository()
  const otherWindow = createTeachingDraftRepository('deeptutor-student-task-buffers')
  await taskA.read(actor)
  await otherWindow.write(actor, slot, sample('Other window current answer'))
  await taskB.read(actor)
  await newlyMountedA.read(actor)
  await expect(taskA.write(actor, slot, sample('Task A stale answer'))).rejects.toThrow(/another window/)
  expect((await otherWindow.read(actor))[0].value).toEqual(sample('Other window current answer'))
})
it('keeps partial needs-help text and the exact pending submission payload in the local buffer', async () => {
  const value = sample('I started the solution and need help continuing.')
  value.responses[0].response_status = 'needs_help'
  value.operation = { kind: 'submit', body: { submission_id: TASK, expected_revision: value.baseRevision, responses: value.responses } }
  expect(isStudentTaskBuffer(value)).toBe(true)
  await repository.write(scope, slot, value)
  const stored = (await repository.read(scope))[0].value
  expect(isStudentTaskBuffer(stored)).toBe(true)
  expect(stored).toEqual(value)
})
it('preserves unsupported stored records until an explicit discard rather than silently overwriting them', async () => {
  const raw = { kind: 'student-task-buffer', version: 500, answer: 'Keep the original' }
  await repository.write(scope, slot, raw)
  render(<Editor />)
  await screen.findByText('Unsupported')
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
  expect(screen.getByLabelText('Answer')).toHaveValue('')
  expect((await repository.read(scope))[0].value).toEqual(raw)
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
  await waitFor(async () => expect(await repository.read(scope)).toEqual([]))
})
it('retries current edits after quota failure without restoring an older cached answer', async () => {
  render(<Editor />); await ready()
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => { throw new DOMException('Full', 'QuotaExceededError') })
  fireEvent.change(screen.getByLabelText('Answer'), { target: { value: 'First unsaved answer' } })
  fireEvent.click(screen.getByRole('button', { name: 'Flush' }))
  await screen.findByText('storage')
  fireEvent.change(screen.getByLabelText('Answer'), { target: { value: 'The newest answer' } })
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('Local saved')
  expect(screen.getByLabelText('Answer')).toHaveValue('The newest answer')
  expect((await repository.read(scope))[0].value).toEqual(sample('The newest answer'))
})
it('never marks later typing saved just because an older write finished', async () => {
  const releases: Array<() => void> = []
  const delayed: TeachingDraftRepository = { read: async () => [], clear: async () => {}, write: vi.fn(() => new Promise<void>(resolve => releases.push(resolve))) }
  render(<Editor repo={delayed} />); await ready(); vi.useFakeTimers()
  fireEvent.change(screen.getByLabelText('Answer'), { target: { value: 'Old answer' } })
  await act(async () => vi.advanceTimersByTimeAsync(250))
  fireEvent.change(screen.getByLabelText('Answer'), { target: { value: 'New answer' } })
  await act(async () => releases[0]())
  expect(screen.queryByText('Local saved')).toBeNull()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Flush' })); await Promise.resolve() })
  await act(async () => releases[1]())
  expect(screen.getByText('Local saved')).toBeVisible()
  expect(delayed.write).toHaveBeenLastCalledWith(scope, slot, sample('New answer'))
})
it('rejects cross-window overwrites and prevents an old window from resurrecting a cleared buffer', async () => {
  const second = createTeachingDraftRepository('student-buffer-test')
  await repository.write(scope, slot, sample('Original')); await second.read(scope)
  await repository.write(scope, slot, sample('Window A'))
  await expect(second.write(scope, slot, sample('Window B'))).rejects.toThrow(/another window/)
  expect((await repository.read(scope))[0].value).toEqual(sample('Window A'))
  await second.read(scope); await repository.clear(scope, slot)
  await expect(second.write(scope, slot, sample('Old window'))).rejects.toThrow(/another window/)
  expect(await repository.read(scope)).toEqual([])
})
it('flushes the fixed source account and General scope before normal navigation and blocks leaving on failure', async () => {
  const write = vi.fn(async () => { throw new Error('Storage unavailable') })
  const failing: TeachingDraftRepository = { read: async () => [], clear: async () => {}, write }
  const view = render(<Editor repo={failing} />); await ready()
  fireEvent.change(screen.getByLabelText('Answer'), { target: { value: 'Source account answer' } })
  fireEvent.click(screen.getByRole('link', { name: 'Settings' }))
  await screen.findByText('storage')
  expect(navigation.router.push).not.toHaveBeenCalled()
  expect(write).toHaveBeenCalledWith(scope, slot, sample('Source account answer'))
  const pending: Promise<void>[] = []
  act(() => window.dispatchEvent(new CustomEvent('deeptutor:before-workspace-switch', { detail: pending })))
  await act(async () => expect(pending[0]).rejects.toThrow('Storage unavailable'))
  view.unmount()
})
it('keeps both windows own visible input when a local CAS conflict occurs', async () => {
  const second = createTeachingDraftRepository('student-buffer-test')
  render(<><Editor label="Window A" /><Editor label="Window B" repo={second} /></>)
  await waitFor(() => expect(screen.getAllByText('ready')).toHaveLength(2))
  const a = within(screen.getByRole('region', { name: 'Window A' })); const b = within(screen.getByRole('region', { name: 'Window B' }))
  fireEvent.change(a.getByLabelText('Answer'), { target: { value: 'A answer' } }); fireEvent.click(a.getByRole('button', { name: 'Flush' }))
  await a.findByText('Local saved')
  fireEvent.change(b.getByLabelText('Answer'), { target: { value: 'B answer' } }); fireEvent.click(b.getByRole('button', { name: 'Flush' }))
  await b.findByText('conflict')
  expect(b.getByLabelText('Answer')).toHaveValue('B answer')
  expect((await repository.read(scope))[0].value).toEqual(sample('A answer'))
})
