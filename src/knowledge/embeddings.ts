import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { assertPrivacy, credential, readAiConfig, readSettings } from '../ai/config';
import { installedOllamaModels } from '../ai/text';
import type { EmbeddingInfo, EmbeddingKind, KnowledgeSettings } from './types';

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export type EmbedPurpose = 'document' | 'query';
export interface EmbeddingProvider {
  /** Stored with every vector; vectors from different models are never compared. */
  readonly model: string;
  readonly kind: EmbeddingKind;
  embed(texts: string[], options: { purpose: EmbedPurpose; signal?: AbortSignal; idf?: (token: string) => number }): Promise<Float32Array[]>;
}

export const knowledgeSettingsSchema = z.object({
  embeddingProvider: z.enum(['auto', 'lexical', 'ollama', 'openai', 'mistral']).default('auto'),
  ollamaModel: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_.:/-]+$/).default('nomic-embed-text'),
  cloudOptIn: z.boolean().default(false),
}).strict();
export const knowledgeSettingsInput = knowledgeSettingsSchema.extend({
  /** Choosing a cloud embedding provider must be confirmed in the same request. */
  confirmCloud: z.boolean().optional(),
}).strict();

export function readKnowledgeSettings(database: Database): KnowledgeSettings {
  const raw = readSettings(database).knowledgeConfig;
  try { return knowledgeSettingsSchema.parse(raw ? JSON.parse(raw) : {}); }
  catch { return knowledgeSettingsSchema.parse({}); }
}

/** The tokens FTS5 `unicode61 remove_diacritics 2` produces, closely enough for weighting. */
export function lexicalTokens(text: string): string[] {
  return text.normalize('NFKC').toLocaleLowerCase().normalize('NFD').replace(/\p{M}+/gu, '').match(/[\p{L}\p{N}_]+/gu) ?? [];
}

const fnv1a = (value: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  return hash >>> 0;
};
export function normalizeVector(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const value of vector) norm += value * value;
  if (norm > 0) { norm = Math.sqrt(norm); for (let index = 0; index < vector.length; index++) vector[index] /= norm; }
  return vector;
}

/**
 * Built-in offline fallback. This is lexical, not semantic: a signed hashed
 * bag-of-words in the SMART `lnc.ltc` scheme. Passages store sublinear term
 * frequency (1 + ln tf), cosine-normalized; the query also weights each term by
 * its inverse document frequency over the indexed passages. It needs no model,
 * no network, and gives stable vectors that do not change as the corpus grows.
 */
export class LexicalEmbedder implements EmbeddingProvider {
  readonly kind = 'lexical' as const;
  readonly model: string;
  constructor(readonly dims = 512) { this.model = `openplod-lexical-v1:${dims}`; }
  async embed(texts: string[], options: { purpose: EmbedPurpose; idf?: (token: string) => number }) {
    return texts.map(text => {
      const counts = new Map<string, number>();
      for (const token of lexicalTokens(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
      const vector = new Float32Array(this.dims);
      for (const [token, count] of counts) {
        const hash = fnv1a(token);
        const weight = (1 + Math.log(count)) * (options.purpose === 'query' && options.idf ? options.idf(token) : 1);
        vector[hash % this.dims] += hash & 0x80000000 ? -weight : weight;
      }
      return normalizeVector(vector);
    });
  }
}

const embeddingsPayload = z.object({ embeddings: z.array(z.array(z.number())) });
const openAiPayload = z.object({ data: z.array(z.object({ index: z.number().int().optional(), embedding: z.array(z.number()) })) });

/** Local Ollama embedding model, used only when it is installed on this computer. */
export class OllamaEmbedder implements EmbeddingProvider {
  readonly kind = 'local' as const;
  readonly model: string;
  constructor(private readonly name: string, private readonly fetcher: Fetcher = fetch) { this.model = `ollama:${name}`; }
  async embed(texts: string[], options: { purpose: EmbedPurpose; signal?: AbortSignal }) {
    // nomic-embed-text is trained with task prefixes; other models take plain text.
    const prefix = /^nomic-embed-text/.test(this.name) ? (options.purpose === 'query' ? 'search_query: ' : 'search_document: ') : '';
    const vectors: Float32Array[] = [];
    for (let offset = 0; offset < texts.length; offset += 16) {
      const response = await this.fetcher('http://127.0.0.1:11434/api/embed', {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.name, input: texts.slice(offset, offset + 16).map(text => prefix + text) }),
        signal: AbortSignal.any([AbortSignal.timeout(60000), ...(options.signal ? [options.signal] : [])]),
      });
      if (!response.ok) throw new Error(`Local Ollama embedding failed (HTTP ${response.status}).`);
      const payload = embeddingsPayload.parse(await response.json());
      vectors.push(...payload.embeddings.map(values => normalizeVector(Float32Array.from(values))));
    }
    if (vectors.length !== texts.length) throw new Error('Local Ollama returned the wrong number of embeddings.');
    return vectors;
  }
}

