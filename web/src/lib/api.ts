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
  status: 'pending' | 'transcribing' | 'complete' | 'failed'
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

const BASE = '/api'

async function fetchJSON<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

/** Map backend recording shape to frontend Recording */
function mapRecording(r: any): Recording {
  const transcript = r.transcript
  const segments: TranscriptSegment[] = []
  if (transcript?.segments) {
    const segs = typeof transcript.segments === 'string' ? JSON.parse(transcript.segments) : transcript.segments
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
    status: r.status === 'complete' ? 'complete' : r.status,
    transcriptText: transcript?.fullText || undefined,
    summary: transcript?.summary ? (typeof transcript.summary === 'string' ? transcript.summary : transcript.summary.overview) : undefined,
    actionItems: transcript?.extractedTasks ? (Array.isArray(transcript.extractedTasks) ? transcript.extractedTasks : []) : undefined,
    segments: segments.length > 0 ? segments : undefined,
  }
}

export const api = {
  getStats: async (): Promise<DashboardStats> => {
    const res = await fetchJSON<any>('/recordings/stats/summary')
    const d = res.data || res
    const byStatus = d.byStatus || {}
    return {
      totalRecordings: Object.values(byStatus).reduce((a: number, b: any) => a + Number(b), 0) as number,
      totalHours: (d.totalDurationSeconds || 0) / 3600,
      transcribedCount: byStatus.complete || 0,
      pendingCount: (byStatus.pending || 0) + (byStatus.transcribing || 0),
    }
  },

  getRecordings: async (params?: Record<string, string>): Promise<Recording[]> => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '?limit=100'
    const res = await fetchJSON<any>(`/recordings${qs}`)
    return (res.data || []).map(mapRecording)
  },

  getRecording: async (id: string): Promise<Recording> => {
    const res = await fetchJSON<any>(`/recordings/${id}`)
    return mapRecording(res.data || res)
  },

  transcribe: async (id: string): Promise<Recording> => {
    const res = await fetchJSON<any>(`/recordings/${id}/reprocess`, { method: 'POST' })
    return mapRecording(res.data || res)
  },

  summarize: async (id: string): Promise<Recording> => {
    const res = await fetchJSON<any>(`/recordings/${id}/analyze`, { method: 'POST' })
    return mapRecording(res.data || res)
  },

  search: async (query: string): Promise<SearchResult[]> => {
    const res = await fetchJSON<any>(`/search?q=${encodeURIComponent(query)}`)
    return res.data || []
  },

  getSettings: async (): Promise<Settings> => {
    const res = await fetchJSON<any>('/settings')
    const d = res.data || {}
    return {
      transcriptionEngine: (d.transcriptionEngine as any) || 'whisper',
      groqApiKey: d.groqApiKey || '',
      deepgramApiKey: d.deepgramApiKey || '',
      syncFolderPath: d.syncFolderPath || '~/Documents/PlaudSync',
      autoTranscribe: d.autoTranscribe === 'true' || d.autoTranscribe === true,
      autoSummarize: d.autoSummarize === 'true' || d.autoSummarize === true,
    }
  },

  updateSettings: async (settings: Partial<Settings>): Promise<Settings> => {
    // Save each setting individually
    for (const [key, value] of Object.entries(settings)) {
      if (value !== undefined) {
        await fetchJSON(`/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value: String(value) }) })
      }
    }
    return api.getSettings()
  },

  sync: async (): Promise<{ synced: number }> => {
    const res = await fetchJSON<any>('/recordings/sync', { method: 'POST' })
    return { synced: res.data?.added || 0 }
  },

  getAudioUrl: (id: string): string => `${BASE}/recordings/${id}/audio`,
}
