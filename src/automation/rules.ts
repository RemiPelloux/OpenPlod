import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { readAiConfig, speechProviders, type AiConfig } from '../ai/config';
import { speechCapabilities } from '../ai/capabilities';
import { validateEffective } from '../ai/transcription-profiles';
import { DOCUMENT_STYLES, documentTemplate, type DocumentStyle } from '../organizer/document-templates';
import { noteTag } from '../organizer/schemas';
import type { Job } from '../jobs/queue';
import { AutomationError, isLoopbackUrl, localOnly, nowIso, stableId, tableExists } from './common';
import type { WebhookService } from './webhooks';

/**
 * Opt-in automation rules (roadmap KB-09).
 *
 * A rule reacts to a newly imported recording that matches its filters and
 * runs its actions in order. Each step has a stable id derived from (rule,
 * recording, step index): runs are unique per (rule, recording), and every
 * downstream write is keyed by the step id, so retries and restarts never
 * duplicate a transcript job, document, tag, or webhook event.
 *
 * Rules are data the user wrote. Transcript text never selects or changes an
 * action. Every provider or external host a rule would send to must be
 * acknowledged on the rule itself, and both acknowledgement and local-only
 * mode are re-checked when each step runs, not only when the rule is saved.
 */
export const RULE_SOURCES = ['plaud', 'upload', 'mobile'] as const;
export const RECORDING_TYPES = ['class', 'meeting', 'conversation', 'other'] as const;
const identifier = z.string().uuid();
const profileId = z.string().regex(/^[a-zA-Z0-9-]{1,64}$/);

export const triggerSchema = z.object({
  type: z.literal('recording.imported').default('recording.imported'),
  sources: z.array(z.enum(RULE_SOURCES)).max(RULE_SOURCES.length).default([]),
  recordingTypes: z.array(z.enum(RECORDING_TYPES)).max(RECORDING_TYPES.length).default([]),
  tag: noteTag.nullable().default(null),
  minDurationSeconds: z.number().int().min(0).max(86400).nullable().default(null),
}).strict();
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('transcribe'), provider: z.enum(speechProviders).nullable().default(null), profileId: profileId.nullable().default(null) }).strict(),
  z.object({ type: z.literal('generate_document'), template: z.enum(DOCUMENT_STYLES).default('notes'), folderId: identifier.nullable().default(null) }).strict(),
  z.object({ type: z.literal('add_tags'), tags: z.array(noteTag).min(1).max(16) }).strict(),
  z.object({ type: z.literal('add_to_collection'), collectionId: z.string().trim().min(1).max(64) }).strict(),
  z.object({ type: z.literal('notify_webhook'), subscriptionId: identifier }).strict(),
]);
const name = z.string().trim().min(1).max(80).refine(value => !/[\x00-\x1f]/.test(value), 'Use a name without control characters');
/** Acknowledgements read `audio:<provider>`, `text:<provider>` or `webhook:<host>`. */
const acknowledgement = z.string().regex(/^(audio|text|webhook):[a-zA-Z0-9.:\[\]-]{1,255}$/);
export const ruleInputSchema = z.object({
  name, enabled: z.boolean().default(false), trigger: triggerSchema.default({ type: 'recording.imported', sources: [], recordingTypes: [], tag: null, minDurationSeconds: null }),
  actions: z.array(actionSchema).min(1).max(8), acknowledgements: z.array(acknowledgement).max(32).default([]),
}).strict();
export const ruleUpdateSchema = z.object({
  name: name.optional(), enabled: z.boolean().optional(), trigger: triggerSchema.optional(), actions: z.array(actionSchema).min(1).max(8).optional(),
  acknowledgements: z.array(acknowledgement).max(32).optional(), revision: z.number().int().positive(),
}).strict();
export type RuleTrigger = z.infer<typeof triggerSchema>;
export type RuleAction = z.infer<typeof actionSchema>;
export type RuleInput = z.infer<typeof ruleInputSchema>;

