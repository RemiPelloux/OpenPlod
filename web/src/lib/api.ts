export interface Recording {
  id: string
  title: string
  filename: string
  filePath: string
  duration: number
  fileSize: number
  recordingType: string
  context: string | null
  recordedAt: string
  createdAt: string
  status: 'pending' | 'transcribing' | 'summarizing' | 'complete' | 'failed'
  transcriptText?: string
  transcriptOrigin?: 'generated' | 'edited'
  transcriptVersionId?: string | null
  summary?: string
  actionItems?: string[]
  speakers?: string[]
  segments?: TranscriptSegment[]
  sourceProvider?: string | null
  sourceRecordingId?: string | null
  sourceTransport?: string | null
  fingerprint?: string | null
  retentionState: 'active' | 'trash'
  deletedAt?: string | null
  revision: number
  notes?: string | null
  tags: string[]
  forwardingStatus: string
  forwardingRunId?: string | null
  forwardingError?: string | null
}

export interface TranscriptSegment {
  id: string
  speaker: string
  text: string
  startTime: number
  endTime: number
}

export interface SearchResult {
  recordingId: string
  recordingTitle: string
  recordedAt: string
  segments: TranscriptSegment[]
}

export interface Settings {
  transcriptionEngine: 'whisper' | 'mistral' | 'deepgram'
  mistralApiKey?: string
  deepgramApiKey?: string
  mistralApiKeyConfigured?: boolean
  deepgramApiKeyConfigured?: boolean
  syncFolderPath: string
  autoTranscribe: boolean
  autoSummarize: boolean
  autoImport: boolean
  plaudRecordingTypes: string[]
  deleteSourceAfterImport: boolean
  openWhistleForwarding: boolean
  openWhistleBaseUrl: string
  openWhistleApiKey?: string
  openWhistleApiKeyConfigured?: boolean
  openWhistleAgentId: string
}

export interface TranscriptVersion {
  segments?: string | { start: number; end: number; text: string; speaker?: number | string }[] | null
  id: string
  recordingId: string
  fullText: string
  origin: 'generated' | 'edited'
  createdAt: string
}

export interface TranscriptDocument {
  recordingId: string
  filename: string | null
  recordedAt: string
  sourceProvider: string | null
  durationSeconds: number | null
  wordCount: number | null
  excerpt: string
}

export interface UploadAcknowledgement {
  recordingId: string
  added: boolean
}

export interface DashboardStats {
  totalRecordings: number
  totalHours: number
  transcribedCount: number
  pendingCount: number
}

export interface SyncResult {
  added: number
  skipped: number
  errors: string[]
}

export interface PlaudStatus {
  deviceDetected: boolean
  deviceName: string | null
  detail: string
  transferAvailable: boolean
  folderAvailable: boolean
  connectionVerified: boolean
  directTransferAvailable: boolean
  recordingListState: 'unavailable'
  deviceRecordingCount: number | null
  syncPath: string | null
}

export interface AvailableRecording {
  filename: string
  path: string
  size: number
  modifiedAt: string
  durationMs: number | null
  fingerprint: string
  imported: boolean
  recordingId: string | null
  retentionState: string | null
}

export interface DeviceRecording {
  sessionId: number
  size: number
  scene: number
  timezone: number
  recordingId: string | null
  retentionState: string | null
}

interface ApiEnvelope<T> {
  success: boolean
  data: T
  error?: string
}

type RawSettings = Record<string, string | boolean | undefined>

interface RawTranscriptSegment {
  speaker?: number | string
  text?: string
  start?: number
  end?: number
}

interface RawTranscript {
  fullText?: string
  origin?: 'generated' | 'edited'
  currentVersionId?: string | null
  segments?: RawTranscriptSegment[] | string
  summary?: { overview?: string } | string
  extractedTasks?: Array<string | { title?: string }>
}

interface RawRecording {
  id: string
  originalFilename?: string | null
  filePath?: string | null
  durationSeconds?: number | null
  fileSizeBytes?: number | null
  recordingType?: string | null
  context?: string | null
  recordedAt?: string | null
  uploadedAt?: string | null
  status?: Recording['status']
  transcript?: RawTranscript | null
  sourceProvider?: string | null
  sourceRecordingId?: string | null
  sourceTransport?: string | null
  fingerprint?: string | null
  retentionState?: 'active' | 'trash'
  deletedAt?: string | null
  revision?: number
  notes?: string | null
  tags?: string[] | string | null
  forwardingStatus?: string
  forwardingRunId?: string | null
  forwardingError?: string | null
}

interface RawStats {
  byStatus?: Partial<Record<Recording['status'], number>>
  totalDurationSeconds?: number
}

