import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { z } from 'zod';
import { reportedUsage } from '../ai/text';
import type { TranscriptionEngine, TranscriptionOptions, TranscriptionResult } from './types';

export function transcriptionFailure(engine: string, error: string): TranscriptionResult {
  return { success: false, engine, error, fullText: '', segments: [], wordCount: 0, confidence: null, speakerCount: null, duration: 0 };
}
const segmentSchema = z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().nonnegative(), text: z.string() }).refine(s => s.end >= s.start);
const responseSchema = z.object({ text: z.string(), segments: z.array(segmentSchema).optional(), duration: z.number().finite().nonnegative().optional(), language: z.string().optional(), usage: z.unknown().optional() });
export class OpenAiEngine implements TranscriptionEngine {
  readonly name = 'openai';
  constructor(private key = process.env.OPENAI_API_KEY, private fetcher: typeof fetch = fetch) {}
  isAvailable() { return Boolean(this.key?.trim()); }
  async transcribeFile(path: string, options?: TranscriptionOptions) {
    const extension = extname(path).slice(1).toLowerCase();
    if (!['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm'].includes(extension)) return transcriptionFailure(this.name, 'OpenAI does not accept this audio format. Convert a copy first.');
    if (Bun.file(path).size > 25_000_000) return transcriptionFailure(this.name, 'OpenAI accepts files up to 25 MB. The original has not been sent.');
    return this.transcribeBuffer(await readFile(path), Bun.file(path).type, options, basename(path));
  }
  async transcribeBuffer(buffer: Buffer, mimetype: string, options: TranscriptionOptions = {}, filename = 'recording.wav'): Promise<TranscriptionResult> {
    if (!this.isAvailable()) return transcriptionFailure(this.name, 'OpenAI API key is not configured.');
    if (buffer.length > 25_000_000) return transcriptionFailure(this.name, 'OpenAI accepts files up to 25 MB. Nothing was sent.');
    const model = options.model || 'whisper-1';
    if (!['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'].includes(model) || options.diarize)
      return transcriptionFailure(this.name, 'Unsupported OpenAI model or diarization option.');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buffer)], { type: mimetype }), filename);
    form.append('model', model);
    form.append('response_format', model === 'whisper-1' ? 'verbose_json' : 'json');
    if (model === 'whisper-1') form.append('timestamp_granularities[]', 'segment');
    if (options.language && options.language !== 'auto') form.append('language', options.language);
    if (options.vocabulary?.length) form.append('prompt', options.vocabulary.join(', '));
    const signal = AbortSignal.any([AbortSignal.timeout(180000), ...(options.signal ? [options.signal] : [])]);
    try {
      signal.throwIfAborted(); options.onCheckpoint?.({ phase: 'submitting' });
      const response = await this.fetcher('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${this.key}` }, body: form, signal });
      if (!response.ok) return transcriptionFailure(this.name, `OpenAI transcription failed (HTTP ${response.status}).`);
      const payload = responseSchema.parse(await response.json());
      signal.throwIfAborted();
      return { success: true, engine: this.name, fullText: payload.text.trim(), segments: (payload.segments || []).map(s => ({ ...s, confidence: null })),
        wordCount: payload.text.trim().split(/\s+/).filter(Boolean).length, confidence: null, speakerCount: null,
        duration: payload.duration ?? payload.segments?.at(-1)?.end ?? 0, metadata: { model, language: payload.language ?? null, usage: reportedUsage(payload.usage) } };
    } catch { return transcriptionFailure(this.name, signal.aborted ? 'OpenAI request cancelled or timed out. Check provider usage before retrying.' : 'OpenAI returned an invalid response or could not be reached. No automatic retry was made.'); }
  }
}
