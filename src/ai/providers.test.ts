import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { aiConfigSchema, readAiConfig, textSelection } from './config';
import { createAiSettingsApi } from '../api/ai-settings';
import { completeText, installedOllamaModels } from './text';
import { OpenAiEngine } from '../transcription/openai';
import { AssemblyAiEngine } from '../transcription/assemblyai';
import { TranscriptionRouter } from '../transcription/router';
import { normalizeMistralTranscription } from '../transcription/mistral';

function database() { const db = new Database(':memory:'); db.exec("CREATE TABLE user_settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT)"); return db; }
const fakeFetch = (fn: (url: string, init: RequestInit) => Promise<Response>) => fn as typeof fetch;
test('legacy Mistral settings migrate without cloud fallback or English defaults', () => {
  const db = database(); db.query('INSERT INTO user_settings(key,value) VALUES(?,?)').run('transcriptionEngine', 'mistral');
  expect(readAiConfig(db)).toMatchObject({ transcriptionEngine: 'mistral', transcriptionLanguage: 'auto', transcriptionFallback: [], documentProvider: 'mistral' }); db.close();
});
test('atomic settings reject invalid options, redact keys and enforce local-only across tasks', async () => {
  const db = database(), api = createAiSettingsApi(db), config = aiConfigSchema.parse({});
  const put = (body: unknown) => api.request('/', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect((await put({ ...config, credentials: { openaiApiKey: 'synthetic-secret' } })).status).toBe(200);
  const result = await (await api.request('/')).text(); expect(result).not.toContain('synthetic-secret'); expect(result).toContain('openaiApiKey');
  expect((await put({ ...config, transcriptionEngine: 'mistral', transcriptionDiarize: true })).status).toBe(400);
  expect((await put({ ...config, privacyMode: 'local-only', chatProvider: 'openai' })).status).toBe(400);
  expect((await put({ ...config, credentials: { unknown: 'key' } })).status).toBe(400);
  expect(readAiConfig(db).transcriptionEngine).toBe('whisper'); db.close();
});
test('local-only refuses a configured cloud text provider before calling it', () => {
  const db = database(); db.query('INSERT INTO user_settings(key,value) VALUES(?,?)').run('aiConfig', JSON.stringify({ privacyMode: 'local-only' }));
  expect(() => textSelection(db, 'chat', () => 'key')).toThrow('Local-only'); db.close();
});
test('OpenAI multipart preserves automatic language, vocabulary and genuine unknown metrics', async () => {
  const engine = new OpenAiEngine('synthetic-secret', fakeFetch(async (url, init) => {
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions'); expect(init.redirect).toBe('error');
    const form = init.body as FormData; expect(form.get('language')).toBeNull(); expect(form.get('prompt')).toBe('OpenPlod'); expect(form.get('response_format')).toBe('verbose_json');
    return Response.json({ text: 'Bonjour OpenPlod', segments: [{ start: 0, end: 2, text: 'Bonjour OpenPlod' }] });
  }));
  const result = await engine.transcribeBuffer(Buffer.from('synthetic-audio'), 'audio/wav', { vocabulary: ['OpenPlod'] });
  expect(result).toMatchObject({ success: true, speakerCount: null, confidence: null, duration: 2 });
});
test('OpenAI text-only models do not invent timestamps', async () => {
  const engine = new OpenAiEngine('key', fakeFetch(async (_url, init) => {
    expect((init.body as FormData).get('timestamp_granularities[]')).toBeNull(); return Response.json({ text: 'Bonjour' });
  }));
  const result = await engine.transcribeBuffer(Buffer.from('fixture'), 'audio/wav', { model: 'gpt-4o-transcribe' });
  expect(result.segments).toEqual([]); expect(result.duration).toBe(0);
});
test('OpenAI rejects oversized, unsupported, malformed and cancelled requests', async () => {
  let calls = 0;
  const engine = new OpenAiEngine('key', fakeFetch(async () => { calls++; return Response.json({ text: 'x', segments: [{ start: 5, end: 1, text: 'x' }] }); }));
  expect((await engine.transcribeBuffer(Buffer.alloc(25_000_001), 'audio/wav')).success).toBe(false);
  expect((await engine.transcribeBuffer(Buffer.from('fixture'), 'audio/wav', { diarize: true })).success).toBe(false);
  expect(calls).toBe(0);
  expect((await engine.transcribeBuffer(Buffer.from('fixture'), 'audio/wav')).success).toBe(false);
  expect((await engine.transcribeBuffer(Buffer.from('fixture'), 'audio/wav', { signal: AbortSignal.abort() })).success).toBe(false); expect(calls).toBe(1);
});
test('cloud speech errors never expose provider bodies', async () => {
  for (const status of [401, 429, 500]) {
    const result = await new OpenAiEngine('synthetic-secret', fakeFetch(async () => new Response('synthetic-secret', { status }))).transcribeBuffer(Buffer.from('fixture'), 'audio/wav');
    expect(result.error).toContain(String(status)); expect(JSON.stringify(result)).not.toContain('synthetic-secret');
  }
});
test('AssemblyAI checkpoints submission, polls without new upload, and converts milliseconds', async () => {
  const paths: string[] = [], checkpoints: unknown[] = [];
  const fetcher = fakeFetch(async (url, init) => {
    paths.push(url);
    if (url.endsWith('/upload')) return Response.json({ upload_url: 'https://cdn.assemblyai.com/test' });
    if (url.endsWith('/transcript')) { const body = JSON.parse(String(init.body)); expect(body.speech_models).toEqual(['universal-2']); expect(body.language_detection).toBe(true); return Response.json({ id: 'job-1' }); }
    return Response.json({ id: 'job-1', status: 'completed', text: 'Bonjour', utterances: [{ start: 100, end: 900, text: 'Bonjour', speaker: 'A' }], audio_duration: 1 });
  });
  const engine = new AssemblyAiEngine('key', fetcher, 1);
  const result = await engine.transcribeBuffer(Buffer.from('fixture'), 'audio/wav', { onCheckpoint: value => checkpoints.push(value) });
  expect(checkpoints).toEqual([{ phase: 'uploading' }, { phase: 'submitting' }, { phase: 'polling', remoteId: 'job-1' }]);
  expect(result.segments[0]).toMatchObject({ start: 0.1, end: 0.9, speaker: 0 });
  paths.length = 0;
  expect((await engine.transcribeBuffer(Buffer.alloc(0), '', { checkpoint: { phase: 'polling', remoteId: 'job-1' } })).success).toBe(true);
  expect(paths).toEqual(['https://api.assemblyai.com/v2/transcript/job-1']);
});
test('AssemblyAI uncertain submission cannot be replayed and wrong remote IDs are rejected', async () => {
  let calls = 0;
  const engine = new AssemblyAiEngine('key', fakeFetch(async () => { calls++; return Response.json({ id: 'wrong', status: 'completed', text: 'x' }); }), 1);
  expect((await engine.transcribeBuffer(Buffer.alloc(0), '', { checkpoint: { phase: 'submitting' } })).success).toBe(false); expect(calls).toBe(0);
  expect((await engine.transcribeBuffer(Buffer.alloc(0), '', { checkpoint: { phase: 'polling', remoteId: 'correct' } })).success).toBe(false);
});
test('router blocks implicit cloud fallback and diarization rerouting', async () => {
  const router = new TranscriptionRouter({ primary: 'mistral', localOnly: true }, { mistralApiKey: 'key' });
  expect((await router.transcribeBuffer(Buffer.from('fixture'), 'audio/wav')).error).toContain('Local-only');
  const selected = new TranscriptionRouter({ primary: 'mistral', fallback: [] }, { mistralApiKey: 'key' });
  await expect(selected.transcribeWithDiarization('/not-read')).rejects.toThrow('speaker labels');
});
test('Mistral missing confidence and timestamps remain unknown', () => {
  const result = normalizeMistralTranscription({ text: 'Bonjour', segments: [{ text: 'Bonjour' }] });
  expect(result.confidence).toBeNull(); expect(result.speakerCount).toBeNull(); expect(result.segments).toEqual([]);
});
test('OpenAI and Anthropic text adapters preserve model/usage and strict completion', async () => {
  for (const provider of ['openai', 'anthropic'] as const) {
    const result = await completeText({ provider, model: 'test-model', apiKey: 'synthetic-key' }, [{ role: 'system', content: 'Return JSON.' }, { role: 'user', content: 'fixture' }], { json: true }, async (url, init) => {
      expect(init.redirect).toBe('error'); const body = JSON.parse(String(init.body)); expect(body.model).toBe('test-model');
      if (provider === 'anthropic') { expect(url).toContain('anthropic.com'); expect(body.system).toBe('Return JSON.'); return Response.json({ model: 'reported-model', stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 5 } }); }
      return Response.json({ model: 'reported-model', choices: [{ finish_reason: 'stop', message: { content: '{}' } }], usage: { prompt_tokens: 5 } });
    });
    expect(result.provider).toBe(provider); expect(result.model).toBe('reported-model'); expect(result.usage).not.toBeNull();
  }
  await expect(completeText({ provider: 'openai', model: 'test', apiKey: 'key' }, [], {}, async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }))).rejects.toThrow();
});
test('Ollama rejects absent and cloud models before sending transcript', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json({ models: [{ name: 'local:latest' }, { name: 'remote:cloud' }, { name: 'deceptive-local', remote_host: 'https://ollama.com', remote_model: 'cloud' }] }); };
  expect(await installedOllamaModels(fetcher)).toEqual(['local:latest']);
  await expect(completeText({ provider: 'ollama', model: 'remote:cloud' }, [], {}, fetcher)).rejects.toThrow('not installed'); expect(calls).toBe(2);
});
