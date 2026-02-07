/**
 * Recordings API routes.
 * Extracted from hub/src/api/routes/recordings.ts, adapted for standalone SQLite.
 */

import { Hono } from 'hono';
import { db } from '../db/client';
import { recordings, transcripts, speakerProfiles, speakerMappings } from '../db/schema';
import { eq, desc, and, gte, lte, sql, like } from 'drizzle-orm';
import { existsSync, statSync, readFileSync } from 'fs';
import { jobQueue } from '../jobs/queue';

const app = new Hono();

// ============================================
// List Recordings
// ============================================

app.get('/', async (c) => {
  const limit = parseInt(c.req.query('limit') || '20', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);
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
    if (!filePath.startsWith('/') || !existsSync(filePath)) {
      return c.json({ success: false, error: 'File not found' }, 404);
    }

    const stat = statSync(filePath);
    const ext = filePath.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg' };
    const contentType = mimeTypes[ext || ''] || 'audio/mpeg';

    // Simple full-file response (range requests can be added later)
    const buffer = readFileSync(filePath);
    return new Response(buffer, {
      headers: { 'Content-Type': contentType, 'Content-Length': String(stat.size), 'Accept-Ranges': 'bytes' },
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
    const byStatus = await db
      .select({ status: recordings.status, count: sql<number>`count(*)` })
      .from(recordings)
      .groupBy(recordings.status);

    const byType = await db
      .select({ type: recordings.recordingType, count: sql<number>`count(*)` })
      .from(recordings)
      .groupBy(recordings.recordingType);

    const [{ total }] = await db
      .select({ total: sql<number>`coalesce(sum(duration_seconds), 0)` })
      .from(recordings);

    return c.json({
      success: true,
      data: {
        byStatus: Object.fromEntries(byStatus.map(s => [s.status, Number(s.count)])),
        byType: Object.fromEntries(byType.map(t => [t.type, Number(t.count)])),
        totalDurationSeconds: Number(total),
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
    const watcher = new FolderWatcher();
    const result = await watcher.syncAll();
    return c.json({ success: true, data: result });
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

export default app;
