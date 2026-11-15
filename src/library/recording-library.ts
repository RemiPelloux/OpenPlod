import { withRecordingLease } from './recording-lease';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { db, sqlite } from '../db/client';
import { durableCopy, durableWrite, ensureDiskSpace, fsyncDirectory, fsyncFile, sha256File } from './durable-files';
import { beginImport, finishImport, insertRecordingRow, markImportPlaced } from './import-journal';
import { purgeRecordingData } from './purge';
import { recordings, transcripts, userSettings } from '../db/schema';
import { and, eq, or } from 'drizzle-orm';

export const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.webm', '.aac', '.flac']);
export const TRASH_RETENTION_DAYS = 30;

export class RecordingImportConflict extends Error {}

export type RecordingProvenance = {
  sourceProvider: 'plaud' | 'opennotes' | 'upload';
  sourceRecordingId?: string | null;
  sourceTransport: 'export' | 'folder' | 'mobile' | 'upload' | 'ble' | 'cloud';
  recordedAt?: string | null;
};

export type ImportedRecording = {
  id: string;
  filePath: string;
  originalFilename: string;
  fingerprint: string;
  sourceRecordingId: string | null;
};

export async function fingerprintFile(filePath: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

export function isSupportedAudio(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/** Staging directory used while an incoming file is imported into the vault. */
export function incomingDirectory(): string {
  return resolve(dirname(resolve(process.env.OPENPLOD_LIBRARY_PATH || './data/recordings')), 'incoming');
}

/** Replaces characters that are not safe in a filename. */
/** The configured Plaud sync folder (setting, then `PLAUD_SYNC_PATH`), with `~/` expanded. */
export async function configuredSyncPath(): Promise<string | null> {
  const [setting] = await db.select({ value: userSettings.value }).from(userSettings)
    .where(eq(userSettings.key, 'syncFolderPath')).limit(1);
  const raw = setting?.value || process.env.PLAUD_SYNC_PATH;
  if (!raw) return null;
  return resolve(raw.startsWith('~/') ? `${homedir()}/${raw.slice(2)}` : raw);
}

export function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'recording.m4a';
}

export async function importRecordingFile(params: {
  sourcePath: string;
  provenance: RecordingProvenance;
  originalFilename?: string;
  expectedFingerprint?: string;
  metadata?: {
    context?: string | null;
    notes?: string | null;
    recordingType?: string;
    tags?: string[];
    durationMs?: number;
  };
  /** Written to `originals/<id>/` before the recording row is committed (REL-03). */
  sidecars?: ImportSidecar[];
}): Promise<{ recording: ImportedRecording; added: boolean }> {
  const sourcePath = resolve(params.sourcePath);
  if (!existsSync(sourcePath) || !isSupportedAudio(sourcePath)) {
    throw new Error('The selected file is not a supported audio recording.');
  }

  const fingerprint = await fingerprintFile(sourcePath);
  if (params.expectedFingerprint && params.expectedFingerprint !== fingerprint) {
    throw new RecordingImportConflict('Audio fingerprint mismatch. Keep the local recording and retry.');
  }
  // Two imports of the same audio (a startup sync racing a manual one) would both pass the
  // duplicate check before either inserts; serialize them so the second sees the first.
  return withImportLock(fingerprint, () => insertImportedRecording(params, sourcePath, fingerprint));
}

const importLocks = new Map<string, Promise<unknown>>();
async function withImportLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const current = (importLocks.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
  importLocks.set(key, current);
  try { return await current; }
  finally { if (importLocks.get(key) === current) importLocks.delete(key); }
}

async function insertImportedRecording(params: Parameters<typeof importRecordingFile>[0], sourcePath: string, fingerprint: string): Promise<{ recording: ImportedRecording; added: boolean }> {
  const metadata = readPlaudMetadata(sourcePath);
  const sourceRecordingId = params.provenance.sourceRecordingId ?? metadata.id ?? null;
  const duplicateConditions = [eq(recordings.fingerprint, fingerprint)];
  if (sourceRecordingId) duplicateConditions.push(and(
    eq(recordings.sourceRecordingId, sourceRecordingId),
    eq(recordings.sourceProvider, params.provenance.sourceProvider),
  )!);
  const [existing] = await db.select().from(recordings).where(or(...duplicateConditions)).limit(1);
  if (existing) {
    if (params.expectedFingerprint && (existing.fingerprint !== fingerprint || !existsSync(existing.filePath))) {
      throw new RecordingImportConflict('This source ID already exists with different or missing audio. Local audio retained.');
    }
    // Import idempotency must not replace original evidence on a duplicate request.
    if (existing.fingerprint === fingerprint && existsSync(existing.filePath)) await attachMissingSidecars(existing, params.sidecars ?? []);
    return {
      added: false,
      recording: {
        id: existing.id,
        filePath: existing.filePath,
        originalFilename: existing.originalFilename ?? params.originalFilename ?? basename(sourcePath),
        fingerprint: existing.fingerprint ?? fingerprint,
        sourceRecordingId: existing.sourceRecordingId,
      },
    };
  }

  const id = crypto.randomUUID();
  const extension = extname(sourcePath).toLowerCase();
  const vaultDir = resolve(process.env.OPENPLOD_LIBRARY_PATH || './data/recordings');
  mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
  const destination = join(vaultDir, `${id}${extension}`);
  const sidecars = params.sidecars ?? [];
  const originalsDirectory = sidecars.length ? join(vaultDir, 'originals', id) : null;
  const sourceStats = await stat(sourcePath);
  const originalFilename = params.originalFilename ?? basename(sourcePath);
  const recordedAt = params.provenance.recordedAt ?? metadata.startTime ?? sourceStats.mtime.toISOString();
  await ensureDiskSpace(vaultDir, sourceStats.size + await sidecarBytes(sidecars));

  const row = {
    id, file_path: destination, original_filename: originalFilename, file_size_bytes: sourceStats.size,
    duration_seconds: params.metadata?.durationMs == null ? null : Math.round(params.metadata.durationMs / 1000),
    recording_type: params.metadata?.recordingType ?? inferRecordingType(originalFilename),
    context: params.metadata?.context ?? null, status: 'pending', recorded_at: recordedAt,
    source_provider: params.provenance.sourceProvider, source_recording_id: sourceRecordingId,
    source_transport: params.provenance.sourceTransport, fingerprint, retention_state: 'active', revision: 1,
    notes: params.metadata?.notes ?? null, tags: JSON.stringify(params.metadata?.tags ?? []),
  };
  // REL-03: stage and fsync every file, place them with renames, then commit the row and journal together.
  const stagingDirectory = join(vaultDir, '.staging', id);
  beginImport(sqlite, { id, stagingDirectory, destination, originalsDirectory, fingerprint, row: JSON.stringify(row) });
  try {
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
    const stagedAudio = join(stagingDirectory, `audio${extension}`);
    await durableCopy(sourcePath, stagedAudio);
    if (await sha256File(stagedAudio) !== fingerprint) throw new Error('Audio changed while it was being imported. Nothing was imported; retry.');
    const stagedOriginals = join(stagingDirectory, 'originals');
    if (originalsDirectory) await stageSidecars(stagedOriginals, sidecars);
    await fsyncDirectory(stagingDirectory);
    if (originalsDirectory) {
      await mkdir(dirname(originalsDirectory), { recursive: true, mode: 0o700 });
      await rename(stagedOriginals, originalsDirectory);
      await fsyncDirectory(dirname(originalsDirectory));
    }
    await rename(stagedAudio, destination);
    await fsyncDirectory(vaultDir);
    markImportPlaced(sqlite, id);
    sqlite.transaction(() => { insertRecordingRow(sqlite, row); finishImport(sqlite, id); })();
  } catch (error) {
    // The source file is untouched, so removing the vault's own copies loses nothing.
    await unlink(destination).catch(() => undefined);
    if (originalsDirectory) await rm(originalsDirectory, { recursive: true, force: true }).catch(() => undefined);
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    finishImport(sqlite, id);
    throw error;
  }
  await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);

  return {
    added: true,
    recording: { id, filePath: destination, originalFilename, fingerprint, sourceRecordingId },
  };
}

