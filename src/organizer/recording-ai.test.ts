import { beforeEach, afterEach, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initializeOrganizer, OrganizerStore } from './store';
import { RecordingAi, normalizeSourceReferences } from './recording-ai';
import { createRecordingAiApi } from '../api/recording-ai';
let db: Database, store: OrganizerStore, recordingId: string;
beforeEach(() => {
  db = new Database(':memory:'); initializeOrganizer(db); store = new OrganizerStore(db);
  db.exec(`CREATE TABLE recordings(id TEXT,original_filename TEXT,recorded_at TEXT,source_provider TEXT,retention_state TEXT);
    CREATE TABLE transcripts(recording_id TEXT,current_version_id TEXT,full_text TEXT,origin TEXT,segments TEXT);
    CREATE TABLE transcript_versions(id TEXT,recording_id TEXT,full_text TEXT,origin TEXT);`);
  recordingId = crypto.randomUUID();
  db.query('INSERT INTO recordings VALUES(?,?,?,?,?)').run(recordingId, 'Test recording', '2026-09-07', 'plaud', 'active');
  db.query('INSERT INTO transcripts VALUES(?,?,?,?,?)').run(recordingId, crypto.randomUUID(), 'Keep the original audio.', 'generated', JSON.stringify([{ start: 2, end: 5, text: 'Keep the original audio.' }]));
});
afterEach(() => db.close());
const input = () => ({ id: crypto.randomUUID(), conversationId: crypto.randomUUID(), recordingIds: [recordingId], question: 'What was decided?', consent: true });
const reply = (quote = 'Keep the original audio.', sourceId = 'S1') => Response.json({ model: 'test-provider', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answer: 'Keep the original audio. [S1]', citations: [{ sourceId, quote }] }) } }] });
const create = (fetcher: (url: unknown, options?: RequestInit) => Promise<Response>, key = 'test-only-key') => new RecordingAi(store, fetcher as typeof fetch, () => key);
test('selected context only, real request contract, citations and idempotent persistence', async () => {
  let calls = 0;
  const ai = create(async (url, options) => { calls++; expect(url).toBe('https://api.mistral.ai/v1/chat/completions'); const body = JSON.parse(String(options?.body)); const context = JSON.parse(body.messages[1].content); expect(context.sources).toHaveLength(1); expect(context.sources[0].recordingId).toBe(recordingId); return reply(); });
  const request = input(), steps: string[] = [];
  const answer = await ai.ask(request, async s => { steps.push(s); });
  expect(steps).toEqual(['context', 'mistral', 'citations', 'saved']); expect(answer.sources[0]!.start).toBe(2);
  expect((await ai.ask(request, async () => {})).id).toBe(answer.id); expect(calls).toBe(1); expect(ai.history(request.conversationId)).toHaveLength(1);
  expect(JSON.stringify(answer)).not.toContain('test-only-key');
  await expect(ai.ask({ ...request, question: 'Different' }, async () => {})).rejects.toThrow('different');
});
test('rejects unknown and invented citations and does not persist answers', async () => {
  for (const [quote, source] of [['invented text', 'S1'], ['Keep the original audio.', 'S99']]) {
    const ai = create(async () => reply(quote, source)), request = input();
    await expect(ai.ask(request, async () => {})).rejects.toThrow('citation'); expect(ai.history(request.conversationId)).toEqual([]);
  }
});
test('grouped references normalize without fabricating missing sources', () => {
  expect(normalizeSourceReferences('Evidence [S1, S2]. [S3]')).toBe('Evidence [S1] [S2]. [S3]');
  expect(normalizeSourceReferences('[not a source]')).toBe('[not a source]');
});
test('partial timestamps do not silently omit transcript text, and follow-ups include previous answers', async () => {
  db.query('UPDATE transcripts SET full_text=?').run('Keep the original audio. Extra unsegmented text.');
  const ai = create(async (_url, options) => {
    const context = JSON.parse(JSON.parse(String(options?.body)).messages[1].content);
    expect(context.sources[0].text).toContain('Extra unsegmented text.');
    expect(context.sources[0].start).toBeNull();
    if (context.conversation.length) expect(context.conversation[0].answer).toBe('Keep the original audio. [S1]');
    return reply();
  });
  const request = input(); await ai.ask(request, async () => {});
  await ai.ask({ ...request, id: crypto.randomUUID(), question: 'Explain the previous answer.' }, async () => {});
  expect(ai.history(request.conversationId)).toHaveLength(2);
});
test('missing consent, keys, oversized or deleted context never reach provider', async () => {
  let calls = 0; const fetcher = async () => { calls++; return reply(); };
  await expect(create(fetcher).ask({ ...input(), consent: false }, async () => {})).rejects.toThrow();
  await expect(create(fetcher, '').ask(input(), async () => {})).rejects.toThrow('API key');
  db.query('UPDATE transcripts SET full_text=?,segments=NULL').run('x'.repeat(120001));
  await expect(create(fetcher).ask(input(), async () => {})).rejects.toThrow('120 KB');
  db.exec("UPDATE recordings SET retention_state='trash'");
  await expect(create(fetcher).ask(input(), async () => {})).rejects.toThrow('Active recording'); expect(calls).toBe(0);
});
test('history is inaccessible when its recording is in Trash', async () => {
  const ai = create(async () => reply()), request = input(); await ai.ask(request, async () => {});
  db.exec("UPDATE recordings SET retention_state='trash'"); expect(() => ai.history(request.conversationId)).toThrow(); expect(ai.conversations()).toEqual([]);
  db.exec("UPDATE recordings SET retention_state='active'"); expect(ai.history(request.conversationId)).toHaveLength(1);
});
test('provider failure exposes no response body and SSE correlates progress/result', async () => {
  await expect(create(async () => new Response('secret-provider-body', { status: 401 })).ask(input(), async () => {})).rejects.toThrow('HTTP 401');
  const request = input(); const app = createRecordingAiApi(create(async () => reply()));
  const response = await app.request('/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  const stream = await response.text(); expect(stream).toContain('event: progress'); expect(stream).toContain('event: result'); expect(stream).toContain(request.id); expect(stream).not.toContain('test-only-key');
});
