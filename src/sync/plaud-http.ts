import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** macOS uses Foundation like Plaude Archiver; other platforms retain fetch. */
export async function fetchPlaudAuthorization(url: string, init: RequestInit): Promise<Response> {
  if (process.platform !== 'darwin') return fetch(url, init);
  const binary = join(dirname(process.execPath), 'plaud-http');
  if (!existsSync(binary)) {
    if (basename(process.execPath).startsWith('openplod-server')) throw new Error('Native Plaud transport is missing. Reinstall OpenPlod.');
    return fetch(url, init); // Development/test runtime keeps its injectable fetch.
  }
  init.signal?.throwIfAborted();
  const headers = new Headers(init.headers);
  const child = Bun.spawn([binary], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
  });
  const cancel = () => child.kill();
  init.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 25_000);
  try {
    if (init.signal?.aborted) { cancel(); init.signal.throwIfAborted(); }
    child.stdin.write(JSON.stringify({ url, authorization: headers.get('Authorization') ?? '', body: String(init.body ?? '') }));
    child.stdin.end();
    const text = await new Response(child.stdout).text();
    const code = await child.exited;
    init.signal?.throwIfAborted();
    if (code !== 0) throw new Error('Native Plaud transport failed.');
    const result = JSON.parse(text) as {status?:number;headers?:Record<string,string>;body?:string;error?:string};
    if (!result.status || typeof result.body !== 'string') throw new Error('Native Plaud transport failed.');
    return new Response(Buffer.from(result.body, 'base64'), { status: result.status, headers: result.headers });
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', cancel);
    child.kill();
  }
}
