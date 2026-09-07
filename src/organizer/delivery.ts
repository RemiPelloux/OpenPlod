import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OrganizerError, OrganizerStore } from './store';
import { sendNoteSchema } from './schemas';
import type { NoteDelivery, NoteDestination } from './types';

const destinationSchema = z.object({ id: z.string().regex(/^[a-z0-9-]{1,64}$/), name: z.string().trim().min(1).max(80),
  url: z.string().url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash; }, 'Destinations require HTTPS without URL credentials'),
  bearerToken: z.string().max(4096).regex(/^[\x21-\x7e]*$/).optional(),
}).strict();
export type DeliveryDestination = z.infer<typeof destinationSchema>;

export async function readDestinations(): Promise<DeliveryDestination[]> {
  const path = process.env.OPENPLOD_DESTINATIONS_FILE || resolve(dirname(process.env.OPENPLOD_LIBRARY_PATH || './data/recordings'), 'openplod-destinations.json');
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 65536 || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) throw new Error();
    const rows = z.array(destinationSchema).max(20).parse(JSON.parse(await readFile(path, 'utf8')));
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error();
    return rows;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new OrganizerError(503, 'destinations_unavailable', 'Destination configuration must be valid JSON and private to the server user.');
  }
}

export class NoteDeliveryService {
  constructor(private readonly store: OrganizerStore,
    private readonly destinations: () => Promise<DeliveryDestination[]> = readDestinations,
    private readonly fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch) {}

  async list(): Promise<NoteDestination[]> {
    return (await this.destinations()).map(({ id, name, url }) => ({ id, name, host: new URL(url).host }));
  }

  history(documentId: string): NoteDelivery[] {
    this.store.get(documentId);
    // An interrupted process cannot establish whether a remote endpoint accepted a POST.
    this.store.database.query("UPDATE note_deliveries SET state='unknown' WHERE state='pending' AND created_at<?")
      .run(new Date(Date.now() - 60000).toISOString());
    return this.store.database.query(`SELECT id, document_id AS documentId, document_revision AS documentRevision,
      destination_id AS destinationId, state, created_at AS createdAt, status_code AS statusCode
      FROM note_deliveries WHERE document_id=? ORDER BY created_at DESC, id DESC LIMIT 30`).all(documentId) as NoteDelivery[];
  }

  async send(documentId: string, input: unknown): Promise<NoteDelivery> {
    const data = sendNoteSchema.parse(input);
    const requestHash = createHash('sha256').update(JSON.stringify({ documentId, ...data })).digest('hex');
    const existing = this.store.database.query('SELECT document_id AS documentId, request_hash AS requestHash FROM note_deliveries WHERE id=?')
      .get(data.idempotencyKey) as {documentId: string; requestHash: string} | null;
    if (existing) {
      if (existing.requestHash !== requestHash) throw new OrganizerError(409, 'idempotency_conflict', 'This delivery key was used for a different request.');
      return this.history(existing.documentId).find(row => row.id === data.idempotencyKey)
        ?? this.delivery(data.idempotencyKey);
    }
    const destination = (await this.destinations()).find(row => row.id === data.destinationId);
    if (!destination) throw new OrganizerError(404, 'destination_not_found', 'Configured destination not found.');
    destinationSchema.parse(destination);
    // Re-check revision after asynchronous configuration I/O and claim the key before sending.
    const claim = this.store.database.transaction(() => {
      const raced = this.store.database.query('SELECT request_hash AS requestHash FROM note_deliveries WHERE id=?').get(data.idempotencyKey) as {requestHash: string} | null;
      if (raced) {
        if (raced.requestHash !== requestHash) throw new OrganizerError(409, 'idempotency_conflict', 'Delivery key conflict.');
        return null;
      }
      const document = this.store.active(documentId, data.revision);
      this.store.database.query(`INSERT INTO note_deliveries(id,document_id,document_revision,destination_id,state,created_at,request_hash) VALUES(?,?,?,?,'pending',?,?)`)
        .run(data.idempotencyKey, documentId, data.revision, destination.id, new Date().toISOString(), requestHash);
      return document;
    })();
    if (!claim) return this.delivery(data.idempotencyKey);
    let state = 'unknown', status: number | null = null;
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Idempotency-Key': data.idempotencyKey };
      if (destination.bearerToken) headers.Authorization = `Bearer ${destination.bearerToken}`;
      const response = await this.fetcher(destination.url, { method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ schemaVersion: '1', event: 'document.export', deliveryId: data.idempotencyKey, document: {
          id: claim.id, title: claim.title, content: claim.content, revision: claim.revision,
          sourceRecordingId: claim.sourceRecordingId, sourceVersionId: claim.sourceVersionId,
        } }),
      });
      status = response.status;
      if (response.ok) state = 'sent';
      await response.body?.cancel();
    } catch { /* Remote bodies and transport errors can include credentials; never persist them. */ }
    this.store.database.query('UPDATE note_deliveries SET state=?, status_code=? WHERE id=?').run(state, status, data.idempotencyKey);
    return this.delivery(data.idempotencyKey);
  }

  private delivery(id: string): NoteDelivery {
    return this.store.database.query(`SELECT id, document_id AS documentId, document_revision AS documentRevision,
      destination_id AS destinationId, state, created_at AS createdAt, status_code AS statusCode FROM note_deliveries WHERE id=?`).get(id) as NoteDelivery;
  }
}
