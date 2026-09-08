import type { SpeechProvider } from './config';

export const speechCapabilities = {
  whisper: { label: 'Whisper.cpp', local: true, models: ['base', 'small', 'medium'], timestamps: true, diarization: false, vocabulary: false, maxBytes: null, formats: ['wav', 'm4a', 'mp3', 'flac', 'ogg', 'webm', 'aac'], streaming: false },
  mistral: { label: 'Mistral Voxtral', local: false, models: ['voxtral-mini-latest'], timestamps: true, diarization: false, vocabulary: false, maxBytes: null, formats: ['wav', 'm4a', 'mp3', 'flac', 'ogg', 'webm', 'aac'], streaming: false },
  deepgram: { label: 'Deepgram', local: false, models: ['nova-2'], timestamps: true, diarization: true, vocabulary: false, maxBytes: null, formats: ['wav', 'm4a', 'mp3', 'flac', 'ogg', 'webm', 'aac'], streaming: false },
  openai: { label: 'OpenAI', local: false, models: ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'], timestamps: true, diarization: false, vocabulary: true, maxBytes: 25_000_000, formats: ['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm'], streaming: false },
  assemblyai: { label: 'AssemblyAI', local: false, models: ['universal-2'], timestamps: true, diarization: true, vocabulary: true, maxBytes: 100_000_000, formats: ['wav', 'm4a', 'mp3', 'flac', 'ogg', 'webm', 'aac'], streaming: false },
} satisfies Record<SpeechProvider, object>;

export function validateSpeechOptions(provider: SpeechProvider, options: { model?: string; diarize?: boolean; vocabulary?: string[] }): void {
  const capabilities = speechCapabilities[provider];
  if (options.model && !(capabilities.models as readonly string[]).includes(options.model)) throw new Error(`Unsupported ${provider} transcription model.`);
  if (options.diarize && !capabilities.diarization) throw new Error(`${provider} does not support speaker labels in this adapter.`);
  if (options.vocabulary?.length && !capabilities.vocabulary) throw new Error(`${provider} does not support vocabulary hints in this adapter.`);
}
