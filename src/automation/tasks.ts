import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { readSettings } from '../ai/config';
import { protectSetting } from '../vault/secrets';
import { AutomationError, localOnly, nowIso, stableId, transportOutcome, type Fetcher } from './common';

/**
 * Reviewed task exports (roadmap KB-10).
 *
 * Action items become local drafts first. A person edits and approves each
 * one, then explicitly exports approved drafts to a connector. Nothing is
 * posted automatically and transcript text is never read as an instruction.
 * Each (task, connector) pair has one export row with a stable id that is
 * claimed before sending and stores the remote id after; an approved task is
 * therefore created at most once per connector, and an uncertain outcome is
 * recorded as `unknown` and not resent without explicit confirmation.
 */
export const CONNECTORS = ['todoist', 'linear', 'notion'] as const;
export type Connector = typeof CONNECTORS[number];
export type TaskStatus = 'draft' | 'approved' | 'dismissed';
export type ExportState = 'pending' | 'created' | 'failed' | 'unknown';
export interface TaskExport { connector: Connector; status: ExportState; remoteId: string | null; remoteUrl: string | null; error: string | null; attempts: number; updatedAt: string }
export interface TaskDraft {
  id: string; recordingId: string | null; title: string; notes: string; owner: string | null; dueDate: string | null; dueText: string | null;
  source: 'extracted' | 'manual'; status: TaskStatus; revision: number; createdAt: string; updatedAt: string; exports: TaskExport[];
}

const title = z.string().trim().min(1).max(500).refine(value => !/[\x00-\x08\x0b-\x1f]/.test(value), 'Use a title without control characters');
const notes = z.string().max(4000).default('');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Use a real date (YYYY-MM-DD)');
const identifier = z.string().uuid();
export const createTaskSchema = z.object({ title, notes, owner: z.string().trim().max(120).nullable().default(null), dueDate: isoDate.nullable().default(null), recordingId: identifier.nullable().default(null) }).strict();
export const updateTaskSchema = z.object({ title: title.optional(), notes: notes.optional(), owner: z.string().trim().max(120).nullable().optional(), dueDate: isoDate.nullable().optional(),
  status: z.enum(['draft', 'approved', 'dismissed']).optional(), revision: z.number().int().positive() }).strict();
/** Items supplied by the client from a structure it just reviewed (e.g. TS-06 action items). */
export const extractSchema = z.object({ recordingId: identifier, items: z.array(z.object({
  text: z.string().trim().min(1).max(600), owner: z.string().trim().max(120).nullish(), due: z.string().trim().max(60).nullish(),
}).strict()).max(100).optional() }).strict();
export const exportSchema = z.object({ connector: z.enum(CONNECTORS), taskIds: z.array(identifier).min(1).max(50), confirm: z.literal(true),
  /** Resend tasks whose earlier export outcome is unknown; this can create a duplicate. */
  retryUnknown: z.boolean().default(false) }).strict();
const secret = z.string().trim().max(512).regex(/^[^\r\n]*$/);
export const connectorSettingsSchema = z.object({
  todoistApiToken: secret.optional(), linearApiKey: secret.optional(), linearTeamId: z.string().trim().max(64).regex(/^[a-zA-Z0-9-]*$/).optional(),
  notionApiKey: secret.optional(), notionDatabaseId: z.string().trim().max(64).regex(/^[a-fA-F0-9-]*$/).optional(),
  notionTitleProperty: z.string().trim().max(100).optional(), notionDateProperty: z.string().trim().max(100).optional(),
}).strict();
const SETTING_KEYS = Object.keys(connectorSettingsSchema.shape) as (keyof z.infer<typeof connectorSettingsSchema>)[];

type TaskRow = Omit<TaskDraft, 'exports'>;
const taskColumns = `id, recording_id AS recordingId, title, notes, owner, due_date AS dueDate, due_text AS dueText, source, status, revision, created_at AS createdAt, updated_at AS updatedAt`;

