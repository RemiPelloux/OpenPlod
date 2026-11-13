import type { Database } from 'bun:sqlite';
import { initializeMobileSync } from './mobile-schema';

/**
 * Desktop -> client change feed and client -> desktop metadata push (MOB-04).
 * See docs/impl-notes/stream-e-mobile.md for the protocol.
 */
export const MAX_FEED_PAGE = 500;

export type FeedRecording = {
  type: 'recording';
  id: string;
  seq: number;
  revision: number;
  retentionState: string;
  deletedAt: string | null;
  title: string | null;
  recordedAt: string | null;
  recordingType: string;
  context: string | null;
  notes: string | null;
  tags: string[];
  status: string;
  fingerprint: string | null;
  durationSeconds: number | null;
  sourceProvider: string | null;
  sourceRecordingId: string | null;
  transcriptHead: { versionId: string | null; origin: string } | null;
};
export type FeedPurged = { type: 'purged'; id: string; seq: number; revision: number | null };
export type Tombstone = {
  seq: number; recordingId: string; event: 'trash' | 'restore' | 'purge'; revision: number | null;
  fingerprint: string | null; sourceProvider: string | null; sourceRecordingId: string | null; at: string;
};
export type FeedPage = { cursor: string; hasMore: boolean; changes: (FeedRecording | FeedPurged)[]; tombstones: Tombstone[] };

export class CursorExpired extends Error {}

/** Editable metadata a client may push. Processing results and audio are desktop-owned. */
const EDITABLE = ['title', 'context', 'notes', 'tags', 'recordingType', 'recordedAt'] as const;
type EditableField = typeof EDITABLE[number];
export type MetadataChange = { changeId: string; recordingId: string; baseRevision: number; fields: Partial<Record<EditableField, unknown>> };
export type ChangeResult =
  | { changeId: string; status: 'applied'; recordingId: string; revision: number }
  | { changeId: string; status: 'conflict'; recordingId: string; current: FeedRecording }
  | { changeId: string; status: 'not_found' | 'trashed' | 'invalid'; recordingId: string; error: string };

type RecordingRow = {
  id: string; revision: number; retention_state: string; deleted_at: string | null; original_filename: string | null;
  recorded_at: string | null; recording_type: string; context: string | null; notes: string | null; tags: string | null;
  status: string; fingerprint: string | null; duration_seconds: number | null; source_provider: string | null;
  source_recording_id: string | null; transcript_version_id: string | null; transcript_origin: string | null;
};

const RECORDING_SELECT = `SELECT r.id, r.revision, r.retention_state, r.deleted_at, r.original_filename, r.recorded_at,
  r.recording_type, r.context, r.notes, r.tags, r.status, r.fingerprint, r.duration_seconds, r.source_provider,
  r.source_recording_id, t.current_version_id AS transcript_version_id, t.origin AS transcript_origin
  FROM recordings r LEFT JOIN transcripts t ON t.recording_id = r.id`;

function parseTags(value: string | null): string[] {
  try { const parsed = JSON.parse(value ?? '[]'); return Array.isArray(parsed) ? parsed.filter(t => typeof t === 'string') : []; } catch { return []; }
}

function title(filename: string | null): string | null {
  return filename ? filename.replace(/\.[^.]+$/, '') : null;
}

function preserveExtension(value: string, current: string | null): string {
  const extension = current?.match(/\.[^.]+$/)?.[0] ?? '';
  const cleaned = value.trim().slice(0, 200);
  return cleaned.endsWith(extension) ? cleaned : `${cleaned}${extension}`;
}

export class ChangeFeed {
  constructor(private readonly sqlite: Database) { initializeMobileSync(sqlite); }

  private toFeed(row: RecordingRow, seq: number): FeedRecording {
    return {
      type: 'recording', id: row.id, seq, revision: row.revision, retentionState: row.retention_state, deletedAt: row.deleted_at,
      title: title(row.original_filename), recordedAt: row.recorded_at, recordingType: row.recording_type, context: row.context,
      notes: row.notes, tags: parseTags(row.tags), status: row.status, fingerprint: row.fingerprint,
      durationSeconds: row.duration_seconds, sourceProvider: row.source_provider, sourceRecordingId: row.source_recording_id,
      transcriptHead: row.transcript_origin ? { versionId: row.transcript_version_id, origin: row.transcript_origin } : null,
    };
  }

