import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { OrganizerError, OrganizerStore } from '../organizer/store';
import { NoteDeliveryService } from '../organizer/delivery';
import { purgeSchema, revisionSchema } from '../organizer/schemas';
import { DocumentGenerationService, generateDocumentSchema } from '../organizer/generation';

export function createOrganizerApi(store: OrganizerStore, delivery = new NoteDeliveryService(store), generation = new DocumentGenerationService(store)) {
  const app = new Hono();
  app.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  app.use('*', bodyLimit({ maxSize: 4 * 1024 * 1024, onError: c => c.json({ success: false, code: 'payload_too_large', error: 'Request is too large.' }, 413) }));
  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ success: false, code: 'invalid_input', error: error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ') }, 400);
    if (error instanceof SyntaxError) return c.json({ success: false, code: 'invalid_json', error: 'Invalid JSON body.' }, 400);
    if (error instanceof OrganizerError) return c.json({ success: false, code: error.code, error: error.message }, error.status);
    return c.json({ success: false, code: 'storage_error', error: 'The note operation could not be completed. Your last saved version is retained.' }, 500);
  });
  app.get('/', c => c.json({ success: true, data: { schemaVersion: '1', capabilities: ['folders', 'documents', 'transcript-snapshots', 'versions', 'deliveries'], markdownLimitBytes: 524288, trashDays: 30 } }));
  app.get('/folders', c => c.json({ success: true, data: store.folders() }));
  app.get('/transcripts/:id', c => c.json({ success: true, data: store.transcript(c.req.param('id'), c.req.query('versionId')) }));
  app.post('/folders', async c => c.json({ success: true, data: store.createFolder(await c.req.json()) }, 201));
  app.patch('/folders/:id', async c => c.json({ success: true, data: store.updateFolder(c.req.param('id'), await c.req.json()) }));
  app.delete('/folders/:id', async c => {
    store.deleteFolder(c.req.param('id'), revisionSchema.parse(await c.req.json()).revision);
    return c.json({ success: true, data: null });
  });
  app.get('/documents', c => c.json({ success: true, data: store.list(c.req.query()) }));
  app.post('/documents', async c => c.json({ success: true, data: store.create(await c.req.json()) }, 201));
  app.post('/documents/from-transcript', async c => c.json({ success: true, data: store.snapshot(await c.req.json()) }));
  app.post('/documents/generate', async c => {
    const input = generateDocumentSchema.parse(await c.req.json());
    const response = streamSSE(c, async stream => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      const heartbeat = setInterval(() => { void stream.writeSSE({ event: 'keepalive', data: '{}' }).catch(() => controller.abort()); }, 10000);
      try {
        const result = await generation.generate(input, async stage => {
          await stream.writeSSE({ event: 'progress', data: JSON.stringify({ id: input.idempotencyKey, stage, provider: 'mistral' }) });
        }, AbortSignal.any([controller.signal, c.req.raw.signal]));
        await stream.writeSSE({ event: 'result', data: JSON.stringify(result) });
      } catch (error) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: error instanceof OrganizerError ? error.message : 'Document generation failed.', id: input.idempotencyKey }) });
      } finally { clearInterval(heartbeat); }
    });
    response.headers.set('Content-Type', 'text/event-stream; charset=utf-8');
    response.headers.set('Cache-Control', 'no-store');
    return response;
  });
  app.get('/generations/:id', c => c.json({ success: true, data: generation.get(c.req.param('id')) }));
  app.post('/generations/:id/save', async c => c.json({ success: true, data: generation.save(c.req.param('id'), await c.req.json()) }));
  app.get('/documents/:id', c => c.json({ success: true, data: store.get(c.req.param('id')) }));
  app.patch('/documents/:id', async c => c.json({ success: true, data: store.update(c.req.param('id'), await c.req.json()) }));
  app.delete('/documents/:id', async c => c.json({ success: true, data: store.trash(c.req.param('id'), revisionSchema.parse(await c.req.json()).revision) }));
  app.post('/documents/:id/restore', async c => c.json({ success: true, data: store.restore(c.req.param('id'), revisionSchema.parse(await c.req.json()).revision) }));
  app.post('/documents/:id/purge', async c => {
    const data = purgeSchema.parse(await c.req.json()); store.purge(c.req.param('id'), data.revision);
    return c.json({ success: true, data: null });
  });
  app.get('/documents/:id/versions', c => c.json({ success: true, data: store.versions(c.req.param('id'), z.coerce.number().int().min(0).max(1000000).parse(c.req.query('offset') || 0)) }));
  app.get('/documents/:id/versions/:versionId', c => c.json({ success: true, data: store.version(c.req.param('id'), c.req.param('versionId')) }));
  app.post('/documents/:id/versions/:versionId/restore', async c => {
    const data = revisionSchema.parse(await c.req.json()), version = store.version(c.req.param('id'), c.req.param('versionId'));
    return c.json({ success: true, data: store.update(c.req.param('id'), { revision: data.revision, title: version.title, content: version.content }) });
  });
  app.get('/documents/:id/export', c => {
    const document = store.active(c.req.param('id'));
    const format = z.enum(['md', 'json']).parse(c.req.query('format') || 'md');
    c.header('Cache-Control', 'no-store');
    c.header('Content-Disposition', `attachment; filename="document.${format}"; filename*=UTF-8''${encodeURIComponent(document.title).replace(/['()*]/g, value => '%' + value.charCodeAt(0).toString(16))}.${format}`);
    c.header('Content-Type', format === 'md' ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8');
    return c.body(format === 'md' ? document.content : JSON.stringify(document, null, 2));
  });
  app.get('/destinations', async c => c.json({ success: true, data: await delivery.list() }));
  app.get('/documents/:id/deliveries', c => c.json({ success: true, data: delivery.history(c.req.param('id')) }));
  app.post('/documents/:id/send', async c => c.json({ success: true, data: await delivery.send(c.req.param('id'), await c.req.json()) }));
  return app;
}
