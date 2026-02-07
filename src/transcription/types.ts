/**
 * Shared types for all transcription engines
 */

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: number;
  confidence: number;
}

export interface TranscriptionResult {
  success: boolean;
  engine: string;
  fullText: string;
  segments: TranscriptSegment[];
  wordCount: number;
  speakerCount: number;
  confidence: number;
  duration: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface TranscriptionOptions {
  /** Enable speaker diarization */
  diarize?: boolean;
  /** Language code (e.g., 'en') */
  language?: string;
  /** Model to use (engine-specific) */
  model?: string;
  /** Number of threads for local processing */
  threads?: number;
}

export interface TranscriptionEngine {
  readonly name: string;
  /** Check if engine is available (API key set, binary exists, etc.) */
  isAvailable(): boolean;
  /** Transcribe an audio file from disk */
  transcribeFile(filePath: string, options?: TranscriptionOptions): Promise<TranscriptionResult>;
  /** Transcribe from a buffer */
  transcribeBuffer(buffer: Buffer, mimetype: string, options?: TranscriptionOptions): Promise<TranscriptionResult>;
}
