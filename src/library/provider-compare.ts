import type { Database } from 'bun:sqlite';
import { aiConfigSchema, assertPrivacy, readAiConfig, readSettings, sameCustomEndpoint, speechProviders, type AiConfig, type SpeechProvider } from '../ai/config';
import { omitsTranscriptionHints, speechCapabilities, validateSpeechOptions } from '../ai/capabilities';
import type { Job, JobContext, JobQueue } from '../jobs/queue';
import { TranscriptionRouter } from '../transcription/router';
import type { TranscriptionOptions, TranscriptionResult } from '../transcription/types';

/**
 * Compare two transcription providers on the same recording (roadmap TS-11).
 *
 * A comparison is an explicit second paid run, so it is shaped to be
 * impossible to trigger by accident and impossible to mistake for a normal
 * reprocess:
 *
 *  - It needs `confirm: true`; the UI asks the person to acknowledge that the
 *    audio is uploaded again to the chosen provider and may be billed.
 *  - It runs the chosen provider only. Fallback is disabled, so the version is
 *    never silently produced by a different provider than the one compared.
 *  - Its result is an independent transcript version. It never becomes the
 *    current transcript and never changes the recording's status or revision;
 *    promoting it is the ordinary, explicit "Make current" action.
 *  - It is queued as a `process-recording` job with its own dedupe key, so it
 *    can run alongside (not instead of) the recording's normal processing job,
 *    and a double click cannot queue the same comparison twice.
 */

export class ComparisonError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}

export const comparisonKey = (recordingId: string, provider: string) => `compare:${recordingId}:${provider}`;

export interface ComparisonRequest { provider?: unknown; model?: unknown; confirm?: unknown }

export interface ComparisonJobData {
  recordingId: string;
  filePath: string;
  config: AiConfig;
  fingerprint?: string | null;
  compare: { provider: SpeechProvider; ignoredHints: string[] };
}

export interface ComparisonStatus {
  jobId: string;
  provider: string;
  status: Job['status'];
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  /** The independent version this run produced, once it exists. */
  versionId: string | null;
}

/** Validate a request and build the exact configuration the run will use. */
export function prepareComparison(database: Database, recordingId: string, input: ComparisonRequest,
  available: Record<SpeechProvider, boolean>): Omit<ComparisonJobData, 'fingerprint'> {
  const recording = database.query("SELECT file_path AS filePath FROM recordings WHERE id = ? AND retention_state = 'active'")
    .get(recordingId) as { filePath: string } | null;
  if (!recording) throw new ComparisonError(404, 'Active recording not found.');
  if (!database.query('SELECT 1 FROM transcripts WHERE recording_id = ?').get(recordingId)) {
    throw new ComparisonError(409, 'Transcribe this recording before comparing providers.');
  }
  const provider = input.provider;
  if (typeof provider !== 'string' || !(speechProviders as readonly string[]).includes(provider)) {
    throw new ComparisonError(400, 'Choose a transcription provider to compare.');
  }
  const engine = provider as SpeechProvider;
  if (input.confirm !== true) {
    throw new ComparisonError(400, 'Confirm that the audio is sent again to this provider and may be billed.');
  }
  if (!available[engine]) throw new ComparisonError(400, `${speechCapabilities[engine].label} is not configured.`);
  const base = readAiConfig(database);
  try { assertPrivacy(base, engine); } catch (error) { throw new ComparisonError(400, (error as Error).message); }

  const capabilities = speechCapabilities[engine];
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  const ignoresContext = omitsTranscriptionHints(engine, base.transcriptionDiarize);
  // Hints the second provider cannot take are left out and recorded, never sent half-supported.
  const ignoredHints: string[] = [];
  const keep = <T>(value: T, empty: T, supported: boolean, name: string, present: boolean): T => {
    if (!present || supported) return value;
    ignoredHints.push(name); return empty;
  };
  const config: AiConfig = aiConfigSchema.parse({
    ...base, transcriptionEngine: engine, transcriptionModel: model, transcriptionFallback: [], transcriptionProfile: '',
    transcriptionDiarize: keep(base.transcriptionDiarize, false, capabilities.diarization, 'speaker labels', base.transcriptionDiarize),
    transcriptionVocabulary: keep(base.transcriptionVocabulary, [], capabilities.vocabulary && !ignoresContext, 'vocabulary', base.transcriptionVocabulary.length > 0),
    transcriptionPrompt: keep(base.transcriptionPrompt, '', capabilities.prompt && !ignoresContext, 'prompt', Boolean(base.transcriptionPrompt.trim())),
  });
  try { validateSpeechOptions(engine, optionsFor(config)); } catch (error) { throw new ComparisonError(400, (error as Error).message); }
  return { recordingId, filePath: recording.filePath, config, compare: { provider: engine, ignoredHints } };
}

const optionsFor = (config: AiConfig): TranscriptionOptions => ({
  model: config.transcriptionModel || undefined, language: config.transcriptionLanguage, diarize: config.transcriptionDiarize,
  vocabulary: config.transcriptionVocabulary, ...(config.transcriptionPrompt ? { prompt: config.transcriptionPrompt } : {}),
});

