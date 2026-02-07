/**
 * Groq Whisper API transcription engine
 * 
 * Uses Groq's whisper-large-v3 endpoint for fast cloud transcription.
 */

import { readFileSync } from 'fs';
import { basename } from 'path';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { TranscriptionEngine, TranscriptionResult, TranscriptionOptions, TranscriptSegment } from './types.js';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

export class GroqWhisperEngine implements TranscriptionEngine {
  readonly name = 'groq';
  private apiKey: string | undefined;

  constructor() {
    this.apiKey = process.env.GROQ_API_KEY;
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  async transcribeFile(filePath: string, options?: TranscriptionOptions): Promise<TranscriptionResult> {
    const buffer = readFileSync(filePath);
    const ext = filePath.split('.').pop() || 'm4a';
    const mime = ext === 'wav' ? 'audio/wav' : ext === 'mp3' ? 'audio/mpeg' : ext === 'ogg' ? 'audio/ogg' : 'audio/mp4';
    return this.transcribeBuffer(buffer, mime, options, basename(filePath));
  }

  async transcribeBuffer(buffer: Buffer, mimetype: string, options?: TranscriptionOptions, filename?: string): Promise<TranscriptionResult> {
    if (!this.apiKey) {
      return { success: false, engine: this.name, fullText: '', segments: [], wordCount: 0, speakerCount: 0, confidence: 0, duration: 0, error: 'GROQ_API_KEY not set' };
    }

    try {
      const model = options?.model || 'whisper-large-v3';
      const fname = filename || `audio.${mimetype.split('/')[1] || 'm4a'}`;

      // Build multipart form data
      const formData = new FormData();
      formData.append('file', new Blob([buffer], { type: mimetype }), fname);
      formData.append('model', model);
      formData.append('response_format', 'verbose_json');
      formData.append('timestamp_granularities[]', 'segment');

      if (options?.language) {
        formData.append('language', options.language);
      }

      const response = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errBody = await response.text();
        return { success: false, engine: this.name, fullText: '', segments: [], wordCount: 0, speakerCount: 0, confidence: 0, duration: 0, error: `Groq API error ${response.status}: ${errBody}` };
      }

      const result = await response.json() as any;
      return this.parseResult(result);
    } catch (error: any) {
      return { success: false, engine: this.name, fullText: '', segments: [], wordCount: 0, speakerCount: 0, confidence: 0, duration: 0, error: error.message };
    }
  }

  private parseResult(json: any): TranscriptionResult {
    const fullText = json.text || '';
    const segments: TranscriptSegment[] = (json.segments || []).map((seg: any) => ({
      start: seg.start || 0,
      end: seg.end || 0,
      text: (seg.text || '').trim(),
      confidence: seg.avg_logprob ? Math.exp(seg.avg_logprob) : 0.9,
    }));

    const duration = json.duration || (segments.length > 0 ? segments[segments.length - 1].end : 0);

    return {
      success: true,
      engine: this.name,
      fullText,
      segments,
      wordCount: fullText.split(/\s+/).filter(Boolean).length,
      speakerCount: 1, // Groq whisper doesn't do diarization
      confidence: 0.9,
      duration,
    };
  }
}
