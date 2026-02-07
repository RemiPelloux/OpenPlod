/**
 * Whisper.cpp local transcription engine
 * 
 * Uses the whisper-cli binary from homebrew.
 * Free, private, runs entirely on-device.
 */

import { execSync, execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import type { TranscriptionEngine, TranscriptionResult, TranscriptionOptions, TranscriptSegment } from './types.js';

const WHISPER_BIN = '/opt/homebrew/bin/whisper-cli';
const MODELS_DIR = join(process.env.HOME || '~', 'clawd/models/whisper');
const MODEL_URLS: Record<string, string> = {
  'tiny.en': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin',
  'tiny': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
  'base.en': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
  'base': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
  'small.en': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin',
  'small': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
  'medium.en': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin',
  'medium': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin',
};

export class WhisperEngine implements TranscriptionEngine {
  readonly name = 'whisper.cpp';

  isAvailable(): boolean {
    return existsSync(WHISPER_BIN);
  }

  private getModelPath(model: string): string {
    return join(MODELS_DIR, `ggml-${model}.bin`);
  }

  private ensureModel(model: string): string {
    const modelPath = this.getModelPath(model);
    if (existsSync(modelPath)) return modelPath;

    // Try .en variant for English
    if (!model.endsWith('.en')) {
      const enPath = this.getModelPath(`${model}.en`);
      if (existsSync(enPath)) return enPath;
    }

    // Download if we have a URL
    const key = model.endsWith('.en') ? model : `${model}.en`;
    const url = MODEL_URLS[key] || MODEL_URLS[model];
    if (!url) throw new Error(`Unknown whisper model: ${model}`);

    console.log(`[Whisper] Downloading model ${key}...`);
    mkdirSync(MODELS_DIR, { recursive: true });
    const targetPath = this.getModelPath(key);
    execSync(`curl -L -o "${targetPath}" "${url}"`, { stdio: 'pipe', timeout: 600_000 });
    console.log(`[Whisper] Model downloaded to ${targetPath}`);
    return targetPath;
  }

  /**
   * Convert audio to 16kHz WAV (whisper.cpp requirement)
   */
  private toWav(inputPath: string): string {
    const outPath = join(tmpdir(), `whisper-${Date.now()}-${basename(inputPath)}.wav`);
    try {
      execSync(`ffmpeg -y -i "${inputPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${outPath}" 2>/dev/null`, {
        timeout: 120_000,
      });
    } catch {
      // Try with afconvert (macOS built-in) as fallback
      execSync(`afconvert -f WAVE -d LEI16@16000 -c 1 "${inputPath}" "${outPath}"`, {
        timeout: 120_000,
      });
    }
    return outPath;
  }

  async transcribeFile(filePath: string, options?: TranscriptionOptions): Promise<TranscriptionResult> {
    if (!this.isAvailable()) {
      return { success: false, engine: this.name, fullText: '', segments: [], wordCount: 0, speakerCount: 0, confidence: 0, duration: 0, error: 'whisper-cli not found. Install with: brew install whisper-cpp' };
    }

    const model = options?.model || 'base.en';
    const threads = options?.threads || 4;
    let wavPath: string | null = null;

    try {
      const modelPath = this.ensureModel(model);

      // Convert to WAV if not already
      const isWav = filePath.toLowerCase().endsWith('.wav');
      const inputPath = isWav ? filePath : (wavPath = this.toWav(filePath));

      // Run whisper-cli with JSON output
      const outBase = join(tmpdir(), `whisper-out-${Date.now()}`);
      const args = [
        '-m', modelPath,
        '-f', inputPath,
        '-t', String(threads),
        '-oj',           // output JSON
        '-of', outBase,  // output file base
        '--no-prints',
      ];

      if (options?.language) {
        args.push('-l', options.language);
      }

      execFileSync(WHISPER_BIN, args, { timeout: 600_000, stdio: 'pipe' });

      // Parse JSON output
      const jsonPath = `${outBase}.json`;
      if (!existsSync(jsonPath)) {
        return { success: false, engine: this.name, fullText: '', segments: [], wordCount: 0, speakerCount: 0, confidence: 0, duration: 0, error: 'Whisper produced no output' };
      }

      const result = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      unlinkSync(jsonPath);

      return this.parseResult(result);
    } catch (error: any) {
      return { success: false, engine: this.name, fullText: '', segments: [], wordCount: 0, speakerCount: 0, confidence: 0, duration: 0, error: error.message };
    } finally {
      if (wavPath && existsSync(wavPath)) {
        try { unlinkSync(wavPath); } catch {}
      }
    }
  }

  async transcribeBuffer(buffer: Buffer, mimetype: string, options?: TranscriptionOptions): Promise<TranscriptionResult> {
    // Write buffer to temp file, then transcribe
    const ext = mimetype.includes('wav') ? '.wav' : mimetype.includes('mp3') ? '.mp3' : mimetype.includes('ogg') ? '.ogg' : '.m4a';
    const tmpPath = join(tmpdir(), `whisper-buf-${Date.now()}${ext}`);
    writeFileSync(tmpPath, buffer);
    try {
      return await this.transcribeFile(tmpPath, options);
    } finally {
      try { unlinkSync(tmpPath); } catch {}
    }
  }

  private parseResult(json: any): TranscriptionResult {
    const transcription = json.transcription || [];
    const segments: TranscriptSegment[] = [];
    const textParts: string[] = [];

    for (const item of transcription) {
      const text = (item.text || '').trim();
      if (!text) continue;

      segments.push({
        start: this.parseTimestamp(item.timestamps?.from || '00:00:00'),
        end: this.parseTimestamp(item.timestamps?.to || '00:00:00'),
        text,
        confidence: 0.85, // whisper.cpp JSON doesn't include per-segment confidence
      });
      textParts.push(text);
    }

    const fullText = textParts.join(' ');
    const duration = segments.length > 0 ? segments[segments.length - 1].end : 0;

    return {
      success: true,
      engine: this.name,
      fullText,
      segments,
      wordCount: fullText.split(/\s+/).filter(Boolean).length,
      speakerCount: 1, // whisper.cpp doesn't do diarization natively
      confidence: 0.85,
      duration,
    };
  }

  private parseTimestamp(ts: string): number {
    // "00:01:23,456" or "00:01:23.456" → seconds
    const clean = ts.replace(',', '.');
    const parts = clean.split(':');
    if (parts.length === 3) {
      return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    }
    return parseFloat(clean) || 0;
  }
}
