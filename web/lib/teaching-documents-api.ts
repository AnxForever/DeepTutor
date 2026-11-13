import { requestJson } from '@/shared/api/client'
import { ApiError } from '@/shared/api/errors'
import { scopedUrl } from '@/lib/workspace-scope'
import type { AssignmentInput } from '@/lib/teaching-analysis-api'
import type { components } from '@/contracts/generated/api'
import { draftObject, draftText, isDraftAssignment } from '@/lib/teaching-draft-validation'

const ROOT = '/api/teaching-analysis/documents'
export const MAX_DOCUMENT_BYTES = 1_048_576
export const MAX_DOCUMENT_TEXT = 30_000
type Mutable<T> = T extends readonly (infer Item)[] ? Mutable<Item>[] : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T
type Schema<Name extends keyof components['schemas']> = Mutable<components['schemas'][Name]>
export type LocatedBlock = Schema<'LocatedBlock'>
export type LocatedDocument = Omit<Required<Schema<'LocatedDocument'>>, 'blocks'> & { blocks: LocatedBlock[] }
export type DocumentPreview = Omit<Schema<'DocumentPreview'>, 'document'> & { document: LocatedDocument }
export type ExtractedFieldSource = Schema<'DocumentExtraction'>['provenance'][number]
export type DocumentCitation = ExtractedFieldSource['citations'][number]
export type ExtractedDocumentField = ExtractedFieldSource['field']
export type DocumentExtraction = Omit<Schema<'DocumentExtraction'>, 'assignment' | 'document'> & { assignment: AssignmentInput; document: LocatedDocument }
const fields: ExtractedDocumentField[] = ['question', 'student_answer', 'student_work', 'reference_answer', 'rubric']

const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const blockId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
const nonblank = (value: unknown, limit: number): value is string => draftText(value, limit) && Boolean(value.trim())
const warnings = (value: unknown, limit: number): value is string[] => Array.isArray(value) && value.length <= limit && value.every(item => draftText(item, 1000))

/** IndexedDB can hold richer objects than JSON; none belong in this slot. */
export function isSerializableDocumentState(value: unknown): boolean {
  const ancestors = new Set<object>()
  let nodes = 0
  let textUnits = 0
  function visit(item: unknown, depth: number): boolean {
    if (++nodes > 30_000 || depth > 24) return false
    if (item === null || typeof item === 'boolean') return true
    if (typeof item === 'number') return Number.isFinite(item)
    if (typeof item === 'string') { textUnits += item.length; return textUnits <= MAX_DOCUMENT_BYTES * 4 }
    if (!(Array.isArray(item) || draftObject(item)) || ancestors.has(item)) return false
    ancestors.add(item)
    const valid = Object.values(item).every(child => visit(child, depth + 1))
    ancestors.delete(item)
    return valid
  }
  return visit(value, 0)
}

