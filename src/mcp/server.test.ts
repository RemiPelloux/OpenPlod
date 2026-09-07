import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initializeOrganizer, OrganizerStore } from '../organizer/store';
import { createOrganizerApi } from '../api/organizer';
import { createMcpServer } from './server';
import { OpenPlodClient } from './client';

let db: Database, store: OrganizerStore;
beforeEach(() => { db = new Database(':memory:'); db.exec('PRAGMA foreign_keys=ON'); initializeOrganizer(db); store = new OrganizerStore(db); });
afterEach(() => db.close());

async function connect(writable = false) {
  const api = createOrganizerApi(store);
  const vault = new OpenPlodClient('http://127.0.0.1:3499', 'fixture-token', async (url, init) => api.request(new URL(url).pathname.replace('/api/v1', '') + new URL(url).search, init));
  const server = createMcpServer(vault, writable);
  const client = new Client({ name: 'openplod-test', version: '1.0.0' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left); await client.connect(right);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test('official MCP SDK negotiates read-only tools and Markdown resources', async () => {
  const note = store.create({ title: 'Agent notes', content: '# Read me\n\nUntrusted document text.', idempotencyKey: crypto.randomUUID() });
  const { client, close } = await connect();
  try {
    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name)).toContain('list_documents');
    expect(listed.tools.every(tool => tool.annotations?.readOnlyHint)).toBe(true);
    expect(listed.tools.map(tool => tool.name)).not.toContain('create_document');
    const result = await client.callTool({ name: 'get_document', arguments: { id: note.id } });
    expect(JSON.stringify(result.content)).toContain('Untrusted document text');
    expect((await client.listResources()).resources[0].uri).toBe(`openplod://documents/${note.id}`);
    expect((await client.readResource({ uri: `openplod://documents/${note.id}` })).contents[0]).toMatchObject({ mimeType: 'text/markdown', text: note.content });
    const search = await client.callTool({ name: 'list_documents', arguments: { q: 'untrusted' } });
    expect(JSON.stringify(search.content)).toContain('Agent notes');
    const denied = await client.callTool({ name: 'create_document', arguments: { title: 'no', idempotencyKey: crypto.randomUUID() } });
    expect(denied.isError).toBe(true); expect(store.list().total).toBe(1);
  } finally { await close(); }
});

test('write-enabled MCP creates/moves notes, rejects stale revisions and cannot send or purge', async () => {
  const { client, close } = await connect(true);
  try {
    const key = crypto.randomUUID();
    const created = await client.callTool({ name: 'create_document', arguments: { title: 'Created by MCP', content: '# Note', idempotencyKey: key } });
    expect(created.isError).not.toBe(true);
    await client.callTool({ name: 'create_document', arguments: { title: 'Created by MCP', content: '# Note', idempotencyKey: key } });
    expect(store.list().total).toBe(1);
    const note = store.list().documents[0];
    await client.callTool({ name: 'update_document', arguments: { id: note.id, revision: 1, content: 'Edited' } });
    const stale = await client.callTool({ name: 'update_document', arguments: { id: note.id, revision: 1, content: 'Stale' } });
    expect(stale.isError).toBe(true); expect(store.get(note.id).content).toBe('Edited');
    const unconfirmed = await client.callTool({ name: 'trash_document', arguments: { id: note.id, revision: 2 } });
    expect(unconfirmed.isError).toBe(true);
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    expect(tools).not.toContain('send_document'); expect(tools).not.toContain('purge_document');
    await client.callTool({ name: 'trash_document', arguments: { id: note.id, revision: 2, confirm: true } });
    expect(store.get(note.id).deletedAt).not.toBeNull();
    await client.callTool({ name: 'restore_document', arguments: { id: note.id, revision: 3 } });
    expect(store.get(note.id).deletedAt).toBeNull();
  } finally { await close(); }
});

test('MCP HTTP client requires credentials and restricts remote transport and API paths', async () => {
  expect(() => new OpenPlodClient('http://example.com', 'secret')).toThrow('HTTPS');
  expect(() => new OpenPlodClient('https://user:pass@example.com', 'secret')).toThrow();
  expect(() => new OpenPlodClient('http://127.0.0.1', '')).toThrow('token');
  let calls = 0;
  const client = new OpenPlodClient('http://localhost:3487', 'secret', async (_url, init) => {
    calls++; expect(init.redirect).toBe('error');
    return Response.json({ error: 'upstream secret value' }, { status: 401 });
  });
  await expect(client.request('/api/settings')).rejects.toThrow('Unsupported');
  await expect(client.request('/api/v1/documents/../../settings')).rejects.toThrow('Unsupported');
  await expect(client.request('/api/v1/documents/%2e%2e/%2e%2e/settings')).rejects.toThrow('Unsupported');
  await expect(client.request('/api/v1/documents')).rejects.toThrow('authorization');
  await expect(client.request('/api/v1/documents?q=version..2')).rejects.toThrow('authorization');
  expect(calls).toBe(2);
  const transportError = new OpenPlodClient('https://vault.example', 'secret', async () => { throw new Error('token=secret'); });
  await expect(transportError.request('/api/v1/documents')).rejects.toThrow('could not be reached');
});
