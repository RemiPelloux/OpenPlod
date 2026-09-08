/**
 * Recordings API routes.
 * Extracted from hub/src/api/routes/recordings.ts, adapted for standalone SQLite.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { RecordingBookmarks } from '../library/bookmarks';
import { db, sqlite } from '../db/client';
import { recordings, transcripts, speakerProfiles, speakerMappings, userSettings } from '../db/schema';
import { eq, desc, and, sql, like } from 'drizzle-orm';
import { jobQueue } from '../jobs/queue';
import { parseByteRange } from './audio';
import { homedir } from 'os';
import { createReadStream } from 'fs';
import { Readable } from 'stream';
import { existsSync, mkdirSync } from 'fs';
import { dirname, resolve, sep } from 'path';
import {
  importRecordingFile,
  purgeRecording,
  replaceRecordingAudio,
  restoreRecording,
  softDeleteRecording,
  updateTranscript,
} from '../library/recording-library';
import { forwardRecording } from '../library/forwarding';
import { queueRecordingProcessing } from '../library/processing';

const app = new Hono();
let bookmarkStore: RecordingBookmarks | undefined;
const bookmarks = () => bookmarkStore ??= new RecordingBookmarks(sqlite);
app.get('/:id/bookmarks', c => { try { return c.json({ success: true, data: bookmarks().list(c.req.param('id')) }); } catch (e) { return c.json({ success: false, error: 'Recording bookmarks unavailable.' }, 404); } });
app.post('/:id/bookmarks', async c => { try { return c.json({ success: true, data: bookmarks().add(c.req.param('id'), await c.req.json()) }); } catch (e) { return c.json({ success: false, error: (e as Error).message }, 400); } });
app.delete('/:id/bookmarks/:bookmarkId', c => { try { return c.json({ success: true, data: bookmarks().remove(c.req.param('id'), c.req.param('bookmarkId')) }); } catch { return c.json({ success: false, error: 'Bookmark unavailable.' }, 404); } });

function incomingDirectory(): string {
  const libraryPath = process.env.OPENPLOD_LIBRARY_PATH;
  return libraryPath ? resolve(dirname(libraryPath), 'incoming') : resolve('./data/incoming');
}

// ============================================
// List Recordings
// ============================================

app.get('/', async (c) => {
  const requestedLimit = Number.parseInt(c.req.query('limit') || '20', 10);
  const requestedOffset = Number.parseInt(c.req.query('offset') || '0', 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 20;
  const offset = Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0;
  const status = c.req.query('status');
  const type = c.req.query('type');
  const search = c.req.query('search');
  const retention = c.req.query('retention') === 'trash' ? 'trash' : 'active';

  try {
    const conditions = [];
    if (status) conditions.push(eq(recordings.status, status));
    if (type) conditions.push(eq(recordings.recordingType, type));
    if (search) conditions.push(like(recordings.originalFilename, `%${search}%`));
    conditions.push(eq(recordings.retentionState, retention));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const list = await db
      .select()
      .from(recordings)
      .where(where)
      .orderBy(desc(recordings.recordedAt))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(recordings)
      .where(where);

    return c.json({
      success: true,
      data: list,
      pagination: { total: Number(count), limit, offset, hasMore: offset + list.length < Number(count) },
    });
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// Import from the configured Plaud folder or a multipart mobile/file upload.
app.post('/import', async c => {
  const contentType = c.req.header('content-type') ?? '';
  const imported = [];
  if (contentType.includes('multipart/form-data')) {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) return c.json({ success: false, error: 'Audio file is required.' }, 400);
    if (file.size === 0) return c.json({ success: false, error: 'Audio file is empty.' }, 400);
    const durationMs = body.duration_ms === undefined ? undefined : Number(body.duration_ms);
    if (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs < 0)) {
      return c.json({ success: false, error: 'Recording duration is invalid.' }, 400);
    }
    const incomingDir = incomingDirectory();
    mkdirSync(incomingDir, { recursive: true });
    const incomingPath = resolve(incomingDir, `${crypto.randomUUID()}-${safeFilename(file.name)}`);
    await Bun.write(incomingPath, file);
    try {
      const result = await importRecordingFile({
        sourcePath: incomingPath,
        originalFilename: safeFilename(file.name),
        metadata: { context: typeof body.context === 'string' ? body.context : null,
          recordingType: typeof body.recording_type === 'string' && ['class', 'meeting', 'conversation', 'other'].includes(body.recording_type)
            ? body.recording_type : undefined, durationMs },
        provenance: {
          sourceProvider: body.source_provider === 'plaud' ? 'plaud' : body.source_provider === 'opennotes' ? 'opennotes' : 'upload',
          sourceRecordingId: typeof body.source_recording_id === 'string' ? body.source_recording_id : null,
          sourceTransport: body.source_transport === 'mobile' ? 'mobile' : body.source_transport === 'export' ? 'export' : 'upload',
          recordedAt: typeof body.recorded_at === 'string' ? body.recorded_at : null,
        },
      });
      imported.push(result);
      if (result.added) {
        await queueRecordingProcessing({
          recordingId: result.recording.id,
          filePath: result.recording.filePath,
        });
      }
    } finally {
      await Bun.file(incomingPath).delete().catch(() => undefined);
    }
  } else {
    const body = await c.req.json<{ paths?: string[] }>();
    const root = await configuredSyncPath();
    if (!root) return c.json({ success: false, error: 'Plaud sync folder is not configured.' }, 400);
    for (const candidate of body.paths ?? []) {
      const sourcePath = resolve(candidate);
      if (sourcePath !== root && !sourcePath.startsWith(`${root}${sep}`)) {
        return c.json({ success: false, error: 'Import path is outside the Plaud sync folder.' }, 400);
      }
      const result = await importRecordingFile({
        sourcePath,
        provenance: { sourceProvider: 'plaud', sourceTransport: 'folder' },
      });
      imported.push(result);
      if (result.added) {
        await queueRecordingProcessing({
          recordingId: result.recording.id,
          filePath: result.recording.filePath,
        });
      }
    }
  }
  return c.json({ success: true, data: imported }, 201);
});

app.patch('/:id', async c => {
  const id = c.req.param('id');
  const body = await c.req.json<{
    title?: string;
    recordedAt?: string;
    recordingType?: string;
    context?: string | null;
    notes?: string | null;
    tags?: string[];
    revision: number;
  }>();
  const [recording] = await db.select().from(recordings).where(eq(recordings.id, id)).limit(1);
  if (!recording) return c.json({ success: false, error: 'Not found' }, 404);
  if (body.revision !== recording.revision) return c.json({ success: false, error: 'revision_conflict', data: recording }, 409);
  const changes = {
    originalFilename: body.title ? preserveExtension(body.title, recording.originalFilename) : recording.originalFilename,
    recordedAt: body.recordedAt ?? recording.recordedAt,
    recordingType: body.recordingType ?? recording.recordingType,
    context: body.context === undefined ? recording.context : body.context,
    notes: body.notes === undefined ? recording.notes : body.notes,
    tags: body.tags ?? recording.tags,
    revision: recording.revision + 1,
  };
  await db.update(recordings).set(changes).where(eq(recordings.id, id));
  return c.json({ success: true, data: { ...recording, ...changes } });
});

app.post('/:id/replace-audio', async c => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.json({ success: false, error: 'Audio file is required.' }, 400);
  const incomingDir = incomingDirectory();
  mkdirSync(incomingDir, { recursive: true });
  const incomingPath = resolve(incomingDir, `${crypto.randomUUID()}-${safeFilename(file.name)}`);
  await Bun.write(incomingPath, file);
  try {
    await replaceRecordingAudio({
      recordingId: c.req.param('id'),
      sourcePath: incomingPath,
      expectedRevision: Number(body.revision),
      originalFilename: safeFilename(file.name),
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'revision_conflict') return c.json({ success: false, error: error.message }, 409);
    throw error;
  } finally {
    await Bun.file(incomingPath).delete().catch(() => undefined);
  }
  return c.json({ success: true });
});

app.patch('/:id/transcript', async c => {
  const body = await c.req.json<{ fullText: string; segments?: unknown; revision?: number }>();
  if (typeof body.fullText !== 'string' || (body.revision !== undefined && !Number.isSafeInteger(body.revision))) {
    return c.json({ success: false, error: 'Transcript text and a valid revision are required.' }, 400);
  }
  try {
    if (body.segments !== undefined && body.segments !== null) body.segments = z.array(z.object({
      start: z.number().finite().nonnegative(), end: z.number().finite().nonnegative(), text: z.string().max(50000),
      speaker: z.union([z.number().int().nonnegative(), z.string().max(80)]).optional(), confidence: z.number().optional(),
    }).refine(s => s.end >= s.start)).max(20000).parse(body.segments);
    updateTranscript({ recordingId: c.req.param('id'), fullText: body.fullText, segments: body.segments, revision: body.revision });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Transcript update failed.';
    return c.json({ success: false, error: message }, message === 'revision_conflict' ? 409 : 400);
  }
  return c.json({ success: true });
});

app.get('/:id/transcript/versions', async c => {
  const rows = sqlite.query(`
    SELECT id, recording_id AS recordingId, full_text AS fullText, segments, origin, provenance, created_at AS createdAt
    FROM transcript_versions WHERE recording_id = ? ORDER BY created_at DESC, rowid DESC
  `).all(c.req.param('id'));
  return c.json({ success: true, data: rows.map(row => { const value = row as Record<string, unknown>; return { ...value, provenance: typeof value.provenance === 'string' ? JSON.parse(value.provenance) : null }; }) });
});

app.post('/:id/forward', async c => {
  try {
    const runId = await forwardRecording(c.req.param('id'));
    return c.json({ success: true, data: { runId } }, 202);
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

app.post('/:id/restore', async c => {
  return await restoreRecording(c.req.param('id'))
    ? c.json({ success: true })
    : c.json({ success: false, error: 'Trashed recording not found.' }, 404);
});

app.delete('/:id', async c => {
  const permanent = c.req.query('permanent') === 'true';
  if (permanent && c.req.query('confirm') !== 'true') {
    return c.json({ success: false, error: 'Permanent purge requires confirm=true.' }, 400);
  }
  const changed = permanent
    ? await purgeRecording(c.req.param('id'))
    : await softDeleteRecording(c.req.param('id'));
  return changed ? c.json({ success: true }) : c.json({ success: false, error: 'Not found' }, 404);
});

// ============================================
// Get Recording Detail
// ============================================

app.get('/:id', async (c) => {
  const id = c.req.param('id');
  try {
    const [recording] = await db.select().from(recordings).where(eq(recordings.id, id)).limit(1);
    if (!recording) return c.json({ success: false, error: 'Not found' }, 404);

    const [transcript] = await db.select().from(transcripts).where(eq(transcripts.recordingId, id)).limit(1);

    let speakerLabels: Record<number, string> = {};
    if (transcript) {
      const mappings = await db
        .select({ speakerId: speakerMappings.speakerId, name: speakerProfiles.name })
        .from(speakerMappings)
        .leftJoin(speakerProfiles, eq(speakerMappings.profileId, speakerProfiles.id))
        .where(eq(speakerMappings.transcriptId, transcript.id));

      speakerLabels = Object.fromEntries(mappings.filter(m => m.name).map(m => [m.speakerId, m.name!]));
    }

    return c.json({
      success: true,
      data: {
        ...recording,
        transcript: transcript ? {
          id: transcript.id,
          fullText: transcript.fullText,
          origin: transcript.origin,
          currentVersionId: transcript.currentVersionId,
          segments: transcript.segments,
          wordCount: transcript.wordCount,
          speakerCount: transcript.speakerCount,
          confidenceScore: transcript.confidenceScore,
          speakerLabels,
          summary: transcript.summary,
          extractedTasks: transcript.extractedTasks,
          analyzedAt: transcript.analyzedAt,
        } : null,
      },
    });
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// ============================================
// Stream Audio
// ============================================

app.get('/:id/audio', async (c) => {
  const id = c.req.param('id');
  try {
    const [recording] = await db.select().from(recordings).where(eq(recordings.id, id)).limit(1);
    if (!recording) return c.json({ success: false, error: 'Not found' }, 404);

    const filePath = recording.filePath;
    const file = Bun.file(filePath);
    if (!await file.exists()) {
      return c.json({ success: false, error: 'File not found' }, 404);
    }

    const ext = filePath.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      mp3: 'audio/mpeg',
      m4a: 'audio/mp4',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      webm: 'audio/webm',
      aac: 'audio/aac',
      flac: 'audio/flac',
    };
    const contentType = mimeTypes[ext || ''] || 'application/octet-stream';
    const range = parseByteRange(c.req.header('Range'), file.size);
    const commonHeaders = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
      'Content-Type': contentType,
    };

    if (range === 'invalid') {
      return new Response(null, {
        status: 416,
        headers: { ...commonHeaders, 'Content-Range': `bytes */${file.size}` },
      });
    }

    if (range) {
      const contentLength = range.end - range.start + 1;
      const stream = Readable.toWeb(createReadStream(filePath, { start: range.start, end: range.end }));
      return new Response(stream as unknown as ReadableStream, {
        status: 206,
        headers: {
          ...commonHeaders,
          'Content-Length': String(contentLength),
          'Content-Range': `bytes ${range.start}-${range.end}/${file.size}`,
        },
      });
    }

    return new Response(file, {
      headers: { ...commonHeaders, 'Content-Length': String(file.size) },
    });
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// ============================================
// Stats
// ============================================

app.get('/stats/summary', async (c) => {
  try {
    const totals = sqlite.query(`
      SELECT
        COUNT(*) AS totalRecordings,
        COALESCE(SUM(duration_seconds), 0) AS totalDurationSeconds,
        COALESCE(SUM(status = 'pending'), 0) AS pending,
        COALESCE(SUM(status = 'transcribing'), 0) AS transcribing,
        COALESCE(SUM(status = 'summarizing'), 0) AS summarizing,
        COALESCE(SUM(status = 'complete'), 0) AS complete,
        COALESCE(SUM(status = 'failed'), 0) AS failed,
        COALESCE(SUM(recording_type = 'class'), 0) AS classCount,
        COALESCE(SUM(recording_type = 'meeting'), 0) AS meetingCount,
        COALESCE(SUM(recording_type = 'conversation'), 0) AS conversationCount,
        COALESCE(SUM(recording_type = 'other'), 0) AS otherCount
      FROM recordings
      WHERE retention_state = 'active'
    `).get() as Record<string, number>;

    return c.json({
      success: true,
      data: {
        byStatus: {
          pending: totals.pending,
          transcribing: totals.transcribing,
          summarizing: totals.summarizing,
          complete: totals.complete,
          failed: totals.failed,
        },
        byType: {
          class: totals.classCount,
          meeting: totals.meetingCount,
          conversation: totals.conversationCount,
          other: totals.otherCount,
        },
        totalDurationSeconds: totals.totalDurationSeconds,
      },
    });
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// ============================================
// Analyze Recording
// ============================================

app.post('/:id/analyze', async (c) => {
  const id = c.req.param('id');
  try {
    const { recordingAnalyzer } = await import('../analysis/analyzer');
    const analysis = await recordingAnalyzer.analyze(id);
    return c.json({ success: true, data: analysis });
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// ============================================
// Reprocess
// ============================================

app.post('/:id/reprocess', async (c) => {
  const id = c.req.param('id');
  try {
    const [recording] = await db.select().from(recordings).where(eq(recordings.id, id)).limit(1);
    if (!recording || recording.retentionState !== 'active') return c.json({ success: false, error: 'Active recording not found' }, 404);
    const { aiConfigSchema, readAiConfig } = await import('../ai/config');
    const body = await c.req.text();
    let config;
    try {
      const overrides = body.trim() ? JSON.parse(body) : {};
      if (Object.keys(overrides).some(key => !key.startsWith('transcription'))) throw new Error('Unsupported override');
      config = aiConfigSchema.parse({ ...readAiConfig(sqlite), ...overrides });
      const { assertPrivacy } = await import('../ai/config');
      const { validateSpeechOptions } = await import('../ai/capabilities');
      assertPrivacy(readAiConfig(sqlite), config.transcriptionEngine);
      validateSpeechOptions(config.transcriptionEngine, { model: config.transcriptionModel, diarize: config.transcriptionDiarize, vocabulary: config.transcriptionVocabulary });
    } catch { return c.json({ success: false, error: 'Invalid or privacy-blocked transcription options.' }, 400); }
    await db.update(recordings).set({ status: 'pending', errorMessage: null, processedAt: null }).where(eq(recordings.id, id));
    await jobQueue.add('process-recording', { recordingId: id, filePath: recording.filePath, config });

    return c.json({ success: true, message: 'Queued for reprocessing' });
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// ============================================
// Sync trigger
// ============================================

app.post('/sync', async (c) => {
  try {
    const { FolderWatcher } = await import('../sync/folder-watcher');
    const savedSettings = await db.select().from(userSettings);
    const settings = Object.fromEntries(savedSettings.map(setting => [setting.key, setting.value]));
    const syncPath = settings.syncFolderPath?.startsWith('~/')
      ? `${homedir()}/${settings.syncFolderPath.slice(2)}`
      : settings.syncFolderPath;
    const watcher = new FolderWatcher(syncPath);
    const result = await watcher.syncAll();
    return c.json({ success: true, data: result });
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

export default app;

async function configuredSyncPath(): Promise<string | null> {
  const [setting] = await db.select({ value: userSettings.value }).from(userSettings)
    .where(eq(userSettings.key, 'syncFolderPath')).limit(1);
  const raw = setting?.value || process.env.PLAUD_SYNC_PATH;
  if (!raw) return null;
  return resolve(raw.startsWith('~/') ? `${homedir()}/${raw.slice(2)}` : raw);
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'recording.m4a';
}

function preserveExtension(title: string, current: string | null): string {
  const extension = current?.match(/\.[^.]+$/)?.[0] ?? '';
  const cleaned = title.trim().slice(0, 200);
  return cleaned.endsWith(extension) ? cleaned : `${cleaned}${extension}`;
}
