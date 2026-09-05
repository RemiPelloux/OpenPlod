import { chacha20 } from '@noble/ciphers/chacha.js';

export type RsaUnwrap = (ciphertext: Buffer) => Promise<Buffer>;

export function parsePlaudAudioHeader(input: Uint8Array) {
  const bytes = Buffer.from(input);
  if (bytes.length <= 512 || bytes.subarray(0, 8).toString() !== 'PLAUD.AI'
    || bytes.readUInt16LE(8) !== 1 || bytes.readUInt16LE(10) !== 512
    || bytes.readUInt16LE(48) !== 1 || bytes.readUInt16LE(52) !== 1) {
    throw new Error('Unsupported Plaud audio header');
  }
  const channels = bytes.readUInt16LE(50);
  if (channels < 1 || channels > 2) throw new Error('Unsupported Plaud audio channels');
  return { channels, counter: bytes.readUInt32LE(128), nonce: bytes.subarray(132, 144),
    encryptedKey: bytes.subarray(256, 512), payload: bytes.subarray(512) };
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

export async function decodePlaudAudio(input: Uint8Array, unwrap: RsaUnwrap) {
  const header = parsePlaudAudioHeader(input);
  const key = await unwrap(header.encryptedKey);
  try {
    if (key.length !== 32) throw new Error('Plaud audio key does not match the authorized identity');
    if (header.counter !== 0) throw new Error('Unsupported Plaud audio counter');
    const audio = Buffer.from(chacha20(key, header.nonce, header.payload));
    const integrity = validateOggAudio(audio, header.channels);
    return { audio, integrity };
  } finally { key.fill(0); }
}
