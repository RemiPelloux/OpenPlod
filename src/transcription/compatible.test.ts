import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { OpenAiEngine } from './openai';
import { createAiSettingsApi } from '../api/ai-settings';
import { estimateSpeechUsd } from '../ai/pricing';
import { aiConfigFromSettings, aiConfigSchema, assertLivePrivacy } from '../ai/config';
import { TranscriptionRouter } from './router';
const fake = (fn: (url: string, init: RequestInit) => Promise<Response>) => fn as typeof fetch;
const audio = Buffer.from('fixture');
test('compatible audio uses selected URL/model, optional key, and preserves speaker identity and timings', async () => {
  const engine = new OpenAiEngine(undefined, fake(async (url, init) => {
    expect(url).toBe('http://127.0.0.1:18080/v1/audio/transcriptions');
    expect(init.headers).toEqual({}); expect(init.redirect).toBe('error');
    const form = init.body as FormData;
    expect(form.get('model')).toBe('NVIDIA-Nemotron-3.5-Transcribe-30B-A4B');
    expect(form.get('response_format')).toBe('diarized_json');
    expect(form.get('chunking_strategy')).toBe('auto');
    for (const extension of ['diarize', 'word_timestamps', 'timestamp_granularities[]', 'max_tokens', 'prompt']) {
      expect(form.has(extension)).toBe(false);
    }
    expect(form.get('language')).toBe('fr');
    return Response.json({ text: '<spk:0> Bonjour. <spk:1> Salut. <spk:0> Merci.', duration: 0.1,
      segments: [{ start: 0, end: 1, text: 'Bonjour.', speaker: 'A' }, { start: 2, end: 3, text: 'Salut.', speaker: 'B' }, { start: 4, end: 5, text: 'Merci.', speaker: 'A' }] });
  }), 'http://127.0.0.1:18080/v1/');
  const result = await engine.transcribeBuffer(audio, 'audio/wav', { model: 'NVIDIA-Nemotron-3.5-Transcribe-30B-A4B', language: 'fr', diarize: true, prompt: 'Réunion en français' });
  expect(result.success).toBe(true); expect(result.segments.map(s => s.speaker)).toEqual([0, 1, 0]);
  expect(result.speakerCount).toBe(2); expect(result.duration).toBe(0); expect(result.fullText).toBe('Bonjour. Salut. Merci.');
});
test('requested diarization fails when labels or timings are absent; malformed timings and HTTP errors are rejected', async () => {
  for (const payload of [{ text: 'Bonjour' }, { text: 'Bonjour', segments: [{ start: 0, end: 1, text: 'Bonjour' }] }, { text: 'Bonjour', segments: [{ start: 2, end: 1, text: 'Bonjour', speaker: 0 }] }]) {
    const engine = new OpenAiEngine('', fake(async () => Response.json(payload)), 'http://localhost:18080/v1');
    expect((await engine.transcribeBuffer(audio, 'audio/wav', { model: 'test', diarize: true })).success).toBe(false);
  }
  const engine = new OpenAiEngine('secret', fake(async () => new Response('secret', { status: 401 })), 'https://example.com/v1');
  const result = await engine.transcribeBuffer(audio, 'audio/wav', { model: 'test' });
  expect(result.error).toContain('401'); expect(result.error).not.toContain('secret');
});
test('model discovery reuses custom connection, accepts draft URL and does not save it', async () => {
  const db = new Database(':memory:'); db.exec('CREATE TABLE user_settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT)');
  const config = aiConfigSchema.parse({ privacyMode: 'local-only' });
  db.query('INSERT INTO user_settings(key,value) VALUES(?,?)').run('aiConfig', JSON.stringify(config));
  let calls = 0;
  const api = createAiSettingsApi(db, fake(async (url, init) => {
    calls++; expect(url).toBe('http://localhost:18080/v1/models'); expect(init.headers).toEqual({ Authorization: 'Bearer test-key' });
    return Response.json({ data: [{ id: 'nemotron' }, { id: 'nemotron' }, { id: 'other' }] });
  }));
  const request = (url: string) => api.request('/check/custom', { method: 'POST', body: JSON.stringify({ customBaseUrl: url, apiKey: 'test-key' }) });
  const result = await (await request('http://localhost:18080/v1')).json();
  expect(result.data.models).toEqual(['nemotron', 'other']);
  expect((await request('https://example.com/v1')).status).toBe(503); expect(calls).toBe(1);
  expect((db.query("SELECT value FROM user_settings WHERE key='aiConfig'").get() as { value: string }).value).toBe(JSON.stringify(config)); db.close();
});
test('router detects custom availability without an API key and blocks remote URL in local-only mode', async () => {
  const router = new TranscriptionRouter({ primary: 'custom', localOnly: true }, { customBaseUrl: 'https://example.com/v1' });
  expect(router.status().custom).toBe(true);
  expect((await router.transcribeBuffer(audio, 'audio/wav', { model: 'test' })).success).toBe(false);
  expect(new TranscriptionRouter().status().custom).toBe(false);
});

