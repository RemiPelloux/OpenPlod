import type { Database } from 'bun:sqlite';
import type { JobQueue } from '../jobs/queue';
import type { OrganizerStore } from '../organizer/store';
import { DocumentGenerationService } from '../organizer/generation';
import { onAutomationEvent } from './hooks';
import { WebhookService } from './webhooks';
import { RuleEngine } from './rules';
import { RecordingCollections } from '../knowledge/collections';
import { TaskService } from './tasks';
import { createAutomationsApi, createWebhooksApi } from './api';

/**
 * Wire webhooks, rules and reviewed tasks into the running server. Called
 * once from `src/index.ts`; nothing in this directory runs until then.
 */
export function startAutomation(params: { database: Database; queue: JobQueue; organizer: OrganizerStore; intervalMs?: number }) {
  const { database, queue, organizer } = params;
  const webhooks = new WebhookService(database);
  const collections = new RecordingCollections(database);
  const generation = new DocumentGenerationService(organizer);
  const rules = new RuleEngine(database, {
    queue, webhooks,
    generateDocument: async request => {
      await generation.generate(request, async () => {});
      return generation.save(request.idempotencyKey, { folderId: request.folderId }).id;
    },
    // Adding is idempotent (INSERT OR IGNORE), so a retried step never duplicates membership.
    addToCollection: (collectionId, recordingId) => {
      try {
        const current = collections.get(collectionId);
        collections.add(collectionId, { recordingIds: [recordingId], revision: current.revision });
        return true;
      } catch (error) {
        if ((error as { status?: number }).status === 404) return false;
        throw error;
      }
    },
  });
  const tasks = new TaskService(database);

  // Webhook outbox writes are synchronous so they share the emitter's transaction.
  onAutomationEvent(event => { webhooks.handle(event); });
  onAutomationEvent(async event => {
    if (event.type === 'recording.imported') await rules.onRecordingImported(event.recordingId);
    else if (event.type === 'recording.transcribed') await rules.onRecordingSettled(event.recordingId);
    else if (event.type === 'job.failed' && event.recordingId) await rules.onRecordingSettled(event.recordingId);
  });

  const tick = () => {
    void webhooks.deliverDue().catch(error => console.error('[Webhooks] Delivery worker failed:', error));
    void rules.resumeWaiting().catch(error => console.error('[Automation] Rule sweep failed:', error));
  };
  setInterval(tick, params.intervalMs ?? 15000).unref();
  // Delivery history is bounded: finished deliveries older than the retention window are pruned.
  const prune = () => { try { webhooks.pruneHistory(); } catch (error) { console.error('[Webhooks] History pruning failed:', error); } };
  setInterval(prune, 6 * 3600_000).unref();
  setTimeout(prune, 60_000).unref();
  setTimeout(tick, 1000).unref();

  return { webhooks, rules, tasks, webhooksApi: createWebhooksApi(webhooks), automationsApi: createAutomationsApi(rules, tasks) };
}
