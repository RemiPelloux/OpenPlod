import { expect, test } from 'bun:test';
import { PlaudDownload, PlaudSessionPages, listPlaudSessions, recordingHandshake } from './plaud-transfer';

function page(request: number, total: number, offset: number, ids: number[]) {
  const packet = Buffer.alloc(11 + ids.length * 10);
  packet[0] = 1; packet.writeUInt16LE(26, 1); packet.writeUInt32LE(request, 3);
  packet.writeUInt16LE(total, 7); packet.writeUInt16LE(offset, 9);
  ids.forEach((id, i) => { packet.writeUInt32LE(id, 11 + i * 10); packet.writeUInt32LE(100, 15 + i * 10); });
  return packet;
}

test('list pagination assembles offsets, allows repeated pages, rejects changed snapshots', () => {
  const pages = new PlaudSessionPages(7, 20);
  expect(pages.add(page(7, 3, 2, [30]))).toBeNull();
  expect(pages.add(page(7, 3, 2, [30]))).toBeNull();
  expect(() => pages.add(page(8, 3, 0, [10]))).toThrow('request');
  expect(() => pages.add(page(7, 4, 0, [10]))).toThrow('changed');
  expect(() => pages.add(page(7, 3, 2, [40]))).toThrow('Conflicting');
  expect(pages.add(page(7, 3, 0, [10, 20]))?.map(entry => entry.sessionId)).toEqual([10, 20, 30]);
  expect(new PlaudSessionPages(1, 20).add(page(1, 0, 0, []))).toEqual([]);
  expect(() => new PlaudSessionPages(1, 20).add(page(1, 2, 0, [10, 10]))).toThrow('Duplicate');
});

const session = { sessionId: 7, size: 4, scene: 0, timezone: 0 };
const head = Buffer.from('011c000700000000', 'hex');
const tail = Buffer.from('011d0007000000ffff', 'hex');
const data = Buffer.from('0207000000000000000401020304', 'hex');

test('download requires success head, exact contiguous bytes and matching completion tail', () => {
  const transfer = new PlaudDownload(session);
  expect(() => transfer.add(data)).toThrow();
  expect(transfer.add(head)).toBeNull();
  expect(() => transfer.add(tail)).toThrow('Incomplete');
  expect(transfer.add(Buffer.from('0109000100', 'hex'))).toBeNull();
  expect(transfer.add(data)).toBeNull();
  expect(transfer.add(tail)).toEqual({ bytes: Buffer.from([1, 2, 3, 4]), tailCrc: 65535 });
  expect(() => transfer.add(tail)).toThrow('completed');
});

test('download rejects wrong sessions, gaps, truncation, overrun and error control packets', () => {
  const badSession = Buffer.from(data); badSession.writeUInt32LE(8, 1);
  const gap = Buffer.from(data); gap.writeUInt32LE(1, 5);
  const length = Buffer.from(data); length[9] = 3;
  for (const bad of [badSession, gap, length, data.subarray(0, -1), Buffer.from('0207000000ffffffff0102', 'hex')]) {
    const transfer = new PlaudDownload(session); transfer.add(head);
    expect(() => transfer.add(bad)).toThrow();
  }
  expect(() => new PlaudDownload({ ...session, size: 65 * 1024 * 1024 })).toThrow('limit');
});

test('session list routes unsolicited notifications without interpreting them as an empty list', async () => {
  let requestId = 0, read = 0;
  const sessions = await listPlaudSessions({
    write: async packet => { requestId = Buffer.from(packet).readUInt32LE(3); },
    packet: async () => ++read === 1 ? Buffer.from('0109000100', 'hex') : page(requestId, 1, 0, [7]),
  });
  expect(sessions[0]?.sessionId).toBe(7);
  await expect(listPlaudSessions({ write: async () => {}, packet: async () => { throw new Error('Bluetooth response timeout'); } })).rejects.toThrow('timeout');
});

test('recording handshake rejects access denial and implements serial-driven second mode only', async () => {
  const writes: Buffer[] = [], serial = Buffer.alloc(59); serial[0] = 1; serial[1] = 2;
  const accepted = Buffer.from('01010000140000000100000156000000', 'hex');
  const replies = [serial, accepted];
  const result = await recordingHandshake({ write: async packet => { writes.push(Buffer.from(packet)); }, packet: async () => replies.shift()! }, 'a'.repeat(32));
  expect(result).toEqual({ protocol: 20, channels: 1 });
  expect(writes.map(packet => packet[5])).toEqual([0, 1]);
  const rejected = Buffer.from(accepted); rejected[3] = 2;
  await expect(recordingHandshake({ write: async () => {}, packet: async () => rejected }, 'a'.repeat(32))).rejects.toThrow('rejected');
});