/** Queue a comparison run. A second request for the same provider returns the queued one. */
export async function queueComparison(queue: JobQueue, database: Database, recordingId: string, input: ComparisonRequest,
  available: Record<SpeechProvider, boolean>): Promise<{ job: Job; alreadyQueued: boolean }> {
  const data = prepareComparison(database, recordingId, input, available);
  const key = comparisonKey(recordingId, data.compare.provider);
  const before = queue.getAllJobs().find(job => job.dedupeKey === key && ['pending', 'running'].includes(job.status));
  const job = await queue.add('process-recording', data, 0, { dedupeKey: key });
  return { job, alreadyQueued: before?.id === job.id };
}

/** Comparison runs for a recording, newest first. */
export function listComparisons(queue: JobQueue, database: Database, recordingId: string): ComparisonStatus[] {
  const prefix = comparisonKey(recordingId, '');
  const jobs = queue.getAllJobs().filter(job => job.dedupeKey?.startsWith(prefix)).slice().reverse().slice(0, 20);
  const ids = jobs.map(job => job.id);
  const versions = new Set(ids.length
    ? (database.query('SELECT id FROM transcript_versions WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as { id: string }[]).map(row => row.id)
    : []);
  return jobs.map(job => ({
    jobId: job.id, provider: (job.data as ComparisonJobData).compare?.provider ?? job.dedupeKey!.slice(prefix.length),
    status: job.status, error: job.error ?? null, createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null, versionId: versions.has(job.id) ? job.id : null,
  }));
}

export type ComparisonTranscriber = (filePath: string, config: AiConfig, options: TranscriptionOptions) => Promise<TranscriptionResult>;

/** The real transcriber: the chosen provider only, with no fallback. */
export const routerTranscriber = (database: Database): ComparisonTranscriber => (filePath, config, options) => {
  const settings = readSettings(database);
  const currentConfig = readAiConfig(database);
  const router = new TranscriptionRouter({
    primary: config.transcriptionEngine, fallback: [],
    localOnly: currentConfig.privacyMode === 'local-only' || config.privacyMode === 'local-only',
    beforeAttempt: provider => assertPrivacy(readAiConfig(database), provider),
  }, { mistralApiKey: settings.mistralApiKey, deepgramApiKey: settings.deepgramApiKey, openaiApiKey: settings.openaiApiKey, assemblyaiApiKey: settings.assemblyaiApiKey, customApiKey: sameCustomEndpoint(config.customBaseUrl, currentConfig.customBaseUrl) ? settings.customApiKey : undefined, customBaseUrl: config.customBaseUrl });
  return router.transcribeFile(filePath, options);
};

/**
 * The job handler for a comparison run. Saves one independent version under
 * the job's ID (so a resumed job cannot save twice) and touches nothing else.
 */
export async function runComparison(database: Database, raw: ComparisonJobData, job: JobContext,
  transcribe: ComparisonTranscriber = routerTranscriber(database)): Promise<void> {
  const { recordingId, filePath } = raw;
  const config = aiConfigSchema.parse(raw.config);
  const provider = raw.compare.provider;
  if (config.transcriptionEngine !== provider) throw new Error('Comparison configuration does not match the requested provider.');
  const unchanged = () => {
    const recording = database.query("SELECT fingerprint FROM recordings WHERE id = ? AND retention_state = 'active'")
      .get(recordingId) as { fingerprint: string | null } | null;
    if (!recording || recording.fingerprint !== (raw.fingerprint ?? null)) throw new Error('Recording is unavailable or its audio changed.');
  };
  unchanged();
  if (database.query('SELECT 1 FROM transcript_versions WHERE id = ?').get(job.id)) return;
  assertPrivacy(readAiConfig(database), provider);

  const startedAt = new Date().toISOString();
  const options = optionsFor(config);
  const result = await transcribe(filePath, config, { ...options, signal: job.signal, checkpoint: job.checkpoint, onCheckpoint: job.saveCheckpoint });
  job.signal.throwIfAborted();
  if (!result.success) throw new Error(result.error || `${provider} transcription failed.`);
  // A result from any other engine is not a comparison of this provider.
  if (result.engine !== provider) throw new Error(`Expected a ${provider} transcript but received ${result.engine}. Nothing was saved.`);

  database.transaction(() => {
    unchanged();
    if (database.query('SELECT 1 FROM transcript_versions WHERE id = ?').get(job.id)) return;
    const provenance = {
      provider: result.engine, model: result.metadata?.model ?? null, comparison: true, fingerprint: raw.fingerprint ?? null,
      options: { ...options, ...(raw.compare.ignoredHints.length ? { ignoredHints: raw.compare.ignoredHints } : {}) },
      startedAt, completedAt: new Date().toISOString(), usage: result.metadata?.usage ?? null, language: result.metadata?.language ?? null,
    };
    database.query(`INSERT INTO transcript_versions(id, recording_id, full_text, segments, origin, provenance, created_at)
      VALUES(?,?,?,?,?,?,?)`).run(job.id, recordingId, result.fullText, JSON.stringify(result.segments ?? null), 'generated',
      JSON.stringify(provenance), new Date().toISOString());
  })();
}
