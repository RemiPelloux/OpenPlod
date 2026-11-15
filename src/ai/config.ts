import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { revealSettings } from '../vault/secrets';

export const speechProviders = ['whisper', 'mistral', 'deepgram', 'openai', 'assemblyai', 'custom'] as const;
export const textProviders = ['mistral', 'openai', 'anthropic', 'ollama', 'gemini', 'custom'] as const;
export type SpeechProvider = typeof speechProviders[number];
export type TextProvider = typeof textProviders[number];
export type TextTask = 'analysis' | 'document' | 'chat';
const model = z.string().trim().max(120).regex(/^[a-zA-Z0-9_.:/-]*$/);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/**
 * The restricted custom OpenAI-compatible endpoint (AI-14). HTTPS is required
 * except on loopback; credentials, query strings and fragments are refused so a
 * pasted URL can never smuggle secrets or parameters. Returns the normalised
 * base URL and whether it stays on this computer.
 */
export function customEndpoint(value: string): { base: string; loopback: boolean } {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Enter a valid custom endpoint URL.'); }
  const loopback = LOOPBACK.has(url.hostname) || /^127(\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('Custom endpoints must use HTTPS unless they run on this computer (loopback).');
  if (url.username || url.password || url.search || url.hash) throw new Error('Custom endpoint URLs cannot contain credentials, query strings or fragments.');
  return { base: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, loopback };
}
export function sameCustomEndpoint(left: string, right: string): boolean {
  if (!left || !right) return left === right;
  return customEndpoint(left).base === customEndpoint(right).base;
}
const fallbackEntry = z.object({ provider: z.enum(textProviders), model: model.default('') }).strict();
const usd = z.number().finite().min(0).max(100000).nullable().default(null);
export const aiConfigSchema = z.object({
  privacyMode: z.enum(['selected-providers', 'local-only']).default('selected-providers'),
  transcriptionEngine: z.enum(speechProviders).default('whisper'),
  transcriptionModel: model.default(''),
  transcriptionLanguage: z.string().regex(/^(auto|[a-z]{2,3}(-[A-Z]{2})?)$/).default('auto'),
  transcriptionDiarize: z.boolean().default(false),
  transcriptionVocabulary: z.array(z.string().trim().min(1).max(80)).max(100).default([]),
  transcriptionFallback: z.array(z.enum(speechProviders).exclude(['custom'])).max(4).default([]),
  /** One-off context prompt for providers that accept one (see capabilities.prompt). */
  transcriptionPrompt: z.string().trim().max(2000).default(''),
  /** Default transcription profile id, or '' for none. */
  transcriptionProfile: z.string().regex(/^[a-zA-Z0-9-]{0,64}$/).default(''),
  analysisProvider: z.enum(textProviders).default('mistral'), analysisModel: model.default(''),
  documentProvider: z.enum(textProviders).default('mistral'), documentModel: model.default(''),
  chatProvider: z.enum(textProviders).default('mistral'), chatModel: model.default(''),
  /** Explicit, ordered fallbacks per text task (AI-07). Empty means no fallback. */
  analysisFallback: z.array(fallbackEntry).max(3).default([]),
  documentFallback: z.array(fallbackEntry).max(3).default([]),
  chatFallback: z.array(fallbackEntry).max(3).default([]),
  /** Base URL of a restricted OpenAI-compatible endpoint (provider `custom`), or ''. */
  customBaseUrl: z.string().trim().max(300).refine(value => { if (!value) return true; try { customEndpoint(value); return true; } catch { return false; } }, 'Invalid custom endpoint URL.').default(''),
  /** Monthly cloud budget in USD, compared against OpenPlod's own estimates. Providers do not enforce it. */
  monthlyBudgetUsd: usd,
  /** Ask before any single job whose estimate exceeds this many USD. */
  confirmAboveUsd: usd,
  /** Split audio longer than this many minutes into chunks (0: only when a provider's size limit requires it). */
  transcriptionChunkAboveMinutes: z.number().int().min(0).max(1440).default(0),
}).strict();
export type AiConfig = z.infer<typeof aiConfigSchema>;
export const secretNames = ['mistralApiKey', 'deepgramApiKey', 'openaiApiKey', 'assemblyaiApiKey', 'anthropicApiKey', 'geminiApiKey', 'customApiKey'] as const;
export const aiSettingsInput = aiConfigSchema.extend({
  credentials: z.object(Object.fromEntries(secretNames.map(name => [name, z.string().trim().max(512).regex(/^[^\r\n]*$/).optional()]))).strict().optional(),
});
export function readSettings(database: Database): Record<string, string> {
  if (!database.query("SELECT name FROM sqlite_master WHERE type='table' AND name='user_settings'").get()) return {};
  // Secret values are encrypted at rest (REL-06); callers always receive plaintext.
  return revealSettings(Object.fromEntries((database.query('SELECT key,value FROM user_settings').all() as {key: string; value: string}[]).map(row => [row.key, row.value])));
}
export function aiConfigFromSettings(values: Record<string, string>): AiConfig {
  // Legacy engine/key settings remain valid; all new routing is explicit.
  const raw = values.aiConfig ? JSON.parse(values.aiConfig) : { transcriptionEngine: values.transcriptionEngine || 'whisper' };
  if (Array.isArray(raw?.transcriptionFallback)) {
    raw.transcriptionFallback = raw.transcriptionFallback.filter((provider: unknown) => provider !== 'custom');
  }
  return aiConfigSchema.parse(raw);
}
export function readAiConfig(database: Database): AiConfig {
  return aiConfigFromSettings(readSettings(database));
}
export function credential(database: Database, provider: string): string | undefined {
  const values = readSettings(database);
  // A custom endpoint never inherits an environment variable: its key goes only where the user typed it.
  return values[`${provider}ApiKey`] || (provider === 'custom' ? undefined : process.env[`${provider.toUpperCase()}_API_KEY`]);
}
/** Whether a provider keeps data on this computer. A custom endpoint is cloud unless it is loopback. */
export function isLocalProvider(config: Pick<AiConfig, 'customBaseUrl'>, provider: string): boolean {
  if (provider === 'whisper' || provider === 'ollama') return true;
  if (provider !== 'custom' || !config.customBaseUrl) return false;
  try { return customEndpoint(config.customBaseUrl).loopback; } catch { return false; }
}
export function assertPrivacy(config: Pick<AiConfig, 'privacyMode' | 'customBaseUrl'>, provider: string): void {
  if (config.privacyMode === 'local-only' && !isLocalProvider(config, provider))
    throw new Error('Local-only mode blocks this provider. Change AI settings before sending data.');
}
export const textModels: Record<TextProvider, string> = {
  mistral: 'mistral-small-latest', openai: 'gpt-4.1-mini', anthropic: 'claude-sonnet-4-5', ollama: '', gemini: 'gemini-2.5-flash', custom: '',
};
/** One provider a text task may use, with the privacy check repeated immediately before sending. */
export type ResolvedTextSelection = { provider: TextProvider; model: string; apiKey?: string; baseUrl?: string; beforeSend: () => void };
const providerLabel = (provider: TextProvider) => ({ mistral: 'Mistral', openai: 'OpenAI', anthropic: 'Anthropic', ollama: 'Ollama', gemini: 'Gemini', custom: 'custom endpoint' })[provider];
function resolveText(database: Database, config: AiConfig, provider: TextProvider, chosenModel: string, legacyKey?: () => string | undefined): ResolvedTextSelection {
  assertPrivacy(config, provider);
  const selectedModel = chosenModel || textModels[provider];
  if (!selectedModel) throw new Error(provider === 'ollama' ? 'Select an installed Ollama model in AI settings.' : 'Enter the model name for the custom endpoint in AI settings.');
  const apiKey = legacyKey && provider === 'mistral' ? legacyKey() || credential(database, provider) : credential(database, provider);
  let baseUrl: string | undefined;
  if (provider === 'custom') {
    if (!config.customBaseUrl) throw new Error('Enter the custom endpoint URL in AI settings.');
    baseUrl = customEndpoint(config.customBaseUrl).base;
  } else if (provider !== 'ollama' && !apiKey) throw new Error(`Add a ${providerLabel(provider)} API key in AI settings.`);
  return { provider, model: selectedModel, apiKey, ...(baseUrl ? { baseUrl } : {}), beforeSend: () => assertPrivacy(readAiConfig(database), provider) };
}
/**
 * The provider for a text task, plus its explicit fallbacks (AI-07). The primary
 * must be usable or this throws; a fallback that is blocked by local-only mode or
 * unconfigured is skipped and listed in `skippedFallbacks`, never silently used.
 */
export function textSelection(database: Database, task: TextTask, legacyKey?: () => string | undefined) {
  const config = readAiConfig(database);
  const primary = resolveText(database, config, config[`${task}Provider`], config[`${task}Model`], legacyKey);
  const fallbacks: ResolvedTextSelection[] = [], skippedFallbacks: { provider: TextProvider; reason: string }[] = [];
  for (const entry of config[`${task}Fallback`]) {
    if (entry.provider === primary.provider && (entry.model || textModels[entry.provider]) === primary.model) continue;
    try { fallbacks.push(resolveText(database, config, entry.provider, entry.model, legacyKey)); }
    catch (error) { skippedFallbacks.push({ provider: entry.provider, reason: (error as Error).message }); }
  }
  return { ...primary, task, fallbacks, skippedFallbacks, ledger: { database, task } };
}
