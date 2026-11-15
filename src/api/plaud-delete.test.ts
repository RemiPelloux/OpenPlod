import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import app from './plaud';
import type { Principal } from './access';

// Route-level authorization only. Invalid inputs deliberately stop before any
// identity lookup or Bluetooth connection; bunfig preloads a temporary vault.
for (const kind of ['desktop', 'api', 'open', 'client'] as const) {
  for (const address of ['127.0.0.1', '192.168.1.50']) {
    test(`device deletion requires desktop principal and loopback: ${kind} ${address}`, async () => {
      const wrapper = new Hono();
      wrapper.use('*', async (c, next) => {
        c.set('principal', { kind } as Principal); return next();
      });
      wrapper.route('/', app);
      const environment = { requestIP: () => ({ address, family: 'IPv4', port: 1 }) };
      for (const path of ['/device-delete/prepare', '/device-delete/confirm']) {
        const response = await wrapper.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, environment);
        expect(response.status).toBe(kind === 'desktop' && address === '127.0.0.1' ? 409 : 403);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
      }
    });
  }
}