async function fetchJSON<T>(url: string, opts?: RequestInit): Promise<T> {
  const headers = authenticatedHeaders(opts?.headers)
  if (!(opts?.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  const res = await fetch(apiUrl(url), { ...opts, headers })
  const payload = await res.json().catch(() => null) as { error?: string } | null
  if (!res.ok) throw new Error(payload?.error || `API error: ${res.status}`)
  return payload as T
}

/** Map backend recording shape to frontend Recording */
function mapRecording(r: RawRecording): Recording {
  const transcript = r.transcript
  const segments: TranscriptSegment[] = []
  if (transcript?.segments) {
    let segs: RawTranscriptSegment[] = []
    try {
      const parsed = typeof transcript.segments === 'string' ? JSON.parse(transcript.segments) : transcript.segments
      segs = Array.isArray(parsed) ? parsed : []
    } catch {
      segs = []
    }
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]
      segments.push({
        id: `s${i}`,
        speaker: typeof s.speaker === 'string' ? s.speaker : s.speaker !== undefined ? `Speaker ${s.speaker}` : 'Speaker',
        text: s.text || '',
        startTime: s.start || 0,
        endTime: s.end || 0,
      })
    }
  }

  return {
    id: r.id,
    title: r.originalFilename?.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ') || 'Untitled',
    filename: r.originalFilename || '',
    filePath: r.filePath || '',
    duration: r.durationSeconds || 0,
    fileSize: r.fileSizeBytes || 0,
    recordingType: r.recordingType || 'other',
    context: r.context || null,
    recordedAt: r.recordedAt || r.uploadedAt || '',
    createdAt: r.uploadedAt || '',
    status: r.status || 'pending',
    transcriptText: transcript?.fullText,
    transcriptOrigin: transcript?.origin,
    transcriptVersionId: transcript?.currentVersionId,
    summary: transcript?.summary ? (typeof transcript.summary === 'string' ? transcript.summary : transcript.summary.overview) : undefined,
    actionItems: transcript?.extractedTasks
      ?.map(item => typeof item === 'string' ? item : item.title)
      .filter((item): item is string => Boolean(item)),
    segments: segments.length > 0 ? segments : undefined,
    sourceProvider: r.sourceProvider,
    sourceRecordingId: r.sourceRecordingId,
    sourceTransport: r.sourceTransport,
    fingerprint: r.fingerprint,
    retentionState: r.retentionState ?? 'active',
    deletedAt: r.deletedAt,
    revision: r.revision ?? 1,
    notes: r.notes,
    tags: parseTags(r.tags),
    forwardingStatus: r.forwardingStatus ?? 'not_configured',
    forwardingRunId: r.forwardingRunId,
    forwardingError: r.forwardingError,
  }
}

