import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

type Credentials = { clientId: string; clientSecret: string; userId: string; domain: string };
type Session = { userAccessToken: string; expiresAt: number; domain: string };
const ALLOWED_DOMAINS = new Set(['platform-us.plaud.ai', 'platform-jp.plaud.ai', 'platform.plaud.ai']);

export class PlaudDeviceAuth {
  private cached: Session | null = null;
  private pending: Promise<Session> | null = null;
  private credentialKey = '';

  constructor(private readonly fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch) {}

  async session(credentials: Credentials): Promise<Session> {
    if (!ALLOWED_DOMAINS.has(credentials.domain)) throw new Error('Unsupported Plaud developer region.');
    if (!credentials.clientId || !credentials.clientSecret) throw new Error('Plaud developer credentials are missing.');
    const key = createHash('sha256').update(JSON.stringify(credentials)).digest('hex');
    if (key !== this.credentialKey) {
      this.credentialKey = key;
      this.cached = null;
      this.pending = null;
    }
    if (this.cached && this.cached.expiresAt > Date.now() + 60_000) return this.cached;
    if (!this.pending) this.pending = this.create(credentials).then(session => {
      if (this.credentialKey === key) this.cached = session;
      return session;
    }).finally(() => { if (this.credentialKey === key) this.pending = null; });
    return this.pending;
  }

  private async create(credentials: Credentials): Promise<Session> {
    const base = `https://${credentials.domain}/developer/api`;
    const partner = await this.request(`${base}/oauth/partner/access-token`, {
      Authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    }, '');
    const user = await this.request(`${base}/open/partner/users/access-token`, {
      Authorization: `Bearer ${partner.access_token}`, 'Content-Type': 'application/json',
    }, JSON.stringify({ user_id: credentials.userId, expires_in: 86400 }));
    const expiresIn = Number(user.expires_in ?? 86400);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('Plaud returned an invalid token expiry.');
    return { userAccessToken: user.access_token, expiresAt: Date.now() + Math.min(expiresIn, 86400) * 1000, domain: credentials.domain };
  }

  private async request(url: string, headers: Record<string, string>, body: string) {
    let response: Response;
    try {
      response = await this.fetcher(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new Error('Plaud developer authentication could not be reached.');
    }
    if (!response.ok) throw new Error(`Plaud developer authentication failed (HTTP ${response.status}).`);
    const payload = await response.json() as { access_token?: string; expires_in?: number; data?: { access_token?: string; expires_in?: number } };
    const result = payload.data ?? payload;
    if (typeof result.access_token !== 'string' || !result.access_token) throw new Error('Plaud returned no SDK user token.');
    return { access_token: result.access_token, expires_in: result.expires_in };
  }
}

export async function readDeviceCredentials(): Promise<Credentials> {
  const library = process.env.OPENPLOD_LIBRARY_PATH || './data/recordings';
  const path = resolve(dirname(library), 'plaud-developer.json');
  const saved = await readFile(path, 'utf8').then(JSON.parse).catch(() => ({}));
  return {
    clientId: process.env.PLAUD_CLIENT_ID || saved.clientId || '',
    clientSecret: process.env.PLAUD_CLIENT_SECRET || saved.clientSecret || '',
    userId: process.env.PLAUD_USER_ID || saved.userId || 'openplod-owner',
    domain: process.env.PLAUD_DEVELOPER_DOMAIN || saved.domain || 'platform-us.plaud.ai',
  };
}
