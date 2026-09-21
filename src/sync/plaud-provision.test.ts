import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BINDING_TOKEN_PATTERN, PlaudIdentityProvisioner, clearStoredIdentity, deviceTypeForSerial,
  identityFilePath, normalizeAccessToken, parseAccessToken, provisionWithDeveloperCredentials,
  readStoredIdentity, writeStoredIdentity,
} from './plaud-provision';

const SERIAL = '8810B50327175322';
const MAC = 'C4:96:9D:11:27:21';
const BINDING_TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';

const token = (payload: Record<string, unknown>) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const temporaryPaths: string[] = [];
afterEach(async () => {
  delete process.env.OPENPLOD_DEVICE_IDENTITY;
  while (temporaryPaths.length) await rm(temporaryPaths.pop()!, { recursive: true, force: true });
});

describe('normalizeAccessToken', () => {
  test('accepts a bare token, quotes, a Bearer header and a storage blob', () => {
    expect(normalizeAccessToken('  abc.def.ghi  ')).toBe('abc.def.ghi');
    expect(normalizeAccessToken('"abc.def.ghi"')).toBe('abc.def.ghi');
    expect(normalizeAccessToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(normalizeAccessToken(JSON.stringify({ tokenstr: 'abc.def.ghi' }))).toBe('abc.def.ghi');
    expect(normalizeAccessToken(JSON.stringify({ access_token: 'abc.def.ghi' }))).toBe('abc.def.ghi');
  });
});

describe('parseAccessToken', () => {
  test('reads the binding token, user id and expiry', () => {
    const claims = parseAccessToken(token({ sub: BINDING_TOKEN, user_id: 'user-7', client_id: 'plaud-web', exp: 1_700_000_000 }));
    expect(claims).toEqual({ sub: BINDING_TOKEN, userId: 'user-7', clientId: 'plaud-web', expiresAt: 1_700_000_000_000 });
  });

  test('falls back to the binding token when the user id is absent', () => {
    expect(parseAccessToken(token({ sub: BINDING_TOKEN })).userId).toBe(BINDING_TOKEN);
  });

  test('rejects malformed tokens and missing binding tokens', () => {
    expect(() => parseAccessToken('not-a-jwt')).toThrow(/does not look like/);
    expect(() => parseAccessToken('a.!!!.c')).toThrow(/could not be read/);
    expect(() => parseAccessToken(token({ user_id: 'user-7' }))).toThrow(/binding token/);
    expect(() => parseAccessToken(token({ sub: 'has spaces here' }))).toThrow(/binding token/);
  });

  test('accepts binding tokens that need handshake padding', () => {
    expect(parseAccessToken(token({ sub: 'short' })).sub).toBe('short');
    expect(BINDING_TOKEN_PATTERN.test('x'.repeat(64))).toBe(true);
  });
});

describe('deviceTypeForSerial', () => {
  test('maps serial prefixes to Plaud cloud device types', () => {
    expect(deviceTypeForSerial('8800000000000000')).toBe('notepin');
    expect(deviceTypeForSerial('8810B50327175322')).toBe('notepro');
    expect(deviceTypeForSerial('8820000000000000')).toBe('notepins');
    expect(deviceTypeForSerial('8830000000000000')).toBe('notepro');
    expect(deviceTypeForSerial('8890000000000000')).toBe('note');
  });

  test('rejects serials that are not 16 uppercase hex characters', () => {
    expect(() => deviceTypeForSerial('8810b50327175322')).toThrow(/serial number/);
    expect(() => deviceTypeForSerial('8810')).toThrow(/serial number/);
  });
});

describe('PlaudIdentityProvisioner', () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (responses: Record<string, Response>) => async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    const match = Object.entries(responses).find(([fragment]) => url.includes(fragment));
    if (!match) throw new Error(`unexpected request ${url}`);
    return match[1].clone();
  };

  test('mints a complete identity from gen-key and sn-sign', async () => {
    requests.length = 0;
    const provisioner = new PlaudIdentityProvisioner(fetcher({
      'gen-key': jsonResponse(200, { public_key: 'PUBLIC', private_key: 'PRIVATE' }),
      'sn-sign': jsonResponse(200, { signature: 'SIGNATURE' }),
    }));
    const accessToken = token({ sub: BINDING_TOKEN, user_id: 'u1' });
    const identity = await provisioner.provision({ token: accessToken, serial: SERIAL, identifier: MAC });
    expect(identity).toEqual({
      identifier: MAC, serial: SERIAL, bindingToken: BINDING_TOKEN,
      publicKey: 'PUBLIC', privateKey: 'PRIVATE', signature: 'SIGNATURE', deviceType: 'notepro',
    });
    expect(requests.map(request => new URL(request.url).pathname)).toEqual([
      '/developer/api/open/partner/sdk/gen-key',
      '/developer/api/open/partner/sdk/sn-sign',
    ]);
    expect(requests.every(request => (request.init.headers as Record<string, string>).Authorization === `Bearer ${accessToken}`)).toBe(true);
    expect(JSON.parse(String(requests[1]!.init.body))).toEqual({ type: 'notepro', sn: SERIAL });
  });

  test('surfaces a rejected token with actionable copy', async () => {
    const provisioner = new PlaudIdentityProvisioner(fetcher({ 'gen-key': jsonResponse(401, { detail: 'ACCESS_TOKEN_INVALID' }) }));
    await expect(provisioner.provision({ token: token({ sub: BINDING_TOKEN }), serial: SERIAL, identifier: MAC }))
      .rejects.toThrow(/rejected the sign-in token/);
  });

  test('rejects an identity for a non-Bluetooth identifier', async () => {
    const provisioner = new PlaudIdentityProvisioner(fetcher({}));
    await expect(provisioner.provision({ token: token({ sub: BINDING_TOKEN }), serial: SERIAL, identifier: 'not-an-address' }))
      .rejects.toThrow(/Bluetooth address/);
  });

  test('reports unreachable Plaud without leaking the network error', async () => {
    const provisioner = new PlaudIdentityProvisioner(async () => { throw new Error('ECONNREFUSED'); });
    await expect(provisioner.generateKeyPair(token({ sub: BINDING_TOKEN }))).rejects.toThrow(/could not be reached/);
  });

  test('rejects missing key material', async () => {
    const provisioner = new PlaudIdentityProvisioner(fetcher({ 'gen-key': jsonResponse(200, { public_key: 'PUBLIC' }) }));
    await expect(provisioner.generateKeyPair(token({ sub: BINDING_TOKEN }))).rejects.toThrow(/no recorder key material/);
  });
});

