import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { aiConfigSchema, customEndpoint, isLocalProvider, textSelection } from './config';
import { completeText, ContextLimitError, ollamaContextLength, textProvenance } from './text';
import { createAiSettingsApi } from '../api/ai-settings';
import { initializeOrganizer, OrganizerStore } from '../organizer/store';
import { RecordingAi } from '../organizer/recording-ai';

function database(config: object = {}, settings: Record<string, string> = {}) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE user_settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT)');
  const put = db.query('INSERT INTO user_settings(key,value) VALUES(?,?)');
  put.run('aiConfig', JSON.stringify(config));
  for (const [key, value] of Object.entries(settings)) put.run(key, value);
  return db;
}
const openAiReply = (content = '{}', model = 'reported') => Response.json({ model, choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });

test('Gemini uses generateContent with the API key header and maps roles, JSON mode and usage', async () => {
  const result = await completeText({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'synthetic-key' }, [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }, { role: 'user', content: 'Q2' }], { json: true, maxTokens: 100 }, async (url, init) => {
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('synthetic-key'); expect(init.redirect).toBe('error');
    expect(url).not.toContain('synthetic-key');
    const body = JSON.parse(String(init.body));
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Be brief.' }] });
    expect(body.contents.map((item: { role: string }) => item.role)).toEqual(['user', 'model', 'user']);
    expect(body.generationConfig).toEqual({ temperature: 0.2, maxOutputTokens: 100, responseMimeType: 'application/json' });
    return Response.json({ modelVersion: 'gemini-2.5-flash-001', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'thinking', thought: true }, { text: '{"ok":true}' }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } });
  });
  expect(result).toMatchObject({ text: '{"ok":true}', provider: 'gemini', model: 'gemini-2.5-flash-001', usage: { promptTokenCount: 7, candidatesTokenCount: 3 } });
  await expect(completeText({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'k' }, [{ role: 'user', content: 'x' }], {}, async () => Response.json({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'cut' }] } }] }))).rejects.toThrow();
});

test('custom endpoint is restricted to HTTPS or loopback, and is cloud unless loopback', () => {
  expect(customEndpoint('https://llm.example.com/v1/')).toEqual({ base: 'https://llm.example.com/v1', loopback: false });
  expect(customEndpoint('http://127.0.0.1:8080/v1')).toEqual({ base: 'http://127.0.0.1:8080/v1', loopback: true });
  expect(customEndpoint('http://localhost:1234')).toMatchObject({ loopback: true });
  for (const bad of ['http://llm.example.com/v1', 'https://user:pass@llm.example.com', 'https://llm.example.com/v1?key=x', 'ftp://127.0.0.1', 'not a url', 'http://127.0.0.1.example.com/v1'])
    expect(() => customEndpoint(bad)).toThrow();
  expect(isLocalProvider({ customBaseUrl: 'http://127.0.0.1:8080/v1' }, 'custom')).toBe(true);
  expect(isLocalProvider({ customBaseUrl: 'https://llm.example.com' }, 'custom')).toBe(false);
  expect(aiConfigSchema.safeParse({ customBaseUrl: 'http://llm.example.com' }).success).toBe(false);
});

test('custom endpoint requires a model, sends the key only when set, and does not assume JSON mode', async () => {
  const noModel = database({ chatProvider: 'custom', customBaseUrl: 'http://127.0.0.1:8080/v1' });
  expect(() => textSelection(noModel, 'chat')).toThrow('model name');
  const db = database({ chatProvider: 'custom', chatModel: 'my-model', customBaseUrl: 'http://127.0.0.1:8080/v1', privacyMode: 'local-only' });
  const selection = textSelection(db, 'chat');
  expect(selection).toMatchObject({ provider: 'custom', model: 'my-model', baseUrl: 'http://127.0.0.1:8080/v1', apiKey: undefined });
  await completeText(selection, [{ role: 'user', content: 'hi' }], { json: true }, async (url, init) => {
    expect(url).toBe('http://127.0.0.1:8080/v1/chat/completions'); expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(String(init.body)).response_format).toBeUndefined();
    return openAiReply();
  });
  const cloud = database({ chatProvider: 'custom', chatModel: 'm', customBaseUrl: 'https://llm.example.com/v1', privacyMode: 'local-only' });
  expect(() => textSelection(cloud, 'chat')).toThrow('Local-only');
  const keyed = database({ chatProvider: 'custom', chatModel: 'm', customBaseUrl: 'https://llm.example.com/v1' }, { customApiKey: 'custom-secret' });
  const prior = process.env.CUSTOM_API_KEY; process.env.CUSTOM_API_KEY = 'environment-secret';
  expect(textSelection(keyed, 'chat').apiKey).toBe('custom-secret');
  expect(textSelection(database({ chatProvider: 'custom', chatModel: 'm', customBaseUrl: 'https://llm.example.com/v1' }), 'chat').apiKey).toBeUndefined();
  if (prior === undefined) delete process.env.CUSTOM_API_KEY; else process.env.CUSTOM_API_KEY = prior;
});

