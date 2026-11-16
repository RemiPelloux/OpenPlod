import type { SpeechProvider, TextProvider } from './config';

/**
 * Documented list prices used for spending *estimates* (AI-10).
 *
 * These are public pay-as-you-go list prices as documented by each provider
 * around `PRICES_AS_OF`. They are never a bill: discounts, free tiers, add-ons,
 * taxes, minimum charges and later price changes are not modelled, and no
 * provider enforces OpenPlod's budget. A `null` price means OpenPlod is not
 * confident of the current list price, so the estimate is unknown rather than
 * guessed. Update the table and date together.
 */
export const PRICES_AS_OF = '2025-08-01';
export const PRICE_LABEL = 'Estimate from documented list prices; not a bill, and not enforced by the provider.';
export type SpeechPrice = { usdPerMinute: number | null; note?: string };
export type TextPrice = { usdPerMillionInput: number; usdPerMillionOutput: number } | null;

export const speechPrices: Record<SpeechProvider, Record<string, SpeechPrice>> = {
  whisper: { base: { usdPerMinute: 0, note: 'Runs on this computer.' }, small: { usdPerMinute: 0, note: 'Runs on this computer.' }, medium: { usdPerMinute: 0, note: 'Runs on this computer.' },
    'large-v3-turbo': { usdPerMinute: 0, note: 'Runs on this computer.' }, 'large-v3': { usdPerMinute: 0, note: 'Runs on this computer.' } },
  mistral: { 'voxtral-mini-latest': { usdPerMinute: 0.001 } },
  deepgram: { 'nova-2': { usdPerMinute: null, note: 'Plan- and add-on-dependent; not estimated.' }, 'nova-3': { usdPerMinute: null, note: 'Plan- and add-on-dependent; not estimated.' } },
  openai: { 'whisper-1': { usdPerMinute: 0.006 }, 'gpt-4o-transcribe': { usdPerMinute: 0.006, note: 'OpenAI documents this as an estimated per-minute cost of token billing.' }, 'gpt-4o-mini-transcribe': { usdPerMinute: 0.003, note: 'OpenAI documents this as an estimated per-minute cost of token billing.' } },
  assemblyai: { 'universal-2': { usdPerMinute: null, note: 'Tier- and add-on-dependent; not estimated.' } },
};

/** USD per million tokens. Models not listed (and every `null`) have an unknown price. */
export const textPrices: Record<TextProvider, Record<string, TextPrice>> = {
  mistral: { 'mistral-small-latest': null },
  openai: { 'gpt-4.1-mini': { usdPerMillionInput: 0.4, usdPerMillionOutput: 1.6 }, 'gpt-4.1': { usdPerMillionInput: 2, usdPerMillionOutput: 8 }, 'gpt-4o-mini': { usdPerMillionInput: 0.15, usdPerMillionOutput: 0.6 } },
  anthropic: { 'claude-sonnet-4-5': { usdPerMillionInput: 3, usdPerMillionOutput: 15 }, 'claude-haiku-4-5': { usdPerMillionInput: 1, usdPerMillionOutput: 5 } },
  gemini: { 'gemini-2.5-flash': { usdPerMillionInput: 0.3, usdPerMillionOutput: 2.5 } },
  ollama: {},
  custom: {},
};

export function speechPrice(provider: SpeechProvider, model: string | undefined | null): SpeechPrice {
  const table = speechPrices[provider];
  return table[model || Object.keys(table)[0]] ?? { usdPerMinute: null, note: 'No documented price for this model.' };
}

/** Estimated USD for `seconds` of audio, or null when the price (or the duration) is unknown. */
export function estimateSpeechUsd(provider: SpeechProvider, model: string | undefined | null, seconds: number | null): number | null {
  if (provider === 'whisper') return 0;
  const price = speechPrice(provider, model).usdPerMinute;
  if (price === null || seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  return round(price * seconds / 60);
}

/** Token counts from a provider's reported usage, under each provider's own field names. */
export function tokenCounts(usage: Record<string, number> | null): { input: number; output: number } | null {
  if (!usage) return null;
  const input = usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount;
  const output = usage.completion_tokens ?? usage.output_tokens ?? (usage.candidatesTokenCount === undefined ? undefined : usage.candidatesTokenCount + (usage.thoughtsTokenCount ?? 0));
  return typeof input === 'number' && typeof output === 'number' ? { input, output } : null;
}

/** Estimated USD for a finished text request from its reported usage; null when price or usage is unknown. */
export function estimateTextUsd(provider: TextProvider, model: string, usage: Record<string, number> | null): number | null {
  if (provider === 'ollama') return 0;
  const price = textPrices[provider][model] ?? null, tokens = tokenCounts(usage);
  if (!price || !tokens) return null;
  return round((tokens.input * price.usdPerMillionInput + tokens.output * price.usdPerMillionOutput) / 1_000_000);
}

const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