describe('identity storage', () => {
  const withTemporaryIdentity = async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openplod-provision-'));
    temporaryPaths.push(directory);
    process.env.OPENPLOD_DEVICE_IDENTITY = join(directory, 'nested', 'plaud-device.json');
    return process.env.OPENPLOD_DEVICE_IDENTITY;
  };

  test('writes an owner-only identity that reads back verbatim', async () => {
    const path = await withTemporaryIdentity();
    const identity = {
      identifier: MAC, serial: SERIAL, bindingToken: BINDING_TOKEN,
      signature: 'SIGNATURE', publicKey: 'PUBLIC', privateKey: 'PRIVATE',
    };
    await writeStoredIdentity(identity);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(identity);
    expect(await readStoredIdentity()).toEqual(identity);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o077).toBe(0);
  });

  test('reports a saved identity and clears it', async () => {
    await withTemporaryIdentity();
    expect(await readStoredIdentity()).toBeNull();
    await writeStoredIdentity({ identifier: MAC, serial: SERIAL, bindingToken: BINDING_TOKEN, signature: 's', publicKey: 'p', privateKey: 'q' });
    expect(identityFilePath()).toBe(process.env.OPENPLOD_DEVICE_IDENTITY!);
    expect(await clearStoredIdentity()).toBe(true);
    expect(await readStoredIdentity()).toBeNull();
    expect(await clearStoredIdentity()).toBe(false);
  });
});

describe('provisionWithDeveloperCredentials', () => {
  test('uses the partner access token to provision', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const provisioner = new PlaudIdentityProvisioner(async (url, init) => {
      calls.push({ url, init });
      if (url.includes('gen-key')) return jsonResponse(200, { public_key: 'PUBLIC', private_key: 'PRIVATE' });
      return jsonResponse(200, { signature: 'SIGNATURE' });
    });
    const identity = await provisioner.provision({
      token: token({ sub: BINDING_TOKEN }), serial: SERIAL, identifier: MAC, domain: 'platform-jp.plaud.ai',
    });
    expect(identity.deviceType).toBe('notepro');
    expect(calls.every(call => call.url.startsWith('https://platform-jp.plaud.ai/'))).toBe(true);

    // The developer-credential helper reuses the existing auth flow end to end.
    const session = { userAccessToken: token({ sub: BINDING_TOKEN }), expiresAt: Date.now() + 60_000, domain: 'platform-us.plaud.ai' };
    const result = await provisionWithDeveloperCredentials({
      serial: SERIAL, identifier: MAC,
      credentials: { clientId: 'id', clientSecret: 'secret', userId: 'owner', domain: 'platform-us.plaud.ai' },
      auth: { session: async () => session } as never,
      provisioner,
    });
    expect(result.bindingToken).toBe(BINDING_TOKEN);
  });

  test('explains how to supply developer credentials', async () => {
    await expect(provisionWithDeveloperCredentials({
      serial: SERIAL, identifier: MAC,
      credentials: { clientId: '', clientSecret: '', userId: 'owner', domain: 'platform-us.plaud.ai' },
    })).rejects.toThrow(/client ID and secret/);
  });
});
