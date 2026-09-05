import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { buildDownloadRequest, buildHandshake, buildPreHandshakeChunks, buildSessionRequest,
  parseNoteProAdvertisement, parseSessionPage, PLAUD_COMMAND, PlaudKeyChunks } from './plaud-protocol';
import { PlaudSessionCipher } from './plaud-session-cipher';

describe('APK-verified Plaud framing', () => {
  test('decodes a synthetic Note Pro advertisement without confusing serial and protocol offsets', () => {
    const data = Buffer.from('5d000271030456000701088810000000000001441400040101', 'hex');
    expect(parseNoteProAdvertisement(data)).toEqual({ project: 881, serial: '8810000000000001',
      protocolVersion: 20, encrypted: true });
    expect(() => parseNoteProAdvertisement(data.subarray(0, 21))).toThrow();
    data[3] = 0;
    expect(() => parseNoteProAdvertisement(data)).toThrow();
  });

  test('handshake uses ASCII zero padding and zero mode, not the advertised protocol version', () => {
    const packet = buildHandshake('test-token', 20);
    expect(packet.subarray(0, 6).toString('hex')).toBe('010100020000');
    expect(packet.subarray(6).toString()).toBe('test-token'.padEnd(32, '0'));
    expect(buildHandshake('x', 2).length).toBe(21);
    expect(buildHandshake('x', 3).length).toBe(22);
    expect(buildHandshake('x'.repeat(40), 20).subarray(6).length).toBe(32);
    expect(() => buildHandshake('', 20)).toThrow();
    expect(() => buildHandshake('bad\nvalue', 20)).toThrow();
  });

  test('list and download builders preserve cursors and ranges', () => {
    expect(buildSessionRequest({ requestId: 7, cursor: 100 }).toString('hex')).toBe('011a00070000006400000000');
    expect(buildDownloadRequest({ sessionId: 10, offset: 20, end: 30 }).toString('hex'))
      .toBe('011c000a000000140000001e000000');
    expect(() => buildDownloadRequest({ sessionId: 10, offset: 30, end: 20 })).toThrow();
    expect(() => buildSessionRequest({ requestId: -1, cursor: 0 })).toThrow();
  });

  test('pre-handshake has no normal protocol prefix and safely reassembles reordered chunks', () => {
    const payload = randomBytes(256);
    const chunks = buildPreHandshakeChunks(PLAUD_COMMAND.publicKey, payload);
    expect(chunks.map(packet => packet.length)).toEqual([104, 104, 60]);
    expect(chunks[0]!.subarray(0, 4).toString('hex')).toBe('12fe0300');
    expect(buildPreHandshakeChunks(PLAUD_COMMAND.signature, payload)[0]!.subarray(0, 2).toString('hex')).toBe('10fe');
    expect(() => buildPreHandshakeChunks(0xfe20, payload)).toThrow('Unsupported');
    const collector = new PlaudKeyChunks();
    expect(collector.add(chunks[2]!)).toBeNull();
    expect(collector.add(chunks[0]!)).toBeNull();
    expect(collector.add(chunks[0]!)).toBeNull();
    expect(collector.add(chunks[1]!)).toEqual(payload);
  });

  test('rejects malformed, conflicting, oversized and incomplete key material', () => {
    const chunks = buildPreHandshakeChunks(PLAUD_COMMAND.publicKey, randomBytes(256));
    const collector = new PlaudKeyChunks();
    collector.add(chunks[0]!);
    const conflict = Buffer.from(chunks[0]!); conflict[4] ^= 1;
    expect(() => collector.add(conflict)).toThrow('Conflicting');
    expect(() => collector.add(Buffer.from([0x12, 0xfe, 4, 3, 1]))).toThrow();
    expect(() => collector.add(Buffer.from([0x12, 0xfe, 2, 1, 1]))).toThrow();
    expect(() => new PlaudKeyChunks().add(Buffer.from([0x12, 0xfe, 1, 0, 1]))).toThrow();
    expect(() => buildPreHandshakeChunks(0xfe12, Buffer.alloc(25501))).toThrow();
    expect(() => buildPreHandshakeChunks(0xfe12, Buffer.alloc(0))).toThrow();
    expect(() => buildPreHandshakeChunks(99, Buffer.alloc(1))).toThrow();
  });

  test('recording-list total and page offset are separate uint16 fields, scene/timezone are separate bytes', () => {
    const packet = Buffer.from('011a0007000000030001000a000000640000002c02', 'hex');
    expect(parseSessionPage(packet, 20)).toEqual({ requestId: 7, total: 3, offset: 1,
      entries: [{ sessionId: 10, size: 100, timezone: 44, scene: 2 }] });
    expect(() => parseSessionPage(packet.subarray(0, -1), 20)).toThrow();
    packet.writeUInt16LE(3, 9);
    expect(() => parseSessionPage(packet, 20)).toThrow();
    expect(parseSessionPage(Buffer.from('011a000700000000000000', 'hex'), 20).total).toBe(0);
    expect(() => parseSessionPage(Buffer.alloc(0), 20)).toThrow();
  });
});

