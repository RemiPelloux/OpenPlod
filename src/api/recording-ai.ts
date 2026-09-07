import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { OrganizerError } from '../organizer/store';
import { RecordingAi, questionSchema } from '../organizer/recording-ai';

export function createRecordingAiApi(ai: RecordingAi) {
  const app = new Hono();
  app.use('*', bodyLimit({ maxSize: 32768 }));
  app.onError((e, c) => c.json({ success: false, error: e instanceof OrganizerError ? e.message : 'Invalid AI request.' }, e instanceof OrganizerError ? e.status : 400));
  app.get('/conversations', c => c.json({ success: true, data: ai.conversations() }));
  app.get('/conversations/:id', c => c.json({ success: true, data: ai.history(c.req.param('id')) }));
  app.post('/ask', async c => {
    const input = questionSchema.parse(await c.req.json());
    return streamSSE(c, async stream => {
      const abort = new AbortController(); stream.onAbort(() => abort.abort());
      const timer = setInterval(() => { void stream.writeSSE({ event: 'keepalive', data: '{}' }).catch(() => abort.abort()); }, 10000);
      try {
        const result = await ai.ask(input, async stage => { await stream.writeSSE({ event: 'progress', data: JSON.stringify({ stage, id: input.id, provider: 'mistral' }) }); }, AbortSignal.any([abort.signal, c.req.raw.signal]));
        await stream.writeSSE({ event: 'result', data: JSON.stringify(result) });
      } catch (e) { await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: e instanceof OrganizerError ? e.message : 'AI request failed.', id: input.id }) }); }
      finally { clearInterval(timer); }
    });
  });
  return app;
}
