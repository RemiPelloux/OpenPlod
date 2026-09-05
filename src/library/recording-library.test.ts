import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const testRoot = mkdtempSync(join(tmpdir(), 'openplod-library-'));
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousLibraryPath = process.env.OPENPLOD_LIBRARY_PATH;
const previousPairingToken = process.env.OPENPLOD_PAIRING_TOKEN;
process.env.DATABASE_URL = join(testRoot, 'library.db');
process.env.OPENPLOD_LIBRARY_PATH = join(testRoot, 'vault');
process.env.OPENPLOD_PAIRING_TOKEN = 'test-pairing-token';

const { db, sqlite } = await import('../db/client');
const { initializeDatabase } = await import('../db/setup');
const { recordings, transcripts, transcriptVersions } = await import('../db/schema');
const {
  importRecordingFile,
  purgeExpiredTrash,
  restoreRecording,
  softDeleteRecording,
  updateTranscript,
} = await import('./recording-library');
const { default: mobileApi } = await import('../api/mobile');
const { default: recordingsApi } = await import('../api/recordings');
const { FolderWatcher } = await import('../sync/folder-watcher');

beforeAll(() => initializeDatabase());

afterAll(() => {
  sqlite.close();
  rmSync(testRoot, { recursive: true, force: true });
  restoreEnv('DATABASE_URL', previousDatabaseUrl);
  restoreEnv('OPENPLOD_LIBRARY_PATH', previousLibraryPath);
  restoreEnv('OPENPLOD_PAIRING_TOKEN', previousPairingToken);
});

describe('recording library', () => {
  test('discovers nested Plaud exports and ignores unsupported files', () => {
    const exportRoot = join(testRoot, 'plaud-exports');
    const nested = join(exportRoot, '2026-09-05_voice-note');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(exportRoot, 'meeting.M4A'), 'audio-one');
    writeFileSync(join(nested, 'voice-note.opus'), 'unsupported');
    writeFileSync(join(nested, 'voice-note.wav'), 'audio-two');
    writeFileSync(join(exportRoot, 'metadata.json'), '{}');

    const recordings = new FolderWatcher(exportRoot).listRecordings();

    expect(recordings.map(recording => recording.filename).sort()).toEqual([
      'meeting.M4A',
      'voice-note.wav',
    ]);
    expect(recordings.every(recording => recording.size > 0)).toBe(true);
  });

  test('reports a missing Plaud export folder as not configured', () => {
    const watcher = new FolderWatcher(join(testRoot, 'missing-plaud-folder'));

    expect(watcher.isConfigured()).toBe(false);
    expect(watcher.listRecordings()).toEqual([]);
    expect(watcher.getStatus()).toMatchObject({ configured: false, recordingCount: 0 });
  });

  test('deduplicates imports by content fingerprint and provider id', async () => {
    const firstPath = join(testRoot, 'first.m4a');
    const sameAudioPath = join(testRoot, 'same-audio.m4a');
    const sameProviderPath = join(testRoot, 'same-provider.m4a');
    writeFileSync(firstPath, 'audio-one');
    writeFileSync(sameAudioPath, 'audio-one');
    writeFileSync(sameProviderPath, 'different-audio');

    const first = await importRecordingFile({
      sourcePath: firstPath,
      provenance: {
        sourceProvider: 'plaud',
        sourceRecordingId: 'plaud-1',
        sourceTransport: 'folder',
      },
    });
    const fingerprintDuplicate = await importRecordingFile({
      sourcePath: sameAudioPath,
      provenance: { sourceProvider: 'plaud', sourceTransport: 'folder' },
    });
    const providerDuplicate = await importRecordingFile({
      sourcePath: sameProviderPath,
      provenance: {
        sourceProvider: 'plaud',
        sourceRecordingId: 'plaud-1',
        sourceTransport: 'folder',
      },
    });

    expect(first.added).toBe(true);
    expect(fingerprintDuplicate).toMatchObject({ added: false, recording: { id: first.recording.id } });
    expect(providerDuplicate).toMatchObject({ added: false, recording: { id: first.recording.id } });
  });

  test('versions transcript edits without replacing their provenance', async () => {
    const sourcePath = join(testRoot, 'transcript.m4a');
    writeFileSync(sourcePath, 'transcript-audio');
    const imported = await importRecordingFile({
      sourcePath,
      provenance: { sourceProvider: 'upload', sourceTransport: 'upload' },
    });
    await db.insert(transcripts).values({
      recordingId: imported.recording.id,
      fullText: 'Generated text',
      wordCount: 2,
    });

    await updateTranscript({ recordingId: imported.recording.id, fullText: 'User corrected text' });

    const [current] = await db.select().from(transcripts)
      .where(eq(transcripts.recordingId, imported.recording.id));
    const versions = await db.select().from(transcriptVersions)
      .where(eq(transcriptVersions.recordingId, imported.recording.id));
    expect(current.fullText).toBe('User corrected text');
    expect(current.wordCount).toBe(3);
    expect(versions).toEqual([
      expect.objectContaining({ fullText: 'User corrected text', origin: 'edited' }),
    ]);
  });

  test('soft deletes, restores, and purges expired trash with its audio', async () => {
    const sourcePath = join(testRoot, 'retention.m4a');
    writeFileSync(sourcePath, 'retention-audio');
    const imported = await importRecordingFile({
      sourcePath,
      provenance: { sourceProvider: 'upload', sourceTransport: 'upload' },
    });

    expect(await softDeleteRecording(imported.recording.id)).toBe(true);
    expect(await restoreRecording(imported.recording.id)).toBe(true);
    expect(await softDeleteRecording(imported.recording.id)).toBe(true);
    await db.update(recordings).set({ deletedAt: '2026-01-01T00:00:00.000Z' })
      .where(eq(recordings.id, imported.recording.id));

    expect(await purgeExpiredTrash(new Date('2026-02-01T00:00:00.000Z'))).toBe(1);
    expect(await Bun.file(imported.recording.filePath).exists()).toBe(false);
    expect(await db.select().from(recordings).where(eq(recordings.id, imported.recording.id))).toEqual([]);
  });

  test('requires explicit confirmation before permanently purging audio', async () => {
    const sourcePath = join(testRoot, 'confirmed-purge.m4a');
    writeFileSync(sourcePath, 'confirmed-purge-audio');
    const imported = await importRecordingFile({
      sourcePath,
      provenance: { sourceProvider: 'upload', sourceTransport: 'upload' },
    });
    await softDeleteRecording(imported.recording.id);

    const rejected = await recordingsApi.request(`/${imported.recording.id}?permanent=true`, {
      method: 'DELETE',
    });
    expect(rejected.status).toBe(400);
    expect(await Bun.file(imported.recording.filePath).exists()).toBe(true);

    const confirmed = await recordingsApi.request(
      `/${imported.recording.id}?permanent=true&confirm=true`,
      { method: 'DELETE' },
    );
    expect(confirmed.status).toBe(200);
    expect(await Bun.file(imported.recording.filePath).exists()).toBe(false);
  });
});

