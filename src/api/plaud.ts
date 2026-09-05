import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { db } from '../db/client';
import { recordings, userSettings } from '../db/schema';
import { eq } from 'drizzle-orm';
import { fingerprintFile } from '../library/recording-library';
import { FolderWatcher } from '../sync/folder-watcher';

const app = new Hono();

app.get('/status', async c => {
  const syncPath = await configuredSyncPath();
  const device = await scanDevice();
  return c.json({
    success: true,
    data: {
      deviceDetected: device.detected,
      deviceName: device.name,
      detail: device.detail,
      transferAvailable: Boolean(syncPath && existsSync(syncPath)),
      syncPath,
    },
  });
});

app.get('/available-recordings', async c => {
  const syncPath = await configuredSyncPath();
  if (!syncPath) return c.json({ success: true, data: [] });
  const watcher = new FolderWatcher(syncPath);
  const available = await mapWithConcurrency(watcher.listRecordings(), 4, async file => {
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

async function scanDevice(): Promise<{ detected: boolean; name: string | null; detail: string }> {
  if (process.platform !== 'darwin') {
    return { detected: false, name: null, detail: 'Bluetooth detection is currently available on macOS.' };
  }
  const scanScript = process.env.OPENPLOD_SCAN_SCRIPT || 'scripts/scan-plaud.swift';
  const processHandle = Bun.spawn(['swift', scanScript], { stdout: 'pipe', stderr: 'pipe' });
  const [output, errorOutput, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  const line = output.split('\n').find(value => /found\s+.*plaud|plaud.*found/i.test(value)) ?? '';
  const detected = Boolean(line) && /connection verified/i.test(output) && !/no plaud/i.test(output);
  const detail = output.trim() || errorOutput.trim() || `Plaud scanner exited with code ${exitCode}.`;
  return { detected, name: detected ? 'Plaud Note Pro' : null, detail };
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
