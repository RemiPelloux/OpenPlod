/**
 * Deepgram transcription engine — lazy-loads @deepgram/sdk to avoid import failures.
 */

import { readFileSync } from 'fs';
import type { TranscriptionEngine, TranscriptionResult, TranscriptionOptions, TranscriptSegment } from './types.js';

let _client: any = null;
let _initAttempted = false;

function getClient(): any {
  if (_initAttempted) return _client;
  _initAttempted = true;
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return null;
  try {
    // Dynamic require to avoid top-level import failure
    const { createClient } = require('@deepgram/sdk');
    _client = createClient(apiKey);
  } catch (e) {
    console.log('[Deepgram] SDK not available:', (e as Error).message);
  }
  return _client;
}

export class DeepgramEngine implements TranscriptionEngine {
  readonly name = 'deepgram';

  isAvailable(): boolean {
    return getClient() !== null;
  }

  async transcribeFile(filePath: string, options?: TranscriptionOptions): Promise<TranscriptionResult> {
    const buffer = readFileSync(filePath);
    return this.transcribeBuffer(buffer, 'audio/mp4', options);
  }

  async transcribeBuffer(buffer: Buffer, mimetype: string, options?: TranscriptionOptions): Promise<TranscriptionResult> {
    const client = getClient();
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
      if (options?.language) dgOptions.language = options.language;

      const response = await client.listen.prerecorded.transcribeFile(buffer, dgOptions);
      if (!response.result) return this.fail('No result from Deepgram');
      return this.parseResult(response.result);
    } catch (error: any) {
      return this.fail(error.message);
    }
  }

  async transcribeUrl(audioUrl: string, options?: TranscriptionOptions): Promise<TranscriptionResult> {
    const client = getClient();
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
      return this.fail(error.message);
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
            confidence: 1.0,
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
    const avgConfidence = words.length > 0 ? words.reduce((sum: number, w: any) => sum + (w.confidence || 0), 0) / words.length : 0;

    return {
      success: true,
      engine: this.name,
      fullText,
      segments,
      wordCount: words.length || fullText.split(/\s+/).filter(Boolean).length,
      speakerCount: speakers.size || 1,
      confidence: avgConfidence,
      duration: result.metadata?.duration || 0,
    };
  }
}