  private recording(id: string): RecordingRow | null {
    return this.sqlite.query(`${RECORDING_SELECT} WHERE r.id = ?`).get(id) as RecordingRow | null;
  }

  head(): number {
    return (this.sqlite.query('SELECT COALESCE(MAX(seq), 0) AS seq FROM sync_changes').get() as { seq: number }).seq;
  }

  /**
   * Changes after `since`, one entry per recording carrying its *current* state (not a replay of
   * each intermediate edit). Tombstones are listed separately so peers can propagate trash,
   * restore, and purge events with their timestamps even when the recording no longer exists.
   */
  changes(since: string | undefined, limit = 200): FeedPage {
    const from = since === undefined || since === '' ? 0 : Number(since);
    if (!Number.isSafeInteger(from) || from < 0) throw new CursorExpired('Invalid cursor.');
    const head = this.head();
    if (from > head) throw new CursorExpired('The cursor is newer than this vault. Resynchronize from the beginning.');
    const size = Math.min(Math.max(1, Math.floor(limit) || 200), MAX_FEED_PAGE);
    const entities = this.sqlite.query(`SELECT entity_id AS id, MAX(seq) AS seq FROM sync_changes WHERE seq > ? AND entity = 'recording'
      GROUP BY entity_id ORDER BY seq LIMIT ?`).all(from, size) as { id: string; seq: number }[];
    const cursor = entities.length ? entities[entities.length - 1].seq : head;
    // Two queries per page, not one or two per recording.
    const ids = JSON.stringify(entities.map(entity => entity.id));
    const rows = new Map((this.sqlite.query(`${RECORDING_SELECT} WHERE r.id IN (SELECT value FROM json_each(?))`).all(ids) as RecordingRow[]).map(row => [row.id, row]));
    const missing = entities.filter(entity => !rows.has(entity.id)).map(entity => entity.id);
    const purges = new Map<string, number | null>();
    if (missing.length) {
      const purgeRows = this.sqlite.query(`SELECT recording_id AS id, revision FROM recording_tombstones
        WHERE event = 'purge' AND recording_id IN (SELECT value FROM json_each(?)) ORDER BY seq`).all(JSON.stringify(missing)) as { id: string; revision: number | null }[];
      for (const purge of purgeRows) purges.set(purge.id, purge.revision); // ascending seq: the latest purge wins
    }
    const changes = entities.map(({ id, seq }): FeedRecording | FeedPurged => {
      const row = rows.get(id);
      if (row) return this.toFeed(row, seq);
      return { type: 'purged', id, seq, revision: purges.get(id) ?? null };
    });
    const tombstones = (this.sqlite.query(`SELECT seq, recording_id, event, revision, fingerprint, source_provider, source_recording_id, at
      FROM recording_tombstones WHERE seq > ? AND seq <= ? ORDER BY seq`).all(from, cursor) as {
      seq: number; recording_id: string; event: Tombstone['event']; revision: number | null; fingerprint: string | null;
      source_provider: string | null; source_recording_id: string | null; at: string;
    }[]).map(row => ({ seq: row.seq, recordingId: row.recording_id, event: row.event, revision: row.revision, fingerprint: row.fingerprint,
      sourceProvider: row.source_provider, sourceRecordingId: row.source_recording_id, at: row.at }));
    return { cursor: String(cursor), hasMore: cursor < head, changes, tombstones };
  }

  /**
   * Applies queued client metadata edits. Each edit names the revision it was based on; a stale
   * edit is never merged over newer desktop state and comes back as a conflict carrying the
   * current record. Results are remembered per client and change ID, so a retry after a lost
   * response returns the original outcome instead of a false conflict.
   */
  push(clientId: string, input: unknown): ChangeResult[] {
    if (!Array.isArray(input)) throw new Error('Changes must be a list.');
    if (input.length > 200) throw new Error('Send at most 200 changes per request.');
    return input.map(raw => this.sqlite.transaction(() => this.apply(clientId, raw))());
  }

