import { describe, expect, test } from 'bun:test';
import { PlaudDeviceAuth } from './plaud-device-auth';

const credentials = { clientId: 'test-client', clientSecret: 'private-test-secret', userId: 'owner', domain: 'platform-us.plaud.ai' };

describe('Plaud SDK authentication', () => {
  test('coalesces concurrent token exchanges and caches the scoped user session', async () => {
    const requests: RequestInit[] = [];
    const auth = new PlaudDeviceAuth((async (_url, init) => {
      requests.push(init!);
      return Response.json({ access_token: requests.length === 1 ? 'partner-token' : 'user-token', expires_in: 3600 });
    }));
    const [first, second] = await Promise.all([auth.session(credentials), auth.session(credentials)]);
    expect(first).toEqual(second);
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[1].body as string)).toEqual({ user_id: 'owner', expires_in: 86400 });
    expect(await auth.session(credentials)).toEqual(first);
    expect(JSON.stringify(first)).not.toContain(credentials.clientSecret);
  });

  test('does not expose upstream error bodies or send credentials to arbitrary hosts', async () => {
    const auth = new PlaudDeviceAuth(async () => new Response('private-test-secret', { status: 401 }));
    await expect(auth.session(credentials)).rejects.toThrow('HTTP 401');
    await expect(auth.session({ ...credentials, domain: 'attacker.example' })).rejects.toThrow('Unsupported');
    await expect(auth.session({ ...credentials, clientSecret: '' })).rejects.toThrow('missing');
  });

  test('rotating credentials or owners invalidates cached sessions', async () => {
    let calls = 0;
    const auth = new PlaudDeviceAuth(async () => Response.json({ access_token: `token-${++calls}` }));
    const first = await auth.session(credentials);
    const rotated = await auth.session({ ...credentials, clientSecret: 'rotated' });
    const nextOwner = await auth.session({ ...credentials, userId: 'another-owner' });
    expect(new Set([first.userAccessToken, rotated.userAccessToken, nextOwner.userAccessToken]).size).toBe(3);
    expect(calls).toBe(6);
  });

  test('a failed exchange can be retried without caching the failure', async () => {
    let calls = 0;
    const auth = new PlaudDeviceAuth(async () => ++calls === 1
      ? new Response('', { status: 503 }) : Response.json({ access_token: 'retry-token' }));
    await expect(auth.session(credentials)).rejects.toThrow('HTTP 503');
    expect((await auth.session(credentials)).userAccessToken).toBe('retry-token');
    expect(calls).toBe(3);
  });
});
