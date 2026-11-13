import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { TaskService } from './tasks';

type Call = { url: string; init: RequestInit };
function fixture(respond: (call: Call) => Promise<Response> | Response = () => Response.json({ id: 'td-1', url: 'https://todoist.com/showTask?id=td-1' })) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE user_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE recordings (id TEXT PRIMARY KEY, retention_state TEXT DEFAULT 'active');
    CREATE TABLE transcripts (id TEXT, recording_id TEXT, extracted_tasks TEXT);`);
  const recordingId = crypto.randomUUID();
  db.query('INSERT INTO recordings(id) VALUES(?)').run(recordingId);
  const calls: Call[] = [];
  const service = new TaskService(db, async (url, init) => { calls.push({ url, init }); return respond({ url, init }); });
  return { db, service, calls, recordingId };
}
const approve = (service: TaskService, id: string) => service.update(id, { status: 'approved', revision: service.get(id).revision });

test('action items become local drafts once; spoken due dates stay text until a person sets a date', () => {
  const { db, service, recordingId } = fixture();
  expect(() => service.extract({ recordingId })).toThrow('No action items');
  db.query('INSERT INTO transcripts VALUES(?,?,?)').run('t', recordingId, JSON.stringify([{ title: 'Send the deck', assignee: 'Ana', dueDate: '2026-11-02', context: 'q' }, { title: 'Book a room', context: 'q' }]));
  const saved = service.extract({ recordingId });
  expect(saved.created.map(task => [task.title, task.owner, task.dueDate, task.status, task.source])).toEqual([
    ['Send the deck', 'Ana', '2026-11-02', 'draft', 'extracted'], ['Book a room', null, null, 'draft', 'extracted']]);
  expect(service.extract({ recordingId })).toMatchObject({ created: [], existing: 2 });
  const supplied = service.extract({ recordingId, items: [{ text: 'Call the vendor', due: 'next Friday' }, { text: 'send the deck' }] });
  expect(supplied.existing).toBe(1);
  expect(supplied.created[0]).toMatchObject({ title: 'Call the vendor', dueDate: null, dueText: 'next Friday' });
  expect(service.list({ recordingId })).toHaveLength(3);
  const manual = service.create({ title: 'Follow up', dueDate: '2026-12-01' });
  expect(manual.source).toBe('manual');
  expect(() => service.create({ title: 'Bad', dueDate: '2026-13-45' })).toThrow();
});

test('only approved tasks export, each exactly once per connector, with the remote id stored', async () => {
  const { service, calls, db } = fixture();
  const task = service.create({ title: 'Send the deck', notes: 'v2 only', owner: 'Ana', dueDate: '2026-11-02' });
  await expect(service.export({ connector: 'todoist', taskIds: [task.id], confirm: true })).rejects.toThrow('credentials');
  service.saveConnectorSettings({ todoistApiToken: 'tok' });
  expect(service.connectorSettings().todoist.configured).toBe(true);
  expect(JSON.stringify(service.connectorSettings())).not.toContain('tok');
  expect((await service.export({ connector: 'todoist', taskIds: [task.id], confirm: true })).results[0]).toMatchObject({ status: 'skipped' });
  expect(calls).toHaveLength(0);
  approve(service, task.id);
  const first = await service.export({ connector: 'todoist', taskIds: [task.id, task.id], confirm: true });
  expect(first.results).toEqual([{ taskId: task.id, status: 'created', remoteId: 'td-1', remoteUrl: 'https://todoist.com/showTask?id=td-1', error: null }]);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('https://api.todoist.com/rest/v2/tasks');
  const headers = calls[0].init.headers as Record<string, string>;
  expect(headers.Authorization).toBe('Bearer tok');
  expect(headers['X-Request-Id']).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ content: 'Send the deck', due_date: '2026-11-02' });
  const again = await service.export({ connector: 'todoist', taskIds: [task.id], confirm: true, retryUnknown: true });
  expect(again.results[0]).toMatchObject({ status: 'created', remoteId: 'td-1' });
  expect(calls).toHaveLength(1);
  expect(service.get(task.id).exports).toMatchObject([{ connector: 'todoist', status: 'created', remoteId: 'td-1', attempts: 1 }]);
  expect(() => service.remove(task.id)).toThrow('Dismiss');
  // Editing an approved task returns it to review.
  expect(service.update(task.id, { title: 'Send the final deck', revision: service.get(task.id).revision }).status).toBe('draft');
  // Export requires explicit confirmation and local-only mode blocks it.
  await expect(service.export({ connector: 'todoist', taskIds: [task.id] })).rejects.toThrow();
  db.query("INSERT INTO user_settings(key,value) VALUES('aiConfig',?)").run(JSON.stringify({ privacyMode: 'local-only' }));
  await expect(service.export({ connector: 'todoist', taskIds: [task.id], confirm: true })).rejects.toThrow('Local-only');
});

test('an uncertain export is unknown and is resent only when explicitly asked; a refusal can be retried', async () => {
  let mode: 'timeout' | 'reject' | 'ok' = 'timeout';
  const { service, calls } = fixture(() => {
    if (mode === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    if (mode === 'reject') return new Response('bad', { status: 400 });
    return Response.json({ id: 'td-9' });
  });
  service.saveConnectorSettings({ todoistApiToken: 'tok' });
  const task = service.create({ title: 'Call vendor' });
  approve(service, task.id);
  expect((await service.export({ connector: 'todoist', taskIds: [task.id], confirm: true })).results[0]).toMatchObject({ status: 'unknown', remoteId: null });
  mode = 'ok';
  const held = await service.export({ connector: 'todoist', taskIds: [task.id], confirm: true });
  expect(held.results[0].status).toBe('unknown');
  expect(held.results[0].error).toContain('retryUnknown');
  expect(calls).toHaveLength(1);
  expect((await service.export({ connector: 'todoist', taskIds: [task.id], confirm: true, retryUnknown: true })).results[0]).toMatchObject({ status: 'created', remoteId: 'td-9' });
  expect(calls).toHaveLength(2);
  // Both attempts carried the same request id, so Todoist can deduplicate them.
  expect((calls[0].init.headers as Record<string, string>)['X-Request-Id']).toBe((calls[1].init.headers as Record<string, string>)['X-Request-Id']);
  const other = service.create({ title: 'Refused' });
  approve(service, other.id);
  mode = 'reject';
  expect((await service.export({ connector: 'todoist', taskIds: [other.id], confirm: true })).results[0]).toMatchObject({ status: 'failed' });
  mode = 'ok';
  expect((await service.export({ connector: 'todoist', taskIds: [other.id], confirm: true })).results[0]).toMatchObject({ status: 'created' });
});

test('Linear and Notion requests use their documented shapes', async () => {
  const { service, calls } = fixture(({ url }) => url.includes('linear')
    ? Response.json({ data: { issueCreate: { success: true, issue: { id: 'uuid-1', identifier: 'ENG-12', url: 'https://linear.app/x/issue/ENG-12' } } } })
    : Response.json({ id: 'page-1', url: 'https://notion.so/page-1' }));
  service.saveConnectorSettings({ linearApiKey: 'lin_api', linearTeamId: 'team-1', notionApiKey: 'secret_n', notionDatabaseId: 'abc123', notionDateProperty: 'Due' });
  const task = service.create({ title: 'Ship it', dueDate: '2026-11-03' });
  approve(service, task.id);
  expect((await service.export({ connector: 'linear', taskIds: [task.id], confirm: true })).results[0]).toMatchObject({ status: 'created', remoteId: 'ENG-12' });
  const linear = JSON.parse(String(calls[0].init.body));
  expect(linear.query).toContain('issueCreate');
  expect(linear.variables.input).toMatchObject({ teamId: 'team-1', title: 'Ship it', dueDate: '2026-11-03' });
  expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('lin_api');
  expect((await service.export({ connector: 'notion', taskIds: [task.id], confirm: true })).results[0]).toMatchObject({ status: 'created', remoteId: 'page-1' });
  const notion = JSON.parse(String(calls[1].init.body));
  expect(notion.parent).toEqual({ database_id: 'abc123' });
  expect(notion.properties.Name.title[0].text.content).toBe('Ship it');
  expect(notion.properties.Due).toEqual({ date: { start: '2026-11-03' } });
  expect((calls[1].init.headers as Record<string, string>)['Notion-Version']).toBe('2022-06-28');
  expect(service.get(task.id).exports.map(item => item.connector)).toEqual(['linear', 'notion']);
});

test('the calendar file has one all-day event per dated task and escapes text', () => {
  const { service } = fixture();
  const dated = service.create({ title: 'Review, then sign; done', notes: 'line one\nline two', dueDate: '2026-12-31' });
  service.create({ title: 'No date' });
  const ics = service.calendar();
  expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  expect(ics).toContain(`UID:${dated.id}@openplod`);
  expect(ics).toContain('DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101');
  expect(ics).toContain('SUMMARY:Review\\, then sign\\; done');
  expect(ics).toContain('DESCRIPTION:line one\\nline two');
  expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
});

test('listing drafts and building a calendar do not query once per task', async () => {
  const { countQueries } = await import('../testing/count-queries');
  const { db, service } = fixture();
  const seed = (n: number) => Array.from({ length: n }, (_, i) => service.create({ title: `Task ${i}`, dueDate: '2026-12-01' }).id);
  const one = seed(1);
  db.query("INSERT INTO task_exports(id,task_id,connector,status,created_at,updated_at) VALUES('x',?,'todoist','created','t','t')").run(one[0]);
  const small = await countQueries(db, () => service.list());
  const smallCalendar = await countQueries(db, () => service.calendar(one));
  const many = [...one, ...seed(49)];
  const large = await countQueries(db, () => service.list());
  const largeCalendar = await countQueries(db, () => service.calendar(many));
  expect(large.count).toBe(small.count);
  expect(largeCalendar.count).toBe(smallCalendar.count);
  expect(large.result.find(task => task.id === one[0])!.exports).toEqual([expect.objectContaining({ connector: 'todoist', status: 'created' })]);
  expect(() => service.calendar([one[0], 'missing'])).toThrow('Task draft not found');
});
