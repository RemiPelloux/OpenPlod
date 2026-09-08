import type { Database } from 'bun:sqlite';
import { sqlite } from '../db/client';
import { readAiConfig } from '../ai/config';

export interface Job<T = unknown> {
  id: string; type: string; data: T; status: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';
  error?: string; createdAt: Date; completedAt?: Date; priority: number;
  checkpoint?: { phase: string; remoteId?: string };
}
export type JobContext = { id: string; signal: AbortSignal; checkpoint?: Job['checkpoint']; saveCheckpoint: (checkpoint: NonNullable<Job['checkpoint']>) => void };
type JobHandler<T = unknown> = (data: T, context: JobContext) => Promise<void>;

export class JobQueue {
  private jobs: Job[] = [];
  private handlers = new Map<string, JobHandler<any>>();
  private processing = false;
  private controllers = new Map<string, AbortController>();
  constructor(private database: Database) {
    database.exec('CREATE TABLE IF NOT EXISTS processing_jobs(id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
    for (const row of database.query('SELECT payload FROM processing_jobs ORDER BY rowid').all() as { payload: string }[]) {
      const value = JSON.parse(row.payload);
      const job = { ...value, createdAt: new Date(value.createdAt), completedAt: value.completedAt ? new Date(value.completedAt) : undefined } as Job;
      if (job.status === 'running') {
        job.status = job.checkpoint?.remoteId ? 'pending' : 'failed';
        job.error = job.status === 'failed' ? 'Interrupted during processing. Provider outcome may be unknown; check usage before retrying.' : undefined;
        this.persist(job);
      }
      this.jobs.push(job);
    }
  }
  private persist(job: Job) { this.database.query('INSERT INTO processing_jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(job.id, JSON.stringify(job)); }
  register<T>(type: string, handler: JobHandler<T>) { this.handlers.set(type, handler); queueMicrotask(() => { void this.processNext(); }); }
  async add<T>(type: string, data: T, priority = 0): Promise<Job<T>> {
    const input = data as Record<string, unknown>;
    const existing = this.jobs.find(job => job.type === type && (job.data as any).recordingId === input.recordingId && ['pending', 'running'].includes(job.status));
    if (existing && input.recordingId) return existing as Job<T>;
    let savedData = data;
    if (type === 'process-recording') {
      const recording = this.database.query('SELECT fingerprint FROM recordings WHERE id=?').get(String(input.recordingId)) as { fingerprint: string | null } | null;
      savedData = { ...input, config: input.config ?? readAiConfig(this.database), fingerprint: recording?.fingerprint ?? null } as T;
    }
    const job: Job<T> = { id: crypto.randomUUID(), type, data: savedData, priority, status: 'pending', createdAt: new Date() };
    this.persist(job); this.jobs.push(job);
    queueMicrotask(() => { void this.processNext(); });
    return job;
  }
  cancel(id: string) {
    const job = this.jobs.find(item => item.id === id);
    if (!job || !['pending', 'running'].includes(job.status)) return false;
    job.status = 'cancelled'; job.completedAt = new Date();
    job.error = job.checkpoint?.remoteId ? 'Local polling cancelled. Remote processing may continue.' : 'Cancelled. Any submitted provider request may still be billed.';
    if (job.type === 'process-recording') this.database.query("UPDATE recordings SET status='failed',error_message='Processing cancelled.' WHERE id=? AND retention_state='active'").run(String((job.data as any).recordingId));
    this.persist(job); this.controllers.get(id)?.abort(); return true;
  }
  resume(id: string) {
    const job = this.jobs.find(item => item.id === id);
    if (!job?.checkpoint?.remoteId || !['failed', 'cancelled'].includes(job.status) || this.controllers.has(id)) return false;
    const other = this.jobs.some(item => item.id !== id && ['pending', 'running'].includes(item.status) && (item.data as any).recordingId === (job.data as any).recordingId);
    if (other) return false;
    job.status = 'pending'; job.error = undefined; job.completedAt = undefined; this.persist(job);
    if (job.type === 'process-recording') this.database.query("UPDATE recordings SET status='pending',error_message=NULL WHERE id=? AND retention_state='active'").run(String((job.data as any).recordingId));
    queueMicrotask(() => { void this.processNext(); }); return true;
  }
  setPriority(id: string, priority: number) {
    const job = this.jobs.find(item => item.id === id && item.status === 'pending');
    if (!job || !Number.isInteger(priority) || priority < -10 || priority > 10) return false;
    job.priority = priority; this.persist(job); return true;
  }
  private async processNext() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (true) {
        const job = this.jobs.filter(j => j.status === 'pending' && this.handlers.has(j.type)).sort((a, b) => b.priority - a.priority)[0];
        if (!job) break;
        const controller = new AbortController(); this.controllers.set(job.id, controller);
        job.status = 'running'; this.persist(job);
        try {
          await this.handlers.get(job.type)!(job.data, { id: job.id, signal: controller.signal, checkpoint: job.checkpoint,
            saveCheckpoint: checkpoint => { job.checkpoint = checkpoint; this.persist(job); } });
          if (!controller.signal.aborted) job.status = 'complete';
        } catch (error) {
          if (!controller.signal.aborted) { job.status = 'failed'; job.error = error instanceof Error ? error.message : 'Processing failed.'; }
        } finally {
          job.completedAt = new Date(); this.persist(job); this.controllers.delete(job.id);
        }
      }
    } finally { this.processing = false; }
  }
  getJobs(status?: Job['status']) { return this.jobs.filter(job => !status || job.status === status).slice(-200); }
  getStats(): Record<Job['status'] | 'total', number> { return { total: this.jobs.length, ...Object.fromEntries(['pending', 'running', 'complete', 'failed', 'cancelled'].map(status => [status, this.jobs.filter(job => job.status === status).length])) } as Record<Job['status'] | 'total', number>; }
}
export const jobQueue = new JobQueue(sqlite);
