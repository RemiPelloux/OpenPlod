import type { VaultClient } from './server';

export class OpenPlodClient implements VaultClient {
  private readonly origin: string;
  constructor(origin: string, private readonly token: string,
    private readonly fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch) {
    const url = new URL(origin);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((!loopback && url.protocol !== 'https:') || !['http:', 'https:'].includes(url.protocol)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use a loopback HTTP or trusted HTTPS vault origin without URL credentials.');
    if (!token.trim()) throw new Error('OpenPlod MCP requires a private API or pairing token.');
    this.origin = url.origin;
  }

  async request(path: string, method = 'GET', body?: unknown) {
    const target = new URL(path, this.origin);
    if (!path.startsWith('/api/') || target.origin !== this.origin || target.hash
      || !/^\/api\/(v1\/(documents|folders|transcripts)(\/|$)|transcripts(\/|$))/.test(target.pathname)) throw new Error('Unsupported vault API path.');
    let response: Response;
    try {
      response = await this.fetcher(target.href, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { 'X-OpenPlod-Token': this.token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new Error('OpenPlod could not be reached. Keep the desktop app open and verify the private connection.'); }
    const payload = await response.json().catch(() => null) as { success?: boolean; data?: unknown; code?: string } | null;
    if (!response.ok || !payload?.success) {
      if (response.status === 409) throw new Error('Conflict: reload the current revision before retrying. Your changes were not applied.');
      if (response.status === 401) throw new Error('OpenPlod authorization failed. Check your private token.');
      throw new Error(`Vault request failed (HTTP ${response.status}).`);
    }
    return payload.data;
  }
}
