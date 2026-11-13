import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebhookService, signWebhook, type WebhookOptions } from './webhooks';
import { createWebhooksApi } from './api';
import { emitAutomationEvent, onAutomationEvent } from './hooks';
import { stableId } from './common';

type Call = { url: string; init: RequestInit };
function fixture(options: WebhookOptions = {}, respond: (call: Call) => Promise<Response> | Response = () => new Response('ok')) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE user_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE recordings (id TEXT PRIMARY KEY, recording_type TEXT, duration_seconds INTEGER, recorded_at TEXT, source_provider TEXT, source_transport TEXT, original_filename TEXT, retention_state TEXT DEFAULT 'active');
    CREATE TABLE transcript_versions (id TEXT PRIMARY KEY, recording_id TEXT, full_text TEXT);
    CREATE TABLE note_documents (id TEXT PRIMARY KEY, title TEXT, content TEXT, folder_id TEXT, revision INTEGER DEFAULT 1, source_recording_id TEXT, source_version_id TEXT, created_at TEXT, deleted_at TEXT);`);
  const calls: Call[] = [];
  let clock = Date.parse('2026-10-15T10:00:00Z');
  const service = new WebhookService(db, { autoDeliver: false, now: () => clock, baseDelayMs: 1000, ...options,
    fetcher: async (url, init) => { calls.push({ url, init }); return respond({ url, init }); } });
  return { db, service, calls, advance: (ms: number) => { clock += ms; } };
}
const subscription = (service: WebhookService, extra: Record<string, unknown> = {}) =>
  service.create({ name: 'Local receiver', url: 'http://127.0.0.1:9999/hook', eventTypes: ['recording.imported', 'document.created', 'recording.transcribed'], ...extra });
const header = (call: Call, name: string) => (call.init.headers as Record<string, string>)[name];

test('subscriptions accept HTTPS or loopback HTTP only, need acknowledgement to leave the computer, and show the secret once', () => {
  const { service, db } = fixture();
  expect(() => service.create({ name: 'x', url: 'http://example.com/hook', eventTypes: ['job.failed'] })).toThrow();
  expect(() => service.create({ name: 'x', url: 'https://user:pass@example.com/hook', eventTypes: ['job.failed'] })).toThrow();
  expect(() => service.create({ name: 'x', url: 'https://example.com/hook', eventTypes: ['job.failed'] })).toThrow('leaves this computer');
  expect(() => service.create({ name: 'x', url: 'https://example.com/hook', eventTypes: ['job.failed'], acknowledgeExternal: true, includeText: true })).toThrow('separate confirmation');
  const created = service.create({ name: 'x', url: 'https://example.com/hook', eventTypes: ['job.failed', 'job.failed'], acknowledgeExternal: true });
  expect(created.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
  expect(created).toMatchObject({ external: true, host: 'example.com', eventTypes: ['job.failed'], enabled: true });
  expect(JSON.stringify(service.list())).not.toContain(created.secret);
  // Stored encrypted at rest, never in plaintext.
  const stored = (db.query('SELECT secret FROM webhook_subscriptions WHERE id=?').get(created.id) as { secret: string }).secret;
  expect(stored).toStartWith('enc:v1:');
  expect(stored).not.toContain(created.secret);
  const rotated = service.rotateSecret(created.id);
  expect(rotated.secret).not.toBe(created.secret);
});

test('an event is recorded once, delivered with stable ids and a verifiable signature, without transcript text by default', async () => {
  const { db, service, calls } = fixture();
  const sub = subscription(service);
  db.query("INSERT INTO recordings(id,recording_type,duration_seconds,source_provider,source_transport,original_filename) VALUES('r1','meeting',600,'plaud','ble','Standup.m4a')").run();
  const first = service.handle({ type: 'recording.imported', recordingId: 'r1' });
  const second = service.handle({ type: 'recording.imported', recordingId: 'r1' });
  expect(first).toBe(second!);
  expect(await service.deliverDue()).toBe(1);
  expect(await service.deliverDue()).toBe(0);
  expect(calls).toHaveLength(1);
  const body = String(calls[0].init.body), payload = JSON.parse(body);
  expect(payload).toMatchObject({ schemaVersion: '1', id: first, type: 'recording.imported', deliveryId: stableId('webhook-delivery', first!, sub.id),
    data: { recordingId: 'r1', recordingType: 'meeting', durationSeconds: 600, sourceProvider: 'plaud' } });
  expect(header(calls[0], 'OpenPlod-Event-Id')).toBe(first!);
  expect(header(calls[0], 'Idempotency-Key')).toBe(first!);
  // Receiver-side verification, exactly as documented.
  const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header(calls[0], 'OpenPlod-Signature'))!;
  const expected = createHmac('sha256', sub.secret).update(`${t}.${body}`).digest('hex');
  expect(timingSafeEqual(Buffer.from(v1), Buffer.from(expected))).toBe(true);
  expect(signWebhook(sub.secret, Number(t), body)).toBe(`t=${t},v1=${v1}`);
  const [delivery] = service.deliveries(sub.id);
  expect(delivery).toMatchObject({ status: 'delivered', attemptCount: 1, lastStatusCode: 200, attempts: [{ attempt: 1, trigger: 'auto', outcome: 'delivered' }] });
  // Transcript text is only sent when the subscription opted in.
  db.query("INSERT INTO transcript_versions VALUES('v1','r1','secret words')").run();
  service.handle({ type: 'recording.transcribed', recordingId: 'r1', transcriptVersionId: 'v1', provider: 'whisper', model: null, current: true });
  await service.deliverDue();
  expect(JSON.parse(String(calls[1].init.body)).data.text).toBeUndefined();
  const withText = subscription(service, { includeText: true, acknowledgeText: true, eventTypes: ['recording.transcribed'] });
  service.enqueue('recording.transcribed', 'v1-again', { recordingId: 'r1', transcriptVersionId: 'v1' });
  await service.deliverDue();
  const textCall = calls.find(call => header(call, 'OpenPlod-Delivery-Id') === stableId('webhook-delivery', stableId('webhook-event', 'recording.transcribed', 'v1-again'), withText.id))!;
  expect(JSON.parse(String(textCall.init.body)).data.text).toBe('secret words');
});

test('failures retry with exponential backoff, then fail, and repeated failures disable the subscription', async () => {
  const { service, calls, advance } = fixture({ maxAttempts: 3, disableAfter: 2 }, () => new Response('nope', { status: 503 }));
  const sub = subscription(service, { eventTypes: ['job.failed'] });
  service.handle({ type: 'job.failed', jobId: 'j1', jobType: 'process-recording', recordingId: null, error: 'boom' });
  await service.deliverDue();
  let [delivery] = service.deliveries(sub.id);
  expect(delivery).toMatchObject({ status: 'pending', attemptCount: 1, lastStatusCode: 503 });
  expect(Date.parse(delivery.nextAttemptAt!) - Date.parse('2026-10-15T10:00:00Z')).toBe(1000);
  expect(await service.deliverDue()).toBe(0);
  advance(1000); await service.deliverDue();
  [delivery] = service.deliveries(sub.id);
  expect(Date.parse(delivery.nextAttemptAt!) - Date.parse('2026-10-15T10:00:01Z')).toBe(2000);
  advance(2000); await service.deliverDue();
  [delivery] = service.deliveries(sub.id);
  expect(delivery).toMatchObject({ status: 'failed', attemptCount: 3 });
  expect(delivery.attempts.map(attempt => attempt.outcome)).toEqual(['failed', 'failed', 'failed']);
  expect(new Set(calls.map(call => header(call, 'OpenPlod-Delivery-Id'))).size).toBe(1);
  expect(service.get(sub.id)).toMatchObject({ enabled: true, consecutiveFailures: 1 });
  service.handle({ type: 'job.failed', jobId: 'j2', jobType: 'process-recording', recordingId: null, error: 'boom' });
  for (let i = 0; i < 3; i++) { await service.deliverDue(); advance(10000); }
  expect(service.get(sub.id)).toMatchObject({ enabled: false, consecutiveFailures: 2 });
  expect(service.get(sub.id).disabledReason).toContain('Disabled after 2');
  // A disabled subscription receives nothing new, and enabling it resets the counter.
  service.handle({ type: 'job.failed', jobId: 'j3', jobType: 'x', recordingId: null, error: null });
  expect(service.deliveries(sub.id)).toHaveLength(2);
  expect(service.update(sub.id, { enabled: true })).toMatchObject({ enabled: true, consecutiveFailures: 0, disabledReason: null });
});

test('a timeout after sending is unknown, never retried automatically, and redelivery reuses the same ids', async () => {
  let mode: 'timeout' | 'refused' | 'ok' = 'timeout';
  const { service, calls, advance } = fixture({}, () => {
    if (mode === 'timeout') throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
    if (mode === 'refused') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    return new Response(null, { status: 204 });
  });
  const sub = subscription(service, { eventTypes: ['job.failed'] });
  service.handle({ type: 'job.failed', jobId: 'j1', jobType: 'process-recording', recordingId: null, error: null });
  await service.deliverDue();
  let [delivery] = service.deliveries(sub.id);
  expect(delivery).toMatchObject({ status: 'unknown', nextAttemptAt: null, attempts: [{ outcome: 'unknown' }] });
  advance(86400000);
  expect(await service.deliverDue()).toBe(0);
  mode = 'ok';
  const redelivered = await service.redeliver(delivery.id);
  expect(redelivered).toMatchObject({ id: delivery.id, status: 'delivered', attemptCount: 2 });
  expect(redelivered.attempts.map(attempt => [attempt.trigger, attempt.outcome])).toEqual([['auto', 'unknown'], ['manual', 'delivered']]);
  expect(header(calls[0], 'OpenPlod-Event-Id')).toBe(header(calls[1], 'OpenPlod-Event-Id'));
  expect(header(calls[0], 'OpenPlod-Delivery-Id')).toBe(header(calls[1], 'OpenPlod-Delivery-Id'));
  // A refused connection proves nothing was sent, so it is retried.
  mode = 'refused';
  service.handle({ type: 'job.failed', jobId: 'j2', jobType: 'x', recordingId: null, error: null });
  await service.deliverDue();
  [delivery] = service.deliveries(sub.id).filter(item => item.status !== 'delivered');
  expect(delivery).toMatchObject({ status: 'pending', attempts: [{ outcome: 'failed' }] });
});

test('local-only mode blocks external endpoints, and an interrupted delivery is recovered as unknown', async () => {
  const { db, service, calls } = fixture();
  const external = service.create({ name: 'Cloud', url: 'https://hooks.example.com/x', eventTypes: ['job.failed'], acknowledgeExternal: true });
  const local = subscription(service, { eventTypes: ['job.failed'] });
  db.query("INSERT INTO user_settings(key,value) VALUES('aiConfig',?)").run(JSON.stringify({ privacyMode: 'local-only' }));
  service.handle({ type: 'job.failed', jobId: 'j1', jobType: 'x', recordingId: null, error: null });
  await service.deliverDue();
  expect(service.deliveries(external.id)[0]).toMatchObject({ status: 'blocked', attempts: [{ outcome: 'blocked' }] });
  expect(service.deliveries(local.id)[0]).toMatchObject({ status: 'delivered' });
  expect(calls.map(call => call.url)).toEqual(['http://127.0.0.1:9999/hook']);
  // Simulate a crash mid-request.
  const id = service.deliveries(local.id)[0].id;
  db.query("UPDATE webhook_deliveries SET status='delivering' WHERE id=?").run(id);
  db.query("INSERT INTO webhook_attempts(delivery_id,attempt,trigger,started_at) VALUES(?,2,'auto','2026-10-15T10:00:00Z')").run(id);
  new WebhookService(db, { autoDeliver: false });
  expect(service.delivery(id)).toMatchObject({ status: 'unknown' });
  expect(service.delivery(id).attempts.at(-1)).toMatchObject({ outcome: 'unknown' });
});

test('the API creates, pings, lists deliveries and reports validation errors', async () => {
  const { service, calls } = fixture();
  const api = createWebhooksApi(service);
  const bad = await api.request('/', { method: 'POST', body: JSON.stringify({ name: 'x', url: 'ftp://x', eventTypes: ['job.failed'] }) });
  expect(bad.status).toBe(400);
  const created = await (await api.request('/', { method: 'POST', body: JSON.stringify({ name: 'x', url: 'http://localhost:4000/in', eventTypes: ['job.failed'] }) })).json();
  expect(created.data.secret).toBeString();
  const ping = await (await api.request(`/${created.data.id}/test`, { method: 'POST' })).json();
  expect(ping.data).toMatchObject({ eventType: 'webhook.test', status: 'delivered' });
  expect(calls).toHaveLength(1);
  const deliveries = await (await api.request(`/${created.data.id}/deliveries`)).json();
  expect(deliveries.data).toHaveLength(1);
  expect((await api.request('/not-a-real-id')).status).toBe(404);
  const list = await (await api.request('/')).json();
  expect(list.data.subscriptions[0].secret).toBeUndefined();
});

test('the in-process event bus isolates listener failures', async () => {
  const seen: string[] = [];
  const off1 = onAutomationEvent(() => { throw new Error('sync boom'); });
  const off2 = onAutomationEvent(async () => { throw new Error('async boom'); });
  const off3 = onAutomationEvent(event => { seen.push(event.type); });
  const original = console.error; console.error = () => {};
  try { await emitAutomationEvent({ type: 'document.created', documentId: 'd1' }); }
  finally { console.error = original; off1(); off2(); off3(); }
  expect(seen).toEqual(['document.created']);
});

test('history pruning removes only finished deliveries past retention and keeps the event as the idempotency record', async () => {
  const { service, db } = fixture({ historyRetentionDays: 30 }, () => new Response('ok'));
  const sub = subscription(service);
  db.query("INSERT INTO recordings(id, recording_type) VALUES ('old','audio'),('new','audio'),('waiting','audio')").run();
  for (const id of ['old', 'new', 'waiting']) service.handle({ type: 'recording.imported', recordingId: id });
  await service.deliverDue();
  const deliveryFor = (id: string) => stableId('webhook-delivery', stableId('webhook-event', 'recording.imported', id), sub.id);
  // 'old' finished long ago; 'waiting' is old but still pending a retry.
  db.query("UPDATE webhook_deliveries SET updated_at='2026-01-01T00:00:00.000Z' WHERE id=?").run(deliveryFor('old'));
  db.query("UPDATE webhook_deliveries SET status='pending', updated_at='2026-01-01T00:00:00.000Z' WHERE id=?").run(deliveryFor('waiting'));
  db.query("UPDATE webhook_events SET created_at='2026-01-01T00:00:00.000Z'").run();

  expect(service.pruneHistory()).toEqual({ deliveries: 1, attempts: 1, events: 1 });
  expect(() => service.delivery(deliveryFor('old'))).toThrow('Delivery not found');
  expect(service.delivery(deliveryFor('new')).status).toBe('delivered');
  expect(service.delivery(deliveryFor('waiting')).status).toBe('pending');
  // The same event emitted again is still recognised and not delivered a second time.
  service.handle({ type: 'recording.imported', recordingId: 'old' });
  expect((db.query('SELECT COUNT(*) AS n FROM webhook_deliveries WHERE id=?').get(deliveryFor('old')) as { n: number }).n).toBe(0);
  expect(service.pruneHistory()).toEqual({ deliveries: 0, attempts: 0, events: 0 });
});

test('listing deliveries loads every attempt in one query', async () => {
  const { countQueries } = await import('../testing/count-queries');
  const { service, db } = fixture({}, () => new Response('ok'));
  const sub = subscription(service);
  const seed = async (from: number, n: number) => {
    for (let i = from; i < from + n; i++) { db.query("INSERT INTO recordings(id, recording_type) VALUES (?, 'audio')").run(`r${i}`); service.handle({ type: 'recording.imported', recordingId: `r${i}` }); }
    await service.deliverDue();
  };
  await seed(0, 1);
  const small = await countQueries(db, () => service.deliveries(sub.id));
  await seed(1, 49);
  const large = await countQueries(db, () => service.deliveries(sub.id, 200));
  expect(large.result).toHaveLength(50);
  expect(large.count).toBe(small.count);
  expect(large.result.every(delivery => delivery.attempts.length === 1 && delivery.attempts[0].outcome === 'delivered')).toBe(true);
});
