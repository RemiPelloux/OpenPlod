import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { initializeOrganizer, OrganizerStore } from './store';
import { NoteDeliveryService } from './delivery';
import { createOrganizerApi } from '../api/organizer';
import { apiAccess } from '../api/access';

let database: Database, store: OrganizerStore;
beforeEach(() => { database = new Database(':memory:'); database.exec('PRAGMA foreign_keys=ON'); initializeOrganizer(database); store = new OrganizerStore(database); });
afterEach(() => database.close());
const note = (input = {}) => store.create({ title: 'Meeting notes', content: '# Decisions\n\nKeep the audio.', idempotencyKey: crypto.randomUUID(), ...input });
const folder = (name = 'Projects', parentId: string | null = null) => store.createFolder({ name, parentId });
const apiRequest = (path: string, body?: unknown, method = 'POST') => createOrganizerApi(store).request(path, {
  method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe('Markdown organizer', () => {
  test('initialization is additive and preserves notes across migrations', () => {
    const saved = note(); initializeOrganizer(database); expect(store.get(saved.id).content).toBe(saved.content);
  });
  test('creates nested folders and rejects cycles, duplicates and missing parents', () => {
    const parent = folder(), child = folder('Meetings', parent.id);
    expect(store.folders()).toHaveLength(2);
    expect(() => folder('projects')).toThrow('already exists');
    expect(() => folder('Invalid', crypto.randomUUID())).toThrow('not found');
    expect(() => store.updateFolder(parent.id, { revision: 1, parentId: child.id })).toThrow('itself');
    expect(store.folders().find(row => row.id === parent.id)?.parentId).toBeNull();
  });
  test('folder renames and moves enforce revision conflicts', () => {
    const parent = folder(), child = folder('Inbox');
    expect(store.updateFolder(child.id, { revision: 1, parentId: parent.id, name: 'Archive' })).toMatchObject({ revision: 2, parentId: parent.id });
    expect(() => store.updateFolder(child.id, { revision: 1, name: 'Stale' })).toThrow('changed elsewhere');
  });
  test('only empty folders can be deleted, including hidden Trash contents', () => {
    const target = folder(), document = note({ folderId: target.id });
    expect(() => store.deleteFolder(target.id, 1)).toThrow('including Trash');
    store.trash(document.id, 1);
    expect(() => store.deleteFolder(target.id, 1)).toThrow('including Trash');
    store.purge(document.id, 2); store.deleteFolder(target.id, 1); expect(store.folders()).toHaveLength(0);
  });
  test('note create is idempotent and rejects changed requests using the same key', () => {
    const key = crypto.randomUUID(), first = note({ idempotencyKey: key });
    expect(note({ idempotencyKey: key }).id).toBe(first.id);
    expect(() => note({ idempotencyKey: key, content: 'different' })).toThrow('different content');
    expect(store.list().total).toBe(1);
  });
  test('validates titles, unknown properties, Unicode byte limits and missing folders', () => {
    expect(() => note({ title: '../secrets' })).toThrow();
    expect(() => note({ title: '' })).toThrow();
    expect(() => note({ content: '\0' })).toThrow();
    expect(() => note({ content: '\u20ac'.repeat(180000) })).toThrow('512 KB');
    expect(() => note({ secret: 'unexpected' })).toThrow();
    expect(() => note({ folderId: crypto.randomUUID() })).toThrow('not found');
  });
  test('edits, moves, stars and versions without stale overwrite', () => {
    const target = folder(), original = note();
    const edited = store.update(original.id, { revision: 1, title: 'Decisions', content: 'User edited', folderId: target.id, starred: true });
    expect(edited).toMatchObject({ revision: 2, starred: true, folderId: target.id });
    expect(() => store.update(original.id, { revision: 1, content: 'stale' })).toThrow('changed elsewhere');
    expect(store.get(original.id).content).toBe('User edited');
    expect(store.versions(original.id)).toHaveLength(2);
    const oldVersion = store.version(original.id, store.versions(original.id)[1].id);
    expect(oldVersion.content).toBe(original.content);
    expect(store.update(original.id, { revision: 2, content: oldVersion.content }).revision).toBe(3);
    expect(store.folders()[0].documentCount).toBe(1);
  });
  test('FTS search is indexed, paginated, literal-token safe, and excludes Trash', () => {
    const target = folder();
    const one = note({ title: 'Alpha', content: 'Caf\u00e9 roadmap', folderId: target.id });
    note({ title: 'Beta', content: 'Caf\u00e9 roadmap' }); note({ title: 'Gamma', content: 'Other' });
    expect(store.list({ q: 'cafe road', limit: 1 }).total).toBe(2);
    expect(store.list({ q: 'cafe', sort: 'title', limit: 1, offset: 1 }).documents[0].title).toBe('Beta');
    expect(store.list({ q: '" OR *' }).total).toBe(0);
    expect(store.list({ folderId: target.id }).total).toBe(1);
    expect(store.list({ folderId: 'inbox' }).total).toBe(2);
    store.trash(one.id, 1);
    expect(store.list({ q: 'cafe' }).total).toBe(1);
    expect(store.list({ view: 'trash' }).total).toBe(1);
  });
  test('Trash restores within 30 days and purge removes versions and search content', () => {
    const original = note();
    expect(() => store.purge(original.id, 1)).toThrow('Trash');
    const trashed = store.trash(original.id, 1);
    expect(() => store.update(original.id, { revision: 2, content: 'no' })).toThrow('Restore');
    expect(store.restore(original.id, trashed.revision).revision).toBe(3);
    store.trash(original.id, 3);
    database.query('UPDATE note_documents SET deleted_at=? WHERE id=?').run('2000-01-01T00:00:00Z', original.id);
    expect(() => store.restore(original.id, 4)).toThrow('expired');
    expect(store.purgeExpired()).toBe(1);
    expect(store.list().total).toBe(0);
    expect(database.query('SELECT count(*) AS n FROM note_versions').get()).toEqual({ n: 0 });
    expect(database.query('SELECT count(*) AS n FROM note_fts').get()).toEqual({ n: 0 });
  });
  test('API uses stable errors, bounded query inputs, confirmations and private exports', async () => {
    expect((await apiRequest('/documents', { title: 'missing key' })).status).toBe(400);
    expect((await apiRequest('/documents?limit=0', undefined, 'GET')).status).toBe(400);
    const created = note({ title: 'Note "one"', content: '# Exact\n\n**Markdown**\n' });
    const stale = await apiRequest(`/documents/${created.id}`, { revision: 7, content: 'overwrite' }, 'PATCH');
    expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: 'revision_conflict' });
    const exported = await apiRequest(`/documents/${created.id}/export`, undefined, 'GET');
    expect(exported.headers.get('cache-control')).toBe('no-store');
    expect(exported.headers.get('content-disposition')).toContain('filename*=UTF-8');
    expect(await exported.text()).toBe(created.content);
    store.trash(created.id, 1);
    expect((await apiRequest(`/documents/${created.id}/purge`, { revision: 2 })).status).toBe(400);
    expect((await apiRequest(`/documents/${created.id}/purge`, { revision: 2, confirm: true })).status).toBe(200);
  });
  test('global API middleware rejects absent and invalid tokens', async () => {
    const previous = process.env.OPENPLOD_API_TOKEN;
    process.env.OPENPLOD_API_TOKEN = 'organizer-test-private-token';
    try {
      const app = new Hono(); app.use('*', apiAccess); app.route('/', createOrganizerApi(store));
      expect((await app.request('/documents')).status).toBe(401);
      expect((await app.request('/documents', { headers: { 'X-OpenPlod-Token': 'wrong' } })).status).toBe(401);
      expect((await app.request('/documents', { headers: { 'X-OpenPlod-Token': 'organizer-test-private-token' } })).status).toBe(200);
    } finally { if (previous === undefined) delete process.env.OPENPLOD_API_TOKEN; else process.env.OPENPLOD_API_TOKEN = previous; }
  });
  test('saves transcript snapshots with provenance, idempotency and source independence', () => {
    database.exec(`CREATE TABLE recordings (id TEXT, original_filename TEXT, recorded_at TEXT, source_provider TEXT, retention_state TEXT);
      CREATE TABLE transcripts (recording_id TEXT, current_version_id TEXT, full_text TEXT, origin TEXT);
      CREATE TABLE transcript_versions (id TEXT, recording_id TEXT, full_text TEXT, origin TEXT);`);
    const recordingId = crypto.randomUUID(), versionId = crypto.randomUUID();
    database.query('INSERT INTO recordings VALUES(?,?,?,?,?)').run(recordingId, 'meeting.m4a', '2026-09-05', 'plaud', 'active');
    database.query('INSERT INTO transcripts VALUES(?,?,?,?)').run(recordingId, versionId, 'Current edited text', 'edited');
    database.query('INSERT INTO transcript_versions VALUES(?,?,?,?)').run(versionId, recordingId, 'Saved edited text', 'edited');
    const saved = store.snapshot({ recordingId, versionId });
    expect(store.transcript(recordingId).transcript.fullText).toBe('Current edited text');
    expect(store.transcript(recordingId, versionId).transcript.fullText).toBe('Saved edited text');
    expect(saved).toMatchObject({ sourceRecordingId: recordingId, sourceVersionId: versionId, sourceOrigin: 'edited' });
    expect(saved.content).toContain('Saved edited text');
    expect(store.snapshot({ recordingId, versionId }).id).toBe(saved.id);
    store.update(saved.id, { revision: 1, content: 'Independent note edits' });
    expect(database.query('SELECT full_text FROM transcripts').get()).toEqual({ full_text: 'Current edited text' });
    store.trash(saved.id, 2);
    expect(store.snapshot({ recordingId, versionId }).deletedAt).not.toBeNull();
    expect(() => store.snapshot({ recordingId, versionId: crypto.randomUUID() })).toThrow('not found');
    database.query("UPDATE recordings SET retention_state='trash'").run();
    expect(() => store.snapshot({ recordingId })).toThrow('not found');
  });
});

