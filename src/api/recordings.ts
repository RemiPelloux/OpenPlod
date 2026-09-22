/**
 * Recordings API routes.
 * Extracted from hub/src/api/routes/recordings.ts, adapted for standalone SQLite.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { RecordingBookmarks } from '../library/bookmarks';
import { db, sqlite } from '../db/client';
import { recordings, transcripts, speakerProfiles, speakerMappings, userSettings } from '../db/schema';
import { SUBTITLE_MIME, isSubtitleFormat, renderSubtitles, subtitleReadiness } from '../library/subtitle-export';
import { applyOperation, parseSegments, speakerLabels, type TranscriptOperation } from '../library/transcript-operations';
import { compareVersions, type VersionRecord } from '../library/transcript-diff';
import { createHash } from 'node:crypto';
import { readAiConfig, textSelection } from '../ai/config';
import { extractStructure, proposeCleanup, proposeTranslation, TranscriptAiError } from '../library/transcript-ai';
import { isStructureFormat, renderStructure, STRUCTURE_EXTENSION, STRUCTURE_MIME } from '../library/structure-export';
import { createCustomAction, customActionInput, deleteCustomAction, listCustomActions, runCustomAction, updateCustomAction } from '../library/custom-actions';
import { BatchManager, summarize } from '../library/batch';
import { eq, desc, and, sql, like } from 'drizzle-orm';
import { jobQueue } from '../jobs/queue';
import { parseByteRange } from './audio';
import { homedir } from 'os';
import { createReadStream } from 'fs';
import { Readable } from 'stream';
import { existsSync, mkdirSync } from 'fs';
import { resolve, sep } from 'path';
import {
  importRecordingFile,
  incomingDirectory,
  purgeRecording,
  replaceRecordingAudio,
  restoreRecording,
  safeFilename,
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
    const settings = Object.fromEntries((await db.select().from(userSettings)).map(row => [row.key, row.value]));
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
          settings,
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

/**
 * Reusable custom AI actions (roadmap TS-08).
 *
 * A saved instruction re-runnable against any transcript. Running one only
 * ever returns a preview; the caller decides what to do with the text.
 */
app.get('/custom-actions', c => c.json({ success: true, data: listCustomActions(sqlite) }));

app.post('/custom-actions', async c => {
  try {
    const input = customActionInput.parse(await c.req.json());
    return c.json({ success: true, data: createCustomAction(sqlite, input) }, 201);
  } catch (error) { const { body, status } = aiFailure(error); return c.json(body, status); }
});

app.patch('/custom-actions/:actionId', async c => {
  try {
    const input = customActionInput.parse(await c.req.json());
    return c.json({ success: true, data: updateCustomAction(sqlite, c.req.param('actionId'), input) });
  } catch (error) { const { body, status } = aiFailure(error); return c.json(body, status); }
});

app.delete('/custom-actions/:actionId', c =>
  c.json({ success: true, data: { removed: deleteCustomAction(sqlite, c.req.param('actionId')) } }));

app.post('/:id/transcript/custom-actions/:actionId', async c => {
  const row = transcriptRow(c.req.param('id'));
  if (!row) return c.json({ success: false, error: 'Saved transcript not found.' }, 404);
  const action = listCustomActions(sqlite).find(item => item.id === c.req.param('actionId'));
  if (!action) return c.json({ success: false, error: 'That custom action no longer exists.' }, 404);
  try {
    const result = await runCustomAction({
      action, transcript: row.fullText, selection: analysisSelection(), sourceHash: sourceHash(row.fullText),
    });
    return c.json({ success: true, data: result });
  } catch (error) { const { body, status } = aiFailure(error); return c.json(body, status); }
});

/**
 * Batch transcription (roadmap TS-10).
 *
 * `POST /batch` requires `confirm: true`, because a batch against a cloud
 * provider spends money. The estimate reports scope and provider rather than
 * a currency figure: providers price per second of audio or per token, and
 * OpenPlod does not know either before the call.
 */
const batches = new BatchManager(2);

app.post('/batch/estimate', async c => {
  const body: { recordingIds?: string[] } = await c.req.json<{ recordingIds?: string[] }>().catch(() => ({}));
  const ids = [...new Set((body.recordingIds ?? []).filter(value => typeof value === 'string'))];
  if (ids.length === 0) return c.json({ success: false, error: 'Select at least one recording.' }, 400);
  const config = readAiConfig(sqlite);
  const provider = config.transcriptionEngine ?? null;
  return c.json({ success: true, data: {
    recordings: ids.length, wouldRun: ids.length,
    usesCloudProvider: provider !== null && provider !== 'whisper',
    provider, estimatedCost: null,
  }});
});

