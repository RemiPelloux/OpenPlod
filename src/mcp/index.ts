import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server';
import { OpenPlodClient } from './client';

async function main() {
  let token = process.env.OPENPLOD_API_TOKEN || process.env.OPENPLOD_PAIRING_TOKEN || '';
  if (!token) {
    const file = process.env.OPENPLOD_TOKEN_FILE || join(homedir(), 'Library/Application Support/com.openplod.vault/pairing-token');
    const info = await stat(file);
    if (!info.isFile() || info.size > 4096 || (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))) throw new Error('Private token file is unavailable.');
    token = (await readFile(file, 'utf8')).trim();
  }
  const client = new OpenPlodClient(process.env.OPENPLOD_URL || 'http://127.0.0.1:3487', token);
  const server = createMcpServer(client, process.env.OPENPLOD_MCP_WRITE === '1');
  const stop = () => { void server.close().finally(() => process.exit(0)); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) main().catch(() => {
  console.error('OpenPlod MCP could not start. Check OPENPLOD_URL and a private API token or OPENPLOD_TOKEN_FILE.');
  process.exitCode = 1;
});
