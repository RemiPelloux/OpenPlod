import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getConnInfo } from 'hono/bun';
import { PlaudEnrollment } from '../sync/plaud-enrollment';
import { loadIdentity } from '../sync/plaud-direct';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { db, sqlite } from '../db/client';
import { PlaudAutoImport } from '../sync/plaud-auto-import';
import { recordings, userSettings } from '../db/schema';
import { eq } from 'drizzle-orm';
import { fingerprintFile } from '../library/recording-library';
import { FolderWatcher } from '../sync/folder-watcher';
import { scanDesktopPlaud } from '../sync/desktop-plaud';
import { cancelDirectPlaud, directPlaudConfigured, importDirectPlaudRecording, readDirectPlaudRecordings } from '../sync/plaud-direct';

const app = new Hono();
app.use('*', bodyLimit({ maxSize: 16384 }));
export const automaticPlaud = new PlaudAutoImport(sqlite);
app.get('/auto-import', c => c.json({ success: true, data: automaticPlaud.status() }));
app.patch('/auto-import', async c => {
  try { const input = await c.req.json(); if (typeof input.enabled !== 'boolean') throw new Error('Import preference must be true or false.');
    return c.json({ success: true, data: automaticPlaud.set(input.enabled) }); }
  catch (e) { return c.json({ success: false, error: (e as Error).message }, 400); }
});
const enrollment = new PlaudEnrollment(loadIdentity);
app.use('/authorizations/*', async (c, next) => { c.header('Cache-Control', 'no-store'); return next(); });
const localOwner = (c: Parameters<typeof getConnInfo>[0]) => {
  try { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(getConnInfo(c).remote.address ?? ''); } catch { return false; }
};
app.post('/authorizations', async c => {
  if (!process.env.OPENPLOD_PAIRING_TOKEN) return c.json({ success: false, error: 'Secure desktop pairing must be configured first.' }, 403);
  try { return c.json({ success: true, data: enrollment.create(await c.req.json()) }); }
  catch { return c.json({ success: false, error: 'Invalid authorization request or too many pending requests.' }, 400); }
});
app.get('/authorizations', c => localOwner(c) ? c.json({ success: true, data: enrollment.list() }) : c.json({ success: false, error: 'Open device authorization on the Mac.' }, 403));
app.get('/authorizations/:id', c => {
  try { return c.json({ success: true, data: enrollment.get(c.req.param('id')) }); }
  catch (e) { return c.json({ success: false, error: (e as Error).message }, 404); }
});
app.post('/authorizations/:id/approve', async c => {
  if (!localOwner(c)) return c.json({ success: false, error: 'Approval must happen on this Mac.' }, 403);
  try { const body = await c.req.json(); if (body.confirm !== true || typeof body.code !== 'string') throw new Error('Enter the verification code shown on your phone.');
    return c.json({ success: true, data: await enrollment.approve(c.req.param('id'), body.code) }); }
  catch (e) { return c.json({ success: false, error: (e as Error).message }, 400); }
});
app.post('/authorizations/:id/acknowledge', c => c.json({ success: true, data: enrollment.remove(c.req.param('id')) }));
app.delete('/authorizations/:id', c => localOwner(c) ? c.json({ success: true, data: enrollment.remove(c.req.param('id')) }) : c.json({ success: false, error: 'Use the Mac to decline authorization.' }, 403));
let importJob: { id: string; state: 'running' | 'complete' | 'failed'; result?: Awaited<ReturnType<typeof importDirectPlaudRecording>>; error?: string } | null = null;

app.get('/device-recordings', async c => {
  c.header('Cache-Control', 'no-store');
  try {
    const result = await readDirectPlaudRecordings();
    const saved = await db.select({ id: recordings.id, sourceId: recordings.sourceRecordingId, retention: recordings.retentionState })
      .from(recordings).where(eq(recordings.sourceProvider, 'plaud'));
    return c.json({ success: true, data: result.sessions.map(session => {
      const existing = saved.find(recording => recording.sourceId === `${result.serial}:${session.sessionId}`);
      return { ...session, recordingId: existing?.id ?? null, retentionState: existing?.retention ?? null };
    }), checkedAt: result.checkedAt });
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Device recording list unavailable', recordingCount: null }, 503);
  }
});

