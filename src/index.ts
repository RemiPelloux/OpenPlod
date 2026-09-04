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
import { TranscriptionRouter, type EngineName } from './transcription/router';
import { db } from './db/client';
import { recordings, transcripts, userSettings } from './db/schema';
import { eq } from 'drizzle-orm';
import { searchTranscripts } from './search/transcripts';
import { homedir } from 'os';

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

jobQueue.register('process-recording', async (data: any) => {
  const { recordingId, filePath } = data;
  console.log(`[Job] Processing recording ${recordingId}`);

  await db.update(recordings).set({ status: 'transcribing' }).where(eq(recordings.id, recordingId));

  const savedSettings = await db.select().from(userSettings);
  const settings = Object.fromEntries(savedSettings.map(setting => [setting.key, setting.value]));
  const primary = ['whisper', 'groq', 'deepgram'].includes(settings.transcriptionEngine)
    ? settings.transcriptionEngine as EngineName
    : 'whisper';
  const router = new TranscriptionRouter(
    { primary, fallback: ['whisper', 'groq', 'deepgram'].filter(name => name !== primary) as EngineName[] },
    { groqApiKey: settings.groqApiKey, deepgramApiKey: settings.deepgramApiKey },
  );
  const result = await router.transcribeFile(filePath);

  if (result.success) {
    // Store transcript
    await db.insert(transcripts).values({
      recordingId,
      fullText: result.fullText,
      segments: result.segments as any,
      wordCount: result.wordCount,
      speakerCount: result.speakerCount,
      confidenceScore: result.confidence,
    }).onConflictDoUpdate({
      target: transcripts.recordingId,
      set: {
        fullText: result.fullText,
        segments: result.segments as any,
        wordCount: result.wordCount,
        speakerCount: result.speakerCount,
        confidenceScore: result.confidence,
        summary: null,
        extractedTasks: null,
        analyzedAt: null,
        createdAt: new Date().toISOString(),
      },
    });

    if (settings.autoSummarize === 'true') {
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
      durationSeconds: Math.round(result.duration),
    }).where(eq(recordings.id, recordingId));

    console.log(`[Job] Recording ${recordingId} transcribed: ${result.wordCount} words, ${result.speakerCount} speakers (${result.engine})`);
  } else {
    await db.update(recordings).set({
      status: 'failed',
      errorMessage: result.error,
    }).where(eq(recordings.id, recordingId));
    console.error(`[Job] Recording ${recordingId} failed: ${result.error}`);
  }
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
      return ['localhost', '127.0.0.1', '::1'].includes(url.hostname) ? origin : '';
    } catch {
      return '';
    }
  },
}));
app.use('*', logger());

// Health/info
app.get('/health', (c) => c.json({ status: 'ok', jobs: jobQueue.getStats() }));
app.get('/api/info', (c) => c.json({
  name: 'plaud-app',
  version: '0.1.0',
  status: 'ok',
  engines: transcriptionRouter.status(),
}));

// API routes
app.route('/api/recordings', recordingsApi);

// Settings
app.get('/api/settings', async (c) => {
  const settings = await db.select().from(userSettings);
  const values = Object.fromEntries(settings.map(setting => [setting.key, setting.value]));
  return c.json({
    success: true,
    data: {
      transcriptionEngine: values.transcriptionEngine,
      syncFolderPath: values.syncFolderPath || '~/Documents/PlaudSync',
      autoTranscribe: values.autoTranscribe ?? 'true',
      autoSummarize: values.autoSummarize ?? 'false',
      groqApiKeyConfigured: Boolean(values.groqApiKey),
      deepgramApiKeyConfigured: Boolean(values.deepgramApiKey),
    },
  });
});

app.put('/api/settings/:key', async (c) => {
  const key = c.req.param('key');
  const allowedKeys = new Set([
    'transcriptionEngine',
    'groqApiKey',
    'deepgramApiKey',
    'syncFolderPath',
    'autoTranscribe',
    'autoSummarize',
  ]);
  if (!allowedKeys.has(key)) return c.json({ success: false, error: 'Unknown setting' }, 400);
  const { value } = await c.req.json();
  await db.insert(userSettings).values({ key, value: String(value) })
    .onConflictDoUpdate({ target: userSettings.key, set: { value: String(value), updatedAt: new Date().toISOString() } });
  return c.json({ success: true });
});

// Jobs
app.get('/api/jobs', (c) => c.json({ success: true, data: jobQueue.getJobs(), stats: jobQueue.getStats() }));

// Transcription engine status
app.get('/api/engines', (c) => c.json({ success: true, data: transcriptionRouter.status() }));

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

const port = parseInt(process.env.PORT || '3456', 10);
const hostname = process.env.HOST || '127.0.0.1';
console.log(`[PlaudApp] Starting on http://${hostname}:${port}`);

export default {
  port,
  hostname,
  fetch: app.fetch,
};
