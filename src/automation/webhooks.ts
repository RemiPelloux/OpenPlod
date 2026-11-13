import type { Database } from 'bun:sqlite';
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../vault/secrets';
import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AutomationError, isLoopbackUrl, localOnly, nowIso, stableId, transportOutcome, validateOutboundUrl, type Fetcher } from './common';
import type { AutomationEvent } from './hooks';

/**
 * Signed webhook events (roadmap KB-08).
 *
 * Events are written to an outbox (`webhook_events`) with a stable id derived
 * from their type and subject, so emitting the same fact twice is a no-op.
 * Each (event, subscription) pair gets one delivery with a stable id; retries
 * and manual redeliveries are attempts on that delivery and reuse its ids, so
 * receivers can deduplicate. A timeout or reset after the request may have
 * been sent is recorded as `unknown`, never as success, and is not retried
 * automatically.
 */
export const WEBHOOK_EVENT_TYPES = ['recording.imported', 'recording.transcribed', 'document.created', 'job.failed'] as const;
export type WebhookEventType = typeof WEBHOOK_EVENT_TYPES[number];
/** Targeted, internal event types: never broadcast to every subscription. */
type TargetedType = 'webhook.test' | 'automation.notify';

export interface WebhookSubscription {
  id: string; name: string; url: string; host: string; external: boolean; eventTypes: WebhookEventType[]; includeText: boolean;
  enabled: boolean; disabledReason: string | null; consecutiveFailures: number; createdAt: string; updatedAt: string;
}
export type DeliveryStatus = 'pending' | 'delivering' | 'delivered' | 'failed' | 'unknown' | 'blocked' | 'skipped';
export type AttemptOutcome = 'delivered' | 'failed' | 'unknown' | 'blocked';
export interface WebhookAttempt { attempt: number; trigger: 'auto' | 'manual'; startedAt: string; finishedAt: string | null; outcome: AttemptOutcome | null; statusCode: number | null; error: string | null; durationMs: number | null }
export interface WebhookDelivery {
  id: string; eventId: string; eventType: string; subscriptionId: string; status: DeliveryStatus; attemptCount: number;
  nextAttemptAt: string | null; lastStatusCode: number | null; lastError: string | null; createdAt: string; updatedAt: string; attempts: WebhookAttempt[];
}

const name = z.string().trim().min(1).max(80).refine(value => !/[\x00-\x1f]/.test(value), 'Use a name without control characters');
const url = z.string().trim().max(2048).superRefine((value, context) => { const problem = validateOutboundUrl(value); if (problem) context.addIssue({ code: 'custom', message: problem }); });
const eventTypes = z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(WEBHOOK_EVENT_TYPES.length).transform(values => [...new Set(values)]);
export const createSubscriptionSchema = z.object({
  name, url, eventTypes, includeText: z.boolean().default(false), enabled: z.boolean().default(true),
  /** Required when the URL leaves this computer. */
  acknowledgeExternal: z.boolean().optional(),
  /** Required when transcript or document text is included in payloads. */
  acknowledgeText: z.boolean().optional(),
}).strict();
export const updateSubscriptionSchema = z.object({
  name: name.optional(), url: url.optional(), eventTypes: eventTypes.optional(), includeText: z.boolean().optional(), enabled: z.boolean().optional(),
  acknowledgeExternal: z.boolean().optional(), acknowledgeText: z.boolean().optional(),
}).strict();

type SubscriptionRow = { id: string; name: string; url: string; secret: string; eventTypes: string; includeText: number; enabled: number; disabledReason: string | null; consecutiveFailures: number; createdAt: string; updatedAt: string };
const subscriptionColumns = `id, name, url, secret, event_types AS eventTypes, include_text AS includeText, enabled, disabled_reason AS disabledReason,
  consecutive_failures AS consecutiveFailures, created_at AS createdAt, updated_at AS updatedAt`;
const deliveryColumns = `d.id, d.event_id AS eventId, e.type AS eventType, d.subscription_id AS subscriptionId, d.status, d.attempt_count AS attemptCount,
  d.next_attempt_at AS nextAttemptAt, d.last_status_code AS lastStatusCode, d.last_error AS lastError, d.created_at AS createdAt, d.updated_at AS updatedAt`;

const attemptColumns = 'attempt, trigger, started_at AS startedAt, finished_at AS finishedAt, outcome, status_code AS statusCode, error, duration_ms AS durationMs';

