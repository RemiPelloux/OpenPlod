import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { JobQueue } from './queue';
import { submitTranscription, planTranscription } from './submit';
import { createJobsApi } from '../api/jobs';
import { addRecording, knowledgeVault } from '../knowledge/fixtures';

let database: Database, queue: JobQueue;
beforeEach(() => { database = knowledgeVault(); queue = new JobQueue(database); });
afterEach(() => database.close());
const cloud = () => database.query("INSERT INTO user_settings(key,value) VALUES('aiConfig',?)").run(JSON.stringify({ transcriptionEngine: 'mistral' }));

test('an Idempotency-Key returns the same job on retry and rejects a different request (KB-06)', async () => {
  const recording = addRecording(database);
  const first = await submitTranscription(database, queue, { recordingId: recording.id, idempotencyKey: 'retry-1' });
  expect(first).toMatchObject({ replayed: false, plan: { provider: 'whisper', local: true, requiresCloudConsent: false } });
  const again = await submitTranscription(database, queue, { recordingId: recording.id, idempotencyKey: 'retry-1' });
  expect(again).toMatchObject({ replayed: true });
  expect(again.job.id).toBe(first.job.id);
  expect(queue.getAllJobs()).toHaveLength(1);
  // Still the same job after it finished.
  queue.cancel(first.job.id);
  expect((await submitTranscription(database, queue, { recordingId: recording.id, idempotencyKey: 'retry-1' })).job.id).toBe(first.job.id);
  await expect(submitTranscription(database, queue, { recordingId: recording.id, overrides: { transcriptionLanguage: 'fr' }, idempotencyKey: 'retry-1' })).rejects.toThrow('different request');
  await expect(submitTranscription(database, queue, { recordingId: recording.id, idempotencyKey: 'bad key with spaces' })).rejects.toThrow();
  // Without a key, an active job blocks a second submission instead of dropping its options.
  await submitTranscription(database, queue, { recordingId: recording.id });
  await expect(submitTranscription(database, queue, { recordingId: recording.id })).rejects.toThrow('already being processed');
  expect(queue.getAllJobs()).toHaveLength(2);
});

test('plans report cloud providers and reject non-transcription overrides and Trash', () => {
  const recording = addRecording(database);
  cloud();
  expect(planTranscription(database, recording.id).plan).toMatchObject({ provider: 'mistral', local: false, requiresCloudConsent: true });
  expect(() => planTranscription(database, recording.id, { chatProvider: 'openai' } as never)).toThrow();
  database.query("UPDATE recordings SET retention_state='trash'").run();
  expect(() => planTranscription(database, recording.id)).toThrow('Active recording');
});

test('POST /api/v1/jobs needs confirmation, explicit cloud consent, and replays by key', async () => {
  const recording = addRecording(database);
  cloud();
  const api = createJobsApi(queue, database);
  const post = (body: unknown, headers: Record<string, string> = {}) => api.request('/', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const plan = await (await post({ type: 'process-recording', recordingId: recording.id, dryRun: true })).json();
  expect(plan.data).toMatchObject({ job: null, plan: { provider: 'mistral', requiresCloudConsent: true } });
  expect((await post({ type: 'process-recording', recordingId: recording.id })).status).toBe(400);
  const refused = await post({ type: 'process-recording', recordingId: recording.id, confirm: true });
  expect(refused.status).toBe(409);
  expect((await refused.json()).code).toBe('cloud_consent_required');
  expect(queue.getAllJobs()).toHaveLength(0);
  const created = await post({ type: 'process-recording', recordingId: recording.id, confirm: true, acceptCloudProvider: true }, { 'Idempotency-Key': 'mcp-42' });
  expect(created.status).toBe(201);
  const body = await created.json();
  expect(body.data).toMatchObject({ replayed: false, job: { type: 'process-recording', state: 'pending', recordingId: recording.id, provider: 'mistral' } });
  const replay = await post({ type: 'process-recording', recordingId: recording.id, confirm: true, acceptCloudProvider: true, idempotencyKey: 'mcp-42' });
  expect(replay.status).toBe(200);
  expect((await replay.json()).data.job.id).toBe(body.data.job.id);
  expect((await post({ type: 'process-recording', recordingId: crypto.randomUUID(), dryRun: true })).status).toBe(404);
  expect((await post({ type: 'forward-recording', recordingId: recording.id })).status).toBe(400);
});

test('analysis jobs are listed with their provider', async () => {
  const recording = addRecording(database);
  await queue.add('analyze-recording', { recordingId: recording.id, provider: 'ollama' }, 5);
  const list = await (await createJobsApi(queue, database).request('/?type=analyze-recording')).json();
  expect(list.data.jobs).toMatchObject([{ type: 'analyze-recording', recordingId: recording.id, provider: 'ollama', priority: 5 }]);
});


test('a local custom primary with a cloud fallback requires cloud consent', async () => {
  const recording = addRecording(database);
  database.query("INSERT INTO user_settings(key,value) VALUES('aiConfig',?)").run(JSON.stringify({
    transcriptionEngine: 'custom', transcriptionModel: 'fixture', customBaseUrl: 'http://localhost:18080/v1',
    transcriptionFallback: ['mistral'],
  }));
  expect(planTranscription(database, recording.id).plan).toMatchObject({
    provider: 'custom', local: false, requiresCloudConsent: true, cloudProviders: ['mistral'],
  });
  const response = await createJobsApi(queue, database).request('/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'process-recording', recordingId: recording.id, confirm: true }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'cloud_consent_required', error: expect.stringContaining('mistral') });
  expect(queue.getAllJobs()).toHaveLength(0);
});
