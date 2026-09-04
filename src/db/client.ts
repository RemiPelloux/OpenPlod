import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

const dbPath = process.env.DATABASE_URL || './data/plaud.db';
mkdirSync(dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath);
sqlite.exec('PRAGMA journal_mode = WAL');
sqlite.exec('PRAGMA foreign_keys = ON');
sqlite.exec('PRAGMA synchronous = NORMAL');
sqlite.exec('PRAGMA busy_timeout = 5000');
sqlite.exec('PRAGMA temp_store = MEMORY');
sqlite.exec('PRAGMA cache_size = -20000');

export const db = drizzle(sqlite, { schema });
export { sqlite };