  private apply(clientId: string, raw: unknown): ChangeResult {
    const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const changeId = typeof value.changeId === 'string' ? value.changeId.slice(0, 100) : '';
    const recordingId = typeof value.recordingId === 'string' ? value.recordingId : '';
    if (!changeId || !recordingId) return { changeId, recordingId, status: 'invalid', error: 'changeId and recordingId are required.' };
    const previous = this.sqlite.query('SELECT result FROM sync_applied_changes WHERE client_id = ? AND change_id = ?').get(clientId, changeId) as { result: string } | null;
    if (previous) return JSON.parse(previous.result) as ChangeResult;
    const result = this.evaluate(changeId, recordingId, value);
    // Only final outcomes are remembered; a conflict may be resubmitted after the client rebases.
    if (result.status === 'applied') {
      this.sqlite.query('INSERT INTO sync_applied_changes (client_id, change_id, result) VALUES (?, ?, ?)').run(clientId, changeId, JSON.stringify(result));
    }
    return result;
  }

  private evaluate(changeId: string, recordingId: string, value: Record<string, unknown>): ChangeResult {
    const baseRevision = value.baseRevision;
    const fields = (value.fields && typeof value.fields === 'object' ? value.fields : null) as Record<string, unknown> | null;
    if (!Number.isSafeInteger(baseRevision) || !fields) return { changeId, recordingId, status: 'invalid', error: 'baseRevision and fields are required.' };
    const unknown = Object.keys(fields).filter(key => !(EDITABLE as readonly string[]).includes(key));
    if (unknown.length) return { changeId, recordingId, status: 'invalid', error: `Field ${unknown[0]} cannot be changed from a client.` };
    const row = this.recording(recordingId);
    if (!row) return { changeId, recordingId, status: 'not_found', error: 'Recording not found.' };
    if (row.revision !== baseRevision) return { changeId, recordingId, status: 'conflict', current: this.toFeed(row, this.head()) };
    if (row.retention_state !== 'active') return { changeId, recordingId, status: 'trashed', error: 'Restore this recording before editing it.' };
    const next: Record<string, unknown> = {};
    const text = (key: string, max: number, nullable: boolean) => {
      if (!(key in fields)) return;
      const v = fields[key];
      if (v === null && nullable) { next[key] = null; return; }
      if (typeof v !== 'string') throw new Error(`${key} must be text.`);
      next[key] = v.slice(0, max);
    };
    try {
      text('title', 200, false); text('context', 5000, true); text('notes', 20000, true); text('recordingType', 40, false); text('recordedAt', 64, false);
      if ('tags' in fields) {
        if (!Array.isArray(fields.tags) || fields.tags.some(t => typeof t !== 'string')) throw new Error('tags must be a list of text.');
        next.tags = JSON.stringify((fields.tags as string[]).map(t => t.trim().slice(0, 60)).filter(Boolean).slice(0, 50));
      }
      if (typeof next.title === 'string' && !next.title.trim()) throw new Error('title cannot be empty.');
      if (typeof next.recordedAt === 'string' && Number.isNaN(Date.parse(next.recordedAt))) throw new Error('recordedAt must be a date.');
    } catch (error) {
      return { changeId, recordingId, status: 'invalid', error: (error as Error).message };
    }
    const updated = this.sqlite.query(`UPDATE recordings SET
        original_filename = COALESCE(?, original_filename), context = CASE WHEN ? THEN ? ELSE context END,
        notes = CASE WHEN ? THEN ? ELSE notes END, tags = COALESCE(?, tags), recording_type = COALESCE(?, recording_type),
        recorded_at = COALESCE(?, recorded_at), revision = revision + 1
      WHERE id = ? AND revision = ? RETURNING revision`).get(
      typeof next.title === 'string' ? preserveExtension(next.title, row.original_filename) : null,
      'context' in next ? 1 : 0, (next.context ?? null) as string | null,
      'notes' in next ? 1 : 0, (next.notes ?? null) as string | null,
      (next.tags ?? null) as string | null, (next.recordingType ?? null) as string | null, (next.recordedAt ?? null) as string | null,
      recordingId, baseRevision as number);
    // `changes` would also count the feed triggers' rows, so check the returned row instead.
    if (!updated) return { changeId, recordingId, status: 'conflict', current: this.toFeed(this.recording(recordingId)!, this.head()) };
    return { changeId, recordingId, status: 'applied', revision: (baseRevision as number) + 1 };
  }
}
