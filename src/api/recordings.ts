/**
 * Recordings API routes.
 * Extracted from hub/src/api/routes/recordings.ts, adapted for standalone SQLite.
 */

import { Hono } from 'hono';
import { db, sqlite } from '../db/client';
import { recordings, transcripts, speakerProfiles, speakerMappings, userSettings } from '../db/schema';
import { eq, desc, and, sql, like } from 'drizzle-orm';
import { jobQueue } from '../jobs/queue';
import { parseByteRange } from './audio';
import { homedir } from 'os';
import { createReadStream } from 'fs';
import { Readable } from 'stream';

const app = new Hono();

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

  try {
    const conditions = [];
    if (status) conditions.push(eq(recordings.status, status));
    if (type) conditions.push(eq(recordings.recordingType, type));
    if (search) conditions.push(like(recordings.originalFilename, `%${search}%`));

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
    if (!recording) return c.json({ success: false, error: 'Not found' }, 404);

    await db.update(recordings).set({ status: 'pending', errorMessage: null, processedAt: null }).where(eq(recordings.id, id));
    await jobQueue.add('process-recording', { recordingId: id, filePath: recording.filePath });

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
    return c.json({ success: result.errors.length === 0, data: result }, result.errors.length > 0 ? 400 : 200);
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

export default app;
