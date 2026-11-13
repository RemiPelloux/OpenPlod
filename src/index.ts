/**
 * Plaud App — standalone recording management server.
 * Hono + Drizzle + SQLite.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { redactingLogger } from './vault/redacting-logger';
import { prepareVault, tlsOptions } from './vault/startup';
import { protectSetting } from './vault/secrets';
import { createVaultApi } from './api/vault';
import { serveStatic } from 'hono/bun';
import { initializeDatabase } from './db/setup';
import recordingsApi from './api/recordings';
import { FolderWatcher } from './sync/folder-watcher';
import { jobQueue } from './jobs/queue';
import { TranscriptionRouter } from './transcription/router';
import { db, sqlite } from './db/client';
import { OrganizerStore } from './organizer/store';
import { createOrganizerApi } from './api/organizer';
import { apiAccess } from './api/access';
import { RecordingAi } from './organizer/recording-ai';
import { createRecordingAiApi } from './api/recording-ai';
import { automaticPlaud } from './api/plaud';
import { recordings, userSettings } from './db/schema';
import { eq } from 'drizzle-orm';
import { searchTranscripts } from './search/transcripts';
import plaudApi from './api/plaud';
import mobileApi from './api/mobile';
import transcriptsApi from './api/transcripts';
import { configuredSyncPath, purgeExpiredTrash } from './library/recording-library';
import { saveGeneratedTranscript } from './library/transcript-history';
import { runComparison } from './library/provider-compare';
import { forwardRecordingWithRetry } from './library/forwarding';
import { createAiSettingsApi } from './api/ai-settings';
import { createJobsApi } from './api/jobs';
import { createOnboardingApi } from './api/onboarding';
import { createTranscriptionProfilesApi } from './api/transcription-profiles';
import { createKnowledgeApi } from './api/knowledge';
import { RecordingCollections } from './knowledge/collections';
import { KnowledgeIndex } from './knowledge/retrieval';
import { KnowledgeSuggestions } from './knowledge/suggestions';
import { aiConfigSchema, readAiConfig, readSettings, assertPrivacy } from './ai/config';
import { effectiveTranscription } from './ai/transcription-profiles';
import { startAutomation } from './automation';
import { emitAutomationEvent } from './automation/hooks';
import { runTranscription } from './transcription/job-runner';
import { assemblyAiCancelHook } from './transcription/remote-cancel';
import packageInfo from '../package.json';

// ============================================
// Create tables on startup
// ============================================

initializeDatabase();
await prepareVault(sqlite);

console.log('[DB] Tables ready');

// ============================================
// Transcription router
// ============================================

const transcriptionRouter = new TranscriptionRouter();
const engineStatus = transcriptionRouter.status();
console.log('[Transcription] Engines:', Object.entries(engineStatus).map(([k, v]) => `${k}:${v ? '✓' : '✗'}`).join(' '));

// ============================================
// Register job handlers
// ============================================

jobQueue.register('process-recording', async (data: any, job) => {
  // An explicit provider comparison (TS-11) saves an independent version and nothing else.
  if (data.compare) return runComparison(sqlite, data, job);
  const { recordingId, filePath } = data;
  try {
  const recording = db.select().from(recordings).where(eq(recordings.id, recordingId)).get();
  if (!recording || recording.retentionState !== 'active' || recording.fingerprint !== data.fingerprint) throw new Error('Recording is unavailable or its audio changed.');
  if (sqlite.query('SELECT id FROM transcript_versions WHERE id=? AND recording_id=?').get(job.id, recordingId)) {
    await db.update(recordings).set({ status: 'complete', errorMessage: null }).where(eq(recordings.id, recordingId));
    return;
  }
  // The profile is resolved when the job runs, so provenance records exactly what was sent.
  const { config, options, profile, ignored } = effectiveTranscription(sqlite, aiConfigSchema.parse(data.config));
  const currentConfig = readAiConfig(sqlite);
  assertPrivacy(currentConfig, config.transcriptionEngine);
  console.log(`[Job] Processing recording ${recordingId}`);

  await db.update(recordings).set({ status: 'transcribing' }).where(eq(recordings.id, recordingId));

  const settings = readSettings(sqlite);
  const primary = config.transcriptionEngine;
  const router = new TranscriptionRouter(
    { primary, fallback: config.transcriptionFallback, localOnly: currentConfig.privacyMode === 'local-only' || config.privacyMode === 'local-only', beforeAttempt: provider => assertPrivacy(readAiConfig(sqlite), provider) },
    { mistralApiKey: settings.mistralApiKey, deepgramApiKey: settings.deepgramApiKey, openaiApiKey: settings.openaiApiKey, assemblyaiApiKey: settings.assemblyaiApiKey },
  );
  const startedAt = new Date().toISOString();
  // Cost gate, spend ledger and long-audio chunking (AI-08, AI-10) live in the runner.
  const result = await runTranscription(sqlite, router, { jobId: job.id, recordingId, filePath, config, options, costConfirmed: data.costConfirmed === true, signal: job.signal, checkpoint: job.checkpoint, saveCheckpoint: job.saveCheckpoint });
  job.signal.throwIfAborted();

  if (result.success) {
    const documentUpdated = saveGeneratedTranscript({
      recordingId,
      fullText: result.fullText,
      segments: result.segments,
      wordCount: result.wordCount,
      speakerCount: result.speakerCount,
      confidence: result.confidence,
      fingerprint: data.fingerprint,
      generationId: job.id,
      provenance: { provider: result.engine, model: result.metadata?.model ?? null, fingerprint: data.fingerprint, options: { ...options, profile, ...(ignored.length ? { ignoredProfileHints: ignored } : {}) }, startedAt, completedAt: new Date().toISOString(), usage: result.metadata?.usage ?? null, language: result.metadata?.language ?? null, ...(result.metadata?.chunking ? { chunking: result.metadata.chunking } : {}) },
    });
    void emitAutomationEvent({ type: 'recording.transcribed', recordingId, transcriptVersionId: job.id, provider: result.engine, model: typeof result.metadata?.model === 'string' ? result.metadata.model : null, current: documentUpdated });

    if (documentUpdated && settings.autoSummarize === 'true') {
      await db.update(recordings).set({ status: 'summarizing' }).where(eq(recordings.id, recordingId));
      try {
        const { recordingAnalyzer } = await import('./analysis/analyzer');
        await recordingAnalyzer.analyze(recordingId, true);
      } catch (error) {
        console.error(`[Job] Auto-summary failed for ${recordingId}:`, error);
      }
    }

    await db.update(recordings).set({
      status: 'complete',
      processedAt: new Date().toISOString(),
      ...(result.duration > 0 ? { durationSeconds: Math.round(result.duration) } : {}),
      errorMessage: null,
    }).where(eq(recordings.id, recordingId));

    console.log(`[Job] Recording ${recordingId} transcribed: ${result.wordCount} words, ${result.speakerCount} speakers (${result.engine})`);
  } else {
    throw new Error(result.error || 'Transcription failed.');
  }
  } catch (error) {
    await db.update(recordings).set({ status: 'failed', errorMessage: job.signal.aborted ? 'Processing cancelled.' : error instanceof Error ? error.message : 'Transcription failed.' }).where(eq(recordings.id, recordingId));
    throw error;
  }
});

jobQueue.onCancel(assemblyAiCancelHook(sqlite));

jobQueue.register('forward-recording', async (data: { recordingId: string }) => {
  await forwardRecordingWithRetry(data.recordingId);
});

// Manual analysis runs through the queue so it appears in /api/v1/jobs (KB-06).
jobQueue.register('analyze-recording', async (data: { recordingId: string }) => {
  const { recordingAnalyzer } = await import('./analysis/analyzer');
  await recordingAnalyzer.analyze(data.recordingId, true);
});

// ============================================
// Create Hono app
// ============================================

const app = new Hono();

app.use('*', cors({
  origin: origin => {
    if (!origin) return '';
    try {
      const url = new URL(origin);
      const isLocalDevelopment = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
      const isTauriOrigin = origin === 'tauri://localhost' || url.hostname === 'tauri.localhost';
      return isLocalDevelopment || isTauriOrigin ? origin : '';
    } catch {
      return '';
    }
  },
  allowHeaders: ['Content-Type', 'Content-Range', 'Range', 'X-Chunk-SHA256', 'X-OpenPlod-Token', 'Idempotency-Key'],
  exposeHeaders: ['Accept-Ranges', 'Content-Length', 'Content-Range', 'Upload-Offset'],
}));
app.use('*', redactingLogger());
app.use('/api/*', apiAccess);

// Health/info
app.get('/health', (c) => c.json({ status: 'ok', jobs: jobQueue.getStats() }));
app.get('/api/info', (c) => c.json({
  name: 'OpenPlod',
  version: packageInfo.version,
  status: 'ok',
  engines: transcriptionRouter.status(),
}));

// API routes
app.route('/api/recordings', recordingsApi);
app.route('/api/plaud', plaudApi);
app.route('/api/mobile', mobileApi);
app.route('/api/transcripts', transcriptsApi);
const organizer = new OrganizerStore(sqlite);
app.route('/api/v1/jobs', createJobsApi(jobQueue, sqlite));
app.route('/api/v1/transcription-profiles', createTranscriptionProfilesApi(sqlite));
const automation = startAutomation({ database: sqlite, queue: jobQueue, organizer });
app.route('/api/v1/webhooks', automation.webhooksApi);
app.route('/api/v1/automations', automation.automationsApi);
const knowledgeIndex = new KnowledgeIndex(sqlite);
app.route('/api/v1', createKnowledgeApi({ collections: new RecordingCollections(sqlite), index: knowledgeIndex, suggestions: new KnowledgeSuggestions(sqlite, knowledgeIndex) }));
app.route('/api/v1', createOrganizerApi(organizer));
app.route('/api/ai', createRecordingAiApi(new RecordingAi(organizer, undefined, undefined,
  (query, { limit, signal }) => knowledgeIndex.search({ q: query.slice(0, 500), mode: 'hybrid', source: 'transcripts', limit }, { signal }))));
app.route('/api/ai-settings', createAiSettingsApi(sqlite));
app.route('/api/vault', createVaultApi(sqlite));
app.route('/api/onboarding', createOnboardingApi(sqlite, () => new TranscriptionRouter({}, readSettings(sqlite)).status()));

// Settings
app.get('/api/settings', async (c) => {
  const settings = await db.select().from(userSettings);
  const values = Object.fromEntries(settings.map(setting => [setting.key, setting.value]));
  return c.json({
    success: true,
    data: {
      transcriptionEngine: readAiConfig(sqlite).transcriptionEngine,
      syncFolderPath: values.syncFolderPath || '~/Documents/PlaudSync',
      autoTranscribe: values.autoTranscribe ?? 'true',
      autoSummarize: values.autoSummarize ?? 'false',
      autoImport: values.autoImport ?? 'false',
      plaudRecordingTypes: values.plaudRecordingTypes ?? '["class","meeting","conversation","other"]',
      deleteSourceAfterImport: values.deleteSourceAfterImport ?? 'false',
      openWhistleForwarding: values.openWhistleForwarding ?? 'false',
      openWhistleBaseUrl: values.openWhistleBaseUrl ?? '',
      openWhistleAgentId: values.openWhistleAgentId ?? '',
      openWhistleApiKeyConfigured: Boolean(values.openWhistleApiKey),
      mistralApiKeyConfigured: Boolean(values.mistralApiKey),
      deepgramApiKeyConfigured: Boolean(values.deepgramApiKey),
    },
  });
});

const LEGACY_SETTING_KEYS = new Set([
  'transcriptionEngine', 'mistralApiKey', 'deepgramApiKey', 'syncFolderPath', 'autoTranscribe', 'autoSummarize', 'autoImport',
  'plaudRecordingTypes', 'deleteSourceAfterImport', 'openWhistleForwarding', 'openWhistleBaseUrl', 'openWhistleApiKey', 'openWhistleAgentId',
]);
const upsertSetting = (key: string, value: string) => sqlite.query(`INSERT INTO user_settings(key, value, updated_at) VALUES(?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(key, value, new Date().toISOString());

/** Validate legacy settings, then write them all in one transaction. Returns an error message instead of writing anything. */
function saveLegacySettings(entries: [string, unknown][]): string | null {
  for (const [key, value] of entries) {
    if (!LEGACY_SETTING_KEYS.has(key)) return 'Unknown setting';
    if (key === 'transcriptionEngine') {
      if (!['whisper', 'mistral', 'deepgram', 'openai', 'assemblyai'].includes(String(value))) return 'Unknown transcription provider.';
      if (readAiConfig(sqlite).privacyMode === 'local-only' && value !== 'whisper') return 'Local-only mode blocks cloud transcription.';
    }
  }
  sqlite.transaction(() => {
    for (const [key, value] of entries) {
      if (key === 'transcriptionEngine') {
        const config = readAiConfig(sqlite);
        config.transcriptionEngine = value as typeof config.transcriptionEngine;
        config.transcriptionModel = ''; config.transcriptionDiarize = false; config.transcriptionVocabulary = []; config.transcriptionPrompt = '';
        upsertSetting('aiConfig', JSON.stringify(config));
      }
      upsertSetting(key, protectSetting(key, String(value)));
    }
  })();
  return null;
}

