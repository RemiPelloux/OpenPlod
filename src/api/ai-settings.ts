import { Hono } from 'hono';
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import { aiSettingsInput, readAiConfig, credential, secretNames, assertPrivacy, textProviders } from '../ai/config';
import { speechCapabilities, validateSpeechOptions } from '../ai/capabilities';
import { installedOllamaModels } from '../ai/text';

export function createAiSettingsApi(database: Database) {
  const app = new Hono();
  app.get('/', c => c.json({ success: true, data: { ...readAiConfig(database), credentials: Object.fromEntries(secretNames.map(key => [key, Boolean(credential(database, key.replace('ApiKey', '')))])), capabilities: speechCapabilities } }));
  app.put('/', async c => {
    const input = aiSettingsInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ success: false, error: 'Invalid AI settings.' }, 400);
    const { credentials, ...config } = input.data;
    try {
      assertPrivacy(config, config.transcriptionEngine);
      for (const provider of config.transcriptionFallback) assertPrivacy(config, provider);
      for (const task of ['analysis', 'document', 'chat'] as const) assertPrivacy(config, config[`${task}Provider`]);
      validateSpeechOptions(config.transcriptionEngine, { model: config.transcriptionModel, diarize: config.transcriptionDiarize, vocabulary: config.transcriptionVocabulary });
    } catch (error) { return c.json({ success: false, error: (error as Error).message }, 400); }
    database.transaction(() => {
      const put = database.query("INSERT INTO user_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')");
      put.run('aiConfig', JSON.stringify(config)); put.run('transcriptionEngine', config.transcriptionEngine);
      for (const [key, value] of Object.entries(credentials || {})) if (typeof value === 'string') put.run(key, value);
    })();
    return c.json({ success: true });
  });
  app.get('/ollama-models', async c => {
    try { return c.json({ success: true, data: await installedOllamaModels() }); }
    catch { return c.json({ success: false, error: 'Local Ollama is unavailable. Start Ollama on this Mac.' }, 503); }
  });
  app.post('/check/:provider', async c => {
    const provider = z.enum([...textProviders, 'deepgram', 'assemblyai']).safeParse(c.req.param('provider'));
    if (!provider.success) return c.json({ success: false, error: 'Unknown provider.' }, 400);
    try {
      assertPrivacy(readAiConfig(database), provider.data);
      if (provider.data === 'ollama') return c.json({ success: true, data: { reachable: true, models: await installedOllamaModels() } });
      const key = credential(database, provider.data);
      if (!key) return c.json({ success: false, error: 'API key is not configured.' }, 400);
      const urls = { mistral: 'https://api.mistral.ai/v1/models', openai: 'https://api.openai.com/v1/models', anthropic: 'https://api.anthropic.com/v1/models', deepgram: 'https://api.deepgram.com/v1/projects', assemblyai: 'https://api.assemblyai.com/v2/transcript?limit=1' };
      const headers: Record<string, string> = provider.data === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { Authorization: provider.data === 'assemblyai' ? key : `${provider.data === 'deepgram' ? 'Token' : 'Bearer'} ${key}` };
      const response = await fetch(urls[provider.data], { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
      await response.body?.cancel();
      return c.json({ success: response.ok, data: { reachable: response.ok, status: response.status }, ...(!response.ok ? { error: `Provider returned HTTP ${response.status}.` } : {}) });
    } catch { return c.json({ success: false, error: 'Provider unavailable or blocked by local-only mode.' }, 503); }
  });
  return app;
}
