import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { DocumentImportPanel, isDocumentImportDraft, type DocumentImportDraft } from '@/components/learning/teaching-analysis/DocumentImportPanel'
import { emptyAssignment, emptyAssignmentItem } from '@/components/learning/teaching-analysis/sample'
import { initI18n } from '@/i18n/init'
import { ApiError } from '@/shared/api/errors'
import * as api from '@/lib/teaching-documents-api'

const registry = vi.hoisted(() => ({
  current: null as null | { slot: string; value: DocumentImportDraft; dirty: boolean; validate: (value: unknown) => boolean; onRestore: (value: DocumentImportDraft) => void },
  clear: vi.fn(),
}))
vi.mock('@/components/learning/teaching-analysis/TeachingDrafts', () => ({
  useTeachingDraftSlot: (registration: NonNullable<typeof registry.current>) => { registry.current = registration; return { clear: registry.clear } },
}))
vi.mock('@/lib/teaching-documents-api', async original => ({
  ...(await original<typeof api>()), previewTeachingDocument: vi.fn(), extractTeachingDocument: vi.fn(),
}))
initI18n('en')

const document = (): api.LocatedDocument => ({
  filename: 'worksheet.txt', source_hash: 'a'.repeat(64), parser_version: 'text-v1', warnings: [],
  blocks: [
    { block_id: 'B1', locator: 'Line 1', text: 'Calculate 1/2 + 1/3.' },
    { block_id: 'B2', locator: 'Line 2', text: 'Student answer: 2/5' },
    { block_id: 'B3', locator: 'Line 3', text: 'Working: (1+1)/(2+3)=2/5' },
    { block_id: 'B4', locator: 'Line 4', text: 'Explain equal fractional units.' },
  ],
})
const rawText = () => document().blocks.map(block => block.text).join('\n')
const preview = (): api.DocumentPreview => ({ document: document(), document_token: 'b'.repeat(64) })
const extraction = (): api.DocumentExtraction => {
  const source = document()
  const provenance: api.ExtractedFieldSource[] = [
    { question_id: 'Q1', field: 'question', citations: [{ block_id: 'B1', quote: source.blocks[0].text }] },
    { question_id: 'Q1', field: 'student_answer', citations: [{ block_id: 'B2', quote: '2/5' }] },
    { question_id: 'Q1', field: 'student_work', citations: [{ block_id: 'B3', quote: '(1+1)/(2+3)=2/5' }] },
    { question_id: 'Q2', field: 'question', citations: [{ block_id: 'B4', quote: source.blocks[3].text }] },
  ]
  const assignment = {
    ...emptyAssignment(), assignment_ref: source.filename,
    items: [
      { ...emptyAssignmentItem(1), question: source.blocks[0].text, student_answer: '2/5', student_work: '(1+1)/(2+3)=2/5', answer_status: 'present' as const, transcription_status: 'uncertain' as const, source_locator: 'Line 1; Line 2; Line 3' },
      { ...emptyAssignmentItem(2), question: source.blocks[3].text, transcription_status: 'uncertain' as const, source_locator: 'Line 4' },
    ],
    document_provenance: {
      filename: source.filename, source_hash: source.source_hash, parser_version: source.parser_version,
      fields: provenance.map(field => ({ ...field, citations: field.citations.map(citation => ({ ...citation, locator: source.blocks.find(block => block.block_id === citation.block_id)!.locator })) })),
      signature: 'c'.repeat(64),
    },
  }
  return { document: source, assignment, provenance, warnings: ['Check the extracted text against the original.'] }
}

beforeEach(() => {
  vi.clearAllMocks()
  registry.current = null
  registry.clear.mockReset().mockResolvedValue(undefined)
  vi.mocked(api.previewTeachingDocument).mockReset().mockResolvedValue(preview())
  vi.mocked(api.extractTeachingDocument).mockReset().mockResolvedValue(extraction())
})

