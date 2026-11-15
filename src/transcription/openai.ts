import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { z } from 'zod';
import { customEndpoint } from '../ai/config';
import { reportedUsage } from '../ai/text';
import type { TranscriptionEngine, TranscriptionOptions, TranscriptionResult } from './types';

export function transcriptionFailure(engine: string, error: string): TranscriptionResult {
  return { success: false, engine, error, fullText: '', segments: [], wordCount: 0, confidence: null, speakerCount: null, duration: 0 };
}
const segmentSchema = z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().nonnegative(), text: z.string(), speaker: z.union([z.number().int().nonnegative(), z.string().min(1)]).optional(), words: z.array(z.object({ start: z.number().nonnegative(), end: z.number().nonnegative(), text: z.string() })).optional() }).refine(s => s.end >= s.start);
const responseSchema = z.object({ text: z.string(), segments: z.array(segmentSchema).optional(), duration: z.number().finite().nonnegative().optional(), language: z.string().optional(), usage: z.unknown().optional() });
export class OpenAiEngine implements TranscriptionEngine {
  readonly name: 'openai' | 'custom';
  private base: string;
  private key?: string;
  constructor(key?: string, private fetcher: typeof fetch = fetch, endpoint?: string) {
    this.name = endpoint === undefined ? 'openai' : 'custom';
    this.base = endpoint ? customEndpoint(endpoint).base : '';
    this.key = this.name === 'custom' ? key : key ?? process.env.OPENAI_API_KEY;
  }
  isAvailable() { return this.name === 'custom' ? Boolean(this.base) : Boolean(this.key?.trim()); }
  async transcribeFile(path: string, options?: TranscriptionOptions) {
    if (this.name === 'custom' && extname(path).toLowerCase() !== '.wav') {
      const directory = await mkdtemp(join(tmpdir(), 'openplod-compatible-'));
      const wav = join(directory, 'audio.wav');
      const signal = AbortSignal.any([AbortSignal.timeout(120000), ...(options?.signal ? [options.signal] : [])]);
      try {
        options?.onCheckpoint?.({ phase: 'converting' });
        const run = promisify(execFile);
        try { await run('ffmpeg', ['-y', '-i', path, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { signal }); }
        catch { signal.throwIfAborted(); await run('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', path, wav], { signal }); }
        return await this.transcribeBuffer(await readFile(wav), 'audio/wav', options);
      } catch { return transcriptionFailure(this.name, 'Audio conversion failed or was cancelled. Nothing was sent.'); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
    const extension = extname(path).slice(1).toLowerCase();
    if (this.name === 'openai' && !['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm'].includes(extension)) return transcriptionFailure(this.name, 'OpenAI does not accept this audio format. Convert a copy first.');
    if (this.name === 'openai' && Bun.file(path).size > 25_000_000) return transcriptionFailure(this.name, 'OpenAI accepts files up to 25 MB. The original has not been sent.');
    return this.transcribeBuffer(await readFile(path), Bun.file(path).type, options, basename(path));
  }
  async transcribeBuffer(buffer: Buffer, mimetype: string, options: TranscriptionOptions = {}, filename = 'recording.wav'): Promise<TranscriptionResult> {
    if (!this.isAvailable()) return transcriptionFailure(this.name, 'OpenAI API key is not configured.');
    if (this.name === 'openai' && buffer.length > 25_000_000) return transcriptionFailure(this.name, 'OpenAI accepts files up to 25 MB. Nothing was sent.');
    const custom = this.name === 'custom';
    const model = options.model || (custom ? '' : 'whisper-1');
    if (!model) return transcriptionFailure(this.name, 'Select a model from the configured server.');
    if (!custom && (!['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'].includes(model) || options.diarize))
      return transcriptionFailure(this.name, 'Unsupported OpenAI model or diarization option.');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buffer)], { type: mimetype }), filename);
    form.append('model', model);
    if (options.diarize) {
      form.append('response_format', 'diarized_json');
      form.append('chunking_strategy', 'auto');
    } else {
      form.append('response_format', custom || model === 'whisper-1' ? 'verbose_json' : 'json');
    }
    if (custom && !options.diarize) {
      form.append('word_timestamps', 'true');
      form.append('max_tokens', '16384');
      form.append('timestamp_granularities[]', 'word');
    }
    if (model === 'whisper-1' && !options.diarize) form.append('timestamp_granularities[]', 'segment');
    if (options.language && options.language !== 'auto') form.append('language', options.language);
    const prompt = [options.prompt?.trim(), options.vocabulary?.join(', ')].filter(Boolean).join('\n');
    if (prompt && !options.diarize) form.append('prompt', prompt);
    const signal = AbortSignal.any([AbortSignal.timeout(custom ? 3600000 : 180000), ...(options.signal ? [options.signal] : [])]);
    try {
      signal.throwIfAborted(); options.onCheckpoint?.({ phase: 'submitting' });
      const response = await this.fetcher(custom ? `${this.base}/audio/transcriptions` : 'https://api.openai.com/v1/audio/transcriptions', { method: 'POST', redirect: 'error', headers: this.key ? { Authorization: `Bearer ${this.key}` } : {}, body: form, signal });
      if (!response.ok) return transcriptionFailure(this.name, `OpenAI transcription failed (HTTP ${response.status}).`);
      const payload = responseSchema.parse(await response.json());
      signal.throwIfAborted();
      const speakers = new Map<string, number>();
      const segments = (payload.segments || []).map(s => {
        const { speaker, ...segment } = s;
        if (speaker === undefined) return { ...segment, speaker: undefined, confidence: null };
        const id = String(speaker);
        if (!speakers.has(id)) speakers.set(id, speakers.size);
        return { ...segment, speaker: speakers.get(id)!, confidence: null };
      });
      if (options.diarize && (!segments.length || segments.some(s => s.speaker === undefined)))
        return transcriptionFailure(this.name, 'The server did not return timed speaker labels. Enable diarization on the server or choose a model that supports it.');
      const fullText = custom ? payload.text.replace(/<spk:\d+>/g, '').replace(/ +/g, ' ').trim() : payload.text.trim();
      return { success: true, engine: this.name, fullText, segments,
        wordCount: fullText.split(/\s+/).filter(Boolean).length, confidence: null, speakerCount: speakers.size || null,
        // Compatible servers may report processing time as duration (oMLX). Do not overwrite the recording's real duration.
        duration: custom ? 0 : payload.duration ?? payload.segments?.at(-1)?.end ?? 0,
        metadata: { model, ...(custom ? { endpoint: this.base } : {}), language: payload.language ?? null, usage: reportedUsage(payload.usage) } };

    } catch { return transcriptionFailure(this.name, signal.aborted ? 'OpenAI request cancelled or timed out. Check provider usage before retrying.' : 'OpenAI returned an invalid response or could not be reached. No automatic retry was made.'); }
  }
}