export function isLocatedDocument(value: unknown): value is LocatedDocument {
  if (!draftObject(value) || !nonblank(value.filename, 200) || /[\\/<>:"|?*\u0000-\u001f]/.test(value.filename) || ['.', '..'].includes(value.filename) ||
    !hash(value.source_hash) || !nonblank(value.parser_version, 100) || !warnings(value.warnings, 20) ||
    !Array.isArray(value.blocks) || !value.blocks.length || value.blocks.length > 300) return false
  const ids = new Set<string>()
  let characters = 0
  for (const block of value.blocks) {
    if (!draftObject(block) || !blockId(block.block_id) || ids.has(block.block_id) || !nonblank(block.locator, 500) || !nonblank(block.text, MAX_DOCUMENT_TEXT)) return false
    ids.add(block.block_id)
    characters += Array.from(block.text).length
    if (characters > MAX_DOCUMENT_TEXT) return false
  }
  return true
}

export function sameLocatedDocument(left: LocatedDocument, right: LocatedDocument): boolean {
  return left.filename === right.filename && left.source_hash === right.source_hash && left.parser_version === right.parser_version &&
    left.blocks.length === right.blocks.length && left.blocks.every((block, index) => {
      const other = right.blocks[index]
      return block.block_id === other.block_id && block.locator === other.locator && block.text === other.text
    })
}

export function isDocumentPreview(value: unknown): value is DocumentPreview {
  return draftObject(value) && isLocatedDocument(value.document) && hash(value.document_token)
}

/** Structural/source consistency checks; the server owns proof verification. */
export function isDocumentExtraction(value: unknown): value is DocumentExtraction {
  if (!draftObject(value) || !isLocatedDocument(value.document) || !isDraftAssignment(value.assignment) ||
    !Array.isArray(value.provenance) || value.provenance.length > 200 || !warnings(value.warnings, 25)) return false
  const document = value.document
  const assignment = value.assignment
  const blocks = new Map(document.blocks.map(block => [block.block_id, block]))
  const questions = new Map(assignment.items.map(item => [item.question_id, item]))
  if (questions.size !== assignment.items.length || assignment.items.some(item => !item.question_id.trim() || !item.question.trim() || item.transcription_status !== 'uncertain' || item.answer_status === 'confirmed_blank')) return false
  const seen = new Set<string>()
  for (const field of value.provenance) {
    if (!draftObject(field) || !nonblank(field.question_id, 128) || typeof field.field !== 'string' || !fields.includes(field.field as ExtractedDocumentField) ||
      !Array.isArray(field.citations) || !field.citations.length || field.citations.length > 6) return false
    const key = `${field.question_id}:${field.field}`
    if (seen.has(key)) return false
    seen.add(key)
    const question = questions.get(field.question_id)
    if (!question) return false
    const quotes: string[] = []
    for (const citation of field.citations) {
      if (!draftObject(citation) || !blockId(citation.block_id) || !nonblank(citation.quote, 8000)) return false
      const block = blocks.get(citation.block_id)
      if (!block || !block.text.includes(citation.quote) || block.text.indexOf(citation.quote) !== block.text.lastIndexOf(citation.quote)) return false
      quotes.push(citation.quote)
    }
    if (question[field.field as ExtractedDocumentField] !== quotes.join('\n')) return false
  }
  for (const question of assignment.items) {
    for (const field of fields) {
      if (question[field] !== null && !seen.has(`${question.question_id}:${field}`)) return false
    }
    const present = question.student_answer !== null || question.student_work !== null
    if (question.answer_status !== (present ? 'present' : 'unknown')) return false
  }
  const snapshot = (assignment as AssignmentInput & { document_provenance?: unknown }).document_provenance
  if (assignment.items.length) {
    if (!draftObject(snapshot) || snapshot.filename !== document.filename || snapshot.source_hash !== document.source_hash || snapshot.parser_version !== document.parser_version ||
      !hash(snapshot.signature) || !Array.isArray(snapshot.fields) || snapshot.fields.length !== value.provenance.length) return false
    for (let index = 0; index < snapshot.fields.length; index++) {
      const saved = snapshot.fields[index]
      const current = value.provenance[index]
      if (!draftObject(saved) || !draftObject(current) || saved.question_id !== current.question_id || saved.field !== current.field ||
        !Array.isArray(saved.citations) || !Array.isArray(current.citations) || saved.citations.length !== current.citations.length) return false
      for (let citationIndex = 0; citationIndex < saved.citations.length; citationIndex++) {
        const quote = saved.citations[citationIndex]
        const original = current.citations[citationIndex]
        if (!draftObject(quote) || !draftObject(original) || quote.block_id !== original.block_id || quote.quote !== original.quote || quote.locator !== blocks.get(String(quote.block_id))?.locator) return false
      }
    }
  }
  return true
}

function invalidResponse(): ApiError {
  return new ApiError({ code: 'teaching_document_response_invalid', message: 'The document response could not be verified. The previous material is preserved.', retryable: false, scope: 'network' })
}

export async function previewTeachingDocument(file: File, workspaceId: string, signal?: AbortSignal): Promise<DocumentPreview> {
  const body = new FormData()
  body.append('file', file)
  const result = await requestJson<unknown>(scopedUrl(`${ROOT}/preview`, workspaceId), { method: 'POST', body, signal })
  if (!isDocumentPreview(result)) throw invalidResponse()
  return result
}

export async function extractTeachingDocument(preview: DocumentPreview, language: 'en' | 'zh', workspaceId: string, signal?: AbortSignal): Promise<DocumentExtraction> {
  const result = await requestJson<unknown>(scopedUrl(`${ROOT}/extract`, workspaceId), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document: preview.document, document_token: preview.document_token, language }), signal,
  })
  if (!isDocumentExtraction(result) || !sameLocatedDocument(preview.document, result.document)) throw invalidResponse()
  return result
}