describe('confirmed destination deliveries', () => {
  const destinations = async () => [{ id: 'test', name: 'Test receiver', url: 'https://receiver.example/ingest', bearerToken: 'private-test-secret' }];
  test('redacts destination secrets and sends exact saved content once', async () => {
    const document = note(); let calls = 0;
    const service = new NoteDeliveryService(store, destinations, async (url, init) => {
      calls++; expect(url).toBe('https://receiver.example/ingest'); expect(init.redirect).toBe('error');
      expect(JSON.parse(String(init.body))).toMatchObject({ schemaVersion: '1', document: { content: document.content, revision: 1 } });
      return new Response('accepted', { status: 202 });
    });
    expect(await service.list()).toEqual([{ id: 'test', name: 'Test receiver', host: 'receiver.example' }]);
    const input = { destinationId: 'test', revision: 1, confirm: true, idempotencyKey: crypto.randomUUID() };
    const result = await service.send(document.id, input); expect(result.state).toBe('sent');
    expect(await service.send(document.id, input)).toEqual(result); expect(calls).toBe(1);
    await expect(service.send(document.id, { ...input, revision: 2 })).rejects.toThrow('different request');
    expect(JSON.stringify(service.history(document.id))).not.toContain('secret');
  });
  test('uncertain sends are recorded and never automatically resent', async () => {
    const document = note(); let calls = 0;
    const service = new NoteDeliveryService(store, destinations, async () => { calls++; throw new Error('credential must not leak'); });
    const input = { destinationId: 'test', revision: 1, confirm: true, idempotencyKey: crypto.randomUUID() };
    expect((await service.send(document.id, input)).state).toBe('unknown');
    expect((await service.send(document.id, input)).state).toBe('unknown');
    expect(calls).toBe(1); expect(JSON.stringify(service.history(document.id))).not.toContain('credential');
  });
  test('concurrent duplicate requests have a single outbound POST', async () => {
    const document = note(); let calls = 0;
    const service = new NoteDeliveryService(store, destinations, async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return new Response(); });
    const input = { destinationId: 'test', revision: 1, confirm: true, idempotencyKey: crypto.randomUUID() };
    await Promise.all([service.send(document.id, input), service.send(document.id, input)]);
    expect(calls).toBe(1);
  });
  test('rejects arbitrary URLs, unconfirmed or stale content, redirects and plain HTTP config', async () => {
    const document = note(); let calls = 0;
    const service = new NoteDeliveryService(store, destinations, async () => { calls++; return new Response('sensitive response', { status: 500 }); });
    const input = { destinationId: 'test', revision: 1, confirm: true, idempotencyKey: crypto.randomUUID() };
    await expect(service.send(document.id, { ...input, confirm: false })).rejects.toThrow();
    await expect(service.send(document.id, { ...input, revision: 2 })).rejects.toThrow('changed elsewhere');
    await expect(service.send(document.id, { ...input, url: 'http://localhost' })).rejects.toThrow();
    await expect(service.send(document.id, { ...input, destinationId: 'missing' })).rejects.toThrow('not found');
    expect(calls).toBe(0);
    expect((await service.send(document.id, input)).state).toBe('unknown');
    expect(JSON.stringify(service.history(document.id))).not.toContain('sensitive');
    const insecure = new NoteDeliveryService(store, async () => [{ id: 'http', name: 'bad', url: 'http://localhost' }]);
    await expect(insecure.send(document.id, { ...input, destinationId: 'http', idempotencyKey: crypto.randomUUID() })).rejects.toThrow();
  });
});
