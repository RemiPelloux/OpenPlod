import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { aiConfigSchema } from './config';
import { estimateSpeechUsd, estimateTextUsd, PRICES_AS_OF, speechPrices, tokenCounts } from './pricing';
import { costGate, estimateRecordings, estimateTranscription, monthToDate, recordSpend, recordTextSpend, settleSpend } from './spending';
import { validateSpeechOptions, speechLanguages, timestampGranularity } from './capabilities';

function database(config: object = {}) {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE user_settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT); CREATE TABLE recordings(id TEXT PRIMARY KEY, duration_seconds INTEGER, file_path TEXT, file_size_bytes INTEGER)");
  db.query('INSERT INTO user_settings(key,value) VALUES(?,?)').run('aiConfig', JSON.stringify(config));
  return db;
}

test('price table is dated and leaves uncertain prices unknown instead of guessing', () => {
  expect(PRICES_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(estimateSpeechUsd('openai', 'whisper-1', 600)).toBeCloseTo(0.06);
  expect(estimateSpeechUsd('openai', 'gpt-4o-mini-transcribe', 60)).toBeCloseTo(0.003);
  expect(estimateSpeechUsd('whisper', 'base', 6000)).toBe(0);
  expect(speechPrices.deepgram['nova-3'].usdPerMinute).toBeNull();
  expect(estimateSpeechUsd('deepgram', 'nova-3', 60)).toBeNull();
  expect(estimateSpeechUsd('openai', 'whisper-1', null)).toBeNull();
  expect(estimateSpeechUsd('openai', 'unknown-model', 60)).toBeNull();
  expect(estimateTextUsd('openai', 'gpt-4.1-mini', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 })).toBeCloseTo(2);
  expect(estimateTextUsd('gemini', 'gemini-2.5-flash', { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 100 })).toBeCloseTo(0.0008);
  expect(estimateTextUsd('mistral', 'mistral-small-latest', { prompt_tokens: 10, completion_tokens: 10 })).toBeNull();
  expect(estimateTextUsd('openai', 'gpt-4.1-mini', null)).toBeNull();
  expect(tokenCounts({ input_tokens: 3 })).toBeNull();
});

test('transcription estimate uses the most expensive cloud provider in the chain and stays unknown without duration', () => {
  const config = aiConfigSchema.parse({ transcriptionEngine: 'openai', transcriptionModel: 'gpt-4o-mini-transcribe' });
  expect(estimateTranscription(config, { durationSeconds: 120, fileBytes: 1000 })).toMatchObject({ usd: 0.006, local: false, currency: 'USD', unknownReason: null });
  expect(estimateTranscription(config, { durationSeconds: null, fileBytes: 1000 }).usd).toBeNull();
  expect(estimateTranscription({ ...config, transcriptionFallback: ['deepgram'] }, { durationSeconds: 120, fileBytes: 1000 }).usd).toBeNull();
  expect(estimateTranscription(aiConfigSchema.parse({}), { durationSeconds: null, fileBytes: null })).toMatchObject({ usd: 0, local: true });
  // Chunked audio bills the overlap too: a 25 MB+ file over 20 minutes is three chunks with two 2 s overlaps.
  const chunked = estimateTranscription({ ...config, transcriptionModel: 'whisper-1' }, { durationSeconds: 1500, fileBytes: 30_000_000 });
  expect(chunked.billedSeconds).toBe(1504);
});

test('gate requires confirmation over the threshold, over the budget, or when unknown with limits set', () => {
  const db = database({ monthlyBudgetUsd: 1, confirmAboveUsd: 0.5 });
  expect(costGate(db, 0.1, false).required).toBe(false);
  expect(costGate(db, 0.6, false).reasons.join(' ')).toContain('threshold');
  expect(costGate(db, null, false).required).toBe(true);
  expect(costGate(db, 5, true).required).toBe(false);
  recordSpend(db, { id: 'a', jobId: 'job', task: 'transcription', provider: 'openai', model: 'whisper-1', estimatedUsd: 0.95, basis: 'audio-seconds', units: 60, usage: null, status: 'estimated' });
  expect(costGate(db, 0.1, false).reasons.join(' ')).toContain('budget');
  expect(costGate(database(), null, false).required).toBe(false);
  db.close();
});

