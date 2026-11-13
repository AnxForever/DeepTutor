export interface TeachingDraftScope { accountId: string; workspaceId: string }
export interface TeachingDraftRecord extends TeachingDraftScope {
  slot: string
  version: 1
  value: unknown
  updatedAt: number
  writeRevision?: number
}
export interface TeachingDraftRepository {
  read(scope: TeachingDraftScope): Promise<TeachingDraftRecord[]>
  write(scope: TeachingDraftScope, slot: string, value: unknown): Promise<void>
  clear(scope: TeachingDraftScope, slot: string): Promise<void>
}

type DraftKey = [string, string, string]
const keyOf = (scope: TeachingDraftScope, slot: string): DraftKey => [scope.accountId, scope.workspaceId, slot]
export class TeachingDraftConflict extends Error {
  constructor() { super('The local draft changed in another window. Export your edits before reloading.'); this.name = 'TeachingDraftConflict' }
}
type StoredDraft = TeachingDraftRecord & { deleted?: boolean }

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Draft storage unavailable')); return }
    const request = indexedDB.open('deeptutor-teaching-drafts', 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('drafts')
      store.createIndex('scope', ['accountId', 'workspaceId'])
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Draft storage blocked'))
  })
}

async function mutate(scope: TeachingDraftScope, slot: string, expected: { revision: number; exists: boolean }, value?: unknown): Promise<number> {
  const db = await database()
  try {
    return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite')
      const store = tx.objectStore('drafts')
      const get = store.get(keyOf(scope, slot))
      let failure: unknown
      let nextRevision = expected.revision
      get.onsuccess = () => {
        try {
          const current = get.result as StoredDraft | undefined
          if ((current?.writeRevision ?? 0) !== expected.revision || (current !== undefined) !== expected.exists) throw new TeachingDraftConflict()
          nextRevision = expected.revision + 1
          store.put({ ...scope, slot, version: 1, value, updatedAt: Date.now(), writeRevision: nextRevision, deleted: value === undefined } satisfies StoredDraft, keyOf(scope, slot))
        } catch (reason) { failure = reason; tx.abort() }
      }
      tx.oncomplete = () => resolve(nextRevision)
      tx.onerror = () => reject(failure ?? tx.error)
      tx.onabort = () => reject(failure ?? tx.error)
    })
  } finally { db.close() }
}

/** Each browser window tracks the versions it has actually read or committed. */
export function createTeachingDraftRepository(): TeachingDraftRepository {
  const queues = new Map<string, Promise<void>>()
  const epochs = new Map<string, number>()
  const seen = new Map<string, { revision: number; exists: boolean }>()
  function enqueue(key: string, operation: () => Promise<void>): Promise<void> {
    const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(operation)
    queues.set(key, next)
    void next.finally(() => { if (queues.get(key) === next) queues.delete(key) }).catch(() => {})
    return next
  }
  return {
  async read(scope) {
    const captured = { ...scope }
    await Promise.allSettled(Array.from(queues).filter(([key]) => { const parts = JSON.parse(key) as DraftKey; return parts[0] === captured.accountId && parts[1] === captured.workspaceId }).map(([, operation]) => operation))
    const db = await database()
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('drafts', 'readonly')
        const request = tx.objectStore('drafts').index('scope').getAll(IDBKeyRange.only([captured.accountId, captured.workspaceId]))
        tx.oncomplete = () => {
          const records = request.result as StoredDraft[]
          for (const record of records) if (record.writeRevision === undefined || (Number.isSafeInteger(record.writeRevision) && record.writeRevision >= 0)) seen.set(JSON.stringify(keyOf(captured, record.slot)), { revision: record.writeRevision ?? 0, exists: true })
          resolve(records.filter(record => !record.deleted))
        }
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    } finally { db.close() }
  },
  write(scope, slot, value) {
    const captured = { ...scope }
    const key = JSON.stringify(keyOf(scope, slot))
    const epoch = epochs.get(key) ?? 0
    // Capture data now, not after an asynchronous navigation changes the page.
    const snapshot: unknown = JSON.parse(JSON.stringify(value))
    return enqueue(key, async () => {
      if ((epochs.get(key) ?? 0) !== epoch) return
      const revision = await mutate(captured, slot, seen.get(key) ?? { revision: 0, exists: false }, snapshot)
      seen.set(key, { revision, exists: true })
    })
  },
  clear(scope, slot) {
    const captured = { ...scope }
    const key = JSON.stringify(keyOf(scope, slot))
    epochs.set(key, (epochs.get(key) ?? 0) + 1)
    return enqueue(key, async () => { seen.set(key, { revision: await mutate(captured, slot, seen.get(key) ?? { revision: 0, exists: false }), exists: true }) })
  },
  }
}

export const teachingDraftRepository = createTeachingDraftRepository()