app.put('/api/settings/:key', async (c) => {
  const { value } = await c.req.json();
  const error = saveLegacySettings([[c.req.param('key'), value]]);
  return error ? c.json({ success: false, error }, 400) : c.json({ success: true });
});

/** Several legacy settings at once: `{ key: value, ... }`. All are validated first; nothing is written if any is rejected. */
app.patch('/api/settings', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ success: false, error: 'Send an object of settings.' }, 400);
  const error = saveLegacySettings(Object.entries(body));
  return error ? c.json({ success: false, error }, 400) : c.json({ success: true });
});

// Jobs
app.get('/api/jobs', (c) => c.json({ success: true, data: jobQueue.getJobs().map(({ data, ...job }) => ({ ...job, checkpoint: job.checkpoint && { phase: job.checkpoint.phase, remoteId: job.checkpoint.remoteId, inFlight: job.checkpoint.inFlight, progress: job.checkpoint.progress }, recordingId: (data as any).recordingId, provider: (data as any).config?.transcriptionEngine })), stats: jobQueue.getStats() }));
app.post('/api/jobs/:id/cancel', c => c.json({ success: jobQueue.cancel(c.req.param('id')) }));
app.post('/api/jobs/:id/resume', c => c.json({ success: jobQueue.resume(c.req.param('id')) }));
app.patch('/api/jobs/:id', async c => { const body = await c.req.json(); return c.json({ success: jobQueue.setPriority(c.req.param('id'), body.priority) }); });