describe('mobile pairing', () => {
  test('rejects missing or invalid pairing tokens', async () => {
    const missing = await mobileApi.request('/health');
    const invalid = await mobileApi.request('/health', {
      headers: { 'X-OpenPlod-Token': 'wrong' },
    });

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
  });

  test('accepts the configured pairing token', async () => {
    const response = await mobileApi.request('/health', {
      headers: { 'X-OpenPlod-Token': 'test-pairing-token' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { vault: 'ready' } });
  });

  test('returns a durable recording id after storing a mobile capture', async () => {
    const body = new FormData();
    body.append('file', new File(['mobile-audio'], 'phone-note.webm', { type: 'audio/webm' }));
    body.append('source_provider', 'opennotes');
    body.append('recorded_at', '2026-09-05T08:30:00.000Z');
    body.append('context', 'Captured from the phone');

    const response = await mobileApi.request('/recordings', {
      method: 'POST',
      headers: { 'X-OpenPlod-Token': 'test-pairing-token' },
      body,
    });
    const payload = await response.json() as {
      success: boolean;
      data: { recordingId: string; added: boolean };
    };

    expect(response.status).toBe(201);
    expect(payload.success).toBe(true);
    expect(payload.data.added).toBe(true);
    expect(payload.data.recordingId).toBeString();
    const [stored] = await db.select().from(recordings)
      .where(eq(recordings.id, payload.data.recordingId));
    expect(stored).toMatchObject({
      sourceProvider: 'opennotes',
      sourceTransport: 'mobile',
      context: 'Captured from the phone',
    });
    expect(await Bun.file(stored.filePath).exists()).toBe(true);
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