/** A file kept beside the playable audio in `originals/<id>/` (device bytes, decoded audio, provenance). */
export type ImportSidecar = { name: string; sourcePath?: string; data?: string | Uint8Array };

async function sidecarBytes(sidecars: ImportSidecar[]) {
  let total = 0;
  for (const sidecar of sidecars) total += sidecar.sourcePath ? (await stat(sidecar.sourcePath)).size : Buffer.byteLength(sidecar.data ?? '');
  return total;
}

async function stageSidecars(directory: string, sidecars: ImportSidecar[]) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const sidecar of sidecars) {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(sidecar.name) || sidecar.name.startsWith('.')) throw new Error('Invalid sidecar name');
    const target = join(directory, sidecar.name);
    if (sidecar.sourcePath) await durableCopy(sidecar.sourcePath, target);
    else await durableWrite(target, sidecar.data ?? '');
  }
  await fsyncDirectory(directory);
}

/** Adds sidecars to an existing recording that has none yet, without replacing existing evidence. */
async function attachMissingSidecars(recording: { id: string; filePath: string }, sidecars: ImportSidecar[]) {
  if (!sidecars.length) return;
  const originalsDirectory = join(dirname(recording.filePath), 'originals', recording.id);
  if (existsSync(originalsDirectory)) return;
  const library = dirname(recording.filePath);
  await ensureDiskSpace(library, await sidecarBytes(sidecars));
  const staging = join(library, '.staging', `${recording.id}-sidecars-${Date.now()}`);
  try {
    await stageSidecars(staging, sidecars);
    await mkdir(dirname(originalsDirectory), { recursive: true, mode: 0o700 });
    await rename(staging, originalsDirectory);
    await fsyncDirectory(dirname(originalsDirectory));
  } finally { await rm(staging, { recursive: true, force: true }).catch(() => undefined); }
}

