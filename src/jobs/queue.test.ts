import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { JobQueue } from './queue';
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
test('queue persists pending jobs, deduplicates recording work and respects priority', async () => {
  const db = new Database(':memory:'), queue = new JobQueue(db);
  const first = await queue.add('task', { recordingId: 'one' }, 0);
  expect((await queue.add('task', { recordingId: 'one' }, 5)).id).toBe(first.id);
  await queue.add('task', { recordingId: 'two' }, 5);
  const recovered = new JobQueue(db), seen: string[] = [];
  recovered.register('task', async (data: { recordingId: string }) => { seen.push(data.recordingId); });
  await tick(); expect(seen).toEqual(['two', 'one']); expect(recovered.getStats().complete).toBe(2); db.close();
});
test('restart recovers known remote jobs but never resubmits uncertain work', async () => {
  const db = new Database(':memory:'), initial = new JobQueue(db);
  for (const remote of [true, false]) {
    const id = crypto.randomUUID();
    db.query('INSERT INTO processing_jobs VALUES(?,?)').run(id, JSON.stringify({ id, type: 'task', data: { recordingId: id }, priority: 0, status: 'running', createdAt: new Date(), checkpoint: remote ? { phase: 'polling', remoteId: 'provider-id' } : { phase: 'submitting' } }));
  }
  const recovered = new JobQueue(db); expect(recovered.getStats().pending).toBe(1); expect(recovered.getStats().failed).toBe(1);
  let count = 0; recovered.register('task', async (_data, context) => { count++; expect(context.checkpoint?.remoteId).toBe('provider-id'); });
  await tick(); expect(count).toBe(1); db.close();
});
test('cancel aborts local work and resumes polling only after the old handler settles', async () => {
  const db = new Database(':memory:'), queue = new JobQueue(db);
  queue.register('task', async (_data, context) => { context.saveCheckpoint({ phase: 'polling', remoteId: 'remote' }); await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true })); });
  const job = await queue.add('task', { recordingId: 'one' }); await tick();
  expect(queue.cancel(job.id)).toBe(true); expect(queue.resume(job.id)).toBe(false); await tick();
  expect(queue.getJobs()[0].status).toBe('cancelled');
  queue.register('task', async (_data, context) => { expect(context.checkpoint?.remoteId).toBe('remote'); });
  expect(queue.resume(job.id)).toBe(true); await tick(); expect(queue.getJobs()[0].status).toBe('complete'); db.close();
});
