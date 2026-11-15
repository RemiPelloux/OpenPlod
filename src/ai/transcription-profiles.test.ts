import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { aiConfigSchema, readAiConfig } from './config';
import { effectiveTranscription, PROFILE_PRESETS, TranscriptionProfiles } from './transcription-profiles';
import { createTranscriptionProfilesApi } from '../api/transcription-profiles';
import { createAiSettingsApi } from '../api/ai-settings';
import { createOnboardingApi } from '../api/onboarding';
import { whisperPrompt } from '../transcription/whisper';
import { OpenAiEngine } from '../transcription/openai';
import { DeepgramEngine } from '../transcription/deepgram';

let db: Database, profiles: TranscriptionProfiles;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec("CREATE TABLE user_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
  profiles = new TranscriptionProfiles(db);
});
afterEach(() => db.close());
const config = (input: Record<string, unknown> = {}) => aiConfigSchema.parse(input);
const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('Transcription profiles', () => {
  test('presets are copied, names stay unique, and invalid combinations are refused', () => {
    const first = profiles.create({ preset: 'engineering' });
    expect(first).toMatchObject({ name: 'Engineering standup', engine: null, diarize: true, vocabulary: expect.arrayContaining(['Kubernetes']) });
    expect(profiles.create({ preset: 'engineering' }).name).toBe('Engineering standup (2)');
    expect(() => profiles.create({ name: 'engineering STANDUP' })).toThrow('already exists');
    expect(() => profiles.create({ name: 'Voxtral prompt', engine: 'mistral', prompt: 'Context' })).toThrow('context prompt');
    expect(() => profiles.create({ name: 'Model only', model: 'whisper-1' })).toThrow('provider');
    expect(() => profiles.create({ preset: 'unknown' })).toThrow('Unknown profile preset');
    const custom = profiles.create({ name: 'Board', engine: 'openai', model: 'gpt-4o-transcribe', prompt: 'Board meeting', vocabulary: ['OpenPlod', 'openplod', 'Voxtral'] });
    expect(custom.vocabulary).toEqual(['openplod', 'Voxtral']);
    // Switching provider drops the model chosen for the previous one.
    expect(profiles.update(custom.id, { engine: 'whisper' })).toMatchObject({ engine: 'whisper', model: null });
    expect(PROFILE_PRESETS.every(preset => preset.prompt.length <= 1000)).toBe(true);
  });

  test('a generic profile drops hints the provider cannot take and says so', () => {
    const meeting = profiles.create({ preset: 'meeting' });
    const onMistral = effectiveTranscription(db, config({ transcriptionEngine: 'mistral', transcriptionProfile: meeting.id }));
    expect(onMistral.options).toEqual({ model: undefined, language: 'auto', diarize: false, vocabulary: [] });
    expect(onMistral.ignored).toEqual(['prompt', 'speaker labels']);
    expect(onMistral.profile).toEqual({ id: meeting.id, name: 'Team meeting' });

    const onOpenAi = effectiveTranscription(db, config({ transcriptionEngine: 'openai', transcriptionPrompt: 'Quarterly review.', transcriptionVocabulary: ['Plaud'], transcriptionProfile: meeting.id }));
    expect(onOpenAi.options.prompt).toBe(`Quarterly review.\n${meeting.prompt}`);
    expect(onOpenAi.options.diarize).toBe(false);
    expect(onOpenAi.ignored).toEqual(['speaker labels']);
    expect(effectiveTranscription(db, config({ transcriptionEngine: 'assemblyai', transcriptionProfile: meeting.id })).options.diarize).toBe(true);
  });

  test('custom diarization records omitted hints and preserves them when diarization is off', () => {
    const profile = profiles.create({ name: 'French meeting', language: 'fr', prompt: 'Meeting context', vocabulary: ['OpenPlod'] });
    const settings = config({
      transcriptionEngine: 'custom', transcriptionModel: 'VibeVoice-ASR', transcriptionProfile: profile.id,
      transcriptionDiarize: true, transcriptionPrompt: 'Agenda', transcriptionVocabulary: ['PLAUD'],
    });
    const diarized = effectiveTranscription(db, settings);
    expect(diarized.options).toEqual({ model: 'VibeVoice-ASR', language: 'fr', diarize: true, vocabulary: [] });
    expect(diarized.ignored).toEqual(['vocabulary', 'prompt']);

    const plain = effectiveTranscription(db, { ...settings, transcriptionDiarize: false });
    expect(plain.options).toMatchObject({ prompt: 'Agenda\nMeeting context', vocabulary: ['PLAUD', 'OpenPlod'] });
    expect(plain.ignored).toEqual([]);
  });

  test('a provider-specific profile selects its engine, model, language, and vocabulary', () => {
    const french = profiles.create({ name: 'Cours', engine: 'whisper', model: 'medium', language: 'fr', prompt: 'Cours de droit.', vocabulary: ['Conseil d’État'] });
    const resolved = effectiveTranscription(db, config({ transcriptionEngine: 'openai', transcriptionModel: 'whisper-1', transcriptionVocabulary: ['Plaud'], transcriptionProfile: french.id }));
    expect(resolved.config).toMatchObject({ transcriptionEngine: 'whisper', transcriptionModel: 'medium', transcriptionLanguage: 'fr' });
    expect(resolved.options).toMatchObject({ model: 'medium', language: 'fr', vocabulary: ['Plaud', 'Conseil d’État'], prompt: 'Cours de droit.' });
    expect(whisperPrompt(resolved.options)).toEqual(['--prompt', 'Cours de droit. Glossary: Plaud, Conseil d’État.']);
    expect(whisperPrompt({})).toEqual([]);
    expect(() => effectiveTranscription(db, config({ transcriptionProfile: crypto.randomUUID() }))).toThrow('no longer exists');
  });

  test('deleting the default profile clears it, and settings refuse unusable profiles and prompts', async () => {
    const settings = createAiSettingsApi(db);
    const put = (body: unknown) => settings.request('/', { ...json(body), method: 'PUT' });
    const legal = profiles.create({ preset: 'legal' });
    expect((await put({ ...config(), transcriptionProfile: legal.id })).status).toBe(200);
    expect(readAiConfig(db).transcriptionProfile).toBe(legal.id);
    expect((await put({ ...config(), transcriptionProfile: crypto.randomUUID() })).status).toBe(400);
    const refused = await put({ ...config(), transcriptionEngine: 'mistral', transcriptionPrompt: 'Context' });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain('context prompt');
    profiles.delete(legal.id);
    expect(readAiConfig(db).transcriptionProfile).toBe('');
  });

  test('HTTP contract', async () => {
    const api = createTranscriptionProfilesApi(db);
    const created = await api.request('/', json({ preset: 'lecture', name: 'Physics 101' }));
    expect(created.status).toBe(201);
    const { data } = await created.json() as { data: { id: string } };
    expect((await api.request('/', json({ name: 'physics 101' }))).status).toBe(409);
    expect((await api.request('/', json({ name: 'Bad', engine: 'deepgram', unknown: true }))).status).toBe(400);
    const listed = await (await api.request('/')).json() as { data: { profiles: unknown[]; presets: unknown[] } };
    expect(listed.data.profiles).toHaveLength(1);
    expect(listed.data.presets).toHaveLength(PROFILE_PRESETS.length);
    expect((await api.request(`/${data.id}`, { ...json({ prompt: 'Thermodynamics' }), method: 'PATCH' })).status).toBe(200);
    expect(profiles.get(data.id).prompt).toBe('Thermodynamics');
    expect((await api.request(`/${data.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await api.request(`/${data.id}`)).status).toBe(404);
  });
});

describe('Provider prompts', () => {
  test('OpenAI sends the context prompt followed by vocabulary', async () => {
    let prompt: unknown = null;
    const engine = new OpenAiEngine('synthetic-key', (async (_url: string, init: RequestInit) => {
      prompt = (init.body as FormData).get('prompt');
      return Response.json({ text: 'ok', segments: [{ start: 0, end: 1, text: 'ok' }] });
    }) as typeof fetch);
    expect((await engine.transcribeBuffer(Buffer.from('audio'), 'audio/wav', { prompt: 'Board meeting.', vocabulary: ['OpenPlod', 'Voxtral'] })).success).toBe(true);
    expect(prompt).toBe('Board meeting.\nOpenPlod, Voxtral');
  });

  test('Deepgram sends keywords on nova-2 and key terms on nova-3', async () => {
    const urls: string[] = [], original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => { urls.push(url); return Response.json({ results: { channels: [{ alternatives: [{ transcript: 'ok', words: [] }] }] }, metadata: { duration: 1 } }); }) as typeof fetch;
    try {
      const engine = new DeepgramEngine('synthetic-key');
      await engine.transcribeBuffer(Buffer.from('audio'), 'audio/wav', { vocabulary: ['OpenPlod'], diarize: true });
      await engine.transcribeBuffer(Buffer.from('audio'), 'audio/wav', { model: 'nova-3', vocabulary: ['OpenPlod'] });
    } finally { globalThis.fetch = original; }
    expect(new URL(urls[0]!).searchParams.getAll('keywords')).toEqual(['OpenPlod']);
    expect(new URL(urls[0]!).searchParams.get('diarize')).toBe('true');
    expect(new URL(urls[1]!).searchParams.getAll('keyterm')).toEqual(['OpenPlod']);
  });
});

describe('Onboarding', () => {
  test('reports setup state, completes, and resets without touching AI settings', async () => {
    db.exec("CREATE TABLE recordings(id TEXT PRIMARY KEY, retention_state TEXT NOT NULL DEFAULT 'active'); INSERT INTO recordings VALUES ('a','active'),('b','trash')");
    const api = createOnboardingApi(db, () => ({ whisper: false }));
    const status = async () => ((await (await api.request('/')).json()) as { data: Record<string, unknown> }).data;
    expect(await status()).toMatchObject({ completedAt: null, skipped: false, engine: 'whisper', engineLabel: 'Whisper.cpp', engineReady: false, recordings: 1, documents: 0, profiles: 0 });
    expect((await api.request('/complete', json({ skipped: 'yes' }))).status).toBe(400);
    expect((await api.request('/complete', json({ skipped: true }))).status).toBe(200);
    expect(await status()).toMatchObject({ completedAt: expect.any(String), skipped: true });
    expect((await api.request('/reset', json({}))).status).toBe(200);
    expect((await status()).completedAt).toBeNull();
    expect(db.query("SELECT count(*) AS n FROM user_settings WHERE key='aiConfig'").get()).toEqual({ n: 0 });
  });
});