test('a saved custom key stays with its endpoint when checking or saving a different URL', async () => {
  using db = new Database(':memory:');
  db.exec('CREATE TABLE user_settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
  const original = aiConfigSchema.parse({ customBaseUrl: 'https://speech.example/v1' });
  const insert = db.query('INSERT INTO user_settings(key,value) VALUES(?,?)');
  insert.run('aiConfig', JSON.stringify(original));
  insert.run('customApiKey', 'fixture-key');
  const requests: RequestInit['headers'][] = [];
  const api = createAiSettingsApi(db, fake(async (_url, init) => {
    requests.push(init.headers);
    return Response.json({ data: [] });
  }));
  for (const customBaseUrl of ['https://speech.example/v1/', 'https://other.example/v1']) {
    const response = await api.request('/check/custom', { method: 'POST', body: JSON.stringify({ customBaseUrl }) });
    expect(response.status).toBe(200);
  }
  expect(requests).toEqual([{ Authorization: 'Bearer fixture-key' }, {}]);
  const save = (customBaseUrl: string) => api.request('/', {
    method: 'PUT', body: JSON.stringify({ ...original, customBaseUrl }),
    headers: { 'Content-Type': 'application/json' },
  });
  const storedKey = db.query("SELECT value FROM user_settings WHERE key='customApiKey'");
  expect((await save('https://speech.example/v1/')).status).toBe(200);
  expect(storedKey.get()).toEqual({ value: 'fixture-key' });
  expect((await save('https://other.example/v1')).status).toBe(200);
  expect(storedKey.get()).toBeNull();
});

test('custom providers require a chosen model and cannot be a fallback', () => {
  expect(aiConfigSchema.safeParse({ transcriptionFallback: ['custom'] }).success).toBe(false);
  expect(aiConfigFromSettings({ aiConfig: JSON.stringify({ transcriptionFallback: ['custom', 'whisper'] }) }).transcriptionFallback).toEqual(['whisper']);
});

test('custom models with inherited property names still have unknown prices', () => {
  for (const model of ['constructor', 'toString', '__proto__']) {
    expect(estimateSpeechUsd('custom', model, 60)).toBeNull();
  }
});


test('a live local-only change blocks subsequent chunks at the queued remote endpoint', async () => {
  using db = new Database(':memory:');
  db.exec('CREATE TABLE user_settings(key TEXT PRIMARY KEY, value TEXT)');
  const remote = 'https://speech.example/v1';
  const save = db.query("INSERT OR REPLACE INTO user_settings VALUES ('aiConfig', ?)");
  save.run(JSON.stringify({ customBaseUrl: remote }));
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = fake(async url => {
    requests.push(url);
    return Response.json({ text: 'Synthetic chunk', duration: 1 });
  });
  try {
    const router = new TranscriptionRouter({
      primary: 'custom',
      beforeAttempt: provider => assertLivePrivacy(db, remote, provider),
    }, { customBaseUrl: remote }).primaryOnly();
    expect((await router.transcribeBuffer(audio, 'audio/wav', { model: 'fixture' })).success).toBe(true);
    save.run(JSON.stringify({ privacyMode: 'local-only', customBaseUrl: 'http://localhost:18080/v1' }));
    await expect(router.transcribeBuffer(audio, 'audio/wav', { model: 'fixture' })).rejects.toThrow('Local-only mode blocks this provider');
    expect(requests).toEqual([`${remote}/audio/transcriptions`]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('a privacy change during file preparation is checked again before upload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openplod-privacy-'));
  const file = join(root, 'synthetic.wav');
  const originalFetch = globalThis.fetch;
  let permitted = true;
  let calls = 0;
  try {
    await writeFile(file, audio);
    globalThis.fetch = fake(async () => { calls++; return Response.json({ text: 'Synthetic' }); });
    const router = new TranscriptionRouter({
      primary: 'custom',
      beforeAttempt: () => { if (!permitted) throw new Error('Local-only mode blocks this provider.'); },
    }, { customBaseUrl: 'https://speech.example/v1' });
    const result = router.transcribeFile(file, { model: 'fixture' });
    permitted = false;
    expect((await result).error).toContain('Local-only');
    expect(calls).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
