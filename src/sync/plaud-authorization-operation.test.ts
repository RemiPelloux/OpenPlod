import { expect, test } from 'bun:test';
import { PlaudAuthorizationOperation } from './plaud-authorization-operation';

test('cancellation before arrival prevents work and a new operation can retry', async () => {
  const operation = new PlaudAuthorizationOperation();
  await operation.cancel('cancelled');
  let calls = 0;
  await expect(operation.run('cancelled', async () => ++calls)).rejects.toThrow('cancelled');
  expect(calls).toBe(0);
  expect(await operation.run('new', async () => ++calls)).toBe(1);
});

test('cancellation settles active work before acknowledging and concurrent work is rejected', async () => {
  const operation = new PlaudAuthorizationOperation();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let wrote = false;
  const running = operation.run('one', async signal => { await gate; signal.throwIfAborted(); wrote = true; });
  const rejected = running.then(() => null, error => error as Error);
  await expect(operation.run('two', async () => {})).rejects.toThrow('already running');
  await operation.cancel('different-id');
  let acknowledged = false;
  const cancellation = operation.cancel('one').then(() => { acknowledged = true; });
  await Promise.resolve();
  expect(acknowledged).toBe(false);
  release();
  const [error] = await Promise.all([rejected, cancellation]);
  expect(error?.message).toContain('cancelled');
  expect(wrote).toBe(false);
  expect(acknowledged).toBe(true);
});