test('explicit fallbacks run in order, record who answered and never run after a cancel', async () => {
  const db = database({ documentProvider: 'openai', documentFallback: [{ provider: 'anthropic', model: '' }, { provider: 'gemini', model: '' }] }, { openaiApiKey: 'o', anthropicApiKey: 'a' });
  const selection = textSelection(db, 'document');
  expect(selection.fallbacks.map(item => item.provider)).toEqual(['anthropic']);
  expect(selection.skippedFallbacks).toEqual([{ provider: 'gemini', reason: 'Add a Gemini API key in AI settings.' }]);
  const urls: string[] = [];
  const result = await completeText(selection, [{ role: 'user', content: 'x' }], {}, async url => {
    urls.push(url);
    if (url.includes('openai')) return new Response('down', { status: 503 });
    return Response.json({ model: 'claude', stop_reason: 'end_turn', content: [{ type: 'text', text: 'answer' }], usage: { input_tokens: 1, output_tokens: 1 } });
  });
  expect(urls).toEqual(['https://api.openai.com/v1/chat/completions', 'https://api.anthropic.com/v1/messages']);
  expect(result.provider).toBe('anthropic');
  expect(textProvenance(result)).toMatchObject({ provider: 'anthropic', model: 'claude', fallbackFrom: [{ provider: 'openai', error: 'openai request failed (HTTP 503). Check AI settings.' }] });
  expect(textProvenance(result).startedAt).toBeString();
  // The ledger records the provider that actually answered.
  expect(db.query('SELECT provider, task FROM ai_spend_ledger').all()).toEqual([{ provider: 'anthropic', task: 'document' }]);
  const controller = new AbortController(); let calls = 0;
  await expect(completeText(selection, [{ role: 'user', content: 'x' }], { signal: controller.signal }, async () => { calls++; controller.abort(); return new Response('x', { status: 500 }); })).rejects.toThrow();
  expect(calls).toBe(1);
  await expect(completeText(selection, [{ role: 'user', content: 'x' }], {}, async () => new Response('x', { status: 500 }))).rejects.toThrow('Every configured provider failed');
});

test('local-only mode refuses cloud fallbacks and settings reject them', async () => {
  const db = database({ privacyMode: 'local-only', chatProvider: 'ollama', chatModel: 'llama3', chatFallback: [{ provider: 'openai', model: '' }] }, { openaiApiKey: 'o' });
  const selection = textSelection(db, 'chat');
  expect(selection.fallbacks).toEqual([]); expect(selection.skippedFallbacks[0].reason).toContain('Local-only');
  const api = createAiSettingsApi(database());
  const response = await api.request('/', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...aiConfigSchema.parse({}), privacyMode: 'local-only', transcriptionEngine: 'whisper', analysisProvider: 'ollama', documentProvider: 'ollama', chatProvider: 'ollama', chatFallback: [{ provider: 'gemini', model: '' }] }) });
  expect(response.status).toBe(400);
});

test('Ollama context is read from /api/show; an oversized transcript is refused and never sent to a cloud fallback', async () => {
  const calls: string[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push(url);
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'small:latest' }] });
    if (url.endsWith('/api/show')) { expect(JSON.parse(String(init.body))).toEqual({ model: 'small:latest' }); return Response.json({ model_info: { 'general.architecture': 'llama', 'llama.context_length': 2048 } }); }
    if (url.endsWith('/api/chat')) { expect(JSON.parse(String(init.body)).options.num_ctx).toBe(2048); return Response.json({ done: true, done_reason: 'stop', message: { content: 'ok' }, prompt_eval_count: 3, eval_count: 1 }); }
    return openAiReply();
  };
  expect(await ollamaContextLength('small:latest', fetcher)).toBe(2048);
  const ollama = { provider: 'ollama' as const, model: 'small:latest', fallbacks: [{ provider: 'openai' as const, model: 'gpt-4.1-mini', apiKey: 'k' }] };
  expect((await completeText(ollama, [{ role: 'user', content: 'short' }], { maxTokens: 100 }, fetcher)).text).toBe('ok');
  calls.length = 0;
  const error = await completeText(ollama, [{ role: 'user', content: 'x'.repeat(20000) }], {}, fetcher).catch(e => e);
  expect(error).toBeInstanceOf(ContextLimitError); expect(error.message).toContain('approximate');
  expect(calls.some(url => url.includes('openai') || url.endsWith('/api/chat'))).toBe(false);
  expect(await ollamaContextLength('x', async () => Response.json({ model_info: {} }))).toBeNull();
});

