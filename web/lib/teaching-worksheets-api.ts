import { requestBlob } from '@/shared/api/client'
import { scopedUrl } from '@/lib/workspace-scope'

export function fetchTeachingWorksheet(id: string, revision: number, audience: 'student' | 'teacher', format: 'html' | 'markdown', language: 'zh' | 'en', workspaceId: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ revision: String(revision), audience, format, language })
  return requestBlob(scopedUrl(`/api/teaching-analysis/followups/${encodeURIComponent(id)}/worksheet?${query}`, workspaceId), { cache: 'no-store', signal })
}
