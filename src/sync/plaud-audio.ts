import { chacha20 } from '@noble/ciphers/chacha.js';

export type RsaUnwrap = (ciphertext: Buffer) => Promise<Buffer>;

export function parsePlaudAudioHeader(input: Uint8Array) {
  const bytes = Buffer.from(input);
  // Byte 48 is 1 on Note Pro files. Recorders that stream raw Opus packets write
  // a different codec marker there (5 on the Plaud Note) and store the packet
  // size at 144, so the marker is not a validity condition.
  if (bytes.length <= 512 || bytes.subarray(0, 8).toString() !== 'PLAUD.AI'
    || bytes.readUInt16LE(8) !== 1 || bytes.readUInt16LE(10) !== 512
    || bytes.readUInt16LE(52) !== 1) {
    throw new Error('Unsupported Plaud audio header');
  }
  const channels = bytes.readUInt16LE(50);
  if (channels < 1 || channels > 2) throw new Error('Unsupported Plaud audio channels');
  const segmentSize = bytes.readUInt16LE(48) === 1 ? 0 : bytes.readUInt16LE(144);
  if (segmentSize !== 0 && (segmentSize < 8 || segmentSize > 4096)) {
    throw new Error('Unsupported Plaud audio segment size');
  }
  return { channels, counter: bytes.readUInt32LE(128), nonce: bytes.subarray(132, 144),
    encryptedKey: bytes.subarray(256, 512), payload: bytes.subarray(512), segmentSize };
}

export function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc = (crc ^ (byte << 24)) >>> 0;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0)) >>> 0;
  }
  return crc;
}

// Raw file ChaCha20 has no authentication tag. Require every Ogg page checksum,
// continuous per-stream sequence numbers and end-of-stream before accepting audio.
export function validateOggAudio(input: Uint8Array, expectedChannels: number) {
  const bytes = Buffer.from(input);
  const streams = new Map<number, { sequence: number; ended: boolean }>();
  let offset = 0, pages = 0, opus = false;
  while (offset < bytes.length) {
    if (offset + 27 > bytes.length || bytes.subarray(offset, offset + 4).toString() !== 'OggS'
      || bytes[offset + 4] !== 0) throw new Error('Truncated or invalid Ogg page');
    const segments = bytes[offset + 26]!;
    const headerEnd = offset + 27 + segments;
    if (headerEnd > bytes.length) throw new Error('Truncated Ogg segment table');
    let length = 0;
    for (const segment of bytes.subarray(offset + 27, headerEnd)) length += segment;
    const end = headerEnd + length;
    if (end > bytes.length) throw new Error('Incomplete Ogg payload');
    const page = Buffer.from(bytes.subarray(offset, end));
    const checksum = page.readUInt32LE(22);
    page.fill(0, 22, 26);
    if (oggCrc(page) !== checksum) throw new Error('Ogg checksum mismatch');
    const serial = page.readUInt32LE(14), sequence = page.readUInt32LE(18), flags = page[5]!;
    const previous = streams.get(serial);
    if ((!previous && (sequence !== 0 || !(flags & 2)))
      || (previous && (previous.ended || sequence !== previous.sequence + 1 || (flags & 2)))) {
      throw new Error('Discontinuous Ogg stream');
    }
    streams.set(serial, { sequence, ended: Boolean(flags & 4) });
    if (!previous && bytes.subarray(headerEnd, headerEnd + 8).toString() === 'OpusHead') {
      if (length < 19 || bytes[headerEnd + 9] !== expectedChannels) throw new Error('Opus channel mismatch');
      opus = true;
    }
    pages++; offset = end;
  }
  if (!opus || !streams.size || [...streams.values()].some(stream => !stream.ended)) {
    throw new Error('Incomplete Opus recording');
  }
  return { pages, streams: streams.size, channels: expectedChannels };
}

/** Opus TOC configuration → samples per frame at 48 kHz (RFC 6716, table 2). */
const OPUS_FRAME_SAMPLES = [480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 1920, 2880,
  480, 960, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960];

/**
 * Recorders that report `isOggAudio = 0` stream raw Opus packets. Every segment of
 * `segmentSize` bytes is one packet, encrypted with its own ChaCha20 keystream
 * started at counter 0 with the file nonce. Wrapping the packets into Ogg keeps the
 * integrity checks and the ffmpeg conversion downstream unchanged.
 */
export function decodeSegmentedOpus(key: Uint8Array, nonce: Uint8Array, payload: Uint8Array,
  segmentSize: number, channels: number): Buffer {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < payload.length; offset += segmentSize) {
    const segment = payload.subarray(offset, Math.min(offset + segmentSize, payload.length));
    if (segment.length) packets.push(Buffer.from(chacha20(key, nonce, segment)));
  }
  if (!packets.length) throw new Error('Empty Plaud audio payload');
  const serial = 0x4f50454e;
  const pages: Buffer[] = [];
  let sequence = 0;
  const head = Buffer.alloc(19);
  head.write('OpusHead'); head[8] = 1; head[9] = channels;
  head.writeUInt16LE(312, 10); head.writeUInt32LE(48000, 12); head[18] = 0;
  pages.push(oggPage(head, 0, 0x02, serial, sequence++));
  const vendor = Buffer.from('OpenPlod');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(vendor.length);
  const tags = Buffer.concat([Buffer.from('OpusTags'), length, vendor, Buffer.alloc(4)]);
  pages.push(oggPage(tags, 0, 0x00, serial, sequence++));
  let granule = 312;
  for (const [index, packet] of packets.entries()) {
    granule += OPUS_FRAME_SAMPLES[packet[0]! >> 3] ?? 960;
    pages.push(oggPage(packet, granule, index === packets.length - 1 ? 0x04 : 0x00, serial, sequence++));
  }
  return Buffer.concat(pages);
}

function oggPage(payload: Buffer, granule: number, headerType: number, serial: number, sequence: number): Buffer {
  const segments: number[] = [];
  let remaining = payload.length;
  while (remaining >= 255) { segments.push(255); remaining -= 255; }
  segments.push(remaining);
  const head = Buffer.alloc(27 + segments.length);
  head.write('OggS'); head[4] = 0; head[5] = headerType;
  head.writeBigInt64LE(BigInt(granule), 6);
  head.writeUInt32LE(serial, 14); head.writeUInt32LE(sequence, 18);
  head[26] = segments.length;
  segments.forEach((value, index) => { head[27 + index] = value; });
  const page = Buffer.concat([head, payload]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

export async function decodePlaudAudio(input: Uint8Array, unwrap: RsaUnwrap) {
  const header = parsePlaudAudioHeader(input);
  const key = await unwrap(header.encryptedKey);
  try {
    if (key.length !== 32) throw new Error('Plaud audio key does not match the authorized identity');
    if (header.counter !== 0) throw new Error('Unsupported Plaud audio counter');
    const audio = header.segmentSize > 0
      ? decodeSegmentedOpus(key, header.nonce, header.payload, header.segmentSize, header.channels)
      : Buffer.from(chacha20(key, header.nonce, header.payload));
    const integrity = validateOggAudio(audio, header.channels);
    return { audio, integrity };
  } finally { key.fill(0); }
}