/** OpenAI or Mistral embeddings. Only constructed after explicit cloud opt-in. */
export class CloudEmbedder implements EmbeddingProvider {
  readonly kind = 'cloud' as const;
  readonly model: string;
  private readonly name: string;
  constructor(private readonly provider: 'openai' | 'mistral', private readonly apiKey: string, private readonly fetcher: Fetcher = fetch, private readonly beforeSend: () => void = () => {}) {
    this.name = provider === 'openai' ? 'text-embedding-3-small' : 'mistral-embed';
    this.model = `${provider}:${this.name}`;
  }
  async embed(texts: string[], options: { purpose: EmbedPurpose; signal?: AbortSignal }) {
    const url = this.provider === 'openai' ? 'https://api.openai.com/v1/embeddings' : 'https://api.mistral.ai/v1/embeddings';
    const vectors: Float32Array[] = [];
    for (let offset = 0; offset < texts.length; offset += 64) {
      this.beforeSend();
      const response = await this.fetcher(url, {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.name, input: texts.slice(offset, offset + 64) }),
        signal: AbortSignal.any([AbortSignal.timeout(60000), ...(options.signal ? [options.signal] : [])]),
      });
      if (!response.ok) throw new Error(`${this.provider} embedding request failed (HTTP ${response.status}).`);
      const payload = openAiPayload.parse(await response.json());
      const ordered = payload.data.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      vectors.push(...ordered.map(item => normalizeVector(Float32Array.from(item.embedding))));
    }
    if (vectors.length !== texts.length) throw new Error(`${this.provider} returned the wrong number of embeddings.`);
    return vectors;
  }
}

/**
 * Searches ask which Ollama models are installed on every query. An unreachable
 * Ollama costs up to a 5 s timeout per check, so the answer is cached briefly per
 * fetcher: 30 s when Ollama answers, 15 s when it does not. Settings > "Load local
 * models" still asks Ollama directly.
 */
const INSTALLED_TTL_MS = 30_000, UNREACHABLE_TTL_MS = 15_000;
const installedCache = new WeakMap<Fetcher, { models: Promise<string[]>; expires: number }>();
export function cachedOllamaModels(fetcher: Fetcher = fetch, now = Date.now()): Promise<string[]> {
  const hit = installedCache.get(fetcher);
  if (hit && hit.expires > now) return hit.models;
  const entry = { models: installedOllamaModels(fetcher).catch(() => { entry.expires = Date.now() + UNREACHABLE_TTL_MS; return [] as string[]; }), expires: now + INSTALLED_TTL_MS };
  installedCache.set(fetcher, entry);
  return entry.models;
}

/**
 * Pick the embedding provider for this vault. Local first: `auto` uses an installed
 * Ollama embedding model, otherwise the lexical fallback. A cloud provider is only
 * used when it is selected, explicitly opted in, allowed by the privacy mode, and
 * has a key; otherwise the lexical fallback is used and the reason is reported.
 */
export async function resolveEmbedder(database: Database, fetcher: Fetcher = fetch): Promise<{ provider: EmbeddingProvider; info: EmbeddingInfo }> {
  const settings = readKnowledgeSettings(database);
  const lexical = new LexicalEmbedder();
  const fallback = (note: string | null, requested = true) => ({ provider: lexical as EmbeddingProvider, info: { model: lexical.model, kind: lexical.kind, fallback: requested, note } });
  if (settings.embeddingProvider === 'lexical') return fallback(null, false);
  if (settings.embeddingProvider === 'auto' || settings.embeddingProvider === 'ollama') {
    const installed = await cachedOllamaModels(fetcher);
    const name = installed.find(model => model === settings.ollamaModel || model === `${settings.ollamaModel}:latest`);
    if (name) {
      const provider = new OllamaEmbedder(name, fetcher);
      return { provider, info: { model: provider.model, kind: provider.kind, fallback: false, note: null } };
    }
    return fallback(settings.embeddingProvider === 'auto' ? `Install the Ollama model ${settings.ollamaModel} for semantic search; using the built-in lexical index.` : `Ollama model ${settings.ollamaModel} is not installed; using the built-in lexical index.`, settings.embeddingProvider === 'ollama');
  }
  const cloud = settings.embeddingProvider;
  if (!settings.cloudOptIn) return fallback(`Cloud embeddings need explicit opt-in; using the built-in lexical index.`);
  try { assertPrivacy(readAiConfig(database), cloud); }
  catch { return fallback('Local-only mode blocks cloud embeddings; using the built-in lexical index.'); }
  const key = credential(database, cloud);
  if (!key) return fallback(`Add a ${cloud} API key for cloud embeddings; using the built-in lexical index.`);
  const provider = new CloudEmbedder(cloud, key, fetcher, () => assertPrivacy(readAiConfig(database), cloud));
  return { provider, info: { model: provider.model, kind: provider.kind, fallback: false, note: null } };
}

export const vectorToBlob = (vector: Float32Array) => new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
export const blobToVector = (blob: Uint8Array) => new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
export function cosine(a: Float32Array, b: Float32Array) {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let index = 0; index < a.length; index++) dot += a[index] * b[index];
  return dot;
}
