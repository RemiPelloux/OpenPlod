/**
 * Recordings API routes.
 * Extracted from hub/src/api/routes/recordings.ts, adapted for standalone SQLite.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { RecordingBookmarks } from '../library/bookmarks';
import { db, sqlite } from '../db/client';
import { recordings, transcripts, userSettings } from '../db/schema';
import { SUBTITLE_MIME, isSubtitleFormat, renderSubtitles, subtitleReadiness } from '../library/subtitle-export';
import { applyOperation, parseSegments, speakerLabels, type TranscriptOperation } from '../library/transcript-operations';
import { compareVersions, type VersionRecord } from '../library/transcript-diff';
import { createHash } from 'node:crypto';
import { readAiConfig, readSettings, textSelection } from '../ai/config';
import { ComparisonError, listComparisons, queueComparison, type ComparisonRequest } from '../library/provider-compare';
import { TranscriptionRouter } from '../transcription/router';
import { extractStructure, proposeCleanup, proposeTranslation, TranscriptAiError } from '../library/transcript-ai';
import { isStructureFormat, renderStructure, STRUCTURE_EXTENSION, STRUCTURE_FORMATS, STRUCTURE_MIME, type StructureFormat } from '../library/structure-export';
import { StructureStore, StructureStoreError } from '../library/structure-store';
import { transcriptPdf } from '../library/transcript-pdf';
import type { TranscriptStructure } from '../library/transcript-ai';
import { createCustomAction, customActionInput, deleteCustomAction, listCustomActions, runCustomAction, updateCustomAction } from '../library/custom-actions';
import { BatchManager, summarize } from '../library/batch';
import { assertFolder, documentBatchOptionsSchema, documentBatchRunner, documentCandidates, estimateDocumentBatch, type DocumentBatchOptions } from '../library/batch-documents';
import { DocumentGenerationService } from '../organizer/generation';
import { OrganizerStore } from '../organizer/store';
import { eq, desc, and, sql, like } from 'drizzle-orm';
import { jobQueue } from '../jobs/queue';
import { estimateRecordings } from '../ai/spending';
import { parseByteRange } from './audio';
import { createReadStream } from 'fs';
import { Readable } from 'stream';
import { existsSync, mkdirSync } from 'fs';
import { resolve, sep } from 'path';
import {
  importRecordingFile,
  configuredSyncPath,
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
import { JobSubmitError, submitTranscription } from '../jobs/submit';
import { RecordingCollections } from '../knowledge/collections';

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
  const collection = c.req.query('collection');
  if (collection !== undefined && !z.string().uuid().safeParse(collection).success) return c.json({ success: false, error: 'Unknown collection.' }, 400);

  try {
    const conditions = [];
    if (status) conditions.push(eq(recordings.status, status));
    if (type) conditions.push(eq(recordings.recordingType, type));
    if (search) conditions.push(like(recordings.originalFilename, `%${search}%`));
    conditions.push(eq(recordings.retentionState, retention));
    // KB-01: recordings in one collection.
    if (collection) conditions.push(sql`${recordings.id} IN (SELECT recording_id FROM recording_collection_items WHERE collection_id = ${collection})`);

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

    // One lookup for the page, so the library can tell which rows still need a transcript.
    const transcribed = transcribedIds(list.map(row => row.id));
    const memberships = collectionIds(list.map(row => row.id));
    return c.json({
      success: true,
      data: list.map(row => ({ ...row, hasTranscript: transcribed.has(row.id), collectionIds: memberships.get(row.id) ?? [] })),
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
    // The saved transcript belongs to the old audio; process the new audio like a fresh import.
    const [replaced] = await db.select({ filePath: recordings.filePath }).from(recordings).where(eq(recordings.id, c.req.param('id'))).limit(1);
    if (replaced) await queueRecordingProcessing({ recordingId: c.req.param('id'), filePath: replaced.filePath });
  } catch (error) {
    if (error instanceof Error && error.message === 'revision_conflict') return c.json({ success: false, error: error.message }, 409);
    if (error instanceof Error && /Trash|not found|Unsupported/.test(error.message)) return c.json({ success: false, error: error.message }, 400);
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
      words: z.array(z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().nonnegative(), text: z.string().max(200) })).max(5000).nullable().optional(),
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
 * provider spends money. The estimate reports scope, provider and an AI-10
 * cost estimate from documented list prices (null when a price or duration is
 * unknown). When the estimate exceeds the per-job threshold or the remaining
 * monthly budget, `confirmCost: true` is also required (409 otherwise).
 */
