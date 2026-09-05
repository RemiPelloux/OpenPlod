// Interoperability framing verified against APK builders/parsers; no device writes here.
export const PLAUD_COMMAND = { handshake: 1, sessions: 26, download: 28, tail: 29,
  signature: 0xfe10, signatureAccepted: 0xfe11, publicKey: 0xfe12 } as const;

export function parseNoteProAdvertisement(data: Uint8Array) {
  const bytes = Buffer.from(data);
  if (bytes.length < 22 || bytes[2] !== 2 || bytes[5] !== 4 || bytes[10] !== 8) {
    throw new Error('Unsupported or truncated Note Pro advertisement');
  }
  const project = bytes.readUInt16LE(3);
  if (project !== 881 && project !== 883) throw new Error('Not a supported Note Pro project');
  return { project, serial: bytes.subarray(11, 19).toString('hex').toUpperCase(),
    protocolVersion: bytes.readUInt16LE(20), encrypted: bytes.readUInt16LE(20) >= 20 };
}

function uint32(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error('Invalid unsigned integer');
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function command(id: number, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(3);
  header[0] = 1;
  header.writeUInt16LE(id, 1);
  return Buffer.concat([header, payload]);
}

export function buildHandshake(bindingToken: string, protocolVersion: number): Buffer {
  if (!/^[\x21-\x7e]+$/.test(bindingToken)) throw new Error('A nonempty ASCII device binding token is required');
  if (!Number.isInteger(protocolVersion) || protocolVersion < 1) throw new Error('Invalid protocol version');
  const tokenLength = protocolVersion >= 9 ? 32 : 16;
  const token = Buffer.from(bindingToken.slice(0, tokenLength).padEnd(tokenLength, '0'), 'ascii');
  // APK transport O() returns zero; the optional third field is NOT the firmware version.
  const options = protocolVersion >= 3 ? [2, 0, 0] : [2, 0];
  return command(PLAUD_COMMAND.handshake, Buffer.concat([Buffer.from(options), token]));
}

export function buildSessionRequest(options: { requestId: number; cursor: number; ascending?: boolean }): Buffer {
  return command(PLAUD_COMMAND.sessions, Buffer.concat([uint32(options.requestId), uint32(options.cursor),
    Buffer.from([options.ascending ? 1 : 0])]));
}

export function buildDownloadRequest(options: { sessionId: number; offset: number; end: number }): Buffer {
  if (options.offset >= options.end) throw new Error('Download range must be nonempty');
  return command(PLAUD_COMMAND.download, Buffer.concat([
    uint32(options.sessionId), uint32(options.offset), uint32(options.end),
  ]));
}

export function buildPreHandshakeChunks(opcode: number, payload: Uint8Array): Buffer[] {
  const supported: number[] = [PLAUD_COMMAND.signature, PLAUD_COMMAND.publicKey];
  if (!supported.includes(opcode)) {
    throw new Error('Unsupported pre-handshake command');
  }
  const total = Math.ceil(payload.length / 100);
  if (total < 1 || total > 255) throw new Error('Invalid pre-handshake payload size');
  return Array.from({ length: total }, (_, index) => {
    const header = Buffer.alloc(4);
    header.writeUInt16LE(opcode); header[2] = total; header[3] = index;
    return Buffer.concat([header, payload.subarray(index * 100, (index + 1) * 100)]);
  });
}

export class PlaudKeyChunks {
  private total: number | null = null;
  private chunks = new Map<number, Buffer>();

  add(packet: Uint8Array): Buffer | null {
    const bytes = Buffer.from(packet);
    if (bytes.length < 5 || bytes.length > 104 || bytes.readUInt16LE(0) !== PLAUD_COMMAND.publicKey) {
      throw new Error('Invalid key-exchange packet');
    }
    const [total, index] = [bytes[2]!, bytes[3]!];
    if (total === 0 || total > 3 || index >= total || (this.total !== null && total !== this.total)) {
      throw new Error('Inconsistent RSA-2048 key-exchange chunks');
    }
    const payload = bytes.subarray(4);
    if (this.chunks.has(index) && !this.chunks.get(index)!.equals(payload)) throw new Error('Conflicting key chunk');
    this.total = total;
    this.chunks.set(index, payload);
    if (this.chunks.size !== total) return null;
    const result = Buffer.concat(Array.from({ length: total }, (_, i) => this.chunks.get(i)!));
    if (result.length !== 256) throw new Error('Invalid RSA-2048 ciphertext size');
    return result;
  }
}

export interface PlaudSessionEntry { sessionId: number; size: number; scene: number; timezone: number }

export function parseSessionPage(packet: Uint8Array, protocolVersion: number) {
  const bytes = Buffer.from(packet);
  if (bytes.length < 11 || bytes[0] !== 1 || bytes.readUInt16LE(1) !== PLAUD_COMMAND.sessions) {
    throw new Error('Invalid recording-list response');
  }
  if (!Number.isInteger(protocolVersion) || protocolVersion < 1) throw new Error('Invalid protocol version');
  const stride = protocolVersion === 1 ? 8 : protocolVersion < 7 ? 9 : 10;
  const total = bytes.readUInt16LE(7), offset = bytes.readUInt16LE(9);
  if ((bytes.length - 11) % stride !== 0 || offset + (bytes.length - 11) / stride > total) {
    throw new Error('Truncated or inconsistent recording-list page');
  }
  const entries: PlaudSessionEntry[] = [];
  for (let start = 11; start < bytes.length; start += stride) {
    entries.push({ sessionId: bytes.readUInt32LE(start), size: bytes.readUInt32LE(start + 4),
      scene: stride === 8 ? 0 : bytes[start + stride - 1]!, timezone: stride === 10 ? bytes[start + 8]! : 0 });
  }
  return { requestId: bytes.readUInt32LE(3), total, offset, entries };
}
