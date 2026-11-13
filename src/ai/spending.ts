import type { Database } from 'bun:sqlite';
import { isLocalProvider, readAiConfig, type AiConfig, type SpeechProvider, type TextProvider } from './config';
import { estimateSpeechUsd, estimateTextUsd, PRICE_LABEL, PRICES_AS_OF } from './pricing';
import { chunkPlan } from '../transcription/long-audio';
import { effectiveTranscription } from './transcription-profiles';

/**
 * Cloud spending estimates, ledger and confirmation gate (AI-10).
 *
 * Everything here is OpenPlod's own estimate from documented list prices. No
 * provider is told about the budget, so it is a confirmation threshold, not a
 * cap: work the user confirms can still exceed it, and a provider may bill
 * differently. Months are calendar months in UTC.
 */
export type SpendStatus = 'estimated' | 'complete' | 'failed' | 'cancelled' | 'not-sent';
export interface SpendEntry { id: string; jobId: string | null; task: string; provider: string; model: string | null; estimatedUsd: number | null; basis: 'audio-seconds' | 'reported-tokens' | 'unknown'; units: number | null; usage: Record<string, number> | null; status: SpendStatus }
export interface CostEstimate { usd: number | null; currency: 'USD'; label: string; pricesAsOf: string; durationSeconds: number | null; billedSeconds: number | null; provider: string; model: string | null; local: boolean; unknownReason: string | null }

export function initializeSpendLedger(database: Database) {
  database.exec(`CREATE TABLE IF NOT EXISTS ai_spend_ledger (
    id TEXT PRIMARY KEY, job_id TEXT, task TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, month TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, estimated_usd REAL, basis TEXT NOT NULL, units REAL,
    reported_usage TEXT, status TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_ai_spend_month ON ai_spend_ledger(month);`);
}
export const monthOf = (date: Date) => date.toISOString().slice(0, 7);

/** Insert or update one ledger row. Local providers are never recorded: they are not cloud spend. */
export function recordSpend(database: Database, entry: SpendEntry, now = new Date()) {
  initializeSpendLedger(database);
  const at = now.toISOString();
  database.query(`INSERT INTO ai_spend_ledger(id,job_id,task,provider,model,month,created_at,updated_at,estimated_usd,basis,units,reported_usage,status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET estimated_usd=excluded.estimated_usd, basis=excluded.basis, units=excluded.units,
    reported_usage=COALESCE(excluded.reported_usage, reported_usage), status=excluded.status, provider=excluded.provider, model=excluded.model, updated_at=excluded.updated_at`)
    .run(entry.id, entry.jobId, entry.task, entry.provider, entry.model, monthOf(now), at, at, entry.estimatedUsd, entry.basis, entry.units, entry.usage ? JSON.stringify(entry.usage) : null, entry.status);
}

export function settleSpend(database: Database, id: string, status: SpendStatus, usage: Record<string, number> | null = null) {
  initializeSpendLedger(database);
  database.query('UPDATE ai_spend_ledger SET status=?, reported_usage=COALESCE(?, reported_usage), updated_at=? WHERE id=?').run(status, usage ? JSON.stringify(usage) : null, new Date().toISOString(), id);
}

/** Record a finished text request (called by `completeText` through the selection's ledger hook). */
export function recordTextSpend(database: Database, task: string, provider: TextProvider, model: string, usage: Record<string, number> | null) {
  if (isLocalProvider(readAiConfig(database), provider)) return;
  const usd = estimateTextUsd(provider, model, usage);
  recordSpend(database, { id: crypto.randomUUID(), jobId: null, task, provider, model, estimatedUsd: usd, basis: usd === null ? 'unknown' : 'reported-tokens', units: null, usage, status: 'complete' });
}

/** Month-to-date estimated cloud spend. Entries that were never sent are excluded; unknown estimates are counted, not guessed. */
export function monthToDate(database: Database, now = new Date()) {
  initializeSpendLedger(database);
  const month = monthOf(now);
  const row = database.query(`SELECT COALESCE(SUM(estimated_usd),0) AS usd, SUM(estimated_usd IS NULL) AS unknown, COUNT(*) AS entries
    FROM ai_spend_ledger WHERE month=? AND status<>'not-sent'`).get(month) as { usd: number; unknown: number | null; entries: number };
  const config = readAiConfig(database);
  return { month, currency: 'USD' as const, estimatedUsd: Math.round(row.usd * 1_000_000) / 1_000_000, unknownEntries: row.unknown ?? 0, entries: row.entries,
    budgetUsd: config.monthlyBudgetUsd, remainingUsd: config.monthlyBudgetUsd === null ? null : Math.max(0, config.monthlyBudgetUsd - row.usd),
    confirmAboveUsd: config.confirmAboveUsd, label: PRICE_LABEL, pricesAsOf: PRICES_AS_OF };
}

/**
 * Estimate one transcription. With fallbacks configured the most expensive cloud
 * provider in the chain is used, and any unknown price makes the estimate unknown.
 */
