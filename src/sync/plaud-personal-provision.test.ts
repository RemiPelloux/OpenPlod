import { describe, expect, test } from 'bun:test';
import { createCipheriv, createHmac, createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { PlaudPersonalIdentityProvisioner, provisionPlaudAccount } from './plaud-personal-provision';
import rsaFixture from './fixtures/plaud-rsa-synthetic.json';

const serial = '8810000000000001';
const identifier = 'C4:96:9D:11:27:21';
const jwt = (claims: Record<string, unknown> = {}) => `header.${Buffer.from(JSON.stringify({ sub: 'owner-fixture', ...claims })).toString('base64url')}.signature`;
const pair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const privateDer = createPrivateKey(pair.privateKey).export({ type: 'pkcs1', format: 'der' }).toString('base64');
const signature = Buffer.alloc(256, 3).toString('base64');
const keyData = { public_key_base64: Buffer.from(pair.publicKey).toString('base64'), private_key_base64: Buffer.from(pair.privateKey).toString('base64') };
const signData = { signature: { [serial]: signature } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ok = (data: unknown) => json({ status: 0, data });

// Independent encrypted fixture, using the documented public envelope format.
const encrypted = (data: unknown, tamper = false) => {
  const key = Buffer.from('8rRmMCskL3NaUiGr-UsmEEeI8NKH-ZfeGbpRGqSLpuI=', 'base64url');
  const iv = Buffer.alloc(16, 7);
  const cipher = createCipheriv('aes-128-cbc', key.subarray(16), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ status: 0, data })), cipher.final()]);
  const body = Buffer.concat([Buffer.from([0x80]), Buffer.alloc(8), iv, ciphertext]);
  const mac = createHmac('sha256', key.subarray(0, 16)).update(body).digest();
  if (tamper) mac[0] = mac[0]! ^ 1;
  return new Response(Buffer.concat([body, mac]).toString('base64url'), { headers: { 'x-encrypt-response': '1' } });
};

