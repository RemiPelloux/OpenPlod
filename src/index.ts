/**
 * Plaud App — standalone recording management server.
 * Hono + Drizzle + SQLite.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
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
import { homedir } from 'os';
import plaudApi from './api/plaud';
import mobileApi from './api/mobile';
import transcriptsApi from './api/transcripts';
import { purgeExpiredTrash } from './library/recording-library';
import { saveGeneratedTranscript } from './library/transcript-history';
import { forwardRecordingWithRetry } from './library/forwarding';
import { createAiSettingsApi } from './api/ai-settings';
import { aiConfigSchema, readAiConfig, readSettings, assertPrivacy } from './ai/config';
import packageInfo from '../package.json';

// ============================================
// Create tables on startup
// ============================================

initializeDatabase();

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
  const { recordingId, filePath } = data;
  try {
  const recording = db.select().from(recordings).where(eq(recordings.id, recordingId)).get();
  if (!recording || recording.retentionState !== 'active' || recording.fingerprint !== data.fingerprint) throw new Error('Recording is unavailable or its audio changed.');
  if (sqlite.query('SELECT id FROM transcript_versions WHERE id=? AND recording_id=?').get(job.id, recordingId)) {
    await db.update(recordings).set({ status: 'complete', errorMessage: null }).where(eq(recordings.id, recordingId));
    return;
  }
  const config = aiConfigSchema.parse(data.config);
  const currentConfig = readAiConfig(sqlite);
  assertPrivacy(currentConfig, config.transcriptionEngine);
  console.log(`[Job] Processing recording ${recordingId}`);

  await db.update(recordings).set({ status: 'transcribing' }).where(eq(recordings.id, recordingId));

  const savedSettings = await db.select().from(userSettings);
  const settings = Object.fromEntries(savedSettings.map(setting => [setting.key, setting.value]));
  const primary = config.transcriptionEngine;
  const router = new TranscriptionRouter(
    { primary, fallback: config.transcriptionFallback, localOnly: currentConfig.privacyMode === 'local-only' || config.privacyMode === 'local-only', beforeAttempt: provider => assertPrivacy(readAiConfig(sqlite), provider) },
    { mistralApiKey: settings.mistralApiKey, deepgramApiKey: settings.deepgramApiKey, openaiApiKey: settings.openaiApiKey, assemblyaiApiKey: settings.assemblyaiApiKey },
  );
  const options = { model: config.transcriptionModel || undefined, language: config.transcriptionLanguage, diarize: config.transcriptionDiarize, vocabulary: config.transcriptionVocabulary };
  const startedAt = new Date().toISOString();
  const result = await router.transcribeFile(filePath, { ...options, signal: job.signal, checkpoint: job.checkpoint, onCheckpoint: job.saveCheckpoint });
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
      provenance: { provider: result.engine, model: result.metadata?.model ?? null, fingerprint: data.fingerprint, options, startedAt, completedAt: new Date().toISOString(), usage: result.metadata?.usage ?? null, language: result.metadata?.language ?? null },
    });

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

jobQueue.register('forward-recording', async (data: { recordingId: string }) => {
  await forwardRecordingWithRetry(data.recordingId);
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
  allowHeaders: ['Content-Type', 'Range', 'X-OpenPlod-Token'],
  exposeHeaders: ['Accept-Ranges', 'Content-Length', 'Content-Range'],
}));
app.use('*', logger());
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
organizer.purgeExpired();
app.route('/api/v1', createOrganizerApi(organizer));
app.route('/api/ai', createRecordingAiApi(new RecordingAi(organizer)));
app.route('/api/ai-settings', createAiSettingsApi(sqlite));

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

app.put('/api/settings/:key', async (c) => {
  const key = c.req.param('key');
  const allowedKeys = new Set([
    'transcriptionEngine',
    'mistralApiKey',
    'deepgramApiKey',
    'syncFolderPath',
    'autoTranscribe',
    'autoSummarize',
    'autoImport',
    'plaudRecordingTypes',
    'deleteSourceAfterImport',
    'openWhistleForwarding',
    'openWhistleBaseUrl',
    'openWhistleApiKey',
    'openWhistleAgentId',
  ]);
  if (!allowedKeys.has(key)) return c.json({ success: false, error: 'Unknown setting' }, 400);
  const { value } = await c.req.json();
  if (key === 'transcriptionEngine') {
    if (!['whisper', 'mistral', 'deepgram', 'openai', 'assemblyai'].includes(value)) return c.json({ success: false, error: 'Unknown transcription provider.' }, 400);
    const config = readAiConfig(sqlite);
    if (config.privacyMode === 'local-only' && value !== 'whisper') return c.json({ success: false, error: 'Local-only mode blocks cloud transcription.' }, 400);
    config.transcriptionEngine = value;
    config.transcriptionModel = ''; config.transcriptionDiarize = false; config.transcriptionVocabulary = [];
    await db.insert(userSettings).values({ key: 'aiConfig', value: JSON.stringify(config) }).onConflictDoUpdate({ target: userSettings.key, set: { value: JSON.stringify(config) } });
  }
  await db.insert(userSettings).values({ key, value: String(value) })
    .onConflictDoUpdate({ target: userSettings.key, set: { value: String(value), updatedAt: new Date().toISOString() } });
  return c.json({ success: true });
});

// Jobs
app.get('/api/jobs', (c) => c.json({ success: true, data: jobQueue.getJobs().map(({ data, ...job }) => ({ ...job, recordingId: (data as any).recordingId, provider: (data as any).config?.transcriptionEngine })), stats: jobQueue.getStats() }));
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
  const configuredPath = settings.syncFolderPath?.startsWith('~/')
    ? `${homedir()}/${settings.syncFolderPath.slice(2)}`
    : settings.syncFolderPath;
  const watcher = new FolderWatcher(configuredPath);
  if (!watcher.isConfigured()) return;

  watcher.startWatching();
  const result = await watcher.syncAll();
  console.log(`[Startup] Folder sync: ${result.added} added, ${result.skipped} skipped`);
}

void startFolderSync().catch(error => console.error('[Startup] Folder sync failed:', error));
setInterval(() => { void automaticPlaud.tick(); }, 60000).unref();
void purgeExpiredTrash().then(count => {
  if (count > 0) console.log(`[Retention] Purged ${count} expired recording(s)`);
}).catch(error => console.error('[Retention] Trash purge failed:', error));

const port = parseInt(process.env.PORT || '3487', 10);
const hostname = process.env.HOST || '127.0.0.1';
console.log(`[PlaudApp] Starting on http://${hostname}:${port}`);

export default {
  port,
  hostname,
  // CoreBluetooth discovery can take up to 35 seconds before returning a result.
  idleTimeout: 60,
  fetch: app.fetch,
};
