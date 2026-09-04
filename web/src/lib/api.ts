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
  summary?: string
  actionItems?: string[]
  speakers?: string[]
  segments?: TranscriptSegment[]
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
  transcriptionEngine: 'whisper' | 'groq' | 'deepgram'
  groqApiKey?: string
  deepgramApiKey?: string
  groqApiKeyConfigured?: boolean
  deepgramApiKeyConfigured?: boolean
  syncFolderPath: string
  autoTranscribe: boolean
  autoSummarize: boolean
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

interface ApiEnvelope<T> {
  success: boolean
  data: T
  error?: string
}

type RawSettings = Record<string, string | boolean | undefined>

interface RawTranscriptSegment {
  speaker?: number
  text?: string
  start?: number
  end?: number
}

interface RawTranscript {
  fullText?: string
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
}

interface RawStats {
  byStatus?: Partial<Record<Recording['status'], number>>
  totalDurationSeconds?: number
}

const BASE = '/api'

async function fetchJSON<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
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
        speaker: s.speaker !== undefined ? `Speaker ${s.speaker}` : 'Speaker',
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
    transcriptText: transcript?.fullText || undefined,
    summary: transcript?.summary ? (typeof transcript.summary === 'string' ? transcript.summary : transcript.summary.overview) : undefined,
    actionItems: transcript?.extractedTasks
      ?.map(item => typeof item === 'string' ? item : item.title)
      .filter((item): item is string => Boolean(item)),
    segments: segments.length > 0 ? segments : undefined,
  }
}

export const api = {
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
      transcriptionEngine: ['whisper', 'groq', 'deepgram'].includes(engine)
        ? engine as Settings['transcriptionEngine']
        : 'whisper',
      groqApiKey: typeof d.groqApiKey === 'string' ? d.groqApiKey : '',
      deepgramApiKey: typeof d.deepgramApiKey === 'string' ? d.deepgramApiKey : '',
      groqApiKeyConfigured: d.groqApiKeyConfigured === 'true' || d.groqApiKeyConfigured === true,
      deepgramApiKeyConfigured: d.deepgramApiKeyConfigured === 'true' || d.deepgramApiKeyConfigured === true,
      syncFolderPath: typeof d.syncFolderPath === 'string' ? d.syncFolderPath : '~/Documents/PlaudSync',
      autoTranscribe: d.autoTranscribe === 'true',
      autoSummarize: d.autoSummarize === 'true',
    }
  },

  updateSettings: async (settings: Partial<Settings>): Promise<Settings> => {
    await Promise.all(Object.entries(settings).map(([key, value]) => {
      if (value === undefined) return Promise.resolve()
      if ((key === 'groqApiKey' || key === 'deepgramApiKey') && value === '') return Promise.resolve()
      if (key.endsWith('Configured')) return Promise.resolve()
      return fetchJSON(`/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value: String(value) }) })
    }))
    return api.getSettings()
  },

  sync: async (): Promise<SyncResult> => {
    const res = await fetchJSON<ApiEnvelope<SyncResult>>('/recordings/sync', { method: 'POST' })
    return res.data
  },

  getAudioUrl: (id: string): string => `${BASE}/recordings/${id}/audio`,
}