export async function replaceRecordingAudio(params: Parameters<typeof replaceRecordingAudioUnlocked>[0]): Promise<void> {
  return withRecordingLease(params.recordingId, () => replaceRecordingAudioUnlocked(params));
}

async function replaceRecordingAudioUnlocked(params: {
  recordingId: string;
  sourcePath: string;
  expectedRevision?: number;
  originalFilename?: string;
}): Promise<void> {
  const [recording] = await db.select().from(recordings).where(eq(recordings.id, params.recordingId)).limit(1);
  if (!recording) throw new Error('Recording not found.');
  if (recording.retentionState !== 'active') throw new Error('Restore this recording from Trash before replacing its audio.');
  if (params.expectedRevision !== undefined && recording.revision !== params.expectedRevision) {
    throw new Error('revision_conflict');
  }
  if (!isSupportedAudio(params.sourcePath)) throw new Error('Unsupported audio format.');

  const extension = extname(params.sourcePath).toLowerCase();
  const destination = join(dirname(recording.filePath), `${recording.id}${extension}`);
  const staged = `${destination}.replacement`;
  await ensureDiskSpace(dirname(destination), (await stat(params.sourcePath)).size);
  await unlink(staged).catch(() => undefined);
  await copyFile(params.sourcePath, staged);
  await fsyncFile(staged);
  const fingerprint = await fingerprintFile(staged);
  const fileStats = await stat(staged);
  await rename(staged, destination);
  await fsyncDirectory(dirname(destination));
  if (destination !== recording.filePath) await unlink(recording.filePath).catch(() => undefined);
  await db.update(recordings).set({
    filePath: destination,
    originalFilename: params.originalFilename ?? basename(params.sourcePath),
    fileSizeBytes: fileStats.size,
    fingerprint,
    status: 'pending',
    processedAt: null,
    errorMessage: null,
    revision: recording.revision + 1,
  }).where(eq(recordings.id, recording.id));
}

export async function softDeleteRecording(recordingId: string): Promise<boolean> {
  return withRecordingLease(recordingId, () => softDeleteRecordingUnlocked(recordingId));
}

async function softDeleteRecordingUnlocked(recordingId: string): Promise<boolean> {
  const [recording] = await db.select().from(recordings).where(eq(recordings.id, recordingId)).limit(1);
  if (!recording) return false;
  await db.update(recordings).set({
    retentionState: 'trash',
    deletedAt: new Date().toISOString(),
    revision: recording.revision + 1,
  }).where(eq(recordings.id, recordingId));
  return true;
}

export async function restoreRecording(recordingId: string): Promise<boolean> {
  const [recording] = await db.select().from(recordings).where(and(
    eq(recordings.id, recordingId),
    eq(recordings.retentionState, 'trash'),
  )).limit(1);
  if (!recording) return false;
  await db.update(recordings).set({
    retentionState: 'active',
    deletedAt: null,
    revision: recording.revision + 1,
  }).where(eq(recordings.id, recordingId));
  return true;
}

/** Confirmed purge of a recording in Trash (REL-04); see `purge.ts` for exactly what is removed. */
export async function purgeRecording(recordingId: string): Promise<boolean> {
  return Boolean(await purgeRecordingData(sqlite, recordingId, { reason: 'manual' }));
}

export async function purgeExpiredTrash(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const trashed = await db.select({
    id: recordings.id,
    deletedAt: recordings.deletedAt,
  }).from(recordings).where(eq(recordings.retentionState, 'trash'));
  const expired = trashed.filter(recording => recording.deletedAt && new Date(recording.deletedAt) <= cutoff);
  let purged = 0;
  for (const recording of expired) {
    if (await purgeRecordingData(sqlite, recording.id, { reason: 'trash-expiry', now })) purged++;
  }
  return purged;
}

export { updateTranscript } from './transcript-history';

function readPlaudMetadata(sourcePath: string): { id?: string; startTime?: string } {
  const metadataPath = join(dirname(sourcePath), 'metadata.json');
  if (!existsSync(metadataPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(metadataPath, 'utf8')) as Record<string, unknown>;
    return {
      id: typeof parsed.id === 'string' ? parsed.id : undefined,
      startTime: typeof parsed.startTime === 'string' ? parsed.startTime : undefined,
    };
  } catch {
    return {};
  }
}

export function inferRecordingType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.includes('class') || lower.includes('lecture')) return 'class';
  if (lower.includes('meeting') || lower.includes('call')) return 'meeting';
  if (lower.includes('conversation') || lower.includes('chat')) return 'conversation';
  return 'other';
}
