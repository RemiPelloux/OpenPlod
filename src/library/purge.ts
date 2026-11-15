import { withRecordingLease } from './recording-lease';
import type { Database } from 'bun:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { rm, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { purgeHooks, type PurgeContext } from './purge-hooks';

/**
 * REL-04: confirmed purge of one recording that is already in Trash.
 *
 * Removed inside one transaction: the recording row (cascading transcripts,
 * transcript versions, analyses, speaker mappings, bookmarks and the FTS index via
 * triggers), processing-job payloads, Plaud import events, document generation
 * records, and rows in known search/embedding tables when those tables exist.
 * AI chat turns that quoted the recording are redacted (question and answer removed,
 * state 'purged') rather than deleted, so a conversation keeps an audit marker
 * without the purged content. Documents in the Documents workspace are user
 * artifacts with their own Trash: they are kept and only unlinked from the source.
 * A tombstone row records the purge (IDs and fingerprint only, never content).
 *
 * After the commit: the audio file, originals/<id>/ sidecars and any Plaud resume
 * or quarantine `.part` files for the source session are deleted. Purge is not
 * certified secure erasure (see SECURITY.md).
 */

export type PurgeReport = {
  recordingId: string;
  removed: Record<string, number>;
  documentsUnlinked: number;
  aiTurnsRedacted: number;
  files: string[];
  fileErrors: string[];
  hookErrors: string[];
};

/** Search/embedding tables another module may create; purged when present. */
export const DERIVED_INDEX_TABLES = ['search_passages', 'embeddings', 'recording_embeddings', 'passage_embeddings', 'embedding_chunks', 'search_index'];

