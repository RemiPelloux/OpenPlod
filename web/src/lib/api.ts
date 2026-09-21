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

export interface TranscriptWord {
  start: number
  end: number
  text: string
}

export interface TranscriptSegment {
  id: string
  speaker: string
  text: string
  startTime: number
  endTime: number
  /** Real per-word timings, or null when the provider supplied none. */
  words?: TranscriptWord[] | null
}

// ---------------------------------------------------------------------------
// Transcript Studio (roadmap TS-02..TS-06, TS-09)
// ---------------------------------------------------------------------------

/** One editing operation the transcript editor can apply. */
export type TranscriptOperation =
  | { op: 'rename-speaker'; from: number | string; to: number | string }
  | { op: 'merge-speakers'; sources: (number | string)[]; target: number | string }
  | { op: 'split-segment'; index: number; offset: number }
  | { op: 'merge-segments'; start: number; count: number }
  | { op: 'replace'; search: string; replacement: string; matchCase?: boolean; wholeWord?: boolean; speaker?: number | string | null }

export interface StudioSegment {
  start: number
  end: number
  text: string
  speaker?: number | string | null
  confidence?: number | null
}

export interface OperationResult {
  preview: boolean
  fullText: string
  segments: StudioSegment[]
  summaries: string[]
  speakers: (number | string)[]
}

export interface DiffPart { op: 'equal' | 'insert' | 'delete'; text: string }
export interface TranscriptDiff {
  parts: DiffPart[]
  stats: { inserted: number; deleted: number; unchanged: number; identical: boolean }
  granularity: 'word' | 'line' | 'block'
}

export interface VersionComparison {
  before: { versionId: string; origin: string; createdAt: string; provenance: Record<string, unknown> | null }
  after: { versionId: string; origin: string; createdAt: string; provenance: Record<string, unknown> | null }
  diff: TranscriptDiff
  changeKind: 'manual-correction' | 'regeneration' | 'manual-revision' | 'reverted-to-generated'
}

export interface CleanupProposal {
  text: string
  diff: TranscriptDiff
  provider: string
  model: string
  usage: Record<string, number> | null
  sourceHash: string
}

export interface TranslationProposal {
  text: string
  targetLanguage: string
  provider: string
  model: string
  sourceHash: string
}

export interface TimedItem { text: string; startSeconds: number | null; segmentIndex: number | null }
export interface StructureChapter extends TimedItem { title: string }
export interface StructureAction extends TimedItem { owner: string | null; due: string | null }

export interface TranscriptStructure {
  chapters: StructureChapter[]
  decisions: TimedItem[]
  actionItems: StructureAction[]
  openQuestions: TimedItem[]
  provider: string
  model: string
  timestampsAvailable: boolean
}

/** Whether a transcript can honestly be exported as subtitles. */
export interface SubtitleReadiness {
  exportable: boolean
  reason: 'no-segments' | 'no-timing' | 'invalid-timing' | 'empty-text' | null
  detail: string
  cueCount: number
  formats: string[]
}

export interface TranscriptVersionRow {
  id: string
  recordingId: string
  fullText: string
  origin: string
  provenance: Record<string, unknown> | null
  createdAt: string
}

/** A saved, reusable AI instruction (roadmap TS-08). */
export interface CustomAction {
  id: string
  name: string
  instruction: string
  description: string
  createdAt: string
}

export interface CustomActionResult {
  actionId: string
  actionName: string
  text: string
  provider: string
  model: string
  sourceHash: string
}

/** Batch transcription (roadmap TS-10). */
export interface BatchItem {
  recordingId: string
  state: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled'
  error?: string
}

export interface BatchJob {
  id: string
  kind: 'transcribe' | 'document'
  items: BatchItem[]
  createdAt: string
  cancelledAt: string | null
  active: boolean
  summary: { total: number; pending: number; running: number; complete: number; failed: number; cancelled: number }
}

export interface BatchEstimate {
  recordings: number
  wouldRun: number
  usesCloudProvider: boolean
  provider: string | null
  /** Always null: providers price per second or per token, so a figure here would be invented. */
  estimatedCost: null
}

export interface SearchResult {
  recordingId: string
  recordingTitle: string
  recordedAt: string
  segments: TranscriptSegment[]
}

