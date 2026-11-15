import { bytePercent, ffmpegProgress, type PlaudImportProgress } from './plaud-progress';
import { runPlaudAudioTool } from './plaud-audio-tool';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, stat, unlink, writeFile, rmdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PlaudConnection, type PlaudIdentity } from './plaud-connection';
import { PlaudTransport } from './plaud-transport';
import { decodePlaudAudio } from './plaud-audio';
import { checkPlaudDownloadSize, downloadPlaudSession, listPlaudSessions, recordingHandshake } from './plaud-transfer';
import { fingerprintFile, importRecordingFile } from '../library/recording-library';
import { openPlaudCheckpoint } from './plaud-checkpoint';
import { evaluateTailChecksum, TransferChecksumMismatch } from './transfer-checksum';
import { ensureDiskSpace, fsyncDirectory } from '../library/durable-files';
import { bluetoothSupported, isBluetoothIdentifier, isDesktopPlatform } from './plaud-bridge';
import { BINDING_TOKEN_PATTERN, PLAUD_SERIAL_PATTERN, identityFilePath } from './plaud-provision';

interface DeviceIdentity extends PlaudIdentity { identifier: string; serial: string; bindingToken: string }
const vaultRoot = () => dirname(resolve(process.env.OPENPLOD_LIBRARY_PATH || './data/recordings'));
const identityPath = identityFilePath;
let active: AbortController | null = null;

export const directPlaudConfigured = () => isDesktopPlatform() && bluetoothSupported() && existsSync(identityPath());
export function cancelDirectPlaud() { active?.abort(); }

export async function loadIdentity(): Promise<DeviceIdentity> {
  const file = identityPath(), info = await stat(file);
  if (!info.isFile() || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) throw new Error('Plaud identity file must be private to this user');
  let identity: DeviceIdentity;
  try { identity = JSON.parse(await readFile(file, 'utf8')) as DeviceIdentity; }
  catch { throw new Error('Saved Plaud identity could not be read'); }
  if (!identity || typeof identity !== 'object') throw new Error('Invalid saved Plaud device identity');
  if (!isBluetoothIdentifier(identity.identifier)
    || !PLAUD_SERIAL_PATTERN.test(identity.serial) || !BINDING_TOKEN_PATTERN.test(identity.bindingToken)
    || typeof identity.signature !== 'string' || typeof identity.privateKey !== 'string' || typeof identity.publicKey !== 'string') {
    throw new Error('Invalid saved Plaud device identity');
  }
  return identity;
}

