import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { JobQueue, type JobContext } from '../jobs/queue';
import type { SpeechProvider } from '../ai/config';
import {
  ComparisonError, comparisonKey, listComparisons, prepareComparison, queueComparison, runComparison,
  type ComparisonJobData, type ComparisonTranscriber,
} from './provider-compare';

let database: Database;
const recordingId = crypto.randomUUID();
const available: Record<SpeechProvider, boolean> = { custom: false, whisper: false, mistral: true, deepgram: true, openai: false, assemblyai: false };
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

beforeEach(() => {
  database = new Database(':memory:');
  database.exec(`CREATE TABLE recordings(id TEXT PRIMARY KEY, file_path TEXT, fingerprint TEXT, retention_state TEXT, status TEXT, error_message TEXT, revision INTEGER);
    CREATE TABLE transcripts(recording_id TEXT, current_version_id TEXT, full_text TEXT);
    CREATE TABLE transcript_versions(id TEXT PRIMARY KEY, recording_id TEXT, full_text TEXT, segments TEXT, origin TEXT, provenance TEXT, created_at TEXT);
    CREATE TABLE user_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  database.query('INSERT INTO recordings VALUES(?,?,?,?,?,?,?)').run(recordingId, '/vault/a.wav', 'fp-1', 'active', 'complete', null, 3);
  database.query('INSERT INTO transcripts VALUES(?,?,?)').run(recordingId, 'v-current', 'Original text.');
  database.query('INSERT INTO user_settings VALUES(?,?)').run('aiConfig', JSON.stringify({
    transcriptionEngine: 'mistral', transcriptionDiarize: false, transcriptionVocabulary: ['OpenPlod'], transcriptionLanguage: 'fr',
  }));
});
afterEach(() => database.close());

const context = (id: string, signal = new AbortController().signal): JobContext => ({ id, signal, saveCheckpoint: () => {} });
const success = (engine: string): ComparisonTranscriber => async () => ({
  success: true, engine, fullText: 'Deepgram text.', segments: [{ start: 0, end: 2, text: 'Deepgram text.', speaker: 0, confidence: 0.9 }],
  wordCount: 2, speakerCount: 1, confidence: 0.9, duration: 2, metadata: { model: 'nova-3' },
});
const data = (): ComparisonJobData => ({ ...prepareComparison(database, recordingId, { provider: 'deepgram', confirm: true }, available), fingerprint: 'fp-1' });

describe('comparison requests', () => {
  test('require explicit confirmation that audio is sent again', () => {
    expect(() => prepareComparison(database, recordingId, { provider: 'deepgram' }, available)).toThrow('sent again');
  });

  test('refuse unknown, unconfigured or privacy-blocked providers', () => {
    expect(() => prepareComparison(database, recordingId, { provider: 'nope', confirm: true }, available)).toThrow('Choose');
    expect(() => prepareComparison(database, recordingId, { provider: 'openai', confirm: true }, available)).toThrow('not configured');
    database.query('UPDATE user_settings SET value = ? WHERE key = ?').run(JSON.stringify({ privacyMode: 'local-only' }), 'aiConfig');
    expect(() => prepareComparison(database, recordingId, { provider: 'deepgram', confirm: true }, available)).toThrow('Local-only');
  });

  test('need an existing transcript and an active recording', () => {
    database.query('DELETE FROM transcripts').run();
    expect(() => prepareComparison(database, recordingId, { provider: 'deepgram', confirm: true }, available)).toThrow('Transcribe');
    database.query("UPDATE recordings SET retention_state = 'trash'").run();
    const error = (() => { try { prepareComparison(database, recordingId, { provider: 'deepgram', confirm: true }, available); } catch (failure) { return failure; } })();
    expect(error).toBeInstanceOf(ComparisonError);
    expect((error as ComparisonError).status).toBe(404);
  });

  test('run only the chosen provider and drop hints it cannot take, recording what was dropped', () => {
    const mistral = prepareComparison(database, recordingId, { provider: 'mistral', confirm: true }, available);
    expect(mistral.config).toMatchObject({ transcriptionEngine: 'mistral', transcriptionFallback: [], transcriptionProfile: '', transcriptionVocabulary: [], transcriptionLanguage: 'fr' });
    expect(mistral.compare.ignoredHints).toEqual(['vocabulary']);
    const deepgram = prepareComparison(database, recordingId, { provider: 'deepgram', model: 'nova-3', confirm: true }, available);
    expect(deepgram.config).toMatchObject({ transcriptionModel: 'nova-3', transcriptionVocabulary: ['OpenPlod'] });
    expect(() => prepareComparison(database, recordingId, { provider: 'deepgram', model: 'gpt-4o', confirm: true }, available)).toThrow('Unsupported');
  });

  test('compare with a discovered custom model and record hints omitted by diarization', () => {
    database.query('UPDATE user_settings SET value = ? WHERE key = ?').run(JSON.stringify({
      customBaseUrl: 'http://127.0.0.1:8000/v1', transcriptionDiarize: true,
      transcriptionVocabulary: ['OpenPlod'], transcriptionPrompt: 'Meeting context',
    }), 'aiConfig');
    const prepared = prepareComparison(database, recordingId, { provider: 'custom', model: 'VibeVoice-ASR', confirm: true }, { ...available, custom: true });
    expect(prepared.config).toMatchObject({
      transcriptionModel: 'VibeVoice-ASR', transcriptionDiarize: true, transcriptionPrompt: '', transcriptionVocabulary: [],
    });
    expect(prepared.compare.ignoredHints).toEqual(['vocabulary', 'prompt']);
  });
});

describe('queueing', () => {
  test('a comparison runs alongside the normal processing job and is deduplicated by its own key', async () => {
    const queue = new JobQueue(database);
    const normal = await queue.add('process-recording', { recordingId, filePath: '/vault/a.wav' });
    const first = await queueComparison(queue, database, recordingId, { provider: 'deepgram', confirm: true }, available);
    const again = await queueComparison(queue, database, recordingId, { provider: 'deepgram', confirm: true }, available);
    expect(first.job.id).not.toBe(normal.id);
    expect(first.alreadyQueued).toBe(false);
    expect(again).toMatchObject({ alreadyQueued: true, job: { id: first.job.id } });
    expect(first.job.dedupeKey).toBe(comparisonKey(recordingId, 'deepgram'));
    // The recording's own processing job is still the one reprocess and batches see.
    expect(queue.activeJob('process-recording', recordingId)?.id).toBe(normal.id);
    // Without a key, a second ordinary job is still deduplicated as before.
    expect((await queue.add('process-recording', { recordingId, filePath: '/vault/a.wav' })).id).toBe(normal.id);
    expect(listComparisons(queue, database, recordingId)).toEqual([expect.objectContaining({ jobId: first.job.id, provider: 'deepgram', status: 'pending', versionId: null })]);
  });

  test('cancelling a comparison leaves the recording status alone', async () => {
    const queue = new JobQueue(database);
    const { job } = await queueComparison(queue, database, recordingId, { provider: 'deepgram', confirm: true }, available);
    expect(queue.cancel(job.id)).toBe(true);
    expect(database.query('SELECT status FROM recordings').get()).toEqual({ status: 'complete' });
  });

  test('an interrupted comparison does not mark the recording failed on restart', async () => {
    const queue = new JobQueue(database);
    const { job } = await queueComparison(queue, database, recordingId, { provider: 'deepgram', confirm: true }, available);
    database.query('UPDATE processing_jobs SET payload = json_set(payload, \'$.status\', \'running\') WHERE id = ?').run(job.id);
    const restarted = new JobQueue(database);
    expect(restarted.getJob(job.id)?.status).toBe('failed');
    expect(database.query('SELECT status FROM recordings').get()).toEqual({ status: 'complete' });
  });
});

describe('running a comparison', () => {
  test('saves an independent version that is never promoted', async () => {
    const id = crypto.randomUUID();
    await runComparison(database, data(), context(id), success('deepgram'));
    const version = database.query('SELECT full_text AS fullText, origin, provenance, segments FROM transcript_versions WHERE id = ?').get(id) as
      { fullText: string; origin: string; provenance: string; segments: string };
    expect(version.fullText).toBe('Deepgram text.');
    expect(version.origin).toBe('generated');
    expect(JSON.parse(version.provenance)).toMatchObject({ provider: 'deepgram', model: 'nova-3', comparison: true, fingerprint: 'fp-1' });
    expect(JSON.parse(version.segments)[0]).toMatchObject({ start: 0, end: 2 });
    expect(database.query('SELECT current_version_id AS id, full_text AS text FROM transcripts').get()).toEqual({ id: 'v-current', text: 'Original text.' });
    expect(database.query('SELECT status, revision FROM recordings').get()).toEqual({ status: 'complete', revision: 3 });
    // A resumed job does not save twice.
    await runComparison(database, data(), context(id), success('deepgram'));
    expect(database.query('SELECT count(*) AS n FROM transcript_versions').get()).toEqual({ n: 1 });
  });

  test('refuses a result from a different engine', async () => {
    await expect(runComparison(database, data(), context(crypto.randomUUID()), success('mistral'))).rejects.toThrow('Nothing was saved');
    expect(database.query('SELECT count(*) AS n FROM transcript_versions').get()).toEqual({ n: 0 });
  });

  test('refuses when the audio changed before or during the run', async () => {
    const job = data();
    database.query("UPDATE recordings SET fingerprint = 'fp-2'").run();
    await expect(runComparison(database, job, context(crypto.randomUUID()), success('deepgram'))).rejects.toThrow('audio changed');
    database.query("UPDATE recordings SET fingerprint = 'fp-1'").run();
    const changing: ComparisonTranscriber = async (...args) => {
      database.query("UPDATE recordings SET fingerprint = 'fp-3'").run();
      return success('deepgram')(...args);
    };
    await expect(runComparison(database, job, context(crypto.randomUUID()), changing)).rejects.toThrow('audio changed');
    expect(database.query('SELECT count(*) AS n FROM transcript_versions').get()).toEqual({ n: 0 });
  });

  test('a provider failure saves nothing and a cancel stops before saving', async () => {
    const failing: ComparisonTranscriber = async () => ({ success: false, engine: 'deepgram', fullText: '', segments: [], wordCount: 0, speakerCount: null, confidence: null, duration: 0, error: 'Deepgram rejected the request.' });
    await expect(runComparison(database, data(), context(crypto.randomUUID()), failing)).rejects.toThrow('Deepgram rejected');
    const controller = new AbortController();
    const cancelling: ComparisonTranscriber = async (...args) => { controller.abort(); return success('deepgram')(...args); };
    await expect(runComparison(database, data(), context(crypto.randomUUID(), controller.signal), cancelling)).rejects.toThrow();
    expect(database.query('SELECT count(*) AS n FROM transcript_versions').get()).toEqual({ n: 0 });
  });

  test('the queue routes a compare job through the comparison handler path', async () => {
    const queue = new JobQueue(database);
    queue.register('process-recording', async (job: ComparisonJobData, ctx) => {
      if (job.compare) return runComparison(database, job, ctx, success('deepgram'));
      throw new Error('normal processing should not run in this test');
    });
    const { job } = await queueComparison(queue, database, recordingId, { provider: 'deepgram', confirm: true }, available);
    for (let attempt = 0; attempt < 50 && queue.getJob(job.id)?.status !== 'complete'; attempt += 1) await tick();
    expect(queue.getJob(job.id)?.status).toBe('complete');
    expect(listComparisons(queue, database, recordingId)[0]).toMatchObject({ status: 'complete', versionId: job.id });
  });
});
