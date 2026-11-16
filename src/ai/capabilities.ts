import type { SpeechProvider } from './config';

export type TimestampGranularity = 'word' | 'segment' | 'none';
/**
 * Languages OpenAI documents for Whisper (and its gpt-4o transcription models),
 * as ISO 639-1 codes. whisper.cpp runs the same multilingual models.
 */
const WHISPER_LANGUAGES = ['af', 'ar', 'hy', 'az', 'be', 'bs', 'bg', 'ca', 'zh', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'gl', 'de', 'el', 'he', 'hi', 'hu', 'is', 'id', 'it', 'ja', 'kn', 'kk', 'ko', 'lv', 'lt', 'mk', 'ms', 'mr', 'mi', 'ne', 'no', 'fa', 'pl', 'pt', 'ro', 'ru', 'sr', 'sk', 'sl', 'es', 'sw', 'sv', 'tl', 'ta', 'th', 'tr', 'uk', 'ur', 'vi', 'cy'] as const;
/** Languages Mistral documents for Voxtral transcription. */
const VOXTRAL_LANGUAGES = ['en', 'es', 'fr', 'pt', 'hi', 'de', 'nl', 'it'] as const;

/**
 * Speech capability registry (AI-04). Per-model `languages` is a documented list
 * of ISO 639-1 codes, or `null` when OpenPlod does not hold a reliable list (the
 * language is then passed through and the provider decides). `timestampGranularity`
 * is what this adapter actually returns for each model; AssemblyAI only returns
 * timed utterances when speaker labels are on.
 */
export const speechCapabilities = {
  whisper: { label: 'Whisper.cpp', local: true, models: ['base', 'small', 'medium', 'large-v3-turbo', 'large-v3'], timestamps: true, diarization: false, vocabulary: true, prompt: true, maxBytes: null, formats: ['wav', 'm4a', 'mp3', 'flac', 'ogg', 'webm', 'aac'], streaming: false,
    languages: { base: WHISPER_LANGUAGES, small: WHISPER_LANGUAGES, medium: WHISPER_LANGUAGES, 'large-v3-turbo': WHISPER_LANGUAGES, 'large-v3': WHISPER_LANGUAGES },
    timestampGranularity: { base: 'segment', small: 'segment', medium: 'segment', 'large-v3-turbo': 'segment', 'large-v3': 'segment' } },
  mistral: { label: 'Mistral Voxtral', local: false, models: ['voxtral-mini-latest'], timestamps: true, diarization: false, vocabulary: false, prompt: false, maxBytes: null, formats: ['wav', 'm4a', 'mp3', 'flac', 'ogg', 'webm', 'aac'], streaming: false,
    languages: { 'voxtral-mini-latest': VOXTRAL_LANGUAGES }, timestampGranularity: { 'voxtral-mini-latest': 'segment' } },
  deepgram: { label: 'Deepgram', local: false, models: ['nova-2', 'nova-3'], timestamps: true, diarization: true, vocabulary: true, prompt: false, maxBytes: null, formats: ['wav', 'm4a', 'mp3', 'flac', 'ogg', 'webm', 'aac'], streaming: false,
    languages: { 'nova-2': null, 'nova-3': null }, timestampGranularity: { 'nova-2': 'word', 'nova-3': 'word' } },
  openai: { label: 'OpenAI', local: false, models: ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'], timestamps: true, diarization: false, vocabulary: true, prompt: true, maxBytes: 25_000_000, formats: ['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm'], streaming: false,
    languages: { 'whisper-1': WHISPER_LANGUAGES, 'gpt-4o-transcribe': WHISPER_LANGUAGES, 'gpt-4o-mini-transcribe': WHISPER_LANGUAGES }, timestampGranularity: { 'whisper-1': 'segment', 'gpt-4o-transcribe': 'none', 'gpt-4o-mini-transcribe': 'none' } },
  assemblyai: { label: 'AssemblyAI', local: false, models: ['universal-2'], timestamps: true, diarization: true, vocabulary: true, prompt: false, maxBytes: 100_000_000, formats: ['wav', 'm4a', 'mp3', 'flac', 'ogg', 'webm', 'aac'], streaming: false,
    languages: { 'universal-2': null }, timestampGranularity: { 'universal-2': 'segment' } },
} satisfies Record<SpeechProvider, { models: string[]; languages: Record<string, readonly string[] | null>; timestampGranularity: Record<string, TimestampGranularity>; maxBytes: number | null } & Record<string, unknown>>;

/** The model a provider runs when none is chosen. */
export const defaultSpeechModel = (provider: SpeechProvider) => speechCapabilities[provider].models[0];
/** Documented languages for a model, or null when unknown. */
export function speechLanguages(provider: SpeechProvider, model?: string | null): readonly string[] | null {
  return (speechCapabilities[provider].languages as Record<string, readonly string[] | null>)[model || defaultSpeechModel(provider)] ?? null;
}
export function timestampGranularity(provider: SpeechProvider, model?: string | null, diarize = false): TimestampGranularity {
  if (provider === 'assemblyai' && !diarize) return 'none';
  return (speechCapabilities[provider].timestampGranularity as Record<string, TimestampGranularity>)[model || defaultSpeechModel(provider)] ?? 'none';
}

export function validateSpeechOptions(provider: SpeechProvider, options: { model?: string; diarize?: boolean; vocabulary?: string[]; prompt?: string; language?: string }): void {
  const capabilities = speechCapabilities[provider];
  if (options.model && !(capabilities.models as readonly string[]).includes(options.model)) throw new Error(`Unsupported ${provider} transcription model.`);
  if (options.diarize && !capabilities.diarization) throw new Error(`${provider} does not support speaker labels in this adapter.`);
  if (options.vocabulary?.length && !capabilities.vocabulary) throw new Error(`${provider} does not support vocabulary hints in this adapter.`);
  if (options.prompt?.trim() && !capabilities.prompt) throw new Error(`${provider} does not accept a context prompt in this adapter.`);
  // A language is checked only against a documented list; an unknown list is never guessed.
  const languages = speechLanguages(provider, options.model);
  if (options.language && options.language !== 'auto' && languages && !languages.includes(options.language.split('-')[0]))
    throw new Error(`${capabilities.label} does not document support for language "${options.language}". Choose automatic detection or another provider.`);
}