export interface AutomationRule extends RuleInput { id: string; revision: number; acknowledgedAt: string | null; createdAt: string; updatedAt: string }
export interface Requirement { key: string; kind: 'audio' | 'text' | 'webhook'; target: string; label: string; local: boolean; acknowledged: boolean; step: number }
export type StepStatus = 'pending' | 'running' | 'waiting' | 'done' | 'skipped' | 'failed' | 'unknown';
export type RunStatus = 'running' | 'waiting' | 'complete' | 'failed' | 'cancelled';
export interface RunStep { id: string; index: number; type: RuleAction['type']; status: StepStatus; detail: string | null; resultRef: string | null; attempts: number; updatedAt: string }
export interface RuleRun { id: string; ruleId: string; ruleName: string | null; recordingId: string; recordingTitle: string | null; status: RunStatus; createdAt: string; updatedAt: string; steps: RunStep[] }
export interface RulePreview {
  matches: { id: string; title: string | null; sourceProvider: string | null; sourceTransport: string | null; recordingType: string; durationSeconds: number | null; recordedAt: string | null }[];
  totalMatches: number; scanned: number;
  requirements: Requirement[]; missingAcknowledgements: string[];
  localOnly: boolean; blockedByLocalOnly: string[];
  estimatedCost: { status: 'unknown'; amount: null; currency: null; reason: string };
  problems: string[]; note: string;
}

export interface GenerateRequest { idempotencyKey: string; recordingId: string; title: string; style: DocumentStyle; folderId: string | null; expectedProvider: string }
export interface RuleEngineDeps {
  queue: { add: (type: string, data: unknown) => Promise<Job>; getJob: (id: string) => Job | undefined; activeJob: (type: string, recordingId: string) => Job | undefined };
  /** Generate and save a document; idempotent per `idempotencyKey`. Returns the saved document id. */
  generateDocument?: (request: GenerateRequest) => Promise<string>;
  webhooks?: WebhookService;
  /** Present only when recording collections exist. Returns false when the collection is missing. */
  addToCollection?: (collectionId: string, recordingId: string) => boolean;
}

type RuleRow = { id: string; name: string; enabled: number; trigger: string; actions: string; acknowledgements: string; acknowledgedAt: string | null; revision: number; createdAt: string; updatedAt: string };
type RecordingRow = { id: string; filePath: string; title: string | null; recordingType: string; durationSeconds: number | null; recordedAt: string | null; sourceProvider: string | null; sourceTransport: string | null; tags: string | null; retentionState: string };
const ruleColumns = 'id, name, enabled, trigger, actions, acknowledgements, acknowledged_at AS acknowledgedAt, revision, created_at AS createdAt, updated_at AS updatedAt';
const recordingColumns = `id, file_path AS filePath, original_filename AS title, recording_type AS recordingType, duration_seconds AS durationSeconds, recorded_at AS recordedAt,
  source_provider AS sourceProvider, source_transport AS sourceTransport, tags, retention_state AS retentionState`;
const stepColumns = 'id, step_index AS "index", action_type AS type, status, detail, result_ref AS resultRef, attempts, updated_at AS updatedAt';
const textLocal = (provider: string) => provider === 'ollama';

