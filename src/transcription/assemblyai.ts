import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import type { TranscriptionEngine, TranscriptionOptions, TranscriptionResult } from './types';
import { transcriptionFailure } from './openai';

const remoteId = z.string().regex(/^[a-zA-Z0-9-]{1,128}$/);
const utterance = z.object({ start: z.number().nonnegative(), end: z.number().nonnegative(), text: z.string(), speaker: z.string().nullable().optional(), confidence: z.number().min(0).max(1).nullable().optional() }).refine(s => s.end >= s.start);
const resultSchema = z.object({ id: remoteId, status: z.enum(['queued', 'processing', 'completed', 'error']), text: z.string().nullable().optional(), utterances: z.array(utterance).nullable().optional(),
  audio_duration: z.number().nonnegative().nullable().optional(), confidence: z.number().min(0).max(1).nullable().optional(), language_code: z.string().nullable().optional(), speech_model_used: z.string().nullable().optional() });
export class AssemblyAiEngine implements TranscriptionEngine {
  readonly name = 'assemblyai';
  constructor(private key = process.env.ASSEMBLYAI_API_KEY, private fetcher: typeof fetch = fetch, private pollMs = 3000) {}
  isAvailable() { return Boolean(this.key?.trim()); }
  async transcribeFile(path: string, options?: TranscriptionOptions) {
    if (Bun.file(path).size > 100_000_000) return transcriptionFailure(this.name, 'AssemblyAI uploads are limited to 100 MB in OpenPlod. Nothing was sent.');
    return this.transcribeBuffer(options?.checkpoint?.remoteId ? Buffer.alloc(0) : await readFile(path), Bun.file(path).type, options);
  }
  async transcribeBuffer(buffer: Buffer, _mimetype: string, options: TranscriptionOptions = {}): Promise<TranscriptionResult> {
    if (!this.isAvailable()) return transcriptionFailure(this.name, 'AssemblyAI API key is not configured.');
    if (buffer.length > 100_000_000) return transcriptionFailure(this.name, 'AssemblyAI uploads are limited to 100 MB in OpenPlod. Nothing was sent.');
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(options.signal ? [options.signal] : [])]);
    const headers = { authorization: this.key!, 'Content-Type': 'application/json' };
    const request = async (path: string, init: RequestInit) => {
      const response = await this.fetcher(`https://api.assemblyai.com/v2/${path}`, { redirect: 'error', ...init, headers: init.headers ?? headers, signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]) });
      if (!response.ok) throw new Error(`AssemblyAI request failed (HTTP ${response.status}).`);
      return response.json();
    };
    let id = options.checkpoint?.remoteId;
    try {
      signal.throwIfAborted();
      if (id) remoteId.parse(id);
      else {
        if (options.checkpoint?.phase === 'submitting') throw new Error('AssemblyAI submission outcome is unknown. Check your provider dashboard before starting another job.');
        options.onCheckpoint?.({ phase: 'uploading' });
        const uploaded = z.object({ upload_url: z.url() }).parse(await request('upload', { method: 'POST', headers: { authorization: this.key!, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(buffer) }));
        options.onCheckpoint?.({ phase: 'submitting' });
        const submitted = z.object({ id: remoteId }).parse(await request('transcript', { method: 'POST', body: JSON.stringify({ audio_url: uploaded.upload_url, speech_models: [options.model || 'universal-2'],
          speaker_labels: options.diarize === true, ...(options.language && options.language !== 'auto' ? { language_code: options.language, language_detection: false } : { language_detection: true }),
          ...(options.vocabulary?.length ? { word_boost: options.vocabulary } : {}) }) }));
        id = submitted.id;
        options.onCheckpoint?.({ phase: 'polling', remoteId: id });
      }
      let failures = 0;
      while (!signal.aborted) {
        let raw: unknown;
        try { raw = await request(`transcript/${encodeURIComponent(id)}`, { method: 'GET' }); failures = 0; }
        catch { if (++failures >= 3) throw new Error('AssemblyAI status unavailable. The remote job ID was retained; resume instead of submitting again.'); await delay(this.pollMs, undefined, { signal }); continue; }
        const payload = resultSchema.parse(raw);
        if (payload.id !== id) throw new Error('AssemblyAI returned a different job ID.');
        if (payload.status === 'error') throw new Error('AssemblyAI could not transcribe this recording. Check the provider dashboard.');
        if (payload.status === 'completed') {
          if (typeof payload.text !== 'string') throw new Error('AssemblyAI returned an invalid transcript.');
          signal.throwIfAborted();
          const speakers = [...new Set((payload.utterances || []).map(u => u.speaker).filter((s): s is string => typeof s === 'string'))];
          return { success: true, engine: this.name, fullText: payload.text.trim(), wordCount: payload.text.trim().split(/\s+/).filter(Boolean).length,
            segments: (payload.utterances || []).map(u => ({ start: u.start / 1000, end: u.end / 1000, text: u.text, confidence: u.confidence ?? null, ...(typeof u.speaker === 'string' ? { speaker: speakers.indexOf(u.speaker) } : {}) })),
            speakerCount: speakers.length || null, confidence: payload.confidence ?? null, duration: payload.audio_duration ?? 0,
            metadata: { model: payload.speech_model_used || options.model || 'universal-2', remoteId: id, language: payload.language_code ?? null, usage: null } };
        }
        await delay(this.pollMs, undefined, { signal });
      }
      throw new Error('AssemblyAI polling cancelled.');
    } catch (error) {
      return transcriptionFailure(this.name, signal.aborted ? 'AssemblyAI polling stopped. Remote processing may continue; its job ID is retained.' : error instanceof Error && error.message.startsWith('AssemblyAI ') ? error.message : 'AssemblyAI returned an invalid response or could not be reached. Check provider usage before retrying.');
    }
  }
}
