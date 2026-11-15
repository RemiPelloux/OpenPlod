import type { Database } from 'bun:sqlite';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { sha256File } from '../library/durable-files';
import { withRecordingLease } from '../library/recording-lease';
import { deletePlaudSession, listPlaudSessions, type PlaudPackets } from './plaud-transfer';
import type { PlaudSessionEntry } from './plaud-protocol';

type Backup = { id: string; filePath: string; fingerprint: string; revision: number; fileSize: number };
type Receipt = { recordingId: string; serial: string; session: PlaudSessionEntry; backup: Backup; expiresAt: number };
export type DeletionConnection = <T>(operation: (connection: PlaudPackets, serial: string, signal: AbortSignal) => Promise<T>) => Promise<T>;
const backupError = () => new Error('A verified, unchanged local backup is required. Import this recording before deleting it from Plaud.');

/** No database client or hardware is opened on import; tests supply an isolated vault. */
export class VerifiedPlaudDeletion {
  private receipts = new Map<string, Receipt>();
  constructor(private database: Database, private connect: DeletionConnection,
    private library = resolve(process.env.OPENPLOD_LIBRARY_PATH || './data/recordings'), private now = Date.now) {}

  private async verify(recordingId: string, serial: string, session: PlaudSessionEntry): Promise<Backup> {
    try { return await this.verifyFiles(recordingId, serial, session); }
    catch { throw backupError(); }
  }

  private async verifyFiles(recordingId: string, serial: string, session: PlaudSessionEntry): Promise<Backup> {
    const row = this.database.query(`SELECT id, file_path AS filePath, fingerprint, revision, file_size_bytes AS fileSize
      FROM recordings WHERE id=? AND source_provider='plaud' AND source_transport='ble'
      AND source_recording_id=? AND retention_state='active'`).get(recordingId, `${serial}:${session.sessionId}`) as Backup | null;
    if (!row || !/^[a-f0-9]{64}$/.test(row.fingerprint ?? '')) throw backupError();
    const root = await realpath(this.library);
    const checked = async (path: string) => {
      const info = await lstat(path);
      if (!info.isFile() || info.size <= 0 || !(await realpath(path)).startsWith(root + sep)) throw backupError();
      return info;
    };
    if (resolve(dirname(row.filePath)) !== resolve(this.library)) throw backupError();
    const originals = join(this.library, 'originals', row.id);
    const original = join(originals, 'device-original.plaud');
    const provenance = join(originals, 'provenance.json');
    if ((await checked(provenance)).size > 65536) throw backupError();
    const evidence = JSON.parse(await readFile(provenance, 'utf8'));
    if (evidence.serial !== serial || evidence.session?.sessionId !== session.sessionId
      || evidence.session?.size !== session.size || evidence.sourceTransport !== 'ble'
      || !Number.isFinite(evidence.durationMs) || evidence.durationMs <= 0
      || (evidence.playbackSha256 ? evidence.playbackSha256 !== row.fingerprint : row.revision !== 1)) throw backupError();
    if ((await checked(original)).size !== session.size || (await checked(row.filePath)).size !== row.fileSize
      || await sha256File(original) !== evidence.originalSha256 || await sha256File(row.filePath) !== row.fingerprint) throw backupError();
    return row;
  }

  async prepare(recordingId: string, sessionId: number) {
    if (typeof recordingId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(recordingId)
      || !Number.isSafeInteger(sessionId) || sessionId < 0 || sessionId > 0xffffffff) throw backupError();
    for (const [token, receipt] of this.receipts) if (receipt.expiresAt <= this.now()) this.receipts.delete(token);
    if (this.receipts.size >= 16) throw new Error('Too many pending deletion confirmations. Wait a few minutes.');
    return withRecordingLease(recordingId, () => this.connect(async (connection, serial, signal) => {
      const session = (await listPlaudSessions(connection)).find(item => item.sessionId === sessionId);
      if (!session || session.size <= 0) throw backupError();
      const backup = await this.verify(recordingId, serial, session);
      signal.throwIfAborted();
      const token = crypto.randomUUID(), expiresAt = this.now() + 120000;
      this.receipts.set(token, { recordingId, serial, session, backup, expiresAt });
      return { token, expiresAt, sessionId, recordingId };
    }));
  }

  async confirm(token: string, confirmed: boolean) {
    const receipt = this.receipts.get(token);
    if (!confirmed || !receipt || receipt.expiresAt <= this.now()) throw new Error('Deletion confirmation expired or invalid. Verify the backup again.');
    // Consume synchronously before any await, including failure/uncertain outcomes.
    this.receipts.delete(token);
    return withRecordingLease(receipt.recordingId, () => this.connect(async (connection, serial, signal) => {
      if (serial !== receipt.serial) throw backupError();
      const current = (await listPlaudSessions(connection)).find(item => item.sessionId === receipt.session.sessionId);
      if (!current || current.size !== receipt.session.size || current.scene !== receipt.session.scene
        || current.timezone !== receipt.session.timezone) throw backupError();
      const backup = await this.verify(receipt.recordingId, serial, current);
      if (backup.revision !== receipt.backup.revision || backup.fingerprint !== receipt.backup.fingerprint
        || backup.filePath !== receipt.backup.filePath || this.now() >= receipt.expiresAt) throw backupError();
      signal.throwIfAborted();
      await deletePlaudSession(connection, current.sessionId);
      return { sessionId: current.sessionId, recordingId: receipt.recordingId, deleted: true as const };
    }));
  }
}
