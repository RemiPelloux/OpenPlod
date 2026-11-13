import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const previousPairingToken = process.env.OPENPLOD_PAIRING_TOKEN;
const previousApiToken = process.env.OPENPLOD_API_TOKEN;
const PAIRING = 'mobile-test-global-token';
const API = 'mobile-test-api-token';

const { sqlite } = await import('../db/client');
const { initializeDatabase } = await import('../db/setup');
const { default: mobileApi } = await import('./mobile');
const { incomingDirectory, softDeleteRecording, restoreRecording, purgeRecording } = await import('../library/recording-library');
const { MobileUploads, UPLOAD_EXPIRY_MS } = await import('../sync/mobile-uploads');

beforeAll(() => {
  process.env.OPENPLOD_PAIRING_TOKEN = PAIRING;
  process.env.OPENPLOD_API_TOKEN = API;
  initializeDatabase();
});
afterAll(() => {
  restoreEnv('OPENPLOD_PAIRING_TOKEN', previousPairingToken);
  restoreEnv('OPENPLOD_API_TOKEN', previousApiToken);
});

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
type Json = { success: boolean; code?: string; error?: string; data: any };
async function call(path: string, token: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  headers.set('X-OpenPlod-Token', token);
  let body = init.body;
  if (init.json !== undefined) { headers.set('Content-Type', 'application/json'); body = JSON.stringify(init.json); }
  const response = await mobileApi.request(path, { ...init, headers, body });
  return { status: response.status, headers: response.headers, json: await response.json().catch(() => null) as Json };
}
async function newClient(name = 'Pixel', permissions?: string[]) {
  const created = await call('/clients', API, { method: 'POST', json: { name, platform: 'android', ...(permissions ? { permissions } : {}) } });
  expect(created.status).toBe(201);
  return created.json.data as { client: { id: string }; token: string };
}
function chunk(token: string, id: string, bytes: Uint8Array, start: number, total: number, checksum = sha(bytes)) {
  return call(`/uploads/${id}`, token, {
    method: 'PUT', body: bytes as Uint8Array<ArrayBuffer>,
    headers: { 'Content-Range': `bytes ${start}-${start + bytes.length - 1}/${total}`, 'X-Chunk-SHA256': checksum },
  });
}
function audio(label: string, size = 20_000) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + label.charCodeAt(i % label.length)) & 0xff;
  return bytes;
}

