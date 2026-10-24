import { expect, test } from 'bun:test';
import { chacha20 } from '@noble/ciphers/chacha.js';
import { decodePlaudAudio, oggCrc, parsePlaudAudioHeader, validateOggAudio } from './plaud-audio';

function oggPage(flags = 6, sequence = 0) {
  const bytes = Buffer.alloc(47);
  bytes.write('OggS'); bytes[5] = flags; bytes.writeUInt32LE(3, 14); bytes.writeUInt32LE(sequence, 18);
  bytes[26] = 1; bytes[27] = 19; bytes.write('OpusHead', 28); bytes[36] = 1; bytes[37] = 1;
  bytes.writeUInt32LE(oggCrc(bytes), 22);
  return bytes;
}

test('Ogg integrity checks checksum, channels, pages, sequence and end-of-stream', () => {
  expect(oggCrc(Buffer.from('123456789'))).toBe(0x89a1897f);
  const valid = oggPage();
  expect(validateOggAudio(valid, 1).pages).toBe(1);
  expect(() => validateOggAudio(valid, 2)).toThrow('channel');
  expect(() => validateOggAudio(valid.subarray(0, -1), 1)).toThrow('Incomplete');
  expect(() => validateOggAudio(oggPage(2), 1)).toThrow('Incomplete');
  expect(() => validateOggAudio(oggPage(6, 2), 1)).toThrow('Discontinuous');
  expect(() => validateOggAudio(Buffer.concat([valid, valid]), 1)).toThrow('Discontinuous');
  valid[46] ^= 1;
  expect(() => validateOggAudio(valid, 1)).toThrow('checksum');
});

test('Plaud file unwrap validates the negotiated format and wipes symmetric key material', async () => {
  const key = Buffer.alloc(32, 3), nonce = Buffer.alloc(12, 5), header = Buffer.alloc(512);
  header.write('PLAUD.AI'); header.writeUInt16LE(1, 8); header.writeUInt16LE(512, 10);
  header.writeUInt16LE(1, 48); header.writeUInt16LE(1, 50); header.writeUInt16LE(1, 52); nonce.copy(header, 132);
  const input = Buffer.concat([header, chacha20(key, nonce, oggPage())]);
  expect(parsePlaudAudioHeader(input).channels).toBe(1);
  const result = await decodePlaudAudio(input, async () => key);
  expect(result.integrity.pages).toBe(1);
  expect(key.every(byte => byte === 0)).toBe(true);
  await expect(decodePlaudAudio(input, async () => Buffer.alloc(31))).rejects.toThrow('key');
  const badKey = Buffer.alloc(32, 4);
  await expect(decodePlaudAudio(input, async () => badKey)).rejects.toThrow();
  expect(badKey.every(byte => byte === 0)).toBe(true);
  input[52] = 2;
  expect(() => parsePlaudAudioHeader(input)).toThrow('Unsupported');
});

test('decodes a recorder that streams raw Opus packets instead of Ogg', async () => {
  // Plaud Note layout: byte 48 is 5, the packet size sits at 144, and every
  // 80-byte segment is one Opus packet encrypted with its own keystream.
  const key = Buffer.alloc(32, 7), nonce = Buffer.alloc(12, 9), header = Buffer.alloc(512);
  header.write('PLAUD.AI'); header.writeUInt16LE(1, 8); header.writeUInt16LE(512, 10);
  header.writeUInt16LE(5, 48); header.writeUInt16LE(1, 50); header.writeUInt16LE(1, 52);
  header.writeUInt16LE(80, 144); nonce.copy(header, 132);
  const packets = Buffer.alloc(160, 0xb8);
  const encrypted = Buffer.concat([0, 1].map(index =>
    Buffer.from(chacha20(key, nonce, packets.subarray(index * 80, index * 80 + 80)))));
  const result = await decodePlaudAudio(Buffer.concat([header, encrypted]), async () => key);
  expect(result.integrity.channels).toBe(1);
  expect(result.integrity.pages).toBeGreaterThan(2);
  expect(result.audio.subarray(0, 4).toString()).toBe('OggS');
});
