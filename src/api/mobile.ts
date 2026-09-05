import { Hono } from 'hono';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { importRecordingFile, RecordingImportConflict } from '../library/recording-library';
import { queueRecordingProcessing } from '../library/processing';
import { PlaudDeviceAuth, readDeviceCredentials } from '../sync/plaud-device-auth';

const app = new Hono();
const deviceAuth = new PlaudDeviceAuth();

app.use('*', async (c, next) => {
  const expected = process.env.OPENPLOD_PAIRING_TOKEN;
  if (!expected) return c.json({ success: false, error: 'Mobile pairing is not configured.' }, 503);
  if (c.req.header('X-OpenPlod-Token') !== expected) {
    return c.json({ success: false, error: 'Invalid pairing token.' }, 401);
  }
  await next();
});

app.get('/health', c => c.json({ success: true, data: { vault: 'ready' } }));

app.post('/plaud/session', async c => {
  c.header('Cache-Control', 'no-store');
  try {
    return c.json({ success: true, data: await deviceAuth.session(await readDeviceCredentials()) });
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Plaud SDK authentication failed.' }, 503);
  }
});

app.post('/recordings', async c => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.json({ success: false, error: 'Audio file is required.' }, 400);
  if (!file.size) return c.json({ success: false, error: 'Audio file is empty.' }, 400);
  const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint : undefined;
  if (fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(fingerprint)) {
    return c.json({ success: false, error: 'A SHA-256 fingerprint is required.' }, 400);
  }
  const durationMs = body.duration_ms === undefined ? undefined : Number(body.duration_ms);
  if (durationMs !== undefined && (!Number.isSafeInteger(durationMs) || durationMs < 0)) {
    return c.json({ success: false, error: 'Invalid recording duration.' }, 400);
  }
  const libraryPath = process.env.OPENPLOD_LIBRARY_PATH;
  const incomingDir = libraryPath ? resolve(dirname(libraryPath), 'incoming') : resolve('./data/incoming');
  mkdirSync(incomingDir, { recursive: true });
  const incomingPath = resolve(incomingDir, `${crypto.randomUUID()}-${safeFilename(file.name)}`);
  await Bun.write(incomingPath, file);
  try {
    const result = await importRecordingFile({
      sourcePath: incomingPath,
      originalFilename: safeFilename(file.name),
      expectedFingerprint: fingerprint,
      provenance: {
        sourceProvider: body.source_provider === 'plaud' ? 'plaud' : 'opennotes',
        sourceRecordingId: typeof body.source_recording_id === 'string' ? body.source_recording_id : null,
        sourceTransport: 'mobile',
        recordedAt: typeof body.recorded_at === 'string' ? body.recorded_at : null,
      },
      metadata: {
        durationMs,
        context: typeof body.context === 'string' ? body.context : null,
        recordingType: typeof body.recording_type === 'string' ? body.recording_type : undefined,
      },
    });
    if (result.added) {
      await queueRecordingProcessing({
        recordingId: result.recording.id,
        filePath: result.recording.filePath,
      });
    }
    return c.json({
      success: true,
      data: { recordingId: result.recording.id, fingerprint: result.recording.fingerprint, added: result.added },
    }, result.added ? 201 : 200);
  } catch (error) {
    if (error instanceof RecordingImportConflict) return c.json({ success: false, error: error.message }, 409);
    throw error;
  } finally {
    await Bun.file(incomingPath).delete().catch(() => undefined);
  }
});

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'recording.m4a';
}

export default app;
