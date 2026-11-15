import { Hono } from 'hono';
import { protectSetting } from '../vault/secrets';
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import { aiSettingsInput, aiConfigSchema, readAiConfig, credential, secretNames, assertPrivacy, textProviders, textModels, customEndpoint, isLocalProvider, sameCustomEndpoint } from '../ai/config';
import { speechCapabilities } from '../ai/capabilities';
import { validateEffective } from '../ai/transcription-profiles';
import { installedOllamaModels, ollamaContextLength } from '../ai/text';
import { PRICE_LABEL, PRICES_AS_OF, speechPrices, textPrices } from '../ai/pricing';
import { estimateRecordings, monthToDate } from '../ai/spending';

const estimateSchema = z.object({ recordingIds: z.array(z.string().uuid()).min(1).max(500), overrides: z.record(z.string().regex(/^transcription/), z.unknown()).optional() }).strict();
export function createAiSettingsApi(database: Database, fetcher: typeof fetch = fetch) {
  const app = new Hono();
  app.get('/', c => {
    const config = readAiConfig(database);
    return c.json({ success: true, data: { ...config, credentials: Object.fromEntries(secretNames.map(key => [key, Boolean(credential(database, key.replace('ApiKey', '')))])), capabilities: { ...speechCapabilities, custom: { ...speechCapabilities.custom, local: isLocalProvider(config, 'custom'), models: config.transcriptionEngine === 'custom' && config.transcriptionModel ? [config.transcriptionModel] : [] } },
      textCapabilities: Object.fromEntries(textProviders.map(provider => [provider, { defaultModel: textModels[provider] || null, local: isLocalProvider(config, provider), requiresKey: !['ollama', 'custom'].includes(provider) }])),
      pricing: { pricesAsOf: PRICES_AS_OF, label: PRICE_LABEL, speech: speechPrices, text: textPrices } } });
  });
  app.put('/', async c => {
    const input = aiSettingsInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ success: false, error: input.error.issues.some(issue => issue.path[0] === 'customBaseUrl') ? 'Custom endpoints must use HTTPS (or loopback HTTP) without credentials, query or fragment.' : 'Invalid AI settings.' }, 400);
    const { credentials, ...config } = input.data;
    try {
      assertPrivacy(config, config.transcriptionEngine);
      for (const provider of config.transcriptionFallback) assertPrivacy(config, provider);
      for (const task of ['analysis', 'document', 'chat'] as const) {
        assertPrivacy(config, config[`${task}Provider`]);
        for (const entry of config[`${task}Fallback`]) assertPrivacy(config, entry.provider);
      }
      assertPrivacy(config, validateEffective(database, config).config.transcriptionEngine);
    } catch (error) { return c.json({ success: false, error: (error as Error).message }, 400); }
    database.transaction(() => {
      const put = database.query("INSERT INTO user_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')");
      if (!sameCustomEndpoint(config.customBaseUrl, readAiConfig(database).customBaseUrl) && credentials?.customApiKey === undefined) {
        database.query("DELETE FROM user_settings WHERE key='customApiKey'").run();
      }
      put.run('aiConfig', JSON.stringify(config)); put.run('transcriptionEngine', config.transcriptionEngine);
      for (const [key, value] of Object.entries(credentials || {})) if (typeof value === 'string') put.run(key, protectSetting(key, value));
    })();
    return c.json({ success: true });
  });
  app.get('/ollama-models', async c => {
    try { return c.json({ success: true, data: await installedOllamaModels(fetcher) }); }
    catch { return c.json({ success: false, error: 'Local Ollama is unavailable. Start Ollama on this computer.' }, 503); }
  });
  /** A local model's context window (AI-13). `null` means Ollama did not report one. */
  app.get('/ollama-context', async c => {
    const model = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_.:/-]+$/).safeParse(c.req.query('model'));
    if (!model.success) return c.json({ success: false, error: 'Choose an installed Ollama model.' }, 400);
    try {
      if (!(await installedOllamaModels(fetcher)).includes(model.data)) return c.json({ success: false, error: 'That Ollama model is not installed locally.' }, 404);
      return c.json({ success: true, data: { model: model.data, contextLength: await ollamaContextLength(model.data, fetcher) } });
    } catch { return c.json({ success: false, error: 'Local Ollama is unavailable. Start Ollama on this computer.' }, 503); }
  });
  /** Month-to-date estimated cloud spend (AI-10). Estimates only; providers do not enforce the budget. */
  app.get('/spending', c => c.json({ success: true, data: monthToDate(database) }));
  /** Cost estimate for transcribing recordings with the current settings plus optional per-job overrides. */
  app.post('/estimate', async c => {
    const input = estimateSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ success: false, error: 'Select recordings to estimate.' }, 400);
    const config = aiConfigSchema.safeParse({ ...readAiConfig(database), ...input.data.overrides });
    if (!config.success) return c.json({ success: false, error: 'Invalid transcription options.' }, 400);
    try { return c.json({ success: true, data: estimateRecordings(database, input.data.recordingIds, config.data) }); }
    catch (error) { return c.json({ success: false, error: (error as Error).message }, 400); }
  });
  app.post('/check/:provider', async c => {
    const provider = z.enum([...textProviders, 'deepgram', 'assemblyai']).safeParse(c.req.param('provider'));
    if (!provider.success) return c.json({ success: false, error: 'Unknown provider.' }, 400);
    try {
      let config = readAiConfig(database);
      const savedBaseUrl = config.customBaseUrl;
      let draftKey: string | undefined;
      if (provider.data === 'custom') {
        const raw = await c.req.text();
        if (raw) {
          const draft = z.object({ customBaseUrl: aiConfigSchema.shape.customBaseUrl, apiKey: z.string().max(512).regex(/^[^\r\n]*$/).optional() }).strict().safeParse(JSON.parse(raw));
          if (!draft.success) return c.json({ success: false, error: 'Invalid custom endpoint.' }, 400);
          config = { ...config, customBaseUrl: draft.data.customBaseUrl }; draftKey = draft.data.apiKey;
        }
      }
      assertPrivacy(config, provider.data);
      if (provider.data === 'ollama') return c.json({ success: true, data: { reachable: true, models: await installedOllamaModels(fetcher) } });
      const canUseSavedKey = provider.data !== 'custom' || sameCustomEndpoint(config.customBaseUrl, savedBaseUrl);
      const key = draftKey ?? (canUseSavedKey ? credential(database, provider.data) : undefined);
      let url: string, headers: Record<string, string>;
      if (provider.data === 'custom') {
        if (!config.customBaseUrl) return c.json({ success: false, error: 'Custom endpoint URL is not configured.' }, 400);
        url = `${customEndpoint(config.customBaseUrl).base}/models`; headers = key ? { Authorization: `Bearer ${key}` } : {};
      } else {
        if (!key) return c.json({ success: false, error: 'API key is not configured.' }, 400);
        const urls = { mistral: 'https://api.mistral.ai/v1/models', openai: 'https://api.openai.com/v1/models', anthropic: 'https://api.anthropic.com/v1/models', deepgram: 'https://api.deepgram.com/v1/projects', assemblyai: 'https://api.assemblyai.com/v2/transcript?limit=1', gemini: 'https://generativelanguage.googleapis.com/v1beta/models' };
        url = urls[provider.data];
        headers = provider.data === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : provider.data === 'gemini' ? { 'x-goog-api-key': key } : { Authorization: provider.data === 'assemblyai' ? key : `${provider.data === 'deepgram' ? 'Token' : 'Bearer'} ${key}` };
      }
      const response = await fetcher(url, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (provider.data === 'custom' && response.ok) {
        const payload = z.object({ data: z.array(z.object({ id: z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.:/-]+$/) })) }).parse(await response.json());
        return c.json({ success: true, data: { reachable: true, models: [...new Set(payload.data.map(model => model.id))].sort() } });
      }
      await response.body?.cancel();
      return c.json({ success: response.ok, data: { reachable: response.ok, status: response.status }, ...(!response.ok ? { error: `Provider returned HTTP ${response.status}.` } : {}) });
    } catch { return c.json({ success: false, error: 'Provider unavailable or blocked by local-only mode.' }, 503); }
  });
  return app;
}