export function tableExists(database: Database, name: string) {
  return Boolean(database.query("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(name));
}
function hasColumn(database: Database, table: string, column: string) {
  return (database.query(`PRAGMA table_info("${table.replace(/"/g, '')}")`).all() as { name: string }[]).some(row => row.name === column);
}

export function ensureTombstoneTable(database: Database) {
  database.exec(`CREATE TABLE IF NOT EXISTS recording_purges (
    recording_id TEXT PRIMARY KEY, source_provider TEXT, source_recording_id TEXT, fingerprint TEXT,
    reason TEXT NOT NULL, purged_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_recording_purges_source ON recording_purges(source_provider, source_recording_id);`);
}

type RecordingRow = { id: string; filePath: string; sourceProvider: string | null; sourceRecordingId: string | null;
  sourceTransport: string | null; fingerprint: string | null; retentionState: string };

function loadRecording(database: Database, recordingId: string) {
  return database.query(`SELECT id, file_path AS filePath, source_provider AS sourceProvider, source_recording_id AS sourceRecordingId,
    source_transport AS sourceTransport, fingerprint, retention_state AS retentionState FROM recordings WHERE id=?`).get(recordingId) as RecordingRow | null;
}

/** Files on disk that belong only to this recording (resume parts are matched by Plaud serial and session). */
export function recordingFiles(recording: Pick<RecordingRow, 'id' | 'filePath' | 'sourceProvider' | 'sourceRecordingId'>, libraryDirectory: string) {
  const files = [recording.filePath, join(dirname(recording.filePath), 'originals', recording.id)];
  const incoming = join(dirname(resolve(libraryDirectory)), 'incoming');
  const source = recording.sourceProvider === 'plaud' ? /^([A-Za-z0-9]+):(\d+)$/.exec(recording.sourceRecordingId ?? '') : null;
  if (source) {
    for (const directory of [join(incoming, 'plaud-resume'), join(incoming, 'plaud-quarantine')]) {
      if (!existsSync(directory)) continue;
      for (const name of readdirSync(directory)) if (name.startsWith(`${source[1]}-${source[2]}-`)) files.push(join(directory, name));
    }
  }
  return files;
}

export async function purgeRecordingData(database: Database, recordingId: string,
  options: Parameters<typeof purgeRecordingDataUnlocked>[2] = {}): Promise<PurgeReport | null> {
  return withRecordingLease(recordingId, () => purgeRecordingDataUnlocked(database, recordingId, options));
}

async function purgeRecordingDataUnlocked(database: Database, recordingId: string, options: {
  libraryDirectory?: string; reason?: PurgeContext['reason']; requireTrash?: boolean; now?: Date;
} = {}): Promise<PurgeReport | null> {
  const recording = loadRecording(database, recordingId);
  if (!recording || ((options.requireTrash ?? true) && recording.retentionState !== 'trash')) return null;
  const libraryDirectory = resolve(options.libraryDirectory ?? process.env.OPENPLOD_LIBRARY_PATH ?? './data/recordings');
  const context: PurgeContext = {
    database, recordingId, filePath: recording.filePath, libraryDirectory,
    sourceProvider: recording.sourceProvider, sourceRecordingId: recording.sourceRecordingId, sourceTransport: recording.sourceTransport,
    fingerprint: recording.fingerprint, purgedAt: (options.now ?? new Date()).toISOString(), reason: options.reason ?? 'manual',
  };
  const report: PurgeReport = { recordingId, removed: {}, documentsUnlinked: 0, aiTurnsRedacted: 0, files: [], fileErrors: [], hookErrors: [] };
  const files = recordingFiles(recording, libraryDirectory);
  const hooks = purgeHooks();
  const count = (table: string, changes: number) => { if (changes) report.removed[table] = (report.removed[table] ?? 0) + changes; };

  database.transaction(() => {
    if (tableExists(database, 'processing_jobs')) count('processing_jobs', database.query(
      "DELETE FROM processing_jobs WHERE (CASE WHEN json_valid(payload) THEN json_extract(payload,'$.data.recordingId') END)=?").run(recordingId).changes);
    if (tableExists(database, 'plaud_import_events')) count('plaud_import_events', database.query('DELETE FROM plaud_import_events WHERE recording_id=?').run(recordingId).changes);
    if (tableExists(database, 'note_generations')) count('note_generations', database.query('DELETE FROM note_generations WHERE recording_id=?').run(recordingId).changes);
    if (tableExists(database, 'note_documents')) report.documentsUnlinked = database.query(
      'UPDATE note_documents SET source_recording_id=NULL, source_version_id=NULL, source_origin=NULL WHERE source_recording_id=?').run(recordingId).changes;
    if (tableExists(database, 'ai_turns')) report.aiTurnsRedacted = database.query(`UPDATE ai_turns SET question='[purged]', result=NULL, state='purged',
      recording_ids=(SELECT json_group_array(value) FROM json_each(ai_turns.recording_ids) WHERE value<>?1)
      WHERE EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ai_turns.recording_ids) THEN ai_turns.recording_ids ELSE '[]' END) WHERE value=?1)`).run(recordingId).changes;
    for (const table of DERIVED_INDEX_TABLES) {
      if (tableExists(database, table) && hasColumn(database, table, 'recording_id')) count(table, database.query(`DELETE FROM "${table}" WHERE recording_id=?`).run(recordingId).changes);
    }
    for (const hook of hooks) hook.inTransaction?.(context);
    ensureTombstoneTable(database);
    database.query(`INSERT INTO recording_purges(recording_id, source_provider, source_recording_id, fingerprint, reason, purged_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(recording_id) DO UPDATE SET purged_at=excluded.purged_at, reason=excluded.reason`)
      .run(recordingId, recording.sourceProvider, recording.sourceRecordingId, recording.fingerprint, context.reason, context.purgedAt);
    // `changes` also counts cascaded rows, so report the recording itself.
    count('recordings', database.query('DELETE FROM recordings WHERE id=?').run(recordingId).changes ? 1 : 0);
  })();

  for (const path of files) {
    if (!existsSync(path)) continue;
    try { await (path.endsWith(recording.id) ? rm(path, { recursive: true, force: true }) : unlink(path)); report.files.push(path); }
    catch (error) { report.fileErrors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  for (const hook of hooks) {
    try { await hook.afterCommit?.(context); }
    catch (error) { report.hookErrors.push(`${hook.name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (report.fileErrors.length || report.hookErrors.length) console.error('[Purge] Incomplete cleanup', { recordingId, fileErrors: report.fileErrors.length, hookErrors: report.hookErrors.length });
  return report;
}
