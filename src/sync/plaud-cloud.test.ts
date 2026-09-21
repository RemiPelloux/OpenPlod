import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PlaudCloudClient,
  PlaudCloudError,
  clearStoredCloudToken,
  cloudTokenPath,
  isWorkspaceToken,
  normalizeCloudToken,
  parseWorkspaceToken,
  readStoredCloudToken,
  resolveCloudToken,
  writeStoredCloudToken,
} from './plaud-cloud';

const jwt = (claims: Record<string, unknown>) => [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IldUIn0',
  Buffer.from(JSON.stringify(claims)).toString('base64url'),
  'signature',
].join('.');

const ACCOUNT = jwt({
  sub: 'da4624473b8a44c58dddd668dc9b1c01',
  wid: 'ws_gmy0jmCXCg',
  mid: 'mem_gmy0jmCXCh',
  region: 'aws:eu-central-1',
  exp: 1790102871,
});

const json = (payload: unknown) => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

const file = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  filename: `2026-09-21 ${id}`,
  filesize: 21933056,
  fullname: `${id}.ogg`,
  file_md5: 'abc',
  start_time: 1789997840000,
  end_time: 1790002980000,
  duration: 5140000,
  serial_number: '8810B50327175322',
  is_trash: false,
  is_trans: false,
  is_summary: false,
  ori_ready: false,
  scene: 1,
  ...extra,
});

let previousLibraryPath: string | undefined;
let root: string;

beforeEach(() => {
  previousLibraryPath = process.env.OPENPLOD_LIBRARY_PATH;
  root = mkdtempSync(join(tmpdir(), 'openplod-cloud-'));
  process.env.OPENPLOD_LIBRARY_PATH = join(root, 'vault', 'recordings');
});

afterEach(() => {
  if (previousLibraryPath === undefined) delete process.env.OPENPLOD_LIBRARY_PATH;
  else process.env.OPENPLOD_LIBRARY_PATH = previousLibraryPath;
  delete process.env.PLAUD_CLOUD_TOKEN;
  rmSync(root, { recursive: true, force: true });
});

describe('normalizeCloudToken', () => {
  test('accepts the shapes a user might copy', () => {
    expect(normalizeCloudToken(`  ${ACCOUNT}  `)).toBe(ACCOUNT);
    expect(normalizeCloudToken(`"${ACCOUNT}"`)).toBe(ACCOUNT);
    expect(normalizeCloudToken(`Bearer ${ACCOUNT}`)).toBe(ACCOUNT);
    expect(normalizeCloudToken(JSON.stringify({ workspaceToken: ACCOUNT }))).toBe(ACCOUNT);
    expect(normalizeCloudToken(JSON.stringify({ tokenstr: ACCOUNT }))).toBe(ACCOUNT);
  });

  test('leaves an unrelated value alone', () => {
    expect(normalizeCloudToken('not-a-token')).toBe('not-a-token');
  });
});

describe('parseWorkspaceToken', () => {
  test('reads the account claims', () => {
    const workspace = parseWorkspaceToken(ACCOUNT);
    expect(workspace.userId).toBe('da4624473b8a44c58dddd668dc9b1c01');
    expect(workspace.workspaceId).toBe('ws_gmy0jmCXCg');
    expect(workspace.memberId).toBe('mem_gmy0jmCXCh');
    expect(workspace.region).toBe('aws:eu-central-1');
    expect(workspace.expiresAt).toBe(1790102871);
  });

  test('rejects anything that is not a Plaud sign-in token', () => {
    expect(() => parseWorkspaceToken('')).toThrow(PlaudCloudError);
    expect(() => parseWorkspaceToken('short')).toThrow(/does not look like a Plaud sign-in token/);
    expect(() => parseWorkspaceToken('a.b')).toThrow(PlaudCloudError);
  });

  test('rejects a token with no account in it', () => {
    expect(() => parseWorkspaceToken(jwt({ wid: 'ws' }))).toThrow(/no account/);
  });

  test('rejects an unreadable payload', () => {
    // Well-formed base64url that does not decode to JSON.
    expect(() => parseWorkspaceToken('aaa.bm9wZQ.ccc')).toThrow(/unreadable/);
  });

  test('isWorkspaceToken mirrors parsing', () => {
    expect(isWorkspaceToken(ACCOUNT)).toBe(true);
    expect(isWorkspaceToken('nope')).toBe(false);
    expect(isWorkspaceToken(undefined)).toBe(false);
  });
});