export interface Settings {
  transcriptionEngine: 'whisper' | 'mistral' | 'deepgram' | 'openai' | 'assemblyai'
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
  provenance?: { provider?: string; model?: string; fingerprint?: string; startedAt?: string; completedAt?: string; usage?: Record<string, number> | null; options?: Record<string, unknown> } | null
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
  deviceIdentifier: string | null
  deviceSerial: string | null
  protocolVersion: number | null
  /** Host operating system the vault service runs on. */
  platform: string
  /** Bluetooth stack in use: `corebluetooth`, `bluez` or `winrt`. */
  bluetoothBackend: string | null
  /** True when every host precondition for direct transfer is satisfied. */
  bluetoothReady: boolean
  environmentBlockers: { id: string; label: string; detail: string; remediation: string | null }[]
}

/** One autodetected host precondition for direct Bluetooth transfer. */
export interface EnvironmentCheck {
  id: 'platform' | 'bridge' | 'adapter' | 'audio-tools' | 'identity'
  label: string
  ok: boolean
  detail: string
  remediation: string | null
  actionable: boolean
}

/** What this computer can do, autodetected rather than assumed. */
export interface PlaudEnvironment {
  platform: string
  arch: string
  osRelease: string
  backend: string | null
  bridgeBackend: 'native' | 'swift'
  bridgePath: string | null
  adapter: string | null
  checks: EnvironmentCheck[]
  ready: boolean
  blockers: EnvironmentCheck[]
  checkedAt: string
}

/** State of the recorder's local authorization (`plaud-device.json`). */
export interface PlaudIdentityStatus {
  authorized: boolean
  serial: string | null
  identifier: string | null
  deviceType: string | null
  developerCredentialsAvailable: boolean
  domains: string[]
  identityPath: string
}

/** One recording listed from the Plaud cloud account. */
export interface PlaudCloudRecordingSummary {
  id: string
  filename: string
  recordedAt: string
  durationMs: number
  sizeBytes: number
  serial: string | null
  isTrash: boolean
  hasTranscript: boolean
  hasSummary: boolean
  imported: boolean
  recordingId: string | null
}

/** Account + recording list from the cloud, without touching Bluetooth. */
export interface PlaudCloudStatus {
  linked: boolean
  account: { userId: string; workspaceId: string; region: string; expiresAt: number | null } | null
  domain: string | null
  recordings: PlaudCloudRecordingSummary[]
  totals: { count: number; bytes: number; trashCount: number; importedCount: number }
}

export interface PlaudCloudImportJob {
  id: string
  state: 'running' | 'complete' | 'failed' | 'cancelled'
  total: number
  completed: number
  totalBytes: number
  receivedBytes: number
  current: string | null
  imported: { sourceId: string; recordingId: string; title: string; added: boolean }[]
  failures: { sourceId: string; title: string; error: string }[]
  transcripts: number
  summaries: number
  transcriptFailures: { sourceId: string; title: string; error: string }[]
  error?: string
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
  /** Unvalidated per-word timings from the provider; checked before use. */
  words?: unknown
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
        // Only real per-word timings survive; anything malformed is dropped so
        // the player falls back to segment following rather than guessing.
        words: Array.isArray(s.words)
          ? (s.words as unknown[])
            .filter((w): w is { start: number; end: number; text: string } => {
              const word = w as { start?: unknown; end?: unknown; text?: unknown } | null
              return typeof word?.start === 'number' && typeof word.end === 'number'
                && typeof word.text === 'string' && Number.isFinite(word.start) && Number.isFinite(word.end)
                && word.start >= 0 && word.end > word.start
            })
            .map(w => ({ start: w.start, end: w.end, text: w.text }))
          : null,
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