const batches = new BatchManager(2);

/** Which of these recordings already have a saved transcript, in one statement. */
function transcribedIds(ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  return new Set((sqlite.query('SELECT recording_id AS id FROM transcripts WHERE recording_id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(ids)) as { id: string }[]).map(row => row.id));
}

/**
 * Batch document generation (roadmap TS-10) runs one item at a time: each
 * item is a provider call, and the document service already refuses more
 * than two concurrent generations.
 */
const documentBatches = new BatchManager(1);
const documentBatchOptions = new Map<string, DocumentBatchOptions>();
let documentService: DocumentGenerationService | undefined;
const documents = () => documentService ??= new DocumentGenerationService(new OrganizerStore(sqlite));
const findBatch = (id: string) => batches.get(id) ?? documentBatches.get(id);
const uniqueIds = (value: unknown): string[] =>
  [...new Set((Array.isArray(value) ? value : []).filter((item): item is string => typeof item === 'string'))].slice(0, 500);
/** Collection ids for one page of recordings, in one statement (KB-01). */
function collectionIds(ids: string[]): Map<string, string[]> {
  return new RecordingCollections(sqlite).membership(ids);
}

app.post('/batch/estimate', async c => {
  const body: { recordingIds?: unknown; kind?: unknown } = await c.req.json<{ recordingIds?: unknown; kind?: unknown }>().catch(() => ({}));
  const ids = uniqueIds(body.recordingIds);
  if (ids.length === 0) return c.json({ success: false, error: 'Select at least one recording.' }, 400);
  if (body.kind === 'document') return c.json({ success: true, data: estimateDocumentBatch(sqlite, ids) });
  const config = readAiConfig(sqlite);
  const provider = config.transcriptionEngine ?? null;
  const transcribed = transcribedIds(ids), runnable = ids.filter(id => !transcribed.has(id));
  const cost = runnable.length ? estimateRecordings(sqlite, runnable, config) : null;
  return c.json({ success: true, data: {
    recordings: ids.length, wouldRun: runnable.length,
    usesCloudProvider: provider !== null && provider !== 'whisper',
    provider, estimatedCost: cost,
  }});
});

app.post('/batch', async c => {
  const body: { recordingIds?: unknown; confirm?: boolean; retryOf?: string; kind?: unknown; confirmCost?: boolean } & Record<string, unknown> =
    await c.req.json<{ recordingIds?: unknown; confirm?: boolean; retryOf?: string; kind?: unknown; confirmCost?: boolean }>().catch(() => ({}));
  if (body.confirm !== true) {
    return c.json({ success: false, error: 'Confirm the batch before it runs; it may use a paid provider.' }, 400);
  }
  if (body.kind === 'document') return startDocumentBatch(c, body);
  // Re-transcribing a finished recording is a second paid call, not batch work; it stays a per-recording action.
  const requested = uniqueIds(body.recordingIds);
  const transcribed = transcribedIds(requested);
  const ids = requested.filter(id => !transcribed.has(id));
  if (ids.length === 0 && !body.retryOf) return c.json({ success: false, error: 'Every selected recording already has a transcript.' }, 400);
  if (body.retryOf && !batches.get(body.retryOf)) return c.json({ success: false, error: 'That batch is no longer available.' }, 404);
  const costConfirmed = body.confirmCost === true;
  if (ids.length && !costConfirmed) {
    const cost = estimateRecordings(sqlite, ids, readAiConfig(sqlite));
    if (cost.confirmationRequired) return c.json({ success: false, code: 'cost_confirmation_required', error: `Confirm the estimated cost first. ${cost.reasons.join(' ')}`, data: cost }, 409);
  }
  try {
    const job = batches.start({
      kind: 'transcribe', recordingIds: ids, retryOf: body.retryOf,
      runner: async recordingId => {
        const row = sqlite.query('SELECT file_path AS filePath, retention_state AS retentionState FROM recordings WHERE id = ?')
          .get(recordingId) as { filePath: string; retentionState: string } | null;
        if (!row) throw new Error('Recording not found.');
        if (row.retentionState !== 'active') throw new Error('Recording is in Trash.');
        // A batch is an explicit "transcribe these" request: queue transcription directly rather than
        // through the import route, which may forward instead or do nothing when auto-transcribe is off.
        if (!jobQueue.activeJob('process-recording', recordingId))
          sqlite.query("UPDATE recordings SET status='pending', error_message=NULL WHERE id=?").run(recordingId);
        await jobQueue.add('process-recording', { recordingId, filePath: row.filePath, ...(costConfirmed ? { costConfirmed: true } : {}) });
      },
    });
    batches.prune();
    return c.json({ success: true, data: { ...job, summary: summarize(job) } }, 202);
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Batch could not start.' }, 400);
  }
});

/**
 * A document batch needs the provider the person confirmed. A retry re-runs
 * only the failed items with the options of the original batch, so a retry
 * can never quietly change the template, folder or provider.
 */
function startDocumentBatch(c: Context, body: { recordingIds?: unknown; retryOf?: string } & Record<string, unknown>) {
  let options: DocumentBatchOptions;
  let ids: string[] = [];
  if (body.retryOf) {
    const stored = documentBatchOptions.get(body.retryOf);
    if (!stored || !documentBatches.get(body.retryOf)) return c.json({ success: false, error: 'That batch is no longer available.' }, 404);
    options = stored;
  } else {
    const parsed = documentBatchOptionsSchema.safeParse({ style: body.style, instructions: body.instructions, folderId: body.folderId, expectedProvider: body.expectedProvider });
    if (!parsed.success) return c.json({ success: false, code: 'invalid_input', error: 'Choose a template, a folder and up to 2,000 characters of instructions.' }, 400);
    options = parsed.data;
    const requested = uniqueIds(body.recordingIds);
    const runnable = documentCandidates(sqlite, requested);
    ids = requested.filter(id => runnable.has(id));
    if (ids.length === 0) return c.json({ success: false, error: 'None of the selected recordings has a transcript to send.' }, 400);
  }
  if (!options.expectedProvider) return c.json({ success: false, error: 'Confirm which provider receives the transcripts.' }, 400);
  let provider: string;
  try { provider = textSelection(sqlite, 'document').provider; }
  catch (error) { return c.json({ success: false, code: 'provider_unavailable', error: (error as Error).message }, 503); }
  if (provider !== options.expectedProvider) {
    return c.json({ success: false, code: 'provider_changed', error: 'The document provider changed. Review where the transcripts will be sent and confirm again.' }, 409);
  }
  try {
    assertFolder(sqlite, options.folderId);
    const job = documentBatches.start({
      kind: 'document', recordingIds: ids, retryOf: body.retryOf, runner: documentBatchRunner(sqlite, documents(), options),
    });
    documentBatchOptions.set(job.id, options);
    documentBatches.prune();
    for (const id of documentBatchOptions.keys()) if (!documentBatches.get(id)) documentBatchOptions.delete(id);
    return c.json({ success: true, data: { ...job, summary: summarize(job), options } }, 202);
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Batch could not start.' }, 400);
  }
}

app.get('/batch/:batchId', c => {
  const job = findBatch(c.req.param('batchId'));
  if (!job) return c.json({ success: false, error: 'That batch is no longer available.' }, 404);
  c.header('Cache-Control', 'no-store');
  const options = documentBatchOptions.get(job.id);
  return c.json({ success: true, data: { ...job, summary: summarize(job), ...(options ? { options } : {}) } });
});

app.post('/batch/:batchId/cancel', c => {
  const id = c.req.param('batchId');
  return c.json({ success: true, data: { cancelled: batches.cancel(id) || documentBatches.cancel(id) } });
});

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
  const body: { versionId?: unknown } = await c.req.json<{ versionId?: unknown }>().catch(() => ({}));
  // A specific saved version can be analysed; otherwise the current transcript.
  const versionId = typeof body.versionId === 'string' && body.versionId ? body.versionId : null;
  const row = versionId
    ? sqlite.query('SELECT full_text AS fullText, segments, id AS versionId FROM transcript_versions WHERE recording_id = ? AND id = ?')
      .get(id, versionId) as { fullText: string; segments: unknown; versionId: string | null } | null
    : transcriptRow(id);
  if (!row) return c.json({ success: false, error: versionId ? 'That transcript version does not exist.' : 'Saved transcript not found.' }, 404);
  // `format` turns the same extraction into a downloadable artefact (TS-09).
  const format = c.req.query('format');
  if (format !== undefined && !isStructureFormat(format)) {
    return c.json({ success: false, error: `Supported formats are ${Object.keys(STRUCTURE_MIME).join(', ')}.` }, 400);
  }
  try {
    const segments = parseSegments(typeof row.segments === 'string' ? JSON.parse(row.segments) : row.segments);
    const structure = await extractStructure(segments, { selection: analysisSelection() });
    if (format === undefined) {
      // Held for review, not saved: the client saves it by proposal ID (TS-06).
      const proposal = structureStore().propose({ recordingId: id, versionId: row.versionId, sourceHash: sourceHash(row.fullText), structure });
      return c.json({ success: true, data: { ...structure, proposalId: proposal.proposalId, versionId: row.versionId } });
    }
    return structureDownload(c, id, format, structure);
  } catch (error) { const { body, status } = aiFailure(error); return c.json(body, status); }
});

/** Recording title for export headings, or null when it has none. */
const recordingTitle = (id: string): string | null =>
  (sqlite.query('SELECT original_filename AS filename FROM recordings WHERE id = ?').get(id) as
    { filename: string | null } | null)?.filename?.replace(/\.[^.]+$/, '') || null;

function structureDownload(c: Context, id: string, format: StructureFormat, structure: TranscriptStructure) {
  // PDF is binary-safe ASCII; only text formats carry a charset.
  c.header('Content-Type', format === 'pdf' ? STRUCTURE_MIME.pdf : `${STRUCTURE_MIME[format]}; charset=utf-8`);
  c.header('Content-Disposition', `attachment; filename="${id}.${STRUCTURE_EXTENSION[format]}"`);
  c.header('Cache-Control', 'no-store');
  return c.body(renderStructure(format, structure, recordingTitle(id) ?? 'Transcript analysis'));
}

/**
 * Saved structure (roadmap TS-06).
 *
 * Saving takes the proposal ID from an extraction, never a structure body, so
 * what is stored is exactly what this server extracted and resolved. Every
 * save is a new row; regenerating keeps the earlier rows as history.
 */
let structureStoreInstance: StructureStore | undefined;
const structureStore = () => structureStoreInstance ??= new StructureStore(sqlite);

app.get('/:id/transcript/structures', c =>
  c.json({ success: true, data: structureStore().list(c.req.param('id')) }));

app.post('/:id/transcript/structures', async c => {
  const body: { proposalId?: unknown } = await c.req.json<{ proposalId?: unknown }>().catch(() => ({}));
  if (typeof body.proposalId !== 'string' || !body.proposalId) return c.json({ success: false, error: 'Run the analysis, review it, then save it.' }, 400);
  try {
    return c.json({ success: true, data: structureStore().save(c.req.param('id'), body.proposalId) }, 201);
  } catch (error) {
    if (error instanceof StructureStoreError) return c.json({ success: false, code: error.code, error: error.message }, error.status);
    throw error;
  }
});

app.get('/:id/transcript/structures/:structureId', c => {
  const id = c.req.param('id');
  const saved = structureStore().get(id, c.req.param('structureId'));
  if (!saved) return c.json({ success: false, error: 'That saved analysis does not exist.' }, 404);
  const format = c.req.query('format');
  if (format === undefined) return c.json({ success: true, data: saved });
  if (!isStructureFormat(format)) return c.json({ success: false, error: `Supported formats are ${STRUCTURE_FORMATS.join(', ')}.` }, 400);
  return structureDownload(c, id, format, saved.structure);
});

app.delete('/:id/transcript/structures/:structureId', c =>
  structureStore().remove(c.req.param('id'), c.req.param('structureId'))
    ? c.json({ success: true })
    : c.json({ success: false, error: 'That saved analysis does not exist.' }, 404));

/**
 * Transcript PDF (roadmap TS-09).
 *
 * Rendered on the server from the stored version, so the file is exactly the
 * version selected, with no browser print step.
 */
app.get('/:id/transcript/pdf', c => {
  const id = c.req.param('id');
  const versionId = c.req.query('versionId');
  const recording = sqlite.query('SELECT recorded_at AS recordedAt, source_provider AS sourceProvider FROM recordings WHERE id = ?')
    .get(id) as { recordedAt: string | null; sourceProvider: string | null } | null;
  if (!recording) return c.json({ success: false, error: 'Recording not found.' }, 404);
  const current = transcriptRow(id);
  const resolvedVersionId = versionId || current?.versionId || null;
  const version = resolvedVersionId
    ? sqlite.query('SELECT full_text AS fullText, segments, origin, provenance FROM transcript_versions WHERE recording_id = ? AND id = ?')
      .get(id, resolvedVersionId) as { fullText: string; segments: unknown; origin: string; provenance: string | null } | null
    : null;
  if (versionId && !version) return c.json({ success: false, error: 'That transcript version does not exist.' }, 404);
  const source = version ?? (current ? { ...current, origin: (sqlite.query('SELECT origin FROM transcripts WHERE recording_id = ?')
    .get(id) as { origin: string } | null)?.origin ?? null, provenance: null } : null);
  if (!source) return c.json({ success: false, error: 'Saved transcript not found.' }, 404);
  const provenance = typeof source.provenance === 'string' ? JSON.parse(source.provenance) as Record<string, unknown> : null;
  const { pdf } = transcriptPdf({
    title: recordingTitle(id) ?? 'Transcript', recordedAt: recording.recordedAt, source: recording.sourceProvider,
    versionId: version ? resolvedVersionId : null, origin: source.origin,
    provider: typeof provenance?.provider === 'string' ? provenance.provider : null,
    model: typeof provenance?.model === 'string' ? provenance.model : null,
    fullText: source.fullText, segments: typeof source.segments === 'string' ? JSON.parse(source.segments) : source.segments,
  });
  c.header('Content-Type', 'application/pdf');
  c.header('Content-Disposition', `attachment; filename="${id}.pdf"`);
  c.header('Cache-Control', 'no-store');
  return c.body(pdf);
});

/**
 * Provider comparison (roadmap TS-11).
 *
 * `POST` queues an explicit, confirmed second run with another provider; the
 * result is an independent version that is never promoted automatically.
 * `GET` reports those runs and which providers could be used.
 */
const engineStatus = () => new TranscriptionRouter({}, readSettings(sqlite)).status();

app.get('/:id/transcript/provider-comparisons', c => {
  const id = c.req.param('id');
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, data: { runs: listComparisons(jobQueue, sqlite, id), available: engineStatus() } });
});

