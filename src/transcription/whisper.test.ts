import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { speechCapabilities } from '../ai/capabilities';
import { speechPrices } from '../ai/pricing';
import { resolveWhisperModel } from './whisper';

describe('Whisper model selection', () => {
  test('every selectable model has languages, timestamps and a price', () => {
    const whisper = speechCapabilities.whisper;
    expect(whisper.models).toEqual(['base', 'small', 'medium', 'large-v3-turbo', 'large-v3']);
    for (const model of whisper.models) {
      expect(whisper.languages[model as keyof typeof whisper.languages]).toBeDefined();
      expect(whisper.timestampGranularity[model as keyof typeof whisper.timestampGranularity]).toBe('segment');
      expect(speechPrices.whisper[model]?.usdPerMinute).toBe(0);
    }
  });

  test('prefers the configured folder and falls back to the legacy default', () => {
    const legacy = join(homedir(), 'clawd/models/whisper/ggml-small.bin');
    const files = new Set(['/models/ggml-base.bin', legacy]);
    const exists = (path: string) => files.has(path);
    expect(resolveWhisperModel('base', '/models', exists)).toBe('/models/ggml-base.bin');
    expect(resolveWhisperModel('small', '/models', exists)).toBe(legacy);
    expect(resolveWhisperModel('large-v3', '/models', exists)).toBeNull();
    expect(resolveWhisperModel('small', undefined, exists)).toBe(legacy);
  });
});
