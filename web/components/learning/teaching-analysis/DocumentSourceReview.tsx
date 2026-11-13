'use client'

import { useTranslation } from 'react-i18next'
import { ArrowUpRight } from 'lucide-react'
import { StatusChip } from '@/shared/ui'
import type { DocumentExtraction, DocumentPreview, ExtractedDocumentField } from '@/lib/teaching-documents-api'

const fieldNames: ExtractedDocumentField[] = ['question', 'student_answer', 'student_work', 'reference_answer', 'rubric']

export function DocumentSourceReview({ preview, extraction, view, highlighted, sourceId, onCitation, sourceHeadingId, extractionHeadingId }: {
  preview: DocumentPreview | null
  extraction: DocumentExtraction | null
  view: 'source' | 'extracted'
  highlighted: string | null
  sourceId: (blockId: string) => string
  onCitation: (blockId: string) => void
  sourceHeadingId: string
  extractionHeadingId: string
}) {
  const { t } = useTranslation()
  const document = preview?.document
  return (
    <div className="mt-5 grid min-w-0 gap-4 lg:grid-cols-2">
      <section id={sourceHeadingId} aria-label={t('teaching.documents.source')} className={`${view === 'source' ? 'block' : 'hidden'} min-w-0 rounded-xl border border-border lg:block`}>
        <header className="border-b border-border p-4"><h4 className="text-sm font-semibold">{t('teaching.documents.source')}</h4><p className="mt-1 text-xs leading-5 text-muted-foreground">{document ? t('teaching.documents.sourceCount', { filename: document.filename, n: document.blocks.length }) : t('teaching.documents.emptySource')}</p></header>
        {document && <>
          <p className="px-4 pt-3 text-xs leading-5 text-muted-foreground">{t('teaching.documents.originalReadOnly')}</p>
          <ol className="mt-3 max-h-[34rem] space-y-3 overflow-y-auto p-3">
            {document.blocks.map(block => <li key={block.block_id} id={sourceId(block.block_id)} tabIndex={-1} data-document-block={block.block_id} className={`rounded-lg border p-3 outline-none ${highlighted === block.block_id ? 'border-primary/50 bg-primary/5 ring-2 ring-primary/20' : 'border-border/60 bg-muted/25'}`}>
              <p className="mb-2 text-xs font-medium text-muted-foreground">{block.locator}</p>
              <p className="whitespace-pre-wrap break-words text-sm leading-6">{block.text}</p>
            </li>)}
          </ol>
        </>}
      </section>
      <section id={extractionHeadingId} aria-label={t('teaching.documents.extracted')} className={`${view === 'extracted' ? 'block' : 'hidden'} min-w-0 rounded-xl border border-border lg:block`}>
        <header className="border-b border-border p-4"><h4 className="text-sm font-semibold">{t('teaching.documents.extracted')}</h4></header>
        {!extraction ? <p className="p-4 text-sm leading-6 text-muted-foreground">{t('teaching.documents.emptyExtraction')}</p> : !extraction.assignment.items.length ? <p className="p-4 text-sm leading-6 text-muted-foreground">{t('teaching.documents.noItems')}</p> : <div className="max-h-[38rem] space-y-3 overflow-y-auto p-3">
          {extraction.assignment.items.map((item, index) => <details key={item.question_id} open={index === 0 ? true : undefined} className="rounded-lg border border-border">
            <summary className="cursor-pointer px-3 py-3 text-sm font-medium">{t('teaching.documents.questionTitle', { id: item.question_id })}<span className="ml-2"><StatusChip tone="warning">{t('teaching.transcriptionStatus.uncertain')}</StatusChip></span></summary>
            <dl className="space-y-4 border-t border-border p-3">
              {fieldNames.map(field => {
                const value = item[field]
                const provenance = extraction.provenance.find(source => source.question_id === item.question_id && source.field === field)
                return <div key={field}>
                  <dt className="text-xs font-medium text-muted-foreground">{t(`teaching.documents.field.${field}`)}</dt>
                  <dd className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{value ?? t('teaching.documents.notFound')}</dd>
                  {provenance?.citations.map((citation, citationIndex) => {
                    const block = document?.blocks.find(original => original.block_id === citation.block_id)
                    return <blockquote key={citationIndex} className="mt-2 border-l-2 border-primary/30 bg-muted/40 px-3 py-2">
                      <a href={`#${sourceId(citation.block_id)}`} className="inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline" onClick={event => { event.preventDefault(); onCitation(citation.block_id) }}>{t('teaching.documents.sourceQuote', { location: block?.locator ?? citation.block_id })}<ArrowUpRight size={12} aria-hidden /></a>
                      <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5">{citation.quote}</p>
                    </blockquote>
                  })}
                </div>
              })}
            </dl>
          </details>)}
        </div>}
      </section>
    </div>
  )
}
