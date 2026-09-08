import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { z } from 'zod';
import type { TranscriptionEngine, TranscriptionOptions, TranscriptionResult } from './types';
import { transcriptionFailure } from './openai';

const run = promisify(execFile);
const binary = process.env.WHISPER_BIN || '/opt/homebrew/bin/whisper-cli';
const models = process.env.WHISPER_MODELS_DIR || join(homedir(), 'clawd/models/whisper');
const resultSchema = z.object({ transcription: z.array(z.object({ text: z.string(), offsets: z.object({ from: z.number().nonnegative(), to: z.number().nonnegative() }) })) });
export class WhisperEngine implements TranscriptionEngine {
  readonly name = 'whisper.cpp';
  isAvailable() { return existsSync(binary); }
  async transcribeFile(path: string, options: TranscriptionOptions = {}): Promise<TranscriptionResult> {
    if (!this.isAvailable()) return transcriptionFailure(this.name, 'Install whisper-cpp before local transcription.');
    const model = options.model || 'base';
    if (!['base', 'small', 'medium'].includes(model)) return transcriptionFailure(this.name, 'Select a supported multilingual Whisper model.');
    const modelPath = join(models, `ggml-${model}.bin`);
    if (!existsSync(modelPath)) return transcriptionFailure(this.name, `Install ggml-${model}.bin in WHISPER_MODELS_DIR before transcription. No model or audio was downloaded.`);
    const directory = await mkdtemp(join(tmpdir(), 'openplod-whisper-'));
    const signal = AbortSignal.any([AbortSignal.timeout(600000), ...(options.signal ? [options.signal] : [])]);
    try {
      const wav = join(directory, 'audio.wav'), output = join(directory, 'transcript');
      options.onCheckpoint?.({ phase: 'converting' });
      try { await run('ffmpeg', ['-y', '-i', path, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { signal, timeout: 120000 }); }
      catch { signal.throwIfAborted(); await run('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', path, wav], { signal, timeout: 120000 }); }
      options.onCheckpoint?.({ phase: 'transcribing' });
      await run(binary, ['-m', modelPath, '-f', wav, '-t', String(Math.max(1, Math.min(16, options.threads || 4))), '-oj', '-of', output, '--no-prints', '-l', options.language || 'auto'], { signal, timeout: 600000 });
      const parsed = resultSchema.parse(JSON.parse(await readFile(`${output}.json`, 'utf8')));
      signal.throwIfAborted();
      if (parsed.transcription.some(item => item.offsets.to < item.offsets.from)) throw new Error('Invalid offsets');
      const segments = parsed.transcription.map(item => ({ start: item.offsets.from / 1000, end: item.offsets.to / 1000, text: item.text.trim(), confidence: null }));
      const fullText = segments.map(s => s.text).join(' ').trim();
      return { success: true, engine: this.name, fullText, segments, wordCount: fullText.split(/\s+/).filter(Boolean).length, speakerCount: null, confidence: null, duration: segments.at(-1)?.end || 0, metadata: { model, usage: null } };
    } catch { return transcriptionFailure(this.name, signal.aborted ? 'Local transcription cancelled or timed out.' : 'Local transcription failed. Check the Whisper model and audio converter installation.'); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
  async transcribeBuffer(buffer: Buffer, _mimetype: string, options?: TranscriptionOptions) {
    const directory = await mkdtemp(join(tmpdir(), 'openplod-whisper-input-'));
    try { const path = join(directory, 'audio'); await writeFile(path, buffer, { mode: 0o600 }); return await this.transcribeFile(path, options); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}
