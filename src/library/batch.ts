/**
 * Batch transcription and document generation (roadmap TS-10).
 *
 * A batch is a tracked list of per-item outcomes, not a fire-and-forget loop.
 * Three properties matter and are what the tests pin down:
 *
 *  - **Per-item status.** One failure never fails the batch; it fails that
 *    item and the rest continue.
 *  - **Cancellation.** Cancelling stops *queuing further work*. Items already
 *    running are marked `cancelled` only once they actually stop, so the UI
 *    never claims a stop that did not happen.
 *  - **Retry failed only.** Re-running a batch touches items that failed, and
 *    never re-submits one that already succeeded — which for a paid provider
 *    is the difference between a retry and a second charge.
 */

export type BatchItemState = 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';

export interface BatchItem {
  recordingId: string;
  state: BatchItemState;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface BatchJob {
  id: string;
  kind: 'transcribe' | 'document';
  items: BatchItem[];
  createdAt: string;
  cancelledAt: string | null;
  /** True while any item is pending or running. */
  active: boolean;
}

export interface BatchSummary {
  total: number;
  pending: number;
  running: number;
  complete: number;
  failed: number;
  cancelled: number;
}

export const summarize = (job: BatchJob): BatchSummary => ({
  total: job.items.length,
  pending: job.items.filter(item => item.state === 'pending').length,
  running: job.items.filter(item => item.state === 'running').length,
  complete: job.items.filter(item => item.state === 'complete').length,
  failed: job.items.filter(item => item.state === 'failed').length,
  cancelled: job.items.filter(item => item.state === 'cancelled').length,
});

const isActive = (job: BatchJob) => job.items.some(item => item.state === 'pending' || item.state === 'running');

/** What a batch would cost, so the caller can confirm before spending. */
export interface BatchEstimate {
  recordings: number;
  /** Items that would actually run: already-complete ones are excluded. */
  wouldRun: number;
  /** True when the work reaches a paid provider, so confirmation is required. */
  usesCloudProvider: boolean;
  provider: string | null;
  /**
   * Deliberately absent. Providers price per second of audio or per token and
   * OpenPlod does not know either before the call, so a number here would be
   * invented. The caller confirms scope, not a fabricated figure.
   */
  estimatedCost: null;
}

export type BatchRunner = (recordingId: string, signal: AbortSignal) => Promise<void>;

/**
 * Runs batches in memory.
 *
 * Deliberately not persisted: a batch is a foreground operation the user is
 * watching. Durable per-recording work already lives in the job queue, which
 * is what each item ultimately drives.
 */
export class BatchManager {
  private jobs = new Map<string, BatchJob>();
  private controllers = new Map<string, AbortController>();

  constructor(private readonly concurrency = 2) {}

  get(id: string): BatchJob | null {
    const job = this.jobs.get(id);
    return job ? { ...job, items: job.items.map(item => ({ ...item })), active: isActive(job) } : null;
  }

  list(): BatchJob[] {
    return [...this.jobs.values()].map(job => ({ ...job, items: job.items.map(item => ({ ...item })), active: isActive(job) }));
  }

  /** Stop queuing new work. Running items settle as `cancelled` when they stop. */
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || !isActive(job)) return false;
    job.cancelledAt = new Date().toISOString();
    this.controllers.get(id)?.abort();
    // Only not-yet-started items can be cancelled synchronously and honestly.
    for (const item of job.items) if (item.state === 'pending') item.state = 'cancelled';
    return true;
  }

  /**
   * Start a batch. `retryOf` re-runs only the failed items of an earlier
   * batch, so a successful item is never submitted — or charged — twice.
   */
  start(options: { kind: BatchJob['kind']; recordingIds: string[]; runner: BatchRunner; retryOf?: string }): BatchJob {
    const source = options.retryOf ? this.jobs.get(options.retryOf) : null;
    const ids = source
      ? source.items.filter(item => item.state === 'failed').map(item => item.recordingId)
      : [...new Set(options.recordingIds)];
    if (ids.length === 0) throw new Error(source ? 'That batch has no failed items to retry.' : 'Select at least one recording.');

    const job: BatchJob = {
      id: crypto.randomUUID(),
      kind: options.kind,
      items: ids.map(recordingId => ({ recordingId, state: 'pending' as const })),
      createdAt: new Date().toISOString(),
      cancelledAt: null,
      active: true,
    };
    this.jobs.set(job.id, job);
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    void this.drain(job, options.runner, controller);
    return this.get(job.id)!;
  }

  /** Work the queue at bounded concurrency until it is empty or cancelled. */
  private async drain(job: BatchJob, runner: BatchRunner, controller: AbortController): Promise<void> {
    const queue = [...job.items];
    const worker = async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        if (job.cancelledAt) { if (item.state === 'pending') item.state = 'cancelled'; continue; }
        item.state = 'running';
        item.startedAt = new Date().toISOString();
        try {
          await runner(item.recordingId, controller.signal);
          // A cancel that lands mid-item is reported as cancelled, not complete.
          item.state = controller.signal.aborted ? 'cancelled' : 'complete';
        } catch (error) {
          item.state = controller.signal.aborted ? 'cancelled' : 'failed';
          if (item.state === 'failed') item.error = error instanceof Error ? error.message : 'Failed.';
        } finally {
          item.finishedAt = new Date().toISOString();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, job.items.length) }, worker));
    this.controllers.delete(job.id);
  }

  /** Drop finished batches older than the retention window. */
  prune(maxAgeMs = 3_600_000): number {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [id, job] of this.jobs) {
      if (!isActive(job) && Date.parse(job.createdAt) < cutoff) { this.jobs.delete(id); removed += 1; }
    }
    return removed;
  }
}
