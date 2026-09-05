import { Hono } from 'hono';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { importRecordingFile } from '../library/recording-library';
import { queueRecordingProcessing } from '../library/processing';

const app = new Hono();

app.use('*', async (c, next) => {
  const expected = process.env.OPENPLOD_PAIRING_TOKEN;
  if (!expected) return c.json({ success: false, error: 'Mobile pairing is not configured.' }, 503);
  if (c.req.header('X-OpenPlod-Token') !== expected) {
    return c.json({ success: false, error: 'Invalid pairing token.' }, 401);
  }
  await next();
});

app.get('/health', c => c.json({ success: true, data: { vault: 'ready' } }));

app.post('/recordings', async c => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.json({ success: false, error: 'Audio file is required.' }, 400);
  const libraryPath = process.env.OPENPLOD_LIBRARY_PATH;
  const incomingDir = libraryPath ? resolve(dirname(libraryPath), 'incoming') : resolve('./data/incoming');
  mkdirSync(incomingDir, { recursive: true });
  const incomingPath = resolve(incomingDir, `${crypto.randomUUID()}-${safeFilename(file.name)}`);
  await Bun.write(incomingPath, file);
  try {
    const result = await importRecordingFile({
      sourcePath: incomingPath,
      originalFilename: safeFilename(file.name),
      provenance: {
        sourceProvider: body.source_provider === 'plaud' ? 'plaud' : 'opennotes',
        sourceRecordingId: typeof body.source_recording_id === 'string' ? body.source_recording_id : null,
        sourceTransport: 'mobile',
        recordedAt: typeof body.recorded_at === 'string' ? body.recorded_at : null,
      },
      metadata: {
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
  } finally {
    await Bun.file(incomingPath).delete().catch(() => undefined);
  }
});

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'recording.m4a';
}

export default app;