  transcribe: async (id: string, options?: Record<string, unknown>): Promise<void> => {
    await fetchJSON(`/recordings/${id}/reprocess`, { method: 'POST', ...(options ? { body: JSON.stringify(options) } : {}) })
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
      transcriptionEngine: ['whisper', 'mistral', 'deepgram', 'openai', 'assemblyai'].includes(engine)
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

  // --- Custom AI actions (TS-08) and batches (TS-10) ---------------------

  listCustomActions: async (): Promise<CustomAction[]> => {
    const res = await fetchJSON<ApiEnvelope<CustomAction[]>>('/recordings/custom-actions', { signal: AbortSignal.timeout(20000) })
    return res.data
  },

  createCustomAction: async (input: { name: string; instruction: string; description?: string }): Promise<CustomAction> => {
    const res = await fetchJSON<ApiEnvelope<CustomAction>>('/recordings/custom-actions', {
      method: 'POST', body: JSON.stringify(input), signal: AbortSignal.timeout(20000),
    })
    return res.data
  },

  deleteCustomAction: async (actionId: string): Promise<void> => {
    await fetchJSON<ApiEnvelope<unknown>>(`/recordings/custom-actions/${encodeURIComponent(actionId)}`, {
      method: 'DELETE', signal: AbortSignal.timeout(20000),
    })
  },

  runCustomAction: async (id: string, actionId: string): Promise<CustomActionResult> => {
    const res = await fetchJSON<ApiEnvelope<CustomActionResult>>(
      `/recordings/${id}/transcript/custom-actions/${encodeURIComponent(actionId)}`,
      { method: 'POST', body: JSON.stringify({}), signal: AbortSignal.timeout(180000) })
    return res.data
  },

  estimateBatch: async (recordingIds: string[]): Promise<BatchEstimate> => {
    const res = await fetchJSON<ApiEnvelope<BatchEstimate>>('/recordings/batch/estimate', {
      method: 'POST', body: JSON.stringify({ recordingIds }), signal: AbortSignal.timeout(20000),
    })
    return res.data
  },

  startBatch: async (recordingIds: string[], options: { retryOf?: string } = {}): Promise<BatchJob> => {
    const res = await fetchJSON<ApiEnvelope<BatchJob>>('/recordings/batch', {
      method: 'POST', body: JSON.stringify({ recordingIds, confirm: true, ...options }), signal: AbortSignal.timeout(30000),
    })
    return res.data
  },

  getBatch: async (batchId: string): Promise<BatchJob> => {
    const res = await fetchJSON<ApiEnvelope<BatchJob>>(`/recordings/batch/${encodeURIComponent(batchId)}`, { signal: AbortSignal.timeout(20000) })
    return res.data
  },

  cancelBatch: async (batchId: string): Promise<void> => {
    await fetchJSON<ApiEnvelope<unknown>>(`/recordings/batch/${encodeURIComponent(batchId)}/cancel`, {
      method: 'POST', body: JSON.stringify({}), signal: AbortSignal.timeout(20000),
    })
  },

  // --- Transcript Studio -------------------------------------------------

  transcriptOperations: async (id: string, operations: TranscriptOperation[], options: { preview?: boolean; revision?: number } = {}): Promise<OperationResult> => {
    const res = await fetchJSON<ApiEnvelope<OperationResult>>(`/recordings/${id}/transcript/operations`, {
      method: 'POST', body: JSON.stringify({ operations, ...options }), signal: AbortSignal.timeout(30000),
    })
    return res.data
  },

  transcriptVersions: async (id: string): Promise<TranscriptVersionRow[]> => {
    const res = await fetchJSON<ApiEnvelope<TranscriptVersionRow[]>>(`/recordings/${id}/transcript/versions`, { signal: AbortSignal.timeout(20000) })
    return res.data
  },

  compareTranscriptVersions: async (id: string, before: string, after: string): Promise<VersionComparison> => {
    const res = await fetchJSON<ApiEnvelope<VersionComparison>>(
      `/recordings/${id}/transcript/compare?before=${encodeURIComponent(before)}&after=${encodeURIComponent(after)}`,
      { signal: AbortSignal.timeout(30000) })
    return res.data
  },

  promoteTranscriptVersion: async (id: string, versionId: string, revision?: number): Promise<void> => {
    await fetchJSON<ApiEnvelope<unknown>>(`/recordings/${id}/transcript/versions/${encodeURIComponent(versionId)}/promote`, {
      method: 'POST', body: JSON.stringify({ revision }), signal: AbortSignal.timeout(20000),
    })
  },

  proposeCleanup: async (id: string, options: { punctuation?: boolean; paragraphs?: boolean; removeFillers?: boolean; headings?: boolean }): Promise<CleanupProposal> => {
    const res = await fetchJSON<ApiEnvelope<CleanupProposal>>(`/recordings/${id}/transcript/cleanup`, {
      method: 'POST', body: JSON.stringify(options), signal: AbortSignal.timeout(180000),
    })
    return res.data
  },

  saveCleanup: async (id: string, text: string, sourceHash: string, revision?: number): Promise<void> => {
    await fetchJSON<ApiEnvelope<unknown>>(`/recordings/${id}/transcript/cleanup/save`, {
      method: 'POST', body: JSON.stringify({ text, sourceHash, revision }), signal: AbortSignal.timeout(30000),
    })
  },

  proposeTranslation: async (id: string, targetLanguage: string): Promise<TranslationProposal> => {
    const res = await fetchJSON<ApiEnvelope<TranslationProposal>>(`/recordings/${id}/transcript/translate`, {
      method: 'POST', body: JSON.stringify({ targetLanguage }), signal: AbortSignal.timeout(180000),
    })
    return res.data
  },

  saveTranslation: async (id: string, text: string, targetLanguage: string, sourceHash: string): Promise<void> => {
    await fetchJSON<ApiEnvelope<unknown>>(`/recordings/${id}/transcript/translate/save`, {
      method: 'POST', body: JSON.stringify({ text, targetLanguage, sourceHash }), signal: AbortSignal.timeout(30000),
    })
  },

  extractStructure: async (id: string): Promise<TranscriptStructure> => {
    const res = await fetchJSON<ApiEnvelope<TranscriptStructure>>(`/recordings/${id}/transcript/structure`, {
      method: 'POST', body: JSON.stringify({}), signal: AbortSignal.timeout(180000),
    })
    return res.data
  },

  subtitleReadiness: async (id: string): Promise<SubtitleReadiness> => {
    const res = await fetchJSON<ApiEnvelope<SubtitleReadiness>>(`/recordings/${id}/transcript/subtitles`, { signal: AbortSignal.timeout(20000) })
    return res.data
  },

  getPlaudEnvironment: async (options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<PlaudEnvironment> => {
    const query = options.refresh ? '?refresh=1' : ''
    const timeout = AbortSignal.timeout(30000)
    const res = await fetchJSON<ApiEnvelope<PlaudEnvironment>>(`/plaud/environment${query}`, {
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    })
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

  getPlaudIdentity: async (signal?: AbortSignal): Promise<PlaudIdentityStatus> => {
    const res = await fetchJSON<ApiEnvelope<PlaudIdentityStatus>>('/plaud/identity', { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) })
    return res.data
  },

  // Authorizing may trigger a Bluetooth scan to discover the serial and address.
  authorizePlaudDevice: async (input: { token?: string; domain?: string; serial?: string; identifier?: string }, signal?: AbortSignal): Promise<{ authorized: boolean; serial: string; identifier: string; deviceType: string }> => {
    const res = await fetchJSON<ApiEnvelope<{ authorized: boolean; serial: string; identifier: string; deviceType: string }>>('/plaud/identity', {
      method: 'POST', body: JSON.stringify(input),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000),
    })
    return res.data
  },

  clearPlaudIdentity: async (): Promise<{ removed: boolean }> => {
    const res = await fetchJSON<ApiEnvelope<{ removed: boolean }>>('/plaud/identity', { method: 'DELETE', signal: AbortSignal.timeout(20000) })
    return res.data
  },

  getPlaudCloud: async (signal?: AbortSignal): Promise<PlaudCloudStatus> => {
    const res = await fetchJSON<ApiEnvelope<PlaudCloudStatus>>('/plaud/cloud', { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) })
    return res.data
  },

