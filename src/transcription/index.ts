/**
 * Transcription module — public API
 */

export type { TranscriptionEngine, TranscriptionResult, TranscriptionOptions, TranscriptSegment } from './types.js';
export { WhisperEngine } from './whisper.js';
export { GroqWhisperEngine } from './groq.js';
export { MistralEngine } from './mistral.js';
export { DeepgramEngine } from './deepgram.js';
export { TranscriptionRouter, type RouterConfig, type EngineName } from './router.js';

import { TranscriptionRouter } from './router.js';

/** Default singleton router */
export const transcriber = new TranscriptionRouter();
