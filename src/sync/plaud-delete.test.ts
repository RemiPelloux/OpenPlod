import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256File } from '../library/durable-files';
import { withRecordingLease } from '../library/recording-lease';
import { purgeRecordingData } from '../library/purge';
import { VerifiedPlaudDeletion, type DeletionConnection } from './plaud-delete';
import { deletePlaudSession, type PlaudPackets } from './plaud-transfer';
import { buildDeleteRequest } from './plaud-protocol';

let directory: string, database: Database, service: VerifiedPlaudDeletion;
let sessions: { sessionId: number; size: number; scene: number; timezone: number }[];
let writes: Buffer[], serial: string, now: number, response: 'ok' | 'lost' | 'wrong' | 'reject' | 'truncated' | 'retained';
const source = Buffer.from('synthetic original'), audio = Buffer.from('synthetic playback');
const id = 'synthetic-recording';
const original = () => join(directory, 'originals', id, 'device-original.plaud');
const playback = () => join(directory, 'audio.m4a');
const provenance = () => join(directory, 'originals', id, 'provenance.json');
function transport(): PlaudPackets {
  const packets: Buffer[] = [];
  return {
    async write(bytes) {
      const packet = Buffer.from(bytes); writes.push(packet);
      if (packet.readUInt16LE(1) === 26) {
        const page = Buffer.alloc(11 + sessions.length * 10); page[0] = 1; page.writeUInt16LE(26, 1);
        page.writeUInt32LE(packet.readUInt32LE(3), 3); page.writeUInt16LE(sessions.length, 7);
        sessions.forEach((session, i) => { page.writeUInt32LE(session.sessionId, 11 + i * 10); page.writeUInt32LE(session.size, 15 + i * 10); page[19 + i * 10] = session.timezone; page[20 + i * 10] = session.scene; });
        packets.push(page);
      } else if (packet.readUInt16LE(1) === 30) {
        if (response === 'lost') throw new Error('disconnected');
        const ack = Buffer.alloc(response === 'truncated' ? 7 : 8); ack[0] = 1; ack.writeUInt16LE(31, 1);
        ack.writeUInt32LE(response === 'wrong' ? 999 : packet.readUInt32LE(3), 3);
        if (response === 'reject') ack[7] = 1;
        if (response === 'ok') sessions = sessions.filter(session => session.sessionId !== packet.readUInt32LE(3));
        packets.push(ack);
      } else throw new Error('Unexpected device command');
    },
    async packet() { const packet = packets.shift(); if (!packet) throw new Error('timeout'); return packet; },
  };
}
const connect: DeletionConnection = operation => operation(transport(), serial, new AbortController().signal);
const deletions = () => writes.filter(packet => packet.readUInt16LE(1) === 30);
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'openplod-delete-test-'));
  database = new Database(':memory:');
  database.exec(`CREATE TABLE recordings (id TEXT PRIMARY KEY, file_path TEXT, fingerprint TEXT, revision INTEGER,
    file_size_bytes INTEGER, source_provider TEXT, source_transport TEXT, source_recording_id TEXT, retention_state TEXT)`);
  serial = '0000000000000001'; now = 1000; writes = []; response = 'ok';
  sessions = [{ sessionId: 42, size: source.length, scene: 0, timezone: 0 }, { sessionId: 43, size: 50, scene: 0, timezone: 0 }];
  await mkdir(join(directory, 'originals', id), { recursive: true });
  await writeFile(original(), source); await writeFile(playback(), audio);
  const fingerprint = await sha256File(playback());
  await writeFile(provenance(), JSON.stringify({ serial, session: sessions[0], sourceTransport: 'ble', durationMs: 1000,
    originalSha256: await sha256File(original()), playbackSha256: fingerprint }));
  database.query('INSERT INTO recordings VALUES (?,?,?,?,?,?,?,?,?)').run(id, playback(), fingerprint, 1, audio.length, 'plaud', 'ble', `${serial}:42`, 'active');
  service = new VerifiedPlaudDeletion(database, connect, directory, () => now);
});
afterEach(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });

