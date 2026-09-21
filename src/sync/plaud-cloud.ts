/**
 * Plaud Cloud Transfer — enumerate and download recordings from a Plaud account.
 *
 * Every recording a Plaud device captures is uploaded by the phone or desktop
 * client into Plaud's regional object storage. Reaching that copy only needs a
 * workspace sign-in token: it does not need the recorder identity that the
 * Bluetooth handshake requires, and it does not need Plaud's partner/developer
 * credentials.
 *
 * Plaud's global API host answers with the account's regional domain
 * (`{"status":-302,"data":{"domains":{"api":"https://api-euc1.plaud.ai"}}}`), so
 * no region table is hardcoded here and future regions keep working.
 *
 * `Authorization` must be `Bearer <token>`. Plaud sits behind Cloudflare, which
 * rejects runtimes that identify themselves as bots, so every request pins its
 * own user agent.
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { identityDirectory } from './plaud-provision';

export const PLAUD_CLOUD_BASE = 'https://api.plaud.ai';
export const PLAUD_USER_AGENT = 'OpenPlod';

const FILE_LIST_PATH = '/file/simple/web';
const FILE_TEMP_URL_PATH = '/file/temp-url';
const TRANSCRIPT_PATH = '/ai/transsumm';

// Status codes Plaud returns inside an otherwise successful HTTP response.
// `/file/*` reports success as 0; `/ai/*` reports it as 1.
const STATUS_OK = 0;
const STATUS_REGION_MISMATCH = -302;
const FILE_LIST_SUCCESS = [STATUS_OK] as const;
// `/ai/transsumm` reports a finished transcript as 1, and a short note as -111.
const TRANSCRIPT_SUCCESS = [1, -111] as const;
// Plaud answers with this when the recording was never transcribed; it is not an error.
const TRANSCRIPT_ABSENT = -12;

/** A three-part JWT: this is what web.plaud.ai keeps as the workspace token. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export class PlaudCloudError extends Error {
  readonly code: string;
  /** Plaud's own status code for the call, when the failure came from a response. */
  readonly status: number | null;

  constructor(message: string, code = 'cloud_error', status: number | null = null) {
    super(message);
    this.name = 'PlaudCloudError';
    this.code = code;
    this.status = status;
  }
}

export interface PlaudWorkspace {
  token: string;
  userId: string;
  workspaceId: string | null;
  memberId: string | null;
  region: string | null;
  expiresAt: number | null;
}

export interface PlaudCloudRecording {
  id: string;
  filename: string;
  recordedAt: string;
  startTimeMs: number;
  endTimeMs: number | null;
  durationMs: number;
  sizeBytes: number;
  serial: string | null;
  md5: string | null;
  scene: number | null;
  isTrash: boolean;
  hasTranscript: boolean;
  hasSummary: boolean;
  originalReady: boolean;
}

/** One diarized line. Times are seconds and speakers count from zero, as the library stores them. */
export interface PlaudTranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker: number | null;
}

export interface PlaudTranscriptOutlineEntry {
  start: number;
  end: number;
  topic: string;
}

export interface PlaudTranscript {
  segments: PlaudTranscriptSegment[];
  fullText: string;
  speakerCount: number;
  /** The summary Plaud wrote, as Markdown. Null when the recording has none. */
  summaryMarkdown: string | null;
  summaryMeta: Record<string, unknown> | null;
  outline: PlaudTranscriptOutlineEntry[];
  taskId: string | null;
}

const asString = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Accepts whatever a user can realistically copy out of the Plaud web client:
 * the raw token, a quoted token, a `Bearer` prefix, or a whole JSON blob.
 */
export function normalizeCloudToken(raw: string): string {
  let token = raw.trim();
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    token = token.slice(1, -1).trim();
  }
  if (token.startsWith('{')) {
    try {
      const parsed = JSON.parse(token) as Record<string, unknown>;
      for (const key of ['tokenstr', 'workspaceToken', 'access_token', 'token', 'accessToken']) {
        const value = parsed[key];
        if (typeof value === 'string' && value.length > 0) {
          token = value;
          break;
        }
      }
    } catch {
      // Fall through: the raw value may still be a usable token.
    }
  }
  return token.replace(/^Bearer\s+/i, '').trim();
}

