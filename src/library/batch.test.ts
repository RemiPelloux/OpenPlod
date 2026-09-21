import { describe, expect, test } from 'bun:test';
import { BatchManager, summarize } from './batch';

/** Wait until a predicate holds, so tests never race the drain loop. */
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the batch');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const settled = (manager: BatchManager, id: string) => () => manager.get(id)?.active === false;

describe('batch execution', () => {
  test('runs every item and reports each as complete', async () => {
    const manager = new BatchManager();
    const seen: string[] = [];
    const job = manager.start({
      kind: 'transcribe', recordingIds: ['a', 'b', 'c'],
      runner: async id => { seen.push(id); },
    });
    await until(settled(manager, job.id));
    expect(seen.sort()).toEqual(['a', 'b', 'c']);
    expect(summarize(manager.get(job.id)!)).toMatchObject({ total: 3, complete: 3, failed: 0 });
  });

  test('one failure does not stop the rest of the batch', async () => {
    const manager = new BatchManager();
    const job = manager.start({
      kind: 'transcribe', recordingIds: ['ok1', 'bad', 'ok2'],
      runner: async id => { if (id === 'bad') throw new Error('provider exploded'); },
    });
    await until(settled(manager, job.id));
    const result = manager.get(job.id)!;
    expect(summarize(result)).toMatchObject({ complete: 2, failed: 1 });
    expect(result.items.find(item => item.recordingId === 'bad')?.error).toBe('provider exploded');
  });

  test('records per-item timing', async () => {
    const manager = new BatchManager();
    const job = manager.start({ kind: 'transcribe', recordingIds: ['a'], runner: async () => {} });
    await until(settled(manager, job.id));
    const item = manager.get(job.id)!.items[0]!;
    expect(item.startedAt).toBeTruthy();
    expect(item.finishedAt).toBeTruthy();
  });

  test('deduplicates repeated recording IDs', async () => {
    const manager = new BatchManager();
    let calls = 0;
    const job = manager.start({ kind: 'transcribe', recordingIds: ['a', 'a', 'a'], runner: async () => { calls += 1; } });
    await until(settled(manager, job.id));
    expect(calls).toBe(1);
    expect(manager.get(job.id)!.items).toHaveLength(1);
  });

  test('respects the concurrency limit', async () => {
    const manager = new BatchManager(2);
    let running = 0;
    let peak = 0;
    const job = manager.start({
      kind: 'transcribe', recordingIds: ['a', 'b', 'c', 'd', 'e'],
      runner: async () => {
        running += 1; peak = Math.max(peak, running);
        await new Promise(resolve => setTimeout(resolve, 15));
        running -= 1;
      },
    });
    await until(settled(manager, job.id), 5000);
    expect(peak).toBeLessThanOrEqual(2);
  });

  test('refuses an empty selection', () => {
    const manager = new BatchManager();
    expect(() => manager.start({ kind: 'transcribe', recordingIds: [], runner: async () => {} }))
      .toThrow(/at least one recording/i);
  });
});

