import { requestJson } from '@/shared/api/client'
import { scopedUrl } from '@/lib/workspace-scope'
import type { components } from '@/contracts/generated/api'

/** A report carries this exact version, independently of later library edits. */
type Mutable<T> = { -readonly [Key in keyof T]: T[Key] }
export type RubricSnapshot = Mutable<components['schemas']['RubricSnapshot']>
export type RubricTemplate = Mutable<components['schemas']['RubricTemplate']>
export type SaveRubricRequest = Mutable<components['schemas']['SaveRubricRequest']>

const root = '/api/teaching-analysis/rubrics'

export function listTeachingRubrics(workspaceId: string, signal?: AbortSignal) {
  return requestJson<RubricTemplate[]>(scopedUrl(root, workspaceId), { cache: 'no-store', signal })
}

export function saveTeachingRubric(body: SaveRubricRequest, workspaceId: string, signal?: AbortSignal) {
  return requestJson<RubricTemplate>(scopedUrl(root, workspaceId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
}

export function listTeachingRubricRevisions(templateId: string, workspaceId: string, signal?: AbortSignal) {
  return requestJson<RubricTemplate[]>(scopedUrl(`${root}/${encodeURIComponent(templateId)}/revisions`, workspaceId), { cache: 'no-store', signal })
}

export function rubricSnapshot(template: RubricSnapshot): RubricSnapshot {
  return {
    template_id: template.template_id, revision: template.revision, name: template.name,
    subject: template.subject, grade: template.grade, criteria: template.criteria,
  }
}
