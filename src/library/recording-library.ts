import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { copyFile, open, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { db } from '../db/client';
import { recordings, transcriptVersions, transcripts } from '../db/schema';
import { and, eq, or } from 'drizzle-orm';

export const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.webm', '.aac', '.flac']);
export const TRASH_RETENTION_DAYS = 30;

export class RecordingImportConflict extends Error {}

export type RecordingProvenance = {
  sourceProvider: 'plaud' | 'opennotes' | 'upload';
  sourceRecordingId?: string | null;
  sourceTransport: 'export' | 'folder' | 'mobile' | 'upload' | 'ble';
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
}): Promise<{ recording: ImportedRecording; added: boolean }> {
  const sourcePath = resolve(params.sourcePath);
  if (!existsSync(sourcePath) || !isSupportedAudio(sourcePath)) {
    throw new Error('The selected file is not a supported audio recording.');
  }

  const fingerprint = await fingerprintFile(sourcePath);
  if (params.expectedFingerprint && params.expectedFingerprint !== fingerprint) {
    throw new RecordingImportConflict('Audio fingerprint mismatch. Keep the local recording and retry.');
  }
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
  mkdirSync(vaultDir, { recursive: true });
  const destination = join(vaultDir, `${id}${extension}`);
  await copyFile(sourcePath, destination);
  const durableFile = await open(destination, 'r+');
  try { await durableFile.sync(); } finally { await durableFile.close(); }
  const fileStats = await stat(destination);
  const originalFilename = params.originalFilename ?? basename(sourcePath);
  const recordedAt = params.provenance.recordedAt ?? metadata.startTime ?? fileStats.mtime.toISOString();

  try {
    await db.insert(recordings).values({
      id,
      filePath: destination,
      originalFilename,
      fileSizeBytes: fileStats.size,
      durationSeconds: params.metadata?.durationMs == null ? null : Math.round(params.metadata.durationMs / 1000),
      recordingType: params.metadata?.recordingType ?? inferRecordingType(originalFilename),
      context: params.metadata?.context ?? null,
      status: 'pending',
      recordedAt,
      sourceProvider: params.provenance.sourceProvider,
      sourceRecordingId,
      sourceTransport: params.provenance.sourceTransport,
      fingerprint,
      retentionState: 'active',
      revision: 1,
      notes: params.metadata?.notes ?? null,
      tags: params.metadata?.tags ?? [],
    });
  } catch (error) {
    await unlink(destination).catch(() => undefined);
    throw error;
  }

  return {
    added: true,
    recording: { id, filePath: destination, originalFilename, fingerprint, sourceRecordingId },
  };
}

export async function replaceRecordingAudio(params: {
  recordingId: string;
  sourcePath: string;
  expectedRevision?: number;
  originalFilename?: string;
}): Promise<void> {
  const [recording] = await db.select().from(recordings).where(eq(recordings.id, params.recordingId)).limit(1);
  if (!recording) throw new Error('Recording not found.');
  if (params.expectedRevision !== undefined && recording.revision !== params.expectedRevision) {
    throw new Error('revision_conflict');
  }
  if (!isSupportedAudio(params.sourcePath)) throw new Error('Unsupported audio format.');

  const extension = extname(params.sourcePath).toLowerCase();
  const destination = join(dirname(recording.filePath), `${recording.id}${extension}`);
  const staged = `${destination}.replacement`;
  await copyFile(params.sourcePath, staged);
  const fingerprint = await fingerprintFile(staged);
  const fileStats = await stat(staged);
  await rename(staged, destination);
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

export async function saveTranscriptVersion(params: {
  recordingId: string;
  fullText: string;
  segments?: unknown;
  origin: 'generated' | 'edited';
}): Promise<void> {
  await db.insert(transcriptVersions).values({
    recordingId: params.recordingId,
    fullText: params.fullText,
    segments: params.segments,
    origin: params.origin,
  });
}

export async function softDeleteRecording(recordingId: string): Promise<boolean> {
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

export async function purgeRecording(recordingId: string): Promise<boolean> {
  const [recording] = await db.select().from(recordings).where(and(
    eq(recordings.id, recordingId),
    eq(recordings.retentionState, 'trash'),
  )).limit(1);
  if (!recording) return false;
  await unlink(recording.filePath).catch(() => undefined);
  await db.delete(recordings).where(eq(recordings.id, recordingId));
  return true;
}

export async function purgeExpiredTrash(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const trashed = await db.select().from(recordings).where(eq(recordings.retentionState, 'trash'));
  let purged = 0;
  for (const recording of trashed) {
    if (recording.deletedAt && new Date(recording.deletedAt) <= cutoff) {
      if (await purgeRecording(recording.id)) purged += 1;
    }
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
