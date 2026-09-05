import { buildDownloadRequest, buildHandshake, buildSessionRequest, parseSessionPage, type PlaudSessionEntry } from './plaud-protocol';

export interface PlaudPackets {
  write(packet: Uint8Array): Promise<void>;
  packet(timeoutMs?: number): Promise<Buffer>;
}

export class PlaudSessionPages {
  private total: number | null = null;
  private entries = new Map<number, PlaudSessionEntry>();
  constructor(readonly requestId: number, readonly protocol: number) {}
  add(packet: Uint8Array): PlaudSessionEntry[] | null {
    const page = parseSessionPage(packet, this.protocol);
    if (page.requestId !== this.requestId) throw new Error('Recording list request mismatch');
    if (this.total !== null && this.total !== page.total) throw new Error('Recording list changed during pagination');
    this.total = page.total;
    for (const [index, entry] of page.entries.entries()) {
      const position = page.offset + index, previous = this.entries.get(position);
      if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) throw new Error('Conflicting recording list page');
      this.entries.set(position, entry);
    }
    if (this.entries.size !== page.total) return null;
    const result = Array.from({ length: page.total }, (_, i) => this.entries.get(i)!);
    if (new Set(result.map(entry => entry.sessionId)).size !== result.length) throw new Error('Duplicate session IDs');
    return result;
  }
}

export class PlaudDownload {
  private bytes: Buffer;
  private offset = 0;
  private head = false;
  private completed = false;
  constructor(readonly session: PlaudSessionEntry) {
    if (!Number.isSafeInteger(session.size) || session.size <= 0 || session.size > 64 * 1024 * 1024) {
      throw new Error('Recording exceeds the current 64 MiB Bluetooth transfer limit');
    }
    this.bytes = Buffer.alloc(session.size);
  }
  add(packet: Buffer): { bytes: Buffer; tailCrc: number } | null {
    if (this.completed) throw new Error('Download already completed');
    if (packet[0] === 1 && packet.length >= 3) {
      const opcode = packet.readUInt16LE(1);
      if (opcode !== 28 && opcode !== 29) return null;
      if (packet.length < (opcode === 28 ? 8 : 9) || packet.readUInt32LE(3) !== this.session.sessionId) {
        throw new Error('Download session mismatch or truncated control packet');
      }
      if (opcode === 28) {
        if (this.head || packet[7] !== 0) throw new Error('Recording download rejected');
        this.head = true;
      } else {
        if (!this.head || this.offset !== this.session.size) throw new Error('Incomplete recording transfer');
        this.completed = true;
        return { bytes: this.bytes, tailCrc: packet.readUInt16LE(7) };
      }
    } else if (packet[0] === 2) {
      if (!this.head || packet.length < 10 || packet.readUInt32LE(1) !== this.session.sessionId) throw new Error('Invalid recording data packet');
      const position = packet.readUInt32LE(5), length = packet[9]!;
      if (position === 0xffffffff) {
        if (packet.length < 11 || packet[10] !== 1) throw new Error('Device stopped the recording transfer');
        return null;
      }
      if (position !== this.offset || length === 0 || packet.length !== length + 10 || position + length > this.bytes.length) {
        throw new Error('Noncontiguous or malformed recording data');
      }
      packet.copy(this.bytes, position, 10);
      this.offset += length;
    }
    return null;
  }
}

export async function recordingHandshake(connection: PlaudPackets, token: string, protocol = 20) {
  const request = buildHandshake(token, protocol);
  await connection.write(request);
  const deadline = Date.now() + 15000;
  let secondHandshake = false;
  while (Date.now() < deadline) {
    const reply = await connection.packet(deadline - Date.now());
    if (reply.length < 3 || reply[0] !== 1) throw new Error('Malformed recording handshake');
    const opcode = reply.readUInt16LE(1);
    if (opcode === 2 && !secondHandshake) {
      if (reply.length < 59) throw new Error('Truncated serial handshake');
      secondHandshake = true;
      request[5] = 1;
      await connection.write(request);
    } else if (opcode === 1) {
      if (reply.length < 12 || reply[3] !== 0) throw new Error(`Plaud recording access rejected (status ${reply[3] ?? 'unknown'})`);
      if (reply.readUInt16LE(4) !== 20 || reply[11] !== 1) throw new Error('Unsupported negotiated Plaud audio protocol');
      return { protocol: reply.readUInt16LE(4), channels: reply[8]! };
    }
  }
  throw new Error('Recording handshake timeout');
}

let requestSequence = Math.floor(Date.now() / 1000) >>> 0;
export async function listPlaudSessions(connection: PlaudPackets, protocol = 20) {
  const requestId = requestSequence = (requestSequence + 1) >>> 0;
  const pages = new PlaudSessionPages(requestId, protocol);
  await connection.write(buildSessionRequest({ requestId, cursor: 0 }));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const packet = await connection.packet(deadline - Date.now());
    if (packet.length < 3 || packet[0] !== 1 || packet.readUInt16LE(1) !== 26) continue;
    const sessions = pages.add(packet);
    if (sessions) return sessions;
  }
  throw new Error('Recording list timeout; device recording count is unknown');
}

export async function downloadPlaudSession(connection: PlaudPackets, session: PlaudSessionEntry) {
  const download = new PlaudDownload(session);
  await connection.write(buildDownloadRequest({ sessionId: session.sessionId, offset: 0, end: session.size }));
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const result = download.add(await connection.packet(Math.min(15000, deadline - Date.now())));
    if (result) return result;
  }
  throw new Error('Recording download timed out; partial audio was not imported');
}