function mount(props: Partial<Parameters<typeof DocumentImportPanel>[0]> = {}) {
  const onApply = vi.fn()
  const onDirtyChange = vi.fn()
  const view = render(<DocumentImportPanel workspaceId="class-a" disabled={false} onApply={onApply} onDirtyChange={onDirtyChange} {...props} />)
  return { ...view, onApply, onDirtyChange }
}
async function readPaste(text = rawText()) {
  fireEvent.change(screen.getByLabelText('Or paste the original text'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Read pasted text' }))
  await screen.findByText('The original is ready. No model has been called to read this text.')
}
async function extractItems() {
  fireEvent.click(screen.getByRole('button', { name: 'Identify questions and answers' }))
  await screen.findByRole('checkbox', { name: 'I have checked every extracted question and student response against the original.' })
}
const extractedRegion = () => screen.getByRole('region', { name: 'Extracted questions' })
const sourceRegion = () => screen.getByRole('region', { name: 'Original text' })

it('reads ordinary pasted text without interpreting it or applying anything automatically', async () => {
  const view = mount()
  fireEvent.change(screen.getByLabelText('Or paste the original text'), { target: { value: rawText() } })
  expect(api.previewTeachingDocument).not.toHaveBeenCalled()
  expect(api.extractTeachingDocument).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Read pasted text' }))
  await screen.findByText('The original is ready. No model has been called to read this text.')
  expect(api.previewTeachingDocument).toHaveBeenCalledWith(expect.any(File), 'class-a', expect.any(AbortSignal))
  expect(within(sourceRegion()).getByText('Student answer: 2/5')).toBeVisible()
  expect(within(sourceRegion()).queryByRole('textbox')).toBeNull()
  expect(api.extractTeachingDocument).not.toHaveBeenCalled()
  expect(view.onApply).not.toHaveBeenCalled()
})

it('identifies only on request, shows literal field sources and jumps to the actual original block', async () => {
  mount()
  await readPaste()
  await extractItems()
  expect(api.extractTeachingDocument).toHaveBeenCalledWith(preview(), 'en', 'class-a', expect.any(AbortSignal))
  const quote = within(extractedRegion()).getByRole('link', { name: 'Check original · Line 3' })
  fireEvent.click(quote)
  const block = globalThis.document.querySelector('[data-document-block="B3"]')!
  await waitFor(() => expect(block).toHaveFocus())
  expect(block).toHaveClass('ring-2')
  expect(screen.getByRole('tab', { name: 'Original text' })).toHaveAttribute('aria-selected', 'true')
  expect(api.extractTeachingDocument).toHaveBeenCalledTimes(1)
})

it('applies an unconfirmed extraction only explicitly and never infers a missing answer as a blank', async () => {
  const view = mount()
  await readPaste()
  await extractItems()
  expect(view.onApply).not.toHaveBeenCalled()
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: 'Place in the question review form' }))
  const applied = view.onApply.mock.calls[0][0]
  expect(applied.items.every((item: { transcription_status: string }) => item.transcription_status === 'uncertain')).toBe(true)
  expect(applied.items[1]).toMatchObject({ answer_status: 'unknown', student_answer: null, student_work: null })
  expect(applied.student_ref).toBe('')
  expect(applied.subject).toBe('')
  expect(applied.document_provenance).toEqual(extraction().assignment.document_provenance)
  expect(api.extractTeachingDocument).toHaveBeenCalledTimes(1)
})

it('confirms transcription only after the teacher explicitly checks the review box', async () => {
  const view = mount()
  await readPaste()
  await extractItems()
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Transcription checked · Use in this assignment' }))
  const applied = view.onApply.mock.calls[0][0]
  expect(applied.items.every((item: { transcription_status: string }) => item.transcription_status === 'confirmed')).toBe(true)
  expect(applied.items[1]).toMatchObject({ answer_status: 'unknown', student_answer: null, student_work: null })
  expect(applied.document_provenance).toEqual(extraction().assignment.document_provenance)
})

