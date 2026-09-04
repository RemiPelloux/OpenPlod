/**
 * In-memory job queue for single-user app.
 * Replaces BullMQ — just processes jobs sequentially.
 */

export interface Job<T = unknown> {
  id: string;
  type: string;
  data: T;
  status: 'pending' | 'running' | 'complete' | 'failed';
  error?: string;
  createdAt: Date;
  completedAt?: Date;
}

type JobHandler<T = unknown> = (data: T) => Promise<void>;

class JobQueue {
  private static readonly MAX_FINISHED_JOBS = 200;
  private jobs: Job[] = [];
  private handlers: Map<string, JobHandler<any>> = new Map();
  private processing = false;

  register<T>(type: string, handler: JobHandler<T>) {
    this.handlers.set(type, handler);
  }

  async add<T>(type: string, data: T): Promise<Job<T>> {
    const job: Job<T> = {
      id: crypto.randomUUID(),
      type,
      data,
      status: 'pending',
      createdAt: new Date(),
    };
    this.jobs.push(job as Job);
    console.log(`[Queue] Added job ${job.id} (${type})`);

    // Process async without blocking
    if (!this.processing) {
      this.processNext();
    }

    return job;
  }

  private async processNext() {
    this.processing = true;

    while (true) {
      const job = this.jobs.find(j => j.status === 'pending');
      if (!job) break;

      const handler = this.handlers.get(job.type);
      if (!handler) {
        job.status = 'failed';
        job.error = `No handler for job type: ${job.type}`;
        continue;
      }

      job.status = 'running';
      try {
        await handler(job.data);
        job.status = 'complete';
        job.completedAt = new Date();
        console.log(`[Queue] Job ${job.id} (${job.type}) complete`);
      } catch (err) {
        job.status = 'failed';
        job.error = String(err);
        console.error(`[Queue] Job ${job.id} (${job.type}) failed:`, err);
      }
      this.pruneFinishedJobs();
    }

    this.processing = false;
  }

  getJobs(status?: Job['status']): Job[] {
    return status ? this.jobs.filter(j => j.status === status) : [...this.jobs];
  }

  getStats() {
    return {
      total: this.jobs.length,
      pending: this.jobs.filter(j => j.status === 'pending').length,
      running: this.jobs.filter(j => j.status === 'running').length,
      complete: this.jobs.filter(j => j.status === 'complete').length,
      failed: this.jobs.filter(j => j.status === 'failed').length,
    };
  }

  private pruneFinishedJobs() {
    const finished = this.jobs.filter(job => job.status === 'complete' || job.status === 'failed');
    const overflow = finished.length - JobQueue.MAX_FINISHED_JOBS;
    if (overflow <= 0) return;

    const expiredIds = new Set(finished.slice(0, overflow).map(job => job.id));
    this.jobs = this.jobs.filter(job => !expiredIds.has(job.id));
  }
}

export const jobQueue = new JobQueue();
