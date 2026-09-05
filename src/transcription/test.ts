#!/usr/bin/env bun
/**
 * Test transcription engines against real audio
 */

import { WhisperEngine } from './whisper.js';
import { MistralEngine } from './mistral.js';
import { DeepgramEngine } from './deepgram.js';
import { TranscriptionRouter } from './router.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

async function main() {
  console.log('=== Transcription Engine Tests ===\n');

  // Check engine availability
  const router = new TranscriptionRouter();
  const status = router.status();
  console.log('Engine status:');
  for (const [name, available] of Object.entries(status)) {
    console.log(`  ${name}: ${available ? '✅' : '❌'}`);
  }
  console.log();

  // Generate test audio with speech
  const testFile = '/tmp/whisper-test.wav';
  console.log('Generating test speech audio...');
  try {
    execSync(`say -o /tmp/whisper-test.aiff "Hello, this is a test of the transcription engine. The quick brown fox jumps over the lazy dog."`);
    execSync(`afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/whisper-test.aiff "${testFile}"`);
  } catch {
    execSync(`ffmpeg -y -f lavfi -i "sine=frequency=440:duration=3" -ar 16000 -ac 1 "${testFile}" 2>/dev/null`);
  }
  console.log(`Test file: ${testFile}\n`);

  // Test Whisper.cpp
  console.log('--- Testing Whisper.cpp ---');
  const whisper = new WhisperEngine();
  if (whisper.isAvailable()) {
    const start = Date.now();
    const result = await whisper.transcribeFile(testFile);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (result.success) {
      console.log(`  ✅ Success in ${elapsed}s`);
      console.log(`  Words: ${result.wordCount}, Duration: ${result.duration.toFixed(1)}s`);
      console.log(`  Text: "${result.fullText.substring(0, 200)}"`);
      console.log(`  Segments: ${result.segments.length}`);
    } else {
      console.log(`  ❌ Failed: ${result.error}`);
    }
  } else {
    console.log('  ⏭️  Not available');
  }
  console.log();

  // Test Mistral
  console.log('--- Testing Mistral Voxtral ---');
  const mistral = new MistralEngine();
  if (mistral.isAvailable()) {
    const start = Date.now();
    const result = await mistral.transcribeFile(testFile);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (result.success) {
      console.log(`  ✅ Success in ${elapsed}s`);
      console.log(`  Words: ${result.wordCount}, Duration: ${result.duration.toFixed(1)}s`);
      console.log(`  Text: "${result.fullText.substring(0, 200)}"`);
    } else {
      console.log(`  ❌ Failed: ${result.error}`);
    }
  } else {
    console.log('  ⏭️  Not available (set MISTRAL_API_KEY)');
  }
  console.log();

  // Test Deepgram
  console.log('--- Testing Deepgram ---');
  const deepgram = new DeepgramEngine();
  if (deepgram.isAvailable()) {
    const start = Date.now();
    const result = await deepgram.transcribeFile(testFile, { diarize: true });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (result.success) {
      console.log(`  ✅ Success in ${elapsed}s`);
      console.log(`  Words: ${result.wordCount}, Duration: ${result.duration.toFixed(1)}s`);
      console.log(`  Speakers: ${result.speakerCount}`);
      console.log(`  Text: "${result.fullText.substring(0, 200)}"`);
    } else {
      console.log(`  ❌ Failed: ${result.error}`);
    }
  } else {
    console.log('  ⏭️  Not available (set DEEPGRAM_API_KEY)');
  }
  console.log();

  // Test Router with fallback
  console.log('--- Testing Router (fallback chain) ---');
  const start = Date.now();
  const result = await router.transcribeFile(testFile);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (result.success) {
    console.log(`  ✅ Routed to: ${result.engine} in ${elapsed}s`);
    console.log(`  Words: ${result.wordCount}`);
    console.log(`  Text: "${result.fullText.substring(0, 200)}"`);
  } else {
    console.log(`  ❌ All engines failed: ${result.error}`);
  }

  console.log('\n=== Tests Complete ===');
}

main().catch(console.error);
