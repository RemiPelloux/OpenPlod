import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { recordings, transcripts, transcriptVersions } from '../db/schema';

export function updateTranscript(params: {
  recordingId: string; fullText: string; segments?: unknown; revision?: number;
}): void {
  db.transaction(tx => {
    const recording = tx.select().from(recordings).where(eq(recordings.id, params.recordingId)).get();
    const current = tx.select().from(transcripts).where(eq(transcripts.recordingId, params.recordingId)).get();
    if (!recording || !current) throw new Error('Transcript not found.');
    if (recording.retentionState !== 'active') throw new Error('Recording is in Trash.');
    if (params.revision !== undefined && params.revision !== recording.revision) throw new Error('revision_conflict');
    if (!current.currentVersionId) tx.insert(transcriptVersions).values({ recordingId: params.recordingId,
      fullText: current.fullText, segments: current.segments, origin: current.origin, createdAt: current.createdAt }).run();
    const id = crypto.randomUUID();
    const segments = params.segments ?? (params.fullText === current.fullText ? current.segments : null);
    tx.insert(transcriptVersions).values({ id, recordingId: params.recordingId,
      fullText: params.fullText, segments, origin: 'edited', createdAt: new Date().toISOString() }).run();
    tx.update(transcripts).set({ fullText: params.fullText, segments, origin: 'edited', currentVersionId: id,
      wordCount: params.fullText.trim() ? params.fullText.trim().split(/\s+/).length : 0,
    }).where(eq(transcripts.id, current.id)).run();
    tx.update(recordings).set({ revision: recording.revision + 1 }).where(eq(recordings.id, recording.id)).run();
  });
}

export function saveGeneratedTranscript(params: {
  recordingId: string; fullText: string; segments: unknown;
  wordCount: number; speakerCount: number; confidence: number;
}): boolean {
  return db.transaction(tx => {
    const recording = tx.select().from(recordings).where(eq(recordings.id, params.recordingId)).get();
    if (!recording) return false;
    const current = tx.select().from(transcripts).where(eq(transcripts.recordingId, params.recordingId)).get();
    const versionId = crypto.randomUUID();
    tx.insert(transcriptVersions).values({ id: versionId, recordingId: params.recordingId,
      fullText: params.fullText, segments: params.segments, origin: 'generated', createdAt: new Date().toISOString() }).run();
    tx.update(recordings).set({ revision: recording.revision + 1 }).where(eq(recordings.id, recording.id)).run();
    // Reprocessing adds a generated version without replacing an edited document.
    if (current?.origin === 'edited') return false;
    const values = { fullText: params.fullText, segments: params.segments, wordCount: params.wordCount,
      speakerCount: params.speakerCount, confidenceScore: params.confidence, origin: 'generated',
      currentVersionId: versionId, summary: null, extractedTasks: null, analyzedAt: null, createdAt: new Date().toISOString() };
    tx.insert(transcripts).values({ recordingId: params.recordingId, ...values })
      .onConflictDoUpdate({ target: transcripts.recordingId, set: values }).run();
    return true;
  });
}
