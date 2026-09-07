import { apiUrl, authenticatedHeaders } from './runtime'
import type { DocumentGeneration } from '../../../src/organizer/types'
export type { DocumentGeneration } from '../../../src/organizer/types'
import type { NoteFolder, NoteDocument, NotePage, NoteVersion, NoteDestination, NoteDelivery } from '../../../src/organizer/types'
export type { NoteFolder, NoteDocument, NoteSummary, NotePage, NoteVersion, NoteDestination, NoteDelivery } from '../../../src/organizer/types'

async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(apiUrl(`/v1${path}`), { method,
    headers: authenticatedHeaders(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload?.success) throw new Error(payload?.error || `Notes request failed (HTTP ${response.status}).`)
  return payload.data as T
}

export const notesApi = {
  folders: (signal?: AbortSignal) => request<NoteFolder[]>('/folders', 'GET', undefined, signal),
  createFolder: (name: string, parentId: string | null) => request<NoteFolder>('/folders', 'POST', { name, parentId }),
  updateFolder: (id: string, data: {name: string; parentId: string | null; revision: number}) => request<NoteFolder>(`/folders/${id}`, 'PATCH', data),
  deleteFolder: (id: string, revision: number) => request<null>(`/folders/${id}`, 'DELETE', { revision }),
  list: (query: Record<string, string>, signal?: AbortSignal) => request<NotePage>(`/documents?${new URLSearchParams(query)}`, 'GET', undefined, signal),
  get: (id: string, signal?: AbortSignal) => request<NoteDocument>(`/documents/${id}`, 'GET', undefined, signal),
  create: (data: {title: string; content: string; folderId: string | null; idempotencyKey: string}) => request<NoteDocument>('/documents', 'POST', data),
  update: (id: string, data: {title?: string; content?: string; folderId?: string | null; starred?: boolean; revision: number}) => request<NoteDocument>(`/documents/${id}`, 'PATCH', data),
  trash: (id: string, revision: number) => request<NoteDocument>(`/documents/${id}`, 'DELETE', { revision }),
  restore: (id: string, revision: number) => request<NoteDocument>(`/documents/${id}/restore`, 'POST', { revision }),
  purge: (id: string, revision: number) => request<null>(`/documents/${id}/purge`, 'POST', { revision, confirm: true }),
  versions: (id: string, offset = 0) => request<Omit<NoteVersion, 'content'>[]>(`/documents/${id}/versions?offset=${offset}`),
  version: (id: string, versionId: string) => request<NoteVersion>(`/documents/${id}/versions/${versionId}`),
  restoreVersion: (id: string, versionId: string, revision: number) => request<NoteDocument>(`/documents/${id}/versions/${versionId}/restore`, 'POST', { revision }),
  snapshot: (data: {recordingId: string; versionId: string | null; title: string; folderId: string | null}) => request<NoteDocument>('/documents/from-transcript', 'POST', data),
  saveGeneration: (id: string, folderId: string | null) => request<NoteDocument>(`/generations/${id}/save`, 'POST', { folderId }),
  destinations: () => request<NoteDestination[]>('/destinations'),
  deliveries: (id: string) => request<NoteDelivery[]>(`/documents/${id}/deliveries`),
  send: (id: string, destinationId: string, revision: number, idempotencyKey: string) => request<NoteDelivery>(`/documents/${id}/send`, 'POST', { destinationId, revision, confirm: true, idempotencyKey }),
}

export async function generateDocument(data: { idempotencyKey: string; recordingId: string; versionId: string | null; title: string; style: 'notes' | 'meeting' | 'brief'; instructions: string }, onProgress: (stage: string) => void, signal: AbortSignal): Promise<DocumentGeneration> {
  const response = await fetch(apiUrl('/v1/documents/generate'), { method: 'POST', headers: authenticatedHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(data), signal: AbortSignal.any([signal, AbortSignal.timeout(110000)]) })
  if (!response.ok || !response.body) { const payload = await response.json().catch(() => null); throw new Error(payload?.error || `Generation failed (HTTP ${response.status}).`) }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = '', result: DocumentGeneration | undefined
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += value
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
        const lines = event.split('\n'), type = lines.find(line => line.startsWith('event:'))?.slice(6).trim()
        const json = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!json) continue
        const payload = JSON.parse(json)
        if (type === 'error') throw new Error(payload.error)
        if (type === 'progress') onProgress(payload.stage)
        if (type === 'result') result = payload
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  if (!result) throw new Error('Generation connection ended before a document was received. Nothing was saved to Notes.')
  return result
}

export function folderPaths(folders: NoteFolder[]): {folder: NoteFolder; depth: number; path: string}[] {
  const children = new Map<string | null, NoteFolder[]>()
  for (const folder of folders) children.set(folder.parentId, [...(children.get(folder.parentId) || []), folder])
  const result: {folder: NoteFolder; depth: number; path: string}[] = []
  const visit = (parentId: string | null, path: string, depth: number) => {
    if (depth > 32) return
    for (const folder of children.get(parentId) || []) {
      const next = path ? `${path} / ${folder.name}` : folder.name
      result.push({ folder, depth, path: next }); visit(folder.id, next, depth + 1)
    }
  }
  visit(null, '', 0)
  return result
}