export function initializeRules(database: Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS automation_rules (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, trigger TEXT NOT NULL, actions TEXT NOT NULL,
      acknowledgements TEXT NOT NULL DEFAULT '[]', acknowledged_at TEXT, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, recording_id TEXT NOT NULL, status TEXT NOT NULL, actions TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(rule_id, recording_id)
    );
    CREATE INDEX IF NOT EXISTS automation_runs_recording ON automation_runs(recording_id, status);
    CREATE INDEX IF NOT EXISTS automation_runs_created ON automation_runs(created_at DESC);
    CREATE TABLE IF NOT EXISTS automation_run_steps (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_index INTEGER NOT NULL, action_type TEXT NOT NULL, status TEXT NOT NULL,
      detail TEXT, result_ref TEXT, attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, UNIQUE(run_id, step_index)
    );
  `);
}

const presentRule = (row: RuleRow): AutomationRule => ({
  id: row.id, name: row.name, enabled: Boolean(row.enabled), trigger: JSON.parse(row.trigger), actions: JSON.parse(row.actions),
  acknowledgements: JSON.parse(row.acknowledgements), acknowledgedAt: row.acknowledgedAt, revision: row.revision, createdAt: row.createdAt, updatedAt: row.updatedAt,
});

/** Does this recording satisfy the trigger's filters? Unknown duration never satisfies a minimum. */
export function matchesTrigger(trigger: RuleTrigger, recording: Pick<RecordingRow, 'recordingType' | 'durationSeconds' | 'sourceProvider' | 'sourceTransport' | 'tags'>): boolean {
  if (trigger.sources.length && !trigger.sources.some(source => source === 'plaud' ? recording.sourceProvider === 'plaud'
    : source === 'upload' ? recording.sourceProvider === 'upload' : recording.sourceTransport === 'mobile')) return false;
  if (trigger.recordingTypes.length && !(trigger.recordingTypes as string[]).includes(recording.recordingType)) return false;
  if (trigger.minDurationSeconds !== null && (recording.durationSeconds ?? -1) < trigger.minDurationSeconds) return false;
  if (trigger.tag) {
    const tags = (() => { try { return JSON.parse(recording.tags || '[]') as unknown[]; } catch { return []; } })();
    if (!tags.some(tag => typeof tag === 'string' && tag.toLocaleLowerCase() === trigger.tag!.toLocaleLowerCase())) return false;
  }
  return true;
}

const safeTitle = (value: string) => value.replace(/[\x00-\x1f/\\]/g, '-').trim().slice(0, 150);

export class RuleEngine {
  private active = new Set<string>();
  constructor(readonly database: Database, private deps: RuleEngineDeps) {
    initializeRules(database);
    // A step that was running when the process stopped is retried. Each step is
    // idempotent by its stable id, so this cannot duplicate a downstream write.
    database.query("UPDATE automation_run_steps SET status='pending', updated_at=? WHERE status='running'").run(nowIso());
  }

  // ---------------------------------------------------------------- rule CRUD

  list(): AutomationRule[] {
    return (this.database.query(`SELECT ${ruleColumns} FROM automation_rules ORDER BY created_at, id`).all() as RuleRow[]).map(presentRule);
  }

  get(id: string): AutomationRule {
    const row = this.database.query(`SELECT ${ruleColumns} FROM automation_rules WHERE id=?`).get(id) as RuleRow | null;
    if (!row) throw new AutomationError(404, 'rule_not_found', 'Automation rule not found.');
    return presentRule(row);
  }

  create(input: unknown): AutomationRule {
    const data = ruleInputSchema.parse(input);
    this.checkReferences(data.actions);
    if (data.enabled) this.assertAcknowledged(data.actions, data.acknowledgements);
    const id = crypto.randomUUID(), now = nowIso();
    this.database.query(`INSERT INTO automation_rules(id,name,enabled,trigger,actions,acknowledgements,acknowledged_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(id, data.name, Number(data.enabled), JSON.stringify(data.trigger), JSON.stringify(data.actions), JSON.stringify(data.acknowledgements),
        data.acknowledgements.length ? now : null, now, now);
    return this.get(id);
  }

  update(id: string, input: unknown): AutomationRule {
    const data = ruleUpdateSchema.parse(input), current = this.get(id);
    if (data.revision !== current.revision) throw new AutomationError(409, 'revision_conflict', 'This rule changed elsewhere. Reload it and try again.');
    const next = { ...current, ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) } as AutomationRule;
    if (data.actions) this.checkReferences(next.actions);
    if (next.enabled) this.assertAcknowledged(next.actions, next.acknowledgements);
    const now = nowIso(), acknowledgedAt = data.acknowledgements ? (data.acknowledgements.length ? now : null) : current.acknowledgedAt;
    const changed = this.database.query(`UPDATE automation_rules SET name=?, enabled=?, trigger=?, actions=?, acknowledgements=?, acknowledged_at=?, revision=revision+1, updated_at=?
      WHERE id=? AND revision=?`).run(next.name, Number(next.enabled), JSON.stringify(next.trigger), JSON.stringify(next.actions), JSON.stringify(next.acknowledgements),
      acknowledgedAt, now, id, data.revision).changes;
    if (!changed) throw new AutomationError(409, 'revision_conflict', 'This rule changed elsewhere. Reload it and try again.');
    return this.get(id);
  }

  /** Deleting a rule keeps its execution history; in-flight runs stop at their next step. */
  remove(id: string) {
    this.get(id);
    this.database.query('DELETE FROM automation_rules WHERE id=?').run(id);
  }

  private checkReferences(actions: RuleAction[]) {
    for (const action of actions) {
      if (action.type === 'transcribe' && action.profileId && !(tableExists(this.database, 'transcription_profiles')
        && this.database.query('SELECT 1 FROM transcription_profiles WHERE id=?').get(action.profileId)))
        throw new AutomationError(400, 'profile_not_found', 'The selected transcription profile does not exist.');
      if (action.type === 'generate_document' && action.folderId && !this.database.query('SELECT 1 FROM note_folders WHERE id=?').get(action.folderId))
        throw new AutomationError(400, 'folder_not_found', 'The selected Documents folder does not exist.');
      if (action.type === 'notify_webhook' && !this.database.query('SELECT 1 FROM webhook_subscriptions WHERE id=?').get(action.subscriptionId))
        throw new AutomationError(400, 'webhook_not_found', 'The selected webhook does not exist.');
    }
  }

  // ---------------------------------------------------------------- consent

  /** The job config and the speech engine a transcribe action would use with today's settings. */
  private transcribePlan(action: Extract<RuleAction, { type: 'transcribe' }>): { config: AiConfig; engine: AiConfig['transcriptionEngine'] } {
    const base = readAiConfig(this.database);
    // Rules use exactly one provider: no silent fallback to another service.
    const config: AiConfig = { ...base, transcriptionFallback: [], ...(action.provider ? { transcriptionEngine: action.provider, transcriptionModel: '' } : {}),
      ...(action.profileId ? { transcriptionProfile: action.profileId } : {}) };
    return { config, engine: validateEffective(this.database, config).config.transcriptionEngine };
  }

  /** Every provider or external host the actions would send data to, with today's settings. */
  requirements(actions: RuleAction[], acknowledgements: string[] = []): { requirements: Requirement[]; problems: string[] } {
    const result: Requirement[] = [], problems: string[] = [], acked = new Set(acknowledgements);
    const add = (requirement: Omit<Requirement, 'key' | 'acknowledged'>) => {
      const key = `${requirement.kind}:${requirement.target}`;
      result.push({ ...requirement, key, acknowledged: requirement.local || acked.has(key) });
    };
    actions.forEach((action, step) => {
      if (action.type === 'transcribe') {
        try {
          const engine = this.transcribePlan(action).engine, capability = speechCapabilities[engine];
          add({ kind: 'audio', target: engine, label: `${capability.label} receives the audio`, local: capability.local, step });
        } catch (error) { problems.push(`Step ${step + 1}: ${(error as Error).message}`); }
      } else if (action.type === 'generate_document') {
        const provider = readAiConfig(this.database).documentProvider;
        add({ kind: 'text', target: provider, label: `${provider} receives the transcript text`, local: textLocal(provider), step });
      } else if (action.type === 'notify_webhook') {
        const row = this.database.query('SELECT url FROM webhook_subscriptions WHERE id=?').get(action.subscriptionId) as { url: string } | null;
        if (!row) { problems.push(`Step ${step + 1}: the webhook no longer exists.`); return; }
        const host = new URL(row.url).host;
        add({ kind: 'webhook', target: host, label: `${host} receives event metadata`, local: isLoopbackUrl(row.url), step });
      }
    });
    return { requirements: result, problems };
  }

  private assertAcknowledged(actions: RuleAction[], acknowledgements: string[]) {
    const { requirements, problems } = this.requirements(actions, acknowledgements);
    if (problems.length) throw new AutomationError(400, 'rule_invalid', problems.join(' '));
    const missing = [...new Set(requirements.filter(item => !item.acknowledged).map(item => item.key))];
    if (missing.length) throw new AutomationError(400, 'acknowledgement_required', `Enabling this rule sends data off this computer. Acknowledge: ${missing.join(', ')}.`);
  }

  // ---------------------------------------------------------------- preview

  preview(input: unknown): RulePreview {
    const data = ruleInputSchema.parse(input);
    const scanned = this.database.query(`SELECT ${recordingColumns} FROM recordings WHERE retention_state='active' ORDER BY COALESCE(recorded_at, uploaded_at) DESC LIMIT 2000`).all() as RecordingRow[];
    const matching = scanned.filter(row => matchesTrigger(data.trigger, row));
    const { requirements, problems } = this.requirements(data.actions, data.acknowledgements);
    const local = localOnly(this.database);
    return {
      matches: matching.slice(0, 25).map(row => ({ id: row.id, title: row.title, sourceProvider: row.sourceProvider, sourceTransport: row.sourceTransport, recordingType: row.recordingType, durationSeconds: row.durationSeconds, recordedAt: row.recordedAt })),
      totalMatches: matching.length, scanned: scanned.length,
      requirements, missingAcknowledgements: [...new Set(requirements.filter(item => !item.acknowledged).map(item => item.key))],
      localOnly: local, blockedByLocalOnly: local ? requirements.filter(item => !item.local).map(item => item.key) : [],
      estimatedCost: { status: 'unknown', amount: null, currency: null, reason: 'Providers bill per audio second or per token at rates OpenPlod does not track. Check your provider pricing.' },
      problems,
      note: 'Rules run only for recordings imported after the rule is enabled. These existing recordings show what the filters would match; they are not processed.',
    };
  }

  // ---------------------------------------------------------------- execution

  /** Start every enabled, matching rule for a newly imported recording. */
  async onRecordingImported(recordingId: string): Promise<string[]> {
    const recording = this.recording(recordingId);
    if (!recording) return [];
    const started: string[] = [];
    for (const rule of this.list().filter(item => item.enabled)) {
      if (!matchesTrigger(rule.trigger, recording)) continue;
      const runId = stableId('automation-run', rule.id, recordingId), now = nowIso();
      const inserted = this.database.transaction(() => {
        if (!this.database.query("INSERT OR IGNORE INTO automation_runs(id,rule_id,recording_id,status,actions,created_at,updated_at) VALUES(?,?,?,'running',?,?,?)")
          .run(runId, rule.id, recordingId, JSON.stringify(rule.actions), now, now).changes) return false;
        rule.actions.forEach((action, index) => this.database.query("INSERT INTO automation_run_steps(id,run_id,step_index,action_type,status,updated_at) VALUES(?,?,?,?,'pending',?)")
          .run(stableId('automation-step', rule.id, recordingId, String(index)), runId, index, action.type, now));
        return true;
      })();
      if (inserted) { started.push(runId); await this.advance(runId); }
    }
    return started;
  }

  /** Continue runs waiting on this recording's transcription. */
  async onRecordingSettled(recordingId: string) {
    for (const { id } of this.database.query("SELECT id FROM automation_runs WHERE recording_id=? AND status IN ('waiting','running')").all(recordingId) as { id: string }[]) await this.advance(id);
  }

  /** Periodic sweep: continue every waiting run (after restarts or pruned jobs). */
  async resumeWaiting() {
    for (const { id } of this.database.query("SELECT id FROM automation_runs WHERE status IN ('waiting','running') ORDER BY created_at LIMIT 100").all() as { id: string }[]) await this.advance(id);
  }

  /** Retry failed or unknown steps of a run. Generation retries use a fresh key, so they never reuse a half-finished request. */
  async retry(runId: string): Promise<RuleRun> {
    const run = this.run(runId);
    if (!['failed', 'cancelled'].includes(run.status)) throw new AutomationError(409, 'run_not_retryable', 'Only failed or cancelled runs can be retried.');
    this.database.transaction(() => {
      this.database.query("UPDATE automation_run_steps SET status='pending', attempts=attempts+1, result_ref=CASE WHEN action_type='transcribe' THEN NULL ELSE result_ref END, updated_at=? WHERE run_id=? AND status IN ('failed','unknown','skipped')")
        .run(nowIso(), runId);
      this.database.query("UPDATE automation_runs SET status='running', updated_at=? WHERE id=?").run(nowIso(), runId);
    })();
    await this.advance(runId);
    return this.run(runId);
  }

  async advance(runId: string): Promise<void> {
    if (this.active.has(runId)) return;
    this.active.add(runId);
    try {
      for (let guard = 0; guard < 16; guard++) {
        const run = this.runRow(runId);
        if (!run || ['complete', 'failed', 'cancelled'].includes(run.status)) return;
        const rule = this.database.query(`SELECT ${ruleColumns} FROM automation_rules WHERE id=?`).get(run.ruleId) as RuleRow | null;
        const steps = this.steps(runId);
        if (!rule || !rule.enabled) {
          this.database.query("UPDATE automation_run_steps SET status='skipped', detail='Rule disabled or deleted before this step ran.', updated_at=? WHERE run_id=? AND status IN ('pending','waiting')").run(nowIso(), runId);
          return this.setRun(runId, 'cancelled');
        }
        const step = steps.find(item => item.status !== 'done' && item.status !== 'skipped');
        if (!step) return this.setRun(runId, 'complete');
        if (step.status === 'failed' || step.status === 'unknown') return this.setRun(runId, 'failed');
        const actions = JSON.parse(run.actions) as RuleAction[];
        const status = await this.execute(run.recordingId, presentRule(rule), actions[step.index], step);
        if (status === 'waiting') return this.setRun(runId, 'waiting');
        this.setRun(runId, 'running');
      }
    } finally { this.active.delete(runId); }
  }

  private setStep(step: RunStep, status: StepStatus, detail: string | null, resultRef: string | null = step.resultRef): StepStatus {
    this.database.query('UPDATE automation_run_steps SET status=?, detail=?, result_ref=?, updated_at=? WHERE id=?').run(status, detail, resultRef, nowIso(), step.id);
    return status;
  }

  private setRun(runId: string, status: RunStatus) {
    this.database.query('UPDATE automation_runs SET status=?, updated_at=? WHERE id=? AND status<>?').run(status, nowIso(), runId, status);
  }

  /** Re-checked for every step at run time: settings may have changed since the rule was approved. */
  private consent(rule: AutomationRule, kind: Requirement['kind'], target: string, local: boolean): string | null {
    if (local) return null;
    if (kind !== 'webhook' && localOnly(this.database)) return 'Blocked by local-only mode. Nothing was sent.';
    if (!rule.acknowledgements.includes(`${kind}:${target}`)) return `Needs approval: this step would send data to ${target}, which this rule was not approved for. Edit the rule to acknowledge it.`;
    return null;
  }

  private async execute(recordingId: string, rule: AutomationRule, action: RuleAction, step: RunStep): Promise<StepStatus> {
    const recording = this.recording(recordingId);
    if (!recording || recording.retentionState !== 'active') return this.setStep(step, 'skipped', 'Recording is in Trash or was removed.');
    try {
      switch (action.type) {
        case 'transcribe': return await this.transcribe(recording, rule, action, step);
        case 'generate_document': return await this.generate(recording, rule, action, step);
        case 'add_tags': {
          const current = (() => { try { return JSON.parse(recording.tags || '[]') as string[]; } catch { return []; } })();
          const keys = new Set(current.map(tag => tag.toLocaleLowerCase()));
          const added = action.tags.filter(tag => !keys.has(tag.toLocaleLowerCase()));
          if (added.length) this.database.query('UPDATE recordings SET tags=?, revision=revision+1 WHERE id=?').run(JSON.stringify([...current, ...added]), recordingId);
          return this.setStep(step, 'done', added.length ? `Added ${added.join(', ')}.` : 'Tags already present.');
        }
        case 'add_to_collection': {
          if (!this.deps.addToCollection) return this.setStep(step, 'skipped', 'Recording collections are not available in this version.');
          return this.deps.addToCollection(action.collectionId, recordingId)
            ? this.setStep(step, 'done', 'Added to the collection.', action.collectionId)
            : this.setStep(step, 'skipped', 'The collection or the recording is no longer available.');
        }
        case 'notify_webhook': {
          if (!this.deps.webhooks) return this.setStep(step, 'skipped', 'Webhooks are not available.');
          const row = this.database.query('SELECT url FROM webhook_subscriptions WHERE id=?').get(action.subscriptionId) as { url: string } | null;
          if (!row) return this.setStep(step, 'failed', 'The webhook no longer exists.');
          const blocked = this.consent(rule, 'webhook', new URL(row.url).host, isLoopbackUrl(row.url));
          if (blocked) return this.setStep(step, 'failed', blocked);
          const completed = this.steps(this.runIdOf(step.id)).filter(item => item.index < step.index).map(({ index, type, status, resultRef }) => ({ index, type, status, resultRef }));
          const eventId = this.deps.webhooks.enqueue('automation.notify', stableId(step.id, String(step.attempts)), { ruleId: rule.id, ruleName: rule.name, recordingId, steps: completed }, action.subscriptionId);
          return this.setStep(step, 'done', 'Event queued. Its delivery outcome is in the webhook history.', eventId);
        }
      }
    } catch (error) {
      return this.setStep(step, 'failed', error instanceof Error ? error.message.slice(0, 500) : 'Step failed.');
    }
  }

  private async transcribe(recording: RecordingRow, rule: AutomationRule, action: Extract<RuleAction, { type: 'transcribe' }>, step: RunStep): Promise<StepStatus> {
    if (step.resultRef) {
      // The handler saves the transcript version under the job id before the job is marked complete.
      if (this.database.query('SELECT 1 FROM transcript_versions WHERE id=?').get(step.resultRef)) return this.setStep(step, 'done', 'Transcript saved.');
      const job = this.deps.queue.getJob(step.resultRef);
      if (!job) return this.setStep(step, 'failed', 'The transcription job is no longer tracked and produced no transcript.');
      if (job.status === 'pending' || job.status === 'running') return this.setStep(step, 'waiting', 'Waiting for transcription.');
      if (job.status === 'complete') return this.setStep(step, 'done', 'Transcription finished.');
      return this.setStep(step, 'failed', job.error ?? `Transcription ${job.status}.`);
    }
    const { config, engine } = this.transcribePlan(action);
    const blocked = this.consent(rule, 'audio', engine, speechCapabilities[engine].local);
    if (blocked) return this.setStep(step, 'failed', blocked);
    this.setStep(step, 'running', `Queuing ${speechCapabilities[engine].label}.`);
    const job = await this.deps.queue.add('process-recording', { recordingId: recording.id, filePath: recording.filePath, config });
    const queued = (job.data as { config?: { transcriptionEngine?: string } }).config?.transcriptionEngine;
    return this.setStep(step, 'waiting', queued && queued !== engine ? `Joined an already queued ${queued} transcription for this recording.` : `Waiting for ${speechCapabilities[engine].label}.`, job.id);
  }

  private async generate(recording: RecordingRow, rule: AutomationRule, action: Extract<RuleAction, { type: 'generate_document' }>, step: RunStep): Promise<StepStatus> {
    if (!this.deps.generateDocument) return this.setStep(step, 'skipped', 'Document generation is not available.');
    if (!this.database.query("SELECT 1 FROM transcripts WHERE recording_id=? AND trim(full_text)<>''").get(recording.id)) {
      if (this.deps.queue.activeJob('process-recording', recording.id)) return this.setStep(step, 'waiting', 'Waiting for a transcript.');
      return this.setStep(step, 'failed', 'This recording has no transcript. Add a Transcribe step before this one.');
    }
    const provider = readAiConfig(this.database).documentProvider;
    const blocked = this.consent(rule, 'text', provider, textLocal(provider));
    if (blocked) return this.setStep(step, 'failed', blocked);
    this.setStep(step, 'running', `Generating with ${provider}.`);
    const base = safeTitle((recording.title || 'Recording').replace(/\.[^.]+$/, '')) || 'Recording';
    const key = step.attempts ? stableId(step.id, 'attempt', String(step.attempts)) : step.id;
    try {
      const documentId = await this.deps.generateDocument({ idempotencyKey: key, recordingId: recording.id, title: `${base} - ${documentTemplate(action.template).label}`.slice(0, 180),
        style: action.template, folderId: action.folderId, expectedProvider: provider });
      return this.setStep(step, 'done', 'Document saved.', documentId);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'generation_incomplete') return this.setStep(step, 'unknown', 'An earlier attempt was interrupted. The provider may have processed (and billed) it. Retry to generate again.');
      throw error;
    }
  }

  // ---------------------------------------------------------------- history

  private recording(id: string): RecordingRow | null {
    return this.database.query(`SELECT ${recordingColumns} FROM recordings WHERE id=?`).get(id) as RecordingRow | null;
  }

  private runIdOf(stepId: string): string {
    return (this.database.query('SELECT run_id AS runId FROM automation_run_steps WHERE id=?').get(stepId) as { runId: string }).runId;
  }

  private runRow(id: string) {
    return this.database.query('SELECT id, rule_id AS ruleId, recording_id AS recordingId, status, actions FROM automation_runs WHERE id=?').get(id) as { id: string; ruleId: string; recordingId: string; status: RunStatus; actions: string } | null;
  }

  private steps(runId: string): RunStep[] {
    return this.database.query(`SELECT ${stepColumns} FROM automation_run_steps WHERE run_id=? ORDER BY step_index`).all(runId) as RunStep[];
  }

  private static readonly runSelect = `SELECT r.id, r.rule_id AS ruleId, a.name AS ruleName, r.recording_id AS recordingId, c.original_filename AS recordingTitle,
      r.status, r.created_at AS createdAt, r.updated_at AS updatedAt FROM automation_runs r LEFT JOIN automation_rules a ON a.id=r.rule_id
      LEFT JOIN recordings c ON c.id=r.recording_id`;

  run(id: string): RuleRun {
    const row = this.database.query(`${RuleEngine.runSelect} WHERE r.id=?`).get(id) as Omit<RuleRun, 'steps'> | null;
    if (!row) throw new AutomationError(404, 'run_not_found', 'Automation run not found.');
    return { ...row, steps: this.steps(id) };
  }

  /** A page of runs in two queries: the runs, then every step of those runs. */
  runs(ruleId?: string, limit = 50): RuleRun[] {
    const rows = (ruleId
      ? this.database.query(`${RuleEngine.runSelect} WHERE r.rule_id=? ORDER BY r.created_at DESC, r.id LIMIT ?`).all(ruleId, limit)
      : this.database.query(`${RuleEngine.runSelect} ORDER BY r.created_at DESC, r.id LIMIT ?`).all(limit)) as Omit<RuleRun, 'steps'>[];
    if (!rows.length) return [];
    const steps = this.database.query(`SELECT run_id AS runId, ${stepColumns} FROM automation_run_steps WHERE run_id IN (SELECT value FROM json_each(?)) ORDER BY run_id, step_index`)
      .all(JSON.stringify(rows.map(row => row.id))) as (RunStep & { runId: string })[];
    const byRun = new Map<string, RunStep[]>();
    for (const { runId, ...step } of steps) { const list = byRun.get(runId); if (list) list.push(step as RunStep); else byRun.set(runId, [step as RunStep]); }
    return rows.map(row => ({ ...row, steps: byRun.get(row.id) ?? [] }));
  }
}

export type { DocumentStyle };