app.post('/device-import', async c => {
  const body = await c.req.json<{ sessionId?: number; confirm?: boolean }>();
  if (!body.confirm || !Number.isSafeInteger(body.sessionId)) return c.json({ success: false, error: 'A session ID and import confirmation are required' }, 400);
  if (importJob?.state === 'running') return c.json({ success: false, error: 'A Plaud import is already running' }, 409);
  const job: NonNullable<typeof importJob> = { id: crypto.randomUUID(), state: 'running' };
  importJob = job;
  void importDirectPlaudRecording(body.sessionId!).then(result => { job.result = result; job.state = 'complete'; })
    .catch(error => { job.error = error instanceof Error ? error.message : 'Plaud import failed'; job.state = 'failed'; });
  return c.json({ success: true, data: { id: job.id } }, 202);
});

app.get('/device-import/:id', c => {
  c.header('Cache-Control', 'no-store');
  return importJob?.id === c.req.param('id') ? c.json({ success: true, data: importJob })
    : c.json({ success: false, error: 'Import job unavailable; refresh the library before retrying' }, 404);
});
app.post('/device-cancel', c => { cancelDirectPlaud(); return c.json({ success: true }); });

app.get('/status', async c => {
  const syncPath = await configuredSyncPath();
  const device = await scanDesktopPlaud();
  const folderAvailable = Boolean(syncPath && existsSync(syncPath));
  c.header('Cache-Control', 'no-store');
  return c.json({
    success: true,
    data: {
      deviceDetected: device.detected,
      deviceName: device.name,
      detail: device.detail,
      connectionVerified: device.connectionVerified,
      directTransferAvailable: directPlaudConfigured(),
      recordingListState: 'unavailable',
      deviceRecordingCount: null,
      folderAvailable,
      // Legacy field refers only to folder import, never direct-device transfer.
      transferAvailable: folderAvailable,
      syncPath,
    },
  });
});

app.get('/available-recordings', async c => {
  const syncPath = await configuredSyncPath();
  if (!syncPath) return c.json({ success: true, data: [] });
  const watcher = new FolderWatcher(syncPath);
  const available = await mapWithConcurrency(await watcher.listRecordings(), 4, async file => {
    const fingerprint = await fingerprintFile(file.path);
    const durationMs = await audioDurationMs(file.path);
    const [existing] = await db.select({ id: recordings.id, retentionState: recordings.retentionState })
      .from(recordings).where(eq(recordings.fingerprint, fingerprint)).limit(1);
    return {
      filename: file.filename,
      path: file.path,
      size: file.size,
      modifiedAt: file.modifiedAt.toISOString(),
      durationMs,
      fingerprint,
      imported: Boolean(existing),
      recordingId: existing?.id ?? null,
      retentionState: existing?.retentionState ?? null,
    };
  });
  return c.json({ success: true, data: available });
});

async function configuredSyncPath(): Promise<string | null> {
  const [setting] = await db.select({ value: userSettings.value }).from(userSettings)
    .where(eq(userSettings.key, 'syncFolderPath')).limit(1);
  const raw = setting?.value || process.env.PLAUD_SYNC_PATH;
  if (!raw) return null;
  return resolve(raw.startsWith('~/') ? `${homedir()}/${raw.slice(2)}` : raw);
}

async function audioDurationMs(filePath: string): Promise<number | null> {
  try {
    const processHandle = Bun.spawn([
      'ffprobe',
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { stdout: 'pipe', stderr: 'ignore' });
    const output = await new Response(processHandle.stdout).text();
    if (await processHandle.exited !== 0) return null;
    const seconds = Number.parseFloat(output.trim());
    return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : null;
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

export default app;