test('settings expose capabilities, pricing and spend, and check Gemini and custom endpoints with the right headers', async () => {
  const db = database({ customBaseUrl: 'https://llm.example.com/v1' }, { geminiApiKey: 'g-key', customApiKey: 'c-key' });
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const api = createAiSettingsApi(db, (async (url: string, init: RequestInit) => { seen.push({ url, headers: init.headers as Record<string, string> }); return Response.json({ data: [{ id: 'test-model' }] }); }) as typeof fetch);
  const settings = await (await api.request('/')).json();
  expect(settings.data.pricing.pricesAsOf).toMatch(/^\d{4}-/); expect(settings.data.textCapabilities.custom).toEqual({ defaultModel: null, local: false, requiresKey: false });
  expect(settings.data.capabilities.mistral.languages['voxtral-mini-latest']).toContain('fr');
  expect(JSON.stringify(settings)).not.toContain('g-key');
  expect((await api.request('/check/gemini', { method: 'POST' })).status).toBe(200);
  expect((await api.request('/check/custom', { method: 'POST' })).status).toBe(200);
  expect(seen).toEqual([{ url: 'https://generativelanguage.googleapis.com/v1beta/models', headers: { 'x-goog-api-key': 'g-key' } }, { url: 'https://llm.example.com/v1/models', headers: { Authorization: 'Bearer c-key' } }]);
  const spending = await (await api.request('/spending')).json();
  expect(spending.data).toMatchObject({ estimatedUsd: 0, currency: 'USD', budgetUsd: null });
  const bad = await api.request('/', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...aiConfigSchema.parse({}), customBaseUrl: 'http://llm.example.com' }) });
  expect(bad.status).toBe(400); expect((await bad.json()).error).toContain('HTTPS');
});

test('recording chat reads keys from shared AI settings, not a private Mistral lookup', async () => {
  const db = new Database(':memory:'); initializeOrganizer(db);
  db.exec(`CREATE TABLE user_settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT);
    CREATE TABLE recordings(id TEXT,original_filename TEXT,recorded_at TEXT,source_provider TEXT,retention_state TEXT);
    CREATE TABLE transcripts(recording_id TEXT,current_version_id TEXT,full_text TEXT,origin TEXT,segments TEXT);
    CREATE TABLE transcript_versions(id TEXT,recording_id TEXT,full_text TEXT,origin TEXT);`);
  db.query('INSERT INTO user_settings(key,value) VALUES(?,?)').run('aiConfig', JSON.stringify({ chatProvider: 'openai' }));
  db.query('INSERT INTO user_settings(key,value) VALUES(?,?)').run('openaiApiKey', 'shared-openai-key');
  const recordingId = crypto.randomUUID();
  db.query('INSERT INTO recordings VALUES(?,?,?,?,?)').run(recordingId, 'Test', '2026-09-07', 'plaud', 'active');
  db.query('INSERT INTO transcripts VALUES(?,?,?,?,?)').run(recordingId, crypto.randomUUID(), 'Keep the audio.', 'generated', null);
  let auth = '';
  const ai = new RecordingAi(new OrganizerStore(db), (async (_url: string, init: RequestInit) => { auth = (init.headers as Record<string, string>).Authorization; return openAiReply(JSON.stringify({ answer: 'Keep it. [S1]', citations: [{ sourceId: 'S1', quote: 'Keep the audio.' }] }), 'gpt'); }) as typeof fetch);
  const answer = await ai.ask({ id: crypto.randomUUID(), conversationId: crypto.randomUUID(), recordingIds: [recordingId], question: 'What?', consent: true }, async () => {});
  expect(auth).toBe('Bearer shared-openai-key'); expect(answer).toMatchObject({ provider: 'openai', fallbackFrom: [] }); expect(answer.completedAt).toBeString();
  db.close();
});