describe('cancellation', () => {
  test('cancels queued items and stops starting new work', async () => {
    const manager = new BatchManager(1);
    let started = 0;
    const job = manager.start({
      kind: 'transcribe', recordingIds: ['a', 'b', 'c', 'd'],
      runner: async () => { started += 1; await new Promise(resolve => setTimeout(resolve, 30)); },
    });
    await until(() => started >= 1);
    manager.cancel(job.id);
    await until(settled(manager, job.id), 5000);
    const result = manager.get(job.id)!;
    expect(summarize(result).cancelled).toBeGreaterThan(0);
    // Cancelling must actually prevent work, not merely relabel it.
    expect(started).toBeLessThan(4);
  });

  test('an item interrupted mid-flight is cancelled, not failed', async () => {
    const manager = new BatchManager(1);
    // The runner is invoked before start() returns, so the test waits for it
    // to signal rather than racing to capture the job handle.
    let announceStart: () => void = () => {};
    const running = new Promise<void>(resolve => { announceStart = resolve; });
    const job = manager.start({
      kind: 'transcribe', recordingIds: ['a'],
      runner: async (_id, signal) => {
        announceStart();
        await new Promise(resolve => setTimeout(resolve, 30));
        signal.throwIfAborted();
      },
    });
    await running;
    manager.cancel(job.id);
    await until(settled(manager, job.id), 5000);
    const item = manager.get(job.id)!.items[0]!;
    expect(item.state).toBe('cancelled');
    // A cancelled item must not carry a failure message.
    expect(item.error).toBeUndefined();
  });

  test('cancelling a finished batch reports that nothing was stopped', async () => {
    const manager = new BatchManager();
    const job = manager.start({ kind: 'transcribe', recordingIds: ['a'], runner: async () => {} });
    await until(settled(manager, job.id));
    expect(manager.cancel(job.id)).toBe(false);
  });

  test('cancelling an unknown batch is false rather than an error', () => {
    expect(new BatchManager().cancel('nope')).toBe(false);
  });
});

describe('retry failed only', () => {
  test('re-runs only the failed items', async () => {
    const manager = new BatchManager();
    const first = manager.start({
      kind: 'transcribe', recordingIds: ['ok', 'bad1', 'bad2'],
      runner: async id => { if (id.startsWith('bad')) throw new Error('nope'); },
    });
    await until(settled(manager, first.id));

    const attempted: string[] = [];
    const retry = manager.start({ kind: 'transcribe', recordingIds: [], runner: async id => { attempted.push(id); }, retryOf: first.id });
    await until(settled(manager, retry.id));
    // Re-submitting a succeeded item would be a second charge, not a retry.
    expect(attempted.sort()).toEqual(['bad1', 'bad2']);
    expect(manager.get(retry.id)!.items).toHaveLength(2);
  });

  test('refuses to retry when nothing failed', async () => {
    const manager = new BatchManager();
    const job = manager.start({ kind: 'transcribe', recordingIds: ['a'], runner: async () => {} });
    await until(settled(manager, job.id));
    expect(() => manager.start({ kind: 'transcribe', recordingIds: [], runner: async () => {}, retryOf: job.id }))
      .toThrow(/no failed items/i);
  });

  test('the original batch is left untouched by a retry', async () => {
    const manager = new BatchManager();
    const first = manager.start({
      kind: 'transcribe', recordingIds: ['ok', 'bad'],
      runner: async id => { if (id === 'bad') throw new Error('nope'); },
    });
    await until(settled(manager, first.id));
    const before = JSON.stringify(manager.get(first.id));
    const retry = manager.start({ kind: 'transcribe', recordingIds: [], runner: async () => {}, retryOf: first.id });
    await until(settled(manager, retry.id));
    expect(JSON.stringify(manager.get(first.id))).toBe(before);
  });
});

describe('inspection and retention', () => {
  test('returns copies so callers cannot mutate live state', async () => {
    const manager = new BatchManager();
    const job = manager.start({ kind: 'transcribe', recordingIds: ['a'], runner: async () => {} });
    await until(settled(manager, job.id));
    const snapshot = manager.get(job.id)!;
    snapshot.items[0]!.state = 'failed';
    expect(manager.get(job.id)!.items[0]!.state).toBe('complete');
  });

  test('lists batches and reports an unknown one as null', async () => {
    const manager = new BatchManager();
    manager.start({ kind: 'document', recordingIds: ['a'], runner: async () => {} });
    await until(() => manager.list().every(job => !job.active));
    expect(manager.list()).toHaveLength(1);
    expect(manager.get('missing')).toBeNull();
  });

  test('prunes only finished batches past the retention window', async () => {
    const manager = new BatchManager();
    const job = manager.start({ kind: 'transcribe', recordingIds: ['a'], runner: async () => {} });
    await until(settled(manager, job.id));
    expect(manager.prune(3_600_000)).toBe(0);
    expect(manager.prune(-1)).toBe(1);
    expect(manager.get(job.id)).toBeNull();
  });
});
