import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { sqlite } = await import('../db/client');
const { initializeDatabase } = await import('../db/setup');
const { default: recordingsApi } = await import('./recordings');
const { jobQueue } = await import('../jobs/queue');

const root = mkdtempSync(join(tmpdir(), 'openplod-cost-'));
const ids: string[] = [crypto.randomUUID(), crypto.randomUUID()];
let previousConfig: string | null = null;
beforeAll(() => {
  initializeDatabase();
  previousConfig = (sqlite.query("SELECT value FROM user_settings WHERE key='aiConfig'").get() as { value: string } | null)?.value ?? null;
  sqlite.query("INSERT INTO user_settings(key,value) VALUES('aiConfig',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify({ transcriptionEngine: 'openai', transcriptionModel: 'whisper-1', confirmAboveUsd: 0.05 }));
  for (const id of ids) {
    const path = join(root, `${id}.mp3`); writeFileSync(path, 'audio');
    sqlite.query("INSERT INTO recordings(id,file_path,original_filename,duration_seconds,recording_type,status) VALUES(?,?,?,?,'meeting','complete')").run(id, path, 'a.mp3', 600);
  }
});
afterAll(() => {
  for (const job of jobQueue.getAllJobs()) if (ids.includes((job.data as { recordingId?: string }).recordingId ?? '')) jobQueue.cancel(job.id);
  sqlite.query('DELETE FROM recordings WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(ids));
  if (previousConfig === null) sqlite.query("DELETE FROM user_settings WHERE key='aiConfig'").run();
  else sqlite.query("UPDATE user_settings SET value=? WHERE key='aiConfig'").run(previousConfig);
  rmSync(root, { recursive: true, force: true });
});
const post = (path: string, body: unknown) => recordingsApi.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('reprocess refuses to queue when the confirmed endpoint differs from saved settings', async () => {
  const response = await post(`/${ids[0]}/reprocess`, { expectedCustomEndpoint: 'http://localhost:18080/v1', confirmCost: true });
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe('custom_endpoint_changed');
  expect(jobQueue.activeJob('process-recording', ids[0])).toBeFalsy();
});

test('reprocess over the per-job threshold returns the estimate and queues only with confirmCost', async () => {
  const refused = await post(`/${ids[0]}/reprocess`, {});
  expect(refused.status).toBe(409);
  const body = await refused.json();
  expect(body).toMatchObject({ code: 'cost_confirmation_required', data: { totalUsd: 0.06, currency: 'USD', confirmationRequired: true } });
  expect(body.data.label).toContain('not a bill');
  expect(jobQueue.activeJob('process-recording', ids[0])).toBeUndefined();
  expect((await post(`/${ids[0]}/reprocess`, { confirmCost: true })).status).toBe(200);
  expect(jobQueue.activeJob('process-recording', ids[0])!.data).toMatchObject({ costConfirmed: true });
});

test('batch estimate reports cost and the batch requires confirmCost when the gate trips', async () => {
  const estimate = await (await post('/batch/estimate', { recordingIds: [ids[1]] })).json();
  expect(estimate.data.estimatedCost).toMatchObject({ totalUsd: 0.06, confirmationRequired: true, pricesAsOf: expect.any(String) });
  const refused = await post('/batch', { recordingIds: [ids[1]], confirm: true });
  expect(refused.status).toBe(409); expect((await refused.json()).code).toBe('cost_confirmation_required');
  expect((await post('/batch', { recordingIds: [ids[1]], confirm: true, confirmCost: true })).status).toBe(202);
});
