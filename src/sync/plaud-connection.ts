import { PlaudTransport } from './plaud-transport';
import { buildPreHandshakeChunks, PLAUD_COMMAND, PlaudKeyChunks } from './plaud-protocol';
import { PlaudSessionCipher } from './plaud-session-cipher';

export interface PlaudIdentity { signature: string; publicKey: string; privateKey: string }

export class PlaudConnection {
  private cipher: PlaudSessionCipher | null = null;

  constructor(readonly transport: PlaudTransport) {}

  async establishEncryption(identity: PlaudIdentity, progress: (stage: string) => void = () => {}) {
    progress('sending_signed_identity');
    const collector = new PlaudKeyChunks();
    for (const packet of buildPreHandshakeChunks(PLAUD_COMMAND.signature, Buffer.from(identity.signature, 'base64'))) {
      await this.transport.write(packet);
    }
    let encryptedKeys: Buffer | null = null;
    let publicKeySent = false;
    const deadline = Date.now() + 30000;
    while (!encryptedKeys && Date.now() < deadline) {
      const packet = await this.transport.packet(Math.min(10000, deadline - Date.now()));
      if (packet.length < 2) throw new Error('Truncated pre-handshake response');
      const opcode = packet.readUInt16LE(0);
      if (opcode === PLAUD_COMMAND.signatureAccepted && !publicKeySent) {
        progress('identity_accepted_sending_public_key');
        for (const chunk of buildPreHandshakeChunks(PLAUD_COMMAND.publicKey, Buffer.from(identity.publicKey))) {
          await this.transport.write(chunk);
        }
        publicKeySent = true;
      } else if (opcode === PLAUD_COMMAND.publicKey) encryptedKeys = collector.add(packet);
      else throw new Error(`Unexpected pre-handshake response (${opcode})`);
    }
    if (!encryptedKeys) throw new Error('Key exchange timed out');
    const reply = await this.transport.request('rsa-decrypt', { data: encryptedKeys.toString('base64'), key: identity.privateKey });
    const material = Buffer.from(reply.data ?? '', 'base64');
    try { this.cipher = new PlaudSessionCipher(material); } finally { material.fill(0); }
    progress('encrypted_session_verified');
  }

  async write(packet: Uint8Array) {
    if (!this.cipher) throw new Error('Encrypted session is not ready');
    await this.transport.write(this.cipher.encrypt(packet));
  }

  async packet(timeoutMs = 10000): Promise<Buffer> {
    if (!this.cipher) throw new Error('Encrypted session is not ready');
    return this.cipher.decrypt(await this.transport.packet(timeoutMs));
  }

  async close() { this.cipher?.destroy(); this.cipher = null; await this.transport.close(); }
}
