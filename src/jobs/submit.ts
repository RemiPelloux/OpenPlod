import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { aiConfigSchema, assertPrivacy, isLocalProvider, readAiConfig, type AiConfig } from '../ai/config';
import { validateEffective } from '../ai/transcription-profiles';
import { estimateRecordings } from '../ai/spending';
import type { Job, JobQueue } from './queue';

/**
 * Submitting processing jobs with client idempotency (roadmap KB-06).
 *
 * A client may send an `Idempotency-Key` (1-128 visible ASCII characters) on job
 * creation. The first request with a key creates the job; a retry with the same
 * key and the same request returns that same job, whatever its state, and never
 * queues a second paid call. The same key with a different request is a 409.
 */
export class JobSubmitError extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly code: string, message: string, readonly data?: unknown) { super(message); }
}
const fail = (status: JobSubmitError['status'], code: string, message: string, data?: unknown): never => { throw new JobSubmitError(status, code, message, data); };
export const idempotencyKeySchema = z.string().regex(/^[\x21-\x7e]{1,128}$/, 'Idempotency-Key must be 1-128 visible ASCII characters');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Only transcription settings can be overridden per job; analysis and chat routing stay as configured. */
export function transcriptionOverrides(value: unknown): Partial<AiConfig> {
  const overrides = value ?? {};
  if (typeof overrides !== 'object' || Array.isArray(overrides) || Object.keys(overrides).some(key => !key.startsWith('transcription')))
    fail(400, 'invalid_options', 'Only transcription options can be overridden.');
  return overrides as Partial<AiConfig>;
}

export interface TranscriptionPlan {
  recordingId: string; provider: string; model: string | null; profile: string | null;
  /** True when audio stays on this computer (Whisper.cpp). */
  local: boolean;
  /** A cloud provider receives the audio and may bill for it; MCP and API clients must confirm this. */
  requiresCloudConsent: boolean;
}

/** Resolve what a transcription job would do, without queueing it or contacting a provider. */
export function planTranscription(database: Database, recordingId: string, requested: unknown = {}): { config: AiConfig; filePath: string; plan: TranscriptionPlan } {
  const overrides = transcriptionOverrides(requested);
  const recording = database.query('SELECT file_path AS filePath, retention_state AS retentionState FROM recordings WHERE id=?').get(recordingId) as { filePath: string; retentionState: string } | null;
  if (!recording || recording.retentionState !== 'active') fail(404, 'recording_not_found', 'Active recording not found.');
  let config: AiConfig, engine: AiConfig['transcriptionEngine'], model: string | null, profile: string | null;
  try {
    config = aiConfigSchema.parse({ ...readAiConfig(database), ...overrides });
    const resolved = validateEffective(database, config);
    assertPrivacy(readAiConfig(database), resolved.config.transcriptionEngine);
    engine = resolved.config.transcriptionEngine; model = resolved.config.transcriptionModel || null; profile = resolved.profile?.name ?? null;
  } catch (error) {
    const known = error instanceof Error && /profile|does not (support|accept)|Unsupported|Local-only/.test(error.message);
    return fail(400, 'invalid_options', known ? (error as Error).message : 'Invalid or privacy-blocked transcription options.');
  }
  const local = isLocalProvider(config, engine);
  return { config, filePath: recording!.filePath, plan: { recordingId, provider: engine, model, profile, local, requiresCloudConsent: !local } };
}

export function initializeJobRequests(database: Database) {
  database.exec('CREATE TABLE IF NOT EXISTS job_requests (idempotency_key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, job_id TEXT NOT NULL, created_at TEXT NOT NULL)');
}

/**
 * Queue a transcription of an active recording. Refuses (409) while another
 * transcription of the same recording is queued or running, since the queue
 * would otherwise hand back that job and silently drop these options.
 */
export async function submitTranscription(database: Database, queue: JobQueue, input: { recordingId: string; overrides?: unknown; idempotencyKey?: string | null; confirmCost?: boolean; expectedCustomEndpoint?: unknown; expectedProvider?: unknown }): Promise<{ job: Job; plan: TranscriptionPlan; replayed: boolean }> {
  const overrides = transcriptionOverrides(input.overrides);
  const key = input.idempotencyKey ? idempotencyKeySchema.parse(input.idempotencyKey) : null;
  const requestHash = hash({ type: 'process-recording', recordingId: input.recordingId, overrides, expectedProvider: input.expectedProvider, expectedCustomEndpoint: input.expectedCustomEndpoint });
  if (key) {
    initializeJobRequests(database);
    const existing = database.query('SELECT request_hash AS hash, job_id AS jobId FROM job_requests WHERE idempotency_key=?').get(key) as { hash: string; jobId: string } | null;
    if (existing) {
      if (existing.hash !== requestHash) fail(409, 'idempotency_conflict', 'This Idempotency-Key was already used for a different request.');
      const job = queue.getJob(existing.jobId);
      if (!job) fail(409, 'idempotency_expired', 'The job for this Idempotency-Key is no longer retained. Use a new key to submit again.');
      return { job: job!, plan: planTranscription(database, input.recordingId, overrides).plan, replayed: true };
    }
  }
  const { config, filePath, plan } = planTranscription(database, input.recordingId, overrides);
  if (input.expectedProvider !== undefined && input.expectedProvider !== plan.provider) {
    fail(409, 'transcription_provider_changed', 'The transcription provider changed. Review the destination and confirm again.');
  }
  if (input.expectedCustomEndpoint !== undefined && input.expectedCustomEndpoint !== config.customBaseUrl) {
    fail(409, 'custom_endpoint_changed', 'The custom endpoint changed. Review the destination and confirm again.');
  }
  if (queue.activeJob('process-recording', input.recordingId)) fail(409, 'job_active', 'This recording is already being processed. Cancel that job before reprocessing.');
  // AI-10: an estimate over the per-job threshold or the remaining budget needs explicit confirmation.
  const costConfirmed = input.confirmCost === true;
  if (!costConfirmed) {
    const cost = estimateRecordings(database, [input.recordingId], config);
    if (cost.confirmationRequired) fail(409, 'cost_confirmation_required', `Confirm the estimated cost first. ${cost.reasons.join(' ')}`, cost);
  }
  database.query("UPDATE recordings SET status='pending', error_message=NULL, processed_at=NULL WHERE id=?").run(input.recordingId);
  const job = await queue.add('process-recording', { recordingId: input.recordingId, filePath, config, expectedProvider: plan.provider, ...(costConfirmed ? { costConfirmed: true } : {}) });
  if (key) database.query('INSERT OR IGNORE INTO job_requests(idempotency_key, request_hash, job_id, created_at) VALUES(?,?,?,?)').run(key, requestHash, job.id, new Date().toISOString());
  return { job, plan, replayed: false };
}
