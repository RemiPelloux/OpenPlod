import { createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PlaudIdentity } from './plaud-connection';

type Identity = PlaudIdentity & { serial: string; bindingToken: string };
type Request = { id: string; name: string; code: string; publicKey: string; expiresAt: number; envelope?: { iv: string; wrappedKey: string; ciphertext: string } };
export class PlaudEnrollment {
  private requests = new Map<string, Request>();
  constructor(private identity: () => Promise<Identity>, private now = () => Date.now()) {}
  private cleanup() { for (const [id, request] of this.requests) if (request.expiresAt <= this.now()) this.requests.delete(id); }
  create(input: unknown) {
    this.cleanup();
    if (this.requests.size >= 8) throw new Error('Too many authorization requests. Wait for them to expire.');
    const data = z.object({ publicKey: z.string().min(300).max(1200), name: z.string().trim().min(1).max(80) }).strict().parse(input);
    const key = createPublicKey({ key: Buffer.from(data.publicKey, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 2048) throw new Error('An RSA-2048 enrollment key is required.');
    const request: Request = { ...data, id: randomUUID(), code: createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 6).toUpperCase(), expiresAt: this.now() + 600000 };
    this.requests.set(request.id, request);
    return this.public(request);
  }
  private public(r: Request) { return { id: r.id, name: r.name, code: r.code, expiresAt: r.expiresAt, state: r.envelope ? 'approved' : 'pending' }; }
  list() { this.cleanup(); return [...this.requests.values()].map(r => this.public(r)); }
  get(id: string) { this.cleanup(); const r = this.requests.get(id); if (!r) throw new Error('Authorization expired. Request it again from the phone.'); return { ...this.public(r), envelope: r.envelope }; }
  async approve(id: string, code: string) {
    this.get(id); const r = this.requests.get(id)!;
    if (r.code !== code.toUpperCase()) throw new Error('The phone verification code does not match.');
    if (r.envelope) return this.public(r);
    const source = await this.identity();
    const key = randomBytes(32), iv = randomBytes(12);
    try {
      const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(id));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ serial: source.serial, bindingToken: source.bindingToken,
        signature: source.signature, publicKey: source.publicKey, privateKey: source.privateKey })), cipher.final(), cipher.getAuthTag()]);
      // OAEP SHA-1 is the Android Keystore-compatible encryption padding, not a signature.
      const wrappedKey = publicEncrypt({ key: createPublicKey({ key: Buffer.from(r.publicKey, 'base64'), format: 'der', type: 'spki' }), oaepHash: 'sha1' }, key);
      if (r.expiresAt <= this.now() || !this.requests.has(id)) throw new Error('Authorization request expired.');
      r.envelope = { iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), wrappedKey: wrappedKey.toString('base64') };
      return this.public(r);
    } finally { key.fill(0); }
  }
  remove(id: string) { this.requests.delete(id); return { removed: true }; }
}
