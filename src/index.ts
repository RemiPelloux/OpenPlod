/**
 * Plaud App — standalone recording management server.
 * Hono + Drizzle + SQLite.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from 'hono/bun';
import { sqlite } from './db/client';
import recordingsApi from './api/recordings';
import { FolderWatcher } from './sync/folder-watcher';
import { jobQueue } from './jobs/queue';
import { TranscriptionRouter } from './transcription/router';
import { db } from './db/client';
import { recordings, transcripts } from './db/schema';
import { eq, like, or } from 'drizzle-orm';

// ============================================
// Create tables on startup
// ============================================

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    original_filename TEXT,
    duration_seconds INTEGER,
    file_size_bytes INTEGER,
    recording_type TEXT NOT NULL,
    context TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    recorded_at TEXT,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT,
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS transcripts (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    full_text TEXT NOT NULL,
    segments TEXT,
    word_count INTEGER,
    speaker_count INTEGER,
    confidence_score REAL,
    summary TEXT,
    extracted_tasks TEXT,
    analyzed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS speaker_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'other',
    sample_count INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS speaker_mappings (
    id TEXT PRIMARY KEY,
    transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
    speaker_id INTEGER NOT NULL,
    profile_id TEXT REFERENCES speaker_profiles(id) ON DELETE SET NULL,
    confidence REAL,
    manually_assigned INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS analyses (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    summary TEXT,
    extracted_tasks TEXT,
    analyzed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS user_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

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

  const result = await transcriptionRouter.transcribeFile(filePath);

  if (result.success) {
    // Store transcript
    await db.insert(transcripts).values({
      recordingId,
      fullText: result.fullText,
      segments: result.segments as any,
      wordCount: result.wordCount,
      speakerCount: result.speakerCount,
      confidenceScore: result.confidence,
    });

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

app.use('*', cors());
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
  const { userSettings } = await import('./db/schema');
  const settings = await db.select().from(userSettings);
  return c.json({ success: true, data: Object.fromEntries(settings.map(s => [s.key, s.value])) });
});

app.put('/api/settings/:key', async (c) => {
  const key = c.req.param('key');
  const { value } = await c.req.json();
  const { userSettings } = await import('./db/schema');
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
    const results = await db
      .select()
      .from(transcripts)
      .where(like(transcripts.fullText, `%${q}%`));

    const searchResults = [];
    for (const t of results) {
      const [rec] = await db.select().from(recordings).where(eq(recordings.id, t.recordingId)).limit(1);
      if (!rec) continue;

      const segments = typeof t.segments === 'string' ? JSON.parse(t.segments) : (t.segments || []);
      const matchingSegments = segments.filter((s: any) =>
        (s.text || '').toLowerCase().includes(q.toLowerCase())
      ).slice(0, 5).map((s: any, i: number) => ({
        id: `s${i}`,
        speaker: s.speaker !== undefined ? `Speaker ${s.speaker}` : 'Speaker',
        text: s.text || '',
        startTime: s.start || 0,
        endTime: s.end || 0,
      }));

      if (matchingSegments.length === 0 && t.fullText.toLowerCase().includes(q.toLowerCase())) {
        matchingSegments.push({
          id: 's0',
          speaker: 'Speaker',
          text: t.fullText.substring(0, 200),
          startTime: 0,
          endTime: 0,
        });
      }

      searchResults.push({
        recordingId: rec.id,
        recordingTitle: rec.originalFilename?.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ') || 'Untitled',
        recordedAt: rec.recordedAt || rec.uploadedAt,
        segments: matchingSegments,
      });
    }

    return c.json({ success: true, data: searchResults });
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

const watcher = new FolderWatcher();
if (watcher.isConfigured()) {
  watcher.startWatching();
  watcher.syncAll().then(r => {
    console.log(`[Startup] Folder sync: ${r.added} added, ${r.skipped} skipped`);
  });
}

const port = parseInt(process.env.PORT || '3456', 10);
console.log(`[PlaudApp] Starting on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