test('ledger reports month-to-date estimates, excludes unsent work and counts unknown entries', () => {
  const db = database({ monthlyBudgetUsd: 10 });
  const now = new Date();
  recordSpend(db, { id: 'a', jobId: 'one', task: 'transcription', provider: 'openai', model: 'whisper-1', estimatedUsd: 0.5, basis: 'audio-seconds', units: 300, usage: null, status: 'estimated' }, now);
  recordSpend(db, { id: 'b', jobId: 'two', task: 'transcription', provider: 'openai', model: 'whisper-1', estimatedUsd: 2, basis: 'audio-seconds', units: 300, usage: null, status: 'estimated' }, now);
  recordSpend(db, { id: 'old', jobId: 'three', task: 'transcription', provider: 'openai', model: 'whisper-1', estimatedUsd: 9, basis: 'audio-seconds', units: 300, usage: null, status: 'complete' }, new Date(Date.UTC(2000, 0, 1)));
  settleSpend(db, 'a', 'complete', { seconds: 300 });
  settleSpend(db, 'b', 'not-sent');
  recordTextSpend(db, 'analysis', 'mistral', 'mistral-small-latest', { prompt_tokens: 5, completion_tokens: 5 });
  recordTextSpend(db, 'analysis', 'ollama', 'llama3', { input_tokens: 5, output_tokens: 5 });
  const spent = monthToDate(db, now);
  expect(spent).toMatchObject({ estimatedUsd: 0.5, unknownEntries: 1, entries: 2, budgetUsd: 10, remainingUsd: 9.5, currency: 'USD' });
  expect(spent.label).toContain('not enforced by the provider');
  expect(JSON.parse((db.query("SELECT reported_usage AS usage FROM ai_spend_ledger WHERE id='a'").get() as { usage: string }).usage)).toEqual({ seconds: 300 });
  db.close();
});

test('recording estimates use stored duration and flag batches that need confirmation', () => {
  const db = database({ confirmAboveUsd: 0.05 });
  db.query('INSERT INTO recordings VALUES(?,?,?,?)').run('11111111-1111-4111-8111-111111111111', 600, '/nonexistent/a.mp3', 1000);
  db.query('INSERT INTO recordings VALUES(?,?,?,?)').run('22222222-2222-4222-8222-222222222222', null, '/nonexistent/b.mp3', 1000);
  const config = aiConfigSchema.parse({ transcriptionEngine: 'openai', confirmAboveUsd: 0.05 });
  const one = estimateRecordings(db, ['11111111-1111-4111-8111-111111111111'], config);
  expect(one).toMatchObject({ totalUsd: 0.06, unknownCount: 0, confirmationRequired: true });
  const both = estimateRecordings(db, ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'], config);
  expect(both.totalUsd).toBeNull(); expect(both.unknownCount).toBe(1); expect(both.confirmationRequired).toBe(true);
  expect(estimateRecordings(db, ['11111111-1111-4111-8111-111111111111'], aiConfigSchema.parse({})).confirmationRequired).toBe(false);
  db.close();
});

test('capabilities validate documented languages only and report timestamp granularity per model', () => {
  expect(() => validateSpeechOptions('mistral', { language: 'ja' })).toThrow('does not document support');
  expect(() => validateSpeechOptions('mistral', { language: 'fr' })).not.toThrow();
  expect(() => validateSpeechOptions('openai', { model: 'whisper-1', language: 'pt-BR' })).not.toThrow();
  expect(() => validateSpeechOptions('deepgram', { language: 'xx' })).not.toThrow();
  expect(() => validateSpeechOptions('whisper', { language: 'auto' })).not.toThrow();
  expect(speechLanguages('assemblyai')).toBeNull();
  expect(timestampGranularity('openai', 'gpt-4o-transcribe')).toBe('none');
  expect(timestampGranularity('deepgram', 'nova-3')).toBe('word');
  expect(timestampGranularity('assemblyai', null, false)).toBe('none');
  expect(timestampGranularity('assemblyai', null, true)).toBe('segment');
});

test('batch estimates read every recording in one query, and an unknown id stays unknown', async () => {
  const { countQueries } = await import('../testing/count-queries');
  const db = database();
  const ids = Array.from({ length: 40 }, (_, i) => `rec-${i}`);
  for (const id of ids) db.query('INSERT INTO recordings VALUES(?,?,?,?)').run(id, 60, '/nonexistent/x.mp3', 1000);
  const config = aiConfigSchema.parse({ transcriptionEngine: 'openai' });
  const small = await countQueries(db, () => estimateRecordings(db, ids.slice(0, 1), config));
  const large = await countQueries(db, () => estimateRecordings(db, [...ids, 'missing'], config));
  expect(large.count).toBe(small.count);
  expect(large.result.items.map(item => item.recordingId)).toEqual([...ids, 'missing']);
  expect(large.result.unknownCount).toBe(1);
  db.close();
});
