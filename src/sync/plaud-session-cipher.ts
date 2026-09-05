import { chacha20poly1305 } from '@noble/ciphers/chacha.js';

// The device defines the per-session nonce/AD. Never reuse these keys across connections.
// RSA PKCS#1 v1.5 unwrapping must use the native macOS Security framework, not Bun's
// privateDecrypt (which rejects that padding). This layer receives only unwrapped bytes.
export class PlaudSessionCipher {
  private key: Buffer;
  private nonce: Buffer;
  private associatedData: Buffer;
  private sendCounter = 1;
  private receiveCounter = -1;
  private closed = false;

  constructor(material: Uint8Array) {
    if (material.length !== 80) throw new Error(`Invalid Plaud session material length (${material.length})`);
    this.key = Buffer.from(material.subarray(0, 32));
    this.nonce = Buffer.from(material.subarray(32, 44));
    this.associatedData = Buffer.from(material.subarray(44, 56));
    try {
      if (!this.open(material.subarray(56)).equals(Buffer.from('PLAUD.AI'))) {
        throw new Error('Invalid device key verification marker');
      }
    } catch {
      this.destroy();
      throw new Error('Plaud key-exchange verification failed');
    }
  }

  private open(ciphertext: Uint8Array): Buffer {
    if (this.closed || ciphertext.length < 16) throw new Error('Invalid encrypted Plaud packet');
    return Buffer.from(chacha20poly1305(this.key, this.nonce, this.associatedData).decrypt(ciphertext));
  }

  encrypt(packet: Uint8Array): Buffer {
    if (this.closed || packet.length < 3 || this.sendCounter >= 0xffffffff) throw new Error('Plaud session unavailable');
    const counter = Buffer.alloc(4);
    counter.writeUInt32LE(++this.sendCounter);
    const plaintext = Buffer.concat([counter, packet]);
    return Buffer.from(chacha20poly1305(this.key, this.nonce, this.associatedData).encrypt(plaintext));
  }

  decrypt(packet: Uint8Array): Buffer {
    const plaintext = this.open(packet);
    if (plaintext.length < 7) throw new Error('Truncated encrypted Plaud response');
    const counter = plaintext.readUInt32LE(0);
    if (counter <= this.receiveCounter) throw new Error('Replayed or out-of-order Plaud response');
    this.receiveCounter = counter;
    return plaintext.subarray(4);
  }

  destroy() {
    this.closed = true;
    this.key.fill(0); this.nonce.fill(0); this.associatedData.fill(0);
  }
}