app.post('/batch', async c => {
  const body: { recordingIds?: string[]; confirm?: boolean; retryOf?: string } =
    await c.req.json<{ recordingIds?: string[]; confirm?: boolean; retryOf?: string }>().catch(() => ({}));
  if (body.confirm !== true) {
    return c.json({ success: false, error: 'Confirm the batch before it runs; it may use a paid provider.' }, 400);
  }
  const ids = [...new Set((body.recordingIds ?? []).filter(value => typeof value === 'string'))].slice(0, 500);
  try {
    const job = batches.start({
      kind: 'transcribe', recordingIds: ids, retryOf: body.retryOf,
      runner: async recordingId => {
        const row = sqlite.query('SELECT file_path AS filePath, retention_state AS retentionState FROM recordings WHERE id = ?')
          .get(recordingId) as { filePath: string; retentionState: string } | null;
        if (!row) throw new Error('Recording not found.');
        if (row.retentionState !== 'active') throw new Error('Recording is in Trash.');
        await queueRecordingProcessing({ recordingId, filePath: row.filePath });
      },
    });
    batches.prune();
    return c.json({ success: true, data: { ...job, summary: summarize(job) } }, 202);
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Batch could not start.' }, 400);
  }
});

app.get('/batch/:batchId', c => {
  const job = batches.get(c.req.param('batchId'));
  if (!job) return c.json({ success: false, error: 'That batch is no longer available.' }, 404);
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, data: { ...job, summary: summarize(job) } });
});

app.post('/batch/:batchId/cancel', c =>
  c.json({ success: true, data: { cancelled: batches.cancel(c.req.param('batchId')) } }));

/**
 * Reviewed AI operations over a transcript (roadmap TS-04, TS-05, TS-06).
 *
 * Cleanup and translation *propose*; nothing is written until the caller posts
 * the reviewed text back with the source hash it reviewed. Structure
 * extraction returns timestamps resolved from our own segments, never from the
 * model.
 */
const transcriptRow = (id: string) =>
  sqlite.query('SELECT full_text AS fullText, segments, current_version_id AS versionId FROM transcripts WHERE recording_id = ?')
    .get(id) as { fullText: string; segments: unknown; versionId: string | null } | null;

const sourceHash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Map an AI failure to a body and status, so each route just returns it. */
const aiFailure = (error: unknown): { body: Record<string, unknown>; status: 400 | 413 | 500 | 503 } => {
  if (error instanceof TranscriptAiError) {
    const status = error.code === 'transcript_too_large' ? 413 as const
      : ['provider_error', 'provider_failed', 'provider_unstructured', 'provider_lossy', 'provider_unavailable']
        .includes(error.code) ? 503 as const : 400 as const;
    return { body: { success: false, code: error.code, error: error.message }, status };
  }
  return { body: { success: false, error: error instanceof Error ? error.message : 'AI request failed.' }, status: 500 };
};

/** Resolve the configured text provider, or report that none is usable. */
function analysisSelection() {
  try { return textSelection(sqlite, 'analysis'); }
  catch (error) { throw new TranscriptAiError('provider_unavailable', (error as Error).message); }
}

app.post('/:id/transcript/cleanup', async c => {
  const row = transcriptRow(c.req.param('id'));
  if (!row) return c.json({ success: false, error: 'Saved transcript not found.' }, 404);
  const body: { punctuation?: boolean; paragraphs?: boolean; removeFillers?: boolean; headings?: boolean } =
    await c.req.json<{ punctuation?: boolean; paragraphs?: boolean; removeFillers?: boolean; headings?: boolean }>().catch(() => ({}));
  try {
    const proposal = await proposeCleanup(row.fullText, body, { selection: analysisSelection() });
    // The caller must send this hash back, so a stale review cannot be saved.
    return c.json({ success: true, data: { ...proposal, sourceHash: sourceHash(row.fullText) } });
  } catch (error) { const { body, status } = aiFailure(error); return c.json(body, status); }
});