  linkPlaudCloud: async (token: string): Promise<{ linked: boolean; userId: string; region: string; domain: string; expiresAt: number | null; count: number; bytes: number }> => {
    const res = await fetchJSON<ApiEnvelope<{ linked: boolean; userId: string; region: string; domain: string; expiresAt: number | null; count: number; bytes: number }>>('/plaud/cloud/token', { method: 'POST', body: JSON.stringify({ token }), signal: AbortSignal.timeout(30000) })
    return res.data
  },

  unlinkPlaudCloud: async (): Promise<{ removed: boolean }> => {
    const res = await fetchJSON<ApiEnvelope<{ removed: boolean }>>('/plaud/cloud/token', { method: 'DELETE', signal: AbortSignal.timeout(20000) })
    return res.data
  },

  importPlaudCloud: async (options: { ids?: string[]; includeTrash?: boolean }): Promise<{ id: string }> => {
    const res = await fetchJSON<ApiEnvelope<{ id: string }>>('/plaud/cloud/import', { method: 'POST', body: JSON.stringify(options), signal: AbortSignal.timeout(30000) })
    return res.data
  },

  getPlaudCloudImport: async (id: string): Promise<PlaudCloudImportJob> => {
    const res = await fetchJSON<ApiEnvelope<PlaudCloudImportJob>>(`/plaud/cloud/import/${id}`, { signal: AbortSignal.timeout(20000) })
    return res.data
  },

  cancelPlaudCloudImport: async (): Promise<void> => {
    await fetchJSON('/plaud/cloud/cancel', { method: 'POST', signal: AbortSignal.timeout(20000) })
  },

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
