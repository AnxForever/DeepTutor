import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorksheetActions } from '@/components/learning/teaching-analysis/WorksheetActions'
import { SourceProvenanceView } from '@/components/learning/teaching-analysis/SourceProvenanceView'
import { initI18n } from '@/i18n/init'
import { fetchTeachingWorksheet } from '@/lib/teaching-worksheets-api'
import { exampleAssignment } from '@/components/learning/teaching-analysis/sample'
import type { SavedFollowup } from '@/lib/teaching-followups-api'

vi.mock('@/lib/teaching-worksheets-api', () => ({ fetchTeachingWorksheet: vi.fn() }))
initI18n('en')
const NativeURL = URL
const source: SavedFollowup = {
  followup_id: 'c94c3b56-d479-4b9c-a6d6-1815c51da2a4', revision: 3,
  report_id: 'b63f5851-4db1-44b1-bbe7-6f28bfe01830', report_revision: 2, priority_index: 0,
  student_ref: 'student-a', assignment_ref: 'worksheet-a', subject: 'math', grade: '',
  source_fingerprint: 'a'.repeat(64), knowledge_point: 'Addition', title: 'Checked worksheet',
  questions: [{ question_id: 'F1', question: '1 + 1?', reference_answer: '2', rubric: null }],
  created_at: 1, updated_at: 2,
}

function popup() {
  return { opener: window, document: { body: { textContent: '' } }, location: { href: 'about:blank' }, closed: false, close: vi.fn() }
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('URL', class extends NativeURL {
    static createObjectURL = vi.fn(() => 'blob:http://localhost/worksheet')
    static revokeObjectURL = vi.fn()
  })
  vi.mocked(fetchTeachingWorksheet).mockResolvedValue(new Blob(['safe worksheet'], { type: 'text/html' }))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('opens only the saved student edition by default and severs the new tab opener', async () => {
  const tab = popup()
  vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
  render(<WorksheetActions followup={source} workspaceId="class-a" />)
  fireEvent.click(screen.getByRole('button', { name: 'Open student print edition' }))
  await waitFor(() => expect(tab.location.href).toMatch(/^blob:/))
  expect(fetchTeachingWorksheet).toHaveBeenCalledWith(source.followup_id, 3, 'student', 'html', 'en', 'class-a', expect.any(AbortSignal))
  expect(tab.opener).toBeNull()
  expect(fetchTeachingWorksheet).toHaveBeenCalledTimes(1)
})

it('requires the explicitly named teacher action to request an answer-bearing edition', async () => {
  const tab = popup()
  vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
  render(<WorksheetActions followup={source} workspaceId="class-a" />)
  const details = screen.getByText('Teacher reference edition — includes answers').closest('details')!
  details.open = true
  fireEvent.click(screen.getByRole('button', { name: 'Open teacher reference edition' }))
  await waitFor(() => expect(fetchTeachingWorksheet).toHaveBeenCalledWith(source.followup_id, 3, 'teacher', 'html', 'en', 'class-a', expect.any(AbortSignal)))
})

it('does not fetch when the browser blocks a new tab', () => {
  vi.spyOn(window, 'open').mockReturnValue(null)
  render(<WorksheetActions followup={source} workspaceId="class-a" />)
  fireEvent.click(screen.getByRole('button', { name: 'Open student print edition' }))
  expect(fetchTeachingWorksheet).not.toHaveBeenCalled()
  expect(screen.getByText(/Allow a new tab/)).toBeInTheDocument()
})

it('closes an unused print tab after a failed export and leaves the saved version unchanged', async () => {
  const tab = popup()
  vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
  vi.mocked(fetchTeachingWorksheet).mockRejectedValue(new Error('Try again later'))
  render(<WorksheetActions followup={source} workspaceId="class-a" />)
  fireEvent.click(screen.getByRole('button', { name: 'Open student print edition' }))
  await screen.findByText('Try again later')
  expect(tab.close).toHaveBeenCalledOnce()
  expect(source.revision).toBe(3)
})

it('aborts a departed scope and never navigates its late print response', async () => {
  const tab = popup()
  vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
  let complete!: (value: Blob) => void
  vi.mocked(fetchTeachingWorksheet).mockReturnValue(new Promise(resolve => { complete = resolve }))
  const view = render(<WorksheetActions followup={source} workspaceId="class-a" />)
  fireEvent.click(screen.getByRole('button', { name: 'Open student print edition' }))
  const signal = vi.mocked(fetchTeachingWorksheet).mock.calls[0][6]!
  view.unmount()
  expect(signal.aborted).toBe(true)
  await act(async () => complete(new Blob(['late'])))
  expect(tab.location.href).toBe('about:blank')
  expect(tab.close).toHaveBeenCalled()
})

it('retains original document excerpts and labels a corrected current answer as modified', () => {
  const assignment = exampleAssignment('en')
  assignment.items[0].student_answer = 'teacher-corrected'
  assignment.document_provenance = {
    filename: 'work.docx', source_hash: 'a'.repeat(64), parser_version: 'v1', signature: 'b'.repeat(64),
    fields: [{ question_id: assignment.items[0].question_id, field: 'student_answer', citations: [{ block_id: 'B1', locator: 'Paragraph 2', quote: 'original-answer' }] }],
  }
  const clear = vi.fn()
  render(<SourceProvenanceView assignment={assignment} onClear={clear} />)
  screen.getByText(/Original document excerpts/).closest('details')!.open = true
  expect(screen.getByText('Teacher modified this field')).toBeInTheDocument()
  expect(screen.getByText('original-answer')).toBeInTheDocument()
  expect(screen.getByText('Paragraph 2')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Remove document source references' }))
  expect(clear).toHaveBeenCalledOnce()
  expect(assignment.document_provenance.fields[0].citations[0].quote).toBe('original-answer')
})
