import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, stat, unlink, writeFile, rmdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PlaudConnection, type PlaudIdentity } from './plaud-connection';
import { PlaudTransport } from './plaud-transport';
import { decodePlaudAudio } from './plaud-audio';
import { downloadPlaudSession, listPlaudSessions, recordingHandshake } from './plaud-transfer';
import { fingerprintFile, importRecordingFile } from '../library/recording-library';

interface DeviceIdentity extends PlaudIdentity { identifier: string; serial: string; bindingToken: string }
const vaultRoot = () => dirname(resolve(process.env.OPENPLOD_LIBRARY_PATH || './data/recordings'));
const identityPath = () => process.env.OPENPLOD_DEVICE_IDENTITY || join(vaultRoot(), 'plaud-device.json');
let active: AbortController | null = null;

export const directPlaudConfigured = () => process.platform === 'darwin' && existsSync(identityPath());
export function cancelDirectPlaud() { active?.abort(); }

async function loadIdentity(): Promise<DeviceIdentity> {
  const file = identityPath(), info = await stat(file);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error('Plaud identity file must be private to this macOS user');
  let identity: DeviceIdentity;
  try { identity = JSON.parse(await readFile(file, 'utf8')) as DeviceIdentity; }
  catch { throw new Error('Saved Plaud identity could not be read'); }
  if (!identity || typeof identity !== 'object') throw new Error('Invalid saved Plaud device identity');
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(identity.identifier)
    || !/^[0-9A-F]{16}$/.test(identity.serial) || !/^[\x21-\x7e]{32}$/.test(identity.bindingToken)
    || typeof identity.signature !== 'string' || typeof identity.privateKey !== 'string' || typeof identity.publicKey !== 'string') {
    throw new Error('Invalid saved Plaud device identity');
  }
  return identity;
}

async function withDevice<T>(operation: (connection: PlaudConnection, identity: DeviceIdentity, signal: AbortSignal) => Promise<T>): Promise<T> {
  if (active) throw new Error('A Plaud Bluetooth operation is already running');
  if (!directPlaudConfigured()) throw new Error('Authorize this Note Pro on this Mac before connecting');
  const controller = new AbortController(); active = controller;
  try {
    const identity = await loadIdentity();
    for (let attempt = 0; attempt < 2; attempt++) {
      controller.signal.throwIfAborted();
      const transport = new PlaudTransport(identity.identifier);
      const connection = new PlaudConnection(transport);
      const abort = () => { void connection.close(); };
      controller.signal.addEventListener('abort', abort, { once: true });
      try {
        await transport.wait(event => event.event === 'ready', 45000);
        await connection.establishEncryption(identity);
        await recordingHandshake(connection, identity.bindingToken);
        return await operation(connection, identity, controller.signal);
      } catch (error) {
        controller.signal.throwIfAborted();
        if (attempt !== 0 || !(error instanceof Error) || !/timeout|timed out|disconnected|bridge exited/i.test(error.message)) throw error;
      } finally {
        controller.signal.removeEventListener('abort', abort);
        await connection.close();
      }
    }
    throw new Error('Plaud connection failed after one fresh retry');
  } finally { active = null; }
}

export async function readDirectPlaudRecordings() {
  return withDevice(async (connection, identity) => ({ serial: identity.serial,
    sessions: await listPlaudSessions(connection), checkedAt: new Date().toISOString() }));
}

async function durableCopy(source: string, destination: string) {
  await copyFile(source, destination);
  await chmod(destination, 0o600);
  const file = await open(destination, 'r+');
  try { await file.sync(); } finally { await file.close(); }
}

async function runAudioTool(command: string[]) {
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'ignore' });
  const timer = setTimeout(() => child.kill(), 45000);
  try {
    const output = await new Response(child.stdout).text();
    if (await child.exited !== 0) throw new Error('Local audio verification or conversion failed');
    return output;
  } finally { clearTimeout(timer); }
}

export async function importDirectPlaudRecording(sessionId: number) {
  if (!Number.isSafeInteger(sessionId) || sessionId < 0 || sessionId > 0xffffffff) throw new Error('Invalid Plaud session ID');
  return withDevice(async (connection, identity, signal) => {
    const sessions = await listPlaudSessions(connection);
    const selected = sessions.find(session => session.sessionId === sessionId);
    if (!selected) throw new Error('Recording is no longer available on the Plaud');
    const downloaded = await downloadPlaudSession(connection, selected);
    const decoded = await decodePlaudAudio(downloaded.bytes, async ciphertext => {
      const reply = await connection.transport.request('rsa-decrypt', { key: identity.privateKey, data: ciphertext.toString('base64') });
      return Buffer.from(reply.data ?? '', 'base64');
    });
    const retained = await listPlaudSessions(connection);
    if (!retained.some(session => session.sessionId === selected.sessionId && session.size === selected.size)) throw new Error('Source retention could not be confirmed');
    await mkdir(join(vaultRoot(), 'incoming'), { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(vaultRoot(), 'incoming', 'plaud-'));
    const encryptedPath = join(temporary, 'original.plaud'), oggPath = join(temporary, 'audio.ogg'), playbackPath = join(temporary, 'audio.m4a');
    try {
      await writeFile(encryptedPath, downloaded.bytes, { mode: 0o600 });
      await writeFile(oggPath, decoded.audio, { mode: 0o600 });
      await runAudioTool(['ffmpeg', '-v', 'error', '-xerror', '-n', '-i', oggPath, '-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k', playbackPath]);
      const probe = JSON.parse(await runAudioTool(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', playbackPath]));
      const duration = Number(probe.format?.duration);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('Decoded Plaud recording has no playable duration');
      signal.throwIfAborted();
      const result = await importRecordingFile({ sourcePath: playbackPath, originalFilename: `Plaud-${sessionId}.m4a`,
        provenance: { sourceProvider: 'plaud', sourceTransport: 'ble', sourceRecordingId: `${identity.serial}:${sessionId}` },
        metadata: { durationMs: Math.round(duration * 1000) } });
      const originalDirectory = join(dirname(result.recording.filePath), 'originals', result.recording.id);
      await mkdir(originalDirectory, { recursive: true, mode: 0o700 });
      // Import idempotency must not replace original evidence on a duplicate request.
      if (!existsSync(join(originalDirectory, 'device-original.plaud'))) {
        await durableCopy(encryptedPath, join(originalDirectory, 'device-original.plaud'));
        await durableCopy(oggPath, join(originalDirectory, 'decoded-original.ogg'));
        await writeFile(join(originalDirectory, 'provenance.json'), JSON.stringify({
          serial: identity.serial, session: selected, sourceTransport: 'ble', sourceRetained: true,
          originalSha256: await fingerprintFile(encryptedPath), integrity: decoded.integrity,
          tailCrc: downloaded.tailCrc, tailChecksumValidated: false, durationMs: Math.round(duration * 1000),
          downloadedAt: new Date().toISOString(),
        }), { mode: 0o600 });
      }
      return { ...result, durationMs: Math.round(duration * 1000), sourceRetained: true };
    } finally {
      for (const path of [encryptedPath, oggPath, playbackPath]) await unlink(path).catch(() => undefined);
      await rmdir(temporary).catch(() => undefined);
    }
  });
}