export function parseWorkspaceToken(raw: string): PlaudWorkspace {
  const token = normalizeCloudToken(raw);
  if (!TOKEN_PATTERN.test(token)) {
    throw new PlaudCloudError(
      'That does not look like a Plaud sign-in token. Copy the whole value, then try again.',
      'invalid_token',
    );
  }
  const [, payload] = token.split('.');
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new PlaudCloudError('That Plaud sign-in token is unreadable. Copy it again.', 'invalid_token');
  }
  const userId = asString(claims.sub);
  if (!userId) {
    throw new PlaudCloudError('That Plaud sign-in token has no account in it. Sign in again.', 'invalid_token');
  }
  return {
    token,
    userId,
    workspaceId: asString(claims.wid),
    memberId: asString(claims.mid),
    region: asString(claims.region),
    expiresAt: asNumber(claims.exp),
  };
}

export const cloudTokenPath = () => join(identityDirectory(), 'plaud-cloud.json');

/** Structural check used by the API layer before talking to Plaud. */
export function isWorkspaceToken(value: unknown): value is string {
  try {
    parseWorkspaceToken(String(value ?? ''));
    return true;
  } catch {
    return false;
  }
}

function describeStatus(payload: Record<string, unknown>): string {
  const message = asString(payload.msg) ?? asString(payload.err_msg);
  switch (payload.status) {
    case -3900:
      return 'Plaud rejected the sign-in token. Sign in to web.plaud.ai again and paste a fresh token.';
    case -302:
      return 'Plaud could not match this account to a server. Sign in again and paste a fresh token.';
    case -401:
      return 'This Plaud sign-in token has expired. Sign in again and paste a fresh token.';
    default:
      return message && message !== 'success' ? `Plaud refused the request: ${message}` : 'Plaud refused the request.';
  }
}

export interface PlaudCloudClientOptions {
  token: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
}