describe('personal-account authorization', () => {
  test('distinguishes an HTML edge refusal from an API authorization refusal without exposing response data', async () => {
    const options = { token: jwt(), serial, identifier };
    const edge = new PlaudPersonalIdentityProvisioner(async () => new Response('<html>private diagnostic</html>', {status:403,headers:{'content-type':'text/html'}}));
    await expect(edge.provision(options)).rejects.toThrow('blocked by an HTML response (HTTP 403, sn-sign)');
    const api = new PlaudPersonalIdentityProvisioner(async () => new Response('{"secret":"private diagnostic"}', {status:401,headers:{'content-type':'application/json'}}));
    await expect(api.provision(options)).rejects.toThrow('refused authorization (HTTP 401, sn-sign)');
  });

  test('retries a transient serial-signing error but never replays uncertain key generation', async () => {
    const urls: string[] = [];
    const provisioner = new PlaudPersonalIdentityProvisioner(async url => {
      urls.push(url);
      if (urls.length === 1) return new Response('', { status: 503 });
      if (url.endsWith('sn-sign')) return ok(signData);
      throw new Error('lost key-generation response');
    });
    await expect(provisioner.provision({ token: jwt(), serial, identifier })).rejects.toThrow('could not be reached');
    expect(urls.filter(url => url.endsWith('sn-sign'))).toHaveLength(2);
    expect(urls.filter(url => url.endsWith('gen_key'))).toHaveLength(1);
  });

  test('cancelled authorization never contacts the account API', async () => {
    let calls = 0;
    await expect(new PlaudPersonalIdentityProvisioner(async () => { calls++; return ok(signData); })
      .provision({ token: jwt(), serial, identifier, signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(calls).toBe(0);
  });
  test('consumer PEM becomes the exact DER key decrypted by the native bridge test', async () => {
    const identity = await new PlaudPersonalIdentityProvisioner(async url => ok(url.endsWith('sn-sign') ? signData : {
      private_key_base64: Buffer.from(rsaFixture.privateKey).toString('base64'),
      public_key_base64: Buffer.from(rsaFixture.publicKey).toString('base64'),
    })).provision({ token: jwt(), serial, identifier });
    expect(identity.privateKey).toBe(rsaFixture.privateDer);
    expect(identity.publicKey).toBe(rsaFixture.publicKey);
    expect(identity.privateKey).not.toContain('BEGIN');
  });
  test('explicit personal account uses the consumer API, normalizes credentials and preserves the existing binding', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const token = jwt({ region: 'aws:eu-central-1' });
    const result = await provisionPlaudAccount({ token: `Bearer ${token}`, serial, identifier, accountType: 'personal' }, async (url, init) => {
      calls.push({ url, init });
      return ok(url.endsWith('sn-sign') ? signData : keyData);
    });
    expect(calls.map(c => c.url)).toEqual([
      'https://api-euc1.plaud.ai/device-app/device/sn-sign',
      'https://api-euc1.plaud.ai/device-app/e2ee/gen_key',
    ]);
    expect(calls.map(c => JSON.parse(String(c.init.body)))).toEqual([{ sns: [serial] }, {}]);
    expect(calls.every(c => c.init.redirect === 'error' && (c.init.headers as Record<string, string>).Authorization === `Bearer ${token}`)).toBe(true);
    expect(result).toEqual({ identifier, serial, bindingToken: 'owner-fixture', signature, publicKey: pair.publicKey, privateKey: privateDer, deviceType: 'notepro' });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  test('authenticates and decrypts Fernet envelopes', async () => {
    const result = await new PlaudPersonalIdentityProvisioner(async url => encrypted(url.endsWith('sn-sign') ? signData : keyData))
      .provision({ token: jwt(), serial, identifier });
    expect(result.privateKey).toBe(privateDer);
  });

  test('rejects tampering before requesting private keys', async () => {
    let count = 0;
    await expect(new PlaudPersonalIdentityProvisioner(async () => { count++; return encrypted(signData, true); })
      .provision({ token: jwt(), serial, identifier })).rejects.toThrow(/unauthenticated/);
    expect(count).toBe(1);
  });

  test('follows an allowlisted account region and retains it for the key request', async () => {
    const urls: string[] = [];
    await new PlaudPersonalIdentityProvisioner(async url => {
      urls.push(url);
      if (urls.length === 1) return json({ status: -302, data: { domains: { api: 'https://api-apse1.plaud.ai/' } } });
      return ok(url.endsWith('sn-sign') ? signData : keyData);
    }).provision({ token: jwt(), serial, identifier });
    expect(urls).toEqual([
      'https://api.plaud.ai/device-app/device/sn-sign',
      'https://api-apse1.plaud.ai/device-app/device/sn-sign',
      'https://api-apse1.plaud.ai/device-app/e2ee/gen_key',
    ]);
  });

  test('never forwards a token to an untrusted region URL', async () => {
    for (const api of ['http://api.plaud.ai', 'https://api.plaud.ai.evil.test', 'https://api.plaud.ai@evil.test', 'https://api.plaud.ai:8443', 'https://api.plaud.ai/other']) {
      let count = 0;
      await expect(new PlaudPersonalIdentityProvisioner(async () => { count++; return json({ status: -302, data: { domains: { api } } }); })
        .provision({ token: jwt(), serial, identifier })).rejects.toThrow(/unsupported authorization region/);
      expect(count).toBe(1);
    }
  });

  test('bounds region loops', async () => {
    let count = 0;
    await expect(new PlaudPersonalIdentityProvisioner(async () => { count++; return json({ status: -302, data: { domains: { api: 'https://api.plaud.ai' } } }); })
      .provision({ token: jwt(), serial, identifier })).rejects.toThrow(/region could not be resolved/);
    expect(count).toBe(2);
  });

  test('validates local input before contacting Plaud', async () => {
    let calls = 0;
    const fetcher = async () => { calls++; return ok({}); };
    for (const input of [
      { token: jwt({ exp: 1 }), serial, identifier },
      { token: jwt(), serial: 'invalid', identifier },
      { token: jwt(), serial, identifier: 'invalid' },
      { token: 'invalid', serial, identifier },
      { serial, identifier },
      { token: jwt(), serial, identifier, accountType: 'other' },
    ]) await expect(provisionPlaudAccount({ ...input, accountType: input.accountType ?? 'personal' }, fetcher)).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test('rejects errors, wrong serial signatures, malformed responses and mismatched RSA keys', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const cases = [
      async () => json({ secret: 'do-not-echo' }, 401),
      async () => json({ status: -1, msg: 'do-not-echo' }),
      async () => new Response('do-not-echo'),
      async () => ok({ signature: { other: signature } }),
      async (url: string) => ok(url.endsWith('sn-sign') ? signData : { ...keyData, private_key_base64: Buffer.from('do-not-echo').toString('base64') }),
      async (url: string) => ok(url.endsWith('sn-sign') ? signData : { ...keyData, public_key_base64: Buffer.from(other.publicKey).toString('base64') }),
      async () => { throw new Error('do-not-echo'); },
    ];
    for (const fetcher of cases) {
      let failure: unknown;
      try { await new PlaudPersonalIdentityProvisioner(fetcher).provision({ token: jwt(), serial, identifier }); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain('do-not-echo');
    }
  });

  test.each([undefined, 'partner'])('partner tokens retain their API when accountType is %s', async accountType => {
    const urls: string[] = [];
    const identity = await provisionPlaudAccount({ token: jwt(), serial, identifier, accountType, domain: 'platform-jp.plaud.ai' }, async url => {
      urls.push(url);
      return json(url.endsWith('gen-key') ? { public_key: 'PUBLIC', private_key: 'PRIVATE' } : { signature: 'SIGNATURE' });
    });
    expect(urls).toEqual([
      'https://platform-jp.plaud.ai/developer/api/open/partner/sdk/gen-key',
      'https://platform-jp.plaud.ai/developer/api/open/partner/sdk/sn-sign',
    ]);
    expect(identity.bindingToken).toBe('owner-fixture');
  });
});