async function withDevice<T>(operation: (connection: PlaudConnection, identity: DeviceIdentity, signal: AbortSignal) => Promise<T>): Promise<T> {
  if (active) throw new Error('A Plaud Bluetooth operation is already running');
  if (!directPlaudConfigured()) throw new Error('Authorize this Plaud recorder on this computer before connecting');
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

export async function importDirectPlaudRecording(sessionId: number, onProgress?: (progress: PlaudImportProgress) => void) {
  let progress: PlaudImportProgress = { stage: 'connecting', percent: null, receivedBytes: 0, totalBytes: 0, resumedBytes: 0 };
  const report = (update: Partial<PlaudImportProgress>) => { progress = { ...progress, ...update }; onProgress?.(progress); };
  report({});
  if (!Number.isSafeInteger(sessionId) || sessionId < 0 || sessionId > 0xffffffff) throw new Error('Invalid Plaud session ID');
  return withDevice(async (connection, identity, signal) => {
    const sessions = await listPlaudSessions(connection);
    const selected = sessions.find(session => session.sessionId === sessionId);
    if (!selected) throw new Error('Recording is no longer available on the Plaud');
    const resumeDirectory = join(vaultRoot(), 'incoming', 'plaud-resume');
    await mkdir(resumeDirectory, { recursive: true, mode: 0o700 });
    checkPlaudDownloadSize(selected.size);
    await ensureDiskSpace(resumeDirectory, selected.size * 8);
    const resumePath = join(resumeDirectory, `${identity.serial}-${sessionId}-${selected.size}.part`);
    const previous = await readFile(resumePath).catch(() => Buffer.alloc(0));
    const prefix = previous.subarray(0, Math.min(previous.length, selected.size - 1));
    report({ stage: 'downloading', percent: bytePercent(prefix.length, selected.size), receivedBytes: prefix.length, totalBytes: selected.size, resumedBytes: previous.length });
    const checkpoint = await openPlaudCheckpoint(resumePath, prefix.length);
    const downloaded = await downloadPlaudSession(connection, selected, { prefix, checkpoint: async bytes => {
      await checkpoint.save(bytes);
      report({ receivedBytes: bytes.length, percent: bytePercent(bytes.length, selected.size) });
    } })
      .finally(() => checkpoint.close());
    // REL-02: the tail algorithm is unconfirmed, so this records evidence and only a confirmed
    // algorithm can reject. A rejected transfer keeps its bytes in quarantine for inspection.
    report({ stage: 'verifying', percent: null });
    const tailChecksum = evaluateTailChecksum(downloaded.bytes, downloaded.tailCrc);
    if (tailChecksum.status === 'mismatch') {
      const quarantine = join(vaultRoot(), 'incoming', 'plaud-quarantine');
      await mkdir(quarantine, { recursive: true, mode: 0o700 });
      await rename(resumePath, join(quarantine, `${identity.serial}-${sessionId}-${selected.size}-${Date.now()}.part`)).catch(() => undefined);
      await fsyncDirectory(quarantine);
      throw new TransferChecksumMismatch(tailChecksum);
    }
    report({ stage: 'decrypting', percent: null });
    const decoded = await decodePlaudAudio(downloaded.bytes, async ciphertext => {
      const reply = await connection.transport.request('rsa-decrypt', { key: identity.privateKey, data: ciphertext.toString('base64') });
      return Buffer.from(reply.data ?? '', 'base64');
    });
    report({ stage: 'verifying', percent: null });
    const retained = await listPlaudSessions(connection);
    if (!retained.some(session => session.sessionId === selected.sessionId && session.size === selected.size)) throw new Error('Source retention could not be confirmed');
    await mkdir(join(vaultRoot(), 'incoming'), { recursive: true, mode: 0o700 });
    // Temporary device bytes, decoded Ogg and M4A, then their vault copies.
    await ensureDiskSpace(join(vaultRoot(), 'incoming'), (downloaded.bytes.length + decoded.audio.length) * 4);
    const temporary = await mkdtemp(join(vaultRoot(), 'incoming', 'plaud-'));
    const encryptedPath = join(temporary, 'original.plaud'), oggPath = join(temporary, 'audio.ogg'), playbackPath = join(temporary, 'audio.m4a');
    try {
      await writeFile(encryptedPath, downloaded.bytes, { mode: 0o600 });
      await writeFile(oggPath, decoded.audio, { mode: 0o600 });
      const sourceProbe = JSON.parse(await runPlaudAudioTool(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', oggPath], { signal }));
      const sourceDuration = Number(sourceProbe.format?.duration);
      report({ stage: 'converting', percent: Number.isFinite(sourceDuration) && sourceDuration > 0 ? 0 : null });
      await runPlaudAudioTool(['ffmpeg', '-progress', 'pipe:1', '-nostats', '-v', 'error', '-xerror', '-n', '-i', oggPath, '-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k', playbackPath], { signal, onOutput: ffmpegProgress(sourceDuration, percent => report({ percent })) });
      report({ stage: 'verifying', percent: null });
      const probe = JSON.parse(await runPlaudAudioTool(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', playbackPath], { signal }));
      const duration = Number(probe.format?.duration);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('Decoded Plaud recording has no playable duration');
      signal.throwIfAborted();
      const durationMs = Math.round(duration * 1000);
      const provenance = JSON.stringify({
        serial: identity.serial, session: selected, sourceTransport: 'ble', sourceRetained: true,
        originalSha256: await fingerprintFile(encryptedPath), integrity: decoded.integrity,
        tailCrc: downloaded.tailCrc, tailChecksum, durationMs, downloadedAt: new Date().toISOString(),
      });
      // Device bytes, decoded audio and provenance are staged with the playback copy and become
      // visible together with the recording row (REL-03).
      report({ stage: 'saving', percent: null });
      const result = await importRecordingFile({ sourcePath: playbackPath, originalFilename: `Plaud-${sessionId}.m4a`,
        provenance: { sourceProvider: 'plaud', sourceTransport: 'ble', sourceRecordingId: `${identity.serial}:${sessionId}` },
        metadata: { durationMs },
        sidecars: [
          { name: 'device-original.plaud', sourcePath: encryptedPath },
          { name: 'decoded-original.ogg', sourcePath: oggPath },
          { name: 'provenance.json', data: provenance },
        ] });
      await unlink(resumePath).catch(() => undefined);
      // Like every other import path, honour "Transcribe after import" (or forwarding) for new recordings.
      // Imported lazily: the job queue opens the vault database on load.
      if (result.added) await import('../library/processing')
        .then(({ queueRecordingProcessing }) => queueRecordingProcessing({ recordingId: result.recording.id, filePath: result.recording.filePath }))
        .catch(error => console.error('[Plaud] Imported recording could not be queued for processing:', error));
      report({ stage: 'complete', percent: 100 });
      return { ...result, durationMs, sourceRetained: true };
    } finally {
      for (const path of [encryptedPath, oggPath, playbackPath]) await unlink(path).catch(() => undefined);
      await rmdir(temporary).catch(() => undefined);
    }
  });
}