describe('paired clients (MOB-06)', () => {
  test('each pairing gets its own credential; only the hash is stored', async () => {
    const { client, token } = await newClient('Work phone');
    expect(token.length).toBeGreaterThan(30);
    const row = sqlite.query('SELECT token_hash FROM mobile_clients WHERE id = ?').get(client.id) as { token_hash: string };
    expect(row.token_hash).toBe(sha(token));
    expect(JSON.stringify(sqlite.query('SELECT * FROM mobile_clients').all())).not.toContain(token);
    const me = await call('/clients/me', token);
    expect(me.json.data).toMatchObject({ kind: 'client', id: client.id, name: 'Work phone' });
    expect(me.json.data.lastSeenAt).toBeString();
    expect(me.json.data.pairingExpiresAt).toBeNull();
  });

  test('clients cannot manage other clients; the desktop can rename, revoke and rotate', async () => {
    const a = await newClient('A');
    const b = await newClient('B');
    expect((await call('/clients', a.token)).status).toBe(403);
    expect((await call(`/clients/${b.client.id}/revoke`, a.token, { method: 'POST' })).status).toBe(403);
    const renamed = await call(`/clients/${a.client.id}`, API, { method: 'PATCH', json: { name: 'Renamed' } });
    expect(renamed.json.data.name).toBe('Renamed');
    const rotated = await call(`/clients/${a.client.id}/rotate`, API, { method: 'POST' });
    expect((await call('/health', a.token)).status).toBe(401);
    expect((await call('/health', rotated.json.data.token)).status).toBe(200);
    await call(`/clients/${b.client.id}/revoke`, API, { method: 'POST' });
    expect((await call('/health', b.token)).status).toBe(401);
    const list = (await call('/clients', API)).json.data as { id: string; revokedAt: string | null; legacy: boolean }[];
    expect(list.find(c => c.id === b.client.id)?.revokedAt).toBeString();
    expect(list.some(c => c.legacy)).toBe(true);
    expect(JSON.stringify(list)).not.toContain('token_hash');
  });

  test('the global token works as a revocable legacy client; rotating it issues a per-client token', async () => {
    expect((await call('/health', PAIRING)).status).toBe(200);
    expect((await call('/clients/me', PAIRING)).json.data).toMatchObject({ id: 'legacy', legacy: true });
    const rotated = await call('/clients/legacy/rotate', API, { method: 'POST' });
    expect(rotated.json.data.client.legacy).toBe(false);
    expect((await call('/health', PAIRING)).status).toBe(401);
    expect((await call('/health', rotated.json.data.token)).status).toBe(200);
    // Restore the legacy client for other tests by issuing a different desktop token.
    sqlite.query("UPDATE mobile_clients SET revoked_at = NULL WHERE id = 'legacy'").run();
  });

  test('the global token from loopback is the desktop itself and survives legacy revocation', async () => {
    const loopback = { requestIP: () => ({ address: '127.0.0.1', family: 'IPv4', port: 1 }) };
    const lan = { requestIP: () => ({ address: '192.168.1.40', family: 'IPv4', port: 1 }) };
    const headers = { 'X-OpenPlod-Token': PAIRING };
    expect((await mobileApi.request('/clients', { headers }, loopback)).status).toBe(200);
    expect((await mobileApi.request('/clients', { headers }, lan)).status).toBe(403);
    await call('/clients/legacy/revoke', API, { method: 'POST' });
    expect((await mobileApi.request('/health', { headers }, lan)).status).toBe(401);
    expect((await mobileApi.request('/clients', { headers }, loopback)).status).toBe(200);
    sqlite.query("UPDATE mobile_clients SET revoked_at = NULL WHERE id = 'legacy'").run();
  });

  test('per-client permissions are enforced', async () => {
    const readOnly = await newClient('Reader', ['read', 'sync']);
    expect((await call('/uploads', readOnly.token, { method: 'POST', json: {} })).status).toBe(403);
    expect((await call('/changes', readOnly.token)).status).toBe(200);
    expect((await call('/changes', readOnly.token, { method: 'POST', json: { changes: [] } })).status).toBe(403);
  });

  test('unused pairing codes expire', async () => {
    const { token, client } = await newClient('Never used');
    sqlite.query('UPDATE mobile_clients SET pairing_expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), client.id);
    expect((await call('/health', token)).status).toBe(401);
  });
});

describe('resumable uploads (MOB-02, MOB-05)', () => {
  test('uploads in chunks, resumes from the committed offset, and acknowledges durably', async () => {
    const { token } = await newClient('Uploader');
    const bytes = audio('resume');
    const fingerprint = sha(bytes);
    const created = await call('/uploads', token, { method: 'POST', json: { fingerprint, size: bytes.length, filename: 'note.ogg', metadata: { context: 'Chunked', durationMs: 4000 } } });
    expect(created.status).toBe(201);
    const id = created.json.data.transferId as string;
    expect(created.json.data.offset).toBe(0);

    expect((await chunk(token, id, bytes.slice(0, 8000), 0, bytes.length)).json.data.offset).toBe(8000);
    // A corrupted chunk is rejected and nothing is committed.
    const corrupt = await chunk(token, id, bytes.slice(8000, 12000), 8000, bytes.length, sha('other'));
    expect(corrupt.status).toBe(422);
    expect(corrupt.json.data.offset).toBe(8000);
    // A chunk at the wrong offset reports where to resume.
    const gap = await chunk(token, id, bytes.slice(12000, 16000), 12000, bytes.length);
    expect(gap.status).toBe(409);
    expect(gap.headers.get('Upload-Offset')).toBe('8000');
    // Restarting the client (new POST with the same fingerprint) resumes the same transfer.
    const again = await call('/uploads', token, { method: 'POST', json: { fingerprint, size: bytes.length, filename: 'note.ogg' } });
    expect(again.json.data).toMatchObject({ transferId: id, offset: 8000 });
    expect((await call(`/uploads/${id}`, token)).json.data.offset).toBe(8000);
    const head = await mobileApi.request(`/uploads/${id}`, { method: 'HEAD', headers: { 'X-OpenPlod-Token': token } });
    expect(head.headers.get('Upload-Offset')).toBe('8000');
    // Re-sending an already committed chunk is harmless.
    expect((await chunk(token, id, bytes.slice(0, 8000), 0, bytes.length)).json.data.offset).toBe(8000);
    expect((await call(`/uploads/${id}/complete`, token, { method: 'POST' })).status).toBe(409);
    await chunk(token, id, bytes.slice(8000), 8000, bytes.length);

    const ack = await call(`/uploads/${id}/complete`, token, { method: 'POST' });
    expect(ack.status).toBe(201);
    expect(ack.json.data).toMatchObject({ transferId: id, fingerprint, added: true });
    const stored = sqlite.query('SELECT file_path, context, source_transport FROM recordings WHERE id = ?').get(ack.json.data.recordingId) as { file_path: string; context: string; source_transport: string };
    expect(stored).toMatchObject({ context: 'Chunked', source_transport: 'mobile' });
    expect(sha(new Uint8Array(await Bun.file(stored.file_path).arrayBuffer()))).toBe(fingerprint);
    // Completion is idempotent and the staging file is gone.
    const repeat = await call(`/uploads/${id}/complete`, token, { method: 'POST' });
    expect(repeat.json.data.recordingId).toBe(ack.json.data.recordingId);
    expect(existsSync(join(incomingDirectory(), 'uploads', `${id}.ogg`))).toBe(false);
    const client = (await call('/clients/me', token)).json.data;
    expect(client.lastSuccessfulSyncAt).toBeString();
  });

  test('transfers are scoped to their client: another client cannot see or cancel them', async () => {
    const a = await newClient('A');
    const b = await newClient('B');
    const bytes = audio('scoped');
    const fingerprint = sha(bytes);
    const transferA = (await call('/uploads', a.token, { method: 'POST', json: { fingerprint, size: bytes.length, filename: 'a.ogg' } })).json.data.transferId;
    const transferB = (await call('/uploads', b.token, { method: 'POST', json: { fingerprint, size: bytes.length, filename: 'b.ogg' } })).json.data.transferId;
    expect(transferA).not.toBe(transferB);
    await chunk(a.token, transferA, bytes.slice(0, 1000), 0, bytes.length);
    await chunk(b.token, transferB, bytes.slice(0, 2000), 0, bytes.length);
    expect((await call(`/uploads/${transferA}`, b.token)).status).toBe(404);
    expect((await call(`/uploads/${transferA}`, b.token, { method: 'DELETE' })).status).toBe(404);
    expect((await call(`/uploads/${transferB}`, b.token, { method: 'DELETE' })).json.data).toEqual({ cancelled: true });
    expect((await call(`/uploads/${transferA}`, a.token)).json.data.offset).toBe(1000);
  });

  test('rejects mismatched audio at completion and restarts the transfer', async () => {
    const { token } = await newClient('Mismatch');
    const bytes = audio('mismatch', 3000);
    const id = (await call('/uploads', token, { method: 'POST', json: { fingerprint: sha('something else'), size: bytes.length, filename: 'x.ogg' } })).json.data.transferId;
    await chunk(token, id, bytes, 0, bytes.length);
    const result = await call(`/uploads/${id}/complete`, token, { method: 'POST' });
    expect(result.status).toBe(422);
    expect(result.json.code).toBe('fingerprint_mismatch');
    expect((await call(`/uploads/${id}`, token)).json.data.offset).toBe(0);
  });

  test('validates chunk sizes, formats, and ranges', async () => {
    const { token } = await newClient('Validator');
    expect((await call('/uploads', token, { method: 'POST', json: { fingerprint: 'nope', size: 10, filename: 'a.ogg' } })).status).toBe(400);
    expect((await call('/uploads', token, { method: 'POST', json: { fingerprint: sha('x'), size: 10, filename: 'a.exe' } })).status).toBe(400);
    const id = (await call('/uploads', token, { method: 'POST', json: { fingerprint: sha('y'), size: 10, filename: 'a.ogg' } })).json.data.transferId;
    expect((await call(`/uploads/${id}`, token, { method: 'PUT', body: new Uint8Array(5) })).status).toBe(400);
    expect((await chunk(token, id, new Uint8Array(5), 0, 99)).status).toBe(416);
  });

  test('abandoned transfers expire and their staged bytes are deleted', async () => {
    let now = new Date('2026-10-01T00:00:00Z');
    const store = new MobileUploads(sqlite, { now: () => now });
    const bytes = audio('expire', 100);
    const state = await store.create('desktop', { fingerprint: sha(bytes), size: bytes.length, filename: 'old.ogg' });
    await store.append('desktop', state.transferId, { contentRange: 'bytes 0-49/100', chunkSha256: sha(bytes.slice(0, 50)), body: bytes.slice(0, 50) });
    const staged = join(incomingDirectory(), 'uploads', `${state.transferId}.ogg`);
    expect(existsSync(staged)).toBe(true);
    now = new Date(now.getTime() + UPLOAD_EXPIRY_MS + 1000);
    expect(await store.cleanup()).toBeGreaterThanOrEqual(1);
    expect(existsSync(staged)).toBe(false);
    expect(readdirSync(join(incomingDirectory(), 'uploads'))).not.toContain(`${state.transferId}.ogg`);
    await expect(store.status('desktop', state.transferId)).rejects.toThrow('Transfer not found.');
  });

  test('the single-request upload endpoint still works for older clients', async () => {
    const body = new FormData();
    body.append('file', new File([audio('legacy-upload', 500)], 'old-client.webm', { type: 'audio/webm' }));
    const response = await mobileApi.request('/recordings', { method: 'POST', headers: { 'X-OpenPlod-Token': PAIRING }, body });
    expect(response.status).toBe(201);
  });
});

describe('change feed and metadata push (MOB-04)', () => {
  async function storeRecording(token: string, label: string) {
    const bytes = audio(label, 600);
    const id = (await call('/uploads', token, { method: 'POST', json: { fingerprint: sha(bytes), size: bytes.length, filename: `${label}.ogg` } })).json.data.transferId;
    await chunk(token, id, bytes, 0, bytes.length);
    return (await call(`/uploads/${id}/complete`, token, { method: 'POST' })).json.data.recordingId as string;
  }

  test('reports current state, transcript heads, and trash/restore/purge tombstones after a cursor', async () => {
    const { token } = await newClient('Syncer');
    const start = (await call('/changes', token)).json.data;
    let cursor = start.cursor as string;
    for (let page = start; page.hasMore; ) { page = (await call(`/changes?since=${cursor}`, token)).json.data; cursor = page.cursor; }

    const recordingId = await storeRecording(token, 'feed');
    const first = (await call(`/changes?since=${cursor}`, token)).json.data;
    expect(first.changes.map((c: { id: string }) => c.id)).toContain(recordingId);
    expect(first.changes.find((c: { id: string }) => c.id === recordingId)).toMatchObject({ type: 'recording', revision: 1, retentionState: 'active', title: 'feed', transcriptHead: null });
    cursor = first.cursor;
    expect((await call(`/changes?since=${cursor}`, token)).json.data.changes).toEqual([]);

    await softDeleteRecording(recordingId);
    await restoreRecording(recordingId);
    await softDeleteRecording(recordingId);
    await purgeRecording(recordingId);
    const after = (await call(`/changes?since=${cursor}`, token)).json.data;
    expect(after.changes).toEqual([expect.objectContaining({ type: 'purged', id: recordingId })]);
    expect(after.tombstones.map((t: { event: string }) => t.event)).toEqual(['trash', 'restore', 'trash', 'purge']);
    expect(after.tombstones[3]).toMatchObject({ recordingId, at: expect.any(String) });
    expect((await call('/changes?since=999999999', token)).status).toBe(410);
  });

  test('a feed page costs a fixed number of queries however many recordings it lists', async () => {
    const { ChangeFeed } = await import('../sync/change-feed');
    const { countQueries } = await import('../testing/count-queries');
    const feed = new ChangeFeed(sqlite);
    const { token } = await newClient('Counter');
    const head = String(feed.head());
    const ids = [await storeRecording(token, 'count-0')];
    const small = await countQueries(sqlite, () => feed.changes(head, 500));
    for (let i = 1; i < 12; i++) ids.push(await storeRecording(token, `count-${i}`));
    await softDeleteRecording(ids[0]); await purgeRecording(ids[0]);
    const large = await countQueries(sqlite, () => feed.changes(head, 500));
    expect(large.result.changes.filter(change => ids.includes(change.id))).toHaveLength(12);
    expect(large.result.changes.find(change => change.id === ids[0])).toMatchObject({ type: 'purged', revision: expect.any(Number) });
    expect(large.count).toBeLessThanOrEqual(small.count + 1); // + the purge lookup, once per page
  });

  test('applies queued edits on the current revision and returns conflicts without overwriting', async () => {
    const { token } = await newClient('Editor');
    const recordingId = await storeRecording(token, 'edits');
    const applied = await call('/changes', token, { method: 'POST', json: { changes: [
      { changeId: 'c1', recordingId, baseRevision: 1, fields: { title: 'Board meeting', tags: ['work'], notes: 'From phone' } },
    ] } });
    expect(applied.json.data.results[0]).toEqual({ changeId: 'c1', recordingId, status: 'applied', revision: 2 });
    // A retry of the same change returns the original result rather than a false conflict.
    const retried = await call('/changes', token, { method: 'POST', json: { changes: [
      { changeId: 'c1', recordingId, baseRevision: 1, fields: { title: 'Board meeting', tags: ['work'], notes: 'From phone' } },
    ] } });
    expect(retried.json.data.results[0].status).toBe('applied');
    // A desktop-side manual edit bumps the revision; a stale phone edit must not overwrite it.
    sqlite.query("UPDATE recordings SET notes = 'Desk edit', revision = revision + 1 WHERE id = ?").run(recordingId);
    const stale = await call('/changes', token, { method: 'POST', json: { changes: [
      { changeId: 'c2', recordingId, baseRevision: 2, fields: { notes: 'Phone overwrite' } },
      { changeId: 'c3', recordingId, baseRevision: 3, fields: { fingerprint: 'x' } },
      { changeId: 'c4', recordingId: crypto.randomUUID(), baseRevision: 1, fields: {} },
    ] } });
    const [conflict, invalid, missing] = stale.json.data.results;
    expect(conflict).toMatchObject({ status: 'conflict', current: { revision: 3, notes: 'Desk edit', title: 'Board meeting', tags: ['work'] } });
    expect(invalid.status).toBe('invalid');
    expect(missing.status).toBe('not_found');
    expect((sqlite.query('SELECT notes FROM recordings WHERE id = ?').get(recordingId) as { notes: string }).notes).toBe('Desk edit');
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
