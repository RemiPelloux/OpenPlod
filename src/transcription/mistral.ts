import { basename, extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import type {
  TranscriptSegment,
  TranscriptionEngine,
  TranscriptionOptions,
  TranscriptionResult,
} from './types.js';

const MISTRAL_TRANSCRIPTION_URL = 'https://api.mistral.ai/v1/audio/transcriptions';
const DEFAULT_MODEL = 'voxtral-mini-latest';

type MistralSegment = {
  start?: number;
  end?: number;
  text?: string;
  avg_logprob?: number;
};

type MistralResponse = {
  text?: string;
  language?: string;
  duration?: number;
  segments?: MistralSegment[];
  model?: string;
};

export function normalizeMistralTranscription(json: MistralResponse): TranscriptionResult {
  const fullText = typeof json.text === 'string' ? json.text.trim() : '';
  const segments: TranscriptSegment[] = Array.isArray(json.segments)
    ? json.segments.map(segment => ({
        start: finiteNumber(segment.start),
        end: finiteNumber(segment.end),
        text: typeof segment.text === 'string' ? segment.text.trim() : '',
        confidence: confidenceFromLogProbability(segment.avg_logprob),
      }))
    : [];
  const duration = finiteNumber(json.duration)
    || (segments.length > 0 ? segments[segments.length - 1].end : 0);
  const confidence = segments.length > 0
    ? segments.reduce((total, segment) => total + segment.confidence, 0) / segments.length
    : 0.9;

  return {
    success: true,
    engine: 'mistral',
    fullText,
    segments,
    wordCount: fullText.split(/\s+/).filter(Boolean).length,
    speakerCount: 1,
    confidence,
    duration,
    metadata: {
      language: json.language,
      model: json.model ?? DEFAULT_MODEL,
    },
  };
}

export class MistralEngine implements TranscriptionEngine {
  readonly name = 'mistral';

  constructor(
    private readonly apiKey = process.env.MISTRAL_API_KEY,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  isAvailable(): boolean {
    return Boolean(this.apiKey?.trim());
  }

  async transcribeFile(filePath: string, options?: TranscriptionOptions): Promise<TranscriptionResult> {
    const buffer = await readFile(filePath);
    return this.transcribeBuffer(buffer, mimeTypeFor(filePath), options, basename(filePath));
  }

  async transcribeBuffer(
    buffer: Buffer,
    mimetype: string,
    options?: TranscriptionOptions,
    filename = `recording.${extensionForMimeType(mimetype)}`,
  ): Promise<TranscriptionResult> {
    if (!this.apiKey?.trim()) return failed('Mistral API key is not configured.');

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buffer)], { type: mimetype }), filename);
    form.append('model', options?.model ?? DEFAULT_MODEL);
    form.append('timestamp_granularities[]', 'segment');
    if (options?.language) form.append('language', options.language);

    try {
      const response = await this.fetcher(MISTRAL_TRANSCRIPTION_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok) {
        return failed(`Mistral transcription failed (${response.status} ${response.statusText || 'request error'}).`);
      }
      return normalizeMistralTranscription(await response.json() as MistralResponse);
    } catch (error) {
      const reason = error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)
        ? 'The Mistral request timed out.'
        : 'Mistral could not be reached.';
      return failed(reason);
    }
  }
}

function failed(error: string): TranscriptionResult {
  return {
    success: false,
    engine: 'mistral',
    fullText: '',
    segments: [],
    wordCount: 0,
    speakerCount: 0,
    confidence: 0,
    duration: 0,
    error,
  };
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function confidenceFromLogProbability(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.9;
  return Math.max(0, Math.min(1, Math.exp(value)));
}

function mimeTypeFor(filePath: string): string {
  const types: Record<string, string> = {
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.webm': 'audio/webm',
  };
  return types[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function extensionForMimeType(mimetype: string): string {
  const extensions: Record<string, string> = {
    'audio/aac': 'aac',
    'audio/flac': 'flac',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
  };
  return extensions[mimetype] ?? 'audio';
}
