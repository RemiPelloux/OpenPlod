/**
 * Transcription Router
 * 
 * Picks engine based on user config, handles fallback chains.
 * Default chain: whisper.cpp -> Mistral -> Deepgram
 */

import type { TranscriptionEngine, TranscriptionResult, TranscriptionOptions } from './types.js';
import { WhisperEngine } from './whisper.js';
import { MistralEngine } from './mistral.js';
import { DeepgramEngine } from './deepgram.js';

export type EngineName = 'whisper' | 'mistral' | 'deepgram';

export interface RouterConfig {
  /** Preferred engine */
  primary: EngineName;
  /** Fallback chain (tried in order if primary fails) */
  fallback: EngineName[];
  /** Default transcription options */
  defaults?: TranscriptionOptions;
}

export interface ProviderCredentials {
  mistralApiKey?: string;
  deepgramApiKey?: string;
}

const DEFAULT_CONFIG: RouterConfig = {
  primary: 'whisper',
  fallback: ['mistral', 'deepgram'],
  defaults: {
    diarize: true,
    language: 'en',
  },
};

export class TranscriptionRouter {
  private engines: Map<EngineName, TranscriptionEngine>;
  private config: RouterConfig;

  constructor(config?: Partial<RouterConfig>, credentials: ProviderCredentials = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.engines = new Map<EngineName, TranscriptionEngine>([
      ['whisper', new WhisperEngine()],
      ['mistral', new MistralEngine(credentials.mistralApiKey)],
      ['deepgram', new DeepgramEngine(credentials.deepgramApiKey)],
    ]);
  }

  /** Get status of all engines */
  status(): Record<EngineName, boolean> {
    const result: Record<string, boolean> = {};
    for (const [name, engine] of this.engines) {
      result[name] = engine.isAvailable();
    }
    return result as Record<EngineName, boolean>;
  }

  /** Get a specific engine */
  getEngine(name: EngineName): TranscriptionEngine | undefined {
    return this.engines.get(name);
  }

  /** Transcribe with fallback chain */
  async transcribeFile(filePath: string, options?: TranscriptionOptions): Promise<TranscriptionResult> {
    const opts = { ...this.config.defaults, ...options };
    const chain = [this.config.primary, ...this.config.fallback];
    const errors: string[] = [];

    for (const name of chain) {
      const engine = this.engines.get(name);
      if (!engine || !engine.isAvailable()) {
        errors.push(`${name}: not available`);
        continue;
      }

      console.log(`[Router] Trying ${name}...`);
      const result = await engine.transcribeFile(filePath, opts);

      if (result.success) {
        console.log(`[Router] ${name} succeeded: ${result.wordCount} words, ${result.duration.toFixed(1)}s`);
        return result;
      }

      errors.push(`${name}: ${result.error}`);
      console.log(`[Router] ${name} failed: ${result.error}`);
    }

    return {
      success: false,
      engine: 'router',
      fullText: '',
      segments: [],
      wordCount: 0,
      speakerCount: 0,
      confidence: 0,
      duration: 0,
      error: `All engines failed: ${errors.join('; ')}`,
    };
  }

  /** Transcribe buffer with fallback chain */
  async transcribeBuffer(buffer: Buffer, mimetype: string, options?: TranscriptionOptions): Promise<TranscriptionResult> {
    const opts = { ...this.config.defaults, ...options };
    const chain = [this.config.primary, ...this.config.fallback];
    const errors: string[] = [];

    for (const name of chain) {
      const engine = this.engines.get(name);
      if (!engine || !engine.isAvailable()) {
        errors.push(`${name}: not available`);
        continue;
      }

      const result = await engine.transcribeBuffer(buffer, mimetype, opts);
      if (result.success) return result;
      errors.push(`${name}: ${result.error}`);
    }

    return {
      success: false,
      engine: 'router',
      fullText: '',
      segments: [],
      wordCount: 0,
      speakerCount: 0,
      confidence: 0,
      duration: 0,
      error: `All engines failed: ${errors.join('; ')}`,
    };
  }

  /**
   * Transcribe with diarization — prefers Deepgram, falls back to whisper+basic
   */
  async transcribeWithDiarization(filePath: string, options?: TranscriptionOptions): Promise<TranscriptionResult> {
    const opts = { ...this.config.defaults, ...options, diarize: true };

    // Deepgram is best for diarization
    const deepgram = this.engines.get('deepgram');
    if (deepgram?.isAvailable()) {
      const result = await deepgram.transcribeFile(filePath, opts);
      if (result.success && result.speakerCount > 1) return result;
    }

    // Fallback to standard chain (won't have great diarization)
    return this.transcribeFile(filePath, opts);
  }
}