it('keeps the original when no model is configured and offers the scoped model settings link', async () => {
  vi.mocked(api.extractTeachingDocument).mockRejectedValueOnce(new ApiError({ code: 'teaching_model_not_configured', message: 'Missing model', retryable: false, scope: 'network', status: 503 }))
  mount()
  await readPaste()
  fireEvent.click(screen.getByRole('button', { name: 'Identify questions and answers' }))
  expect(await screen.findByRole('link', { name: 'Configure a chat model' })).toHaveAttribute('href', '/settings/llm?dt_workspace=class-a')
  expect(within(sourceRegion()).getByText('Student answer: 2/5')).toBeVisible()
  expect(screen.getByLabelText('Or paste the original text')).toHaveValue(rawText())
  expect(api.extractTeachingDocument).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('button', { name: 'Place in the question review form' })).toBeNull()
})

it('requires explicit re-reading after an invalid proof without silently rerunning a model', async () => {
  vi.mocked(api.extractTeachingDocument).mockRejectedValueOnce(new ApiError({ code: 'teaching_document_token_invalid', message: 'Read again', retryable: false, scope: 'network', status: 422 }))
  mount()
  await readPaste()
  fireEvent.click(screen.getByRole('button', { name: 'Identify questions and answers' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Read the original again' }))
  await screen.findByText('The original is ready. No model has been called to read this text.')
  expect(api.previewTeachingDocument).toHaveBeenCalledTimes(2)
  expect(api.extractTeachingDocument).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Identify questions and answers' })).toBeEnabled()
})

it('retains the old review draft when a replacement document cannot be read', async () => {
  mount()
  await readPaste()
  await extractItems()
  vi.mocked(api.previewTeachingDocument).mockRejectedValueOnce(new Error('The DOCX archive is damaged.'))
  fireEvent.change(screen.getByLabelText('Choose a source document'), { target: { files: [new File(['bad archive'], 'work.docx')] } })
  const dialog = screen.getByRole('dialog', { name: 'Replace the staged source document?' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Read the replacement document' }))
  await screen.findByText('The DOCX archive is damaged.')
  expect(within(sourceRegion()).getByText('Student answer: 2/5')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Place in the question review form' })).toBeEnabled()
})

it('rejects unsupported or oversized files before replacing any existing review material', async () => {
  mount()
  await readPaste()
  await extractItems()
  fireEvent.change(screen.getByLabelText('Choose a source document'), { target: { files: [new File(['pdf'], 'work.pdf')] } })
  expect(screen.getByText(/Choose a TXT, MD or DOCX file/)).toBeVisible()
  const oversized = new File(['x'], 'work.docx')
  Object.defineProperty(oversized, 'size', { value: api.MAX_DOCUMENT_BYTES + 1 })
  fireEvent.change(screen.getByLabelText('Choose a source document'), { target: { files: [oversized] } })
  expect(screen.getByText('Choose a source file up to 1 MB. The current material was kept.')).toBeVisible()
  expect(api.previewTeachingDocument).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Place in the question review form' })).toBeEnabled()
})

it('keeps over-limit pasted text intact and prevents interpreting an older version as that new text', async () => {
  mount()
  await readPaste()
  await extractItems()
  const large = 'x'.repeat(api.MAX_DOCUMENT_TEXT + 1)
  fireEvent.change(screen.getByLabelText('Or paste the original text'), { target: { value: large } })
  fireEvent.click(screen.getByRole('button', { name: 'Read pasted text' }))
  expect(screen.getByLabelText('Or paste the original text')).toHaveValue(large)
  expect(screen.getByText(/Read at most 30,000 text characters/)).toBeVisible()
  expect(screen.getByRole('button', { name: 'Identify questions and answers again' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Place in the question review form' })).toBeDisabled()
  expect(api.previewTeachingDocument).toHaveBeenCalledTimes(1)
  expect(api.extractTeachingDocument).toHaveBeenCalledTimes(1)
  expect(isDocumentImportDraft(registry.current!.value)).toBe(true)
})

it('clears only the document panel and its draft after an explicit confirmation', async () => {
  const view = mount()
  await readPaste()
  await extractItems()
  fireEvent.click(screen.getByRole('button', { name: 'Place in the question review form' }))
  expect(view.onApply).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Clear this staged document' }))
  const dialog = screen.getByRole('dialog', { name: 'Clear this staged document?' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Clear the document panel' }))
  await waitFor(() => expect(screen.getByLabelText('Or paste the original text')).toHaveValue(''))
  expect(registry.clear).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('button', { name: 'Place in the question review form' })).toBeNull()
  expect(view.onApply).toHaveBeenCalledTimes(1)
  expect(view.onDirtyChange).toHaveBeenLastCalledWith(false)
})

it('retains the original when local draft clearing fails', async () => {
  registry.clear.mockRejectedValueOnce(new Error('Local storage unavailable'))
  mount()
  await readPaste()
  fireEvent.click(screen.getByRole('button', { name: 'Clear this staged document' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear the document panel' }))
  await screen.findByText(/The local draft could not be cleared/)
  expect(within(sourceRegion()).getByText('Student answer: 2/5')).toBeVisible()
  expect(screen.getByLabelText('Or paste the original text')).toHaveValue(rawText())
})

it('restores only validated JSON data without a model request or automatic teacher confirmation', async () => {
  const first = mount()
  await readPaste()
  await extractItems()
  fireEvent.click(screen.getByRole('checkbox'))
  const snapshot = JSON.parse(JSON.stringify(registry.current!.value)) as DocumentImportDraft
  expect(isDocumentImportDraft(snapshot)).toBe(true)
  first.unmount()
  vi.mocked(api.previewTeachingDocument).mockClear()
  vi.mocked(api.extractTeachingDocument).mockClear()
  mount()
  const registration = registry.current!
  await act(async () => registration.onRestore(snapshot))
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  expect(screen.getByRole('button', { name: 'Place in the question review form' })).toBeEnabled()
  expect(screen.getByText(/The original and review draft were restored locally/)).toBeVisible()
  expect(api.previewTeachingDocument).not.toHaveBeenCalled()
  expect(api.extractTeachingDocument).not.toHaveBeenCalled()
})

it('rejects damaged draft versions, non-JSON data and citations that disagree with the original', () => {
  const base: DocumentImportDraft = { kind: 'document-import', version: 1, pasted: rawText(), preview: preview(), extraction: extraction(), source_kind: 'paste', preview_pasted: rawText(), requires_preview: false }
  expect(isDocumentImportDraft(base)).toBe(true)
  expect(isDocumentImportDraft({ ...base, version: 2 })).toBe(false)
  expect(isDocumentImportDraft({ ...base, file: new File(['x'], 'unexpected.docx') })).toBe(false)
  expect(isDocumentImportDraft({ ...base, extraction: { ...extraction(), hidden: new Blob(['not JSON']) } })).toBe(false)
  expect(isDocumentImportDraft({ ...base, extraction: { ...extraction(), hidden: () => 'not JSON' } })).toBe(false)
  const cyclic = { ...base } as DocumentImportDraft & { cycle?: unknown }
  cyclic.cycle = cyclic
  expect(isDocumentImportDraft(cyclic)).toBe(false)
  expect(isDocumentImportDraft({ ...base, preview: { ...preview(), document_token: 'not-a-proof' } })).toBe(false)
  const changed = extraction()
  changed.provenance[1].citations[0].quote = 'A fabricated student response'
  expect(isDocumentImportDraft({ ...base, extraction: changed })).toBe(false)
  const differentSource = extraction()
  differentSource.document.source_hash = 'd'.repeat(64)
  expect(isDocumentImportDraft({ ...base, extraction: differentSource })).toBe(false)
  expect(api.isLocatedDocument({ ...document(), filename: '../other.txt' })).toBe(false)
  expect(api.isLocatedDocument({ ...document(), blocks: [document().blocks[0], document().blocks[0]] })).toBe(false)
})

it('aborts a preview read and ignores its late response after switching workspaces', async () => {
  let finish!: (value: api.DocumentPreview) => void
  vi.mocked(api.previewTeachingDocument).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const view = mount()
  fireEvent.change(screen.getByLabelText('Or paste the original text'), { target: { value: rawText() } })
  fireEvent.click(screen.getByRole('button', { name: 'Read pasted text' }))
  const signal = vi.mocked(api.previewTeachingDocument).mock.calls[0][2]!
  view.rerender(<DocumentImportPanel workspaceId="class-b" disabled={false} onApply={view.onApply} />)
  expect(signal.aborted).toBe(true)
  await act(async () => finish(preview()))
  expect(screen.getByLabelText('Or paste the original text')).toHaveValue('')
  expect(screen.queryByRole('button', { name: 'Identify questions and answers' })).toBeNull()
  expect(view.onApply).not.toHaveBeenCalled()
})

it('aborts interpretation on a workspace switch and prevents double interpretation clicks', async () => {
  let finish!: (value: api.DocumentExtraction) => void
  vi.mocked(api.extractTeachingDocument).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const view = mount()
  await readPaste()
  const interpret = screen.getByRole('button', { name: 'Identify questions and answers' })
  fireEvent.click(interpret)
  fireEvent.click(interpret)
  expect(api.extractTeachingDocument).toHaveBeenCalledTimes(1)
  const signal = vi.mocked(api.extractTeachingDocument).mock.calls[0][3]!
  view.rerender(<DocumentImportPanel workspaceId="class-b" disabled={false} onApply={view.onApply} />)
  expect(signal.aborted).toBe(true)
  await act(async () => finish(extraction()))
  expect(screen.queryByRole('button', { name: 'Place in the question review form' })).toBeNull()
  expect(view.onApply).not.toHaveBeenCalled()
})

it('keeps the staging draft until the parent actually accepts its source signature', async () => {
  const view = mount()
  await readPaste()
  await extractItems()
  fireEvent.click(screen.getByRole('button', { name: 'Place in the question review form' }))
  expect(view.onDirtyChange).toHaveBeenLastCalledWith(true)
  view.rerender(<DocumentImportPanel workspaceId="class-a" disabled={false} onApply={view.onApply} onDirtyChange={view.onDirtyChange} appliedSignature="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" />)
  await waitFor(() => expect(view.onDirtyChange).toHaveBeenLastCalledWith(false))
  expect(screen.getByText(/This document's extracted material is in the current assignment/)).toBeVisible()
  fireEvent.change(screen.getByLabelText('Or paste the original text'), { target: { value: 'A different source to read next.' } })
  await waitFor(() => expect(view.onDirtyChange).toHaveBeenLastCalledWith(true))
})

it('does not apply an extraction with no questions or manufacture an answer to make it usable', async () => {
  const empty = extraction()
  empty.assignment.items = []
  empty.assignment.document_provenance = null
  empty.provenance = []
  vi.mocked(api.extractTeachingDocument).mockResolvedValueOnce(empty)
  const view = mount()
  await readPaste()
  await extractItems()
  expect(screen.getByText(/No reviewable questions were identified/)).toBeVisible()
  expect(screen.getByRole('button', { name: 'Place in the question review form' })).toBeDisabled()
  expect(view.onApply).not.toHaveBeenCalled()
})

it('sends only the source and scoped proof through the real extraction client, and rejects malformed responses', async () => {
  const real = await vi.importActual<typeof api>('@/lib/teaching-documents-api')
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(extraction()), { status: 200 }))
  const result = await real.extractTeachingDocument(preview(), 'en', 'class-b')
  expect(result.assignment.items).toHaveLength(2)
  const [url, options] = fetcher.mock.calls[0]
  expect(String(url)).toContain('dt_workspace=class-b')
  expect(options).toMatchObject({ method: 'POST', credentials: 'include' })
  expect(JSON.parse(String(options?.body))).toEqual({ document: preview().document, document_token: preview().document_token, language: 'en' })
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ document: { ...document(), blocks: [] }, document_token: 'b'.repeat(64) }), { status: 200 }))
  await expect(real.previewTeachingDocument(new File(['text'], 'work.txt'), 'class-b')).rejects.toMatchObject({ code: 'teaching_document_response_invalid' })
})
