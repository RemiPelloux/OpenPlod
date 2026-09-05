import { describe, expect, test } from 'bun:test';
import { MistralEngine, normalizeMistralTranscription } from './mistral';

describe('Mistral transcription adapter', () => {
  test('normalizes text, segment timestamps, and confidence', () => {
    const result = normalizeMistralTranscription({
      text: '  A useful transcript.  ',
      language: 'en',
      model: 'voxtral-mini-latest',
      segments: [
        { start: 0, end: 1.4, text: ' A useful', avg_logprob: -0.1 },
        { start: 1.4, end: 2.8, text: ' transcript.', avg_logprob: -0.2 },
      ],
    });

    expect(result).toMatchObject({
      success: true,
      engine: 'mistral',
      fullText: 'A useful transcript.',
      wordCount: 3,
      speakerCount: 1,
      duration: 2.8,
      metadata: { language: 'en', model: 'voxtral-mini-latest' },
    });
    expect(result.segments[0]).toMatchObject({ start: 0, end: 1.4, text: 'A useful' });
    expect(result.segments[0].confidence).toBeGreaterThan(0.9);
  });

  test('sends the Voxtral multipart contract without exposing credentials', async () => {
    let authorization = '';
    let submittedModel = '';
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get('Authorization') ?? '';
      submittedModel = (init?.body as FormData).get('model') as string;
      return new Response(JSON.stringify({ text: 'Hello from Voxtral.', duration: 1.2 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const engine = new MistralEngine('private-test-key', fetcher);

    const result = await engine.transcribeBuffer(Buffer.from('audio'), 'audio/webm');

    expect(authorization).toBe('Bearer private-test-key');
    expect(submittedModel).toBe('voxtral-mini-latest');
    expect(result.fullText).toBe('Hello from Voxtral.');
  });

  test('returns a redacted provider error', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ message: 'private-test-key invalid' }), {
      status: 401,
      statusText: 'Unauthorized',
    })) as unknown as typeof fetch;
    const result = await new MistralEngine('private-test-key', fetcher)
      .transcribeBuffer(Buffer.from('audio'), 'audio/webm');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Mistral transcription failed (401 Unauthorized).');
    expect(result.error).not.toContain('private-test-key');
  });
});
