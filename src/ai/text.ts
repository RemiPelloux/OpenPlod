import { z } from 'zod';
import type { TextProvider } from './config';

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export class TextProviderError extends Error {}
export type TextSelection = { provider: TextProvider; model: string; apiKey?: string; beforeSend?: () => void };
export type TextMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export type TextResult = { text: string; provider: TextProvider; model: string; usage: Record<string, number> | null };
const usageSchema = z.record(z.string(), z.unknown());
export function reportedUsage(value: unknown): Record<string, number> | null {
  const parsed = usageSchema.safeParse(value);
  if (!parsed.success) return null;
  const entries = Object.entries(parsed.data).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0);
  return entries.length ? Object.fromEntries(entries) : null;
}

export async function installedOllamaModels(fetcher: Fetcher = fetch): Promise<string[]> {
  const response = await fetcher('http://127.0.0.1:11434/api/tags', { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Local Ollama is unavailable.');
  const payload = z.object({ models: z.array(z.object({ name: z.string(), remote_model: z.string().optional(), remote_host: z.string().optional() })) }).parse(await response.json());
  // Cloud aliases must never be represented as local inference.
  return payload.models.filter(item => !item.remote_model && !item.remote_host && !/cloud/i.test(item.name)).map(item => item.name);
}

export async function completeText(selection: TextSelection, messages: TextMessage[], options: { signal?: AbortSignal; timeoutMs?: number; maxTokens?: number; json?: boolean } = {}, fetcher: Fetcher = fetch): Promise<TextResult> {
  const { provider, model, apiKey } = selection;
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 90000), ...(options.signal ? [options.signal] : [])]);
  signal.throwIfAborted();
  if (provider !== 'ollama' && !apiKey) throw new Error(`The ${provider} API key is not configured.`);
  const maxTokens = options.maxTokens ?? 8192;
  let url: string, body: unknown;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider === 'ollama') {
    if (!(await installedOllamaModels(fetcher)).includes(model)) throw new Error('The selected local Ollama model is not installed.');
    url = 'http://127.0.0.1:11434/api/chat';
    body = { model, messages, stream: false, options: { temperature: 0.2, num_predict: maxTokens }, ...(options.json ? { format: 'json' } : {}) };
  } else if (provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/messages';
    headers['x-api-key'] = apiKey!; headers['anthropic-version'] = '2023-06-01';
    body = { model, system: messages.filter(m => m.role === 'system').map(m => m.content).join('\n'), messages: messages.filter(m => m.role !== 'system'), max_tokens: maxTokens };
  } else {
    url = provider === 'mistral' ? 'https://api.mistral.ai/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
    headers.Authorization = `Bearer ${apiKey}`;
    body = { model, messages, temperature: 0.2, max_tokens: maxTokens, ...(options.json ? { response_format: { type: 'json_object' } } : {}) };
  }
  try {
    signal.throwIfAborted();
    selection.beforeSend?.();
    const response = await fetcher(url, { method: 'POST', redirect: 'error', headers, body: JSON.stringify(body), signal });
    if (!response.ok) throw new TextProviderError(provider === 'mistral' && [401, 403].includes(response.status)
      ? `Mistral rejected the API key (HTTP ${response.status}). Check AI settings.`
      : `${provider} request failed (HTTP ${response.status}). Check AI settings.`);
    const payload = await response.json() as Record<string, any>;
    let text: unknown, finished: boolean;
    if (provider === 'anthropic') {
      text = Array.isArray(payload.content) ? payload.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('') : null;
      finished = payload.stop_reason === 'end_turn';
    } else if (provider === 'ollama') { text = payload.message?.content; finished = payload.done === true && payload.done_reason === 'stop'; }
    else { text = payload.choices?.[0]?.message?.content; finished = payload.choices?.[0]?.finish_reason === 'stop'; }
    if (!finished || typeof text !== 'string' || !text.trim()) throw new Error(`${provider} returned an empty or incomplete response. Nothing was saved.`);
    signal.throwIfAborted();
    return { text: text.trim(), provider, model: typeof payload.model === 'string' ? payload.model.slice(0, 120) : model,
      usage: reportedUsage(provider === 'ollama' ? { input_tokens: payload.prompt_eval_count, output_tokens: payload.eval_count } : payload.usage) };
  } catch (error) {
    if (signal.aborted) throw new Error('AI request cancelled or timed out. No automatic retry was made.');
    if (error instanceof TextProviderError) throw error;
    throw new Error(`${provider} could not be reached or returned an invalid response.`);
  }
}
