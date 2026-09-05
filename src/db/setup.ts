import { sqlite } from './client';

const SCHEMA_VERSION = 2;

export function initializeDatabase() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS recordings (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      original_filename TEXT,
      duration_seconds INTEGER,
      file_size_bytes INTEGER,
      recording_type TEXT NOT NULL,
      context TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      recorded_at TEXT,
      uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT,
      error_message TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS transcripts (
      id TEXT PRIMARY KEY,
      recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
      full_text TEXT NOT NULL,
      segments TEXT,
      word_count INTEGER,
      speaker_count INTEGER,
      confidence_score REAL,
      summary TEXT,
      extracted_tasks TEXT,
      analyzed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS transcript_versions (
      id TEXT PRIMARY KEY,
      recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
      full_text TEXT NOT NULL,
      segments TEXT,
      origin TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS speaker_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      sample_count INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS speaker_mappings (
      id TEXT PRIMARY KEY,
      transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
      speaker_id INTEGER NOT NULL,
      profile_id TEXT REFERENCES speaker_profiles(id) ON DELETE SET NULL,
      confidence REAL,
      manually_assigned INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY,
      recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
      summary TEXT,
      extracted_tasks TEXT,
      analyzed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS user_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const version = sqlite.query('PRAGMA user_version').get() as { user_version: number };
  if (version.user_version < SCHEMA_VERSION) {
    sqlite.transaction(() => {
      if (version.user_version < 2) {
        sqlite.exec(`
          ALTER TABLE recordings ADD COLUMN source_provider TEXT;
          ALTER TABLE recordings ADD COLUMN source_recording_id TEXT;
          ALTER TABLE recordings ADD COLUMN source_transport TEXT;
          ALTER TABLE recordings ADD COLUMN fingerprint TEXT;
          ALTER TABLE recordings ADD COLUMN retention_state TEXT NOT NULL DEFAULT 'active';
          ALTER TABLE recordings ADD COLUMN deleted_at TEXT;
          ALTER TABLE recordings ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
          ALTER TABLE recordings ADD COLUMN notes TEXT;
          ALTER TABLE recordings ADD COLUMN tags TEXT;
          ALTER TABLE recordings ADD COLUMN forwarding_status TEXT NOT NULL DEFAULT 'not_configured';
          ALTER TABLE recordings ADD COLUMN forwarding_run_id TEXT;
          ALTER TABLE recordings ADD COLUMN forwarding_error TEXT;
          CREATE TABLE IF NOT EXISTS transcript_versions (
            id TEXT PRIMARY KEY,
            recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
            full_text TEXT NOT NULL,
            segments TEXT,
            origin TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
        `);
      }
      // Earlier builds could create multiple transcripts when reprocessing a recording.
      sqlite.exec(`
        DELETE FROM transcripts
        WHERE rowid NOT IN (
          SELECT MAX(rowid) FROM transcripts GROUP BY recording_id
        );

        CREATE INDEX IF NOT EXISTS idx_recordings_recorded_at ON recordings(recorded_at DESC);
        CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status);
        CREATE INDEX IF NOT EXISTS idx_recordings_type ON recordings(recording_type);
        CREATE INDEX IF NOT EXISTS idx_recordings_file_path ON recordings(file_path);
        CREATE INDEX IF NOT EXISTS idx_recordings_fingerprint ON recordings(fingerprint);
        CREATE INDEX IF NOT EXISTS idx_recordings_source_recording_id ON recordings(source_recording_id);
        CREATE INDEX IF NOT EXISTS idx_recordings_retention_state ON recordings(retention_state);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_transcripts_recording_id ON transcripts(recording_id);
        CREATE INDEX IF NOT EXISTS idx_transcript_versions_recording_id ON transcript_versions(recording_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_speaker_mappings_transcript_id ON speaker_mappings(transcript_id);
        CREATE INDEX IF NOT EXISTS idx_analyses_recording_id ON analyses(recording_id);

        CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(
          full_text,
          content='transcripts',
          content_rowid='rowid',
          tokenize='unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER IF NOT EXISTS transcripts_fts_insert AFTER INSERT ON transcripts BEGIN
          INSERT INTO transcripts_fts(rowid, full_text) VALUES (new.rowid, new.full_text);
        END;
        CREATE TRIGGER IF NOT EXISTS transcripts_fts_delete AFTER DELETE ON transcripts BEGIN
          INSERT INTO transcripts_fts(transcripts_fts, rowid, full_text)
          VALUES ('delete', old.rowid, old.full_text);
        END;
        CREATE TRIGGER IF NOT EXISTS transcripts_fts_update AFTER UPDATE OF full_text ON transcripts BEGIN
          INSERT INTO transcripts_fts(transcripts_fts, rowid, full_text)
          VALUES ('delete', old.rowid, old.full_text);
          INSERT INTO transcripts_fts(rowid, full_text) VALUES (new.rowid, new.full_text);
        END;

        INSERT INTO transcripts_fts(transcripts_fts) VALUES ('rebuild');
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
    })();
  }

  sqlite.exec('PRAGMA optimize');
}