export function initializeTasks(database: Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS task_drafts (
      id TEXT PRIMARY KEY, recording_id TEXT, source_ref TEXT UNIQUE, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', owner TEXT,
      due_date TEXT, due_text TEXT, source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS task_drafts_recording ON task_drafts(recording_id, created_at);
    CREATE TABLE IF NOT EXISTS task_exports (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, connector TEXT NOT NULL, status TEXT NOT NULL, remote_id TEXT, remote_url TEXT, error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(task_id, connector)
    );
  `);
}

/** Only an unambiguous ISO date is kept; "next Friday" stays text for a person to resolve. */
const asIsoDate = (value: string | null | undefined) => value && /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) && isoDate.safeParse(value.trim()).success ? value.trim() : null;

export class TaskService {
  constructor(readonly database: Database, private fetcher: Fetcher = fetch, private timeoutMs = 15000) { initializeTasks(database); }

  list(filter: { recordingId?: string; status?: TaskStatus } = {}): TaskDraft[] {
    const rows = this.database.query(`SELECT ${taskColumns} FROM task_drafts WHERE (?1 IS NULL OR recording_id=?1) AND (?2 IS NULL OR status=?2) ORDER BY created_at DESC, id LIMIT 500`)
      .all(filter.recordingId ?? null, filter.status ?? null) as TaskRow[];
    return this.withExportsMany(rows);
  }

  /** Several drafts by id, in the order given. Any unknown id is a 404, as with `get`. */
  getMany(ids: string[]): TaskDraft[] {
    const rows = new Map((this.database.query(`SELECT ${taskColumns} FROM task_drafts WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as TaskRow[]).map(row => [row.id, row]));
    if (ids.some(id => !rows.has(id))) throw new AutomationError(404, 'task_not_found', 'Task draft not found.');
    const byId = new Map(this.withExportsMany([...rows.values()]).map(task => [task.id, task]));
    return ids.map(id => byId.get(id)!);
  }

  get(id: string): TaskDraft {
    const row = this.database.query(`SELECT ${taskColumns} FROM task_drafts WHERE id=?`).get(id) as TaskRow | null;
    if (!row) throw new AutomationError(404, 'task_not_found', 'Task draft not found.');
    return this.withExports(row);
  }

  private withExports(row: TaskRow): TaskDraft {
    const exports = this.database.query(`SELECT connector, status, remote_id AS remoteId, remote_url AS remoteUrl, error, attempts, updated_at AS updatedAt FROM task_exports WHERE task_id=? ORDER BY connector`).all(row.id) as TaskExport[];
    return { ...row, exports };
  }

  /** Exports for a page of drafts in one query. */
  private withExportsMany(rows: TaskRow[]): TaskDraft[] {
    if (!rows.length) return [];
    const exports = this.database.query(`SELECT task_id AS taskId, connector, status, remote_id AS remoteId, remote_url AS remoteUrl, error, attempts, updated_at AS updatedAt
      FROM task_exports WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY connector`).all(JSON.stringify(rows.map(row => row.id))) as (TaskExport & { taskId: string })[];
    const byTask = new Map<string, TaskExport[]>();
    for (const { taskId, ...item } of exports) { const list = byTask.get(taskId); if (list) list.push(item); else byTask.set(taskId, [item]); }
    return rows.map(row => ({ ...row, exports: byTask.get(row.id) ?? [] }));
  }

  create(input: unknown): TaskDraft {
    const data = createTaskSchema.parse(input), id = crypto.randomUUID(), now = nowIso();
    this.database.query(`INSERT INTO task_drafts(id,recording_id,title,notes,owner,due_date,source,created_at,updated_at) VALUES(?,?,?,?,?,?,'manual',?,?)`)
      .run(id, data.recordingId, data.title, data.notes, data.owner, data.dueDate, now, now);
    return this.get(id);
  }

  /**
   * Turn action items into drafts. Items come from the request (a structure the
   * client just showed) or from the recording's saved analysis. Repeating the
   * call never duplicates a draft.
   */
  extract(input: unknown): { created: TaskDraft[]; existing: number } {
    const data = extractSchema.parse(input);
    if (!this.database.query("SELECT 1 FROM recordings WHERE id=? AND retention_state='active'").get(data.recordingId)) throw new AutomationError(404, 'recording_not_found', 'Recording not found.');
    let items = data.items?.map(item => ({ title: item.text, owner: item.owner ?? null, due: item.due ?? null, notes: '' }));
    if (!items) {
      const row = this.database.query('SELECT extracted_tasks AS tasks FROM transcripts WHERE recording_id=?').get(data.recordingId) as { tasks: string | null } | null;
      const saved = (() => { try { return JSON.parse(row?.tasks || '[]') as { title?: unknown; description?: unknown; assignee?: unknown; dueDate?: unknown }[]; } catch { return []; } })();
      items = (Array.isArray(saved) ? saved : []).filter(task => typeof task?.title === 'string' && task.title.trim()).slice(0, 100).map(task => ({
        title: String(task.title).trim().slice(0, 500), notes: typeof task.description === 'string' ? task.description.slice(0, 4000) : '',
        owner: typeof task.assignee === 'string' ? task.assignee.slice(0, 120) : null, due: typeof task.dueDate === 'string' ? task.dueDate.slice(0, 60) : null }));
    }
    if (!items.length) throw new AutomationError(404, 'no_action_items', 'No action items found. Run analysis or structure extraction first, or add tasks by hand.');
    const created: TaskDraft[] = [];
    let existing = 0;
    const now = nowIso();
    this.database.transaction(() => {
      for (const item of items!) {
        const sourceRef = stableId('task-source', data.recordingId, item.title.toLocaleLowerCase());
        const id = crypto.randomUUID();
        const inserted = this.database.query(`INSERT OR IGNORE INTO task_drafts(id,recording_id,source_ref,title,notes,owner,due_date,due_text,source,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,'extracted',?,?)`).run(id, data.recordingId, sourceRef, item.title.slice(0, 500), item.notes, item.owner, asIsoDate(item.due), item.due, now, now).changes;
        if (inserted) created.push(this.get(id)); else existing++;
      }
    })();
    return { created, existing };
  }

  update(id: string, input: unknown): TaskDraft {
    const data = updateTaskSchema.parse(input), current = this.get(id);
    if (current.revision !== data.revision) throw new AutomationError(409, 'revision_conflict', 'This task changed elsewhere. Reload and try again.');
    const content = data.title !== undefined || data.notes !== undefined || data.owner !== undefined || data.dueDate !== undefined;
    // Editing content after approval returns the task to review.
    const status = data.status ?? (content && current.status === 'approved' ? 'draft' : current.status);
    this.database.query(`UPDATE task_drafts SET title=?, notes=?, owner=?, due_date=?, status=?, revision=revision+1, updated_at=? WHERE id=? AND revision=?`)
      .run(data.title ?? current.title, data.notes ?? current.notes, data.owner === undefined ? current.owner : data.owner, data.dueDate === undefined ? current.dueDate : data.dueDate,
        status, nowIso(), id, data.revision);
    return this.get(id);
  }

  remove(id: string) {
    const task = this.get(id);
    if (task.exports.some(item => item.status === 'created' || item.status === 'pending' || item.status === 'unknown'))
      throw new AutomationError(409, 'task_exported', 'This task was (or may have been) exported. Dismiss it instead so its export record is kept.');
    this.database.query('DELETE FROM task_drafts WHERE id=?').run(id);
  }

  // ---------------------------------------------------------------- connectors

  connectorSettings() {
    const values = readSettings(this.database);
    return {
      todoist: { configured: Boolean(values.todoistApiToken) },
      linear: { configured: Boolean(values.linearApiKey && values.linearTeamId), teamId: values.linearTeamId ?? '' },
      notion: { configured: Boolean(values.notionApiKey && values.notionDatabaseId), databaseId: values.notionDatabaseId ?? '',
        titleProperty: values.notionTitleProperty || 'Name', dateProperty: values.notionDateProperty ?? '' },
    };
  }

  /** Credentials are stored like other settings and never returned. An empty string clears a value. */
  saveConnectorSettings(input: unknown) {
    const data = connectorSettingsSchema.parse(input);
    this.database.transaction(() => {
      for (const key of SETTING_KEYS) {
        const value = data[key];
        if (value === undefined) continue;
        if (value === '') this.database.query('DELETE FROM user_settings WHERE key=?').run(key);
        else this.database.query("INSERT INTO user_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')").run(key, protectSetting(key, value));
      }
    })();
    return this.connectorSettings();
  }

  /** Create approved tasks in one connector. Only explicit calls reach here; nothing is scheduled. */
  async export(input: unknown): Promise<{ results: { taskId: string; status: ExportState | 'skipped'; remoteId: string | null; remoteUrl: string | null; error: string | null }[] }> {
    const data = exportSchema.parse(input);
    if (localOnly(this.database)) throw new AutomationError(403, 'local_only', 'Local-only mode blocks sending task text to external services. Download a calendar file instead.');
    const settings = readSettings(this.database);
    const missing = data.connector === 'todoist' ? !settings.todoistApiToken : data.connector === 'linear' ? !(settings.linearApiKey && settings.linearTeamId) : !(settings.notionApiKey && settings.notionDatabaseId);
    if (missing) throw new AutomationError(400, 'connector_not_configured', `Add ${data.connector} credentials first.`);
    const results = [];
    for (const taskId of [...new Set(data.taskIds)]) {
      const task = this.get(taskId);
      if (task.status !== 'approved') { results.push({ taskId, status: 'skipped' as const, remoteId: null, remoteUrl: null, error: 'Approve this task before exporting it.' }); continue; }
      const exportId = stableId('task-export', taskId, data.connector), now = nowIso();
      // Claim the (task, connector) pair before any network call.
      const claimed = this.database.transaction(() => {
        const row = this.database.query('SELECT status FROM task_exports WHERE id=?').get(exportId) as { status: ExportState } | null;
        if (!row) { this.database.query("INSERT INTO task_exports(id,task_id,connector,status,attempts,created_at,updated_at) VALUES(?,?,?,'pending',1,?,?)").run(exportId, taskId, data.connector, now, now); return true; }
        if (row.status === 'failed' || (row.status === 'unknown' && data.retryUnknown)) {
          this.database.query("UPDATE task_exports SET status='pending', error=NULL, attempts=attempts+1, updated_at=? WHERE id=?").run(now, exportId); return true;
        }
        return false;
      })();
      if (!claimed) {
        const row = this.exportRow(exportId);
        results.push({ taskId, status: row.status, remoteId: row.remoteId, remoteUrl: row.remoteUrl,
          error: row.status === 'unknown' ? 'An earlier export may have succeeded. Check the service, then retry with retryUnknown to resend.' : row.status === 'pending' ? 'An export is already in progress.' : null });
        continue;
      }
      const outcome = await this.send(data.connector, task, exportId, settings);
      this.database.query('UPDATE task_exports SET status=?, remote_id=?, remote_url=?, error=?, updated_at=? WHERE id=?')
        .run(outcome.status, outcome.remoteId, outcome.remoteUrl, outcome.error, nowIso(), exportId);
      results.push({ taskId, ...outcome });
    }
    return { results };
  }

  private exportRow(id: string) {
    return this.database.query('SELECT status, remote_id AS remoteId, remote_url AS remoteUrl FROM task_exports WHERE id=?').get(id) as { status: ExportState; remoteId: string | null; remoteUrl: string | null };
  }

  private async send(connector: Connector, task: TaskDraft, exportId: string, settings: Record<string, string>): Promise<{ status: ExportState; remoteId: string | null; remoteUrl: string | null; error: string | null }> {
    const description = [task.notes, task.owner ? `Owner: ${task.owner}` : '', task.dueText && !task.dueDate ? `Due (as said): ${task.dueText}` : '', 'Created from an OpenPlod reviewed task.'].filter(Boolean).join('\n\n');
    let request: { url: string; headers: Record<string, string>; body: unknown };
    if (connector === 'todoist') request = { url: 'https://api.todoist.com/rest/v2/tasks',
      headers: { Authorization: `Bearer ${settings.todoistApiToken}`, 'X-Request-Id': exportId },
      body: { content: task.title, description, ...(task.dueDate ? { due_date: task.dueDate } : {}) } };
    else if (connector === 'linear') request = { url: 'https://api.linear.app/graphql', headers: { Authorization: settings.linearApiKey },
      body: { query: 'mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }',
        variables: { input: { teamId: settings.linearTeamId, title: task.title, description, ...(task.dueDate ? { dueDate: task.dueDate } : {}) } } } };
    else {
      const titleProperty = settings.notionTitleProperty || 'Name', dateProperty = settings.notionDateProperty;
      request = { url: 'https://api.notion.com/v1/pages', headers: { Authorization: `Bearer ${settings.notionApiKey}`, 'Notion-Version': '2022-06-28' },
        body: { parent: { database_id: settings.notionDatabaseId }, properties: { [titleProperty]: { title: [{ text: { content: task.title.slice(0, 2000) } }] },
          ...(dateProperty && task.dueDate ? { [dateProperty]: { date: { start: task.dueDate } } } : {}) },
          children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: description.slice(0, 2000) } }] } }] } };
    }
    let response: Response;
    try {
      response = await this.fetcher(request.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'Content-Type': 'application/json', ...request.headers }, body: JSON.stringify(request.body) });
    } catch (error) {
      return transportOutcome(error) === 'failed'
        ? { status: 'failed', remoteId: null, remoteUrl: null, error: 'Could not connect. Nothing was sent.' }
        : { status: 'unknown', remoteId: null, remoteUrl: null, error: 'No response. The task may have been created; check before retrying.' };
    }
    const payload = await response.json().catch(() => null) as Record<string, any> | null;
    // A 4xx means the service refused the request; a 5xx may still have created the task.
    if (!response.ok) return { status: response.status >= 500 ? 'unknown' : 'failed', remoteId: null, remoteUrl: null, error: `${connector} answered HTTP ${response.status}.` };
    if (connector === 'todoist' && payload?.id) return { status: 'created', remoteId: String(payload.id), remoteUrl: typeof payload.url === 'string' ? payload.url : null, error: null };
    if (connector === 'linear') {
      const issue = payload?.data?.issueCreate?.issue;
      if (payload?.data?.issueCreate?.success && issue?.id) return { status: 'created', remoteId: String(issue.identifier ?? issue.id), remoteUrl: typeof issue.url === 'string' ? issue.url : null, error: null };
      if (Array.isArray(payload?.errors) && !payload?.data?.issueCreate) return { status: 'failed', remoteId: null, remoteUrl: null, error: 'Linear rejected the issue. Check the team id and API key.' };
    }
    if (connector === 'notion' && payload?.id) return { status: 'created', remoteId: String(payload.id), remoteUrl: typeof payload.url === 'string' ? payload.url : null, error: null };
    return { status: 'unknown', remoteId: null, remoteUrl: null, error: `${connector} accepted the request but returned no task id. Check before retrying.` };
  }

  /** An iCalendar file with one all-day event per dated task. Local only; nothing is sent. */
  calendar(taskIds?: string[]): string {
    const tasks = (taskIds?.length ? this.getMany(taskIds) : this.list()).filter(task => task.dueDate && task.status !== 'dismissed');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    const fold = (line: string) => { const parts: string[] = []; let rest = line; while (Buffer.byteLength(rest) > 74) { let cut = 74; while (Buffer.byteLength(rest.slice(0, cut)) > 74) cut--; parts.push(rest.slice(0, cut)); rest = ` ${rest.slice(cut)}`; } parts.push(rest); return parts.join('\r\n'); };
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//OpenPlod//Reviewed tasks//EN', 'CALSCALE:GREGORIAN'];
    for (const task of tasks) {
      const day = task.dueDate!.replace(/-/g, ''), next = new Date(Date.parse(`${task.dueDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10).replace(/-/g, '');
      lines.push('BEGIN:VEVENT', `UID:${task.id}@openplod`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${next}`, `SUMMARY:${escape(task.title)}`,
        ...(task.notes || task.owner ? [`DESCRIPTION:${escape([task.notes, task.owner ? `Owner: ${task.owner}` : ''].filter(Boolean).join('\n'))}`] : []), 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
  }
}