export const api = {
  getTranscriptDocuments: async (options: { source: string; offset: number; signal?: AbortSignal }) => {
    const query = new URLSearchParams({ source: options.source, offset: String(options.offset) })
    return fetchJSON<ApiEnvelope<TranscriptDocument[]> & { pagination: { hasMore: boolean } }>(`/transcripts?${query}`, { signal: options.signal })
  },
  getStats: async (): Promise<DashboardStats> => {
    const res = await fetchJSON<ApiEnvelope<RawStats>>('/recordings/stats/summary')
    const d = res.data
    const byStatus = d.byStatus || {}
    return {
      totalRecordings: Object.values(byStatus).reduce((total, count) => total + Number(count), 0),
      totalHours: (d.totalDurationSeconds || 0) / 3600,
      transcribedCount: byStatus.complete || 0,
      pendingCount: (byStatus.pending || 0) + (byStatus.transcribing || 0),
    }
  },

  getRecordings: async (params?: Record<string, string>): Promise<Recording[]> => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '?limit=100'
    const res = await fetchJSON<ApiEnvelope<RawRecording[]>>(`/recordings${qs}`)
    return res.data.map(mapRecording)
  },

  getRecording: async (id: string): Promise<Recording> => {
    const res = await fetchJSON<ApiEnvelope<RawRecording>>(`/recordings/${id}`)
    return mapRecording(res.data)
  },

  transcribe: async (id: string): Promise<void> => {
    await fetchJSON(`/recordings/${id}/reprocess`, { method: 'POST' })
  },

  summarize: async (id: string): Promise<void> => {
    await fetchJSON(`/recordings/${id}/analyze`, { method: 'POST' })
  },

  search: async (query: string, signal?: AbortSignal): Promise<SearchResult[]> => {
    const res = await fetchJSON<ApiEnvelope<SearchResult[]>>(`/search?q=${encodeURIComponent(query)}`, { signal })
    return res.data
  },

  getSettings: async (): Promise<Settings> => {
    const res = await fetchJSON<ApiEnvelope<RawSettings>>('/settings')
    const d = res.data
    const engine = typeof d.transcriptionEngine === 'string' ? d.transcriptionEngine : ''
    return {
      transcriptionEngine: ['whisper', 'mistral', 'deepgram'].includes(engine)
        ? engine as Settings['transcriptionEngine']
        : 'whisper',
      mistralApiKey: typeof d.mistralApiKey === 'string' ? d.mistralApiKey : '',
      deepgramApiKey: typeof d.deepgramApiKey === 'string' ? d.deepgramApiKey : '',
      mistralApiKeyConfigured: d.mistralApiKeyConfigured === 'true' || d.mistralApiKeyConfigured === true,
      deepgramApiKeyConfigured: d.deepgramApiKeyConfigured === 'true' || d.deepgramApiKeyConfigured === true,
      syncFolderPath: typeof d.syncFolderPath === 'string' ? d.syncFolderPath : '~/Documents/PlaudSync',
      autoTranscribe: d.autoTranscribe === 'true',
      autoSummarize: d.autoSummarize === 'true',
      autoImport: d.autoImport === 'true',
      plaudRecordingTypes: parseRecordingTypes(d.plaudRecordingTypes),
      deleteSourceAfterImport: d.deleteSourceAfterImport === 'true',
      openWhistleForwarding: d.openWhistleForwarding === 'true',
      openWhistleBaseUrl: typeof d.openWhistleBaseUrl === 'string' ? d.openWhistleBaseUrl : '',
      openWhistleApiKeyConfigured: d.openWhistleApiKeyConfigured === 'true' || d.openWhistleApiKeyConfigured === true,
      openWhistleAgentId: typeof d.openWhistleAgentId === 'string' ? d.openWhistleAgentId : '',
    }
  },

  updateSettings: async (settings: Partial<Settings>): Promise<Settings> => {
    await Promise.all(Object.entries(settings).map(([key, value]) => {
      if (value === undefined) return Promise.resolve()
      if ((key === 'mistralApiKey' || key === 'deepgramApiKey' || key === 'openWhistleApiKey') && value === '') return Promise.resolve()
      if (key.endsWith('Configured')) return Promise.resolve()
      const serialized = Array.isArray(value) ? JSON.stringify(value) : String(value)
      return fetchJSON(`/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value: serialized }) })
    }))
    return api.getSettings()
  },

  sync: async (): Promise<SyncResult> => {
    const res = await fetchJSON<ApiEnvelope<SyncResult>>('/recordings/sync', { method: 'POST' })
    return res.data
  },

  getPlaudStatus: async (signal?: AbortSignal): Promise<PlaudStatus> => {
    const res = await fetchJSON<ApiEnvelope<PlaudStatus>>('/plaud/status', { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000) })
    return res.data
  },

  getDeviceRecordings: async (signal?: AbortSignal): Promise<DeviceRecording[]> => {
    const res = await fetchJSON<ApiEnvelope<DeviceRecording[]>>('/plaud/device-recordings', { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(150000)]) : AbortSignal.timeout(150000) })
    return res.data
  },
  importDeviceRecording: async (sessionId: number, signal?: AbortSignal): Promise<string> => {
    const start = await fetchJSON<ApiEnvelope<{ id: string }>>('/plaud/device-import', {
      method: 'POST', body: JSON.stringify({ sessionId, confirm: true }), signal,
    })
    const deadline = Date.now() + 480000
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      const job = await fetchJSON<ApiEnvelope<{ state: string; error?: string; result?: { recording: { id: string } } }>>(`/plaud/device-import/${start.data.id}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) })
      if (job.data.state === 'failed') throw new Error(job.data.error || 'Plaud import failed')
      if (job.data.state === 'complete' && job.data.result) return job.data.result.recording.id
      await new Promise(resolve => window.setTimeout(resolve, 1000))
    }
    throw new Error('Import status timed out. Check the library before retrying.')
  },
  cancelDeviceOperation: () => fetchJSON('/plaud/device-cancel', { method: 'POST', signal: AbortSignal.timeout(10000) }),

  getAvailableRecordings: async (): Promise<AvailableRecording[]> => {
    const res = await fetchJSON<ApiEnvelope<AvailableRecording[]>>('/plaud/available-recordings')
    return res.data
  },

  importRecordings: async (paths: string[]): Promise<void> => {
    await fetchJSON('/recordings/import', { method: 'POST', body: JSON.stringify({ paths }) })
  },

  uploadRecording: async (
    file: File,
    fromMobile: boolean,
    metadata?: {
      recordedAt?: string
      context?: string
      recordingType?: string
      sourceProvider?: 'opennotes' | 'plaud' | 'upload'
      sourceTransport?: 'mobile' | 'upload'
      sourceRecordingId?: string
      durationMs?: number
    },
  ): Promise<UploadAcknowledgement> => {
    const body = new FormData()
    body.append('file', file)
    body.append('source_provider', metadata?.sourceProvider ?? (fromMobile ? 'opennotes' : 'upload'))
    body.append('source_transport', metadata?.sourceTransport ?? (fromMobile ? 'mobile' : 'upload'))
    body.append('recorded_at', metadata?.recordedAt ?? new Date().toISOString())
    if (metadata?.sourceRecordingId) body.append('source_recording_id', metadata.sourceRecordingId)
    if (metadata?.context) body.append('context', metadata.context)
    if (metadata?.recordingType) body.append('recording_type', metadata.recordingType)
    if (metadata?.durationMs !== undefined) body.append('duration_ms', String(metadata.durationMs))
    if (fromMobile) {
      const res = await fetchJSON<ApiEnvelope<UploadAcknowledgement>>('/mobile/recordings', { method: 'POST', body })
      return res.data
    }
    const res = await fetchJSON<ApiEnvelope<Array<{ recording: { id: string }; added: boolean }>>>('/recordings/import', { method: 'POST', body })
    const imported = res.data[0]
    if (!imported) throw new Error('The vault did not acknowledge the recording.')
    return { recordingId: imported.recording.id, added: imported.added }
  },

  updateRecording: async (id: string, patch: Partial<Pick<Recording, 'title' | 'recordedAt' | 'recordingType' | 'context' | 'notes' | 'tags'>> & { revision: number }): Promise<Recording> => {
    const res = await fetchJSON<ApiEnvelope<RawRecording>>(`/recordings/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
    return mapRecording(res.data)
  },

  updateTranscript: async (id: string, fullText: string, revision: number, segments?: { start: number; end: number; text: string; speaker?: number | string }[]): Promise<void> => {
    await fetchJSON(`/recordings/${id}/transcript`, { method: 'PATCH', body: JSON.stringify({ fullText, revision, segments }) })
  },

  getTranscriptVersions: async (id: string): Promise<TranscriptVersion[]> => {
    const res = await fetchJSON<ApiEnvelope<TranscriptVersion[]>>(`/recordings/${id}/transcript/versions`)
    return res.data
  },

  replaceAudio: async (id: string, file: File, revision: number): Promise<void> => {
    const body = new FormData()
    body.append('file', file)
    body.append('revision', String(revision))
    const res = await fetch(apiUrl(`/recordings/${id}/replace-audio`), {
      method: 'POST',
      body,
      headers: authenticatedHeaders(),
    })
    const payload = await res.json().catch(() => null) as { error?: string } | null
    if (!res.ok) throw new Error(payload?.error || `API error: ${res.status}`)
  },

  trashRecording: async (id: string): Promise<void> => {
    await fetchJSON(`/recordings/${id}`, { method: 'DELETE' })
  },

  restoreRecording: async (id: string): Promise<void> => {
    await fetchJSON(`/recordings/${id}/restore`, { method: 'POST' })
  },

  purgeRecording: async (id: string): Promise<void> => {
    await fetchJSON(`/recordings/${id}?permanent=true&confirm=true`, { method: 'DELETE' })
  },

  forwardRecording: async (id: string): Promise<string> => {
    const res = await fetchJSON<ApiEnvelope<{ runId: string }>>(`/recordings/${id}/forward`, { method: 'POST' })
    return res.data.runId
  },

  getAudioBlob: async (id: string, signal?: AbortSignal): Promise<Blob> => {
    const timeout = AbortSignal.timeout(30000)
    const res = await fetch(apiUrl(`/recordings/${id}/audio`), { headers: authenticatedHeaders(), signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    if (!res.ok) throw new Error(`Could not load audio: ${res.status}`)
    return res.blob()
  },

  getAudioObjectUrl: async (id: string): Promise<string> => {
    return URL.createObjectURL(await api.getAudioBlob(id))
  },
}

function parseTags(value: RawRecording['tags']): string[] {
  if (Array.isArray(value)) return value.filter(tag => typeof tag === 'string')
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(tag => typeof tag === 'string') : []
  } catch {
    return []
  }
}

function parseRecordingTypes(value: RawSettings[string]): string[] {
  const defaults = ['class', 'meeting', 'conversation', 'other']
  if (typeof value !== 'string') return defaults
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter(item => defaults.includes(item))
      : defaults
  } catch {
    return defaults
  }
}
import { apiUrl, authenticatedHeaders } from '@/lib/runtime'