app.post('/:id/transcript/cleanup/save', async c => {
  const id = c.req.param('id');
  const row = transcriptRow(id);
  if (!row) return c.json({ success: false, error: 'Saved transcript not found.' }, 404);
  const body: { text?: string; sourceHash?: string; revision?: number } =
    await c.req.json<{ text?: string; sourceHash?: string; revision?: number }>().catch(() => ({}));
  if (typeof body.text !== 'string' || !body.text.trim()) return c.json({ success: false, error: 'Reviewed text is required.' }, 400);
  if (body.sourceHash !== sourceHash(row.fullText)) {
    return c.json({ success: false, code: 'source_changed', error: 'The transcript changed since this cleanup was reviewed. Run it again.' }, 409);
  }
  try {
    // Saved as an ordinary edit: the verbatim original stays in version history.
    updateTranscript({ recordingId: id, fullText: body.text, revision: body.revision });
    return c.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Cleanup could not be saved.';
    return c.json({ success: false, error: message }, message === 'revision_conflict' ? 409 : 400);
  }
});

app.post('/:id/transcript/translate', async c => {
  const row = transcriptRow(c.req.param('id'));
  if (!row) return c.json({ success: false, error: 'Saved transcript not found.' }, 404);
  const body: { targetLanguage?: string } = await c.req.json<{ targetLanguage?: string }>().catch(() => ({}));
  const language = String(body.targetLanguage ?? '').trim();
  // Validate the request before resolving a provider, so a bad language is not
  // reported as a missing API key.
  if (!/^[A-Za-z][A-Za-z0-9-]{1,34}$/.test(language)) {
    return c.json({ success: false, code: 'invalid_language', error: 'Choose a target language.' }, 400);
  }
  try {
    const proposal = await proposeTranslation(row.fullText, language, { selection: analysisSelection() }, row.versionId);
    return c.json({ success: true, data: { ...proposal, sourceHash: sourceHash(row.fullText) } });
  } catch (error) { const { body, status } = aiFailure(error); return c.json(body, status); }
});

app.post('/:id/transcript/translate/save', async c => {
  const id = c.req.param('id');
  const row = transcriptRow(id);
  if (!row) return c.json({ success: false, error: 'Saved transcript not found.' }, 404);
  const body: { text?: string; targetLanguage?: string; sourceHash?: string } =
    await c.req.json<{ text?: string; targetLanguage?: string; sourceHash?: string }>().catch(() => ({}));
  const language = String(body.targetLanguage ?? '').trim();
  if (typeof body.text !== 'string' || !body.text.trim()) return c.json({ success: false, error: 'Reviewed translation is required.' }, 400);
  if (!/^[A-Za-z][A-Za-z0-9-]{1,34}$/.test(language)) return c.json({ success: false, error: 'A target language is required.' }, 400);
  if (body.sourceHash !== sourceHash(row.fullText)) {
    return c.json({ success: false, code: 'source_changed', error: 'The transcript changed since this translation was reviewed. Run it again.' }, 409);
  }
  // A translation is its own lineage: stored as a version, never promoted over
  // the original, so the verbatim transcript is never displaced by a language.
  const versionId = crypto.randomUUID();
  sqlite.query(`INSERT INTO transcript_versions(id, recording_id, full_text, segments, origin, provenance, created_at)
    VALUES(?,?,?,NULL,?,?,?)`).run(
    versionId, id, body.text, `translation:${language}`,
    JSON.stringify({ targetLanguage: language, sourceVersionId: row.versionId }), new Date().toISOString());
  return c.json({ success: true, data: { versionId, origin: `translation:${language}` } });
});

app.post('/:id/transcript/structure', async c => {
  const id = c.req.param('id');
  const row = transcriptRow(id);
  if (!row) return c.json({ success: false, error: 'Saved transcript not found.' }, 404);
  // `format` turns the same extraction into a downloadable artefact (TS-09).
  const format = c.req.query('format');
  if (format !== undefined && !isStructureFormat(format)) {
    return c.json({ success: false, error: `Supported formats are ${Object.keys(STRUCTURE_MIME).join(', ')}.` }, 400);
  }
  try {
    const segments = parseSegments(typeof row.segments === 'string' ? JSON.parse(row.segments) : row.segments);
    const structure = await extractStructure(segments, { selection: analysisSelection() });
    if (format === undefined) return c.json({ success: true, data: structure });
    const title = (sqlite.query('SELECT original_filename AS filename FROM recordings WHERE id = ?').get(id) as
      { filename: string | null } | null)?.filename?.replace(/\.[^.]+$/, '') || 'Transcript analysis';
    c.header('Content-Type', `${STRUCTURE_MIME[format]}; charset=utf-8`);
    c.header('Content-Disposition', `attachment; filename="${id}.${STRUCTURE_EXTENSION[format]}"`);
    c.header('Cache-Control', 'no-store');
    return c.body(renderStructure(format, structure, title));
  } catch (error) { const { body, status } = aiFailure(error); return c.json(body, status); }
});

