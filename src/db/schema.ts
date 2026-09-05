import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ============================================
// RECORDINGS
// ============================================

export const recordings = sqliteTable('recordings', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  filePath: text('file_path').notNull(),
  originalFilename: text('original_filename'),
  durationSeconds: integer('duration_seconds'),
  fileSizeBytes: integer('file_size_bytes'),

  // Classification
  recordingType: text('recording_type').notNull(), // class, meeting, conversation, other
  context: text('context'),

  // Processing status
  status: text('status').default('pending').notNull(), // pending, transcribing, summarizing, complete, failed

  // Timestamps (stored as ISO strings for SQLite)
  recordedAt: text('recorded_at'),
  uploadedAt: text('uploaded_at').default(sql`(datetime('now'))`).notNull(),
  processedAt: text('processed_at'),

  // Error tracking
  errorMessage: text('error_message'),
  retryCount: integer('retry_count').default(0).notNull(),

  // Cross-app identity and retention ownership.
  sourceProvider: text('source_provider'),
  sourceRecordingId: text('source_recording_id'),
  sourceTransport: text('source_transport'),
  fingerprint: text('fingerprint'),
  retentionState: text('retention_state').default('active').notNull(),
  deletedAt: text('deleted_at'),
  revision: integer('revision').default(1).notNull(),
  notes: text('notes'),
  tags: text('tags', { mode: 'json' }).$type<string[]>(),
  forwardingStatus: text('forwarding_status').default('not_configured').notNull(),
  forwardingRunId: text('forwarding_run_id'),
  forwardingError: text('forwarding_error'),
});

// ============================================
// TRANSCRIPTS
// ============================================

export const transcripts = sqliteTable('transcripts', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  recordingId: text('recording_id').references(() => recordings.id, { onDelete: 'cascade' }).notNull(),
  fullText: text('full_text').notNull(),
  segments: text('segments', { mode: 'json' }), // JSON array of {start, end, text, speaker}
  wordCount: integer('word_count'),
  speakerCount: integer('speaker_count'),
  confidenceScore: real('confidence_score'),

  // AI analysis
  summary: text('summary', { mode: 'json' }), // {overview, keyPoints, participants, topics}
  extractedTasks: text('extracted_tasks', { mode: 'json' }), // Array of tasks
  analyzedAt: text('analyzed_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
});

export const transcriptVersions = sqliteTable('transcript_versions', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  recordingId: text('recording_id').references(() => recordings.id, { onDelete: 'cascade' }).notNull(),
  fullText: text('full_text').notNull(),
  segments: text('segments', { mode: 'json' }),
  origin: text('origin').notNull(), // generated or edited
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
});

// ============================================
// SPEAKER PROFILES
// ============================================

export const speakerProfiles = sqliteTable('speaker_profiles', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text('name').notNull(),
  category: text('category').notNull().default('other'), // self, family, teacher, classmate, colleague, other
  sampleCount: integer('sample_count').default(0).notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).default(true).notNull(),
  notes: text('notes'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});

// ============================================
// SPEAKER MAPPINGS
// ============================================

export const speakerMappings = sqliteTable('speaker_mappings', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  transcriptId: text('transcript_id').references(() => transcripts.id, { onDelete: 'cascade' }).notNull(),
  speakerId: integer('speaker_id').notNull(), // 0, 1, 2 from diarization
  profileId: text('profile_id').references(() => speakerProfiles.id, { onDelete: 'set null' }),
  confidence: real('confidence'),
  manuallyAssigned: integer('manually_assigned', { mode: 'boolean' }).default(false).notNull(),
});

// ============================================
// ANALYSES
// ============================================

export const analyses = sqliteTable('analyses', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  recordingId: text('recording_id').references(() => recordings.id, { onDelete: 'cascade' }).notNull(),
  summary: text('summary', { mode: 'json' }),
  extractedTasks: text('extracted_tasks', { mode: 'json' }),
  analyzedAt: text('analyzed_at').default(sql`(datetime('now'))`).notNull(),
});

// ============================================
// USER SETTINGS
// ============================================

export const userSettings = sqliteTable('user_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});
