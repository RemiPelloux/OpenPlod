import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initializeOrganizer, OrganizerStore } from './store';
import { DocumentGenerationService, type GenerationFetch } from './generation';
import { createOrganizerApi } from '../api/organizer';

let database: Database, store: OrganizerStore, recordingId: string, versionId: string;
const source = 'We discussed a local audio vault. The decision was to keep original recordings. The next step is a desktop test. No date was agreed.';
beforeEach(() => {
  database = new Database(':memory:'); database.exec('PRAGMA foreign_keys=ON'); initializeOrganizer(database); store = new OrganizerStore(database);
  database.exec(`CREATE TABLE recordings(id TEXT,original_filename TEXT,recorded_at TEXT,source_provider TEXT,retention_state TEXT);
    CREATE TABLE transcripts(recording_id TEXT,current_version_id TEXT,full_text TEXT,origin TEXT);
    CREATE TABLE transcript_versions(id TEXT,recording_id TEXT,full_text TEXT,origin TEXT);`);
  recordingId = crypto.randomUUID(); versionId = crypto.randomUUID();
  database.query('INSERT INTO recordings VALUES(?,?,?,?,?)').run(recordingId, 'Meeting.wav', '2026-09-05', 'plaud', 'active');
  database.query('INSERT INTO transcripts VALUES(?,?,?,?)').run(recordingId, versionId, source, 'edited');
  database.query('INSERT INTO transcript_versions VALUES(?,?,?,?)').run(versionId, recordingId, source, 'edited');
});
afterEach(() => database.close());
const input = () => ({ recordingId, versionId, title: 'Meeting', idempotencyKey: crypto.randomUUID() });
const content = '# Meeting\n\n## Decision\nKeep original recordings.\n\n## Next step\nTest the desktop vault.';
const response = (text = content, finish = 'stop') => Response.json({ model: 'mistral-small-test', choices: [{ finish_reason: finish, message: { content: text } }] });
const service = (fetcher: GenerationFetch, key = () => 'private-key', timeout = 1000) => new DocumentGenerationService(store, fetcher, key, timeout);

test('calls Mistral, preserves source and saves reviewed output once with provenance and version history', async () => {
  let calls = 0;
  const generator = service((async (url, options) => {
    calls++; expect(url).toBe('https://api.mistral.ai/v1/chat/completions'); expect(options?.redirect).toBe('error');
    const body = JSON.parse(String(options?.body)); expect(body.model).toBe('mistral-small-latest');
    expect(JSON.parse(body.messages[1].content).transcript).toBe(source);
    expect(body.messages[0].content).toContain('untrusted'); return response();
  }) as GenerationFetch);
  const request = input(), stages: string[] = [];
  const generated = await generator.generate(request, async stage => { stages.push(stage); });
  expect(stages).toEqual(['transcript', 'mistral', 'ready']); expect(store.list().total).toBe(0);
  expect((await generator.generate(request, async () => {})).id).toBe(generated.id); expect(calls).toBe(1);
  const saved = generator.save(generated.id, {});
  expect(saved.content).toBe(content); expect(saved.sourceOrigin).toBe('ai:mistral:mistral-small-test');
  expect(saved.sourceVersionId).toBe(versionId); expect(store.versions(saved.id)).toHaveLength(1);
  expect(generator.save(generated.id, {}).id).toBe(saved.id); expect(store.list().total).toBe(1);
  expect(store.transcript(recordingId, versionId).transcript.fullText).toBe(source);
  expect(generator.get(generated.id).steps.at(-1)?.stage).toBe('saved');
  expect(JSON.stringify(generator.get(generated.id))).not.toContain('private-key');
});

test('missing key, oversized input and invalid style never call a provider', async () => {
  let calls = 0; const noKey = service(async () => { calls++; return response(); }, () => '');
  await expect(noKey.generate(input(), async () => {})).rejects.toThrow('Mistral API key');
  await expect(noKey.generate({ ...input(), style: 'unknown' }, async () => {})).rejects.toThrow();
  database.query('UPDATE transcript_versions SET full_text=?').run('a'.repeat(100001));
  await expect(noKey.generate(input(), async () => {})).rejects.toThrow('100 KB'); expect(calls).toBe(0);
});

test('provider errors are redacted and never fall back to a transcript copy', async () => {
  const generator = service(async () => new Response('private-key sensitive provider body', { status: 401 }));
  const request = input(); await expect(generator.generate(request, async () => {})).rejects.toThrow('Mistral rejected');
  expect(generator.get(request.idempotencyKey).state).toBe('failed'); expect(generator.get(request.idempotencyKey).content).toBeNull();
  expect(() => generator.save(request.idempotencyKey, {})).toThrow('review'); expect(store.list().total).toBe(0);
});

test('empty, truncated, unchanged and unstructured responses are rejected', async () => {
  for (const [text, finish] of [['', 'stop'], [content, 'length'], [source, 'stop'], ['Unstructured prose', 'stop']]) {
    const generator = service(async () => response(text, finish));
    await expect(generator.generate(input(), async () => {})).rejects.toThrow();
  }
  expect(store.list().total).toBe(0);
});

test('cancellation and timeout fail without saving; pending requests never run twice', async () => {
  let calls = 0;
  const generator = service(((url, options) => new Promise((resolve, reject) => {
    calls++; options?.signal?.addEventListener('abort', () => reject(new Error('private transport details')), { once: true });
  })) as GenerationFetch, () => 'private-key', 15);
  const request = input(), controller = new AbortController();
  const pending = generator.generate(request, async () => {}, controller.signal);
  await expect(generator.generate(request, async () => {})).rejects.toThrow('still running');
  await new Promise(resolve => setTimeout(resolve, 1)); controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
  await expect(generator.generate(input(), async () => {})).rejects.toThrow('timed out');
  expect(calls).toBe(2); expect(store.list().total).toBe(0);
});

test('rejects reuse with different instructions and deleted or changed source at save', async () => {
  const generator = service(async () => response()), request = input();
  const generated = await generator.generate(request, async () => {});
  await expect(generator.generate({ ...request, title: 'Other' }, async () => {})).rejects.toThrow('different instructions');
  database.query('UPDATE transcript_versions SET full_text=?').run('Edited after generation');
  expect(() => generator.save(generated.id, {})).toThrow('changed');
  database.exec("UPDATE recordings SET retention_state='trash'"); expect(() => generator.save(generated.id, {})).toThrow('Active recording');
});

test('API streams real workflow events and exposes persisted trace, with explicit review save', async () => {
  const generator = service(async () => response()), request = input();
  const api = createOrganizerApi(store, undefined, generator);
  const result = await api.request('/documents/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  expect(result.headers.get('Content-Type')).toContain('text/event-stream');
  expect(result.headers.get('Content-Type')).toContain('charset=utf-8');
  expect(result.headers.get('Cache-Control')).toBe('no-store');
  const events = await result.text(); expect(events).toContain('event: progress'); expect(events).toContain('event: result');
  expect(events).not.toContain('private-key'); expect(store.list().total).toBe(0);
  const saved = await api.request(`/generations/${request.idempotencyKey}/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  expect(saved.status).toBe(200); expect(store.list().total).toBe(1);
});
