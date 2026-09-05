import { Hono } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { recordings, transcripts } from '../db/schema';

const app = new Hono();

app.get('/', async c => {
  const requestedOffset = Number(c.req.query('offset') || 0);
  const offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
  const limit = 30;
  const provider = c.req.query('source');
  const conditions = [eq(recordings.retentionState, 'active')];
  if (provider && ['plaud', 'opennotes', 'upload'].includes(provider)) conditions.push(eq(recordings.sourceProvider, provider));
  const where = and(...conditions);
  const rows = await db.select({
    recordingId: recordings.id,
    filename: recordings.originalFilename,
    recordedAt: recordings.recordedAt,
    sourceProvider: recordings.sourceProvider,
    durationSeconds: recordings.durationSeconds,
    wordCount: transcripts.wordCount,
    excerpt: sql<string>`substr(${transcripts.fullText}, 1, 200)`,
  }).from(recordings).innerJoin(transcripts, eq(transcripts.recordingId, recordings.id))
    .where(where).orderBy(desc(recordings.recordedAt), desc(recordings.id)).limit(limit + 1).offset(offset);
  return c.json({ success: true, data: rows.slice(0, limit), pagination: { offset, limit, hasMore: rows.length > limit } });
});

export default app;
