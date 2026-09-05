import { db } from '../db/client';
import { recordings, userSettings } from '../db/schema';
import { eq } from 'drizzle-orm';

export async function forwardRecording(recordingId: string): Promise<string> {
  const [recording] = await db.select().from(recordings).where(eq(recordings.id, recordingId)).limit(1);
  if (!recording) throw new Error('Recording not found.');
  const values = Object.fromEntries((await db.select().from(userSettings)).map(row => [row.key, row.value]));
  if (values.openWhistleForwarding !== 'true') throw new Error('OpenWhistle forwarding is disabled.');
  if (!values.openWhistleBaseUrl || !values.openWhistleApiKey || !values.openWhistleAgentId) {
    throw new Error('OpenWhistle connection is incomplete.');
  }

  await db.update(recordings).set({ forwardingStatus: 'forwarding', forwardingError: null })
    .where(eq(recordings.id, recordingId));
  try {
    const form = new FormData();
    form.append('file', Bun.file(recording.filePath), recording.originalFilename ?? 'recording.m4a');
    form.append('options', JSON.stringify({
      source_provider: recording.sourceProvider,
      source_recording_id: recording.sourceRecordingId,
      source_transport: recording.sourceTransport,
      original_filename: recording.originalFilename,
      original_recorded_at: recording.recordedAt,
      fingerprint: recording.fingerprint,
    }));
    const baseUrl = values.openWhistleBaseUrl.replace(/\/+$/, '');
    const response = await fetch(`${baseUrl}/agents/${values.openWhistleAgentId}/runs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${values.openWhistleApiKey}`,
        'X-Idempotency-Key': recording.id,
      },
      body: form,
    });
    if (!response.ok) throw new Error(`OpenWhistle returned HTTP ${response.status}.`);
    const payload = await response.json() as { id?: string; run_id?: string };
    const runId = payload.id ?? payload.run_id;
    if (!runId) throw new Error('OpenWhistle did not return a run id.');
    await db.update(recordings).set({
      forwardingStatus: 'forwarded',
      forwardingRunId: runId,
      forwardingError: null,
    }).where(eq(recordings.id, recordingId));
    return runId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(recordings).set({ forwardingStatus: 'failed', forwardingError: message })
      .where(eq(recordings.id, recordingId));
    throw error;
  }
}

export async function forwardRecordingWithRetry(
  recordingId: string,
  options: { attempts?: number; initialDelayMs?: number } = {},
): Promise<string> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? 1_000);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await forwardRecording(recordingId);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await Bun.sleep(initialDelayMs * 2 ** (attempt - 1));
    }
  }

  throw lastError;
}