describe('PlaudCloudClient', () => {
  test('follows the regional redirect and pins headers Cloudflare accepts', async () => {
    const seen: { url: string; authorization: string | null; userAgent: string | null }[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({ url, authorization: headers.get('authorization'), userAgent: headers.get('user-agent') });
      if (url.startsWith('https://api-euc1.plaud.ai')) return json({ status: 0, data_file_list: [file('a'), file('b')] });
      return json({ status: -302, msg: 'user region mismatch', data: { domains: { api: 'https://api-euc1.plaud.ai' } } });
    }) as unknown as typeof fetch;

    const client = new PlaudCloudClient({ token: ACCOUNT, fetcher });
    const recordings = await client.listRecordings();

    expect(seen).toHaveLength(2);
    expect(seen[0]!.url.startsWith('https://api.plaud.ai/file/simple/web')).toBe(true);
    expect(seen[1]!.url.startsWith('https://api-euc1.plaud.ai/file/simple/web')).toBe(true);
    for (const call of seen) {
      expect(call.authorization).toBe(`Bearer ${ACCOUNT}`);
      // A runtime-identifying user agent is refused by Plaud's edge.
      expect(call.userAgent).toBe('OpenPlod');
    }
    expect(client.resolvedDomain).toBe('https://api-euc1.plaud.ai');
    expect(recordings).toHaveLength(2);
  });

  test('maps the fields the library needs', async () => {
    const fetcher = (async () => json({ status: 0, data_file_list: [file('a', { is_trash: true, is_trans: true, is_summary: true })] })) as unknown as typeof fetch;
    const [recording] = await new PlaudCloudClient({ token: ACCOUNT, fetcher }).listRecordings();

    expect(recording).toMatchObject({
      id: 'a',
      filename: '2026-09-21 a',
      startTimeMs: 1789997840000,
      endTimeMs: 1790002980000,
      durationMs: 5140000,
      sizeBytes: 21933056,
      serial: '8810B50327175322',
      md5: 'abc',
      scene: 1,
      isTrash: true,
      hasTranscript: true,
      hasSummary: true,
    });
    expect(recording!.recordedAt).toBe(new Date(1789997840000).toISOString());
  });

  test('excludes trashed recordings on request', async () => {
    const fetcher = (async () => json({ status: 0, data_file_list: [file('keep'), file('gone', { is_trash: true })] })) as unknown as typeof fetch;
    const client = new PlaudCloudClient({ token: ACCOUNT, fetcher });
    expect((await client.listRecordings()).map(r => r.id)).toEqual(['keep', 'gone']);
    expect((await client.listRecordings({ includeTrash: false })).map(r => r.id)).toEqual(['keep']);
  });

  test('skips entries with no identifier instead of failing the whole list', async () => {
    const fetcher = (async () => json({ status: 0, data_file_list: [file('a'), { filename: 'broken' }, 'junk'] })) as unknown as typeof fetch;
    const recordings = await new PlaudCloudClient({ token: ACCOUNT, fetcher }).listRecordings();
    expect(recordings.map(r => r.id)).toEqual(['a']);
  });

  test('explains a rejected token instead of leaking Plaud status codes', async () => {
    const fetcher = (async () => json({ status: -3900, msg: 'invalid auth header' })) as unknown as typeof fetch;
    const client = new PlaudCloudClient({ token: ACCOUNT, fetcher });
    await expect(client.listRecordings()).rejects.toThrow(/Sign in to web\.plaud\.ai again/);
  });

  test('reports when a region cannot be resolved', async () => {
    const fetcher = (async () => json({ status: -302, msg: 'user region mismatch', data: {} })) as unknown as typeof fetch;
    const client = new PlaudCloudClient({ token: ACCOUNT, fetcher });
    await expect(client.listRecordings()).rejects.toThrow(/did not report a server/);
  });

  test('surfaces an edge block distinctly', async () => {
    const fetcher = (async () => new Response('blocked', { status: 403 })) as unknown as typeof fetch;
    const client = new PlaudCloudClient({ token: ACCOUNT, fetcher });
    await expect(client.listRecordings()).rejects.toMatchObject({ code: 'blocked' });
  });

  test('returns a signed download URL', async () => {
    const fetcher = (async () => json({ status: 0, temp_url: 'https://bucket.example/audio.ogg?sig=1' })) as unknown as typeof fetch;
    const client = new PlaudCloudClient({ token: ACCOUNT, fetcher });
    expect(await client.temporaryUrl('a')).toBe('https://bucket.example/audio.ogg?sig=1');
  });

  test('rejects a recording Plaud cannot serve', async () => {
    const fetcher = (async () => json({ status: 0 })) as unknown as typeof fetch;
    const client = new PlaudCloudClient({ token: ACCOUNT, fetcher });
    await expect(client.temporaryUrl('a')).rejects.toMatchObject({ code: 'no_download' });
  });

  test('streams a recording to disk and reports progress', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const fetcher = (async (input: RequestInfo | URL) => {
      if (String(input).startsWith('https://bucket.example/')) return new Response(payload);
      return json({ status: 0, temp_url: 'https://bucket.example/audio.ogg' });
    }) as unknown as typeof fetch;

    const destination = join(root, 'download.ogg');
    const progress: number[] = [];
    const client = new PlaudCloudClient({ token: ACCOUNT, fetcher });
    const written = await client.download('a', destination, received => progress.push(received));

    expect(written).toBe(payload.byteLength);
    expect(progress.at(-1)).toBe(payload.byteLength);
    expect(new Uint8Array(readFileSync(destination))).toEqual(payload);
  });

  test('leaves no partial file behind when a download fails', async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      if (String(input).startsWith('https://bucket.example/')) return new Response('nope', { status: 500 });
      return json({ status: 0, temp_url: 'https://bucket.example/audio.ogg' });
    }) as unknown as typeof fetch;

    const destination = join(root, 'partial.ogg');
    const client = new PlaudCloudClient({ token: ACCOUNT, fetcher });
    await expect(client.download('a', destination)).rejects.toMatchObject({ code: 'download_failed' });
    expect(await Bun.file(destination).exists()).toBe(false);
  });
  test('reads a transcript into the seconds-and-index shape the library stores', async () => {
    const fetcher = (async () => json({
      status: 1,
      data_result: [
        { start_time: 80, end_time: 23680, content: ' Bonjour ', speaker: 'Speaker 1' },
        { start_time: 23680, end_time: 40000, content: 'Salut', speaker: 'Speaker 2' },
        { start_time: 40000, end_time: 41000, content: 'Et encore', speaker: 'Speaker 1' },
        { start_time: 41000, end_time: 42000, content: '', speaker: 'Speaker 9' },
        { start_time: -5, end_time: null, content: 'Sans horodatage', speaker: 0 },
        null,
      ],
      outline_result: [{ start_time: 80, end_time: 23680, topic: 'Ouverture' }, { topic: '' }],
      task_id_info: { trans_task_id: 'task-1' },
    })) as unknown as typeof fetch;

    const transcript = await new PlaudCloudClient({ token: ACCOUNT, fetcher }).transcript('a');

    // Milliseconds become seconds, "Speaker 3" becomes index 2, blank lines are dropped.
    expect(transcript!.segments).toEqual([
      { start: 0.08, end: 23.68, text: 'Bonjour', speaker: 0 },
      { start: 23.68, end: 40, text: 'Salut', speaker: 1 },
      { start: 40, end: 41, text: 'Et encore', speaker: 0 },
      { start: 0, end: 0, text: 'Sans horodatage', speaker: 0 },
    ]);
    expect(transcript).toMatchObject({ speakerCount: 2, taskId: 'task-1' });
    expect(transcript!.fullText).toBe('Bonjour Salut Et encore Sans horodatage');
    expect(transcript!.outline).toEqual([{ start: 0.08, end: 23.68, topic: 'Ouverture' }]);
  });

  test('parses a summary whether Plaud sends JSON text or an object', async () => {
    const body = {
      markdown: '## Resume\n\nLe client veut automatiser.',
      header: { headline: 'Consultation', category: 'Client Needs' },
      summ_type: 'customer-consultation', language: 'Francais', model: 'gemini-2.5-pro', summary_id: 's1',
    };
    const asText = (async () => json({ status: 1, data_result: [], data_result_summ: JSON.stringify(body) })) as unknown as typeof fetch;
    const asObject = (async () => json({ status: 1, data_result: [], data_result_summ: body })) as unknown as typeof fetch;

    for (const fetcher of [asText, asObject]) {
      const transcript = await new PlaudCloudClient({ token: ACCOUNT, fetcher }).transcript('a');
      expect(transcript!.summaryMarkdown).toBe('## Resume\n\nLe client veut automatiser.');
      expect(transcript!.summaryMeta).toMatchObject({
        provider: 'plaud', headline: 'Consultation', template: 'customer-consultation', language: 'Francais',
      });
    }
  });

  test('reports a never-transcribed recording as absent rather than as a failure', async () => {
    const fetcher = (async () => json({ status: -12, msg: 'start trans task error', data_result: null })) as unknown as typeof fetch;
    expect(await new PlaudCloudClient({ token: ACCOUNT, fetcher }).transcript('a')).toBeNull();
  });

  test('accepts the status Plaud uses for a brief memo', async () => {
    const fetcher = (async () => json({
      status: -111, msg: 'success',
      data_result: [{ start_time: 80, end_time: 23680, content: 'Une note.', speaker: 'Speaker 1' }],
    })) as unknown as typeof fetch;

    const transcript = await new PlaudCloudClient({ token: ACCOUNT, fetcher }).transcript('a');
    expect(transcript!.segments).toHaveLength(1);
  });

  test('asks for the transcript with the method and headers Plaud requires', async () => {
    const seen: { url: string; method: string; contentType: string | null; authorization: string | null }[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(input), method: init?.method ?? 'GET',
        contentType: headers.get('content-type'), authorization: headers.get('authorization'),
      });
      return json({ status: 1, data_result: [] });
    }) as unknown as typeof fetch;

    await new PlaudCloudClient({ token: ACCOUNT, fetcher, baseUrl: 'https://api-euc1.plaud.ai' }).transcript('a b');
    expect(seen).toEqual([{
      url: 'https://api-euc1.plaud.ai/ai/transsumm/a%20b', method: 'POST',
      contentType: 'application/json', authorization: `Bearer ${ACCOUNT}`,
    }]);
  });
});