function sessionFixture(marker = 'PLAUD.AI') {
  const key = randomBytes(32), nonce = randomBytes(12), associatedData = randomBytes(12);
  const seal = (plain: Uint8Array) => {
    return Buffer.from(chacha20poly1305(key, nonce, associatedData).encrypt(plain));
  };
  return { key, nonce, associatedData, seal,
    material: Buffer.concat([key, nonce, associatedData, seal(Buffer.from(marker))]) };
}

describe('Note Pro session encryption', () => {
  test('decrypts an independently generated macOS CryptoKit fixture', () => {
    // Generated with CryptoKit ChaChaPoly using synthetic fixed key/nonce/AD.
    const material = Buffer.concat([Buffer.alloc(32, 7), Buffer.alloc(12, 3), Buffer.alloc(12, 5),
      Buffer.from('bbea0c32d2ba19b0fc2584562a17f81b2978a3b15c8bf8e4', 'hex')]);
    const session = new PlaudSessionCipher(material);
    expect(session.decrypt(Buffer.from('eaa64d67978e5840f3cd7315f9c4762025d028e0833515', 'hex')).toString('hex'))
      .toBe('011a00');
  });

  test('requires an authenticated exact verification marker', () => {
    const valid = sessionFixture();
    expect(() => new PlaudSessionCipher(valid.material)).not.toThrow();
    expect(() => new PlaudSessionCipher(sessionFixture('WRONG.AI').material)).toThrow('verification');
    valid.material[79] ^= 1;
    expect(() => new PlaudSessionCipher(valid.material)).toThrow('verification');
    expect(() => new PlaudSessionCipher(Buffer.alloc(56))).toThrow('length');
  });

  test('first command counter is two and is inside the ciphertext', () => {
    const fixture = sessionFixture(), session = new PlaudSessionCipher(fixture.material);
    const packet = buildHandshake('test-token', 20);
    for (const expectedCounter of [2, 3]) {
      const encrypted = session.encrypt(packet);
      const plain = Buffer.from(chacha20poly1305(fixture.key, fixture.nonce, fixture.associatedData).decrypt(encrypted));
      expect(plain.readUInt32LE(0)).toBe(expectedCounter);
      expect(plain.subarray(4).equals(packet)).toBe(true);
    }
  });

  test('rejects altered packets and replay without advancing the receive counter on authentication failure', () => {
    const fixture = sessionFixture(), session = new PlaudSessionCipher(fixture.material);
    const packet = fixture.seal(Buffer.from('01000000011a00', 'hex'));
    const corrupted = Buffer.from(packet); corrupted[0] ^= 1;
    expect(() => session.decrypt(corrupted)).toThrow();
    expect(session.decrypt(packet).toString('hex')).toBe('011a00');
    expect(() => session.decrypt(packet)).toThrow('Replayed');
    expect(() => session.decrypt(fixture.seal(Buffer.alloc(4)))).toThrow('Truncated');
    session.destroy();
    expect(() => session.encrypt(Buffer.from([1, 1, 0]))).toThrow();
    expect(() => session.decrypt(packet)).toThrow();
  });
});