test('exact single-delete framing and integer boundaries', () => {
  expect(buildDeleteRequest(42).toString('hex')).toBe('011e002a000000');
  for (const id of [-1, 2 ** 32, 1.5, NaN]) expect(() => buildDeleteRequest(id)).toThrow();
});
test('prepare reads only; explicit confirmation deletes exactly one device session and keeps backup', async () => {
  const receipt = await service.prepare(id, 42);
  expect(deletions()).toHaveLength(0);
  await expect(service.confirm(receipt.token, false)).rejects.toThrow('confirmation');
  expect(deletions()).toHaveLength(0);
  await expect(service.confirm(receipt.token, true)).resolves.toEqual({ sessionId: 42, recordingId: id, deleted: true });
  expect(deletions()).toHaveLength(1); expect(sessions.map(s => s.sessionId)).toEqual([43]);
  expect(await readFile(original())).toEqual(source); expect(await readFile(playback())).toEqual(audio);
  expect(database.query('SELECT count(*) AS n FROM recordings').get()).toEqual({ n: 1 });
  await expect(service.confirm(receipt.token, true)).rejects.toThrow('confirmation');
  expect(deletions()).toHaveLength(1);
});
for (const change of ['missing', 'original corrupt', 'playback corrupt', 'trash', 'wrong source', 'wrong transport', 'provenance', 'replaced audio']) {
  test(`backup recheck blocks ${change} without a device delete`, async () => {
    const receipt = await service.prepare(id, 42);
    if (change === 'missing') await unlink(original());
    if (change === 'original corrupt') await writeFile(original(), Buffer.alloc(source.length));
    if (change === 'playback corrupt') await writeFile(playback(), Buffer.alloc(audio.length));
    if (change === 'trash') database.exec("UPDATE recordings SET retention_state='trash'");
    if (change === 'wrong source') database.exec("UPDATE recordings SET source_recording_id='other:42'");
    if (change === 'wrong transport') database.exec("UPDATE recordings SET source_transport='cloud'");
    if (change === 'provenance') await writeFile(provenance(), '{}');
    if (change === 'replaced audio') database.exec('UPDATE recordings SET revision=revision+1');
    await expect(service.confirm(receipt.token, true)).rejects.toThrow(); expect(deletions()).toHaveLength(0);
  });
}
for (const change of ['expired', 'device', 'size', 'scene', 'absent']) {
  test(`confirmation blocks changed ${change}`, async () => {
    const receipt = await service.prepare(id, 42);
    if (change === 'expired') now += 120000;
    if (change === 'device') serial = '0000000000000002';
    if (change === 'size') sessions[0]!.size++;
    if (change === 'scene') sessions[0]!.scene++;
    if (change === 'absent') sessions.shift();
    await expect(service.confirm(receipt.token, true)).rejects.toThrow(); expect(deletions()).toHaveLength(0);
  });
}
for (const failure of ['lost', 'wrong', 'reject', 'truncated', 'retained'] as const) {
  test(`${failure} acknowledgement stays uncertain, consumes confirmation and never retries`, async () => {
    const receipt = await service.prepare(id, 42); response = failure;
    await expect(service.confirm(receipt.token, true)).rejects.toThrow('could not be confirmed');
    await expect(service.confirm(receipt.token, true)).rejects.toThrow('confirmation');
    expect(deletions()).toHaveLength(1); expect(await readFile(original())).toEqual(source);
  });
}
test('simultaneous confirmation writes once', async () => {
  const receipt = await service.prepare(id, 42);
  const results = await Promise.allSettled([service.confirm(receipt.token, true), service.confirm(receipt.token, true)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(deletions()).toHaveLength(1);
});
test('lease prevents local purge, releases after error and blocks overlapping backup verification', async () => {
  const { replaceRecordingAudio, softDeleteRecording } = await import('../library/recording-library');
  await withRecordingLease(id, async () => {
    await expect(replaceRecordingAudio({ recordingId: id, sourcePath: playback() })).rejects.toThrow('busy');
    await expect(softDeleteRecording(id)).rejects.toThrow('busy');
    await expect(purgeRecordingData(database, id, { libraryDirectory: directory, requireTrash: false })).rejects.toThrow('busy');
    await expect(service.prepare(id, 42)).rejects.toThrow('busy');
  });
  await expect(withRecordingLease(id, async () => { throw new Error('fixture'); })).rejects.toThrow('fixture');
  expect((await service.prepare(id, 42)).token).toBeTruthy(); expect(deletions()).toHaveLength(0);
});
test('invalid sessions never write; legacy modified backup is rejected', async () => {
  for (const value of [-1, 2 ** 32, 1.5]) await expect(service.prepare(id, value)).rejects.toThrow();
  expect(writes).toHaveLength(0);
  const evidence = JSON.parse(await readFile(provenance(), 'utf8')); delete evidence.playbackSha256;
  await writeFile(provenance(), JSON.stringify(evidence));
  expect((await service.prepare(id, 42)).token).toBeTruthy();
  database.exec('UPDATE recordings SET revision=2');
  await expect(service.prepare(id, 42)).rejects.toThrow('backup');
});
test('pre-aborted connection cannot delete', async () => {
  const controller = new AbortController();
  const operation: DeletionConnection = callback => callback(transport(), serial, controller.signal);
  const deletion = new VerifiedPlaudDeletion(database, operation, directory, () => now);
  const receipt = await deletion.prepare(id, 42); controller.abort();
  await expect(deletion.confirm(receipt.token, true)).rejects.toThrow(); expect(deletions()).toHaveLength(0);
});
test('low-level validation rejects invalid session before any write', async () => {
  await expect(deletePlaudSession(transport(), -1)).rejects.toThrow(); expect(writes).toHaveLength(0);
});

test('backup links and corrupt evidence are rejected before confirmation', async () => {
  await unlink(original()); await symlink(playback(), original());
  await expect(service.prepare(id, 42)).rejects.toThrow('backup');
  expect(deletions()).toHaveLength(0);
  await unlink(original()); await writeFile(original(), source);
  await writeFile(provenance(), '{invalid');
  await expect(service.prepare(id, 42)).rejects.toThrow('backup');
  expect(deletions()).toHaveLength(0);
});