// Transcription engine status
app.get('/api/engines', (c) => c.json({ success: true, data: new TranscriptionRouter({}, readSettings(sqlite)).status() }));

// Search across transcripts
app.get('/api/search', async (c) => {
  const q = c.req.query('q') || '';
  if (q.length < 2) return c.json({ success: true, data: [] });

  try {
    return c.json({ success: true, data: searchTranscripts(q) });
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// Serve frontend static files
app.use('/*', serveStatic({ root: './web/dist' }));
app.get('/*', serveStatic({ path: './web/dist/index.html' }));

// ============================================
// Start folder watcher + server
// ============================================

async function startFolderSync() {
  const savedSettings = await db.select().from(userSettings);
  const settings = Object.fromEntries(savedSettings.map(setting => [setting.key, setting.value]));
  // Manual folder import must not request Documents access during Bluetooth-only startup.
  if (settings.autoImport !== 'true') {
    console.log('[Startup] Automatic folder import is disabled');
    return;
  }
  const watcher = new FolderWatcher(await configuredSyncPath() ?? undefined);
  if (!watcher.isConfigured()) return;

  watcher.startWatching();
  const result = await watcher.syncAll();
  console.log(`[Startup] Folder sync: ${result.added} added, ${result.skipped} skipped`);
}

void startFolderSync().catch(error => console.error('[Startup] Folder sync failed:', error));
setInterval(() => { void automaticPlaud.tick(); }, 60000).unref();
// 30-day Trash retention must hold for a long-running server too, not only at startup.
function purgeTrash() {
  try { organizer.purgeExpired(); } catch (error) { console.error('[Retention] Note trash purge failed:', error); }
  void purgeExpiredTrash().then(count => {
    if (count > 0) console.log(`[Retention] Purged ${count} expired recording(s)`);
  }).catch(error => console.error('[Retention] Trash purge failed:', error));
}
purgeTrash();
setInterval(purgeTrash, 6 * 3600 * 1000).unref();

const port = parseInt(process.env.PORT || '3487', 10);
const hostname = process.env.HOST || '127.0.0.1';
const tls = tlsOptions();
console.log(`[PlaudApp] Starting on ${tls.tls ? 'https' : 'http'}://${hostname}:${port}`);
if (!tls.tls && !['127.0.0.1', 'localhost', '::1'].includes(hostname)) console.warn('[Security] Plain HTTP on a non-loopback address: pairing tokens and audio are not encrypted in transit. Set OPENPLOD_TLS_CERT/OPENPLOD_TLS_KEY.');

export default {
  port,
  hostname,
  ...tls,
  // Bluetooth discovery can take up to 35 seconds before returning a result.
  idleTimeout: 60,
  fetch: app.fetch,
};