describe('stored sign-in token', () => {
  test('round-trips through the vault with owner-only permissions', async () => {
    expect(await readStoredCloudToken()).toBeNull();
    const path = await writeStoredCloudToken(ACCOUNT);
    expect(path).toBe(cloudTokenPath());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await readStoredCloudToken()).toBe(ACCOUNT);
    expect(await clearStoredCloudToken()).toBe(true);
    expect(await readStoredCloudToken()).toBeNull();
    expect(await clearStoredCloudToken()).toBe(false);
  });

  test('refuses to store something that is not a token', async () => {
    await expect(writeStoredCloudToken('nonsense')).rejects.toThrow(PlaudCloudError);
  });

  test('treats a corrupt file as signed out', async () => {
    await writeStoredCloudToken(ACCOUNT);
    await Bun.write(cloudTokenPath(), '{"token":"garbage"}');
    expect(await readStoredCloudToken()).toBeNull();
  });
});

describe('resolveCloudToken', () => {
  test('prefers an explicit token, then the environment', () => {
    expect(resolveCloudToken(ACCOUNT)).toBe(ACCOUNT);
    process.env.PLAUD_CLOUD_TOKEN = `Bearer ${ACCOUNT}`;
    expect(resolveCloudToken()).toBe(ACCOUNT);
    expect(resolveCloudToken('rubbish')).toBeNull();
  });

  test('returns null when nothing is configured', () => {
    expect(resolveCloudToken()).toBeNull();
  });
});
