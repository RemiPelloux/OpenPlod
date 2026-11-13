import type { Database } from 'bun:sqlite';

/**
 * Count the statements a block prepares on `database` (through `query` or
 * `prepare`). Used by N+1 regression tests: a list path should prepare the
 * same number of statements for one row as for fifty.
 */
export async function countQueries<T>(database: Database, run: () => T | Promise<T>): Promise<{ result: T; count: number }> {
  const query = database.query, prepare = database.prepare;
  let count = 0;
  database.query = ((sql: string) => { count++; return query.call(database, sql); }) as typeof database.query;
  database.prepare = ((sql: string, ...rest: unknown[]) => { count++; return (prepare as (...args: unknown[]) => unknown).call(database, sql, ...rest); }) as typeof database.prepare;
  try { return { result: await run(), count }; }
  finally { database.query = query; database.prepare = prepare; }
}