app.post('/:id/transcript/provider-comparisons', async c => {
  const body: ComparisonRequest = await c.req.json<ComparisonRequest>().catch(() => ({}));
  try {
    const { job, alreadyQueued } = await queueComparison(jobQueue, sqlite, c.req.param('id'), body, engineStatus());
    return c.json({ success: true, data: { jobId: job.id, status: job.status, alreadyQueued } }, 202);
  } catch (error) {
    if (error instanceof ComparisonError) return c.json({ success: false, error: error.message }, error.status);
    throw error;
  }
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

// Analysis runs through the job queue (KB-06) so it is listed, cancellable, and
// retained in /api/v1/jobs. The request waits up to two minutes for the result
// and otherwise answers 202 with the job id to poll.
app.post('/:id/analyze', async (c) => {
  const id = c.req.param('id');
  try {
    const { recordingAnalyzer } = await import('../analysis/analyzer');
    const cached = sqlite.query("SELECT t.summary FROM transcripts t JOIN recordings r ON r.id=t.recording_id WHERE t.recording_id=? AND r.retention_state='active' AND t.summary IS NOT NULL AND t.analyzed_at IS NOT NULL").get(id);
    if (cached) return c.json({ success: true, data: await recordingAnalyzer.analyze(id) });
    if (!sqlite.query("SELECT 1 FROM transcripts t JOIN recordings r ON r.id=t.recording_id WHERE t.recording_id=? AND r.retention_state='active'").get(id))
      return c.json({ success: false, error: 'Active transcript not found.' }, 404);
    const job = await jobQueue.add('analyze-recording', { recordingId: id, provider: readAiConfig(sqlite).analysisProvider }, 5);
    const deadline = Date.now() + 120000;
    while ((job.status === 'pending' || job.status === 'running') && Date.now() < deadline && !c.req.raw.signal.aborted) await Bun.sleep(200);
    if (job.status === 'complete') return c.json({ success: true, data: await recordingAnalyzer.analyze(id), jobId: job.id });
    if (job.status === 'pending' || job.status === 'running') return c.json({ success: true, data: null, jobId: job.id, state: job.status }, 202);
    return c.json({ success: false, error: job.error || 'Analysis failed.', jobId: job.id }, 500);
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
    const body = await c.req.text();
    let overrides: Record<string, unknown>, confirmCost = false, expectedCustomEndpoint: unknown;
    try { ({ confirmCost, expectedCustomEndpoint, ...overrides } = body.trim() ? JSON.parse(body) : {}); }
    catch { return c.json({ success: false, error: 'Invalid or privacy-blocked transcription options.' }, 400); }
    // KB-06: a retried request with the same Idempotency-Key returns the same job.
    const { job, replayed } = await submitTranscription(sqlite, jobQueue, { recordingId: id, overrides, expectedCustomEndpoint, idempotencyKey: c.req.header('Idempotency-Key'), confirmCost: confirmCost === true });
    return c.json({ success: true, message: replayed ? 'Already queued for this request' : 'Queued for reprocessing', data: { jobId: job.id, state: job.status, replayed } });
  } catch (error) {
    if (error instanceof JobSubmitError) return c.json({ success: false, code: error.code, error: error.status === 404 ? 'Active recording not found' : error.message, ...(error.data ? { data: error.data } : {}) }, error.status);
    if (error instanceof z.ZodError) return c.json({ success: false, code: 'invalid_input', error: error.issues[0]?.message ?? 'Invalid request.' }, 400);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// ============================================
// Sync trigger
// ============================================

app.post('/sync', async (c) => {
  try {
    const { FolderWatcher } = await import('../sync/folder-watcher');
    const watcher = new FolderWatcher(await configuredSyncPath() ?? undefined);
    const result = await watcher.syncAll();
    return c.json({ success: true, data: result });
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

export default app;

function preserveExtension(title: string, current: string | null): string {
  const extension = current?.match(/\.[^.]+$/)?.[0] ?? '';
  const cleaned = title.trim().slice(0, 200);
  return cleaned.endsWith(extension) ? cleaned : `${cleaned}${extension}`;
}
