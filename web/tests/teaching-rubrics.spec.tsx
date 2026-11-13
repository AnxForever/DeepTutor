import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { RubricLibrary } from '@/components/learning/teaching-analysis/RubricLibrary'
import { initI18n } from '@/i18n/init'
import { ApiError } from '@/shared/api/errors'
import * as api from '@/lib/teaching-rubrics-api'

vi.mock('@/lib/teaching-rubrics-api', async original => ({
  ...(await original<typeof api>()),
  listTeachingRubrics: vi.fn(), saveTeachingRubric: vi.fn(), listTeachingRubricRevisions: vi.fn(),
}))
initI18n('en')
const standard = (revision = 1): api.RubricTemplate => ({
  template_id: '163a8505-236e-4e67-b206-7235178824ee', revision,
  name: 'Check the units', subject: 'Mathematics', grade: 'Grade 5',
  criteria: revision === 1 ? 'Explain the common denominator.' : 'Explain equivalent fractions before adding.',
  created_at: 1, updated_at: revision,
})
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.listTeachingRubrics).mockResolvedValue([standard()])
  vi.mocked(api.saveTeachingRubric).mockImplementation(async request => ({ ...request, revision: request.expected_revision + 1, created_at: 1, updated_at: 2 }))
  vi.mocked(api.listTeachingRubricRevisions).mockResolvedValue([standard(2), standard(1)])
})
const props = () => ({ workspaceId: 'class-a', subject: 'Mathematics', grade: 'Grade 5', applied: null, disabled: false, onApply: vi.fn() })

async function openLibrary() {
  const details = screen.getByText('Marking standard (optional)').closest('details')!
  await act(async () => { details.open = true; fireEvent(details, new Event('toggle')) })
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Saved marking standards' })).toBeEnabled())
}
async function selectStandard() {
  await openLibrary()
  fireEvent.change(screen.getByRole('combobox', { name: 'Saved marking standards' }), { target: { value: standard().template_id } })
}

it('loads the scoped library only when opened and applies an explicit version snapshot', async () => {
  const source = standard()
  vi.mocked(api.listTeachingRubrics).mockResolvedValue([source])
  const input = props()
  render(<RubricLibrary {...input} />)
  expect(api.listTeachingRubrics).not.toHaveBeenCalled()
  await selectStandard()
  expect(api.listTeachingRubrics).toHaveBeenCalledWith('class-a', expect.any(AbortSignal))
  expect(input.onApply).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Apply to this assignment' }))
  expect(input.onApply).toHaveBeenCalledWith(api.rubricSnapshot(standard()))
  expect(input.onApply.mock.calls[0][0]).not.toHaveProperty('updated_at')
  expect(input.onApply.mock.calls[0][0]).not.toBe(source)
})

it('saves a newer library version without changing the version already applied to the assignment', async () => {
  const input = { ...props(), applied: api.rubricSnapshot(standard()) }
  render(<RubricLibrary {...input} />)
  await selectStandard()
  fireEvent.change(screen.getByLabelText('Marking guidance'), { target: { value: 'Explain equivalent fractions before adding.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save standard version' }))
  await screen.findByText(/Revision 2 saved to the library/)
  expect(input.applied.criteria).toBe('Explain the common denominator.')
  expect(input.applied.revision).toBe(1)
  expect(input.onApply).not.toHaveBeenCalled()
  expect(screen.getByText(/This assignment still uses Check the units, revision 1/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Apply revision 2' }))
  expect(input.onApply).toHaveBeenCalledWith(expect.objectContaining({ revision: 2, criteria: 'Explain equivalent fractions before adding.' }))
})

it('preserves new-standard edits and the client ID across a failed save and retry', async () => {
  vi.mocked(api.saveTeachingRubric).mockRejectedValueOnce(new Error('Storage unavailable'))
  const input = props()
  render(<RubricLibrary {...input} />)
  await openLibrary()
  fireEvent.change(screen.getByLabelText('Standard name'), { target: { value: 'Reasoning steps' } })
  fireEvent.change(screen.getByLabelText('Marking guidance'), { target: { value: 'Explain each transformation.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save standard version' }))
  await screen.findByText('Storage unavailable')
  expect(screen.getByLabelText('Marking guidance')).toHaveValue('Explain each transformation.')
  expect(input.onApply).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Save standard version' }))
  await screen.findByText(/Revision 1 saved to the library/)
  const calls = vi.mocked(api.saveTeachingRubric).mock.calls
  expect(calls[0][0]).toEqual(calls[1][0])
  expect(calls[1][0]).toMatchObject({ name: 'Reasoning steps', expected_revision: 0, criteria: 'Explain each transformation.' })
})

it('keeps conflicting local criteria and asks before loading the newer library version', async () => {
  vi.mocked(api.listTeachingRubrics).mockResolvedValueOnce([standard(1)]).mockResolvedValue([standard(2)])
  vi.mocked(api.saveTeachingRubric).mockRejectedValue(new ApiError({ code: 'http_409', message: 'Standard changed', status: 409, retryable: false, scope: 'network' }))
  render(<RubricLibrary {...props()} />)
  await selectStandard()
  fireEvent.change(screen.getByLabelText('Marking guidance'), { target: { value: 'Local criteria to preserve.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save standard version' }))
  await screen.findByText(/The library contains a newer version/)
  expect(screen.getByLabelText('Marking guidance')).toHaveValue('Local criteria to preserve.')
  expect(screen.getByRole('button', { name: 'Save standard version' })).toBeDisabled()
  fireEvent.click(await screen.findByRole('button', { name: 'Reload saved version' }))
  const dialog = screen.getByRole('dialog', { name: 'Discard unsaved standard edits?' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(screen.getByLabelText('Marking guidance')).toHaveValue('Local criteria to preserve.')
})

it('shows historic criteria without replacing the editor or automatically applying them', async () => {
  vi.mocked(api.listTeachingRubrics).mockResolvedValue([standard(2)])
  const input = props()
  render(<RubricLibrary {...input} />)
  await selectStandard()
  fireEvent.click(screen.getByRole('button', { name: 'Standard version history' }))
  const history = await screen.findByRole('region', { name: 'Standard version history' })
  expect(within(history).getByText('Explain the common denominator.')).toBeInTheDocument()
  expect(screen.getByLabelText('Marking guidance')).toHaveValue('Explain equivalent fractions before adding.')
  expect(input.onApply).not.toHaveBeenCalled()
  fireEvent.click(within(history).getByRole('button', { name: 'Apply this version (1)' }))
  expect(input.onApply).toHaveBeenCalledWith(api.rubricSnapshot(standard(1)))
})

it('aborts pending library requests and ignores old-workspace responses', async () => {
  let complete!: (templates: api.RubricTemplate[]) => void
  vi.mocked(api.listTeachingRubrics).mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  const input = props()
  const view = render(<RubricLibrary {...input} />)
  const details = screen.getByText('Marking standard (optional)').closest('details')!
  await act(async () => { details.open = true; fireEvent(details, new Event('toggle')) })
  const signal = vi.mocked(api.listTeachingRubrics).mock.calls[0][1]!
  view.rerender(<RubricLibrary {...input} workspaceId="class-b" />)
  expect(signal.aborted).toBe(true)
  await act(async () => complete([standard()]))
  expect(screen.queryByRole('option', { name: /Check the units/ })).toBeNull()
  await openLibrary()
  expect(api.listTeachingRubrics).toHaveBeenLastCalledWith('class-b', expect.any(AbortSignal))
})