/**
 * Version comparison and promotion (roadmap TS-03).
 *
 * `compare` labels the change by where each side came from, so a manual
 * correction is never presented as if the model had made it. `promote` is the
 * only way a stored version becomes current: nothing here replaces an edited
 * transcript implicitly, and the replaced version stays in history.
 */
const versionRow = (recordingId: string, versionId: string) =>
  sqlite.query(`SELECT id AS versionId, full_text AS fullText, origin, provenance, created_at AS createdAt
    FROM transcript_versions WHERE recording_id = ? AND id = ?`).get(recordingId, versionId) as
    (VersionRecord & { provenance: string | null }) | null;

const readVersion = (recordingId: string, versionId: string): VersionRecord | null => {
  const row = versionRow(recordingId, versionId);
  if (!row) return null;
  return { ...row, provenance: typeof row.provenance === 'string' ? JSON.parse(row.provenance) : null };
};

app.get('/:id/transcript/compare', async c => {
  const id = c.req.param('id');
  const beforeId = c.req.query('before');
  const afterId = c.req.query('after');
  if (!beforeId || !afterId) return c.json({ success: false, error: 'Two version IDs are required.' }, 400);
  const before = readVersion(id, beforeId);
  const after = readVersion(id, afterId);
  if (!before || !after) return c.json({ success: false, error: 'One of those transcript versions does not exist.' }, 404);
  return c.json({ success: true, data: compareVersions(before, after) });
});

app.post('/:id/transcript/versions/:versionId/promote', async c => {
  const id = c.req.param('id');
  const versionId = c.req.param('versionId');
  let revision: number | undefined;
  try {
    const body: { revision?: number } = await c.req.json<{ revision?: number }>().catch(() => ({}));
    revision = typeof body.revision === 'number' ? body.revision : undefined;
    if (revision !== undefined && !Number.isSafeInteger(revision)) throw new Error('Invalid revision.');
  } catch { return c.json({ success: false, error: 'Invalid promotion request.' }, 400); }

  const version = versionRow(id, versionId);
  if (!version) return c.json({ success: false, error: 'That transcript version does not exist.' }, 404);
  const segments = sqlite.query('SELECT segments FROM transcript_versions WHERE id = ?').get(versionId) as { segments: unknown } | null;

  try {
    const promoted = sqlite.transaction(() => {
      const recording = sqlite.query('SELECT revision, retention_state AS retentionState FROM recordings WHERE id = ?').get(id) as
        { revision: number; retentionState: string } | null;
      if (!recording) throw new Error('Recording not found.');
      if (recording.retentionState !== 'active') throw new Error('Recording is in Trash.');
      if (revision !== undefined && revision !== recording.revision) throw new Error('revision_conflict');
      // The replaced version is untouched in history, so this is reversible.
      sqlite.query(`UPDATE transcripts SET full_text = ?, segments = ?, origin = ?, current_version_id = ?, word_count = ?
        WHERE recording_id = ?`).run(
        version.fullText, (segments?.segments as string | null) ?? null, version.origin, versionId,
        version.fullText.trim() ? version.fullText.trim().split(/\s+/).length : 0, id);
      sqlite.query('UPDATE recordings SET revision = ? WHERE id = ?').run(recording.revision + 1, id);
      return { versionId, origin: version.origin, revision: recording.revision + 1 };
    })();
    return c.json({ success: true, data: promoted });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Promotion failed.';
    return c.json({ success: false, error: message }, message === 'revision_conflict' ? 409 : 400);
  }
});

/**
 * Transcript editing operations (roadmap TS-02).
 *
 * Speaker rename/merge, segment split/merge and find/replace are applied as a
 * batch so one editor gesture is one transcript version. `preview` runs the
 * same code and returns the result without saving, which is what the editor
 * shows before the user commits; undo/redo is the client replaying its own
 * stack through this endpoint.
 */