export class PlaudCloudClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private domain: string | null = null;

  constructor(options: PlaudCloudClientOptions) {
    this.token = normalizeCloudToken(options.token);
    this.baseUrl = (options.baseUrl ?? PLAUD_CLOUD_BASE).replace(/\/+$/, '');
    this.fetcher = options.fetcher ?? fetch;
  }

  /** The regional API host resolved from the account, once a request has run. */
  get resolvedDomain(): string | null {
    return this.domain;
  }

  private async request(origin: string, path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.fetcher(`${origin}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'User-Agent': PLAUD_USER_AGENT,
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    if (response.status === 403) {
      throw new PlaudCloudError(
        'Plaud refused the request for this client. Update OpenPlod and try again.',
        'blocked',
      );
    }
    if (!response.ok) {
      throw new PlaudCloudError(`Plaud returned HTTP ${response.status}.`, 'http_error');
    }
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      throw new PlaudCloudError('Plaud returned something that was not a response. Try again.', 'http_error');
    }
  }

  /**
   * Calls an endpoint, following the one redirect Plaud uses to point an
   * account at its regional server.
   */
  private async call(
    path: string,
    init?: RequestInit,
    okStatuses: readonly number[] = FILE_LIST_SUCCESS,
  ): Promise<Record<string, unknown>> {
    let payload = await this.request(this.domain ?? this.baseUrl, path, init);
    if (payload.status === STATUS_REGION_MISMATCH) {
      const data = (payload.data ?? {}) as Record<string, unknown>;
      const domains = (data.domains ?? {}) as Record<string, unknown>;
      const api = asString(domains.api);
      if (!api || !/^https:\/\//.test(api)) {
        throw new PlaudCloudError('Plaud did not report a server for this account. Try again.', 'region_unknown');
      }
      this.domain = api.replace(/\/+$/, '');
      payload = await this.request(this.domain, path, init);
    }
    const status = typeof payload.status === 'number' ? payload.status : STATUS_OK;
    if (!okStatuses.includes(status)) throw new PlaudCloudError(describeStatus(payload), 'request_failed', status);
    return payload;
  }

  /** Resolves (and caches) the account's regional API host. */
  async resolveDomain(): Promise<string> {
    if (this.domain) return this.domain;
    await this.call(`${FILE_LIST_PATH}?skip=0&limit=1&is_trash=2`);
    return this.domain ?? this.baseUrl;
  }

  /** Every recording on the account, oldest first. */
  async listRecordings(options: { includeTrash?: boolean } = {}): Promise<PlaudCloudRecording[]> {
    const includeTrash = options.includeTrash !== false;
    const payload = await this.call(
      `${FILE_LIST_PATH}?skip=0&limit=500&is_trash=2&sort_by=start_time&is_desc=false`,
    );
    const raw = payload.data_file_list;
    const entries = Array.isArray(raw) ? raw : [];
    return entries
      .map(entry => toCloudRecording(entry as Record<string, unknown>))
      .filter((recording): recording is PlaudCloudRecording => recording !== null)
      .filter(recording => includeTrash || !recording.isTrash);
  }

  /** A short-lived signed URL for the recording's audio. */
  async temporaryUrl(id: string): Promise<string> {
    const payload = await this.call(`${FILE_TEMP_URL_PATH}/${encodeURIComponent(id)}`);
    const url = asString(payload.temp_url);
    if (!url) throw new PlaudCloudError('Plaud did not provide a download for that recording. Try again.', 'no_download');
    return url;
  }

  /**
   * The transcript, AI summary, and topic outline Plaud produced for a
   * recording. Resolves to null when Plaud never transcribed it, which is the
   * common case for recordings made before transcription was enabled.
   */
  async transcript(id: string): Promise<PlaudTranscript | null> {
    try {
      const payload = await this.call(
        `${TRANSCRIPT_PATH}/${encodeURIComponent(id)}`,
        { method: 'POST', body: '{}' },
        TRANSCRIPT_SUCCESS,
      );
      return toTranscript(payload);
    } catch (error) {
      if (error instanceof PlaudCloudError && error.status === TRANSCRIPT_ABSENT) return null;
      throw error;
    }
  }

  /**
   * Streams one recording to `destination`. Returns the byte count so callers
   * can compare it with the size the account reported.
   */
  async download(
    id: string,
    destination: string,
    onProgress?: (received: number, total: number) => void,
  ): Promise<number> {
    const url = await this.temporaryUrl(id);
    const response = await this.fetcher(url, { headers: { 'User-Agent': PLAUD_USER_AGENT } });
    if (!response.ok || !response.body) {
      throw new PlaudCloudError(`Plaud could not serve that recording (HTTP ${response.status}).`, 'download_failed');
    }
    mkdirSync(dirname(destination), { recursive: true });
    const total = Number(response.headers.get('content-length') ?? 0);
    const sink = createWriteStream(destination);
    const reader = response.body.getReader();
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (!sink.write(value)) await once(sink, 'drain');
        onProgress?.(received, total);
      }
      sink.end();
      await once(sink, 'finish');
    } catch (error) {
      sink.destroy();
      rmSync(destination, { force: true });
      throw error instanceof PlaudCloudError
        ? error
        : new PlaudCloudError('The download stopped before it finished. Try again.', 'download_failed');
    }
    return received;
  }
}

/** "Speaker 3" describes the third voice; the library numbers them from zero. */
function speakerIndex(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  const match = typeof value === 'string' ? /(\d+)\s*$/.exec(value) : null;
  if (!match) return null;
  const parsed = Number.parseInt(match[1] as string, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed - 1 : null;
}

/** Plaud sends the summary either as a JSON object or as a JSON string. */
function parsePlaudSummary(value: unknown): { markdown: string | null; meta: Record<string, unknown> | null } {
  let record: Record<string, unknown> | null = null;
  if (value && typeof value === 'object') record = value as Record<string, unknown>;
  else if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown;
      record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return { markdown: value.trim(), meta: null };
    }
  }
  if (!record) return { markdown: null, meta: null };
  const header = (record.header ?? {}) as Record<string, unknown>;
  return {
    markdown: asString(record.markdown) ?? asString(record.summary),
    meta: {
      provider: 'plaud',
      headline: asString(header.headline),
      category: asString(header.category),
      template: asString(record.summ_type),
      language: asString(record.language),
      summaryId: asString(record.summary_id),
      model: asString(record.model),
    },
  };
}

function toTimestampMs(value: unknown, fallback: number): number {
  const parsed = asNumber(value);
  return parsed !== null && parsed >= 0 ? parsed : fallback;
}

function toTranscript(payload: Record<string, unknown>): PlaudTranscript {
  const rawSegments = Array.isArray(payload.data_result) ? payload.data_result : [];
  const segments = rawSegments.flatMap<PlaudTranscriptSegment>(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const segment = entry as Record<string, unknown>;
    const text = (asString(segment.content) ?? '').trim();
    if (!text) return [];
    const startMs = toTimestampMs(segment.start_time, 0);
    const endMs = Math.max(startMs, toTimestampMs(segment.end_time, startMs));
    return [{ start: startMs / 1000, end: endMs / 1000, text, speaker: speakerIndex(segment.speaker) }];
  });

  const rawOutline = Array.isArray(payload.outline_result) ? payload.outline_result : [];
  const outline = rawOutline.flatMap<PlaudTranscriptOutlineEntry>(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const topic = (asString(record.topic) ?? '').trim();
    if (!topic) return [];
    const startMs = toTimestampMs(record.start_time, 0);
    return [{ start: startMs / 1000, end: Math.max(startMs, toTimestampMs(record.end_time, startMs)) / 1000, topic }];
  });

  const { markdown, meta } = parsePlaudSummary(payload.data_result_summ);
  const taskInfo = (payload.task_id_info ?? {}) as Record<string, unknown>;
  const speakers = new Set(segments.map(segment => segment.speaker).filter((speaker): speaker is number => speaker !== null));
  return {
    segments,
    fullText: segments.map(segment => segment.text).join(' ').trim(),
    speakerCount: speakers.size,
    summaryMarkdown: markdown,
    summaryMeta: markdown ? meta : null,
    outline,
    taskId: asString(taskInfo.trans_task_id),
  };
}

function toCloudRecording(entry: Record<string, unknown>): PlaudCloudRecording | null {
  const id = asString(entry.id);
  if (!id) return null;
  const startTimeMs = asNumber(entry.start_time) ?? 0;
  return {
    id,
    filename: asString(entry.filename) ?? id,
    recordedAt: startTimeMs > 0 ? new Date(startTimeMs).toISOString() : new Date(0).toISOString(),
    startTimeMs,
    endTimeMs: asNumber(entry.end_time),
    durationMs: asNumber(entry.duration) ?? 0,
    sizeBytes: asNumber(entry.filesize) ?? 0,
    serial: asString(entry.serial_number),
    md5: asString(entry.file_md5),
    scene: asNumber(entry.scene),
    isTrash: entry.is_trash === true,
    hasTranscript: entry.is_trans === true,
    hasSummary: entry.is_summary === true,
    originalReady: entry.ori_ready === true,
  };
}

// ---------------------------------------------------------------------------
// Stored sign-in token
// ---------------------------------------------------------------------------

interface StoredCloudToken {
  token: string;
  linkedAt: string;
}

/** The linked account token, or null when this computer has not signed in. */
export async function readStoredCloudToken(): Promise<string | null> {
  const path = cloudTokenPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredCloudToken>;
    if (typeof parsed.token !== 'string') return null;
    parseWorkspaceToken(parsed.token);
    return parsed.token;
  } catch {
    return null;
  }
}

/**
 * Stores the token for later syncs. The token is a full-account credential, so
 * the file is private to the current user.
 */
export async function writeStoredCloudToken(token: string): Promise<string> {
  const workspace = parseWorkspaceToken(token);
  const path = cloudTokenPath();
  mkdirSync(dirname(path), { recursive: true });
  const record: StoredCloudToken = { token: workspace.token, linkedAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(record, null, 2), { mode: 0o600 });
  return path;
}

export async function clearStoredCloudToken(): Promise<boolean> {
  const path = cloudTokenPath();
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** Token from an explicit argument, then the environment; the vault file is async. */
export function resolveCloudToken(explicit?: string | null): string | null {
  const candidate = explicit?.trim() || process.env.PLAUD_CLOUD_TOKEN?.trim();
  if (!candidate) return null;
  try {
    return parseWorkspaceToken(candidate).token;
  } catch {
    return null;
  }
}