export function initializeWebhooks(database: Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS webhook_subscriptions (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL, event_types TEXT NOT NULL,
      include_text INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, disabled_reason TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0, external_acknowledged_at TEXT, text_acknowledged_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, subject TEXT NOT NULL, data TEXT NOT NULL, target_subscription_id TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS webhook_events_created ON webhook_events(created_at);
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL, subscription_id TEXT NOT NULL, status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, last_status_code INTEGER, last_error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(event_id, subscription_id)
    );
    CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS webhook_deliveries_subscription ON webhook_deliveries(subscription_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS webhook_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, delivery_id TEXT NOT NULL, attempt INTEGER NOT NULL, trigger TEXT NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT, outcome TEXT, status_code INTEGER, error TEXT, duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS webhook_attempts_delivery ON webhook_attempts(delivery_id, attempt);
  `);
}

/** `OpenPlod-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`. */
const webhookSecretName = (id: string) => `webhook:${id}`;
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export interface WebhookOptions {
  fetcher?: Fetcher;
  /** Automatic attempts per delivery before it is marked failed. */
  maxAttempts?: number;
  /** Consecutive failed deliveries before the subscription is disabled. */
  disableAfter?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  /** Start the delivery worker right after an event is queued (off in tests). */
  autoDeliver?: boolean;
  /** Days a finished delivery and its attempts are kept before `pruneHistory` removes them. */
  historyRetentionDays?: number;
  now?: () => number;
}

export class WebhookService {
  private readonly fetcher: Fetcher;
  private readonly options: Required<Omit<WebhookOptions, 'fetcher'>>;
  private draining = false;
  private kickScheduled = false;

  constructor(readonly database: Database, options: WebhookOptions = {}) {
    initializeWebhooks(database);
    // Signing secrets are encrypted at rest like provider keys (REL-06); older plaintext rows are migrated once.
    const plain = (database.query('SELECT id, secret FROM webhook_subscriptions').all() as { id: string; secret: string }[]).filter(row => !isEncryptedSecret(row.secret));
    for (const row of plain) database.query('UPDATE webhook_subscriptions SET secret=? WHERE id=? AND secret=?').run(encryptSecret(webhookSecretName(row.id), row.secret), row.id, row.secret);
    this.fetcher = options.fetcher ?? fetch;
    this.options = { maxAttempts: 6, disableAfter: 5, baseDelayMs: 30000, maxDelayMs: 3600000, timeoutMs: 10000, autoDeliver: true, historyRetentionDays: 90, now: Date.now, ...options };
    // A process that stopped mid-request cannot know whether the receiver got it.
    database.query("UPDATE webhook_attempts SET outcome='unknown', error='Interrupted before a response; the receiver may have processed it.', finished_at=? WHERE outcome IS NULL").run(nowIso());
    database.query("UPDATE webhook_deliveries SET status='unknown', last_error='Interrupted before a response; the receiver may have processed it.', next_attempt_at=NULL, updated_at=? WHERE status='delivering'").run(nowIso());
  }

  // ---------------------------------------------------------------- subscriptions

  list(): WebhookSubscription[] {
    return (this.database.query(`SELECT ${subscriptionColumns} FROM webhook_subscriptions ORDER BY created_at, id`).all() as SubscriptionRow[]).map(present);
  }

  get(id: string): WebhookSubscription { return present(this.row(id)); }

  private row(id: string): SubscriptionRow {
    const row = this.database.query(`SELECT ${subscriptionColumns} FROM webhook_subscriptions WHERE id=?`).get(id) as SubscriptionRow | null;
    if (!row) throw new AutomationError(404, 'webhook_not_found', 'Webhook subscription not found.');
    return row;
  }

  /** The secret is returned once, here and from `rotateSecret`, and never listed again. */
  create(input: unknown): WebhookSubscription & { secret: string } {
    const data = createSubscriptionSchema.parse(input);
    const external = !isLoopbackUrl(data.url);
    if (external && data.acknowledgeExternal !== true) throw new AutomationError(400, 'external_ack_required', 'This URL leaves this computer. Confirm that OpenPlod may send event metadata to it.');
    if (data.includeText && data.acknowledgeText !== true) throw new AutomationError(400, 'text_ack_required', 'Including transcript and document text needs a separate confirmation.');
    const id = crypto.randomUUID(), secret = `whsec_${randomBytes(32).toString('hex')}`, now = nowIso();
    this.database.query(`INSERT INTO webhook_subscriptions(id,name,url,secret,event_types,include_text,enabled,external_acknowledged_at,text_acknowledged_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, data.name, data.url, encryptSecret(webhookSecretName(id), secret), JSON.stringify(data.eventTypes), Number(data.includeText), Number(data.enabled),
      external ? now : null, data.includeText ? now : null, now, now);
    return { ...this.get(id), secret };
  }

  update(id: string, input: unknown): WebhookSubscription {
    const data = updateSubscriptionSchema.parse(input), current = this.row(id), now = nowIso();
    const nextUrl = data.url ?? current.url, nextText = data.includeText ?? Boolean(current.includeText);
    if (data.url && data.url !== current.url && !isLoopbackUrl(nextUrl) && data.acknowledgeExternal !== true)
      throw new AutomationError(400, 'external_ack_required', 'This URL leaves this computer. Confirm that OpenPlod may send event metadata to it.');
    if (nextText && !current.includeText && data.acknowledgeText !== true) throw new AutomationError(400, 'text_ack_required', 'Including transcript and document text needs a separate confirmation.');
    const reenable = data.enabled === true && !current.enabled;
    this.database.query(`UPDATE webhook_subscriptions SET name=?, url=?, event_types=?, include_text=?, enabled=?, updated_at=?,
      disabled_reason=CASE WHEN ? THEN NULL ELSE disabled_reason END, consecutive_failures=CASE WHEN ? THEN 0 ELSE consecutive_failures END,
      external_acknowledged_at=CASE WHEN ? THEN ? ELSE external_acknowledged_at END, text_acknowledged_at=CASE WHEN ? THEN ? ELSE text_acknowledged_at END WHERE id=?`)
      .run(data.name ?? current.name, nextUrl, JSON.stringify(data.eventTypes ?? JSON.parse(current.eventTypes)), Number(nextText), Number(data.enabled ?? Boolean(current.enabled)), now,
        reenable ? 1 : 0, reenable ? 1 : 0, data.acknowledgeExternal === true ? 1 : 0, now, data.acknowledgeText === true ? 1 : 0, now, id);
    return this.get(id);
  }

  rotateSecret(id: string): WebhookSubscription & { secret: string } {
    this.row(id);
    const secret = `whsec_${randomBytes(32).toString('hex')}`;
    this.database.query('UPDATE webhook_subscriptions SET secret=?, updated_at=? WHERE id=?').run(encryptSecret(webhookSecretName(id), secret), nowIso(), id);
    return { ...this.get(id), secret };
  }

  remove(id: string) {
    this.row(id);
    this.database.transaction(() => {
      this.database.query('DELETE FROM webhook_attempts WHERE delivery_id IN (SELECT id FROM webhook_deliveries WHERE subscription_id=?)').run(id);
      this.database.query('DELETE FROM webhook_deliveries WHERE subscription_id=?').run(id);
      this.database.query('DELETE FROM webhook_subscriptions WHERE id=?').run(id);
    })();
  }

  // ---------------------------------------------------------------- outbox

  /** Map an in-process automation event to a webhook event. Synchronous: joins the caller's transaction. */
  handle(event: AutomationEvent): string | null {
    switch (event.type) {
      case 'recording.imported': {
        const recording = this.database.query(`SELECT id, recording_type AS recordingType, duration_seconds AS durationSeconds, recorded_at AS recordedAt,
          source_provider AS sourceProvider, source_transport AS sourceTransport, original_filename AS filename FROM recordings WHERE id=?`).get(event.recordingId) as Record<string, unknown> | null;
        if (!recording) return null;
        const { id, ...metadata } = recording;
        return this.enqueue('recording.imported', event.recordingId, { recordingId: id, ...metadata });
      }
      case 'recording.transcribed':
        return this.enqueue('recording.transcribed', event.transcriptVersionId, { recordingId: event.recordingId, transcriptVersionId: event.transcriptVersionId, provider: event.provider, model: event.model, current: event.current });
      case 'document.created': {
        const document = this.database.query(`SELECT id, title, folder_id AS folderId, revision, source_recording_id AS sourceRecordingId, source_version_id AS sourceVersionId, created_at AS createdAt
          FROM note_documents WHERE id=?`).get(event.documentId) as Record<string, unknown> | null;
        if (!document) return null;
        const { id, ...metadata } = document;
        return this.enqueue('document.created', event.documentId, { documentId: id, ...metadata });
      }
      case 'job.failed':
        return this.enqueue('job.failed', event.jobId, { jobId: event.jobId, jobType: event.jobType, recordingId: event.recordingId, error: event.error });
    }
  }

  /**
   * Record an event once and fan it out to subscribed endpoints. Returns the
   * stable event id. `target` restricts delivery to one subscription.
   */
  enqueue(type: WebhookEventType | TargetedType, subject: string, data: Record<string, unknown>, target?: string): string {
    const eventId = stableId('webhook-event', type, subject), now = nowIso();
    const inserted = this.database.query('INSERT OR IGNORE INTO webhook_events(id,type,subject,data,target_subscription_id,created_at) VALUES(?,?,?,?,?,?)')
      .run(eventId, type, subject, JSON.stringify(data), target ?? null, now).changes > 0;
    if (!inserted) return eventId;
    const subscriptions = target
      ? this.database.query('SELECT id FROM webhook_subscriptions WHERE id=?').all(target) as { id: string }[]
      : this.database.query("SELECT id FROM webhook_subscriptions WHERE enabled=1 AND EXISTS (SELECT 1 FROM json_each(event_types) WHERE value=?)").all(type) as { id: string }[];
    for (const { id } of subscriptions)
      this.database.query(`INSERT OR IGNORE INTO webhook_deliveries(id,event_id,subscription_id,status,next_attempt_at,created_at,updated_at) VALUES(?,?,?,'pending',?,?,?)`)
        .run(stableId('webhook-delivery', eventId, id), eventId, id, new Date(this.options.now()).toISOString(), now, now);
    if (subscriptions.length) this.kick();
    return eventId;
  }

  private kick() {
    if (!this.options.autoDeliver || this.kickScheduled) return;
    this.kickScheduled = true;
    // After the caller's transaction commits.
    setTimeout(() => { this.kickScheduled = false; void this.deliverDue().catch(error => console.error('[Webhooks] Delivery worker failed:', error)); }, 0);
  }

  /** Attempt every pending delivery whose retry time has come. Returns the number attempted. */
  async deliverDue(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    let count = 0;
    try {
      while (true) {
        const due = this.database.query(`SELECT id FROM webhook_deliveries WHERE status='pending' AND next_attempt_at<=? ORDER BY next_attempt_at, id LIMIT 20`)
          .all(new Date(this.options.now()).toISOString()) as { id: string }[];
        if (!due.length) break;
        for (const { id } of due) { await this.attempt(id, 'auto'); count++; }
      }
    } finally { this.draining = false; }
    return count;
  }

  // ---------------------------------------------------------------- delivery

  private body(delivery: { id: string; eventId: string }, subscription: SubscriptionRow): string {
    const event = this.database.query('SELECT id, type, data, created_at AS createdAt FROM webhook_events WHERE id=?').get(delivery.eventId) as { id: string; type: string; data: string; createdAt: string };
    const data = JSON.parse(event.data) as Record<string, unknown>;
    if (subscription.includeText) {
      if (event.type === 'recording.transcribed') {
        const row = this.database.query(`SELECT v.full_text AS text FROM transcript_versions v JOIN recordings r ON r.id=v.recording_id
          WHERE v.id=? AND r.retention_state='active'`).get(String(data.transcriptVersionId)) as { text: string } | null;
        Object.assign(data, row ? { text: row.text } : { textUnavailable: true });
      } else if (event.type === 'document.created') {
        const row = this.database.query('SELECT content AS text FROM note_documents WHERE id=? AND deleted_at IS NULL').get(String(data.documentId)) as { text: string } | null;
        Object.assign(data, row ? { text: row.text } : { textUnavailable: true });
      }
    }
    return JSON.stringify({ schemaVersion: '1', id: event.id, type: event.type, createdAt: event.createdAt, deliveryId: delivery.id, data });
  }

  /** One HTTP attempt. Never throws for remote failures; the outcome is recorded. */
  private async attempt(deliveryId: string, trigger: 'auto' | 'manual'): Promise<WebhookDelivery> {
    const delivery = this.database.query('SELECT id, event_id AS eventId, subscription_id AS subscriptionId, status, attempt_count AS attemptCount FROM webhook_deliveries WHERE id=?')
      .get(deliveryId) as { id: string; eventId: string; subscriptionId: string; status: DeliveryStatus; attemptCount: number } | null;
    if (!delivery) throw new AutomationError(404, 'delivery_not_found', 'Delivery not found.');
    const subscription = this.database.query(`SELECT ${subscriptionColumns} FROM webhook_subscriptions WHERE id=?`).get(delivery.subscriptionId) as SubscriptionRow | null;
    const now = nowIso();
    if (!subscription || (trigger === 'auto' && !subscription.enabled)) {
      this.database.query("UPDATE webhook_deliveries SET status='skipped', last_error=?, next_attempt_at=NULL, updated_at=? WHERE id=? AND status='pending'")
        .run(subscription ? 'Subscription disabled; not sent.' : 'Subscription removed.', now, deliveryId);
      return this.delivery(deliveryId);
    }
    // Claim the delivery so two workers (or a worker and a manual redelivery) never send it concurrently.
    const claimed = this.database.query(`UPDATE webhook_deliveries SET status='delivering', attempt_count=attempt_count+1, next_attempt_at=NULL, updated_at=?
      WHERE id=? AND status ${trigger === 'auto' ? "= 'pending'" : "<> 'delivering'"}`).run(now, deliveryId).changes > 0;
    if (!claimed) return this.delivery(deliveryId);
    const attempt = delivery.attemptCount + 1;
    const attemptId = Number(this.database.query('INSERT INTO webhook_attempts(delivery_id,attempt,trigger,started_at) VALUES(?,?,?,?)').run(deliveryId, attempt, trigger, now).lastInsertRowid);
    const finish = (outcome: AttemptOutcome, statusCode: number | null, error: string | null, durationMs: number | null) => {
      const finishedAt = nowIso();
      this.database.transaction(() => {
        this.database.query('UPDATE webhook_attempts SET outcome=?, status_code=?, error=?, duration_ms=?, finished_at=? WHERE id=?').run(outcome, statusCode, error, durationMs, finishedAt, attemptId);
        let status: DeliveryStatus = outcome === 'failed' ? 'failed' : outcome, next: string | null = null;
        if (outcome === 'failed' && trigger === 'auto' && attempt < this.options.maxAttempts) {
          status = 'pending';
          next = new Date(this.options.now() + Math.min(this.options.maxDelayMs, this.options.baseDelayMs * 2 ** (attempt - 1))).toISOString();
        }
        this.database.query('UPDATE webhook_deliveries SET status=?, next_attempt_at=?, last_status_code=?, last_error=?, updated_at=? WHERE id=?').run(status, next, statusCode, error, finishedAt, deliveryId);
        if (outcome === 'delivered') this.database.query('UPDATE webhook_subscriptions SET consecutive_failures=0 WHERE id=?').run(subscription.id);
        if (status === 'failed') {
          this.database.query('UPDATE webhook_subscriptions SET consecutive_failures=consecutive_failures+1 WHERE id=?').run(subscription.id);
          this.database.query(`UPDATE webhook_subscriptions SET enabled=0, disabled_reason=?, updated_at=? WHERE id=? AND enabled=1 AND consecutive_failures>=?`)
            .run(`Disabled after ${this.options.disableAfter} failed deliveries in a row. Fix the endpoint, then enable it again.`, finishedAt, subscription.id, this.options.disableAfter);
        }
      })();
    };
    // Local-only mode keeps everything on this computer, webhooks included.
    if (!isLoopbackUrl(subscription.url) && localOnly(this.database)) {
      finish('blocked', null, 'Local-only mode blocks sending to addresses outside this computer. Nothing was sent.', null);
      return this.delivery(deliveryId);
    }
    const body = this.body(delivery, subscription), timestamp = Math.floor(this.options.now() / 1000), started = Date.now();
    try {
      const response = await this.fetcher(subscription.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.options.timeoutMs), body,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'OpenPlod-Webhooks/1', 'OpenPlod-Event-Id': delivery.eventId, 'OpenPlod-Delivery-Id': deliveryId,
          'OpenPlod-Event-Type': (JSON.parse(body) as { type: string }).type, 'OpenPlod-Signature': signWebhook(decryptSecret(webhookSecretName(subscription.id), subscription.secret), timestamp, body), 'Idempotency-Key': delivery.eventId } });
      await response.body?.cancel().catch(() => {});
      // Response bodies are never stored: they can contain anything.
      if (response.ok) finish('delivered', response.status, null, Date.now() - started);
      else finish('failed', response.status, `Endpoint answered HTTP ${response.status}.`, Date.now() - started);
    } catch (error) {
      const outcome = transportOutcome(error);
      finish(outcome, null, outcome === 'failed' ? 'Could not connect to the endpoint. Nothing was sent.'
        : 'No response (timeout or connection reset). The endpoint may have received this event; redeliver manually if needed.', Date.now() - started);
    }
    return this.delivery(deliveryId);
  }

  /** Send a delivery again now, reusing its event and delivery ids. */
  redeliver(deliveryId: string): Promise<WebhookDelivery> {
    const delivery = this.delivery(deliveryId);
    const subscription = this.row(delivery.subscriptionId);
    if (!subscription.enabled) throw new AutomationError(409, 'webhook_disabled', 'Enable this webhook before redelivering.');
    if (delivery.status === 'delivering') throw new AutomationError(409, 'delivery_in_progress', 'This delivery is being sent right now.');
    return this.attempt(deliveryId, 'manual');
  }

  /** Send a signed `webhook.test` event to one subscription right now. */
  async ping(subscriptionId: string): Promise<WebhookDelivery> {
    this.row(subscriptionId);
    const eventId = this.enqueue('webhook.test', crypto.randomUUID(), { subscriptionId, message: 'Test event from OpenPlod.' }, subscriptionId);
    return this.attempt(stableId('webhook-delivery', eventId, subscriptionId), 'manual');
  }

  delivery(id: string): WebhookDelivery {
    const row = this.database.query(`SELECT ${deliveryColumns} FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE d.id=?`).get(id) as Omit<WebhookDelivery, 'attempts'> | null;
    if (!row) throw new AutomationError(404, 'delivery_not_found', 'Delivery not found.');
    return { ...row, attempts: this.attempts(id) };
  }

  deliveries(subscriptionId: string, limit = 50): WebhookDelivery[] {
    this.row(subscriptionId);
    const rows = this.database.query(`SELECT ${deliveryColumns} FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id
      WHERE d.subscription_id=? ORDER BY d.created_at DESC, d.id LIMIT ?`).all(subscriptionId, Math.min(Math.max(limit, 1), 200)) as Omit<WebhookDelivery, 'attempts'>[];
    if (!rows.length) return [];
    const attempts = this.database.query(`SELECT delivery_id AS deliveryId, ${attemptColumns} FROM webhook_attempts
      WHERE delivery_id IN (SELECT value FROM json_each(?)) ORDER BY id`).all(JSON.stringify(rows.map(row => row.id))) as (WebhookAttempt & { deliveryId: string })[];
    const byDelivery = new Map<string, WebhookAttempt[]>();
    for (const { deliveryId, ...attempt } of attempts) { const list = byDelivery.get(deliveryId); if (list) list.push(attempt); else byDelivery.set(deliveryId, [attempt]); }
    return rows.map(row => ({ ...row, attempts: byDelivery.get(row.id) ?? [] }));
  }

  /**
   * Remove finished deliveries (and their attempts) last updated before the
   * retention window. Pending and in-flight deliveries are never touched. The
   * event row is kept as the idempotency record, so a re-emitted event is still
   * not delivered twice; only its payload is cleared once no delivery needs it.
   */
  pruneHistory(retentionDays = this.options.historyRetentionDays): { deliveries: number; attempts: number; events: number } {
    const cutoff = new Date(this.options.now() - retentionDays * 86_400_000).toISOString();
    return this.database.transaction(() => {
      const finished = `SELECT id FROM webhook_deliveries WHERE status NOT IN ('pending','delivering') AND updated_at < ?`;
      const attempts = this.database.query(`DELETE FROM webhook_attempts WHERE delivery_id IN (${finished})`).run(cutoff).changes;
      const deliveries = this.database.query(`DELETE FROM webhook_deliveries WHERE id IN (${finished})`).run(cutoff).changes;
      const events = this.database.query(`UPDATE webhook_events SET data='{}' WHERE created_at < ? AND data <> '{}'
        AND NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.event_id=webhook_events.id)`).run(cutoff).changes;
      return { deliveries, attempts, events };
    })();
  }

  private attempts(deliveryId: string): WebhookAttempt[] {
    return this.database.query(`SELECT ${attemptColumns} FROM webhook_attempts WHERE delivery_id=? ORDER BY id`).all(deliveryId) as WebhookAttempt[];
  }
}

function present(row: SubscriptionRow): WebhookSubscription {
  const { secret: _secret, ...rest } = row;
  return { ...rest, host: new URL(row.url).host, external: !isLoopbackUrl(row.url), eventTypes: JSON.parse(row.eventTypes), includeText: Boolean(row.includeText), enabled: Boolean(row.enabled) };
}
