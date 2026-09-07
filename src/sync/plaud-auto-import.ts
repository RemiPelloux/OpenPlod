import type { Database } from 'bun:sqlite';
import { directPlaudConfigured, importDirectPlaudRecording, readDirectPlaudRecordings } from './plaud-direct';

export class PlaudAutoImport {
  private running = false;
  private previous = new Map<string, number>();
  private lastChecked: string | null = null;
  private error: string | null = null;
  private failures = 0;
  private retryAt = 0;
  constructor(private database: Database, private adapter = { configured: directPlaudConfigured, list: readDirectPlaudRecordings, import: importDirectPlaudRecording }) {
    database.exec(`CREATE TABLE IF NOT EXISTS plaud_import_events (id INTEGER PRIMARY KEY AUTOINCREMENT, recording_id TEXT NOT NULL, created_at TEXT NOT NULL);`);
  }
  enabled() { return (this.database.query("SELECT value FROM user_settings WHERE key='directPlaudAutoImport'").get() as { value: string } | null)?.value === 'true'; }
  set(enabled: boolean) {
    if (enabled && !this.adapter.configured()) throw new Error('Authorize this Note Pro on the Mac first.');
    this.database.query("INSERT INTO user_settings(key,value) VALUES('directPlaudAutoImport',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(enabled));
    return this.status();
  }
  status() { return { enabled: this.enabled(), running: this.running, lastChecked: this.lastChecked, error: this.error,
    events: this.database.query('SELECT id,recording_id AS recordingId,created_at AS createdAt FROM plaud_import_events ORDER BY id DESC LIMIT 10').all() }; }
  async tick() {
    if (this.running || !this.enabled() || Date.now() < this.retryAt) return;
    this.running = true;
    try {
      const result = await this.adapter.list(); this.lastChecked = result.checkedAt;
      const observed = new Map<string, number>();
      for (const session of result.sessions) {
        const source = `${result.serial}:${session.sessionId}`; observed.set(source, session.size);
        if (!this.enabled()) break;
        // Wait for an unchanged second observation so in-progress recordings are not imported.
        if (session.size <= 512 || this.previous.get(source) !== session.size) continue;
        if (this.database.query('SELECT id FROM recordings WHERE source_provider=? AND source_recording_id=?').get('plaud', source)) continue;
        const imported = await this.adapter.import(session.sessionId);
        if (imported.added) this.database.query('INSERT INTO plaud_import_events(recording_id,created_at) VALUES(?,?)').run(imported.recording.id, new Date().toISOString());
      }
      this.previous = observed; this.failures = 0; this.error = null; this.retryAt = 0;
      this.database.query('DELETE FROM plaud_import_events WHERE id NOT IN (SELECT id FROM plaud_import_events ORDER BY id DESC LIMIT 100)').run();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Plaud automatic import unavailable.';
      this.retryAt = Date.now() + Math.min(15 * 60000, 30000 * 2 ** Math.min(this.failures++, 5));
    } finally { this.running = false; }
  }
}
