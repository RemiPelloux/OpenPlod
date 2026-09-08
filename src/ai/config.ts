import type { Database } from 'bun:sqlite';
import { z } from 'zod';

export const speechProviders = ['whisper', 'mistral', 'deepgram', 'openai', 'assemblyai'] as const;
export const textProviders = ['mistral', 'openai', 'anthropic', 'ollama'] as const;
export type SpeechProvider = typeof speechProviders[number];
export type TextProvider = typeof textProviders[number];
export type TextTask = 'analysis' | 'document' | 'chat';
const model = z.string().trim().max(120).regex(/^[a-zA-Z0-9_.:/-]*$/);
export const aiConfigSchema = z.object({
  privacyMode: z.enum(['selected-providers', 'local-only']).default('selected-providers'),
  transcriptionEngine: z.enum(speechProviders).default('whisper'),
  transcriptionModel: model.default(''),
  transcriptionLanguage: z.string().regex(/^(auto|[a-z]{2,3}(-[A-Z]{2})?)$/).default('auto'),
  transcriptionDiarize: z.boolean().default(false),
  transcriptionVocabulary: z.array(z.string().trim().min(1).max(80)).max(100).default([]),
  transcriptionFallback: z.array(z.enum(speechProviders)).max(4).default([]),
  analysisProvider: z.enum(textProviders).default('mistral'), analysisModel: model.default(''),
  documentProvider: z.enum(textProviders).default('mistral'), documentModel: model.default(''),
  chatProvider: z.enum(textProviders).default('mistral'), chatModel: model.default(''),
}).strict();
export type AiConfig = z.infer<typeof aiConfigSchema>;
export const secretNames = ['mistralApiKey', 'deepgramApiKey', 'openaiApiKey', 'assemblyaiApiKey', 'anthropicApiKey'] as const;
export const aiSettingsInput = aiConfigSchema.extend({
  credentials: z.object(Object.fromEntries(secretNames.map(name => [name, z.string().trim().max(512).regex(/^[^\r\n]*$/).optional()]))).strict().optional(),
});
export function readSettings(database: Database): Record<string, string> {
  if (!database.query("SELECT name FROM sqlite_master WHERE type='table' AND name='user_settings'").get()) return {};
  return Object.fromEntries((database.query('SELECT key,value FROM user_settings').all() as {key: string; value: string}[]).map(row => [row.key, row.value]));
}
export function readAiConfig(database: Database): AiConfig {
  const values = readSettings(database);
  // Legacy engine/key settings remain valid; all new routing is explicit.
  const raw = values.aiConfig ? JSON.parse(values.aiConfig) : { transcriptionEngine: values.transcriptionEngine || 'whisper' };
  return aiConfigSchema.parse(raw);
}
export function credential(database: Database, provider: string): string | undefined {
  const values = readSettings(database);
  return values[`${provider}ApiKey`] || process.env[`${provider.toUpperCase()}_API_KEY`];
}
export function assertPrivacy(config: AiConfig, provider: string): void {
  if (config.privacyMode === 'local-only' && !['whisper', 'ollama'].includes(provider))
    throw new Error('Local-only mode blocks this provider. Change AI settings before sending data.');
}
export const textModels: Record<TextProvider, string> = {
  mistral: 'mistral-small-latest', openai: 'gpt-4.1-mini', anthropic: 'claude-sonnet-4-5', ollama: '',
};
export function textSelection(database: Database, task: TextTask, legacyKey?: () => string | undefined) {
  const config = readAiConfig(database), provider = config[`${task}Provider`];
  assertPrivacy(config, provider);
  const selectedModel = config[`${task}Model`] || textModels[provider];
  if (!selectedModel) throw new Error('Select an installed Ollama model in AI settings.');
  const apiKey = legacyKey && provider === 'mistral' ? legacyKey() : credential(database, provider);
  if (provider !== 'ollama' && !apiKey) throw new Error(`Add a ${provider === 'mistral' ? 'Mistral' : provider} API key in AI settings.`);
  return { provider, model: selectedModel, apiKey, beforeSend: () => assertPrivacy(readAiConfig(database), provider) };
}
