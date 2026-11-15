import { afterEach, describe, expect, test } from 'bun:test';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import app from './plaud';
import { writeStoredIdentity } from '../sync/plaud-provision';

const originalFetch = globalThis.fetch;
const previousIdentityPath = process.env.OPENPLOD_DEVICE_IDENTITY;
const paths: string[] = [];
afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (previousIdentityPath === undefined) delete process.env.OPENPLOD_DEVICE_IDENTITY;
  else process.env.OPENPLOD_DEVICE_IDENTITY = previousIdentityPath;
  while (paths.length) await rm(paths.pop()!, { recursive: true, force: true });
});
const serial = '8810000000000001';
const identifier = 'C4:96:9D:11:27:21';
const token = `header.${Buffer.from(JSON.stringify({ sub: 'fixture-owner' })).toString('base64url')}.signature`;
const identityPath = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openplod-identity-api-'));
  paths.push(directory);
  process.env.OPENPLOD_DEVICE_IDENTITY = join(directory, 'identity.json');
  return process.env.OPENPLOD_DEVICE_IDENTITY;
};
const request = () => app.request('/identity', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token, serial, identifier, accountType: 'personal' }),
});

describe('recorder identity API', () => {
  test('an aborted save preserves the previous identity and removes temporary keys', async () => {
    const path = await identityPath();
    await writeStoredIdentity({ serial, identifier, bindingToken: 'old', signature: 'old', publicKey: 'old', privateKey: 'old' });
    const before = await readFile(path, 'utf8');
    await expect(writeStoredIdentity({ serial, identifier, bindingToken: 'new', signature: 'new', publicKey: 'new', privateKey: 'new' }, AbortSignal.abort())).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(await readdir(paths[paths.length - 1]!)).toEqual(['identity.json']);
  });

  test('removing authorization cancels provisioning and keeps unrelated local recordings', async () => {
    const path = await identityPath();
    const recording = join(paths[paths.length - 1]!, 'recording.ogg');
    await writeFile(recording, 'keep recording');
    const staged = `${path}.00000000-0000-4000-8000-000000000001.tmp`;
    await writeFile(staged, 'synthetic interrupted key save', { mode: 0o600 });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      started();
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      });
    }) as typeof fetch;
    const pending = request();
    await ready;
    const removed = await app.request('/identity', { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect((await pending).status).toBe(400);
    expect(await readFile(path).catch(() => null)).toBeNull();
    expect(await readFile(recording, 'utf8')).toBe('keep recording');
    expect(await readFile(staged).catch(() => null)).toBeNull();
  });
  test('legacy request without accountType or token still uses configured developer credentials', async () => {
    await identityPath();
    const names = ['PLAUD_CLIENT_ID', 'PLAUD_CLIENT_SECRET', 'PLAUD_USER_ID'] as const;
    const previous = names.map(name => process.env[name]);
    const urls: string[] = [];
    try {
      process.env.PLAUD_CLIENT_ID = 'synthetic-client';
      process.env.PLAUD_CLIENT_SECRET = 'synthetic-secret';
      process.env.PLAUD_USER_ID = 'synthetic-owner';
      globalThis.fetch = (async (url: string) => {
        urls.push(url);
        return Response.json(url.endsWith('access-token') ? { access_token: token, expires_in: 3600 }
          : url.endsWith('gen-key') ? { public_key: 'PUBLIC', private_key: 'PRIVATE' } : { signature: 'SIGNATURE' });
      }) as typeof fetch;
      const response = await app.request('/identity', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serial, identifier }),
      });
      expect(response.status).toBe(200);
      expect(urls).toHaveLength(4);
      expect(urls.every(url => url.includes('/developer/api/'))).toBe(true);
      expect(urls.some(url => url.endsWith('/sdk/gen-key'))).toBe(true);
    } finally {
      names.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name];
        else process.env[name] = previous[index];
      });
    }
  });
  test('personal-account routing saves a private identity, never the cookie or keys in the response', async () => {
    const path = await identityPath();
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ status: 0, data: url.endsWith('sn-sign')
        ? { signature: { [serial]: Buffer.alloc(256, 1).toString('base64') } }
        : { public_key_base64: Buffer.from(pair.publicKey).toString('base64'), private_key_base64: Buffer.from(pair.privateKey).toString('base64') } }));
    }) as typeof fetch;
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.data).toEqual({ authorized: true, serial, identifier, deviceType: 'notepro' });
    expect(urls.every(url => url.startsWith('https://api.plaud.ai/device-app/'))).toBe(true);
    const stored = await readFile(path, 'utf8');
    expect(JSON.parse(stored).privateKey).toBe(createPrivateKey(pair.privateKey).export({ type: 'pkcs1', format: 'der' }).toString('base64'));
    expect(stored).not.toContain(token);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o077).toBe(0);
  });

  test('failed authorization leaves an existing identity byte-for-byte unchanged', async () => {
    const path = await identityPath();
    await writeStoredIdentity({ serial, identifier, bindingToken: 'existing', signature: 'existing', publicKey: 'existing', privateKey: 'existing' });
    const before = await readFile(path, 'utf8');
    globalThis.fetch = (async () => new Response('private-server-error', { status: 403 })) as unknown as typeof fetch;
    const response = await request();
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('private-server-error');
    expect(await readFile(path, 'utf8')).toBe(before);
  });
});
