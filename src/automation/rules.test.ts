import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Job } from '../jobs/queue';
import { RuleEngine, matchesTrigger, type GenerateRequest } from './rules';
import { WebhookService } from './webhooks';
import { createAutomationsApi } from './api';
import { TaskService } from './tasks';

function fixture(options: { failGenerate?: (request: GenerateRequest) => Error | null } = {}) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE user_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE recordings (id TEXT PRIMARY KEY, file_path TEXT, original_filename TEXT, recording_type TEXT, duration_seconds INTEGER, recorded_at TEXT, uploaded_at TEXT DEFAULT '2026-01-01',
      source_provider TEXT, source_transport TEXT, tags TEXT, retention_state TEXT DEFAULT 'active', revision INTEGER DEFAULT 1);
    CREATE TABLE transcripts (id TEXT, recording_id TEXT, full_text TEXT, extracted_tasks TEXT);
    CREATE TABLE transcript_versions (id TEXT PRIMARY KEY, recording_id TEXT, full_text TEXT);
    CREATE TABLE note_folders (id TEXT PRIMARY KEY);
    CREATE TABLE note_documents (id TEXT PRIMARY KEY);`);
  const jobs = new Map<string, Job>(), added: unknown[] = [], generated: GenerateRequest[] = [];
  const queue = {
    add: async (type: string, data: unknown) => {
      const recordingId = (data as { recordingId: string }).recordingId;
      const existing = [...jobs.values()].find(job => job.type === type && (job.data as { recordingId: string }).recordingId === recordingId && ['pending', 'running'].includes(job.status));
      if (existing) return existing;
      added.push(data);
      const job: Job = { id: crypto.randomUUID(), type, data, status: 'pending', createdAt: new Date(), priority: 0 };
      jobs.set(job.id, job); return job;
    },
    getJob: (id: string) => jobs.get(id),
    activeJob: (type: string, recordingId: string) => [...jobs.values()].find(job => job.type === type && (job.data as { recordingId: string }).recordingId === recordingId && ['pending', 'running'].includes(job.status)),
  };
  const webhooks = new WebhookService(db, { autoDeliver: false, fetcher: async () => new Response('ok') });
  const documents = new Map<string, string>();
  const engine = new RuleEngine(db, { queue, webhooks, generateDocument: async request => {
    generated.push(request);
    const failure = options.failGenerate?.(request);
    if (failure) throw failure;
    if (!documents.has(request.idempotencyKey)) documents.set(request.idempotencyKey, crypto.randomUUID());
    return documents.get(request.idempotencyKey)!;
  } });
  const setConfig = (config: Record<string, unknown>) => db.query("INSERT INTO user_settings(key,value) VALUES('aiConfig',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(config));
  const recording = (id: string, values: Partial<{ type: string; duration: number | null; provider: string; transport: string; tags: string[] }> = {}) =>
    db.query('INSERT INTO recordings(id,file_path,original_filename,recording_type,duration_seconds,source_provider,source_transport,tags) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, `/vault/${id}.m4a`, `${id}.m4a`, values.type ?? 'meeting', values.duration === undefined ? 900 : values.duration, values.provider ?? 'plaud', values.transport ?? 'ble', JSON.stringify(values.tags ?? []));
  /** What the real job handler does: save a version under the job id and the current transcript. */
  const transcribe = (jobId: string) => {
    const job = jobs.get(jobId)!, recordingId = (job.data as { recordingId: string }).recordingId;
    db.query("INSERT INTO transcript_versions VALUES(?,?,'Hello team')").run(jobId, recordingId);
    db.query("INSERT INTO transcripts(id,recording_id,full_text) VALUES(?,?,'Hello team')").run(crypto.randomUUID(), recordingId);
    job.status = 'complete';
  };
  return { db, engine, webhooks, jobs, added, generated, setConfig, recording, transcribe };
}

const meetingRule = (extra: Record<string, unknown> = {}) => ({
  name: 'Plaud meetings to minutes', enabled: true,
  trigger: { sources: ['plaud'], recordingTypes: ['meeting'], minDurationSeconds: 300 },
  actions: [{ type: 'transcribe', provider: 'mistral' }, { type: 'generate_document', template: 'meeting' }, { type: 'add_tags', tags: ['auto-minutes'] }],
  acknowledgements: ['audio:mistral', 'text:mistral'], ...extra,
});

test('triggers match source, type, tag and minimum duration; unknown duration never satisfies a minimum', () => {
  const base = { recordingType: 'meeting', durationSeconds: 600, sourceProvider: 'plaud', sourceTransport: 'ble', tags: '["Client"]' };
  const trigger = { type: 'recording.imported' as const, sources: ['plaud' as const], recordingTypes: ['meeting' as const], tag: 'client', minDurationSeconds: 300 };
  expect(matchesTrigger(trigger, base)).toBe(true);
  expect(matchesTrigger(trigger, { ...base, sourceProvider: 'upload' })).toBe(false);
  expect(matchesTrigger(trigger, { ...base, recordingType: 'class' })).toBe(false);
  expect(matchesTrigger(trigger, { ...base, durationSeconds: null })).toBe(false);
  expect(matchesTrigger(trigger, { ...base, tags: '[]' })).toBe(false);
  expect(matchesTrigger({ ...trigger, sources: ['mobile'], tag: null }, { ...base, sourceTransport: 'mobile' })).toBe(true);
});

test('enabling a rule that sends to a cloud provider or external URL requires explicit acknowledgement', () => {
  const { engine, webhooks } = fixture();
  expect(() => engine.create(meetingRule({ acknowledgements: [] }))).toThrow('audio:mistral, text:mistral');
  const disabled = engine.create(meetingRule({ enabled: false, acknowledgements: [] }));
  expect(disabled.enabled).toBe(false);
  expect(() => engine.update(disabled.id, { enabled: true, revision: disabled.revision })).toThrow('Acknowledge');
  const enabled = engine.update(disabled.id, { enabled: true, acknowledgements: ['audio:mistral', 'text:mistral'], revision: disabled.revision });
  expect(enabled).toMatchObject({ enabled: true, revision: 2 });
  expect(enabled.acknowledgedAt).toBeString();
  expect(() => engine.update(disabled.id, { name: 'stale', revision: 1 })).toThrow('changed elsewhere');
  // A local-only pipeline (Whisper + Ollama) needs no acknowledgement; an external webhook does.
  const hook = webhooks.create({ name: 'Zapier', url: 'https://hooks.example.com/x', eventTypes: ['job.failed'], acknowledgeExternal: true });
  expect(() => engine.create({ name: 'Notify', enabled: true, actions: [{ type: 'transcribe', provider: 'whisper' }, { type: 'notify_webhook', subscriptionId: hook.id }] })).toThrow('webhook:hooks.example.com');
  expect(engine.create({ name: 'Local', enabled: true, actions: [{ type: 'transcribe', provider: 'whisper' }, { type: 'add_tags', tags: ['x'] }] }).enabled).toBe(true);
  expect(() => engine.create({ name: 'Bad folder', actions: [{ type: 'generate_document', folderId: crypto.randomUUID() }] })).toThrow('folder');
});

test('preview lists matching recordings, the providers that would receive audio and text, and an unknown cost', () => {
  const { engine, recording, setConfig } = fixture();
  recording('a'); recording('b', { type: 'class' }); recording('c', { duration: 60 }); recording('d', { provider: 'upload', transport: 'upload' });
  const preview = engine.preview(meetingRule({ acknowledgements: ['audio:mistral'] }));
  expect(preview.matches.map(match => match.id)).toEqual(['a']);
  expect(preview.totalMatches).toBe(1);
  expect(preview.requirements.map(item => [item.key, item.local, item.acknowledged])).toEqual([['audio:mistral', false, true], ['text:mistral', false, false]]);
  expect(preview.missingAcknowledgements).toEqual(['text:mistral']);
  expect(preview.estimatedCost).toMatchObject({ status: 'unknown', amount: null });
  expect(preview.note).toContain('imported after');
  setConfig({ privacyMode: 'local-only', documentProvider: 'ollama' });
  const local = engine.preview(meetingRule());
  expect(local.localOnly).toBe(true);
  expect(local.blockedByLocalOnly).toEqual(['audio:mistral']);
  expect(local.requirements[1]).toMatchObject({ key: 'text:ollama', local: true });
});

test('a matching import runs every step once, in order, and retries never duplicate downstream writes', async () => {
  const { db, engine, jobs, added, generated, recording, transcribe } = fixture();
  const rule = engine.create(meetingRule());
  recording('r1');
  const [runId] = await engine.onRecordingImported('r1');
  expect(await engine.onRecordingImported('r1')).toEqual([]);
  let run = engine.run(runId);
  expect(run.status).toBe('waiting');
  expect(run.steps.map(step => step.status)).toEqual(['waiting', 'pending', 'pending']);
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ recordingId: 'r1', config: { transcriptionEngine: 'mistral', transcriptionFallback: [] } });
  // Sweeps while the job runs do nothing.
  await engine.resumeWaiting();
  expect(added).toHaveLength(1);
  transcribe([...jobs.keys()][0]);
  await engine.onRecordingSettled('r1');
  run = engine.run(runId);
  expect(run.status).toBe('complete');
  expect(run.steps.map(step => step.status)).toEqual(['done', 'done', 'done']);
  expect(generated).toHaveLength(1);
  expect(generated[0]).toMatchObject({ recordingId: 'r1', style: 'meeting', title: 'r1 - Meeting minutes', idempotencyKey: run.steps[1].id, expectedProvider: 'mistral' });
  expect(JSON.parse((db.query("SELECT tags FROM recordings WHERE id='r1'").get() as { tags: string }).tags)).toEqual(['auto-minutes']);
  await engine.onRecordingSettled('r1'); await engine.resumeWaiting();
  expect(generated).toHaveLength(1);
  expect(engine.runs(rule.id)).toHaveLength(1);
  // Non-matching recordings start nothing.
  recording('short', { duration: 30 });
  expect(await engine.onRecordingImported('short')).toEqual([]);
});

test('local-only mode and changed providers are re-checked when a step runs', async () => {
  const { engine, added, generated, recording, setConfig, transcribe, jobs } = fixture();
  engine.create(meetingRule());
  setConfig({ privacyMode: 'local-only' });
  recording('r1');
  const [runId] = await engine.onRecordingImported('r1');
  let run = engine.run(runId);
  expect(run.status).toBe('failed');
  expect(run.steps[0]).toMatchObject({ status: 'failed' });
  expect(run.steps[0].detail).toContain('local-only');
  expect(added).toHaveLength(0);
  // The document provider changes to one the rule was never approved for.
  setConfig({ documentProvider: 'openai' });
  recording('r2');
  const [second] = await engine.onRecordingImported('r2');
  transcribe([...jobs.keys()][0]);
  await engine.onRecordingSettled('r2');
  run = engine.run(second);
  expect(run.steps.map(step => step.status)).toEqual(['done', 'failed', 'pending']);
  expect(run.steps[1].detail).toContain('openai');
  expect(generated).toHaveLength(0);
});

test('an interrupted generation is reported as unknown, and a manual retry uses a fresh key', async () => {
  let interrupted = true;
  const { engine, generated, recording, transcribe, jobs } = fixture({ failGenerate: () => interrupted ? Object.assign(new Error('incomplete'), { code: 'generation_incomplete' }) : null });
  engine.create(meetingRule());
  recording('r1');
  const [runId] = await engine.onRecordingImported('r1');
  transcribe([...jobs.keys()][0]);
  await engine.onRecordingSettled('r1');
  let run = engine.run(runId);
  expect(run.status).toBe('failed');
  expect(run.steps[1]).toMatchObject({ status: 'unknown' });
  interrupted = false;
  run = await engine.retry(runId);
  expect(run.status).toBe('complete');
  expect(generated).toHaveLength(2);
  expect(generated[1].idempotencyKey).not.toBe(generated[0].idempotencyKey);
  await expect(engine.retry(runId)).rejects.toThrow('Only failed');
});

test('disabling a rule cancels its waiting runs; missing collections are skipped; webhook notifications are queued once', async () => {
  const { engine, webhooks, recording } = fixture();
  const hook = webhooks.create({ name: 'Local', url: 'http://127.0.0.1:5000/x', eventTypes: ['job.failed'] });
  const rule = engine.create({ name: 'Tag and notify', enabled: true, trigger: { recordingTypes: ['meeting'] },
    actions: [{ type: 'add_to_collection', collectionId: 'clients' }, { type: 'notify_webhook', subscriptionId: hook.id }, { type: 'transcribe', provider: 'whisper' }] });
  recording('r1');
  const [runId] = await engine.onRecordingImported('r1');
  let run = engine.run(runId);
  expect(run.steps.map(step => step.status)).toEqual(['skipped', 'done', 'waiting']);
  expect(run.steps[0].detail).toContain('not available');
  const [delivery] = webhooks.deliveries(hook.id);
  expect(delivery).toMatchObject({ eventType: 'automation.notify', status: 'pending' });
  engine.update(rule.id, { enabled: false, revision: rule.revision });
  await engine.resumeWaiting();
  run = engine.run(runId);
  expect(run.status).toBe('cancelled');
  expect(run.steps[2].status).toBe('skipped');
  expect(webhooks.deliveries(hook.id)).toHaveLength(1);
});

test('the automations API previews, saves and lists rules with run history', async () => {
  const { db, engine, recording } = fixture();
  const api = createAutomationsApi(engine, new TaskService(db));
  recording('r1');
  const preview = await (await api.request('/rules/preview', { method: 'POST', body: JSON.stringify(meetingRule()) })).json();
  expect(preview.data.totalMatches).toBe(1);
  const missing = await api.request('/rules', { method: 'POST', body: JSON.stringify(meetingRule({ acknowledgements: [] })) });
  expect(missing.status).toBe(400);
  expect((await missing.json()).code).toBe('acknowledgement_required');
  const created = await (await api.request('/rules', { method: 'POST', body: JSON.stringify(meetingRule()) })).json();
  expect((await (await api.request(`/rules/${created.data.id}/preview`)).json()).data.totalMatches).toBe(1);
  await engine.onRecordingImported('r1');
  const runs = await (await api.request(`/rules/${created.data.id}/runs`)).json();
  expect(runs.data[0]).toMatchObject({ ruleName: 'Plaud meetings to minutes', recordingId: 'r1', recordingTitle: 'r1.m4a' });
  expect((await api.request('/rules/nope')).status).toBe(404);
});

test('run history loads a page of runs and their steps in a fixed number of queries', async () => {
  const { countQueries } = await import('../testing/count-queries');
  const { db, engine, recording } = fixture();
  const rule = engine.create(meetingRule());
  const seed = async (from: number, n: number) => { for (let i = from; i < from + n; i++) { recording(`r${i}`); await engine.onRecordingImported(`r${i}`); } };
  await seed(0, 1);
  const small = await countQueries(db, () => engine.runs(rule.id));
  await seed(1, 29);
  const large = await countQueries(db, () => engine.runs(rule.id));
  const all = await countQueries(db, () => engine.runs());
  expect(large.result).toHaveLength(30);
  expect(all.result).toHaveLength(30);
  expect(large.count).toBe(small.count);
  // Same shape as fetching each run on its own.
  for (const run of large.result) expect(run).toEqual(engine.run(run.id));
});
