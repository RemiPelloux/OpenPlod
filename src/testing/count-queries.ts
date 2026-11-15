import type { Database } from 'bun:sqlite';

/**
 * Count the statements a block prepares on `database` (through `query` or
 * `prepare`). Used by N+1 regression tests: a list path should prepare the
 * same number of statements for one row as for fifty.
 *
 * Nested calls are not counted: some Bun versions implement `query` by calling
 * `prepare` on a cache miss, which would count a first-time statement twice.
 */
export async function countQueries<T>(database: Database, run: () => T | Promise<T>): Promise<{ result: T; count: number }> {
  const query = database.query, prepare = database.prepare;
  let count = 0, depth = 0;
  const counted = <R>(call: () => R): R => {
    if (depth === 0) count++;
    depth++;
    try { return call(); } finally { depth--; }
  };
  database.query = ((sql: string) => counted(() => query.call(database, sql))) as typeof database.query;
  database.prepare = ((sql: string, ...rest: unknown[]) => counted(() => (prepare as (...args: unknown[]) => unknown).call(database, sql, ...rest))) as typeof database.prepare;
  try { return { result: await run(), count }; }
  finally { database.query = query; database.prepare = prepare; }
}
