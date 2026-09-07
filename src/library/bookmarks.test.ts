import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { RecordingBookmarks } from './bookmarks';
test('bookmarks persist, deduplicate, stay in bounds and follow recording retention', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE recordings(id TEXT PRIMARY KEY,duration_seconds REAL,retention_state TEXT)');
    const recordingId = crypto.randomUUID(), id = crypto.randomUUID(); db.query('INSERT INTO recordings VALUES(?,60,?)').run(recordingId, 'active');
    const store = new RecordingBookmarks(db), input = { id, seconds: 20, label: 'Decision' };
    expect(store.add(recordingId, input)).toHaveLength(1); expect(store.add(recordingId, input)).toHaveLength(1);
    expect(() => store.add(recordingId, { ...input, seconds: 21 })).toThrow('conflict');
    expect(() => store.add(recordingId, { ...input, seconds: 61 })).toThrow('outside');
    db.exec("UPDATE recordings SET retention_state='trash'"); expect(() => store.list(recordingId)).toThrow('Active');
    db.exec("UPDATE recordings SET retention_state='active'"); expect(store.list(recordingId)).toHaveLength(1); expect(store.remove(recordingId, id)).toEqual([]);
  } finally { db.close(); }
});
