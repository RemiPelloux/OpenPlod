import type { Database } from 'bun:sqlite';
import { z } from 'zod';

export class RecordingBookmarks {
  constructor(private database: Database) {
    database.exec(`CREATE TABLE IF NOT EXISTS recording_bookmarks(id TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
      seconds REAL NOT NULL, label TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_recording_bookmarks ON recording_bookmarks(recording_id,seconds);`);
  }
  private active(id: string) {
    z.string().uuid().parse(id);
    const row = this.database.query("SELECT duration_seconds AS duration FROM recordings WHERE id=? AND retention_state='active'").get(id) as { duration: number | null } | null;
    if (!row) throw new Error('Active recording not found.'); return row;
  }
  list(id: string) { this.active(id); return this.database.query('SELECT id,seconds,label,created_at AS createdAt FROM recording_bookmarks WHERE recording_id=? ORDER BY seconds,id').all(id); }
  add(recordingId: string, input: unknown) {
    const recording = this.active(recordingId);
    const data = z.object({ id: z.string().uuid(), seconds: z.number().finite().nonnegative().max(86400), label: z.string().trim().min(1).max(160) }).strict().parse(input);
    if (recording.duration && data.seconds > recording.duration) throw new Error('Bookmark is outside the recording.');
    const existing = this.database.query('SELECT recording_id,seconds,label FROM recording_bookmarks WHERE id=?').get(data.id) as { recording_id: string; seconds: number; label: string } | null;
    if (existing && (existing.recording_id !== recordingId || existing.seconds !== data.seconds || existing.label !== data.label)) throw new Error('Bookmark ID conflict.');
    this.database.query('INSERT OR IGNORE INTO recording_bookmarks VALUES(?,?,?,?,?)').run(data.id, recordingId, data.seconds, data.label, new Date().toISOString());
    return this.list(recordingId);
  }
  remove(recordingId: string, id: string) { this.active(recordingId); z.string().uuid().parse(id); this.database.query('DELETE FROM recording_bookmarks WHERE recording_id=? AND id=?').run(recordingId, id); return this.list(recordingId); }
}
