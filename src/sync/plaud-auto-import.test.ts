import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { PlaudAutoImport } from './plaud-auto-import';
test('automatic import requires opt-in and stable recordings, deduplicates and retains failures as unknown', async () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE user_settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE recordings(id TEXT,source_provider TEXT,source_recording_id TEXT)');
    let calls = 0, imports = 0, fail = false;
    const automatic = new PlaudAutoImport(db, {
      configured: () => true,
      list: async () => { calls++; if (fail) throw new Error('Bluetooth disconnected'); return { serial: 'device', checkedAt: new Date().toISOString(), sessions: [{ sessionId: 7, size: 1000, scene: 0, timezone: 0 }] }; },
      import: async () => { imports++; db.query('INSERT INTO recordings VALUES(?,?,?)').run('saved-id', 'plaud', 'device:7'); return { added: true, durationMs: 1000, sourceRetained: true, recording: { id: 'saved-id', filePath: 'test', originalFilename: 'test', fingerprint: 'test', sourceRecordingId: 'device:7' } }; },
    });
    await automatic.tick(); expect(calls).toBe(0);
    automatic.set(true); await automatic.tick(); expect(imports).toBe(0); await automatic.tick(); expect(imports).toBe(1);
    await automatic.tick(); expect(imports).toBe(1); expect(automatic.status().events).toHaveLength(1);
    fail = true; await automatic.tick(); expect(automatic.status().error).toBe('Bluetooth disconnected');
    const previousCalls = calls; await automatic.tick(); expect(calls).toBe(previousCalls);
  } finally { db.close(); }
});
