import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { OrganizerStore } from '../organizer/store';
import { RecordingCollections } from './collections';
import { KnowledgeIndex, chunkText, chunkTranscript, PASSAGE_MAX_CHARS } from './retrieval';
import { KnowledgeSuggestions } from './suggestions';
import { LexicalEmbedder, cachedOllamaModels, resolveEmbedder, type Fetcher } from './embeddings';
import { createKnowledgeApi } from '../api/knowledge';
import { addRecording, editTranscript, knowledgeVault } from './fixtures';

let database: Database;
beforeEach(() => { database = knowledgeVault(); });
afterEach(() => database.close());
const offline: Fetcher = async () => { throw new Error('offline: no network in tests'); };
const passages = () => (database.query('SELECT count(*) AS count FROM knowledge_passages').get() as { count: number }).count;
const vectors = () => (database.query('SELECT count(*) AS count FROM knowledge_vectors').get() as { count: number }).count;
const setting = (value: unknown) => database.query("INSERT INTO user_settings(key,value) VALUES('knowledgeConfig',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));

describe('chunking', () => {
  test('transcript passages keep segment ranges and real timestamps', () => {
    const segments = Array.from({ length: 30 }, (_, index) => ({ start: index * 10, end: index * 10 + 9, text: `Segment ${index} talks about the quarterly budget and hiring plan.` }));
    const chunks = chunkTranscript(segments.map(segment => segment.text).join(' '), JSON.stringify(segments));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toMatchObject({ seq: 0, segmentStart: 0, startTime: 0 });
    for (let index = 1; index < chunks.length; index++) expect(chunks[index].segmentStart).toBe(chunks[index - 1].segmentEnd! + 1);
    const last = chunks[chunks.length - 1];
    expect(last).toMatchObject({ segmentEnd: 29, endTime: 299 });
    expect(chunks.every(chunk => chunk.text.length <= PASSAGE_MAX_CHARS)).toBe(true);
  });
  test('text without complete segments gets no invented timestamps', () => {
    const partial = chunkTranscript('First part. Second part not in segments.', JSON.stringify([{ start: 1, end: 2, text: 'First part.' }]));
    expect(partial).toEqual([{ seq: 0, text: 'First part. Second part not in segments.', segmentStart: null, segmentEnd: null, startTime: null, endTime: null }]);
    const long = chunkText(`${'A sentence about retrieval. '.repeat(120)}\n\nShort tail.`);
    expect(long.length).toBeGreaterThan(1);
    expect(long.every(chunk => chunk.text.length <= PASSAGE_MAX_CHARS && chunk.startTime === null)).toBe(true);
  });
});

describe('hybrid retrieval (KB-04)', () => {
  test('finds passages with exact version, segment range, timestamps, and retrievers', async () => {
    const budget = addRecording(database, { title: 'Budget review', segments: [
      { start: 0, end: 4, text: 'Welcome everyone.' }, { start: 4, end: 9, text: 'The marketing budget doubles next quarter.' }] });
    addRecording(database, { title: 'Standup', text: 'Deploy the API on Friday after the database migration.' });
    const index = new KnowledgeIndex(database, offline);
    const result = await index.search({ q: 'marketing budget' });
    expect(result.embedding).toMatchObject({ kind: 'lexical', fallback: false });
    expect(result.embedding.note).toContain('nomic-embed-text');
    expect(result.passages[0]).toMatchObject({ sourceType: 'transcript', recordingId: budget.id, versionId: budget.versionId, segmentStart: 0, segmentEnd: 1, startTime: 0, endTime: 9, recordingTitle: 'Budget review.m4a' });
    expect(result.passages[0].matchedBy).toEqual(['fts', 'vector']);
    expect(result.passages[0].score).toBeGreaterThan(0);
    expect(result.passages.some(passage => passage.text.includes('Deploy'))).toBe(false);
    expect(result.index).toMatchObject({ sources: 2, pending: 0 });
    const lexical = await index.search({ q: 'marketing', mode: 'lexical' });
    expect(lexical.passages[0].matchedBy).toEqual(['fts']);
    const semantic = await index.search({ q: 'marketing', mode: 'semantic' });
    expect(semantic.passages[0].matchedBy).toEqual(['vector']);
  });

  test('indexes incrementally and documents too', async () => {
    const store = new OrganizerStore(database);
    addRecording(database, { text: 'Alpha launch checklist.' });
    const index = new KnowledgeIndex(database, offline);
    expect((await index.refresh()).indexed).toBe(1);
    expect((await index.refresh()).indexed).toBe(0);
    const note = store.create({ title: 'Launch notes', content: 'The launch checklist lives in the wiki.', idempotencyKey: crypto.randomUUID() });
    expect((await index.refresh()).indexed).toBe(1);
    const found = await index.search({ q: 'launch checklist', source: 'documents' });
    expect(found.passages).toMatchObject([{ sourceType: 'document', documentId: note.id, documentTitle: 'Launch notes', recordingId: null }]);
    store.update(note.id, { revision: note.revision, starred: true });
    expect((await index.refresh()).indexed).toBe(0);
    store.trash(note.id, 2);
    expect((await index.search({ q: 'wiki', source: 'documents' })).passages).toEqual([]);
  });

  test('exit gate: Trash, purge, and a new version remove cached passages and vectors', async () => {
    const recording = addRecording(database, { title: 'Secret', text: 'The password rotation happens monthly.' });
    const index = new KnowledgeIndex(database, offline);
    await index.refresh();
    expect(passages()).toBe(1); expect(vectors()).toBe(1);

    database.query("UPDATE recordings SET retention_state='trash' WHERE id=?").run(recording.id);
    expect(passages()).toBe(0); expect(vectors()).toBe(0);
    expect((await index.search({ q: 'password rotation' })).passages).toEqual([]);

    database.query("UPDATE recordings SET retention_state='active' WHERE id=?").run(recording.id);
    expect((await index.search({ q: 'password rotation' })).passages).toHaveLength(1);
    const edited = editTranscript(database, recording.id, 'Rotation is now quarterly.');
    expect(passages()).toBe(0);
    const after = await index.search({ q: 'rotation' });
    expect(after.passages).toMatchObject([{ versionId: edited, text: 'Rotation is now quarterly.' }]);
    expect((await index.search({ q: 'monthly password' })).passages).toEqual([]);

    database.query('DELETE FROM recordings WHERE id=?').run(recording.id);
    expect(passages()).toBe(0); expect(vectors()).toBe(0);
    expect(database.query('SELECT count(*) AS count FROM knowledge_sources').get()).toEqual({ count: 0 });
    expect(database.query("SELECT count(*) AS count FROM knowledge_fts WHERE knowledge_fts MATCH 'rotation'").get()).toEqual({ count: 0 });
  });

  test('a passage whose source changed while indexing is never stored', async () => {
    const recording = addRecording(database, { text: 'Original wording here.' });
    let edit = true;
    const lexical = new LexicalEmbedder();
    const index = new KnowledgeIndex(database, offline, async () => ({
      provider: { model: lexical.model, kind: 'lexical', embed: async (texts, options) => {
        if (edit) { edit = false; editTranscript(database, recording.id, 'Replacement wording.'); }
        return lexical.embed(texts, options);
      } },
      info: { model: lexical.model, kind: 'lexical', fallback: false, note: null },
    }));
    await index.refresh();
    expect(vectors()).toBe(0);
    expect(database.query('SELECT count(*) AS count FROM knowledge_sources').get()).toEqual({ count: 0 });
    const result = await index.search({ q: 'wording' });
    expect(result.passages.map(passage => passage.text)).toEqual(['Replacement wording.']);
  });
});

describe('embedding providers', () => {
  test('caches the installed-model check briefly, including an unreachable Ollama', async () => {
    let calls = 0;
    const down: Fetcher = async () => { calls++; throw new Error('connection refused'); };
    expect(await cachedOllamaModels(down)).toEqual([]);
    expect(await cachedOllamaModels(down)).toEqual([]);
    expect(calls).toBe(1);
    const up: Fetcher = async () => { calls++; return Response.json({ models: [{ name: 'nomic-embed-text:latest' }] }); };
    const start = Date.now();
    expect(await cachedOllamaModels(up, start)).toEqual(['nomic-embed-text:latest']);
    await cachedOllamaModels(up, start + 1000);
    expect(calls).toBe(2);
    await cachedOllamaModels(up, start + 31_000);
    expect(calls).toBe(3);
  });

  test('uses an installed Ollama embedding model locally, with task prefixes', async () => {
    addRecording(database, { text: 'Vector databases store embeddings.' });
    const calls: { url: string; body: any }[] = [];
    const fetcher: Fetcher = async (url, init) => {
      calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'nomic-embed-text:latest' }, { name: 'cloud-model', remote_host: 'x' }] });
      return Response.json({ embeddings: (calls.at(-1)!.body.input as string[]).map((text: string) => [text.length % 7, 1, 0.5]) });
    };
    const resolved = await resolveEmbedder(database, fetcher);
    expect(resolved.info).toMatchObject({ model: 'ollama:nomic-embed-text:latest', kind: 'local', fallback: false });
    const index = new KnowledgeIndex(database, fetcher);
    const result = await index.search({ q: 'embeddings' });
    expect(result.embedding.kind).toBe('local');
    expect(calls.every(call => call.url.startsWith('http://127.0.0.1:11434/'))).toBe(true);
    const embedCalls = calls.filter(call => call.url.endsWith('/api/embed'));
    expect(embedCalls[0].body.input[0]).toStartWith('search_document: ');
    expect(embedCalls.at(-1)!.body.input[0]).toBe('search_query: embeddings');
  });

  test('cloud embeddings need explicit opt-in, a key, and are blocked in local-only mode', async () => {
    addRecording(database, { text: 'Cloud text should stay home.' });
    // A developer's own key in the environment must not stand in for the vault's.
    const environmentKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
    const calls: string[] = [];
    const fetcher: Fetcher = async url => {
      calls.push(url);
      return Response.json({ data: [{ index: 0, embedding: [0.1, 0.2] }] });
    };
    setting({ embeddingProvider: 'openai', cloudOptIn: false });
    expect((await resolveEmbedder(database, fetcher)).info).toMatchObject({ kind: 'lexical', fallback: true, note: expect.stringContaining('opt-in') });
    setting({ embeddingProvider: 'openai', cloudOptIn: true });
    expect((await resolveEmbedder(database, fetcher)).info.note).toContain('API key');
    database.query("INSERT INTO user_settings(key,value) VALUES('openaiApiKey','synthetic-key')").run();
    database.query("INSERT INTO user_settings(key,value) VALUES('aiConfig',?)").run(JSON.stringify({ privacyMode: 'local-only' }));
    expect((await resolveEmbedder(database, fetcher)).info.note).toContain('Local-only');
    await new KnowledgeIndex(database, fetcher).search({ q: 'cloud text' });
    expect(calls).toEqual([]);
    database.query("UPDATE user_settings SET value=? WHERE key='aiConfig'").run(JSON.stringify({ privacyMode: 'selected-providers' }));
    const resolved = await resolveEmbedder(database, fetcher);
    expect(resolved.info).toMatchObject({ model: 'openai:text-embedding-3-small', kind: 'cloud' });
    await new KnowledgeIndex(database, fetcher).refresh();
    expect(calls).toEqual(['https://api.openai.com/v1/embeddings']);
    } finally { if (environmentKey !== undefined) process.env.OPENAI_API_KEY = environmentKey; }
  });

  test('search settings require confirmation for cloud providers', async () => {
    const index = new KnowledgeIndex(database, offline);
    const app = createKnowledgeApi({ collections: new RecordingCollections(database), index, suggestions: new KnowledgeSuggestions(database, index) });
    const put = (body: unknown) => app.request('/search/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await put({ embeddingProvider: 'mistral', cloudOptIn: true })).status).toBe(400);
    expect((await (await put({ embeddingProvider: 'mistral', cloudOptIn: true })).json()).code).toBe('cloud_consent_required');
    const accepted = await put({ embeddingProvider: 'mistral', cloudOptIn: true, confirmCloud: true });
    expect((await accepted.json()).data.settings).toEqual({ embeddingProvider: 'mistral', ollamaModel: 'nomic-embed-text', cloudOptIn: true });
    expect((await put({ embeddingProvider: 'lexical' })).status).toBe(200);
    addRecording(database, { title: 'API', text: 'Searchable over HTTP.' });
    const search = await (await app.request('/search?q=searchable&mode=hybrid')).json();
    expect(search.data).toMatchObject({ mode: 'hybrid', embedding: { kind: 'lexical' }, passages: [{ text: 'Searchable over HTTP.' }] });
    expect((await app.request('/search?q=x')).status).toBe(400);
    expect((await (await app.request('/search/status')).json()).data).toMatchObject({ sources: 1, pending: 0 });
  });
});