export function estimateTranscription(config: AiConfig, input: { durationSeconds: number | null; fileBytes: number | null; model?: string | null; diarize?: boolean }): CostEstimate {
  const chain = [...new Set([config.transcriptionEngine, ...config.transcriptionFallback])] as SpeechProvider[];
  const primary = chain[0], duration = input.durationSeconds && input.durationSeconds > 0 ? input.durationSeconds : null;
  const base = { currency: 'USD' as const, label: PRICE_LABEL, pricesAsOf: PRICES_AS_OF, durationSeconds: duration, provider: primary, model: input.model ?? (config.transcriptionModel || null) };
  const cloud = chain.filter(provider => !isLocalProvider(config, provider));
  if (!cloud.length) return { ...base, usd: 0, billedSeconds: duration, local: true, unknownReason: null };
  if (duration === null) return { ...base, usd: null, billedSeconds: null, local: false, unknownReason: 'The recording duration is unknown.' };
  let usd = 0, billed = duration;
  for (const provider of cloud) {
    const plan = chunkPlan(provider, { durationSeconds: duration, fileBytes: input.fileBytes, chunkAboveMinutes: config.transcriptionChunkAboveMinutes });
    const seconds = plan ? plan.reduce((sum, chunk) => sum + chunk.duration, 0) : duration;
    const cost = estimateSpeechUsd(provider, provider === primary ? base.model : null, seconds);
    if (cost === null) return { ...base, usd: null, billedSeconds: null, local: false, unknownReason: `No documented price for ${provider}${provider === primary && base.model ? ` ${base.model}` : ''}.` };
    if (cost >= usd) { usd = cost; billed = seconds; }
  }
  return { ...base, usd, billedSeconds: billed, local: false, unknownReason: null };
}

/**
 * Whether a cloud job needs explicit cost confirmation: its estimate exceeds the
 * per-job threshold, or would take month-to-date spend over the budget. With a
 * threshold or budget set, an unknown estimate also needs confirmation, because
 * it cannot be checked. Without either setting nothing extra is asked.
 */
export function costGate(database: Database, estimateUsd: number | null, local: boolean, now = new Date()) {
  const spent = monthToDate(database, now), reasons: string[] = [];
  if (!local) {
    if (spent.confirmAboveUsd !== null) {
      if (estimateUsd === null) reasons.push('The cost of this job cannot be estimated.');
      else if (estimateUsd > spent.confirmAboveUsd) reasons.push(`The estimate exceeds your per-job confirmation threshold of $${spent.confirmAboveUsd}.`);
    }
    if (spent.budgetUsd !== null) {
      if (estimateUsd === null) { if (!reasons.length) reasons.push('The cost of this job cannot be estimated against your monthly budget.'); }
      else if (spent.estimatedUsd + estimateUsd > spent.budgetUsd) reasons.push(`This would take estimated spend this month over your $${spent.budgetUsd} budget.`);
    }
  }
  return { required: reasons.length > 0, reasons, monthToDate: spent };
}

/** Recording duration and file size for an estimate; unknown values stay null. */
type CostRow = { id: string; duration: number | null; filePath: string | null; fileSize: number | null };
type CostInput = { durationSeconds: number | null; fileBytes: number | null; filePath: string | null };
const COST_COLUMNS = 'id, duration_seconds AS duration, file_path AS filePath, file_size_bytes AS fileSize';
const costInput = (row: CostRow | null | undefined): CostInput =>
  ({ durationSeconds: row?.duration && row.duration > 0 ? row.duration : null, fileBytes: row?.fileSize && row.fileSize > 0 ? row.fileSize : null, filePath: row?.filePath ?? null });

export function recordingCostInput(database: Database, recordingId: string): CostInput {
  return costInput(database.query(`SELECT ${COST_COLUMNS} FROM recordings WHERE id=?`).get(recordingId) as CostRow | null);
}

/** Cost inputs for many recordings in one query. */
function recordingCostInputs(database: Database, recordingIds: string[]): Map<string, CostInput> {
  const rows = database.query(`SELECT ${COST_COLUMNS} FROM recordings WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(recordingIds)) as CostRow[];
  return new Map(rows.map(row => [row.id, costInput(row)]));
}

/**
 * Estimate a set of recordings with one configuration (profile applied) and say
 * whether running them needs cost confirmation. Used by single and batch flows.
 */
export function estimateRecordings(database: Database, recordingIds: string[], requested: AiConfig) {
  const { config, options } = effectiveTranscription(database, requested);
  const inputs = recordingCostInputs(database, recordingIds);
  const items = recordingIds.map(recordingId => {
    const input = inputs.get(recordingId) ?? costInput(null);
    let fileBytes = input.fileBytes;
    try { if (input.filePath) { const size = Bun.file(input.filePath).size; if (size > 0) fileBytes = size; } } catch { /* stored size stays */ }
    const estimate = estimateTranscription(config, { durationSeconds: input.durationSeconds, fileBytes, model: options.model ?? null, diarize: options.diarize });
    return { recordingId, ...estimate };
  });
  const local = items.every(item => item.local), unknown = items.filter(item => item.usd === null).length;
  const totalUsd = unknown ? null : Math.round(items.reduce((sum, item) => sum + (item.usd ?? 0), 0) * 1_000_000) / 1_000_000;
  const gate = costGate(database, totalUsd, local);
  // A single job over the threshold needs confirmation even when only the batch total is checked.
  const threshold = gate.monthToDate.confirmAboveUsd;
  if (!local && threshold !== null && !gate.required && items.some(item => item.usd !== null && item.usd > threshold)) gate.reasons.push(`At least one recording exceeds your per-job confirmation threshold of $${threshold}.`);
  return { items, totalUsd, unknownCount: unknown, local, currency: 'USD' as const, label: PRICE_LABEL, pricesAsOf: PRICES_AS_OF,
    confirmationRequired: gate.reasons.length > 0, reasons: gate.reasons, monthToDate: gate.monthToDate };
}