const speakerLabelSchema = z.union([z.number().int().nonnegative(), z.string().trim().min(1).max(80)]);
const operationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('rename-speaker'), from: speakerLabelSchema, to: speakerLabelSchema }),
  z.object({ op: z.literal('merge-speakers'), sources: z.array(speakerLabelSchema).min(1).max(64), target: speakerLabelSchema }),
  z.object({ op: z.literal('split-segment'), index: z.number().int().nonnegative(), offset: z.number().int().positive() }),
  z.object({ op: z.literal('merge-segments'), start: z.number().int().nonnegative(), count: z.number().int().min(2).max(5000) }),
  z.object({
    op: z.literal('replace'), search: z.string().min(1).max(2000), replacement: z.string().max(2000),
    matchCase: z.boolean().optional(), wholeWord: z.boolean().optional(),
    speaker: speakerLabelSchema.nullish(),
  }),
]);
const operationsSchema = z.object({
  operations: z.array(operationSchema).min(1).max(200),
  revision: z.number().int().nonnegative().optional(),
  preview: z.boolean().optional(),
});

app.post('/:id/transcript/operations', async c => {
  const id = c.req.param('id');
  let input: z.infer<typeof operationsSchema>;
  try { input = operationsSchema.parse(await c.req.json()); }
  catch { return c.json({ success: false, error: 'Unsupported transcript operation request.' }, 400); }

  const row = sqlite.query('SELECT segments, full_text AS fullText FROM transcripts WHERE recording_id = ?').get(id) as
    { segments: unknown; fullText: string } | null;
  if (!row) return c.json({ success: false, error: 'Saved transcript not found.' }, 404);

  try {
    let segments = parseSegments(typeof row.segments === 'string' ? JSON.parse(row.segments) : row.segments);
    if (segments.length === 0) {
      return c.json({ success: false, error: 'This transcript has no segments to edit.' }, 409);
    }
    const summaries: string[] = [];
    let fullText = row.fullText;
    for (const operation of input.operations) {
      const outcome = applyOperation(segments, operation as TranscriptOperation);
      segments = outcome.segments;
      fullText = outcome.fullText;
      summaries.push(outcome.summary);
    }
    if (input.preview) {
      return c.json({ success: true, data: {
        preview: true, fullText, segments, summaries, speakers: speakerLabels(segments),
      }});
    }
    updateTranscript({ recordingId: id, fullText, segments, revision: input.revision });
    return c.json({ success: true, data: {
      preview: false, fullText, segments, summaries, speakers: speakerLabels(segments),
    }});
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Transcript operation failed.';
    return c.json({ success: false, error: message }, message === 'revision_conflict' ? 409 : 400);
  }
});

/**
 * Subtitle export (roadmap TS-09).
 *
 * `GET …/subtitles` reports whether real timings exist; `?format=srt|vtt`
 * downloads the file. A transcript without genuine provider timings is refused
 * with the reason rather than exported with invented ones.
 */
app.get('/:id/transcript/subtitles', async c => {
  const id = c.req.param('id');
  const versionId = c.req.query('versionId');
  // A specific version is read from history; otherwise the current transcript.
  const row = (versionId
    ? sqlite.query('SELECT segments FROM transcript_versions WHERE recording_id = ? AND id = ?').get(id, versionId)
    : sqlite.query('SELECT segments FROM transcripts WHERE recording_id = ?').get(id)) as { segments: unknown } | null;
  if (!row) return c.json({ success: false, error: 'Saved transcript not found.' }, 404);
  const segments = typeof row.segments === 'string' ? JSON.parse(row.segments) : row.segments;
  const readiness = subtitleReadiness(segments);

  const format = c.req.query('format');
  if (format === undefined) {
    return c.json({ success: true, data: {
      exportable: readiness.exportable, reason: readiness.reason, detail: readiness.detail,
      cueCount: readiness.cues.length, formats: readiness.exportable ? ['srt', 'vtt'] : [],
    }});
  }
  if (!isSubtitleFormat(format)) return c.json({ success: false, error: 'Supported subtitle formats are srt and vtt.' }, 400);
  if (!readiness.exportable) return c.json({ success: false, error: readiness.detail, reason: readiness.reason }, 409);

  const speakerLabels = c.req.query('speakerLabels') === '1';
  const body = renderSubtitles(format, segments, { speakerLabels });
  c.header('Content-Type', `${SUBTITLE_MIME[format]}; charset=utf-8`);
  c.header('Content-Disposition', `attachment; filename="${id}.${format}"`);
  c.header('Cache-Control', 'no-store');
  return c.body(body);
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

function preserveExtension(title: string, current: string | null): string {
  const extension = current?.match(/\.[^.]+$/)?.[0] ?? '';
  const cleaned = title.trim().slice(0, 200);
  return cleaned.endsWith(extension) ? cleaned : `${cleaned}${extension}`;
}
