/**
 * Deepgram transcription engine — lazy-loads @deepgram/sdk to avoid import failures.
 */

import { readFile } from 'node:fs/promises';
import type { TranscriptionEngine, TranscriptionResult, TranscriptionOptions, TranscriptSegment } from './types.js';

export class DeepgramEngine implements TranscriptionEngine {
  readonly name = 'deepgram';
  private client: any = null;
  private initAttempted = false;

  constructor(private apiKey = process.env.DEEPGRAM_API_KEY) {}

  private getClient(): any {
    if (this.initAttempted) return this.client;
    this.initAttempted = true;
    if (!this.apiKey) return null;
    try {
      const { createClient } = require('@deepgram/sdk');
      this.client = createClient(this.apiKey);
    } catch (error) {
      console.log('[Deepgram] SDK not available:', (error as Error).message);
    }
    return this.client;
  }

  isAvailable(): boolean {
    return this.getClient() !== null;
  }

  async transcribeFile(filePath: string, options?: TranscriptionOptions): Promise<TranscriptionResult> {
    const buffer = await readFile(filePath);
    return this.transcribeBuffer(buffer, Bun.file(filePath).type || 'application/octet-stream', options);
  }

  async transcribeBuffer(buffer: Buffer, mimetype: string, options?: TranscriptionOptions): Promise<TranscriptionResult> {
    if (!this.apiKey) return this.fail('Deepgram API key is not configured.');
    const signal = AbortSignal.any([AbortSignal.timeout(180000), ...(options?.signal ? [options.signal] : [])]);
    try {
      const query = new URLSearchParams({ model: options?.model || 'nova-2', smart_format: 'true', punctuate: 'true', paragraphs: 'true', utterances: 'true' });
      if (options?.diarize) query.set('diarize_model', 'v1');
      if (options?.language && options.language !== 'auto') query.set('language', options.language); else query.set('detect_language', 'true');
      signal.throwIfAborted(); options?.onCheckpoint?.({ phase: 'submitting' });
      const response = await fetch(`https://api.deepgram.com/v1/listen?${query}`, { method: 'POST', redirect: 'error', headers: { Authorization: `Token ${this.apiKey}`, 'Content-Type': mimetype }, body: new Uint8Array(buffer), signal });
      if (!response.ok) return this.fail(`Deepgram request failed (HTTP ${response.status}).`);
      const result = this.parseResult(await response.json()); signal.throwIfAborted(); return result;
    } catch {
      return this.fail(signal.aborted ? 'Deepgram request cancelled or timed out.' : 'Deepgram returned an invalid response or could not be reached.');
    }
  }

  async transcribeUrl(audioUrl: string, options?: TranscriptionOptions): Promise<TranscriptionResult> {
    const client = this.getClient();
    if (!client) return this.fail('DEEPGRAM_API_KEY not set or SDK unavailable');

    try {
      const dgOptions: any = {
        model: (options?.model as any) || 'nova-2',
        smart_format: true,
        diarize: options?.diarize !== false,
        punctuate: true,
        paragraphs: true,
        utterances: true,
        detect_language: !options?.language,
      };

      const response = await client.listen.prerecorded.transcribeUrl({ url: audioUrl }, dgOptions);
      if (!response.result) return this.fail('No result from Deepgram');
      return this.parseResult(response.result);
    } catch (error: any) {
      return this.fail('Deepgram could not transcribe this URL.');
    }
  }

  private fail(error: string): TranscriptionResult {
    return { success: false, engine: this.name, fullText: '', segments: [], wordCount: 0, speakerCount: 0, confidence: 0, duration: 0, error };
  }

  private parseResult(result: any): TranscriptionResult {
    const channel = result.results?.channels?.[0];
    const alternative = channel?.alternatives?.[0];
    if (!alternative) return this.fail('No transcription in result');

    const fullText = alternative.transcript || '';
    const words = alternative.words || [];
    const segments: TranscriptSegment[] = [];

    if (alternative.paragraphs?.paragraphs) {
      for (const paragraph of alternative.paragraphs.paragraphs) {
        for (const sentence of paragraph.sentences || []) {
          segments.push({
            start: sentence.start || 0,
            end: sentence.end || 0,
            text: (sentence.text || '').trim(),
            speaker: paragraph.speaker,
            confidence: null,
          });
        }
      }
    } else if (words.length > 0) {
      let current: TranscriptSegment | null = null;
      for (const word of words) {
        if (!current || current.speaker !== word.speaker) {
          if (current) segments.push(current);
          current = { start: word.start || 0, end: word.end || 0, text: word.punctuated_word || word.word || '', speaker: word.speaker, confidence: word.confidence || 0 };
        } else {
          current.end = word.end || current.end;
          current.text += ' ' + (word.punctuated_word || word.word || '');
        }
      }
      if (current) segments.push(current);
    }

    const speakers = new Set(segments.map(s => s.speaker).filter(s => s !== undefined));
    const confidences = words.map((word: any) => word.confidence).filter((value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);
    const avgConfidence = confidences.length ? confidences.reduce((sum: number, value: number) => sum + value, 0) / confidences.length : null;

    return {
      success: true,
      engine: this.name,
      fullText,
      segments,
      wordCount: words.length || fullText.split(/\s+/).filter(Boolean).length,
      speakerCount: speakers.size || null,
      confidence: avgConfidence,
      duration: result.metadata?.duration || 0,
      metadata: { model: 'nova-2', language: channel.detected_language ?? null, usage: null },
    };
  }
}
