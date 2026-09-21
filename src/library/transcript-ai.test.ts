import { describe, expect, test } from 'bun:test';
import {
  extractStructure, proposeCleanup, proposeTranslation, TranscriptAiError, type CompleteText,
} from './transcript-ai';
import { TextProviderError, type TextSelection } from '../ai/text';
import type { EditableSegment } from './transcript-operations';

const selection: TextSelection = { provider: 'mistral', model: 'test-model', apiKey: 'k' };

/** A stub provider that returns a fixed body and records what it was sent. */
function stub(text: string) {
  const sent: { system: string; user: string }[] = [];
  const complete: CompleteText = async (_selection, messages) => {
    sent.push({
      system: messages.find(m => m.role === 'system')?.content ?? '',
      user: messages.find(m => m.role === 'user')?.content ?? '',
    });
    return { text, provider: 'mistral', model: 'test-model', usage: { total_tokens: 12 } };
  };
  return { complete, sent };
}

const failing = (error: Error): CompleteText => async () => { throw error; };

const segments: EditableSegment[] = [
  { start: 0, end: 4, text: 'Welcome everyone, let us start with the budget.', speaker: 0 },
  { start: 4, end: 9, text: 'We decided to postpone the launch to March.', speaker: 1 },
  { start: 9, end: 14, text: 'Marie will send the revised figures.', speaker: 0 },
];

describe('input guards', () => {
  test('refuses an empty transcript before contacting a provider', async () => {
    const { complete, sent } = stub('ignored');
    await expect(proposeCleanup('   ', { punctuation: true }, { selection, complete }))
      .rejects.toThrow(/no transcript text/i);
    expect(sent).toHaveLength(0);
  });

  test('refuses an oversized transcript rather than truncating it', async () => {
    const { complete, sent } = stub('ignored');
    const huge = 'word '.repeat(30_000);
    await expect(proposeCleanup(huge, { punctuation: true }, { selection, complete }))
      .rejects.toThrow(/has not been truncated or sent/i);
    expect(sent).toHaveLength(0);
  });

  test('maps a provider error to a typed code', async () => {
    await expect(proposeCleanup('Hello.', { punctuation: true },
      { selection, complete: failing(new TextProviderError('rate limited')) }))
      .rejects.toMatchObject({ code: 'provider_error' });
  });

  test('reports a generic provider failure without claiming a save', async () => {
    const error = await proposeCleanup('Hello.', { punctuation: true },
      { selection, complete: failing(new Error('socket hang up')) })
      .then(() => null, (e: unknown) => e as TranscriptAiError);
    expect(error?.code).toBe('provider_failed');
    expect(error?.message).toMatch(/nothing was saved/i);
  });
});

describe('TS-04 cleanup', () => {
  test('returns the proposal with a diff and never saves', async () => {
    const { complete } = stub('Hello there. General Kenobi.');
    const proposal = await proposeCleanup('hello there general kenobi', { punctuation: true }, { selection, complete });
    expect(proposal.text).toBe('Hello there. General Kenobi.');
    expect(proposal.diff.stats.identical).toBe(false);
    expect(proposal.provider).toBe('mistral');
    expect(proposal.usage).toEqual({ total_tokens: 12 });
  });

  test('requires at least one cleanup option', async () => {
    const { complete, sent } = stub('x');
    await expect(proposeCleanup('Some text.', { punctuation: false, paragraphs: false }, { selection, complete }))
      .rejects.toThrow(/at least one cleanup option/i);
    expect(sent).toHaveLength(0);
  });

  test('only asks for filler removal when it was requested', async () => {
    const off = stub('text');
    await proposeCleanup('um text', { punctuation: true }, { selection, complete: off.complete });
    expect(off.sent[0]!.system).not.toMatch(/filler/i);

    const on = stub('text');
    await proposeCleanup('um text', { removeFillers: true }, { selection, complete: on.complete });
    expect(on.sent[0]!.system).toMatch(/filler/i);
  });

  test('instructs the model not to reword or summarise', async () => {
    const { complete, sent } = stub('text');
    await proposeCleanup('some text', { punctuation: true }, { selection, complete });
    expect(sent[0]!.system).toMatch(/must not reword, summarise/i);
    expect(sent[0]!.system).toMatch(/untrusted source material/i);
  });

  test('rejects a response that deletes more than half the transcript', async () => {
    // A provider that "cleans up" by summarising must not reach the review step.
    const source = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const { complete } = stub('word0 word1 word2');
    await expect(proposeCleanup(source, { punctuation: true }, { selection, complete }))
      .rejects.toMatchObject({ code: 'provider_lossy' });
  });

  test('rejects an empty response', async () => {
    const { complete } = stub('   ');
    await expect(proposeCleanup('Real text here.', { punctuation: true }, { selection, complete }))
      .rejects.toMatchObject({ code: 'provider_unstructured' });
  });
});

describe('TS-05 translation', () => {
  test('returns the translation with its language and source lineage', async () => {
    const { complete, sent } = stub('Bonjour tout le monde.');
    const proposal = await proposeTranslation('Hello everyone.', 'fr', { selection, complete }, 'v1');
    expect(proposal).toMatchObject({ text: 'Bonjour tout le monde.', targetLanguage: 'fr', sourceVersionId: 'v1' });
    expect(sent[0]!.system).toMatch(/translate the transcript into fr/i);
  });

  test('trims the language tag and rejects a malformed one', async () => {
    const { complete } = stub('x');
    expect((await proposeTranslation('Hi.', '  pt-BR  ', { selection, complete })).targetLanguage).toBe('pt-BR');
    for (const bad of ['', '  ', '!!', 'a'.repeat(40)]) {
      await expect(proposeTranslation('Hi.', bad, { selection, complete })).rejects.toMatchObject({ code: 'invalid_language' });
    }
  });

  test('instructs the model not to summarise or omit', async () => {
    const { complete, sent } = stub('x');
    await proposeTranslation('Hi.', 'de', { selection, complete });
    expect(sent[0]!.system).toMatch(/do not summarise, omit/i);
  });

  test('defaults the source version to null when not supplied', async () => {
    const { complete } = stub('x');
    expect((await proposeTranslation('Hi.', 'de', { selection, complete })).sourceVersionId).toBeNull();
  });
});

describe('TS-06 structured extraction', () => {
  const payload = JSON.stringify({
    chapters: [{ title: 'Budget', segmentIndex: 0 }],
    decisions: [{ text: 'Postpone the launch to March.', segmentIndex: 1 }],
    actionItems: [{ text: 'Send the revised figures.', owner: 'Marie', due: null, segmentIndex: 2 }],
    openQuestions: [{ text: 'Who signs off?', segmentIndex: 1 }],
  });

  test('resolves timestamps from our own segments, not from the model', async () => {
    const { complete } = stub(payload);
    const structure = await extractStructure(segments, { selection, complete });
    expect(structure.chapters[0]).toMatchObject({ title: 'Budget', startSeconds: 0, segmentIndex: 0 });
    expect(structure.decisions[0]).toMatchObject({ startSeconds: 4 });
    expect(structure.actionItems[0]).toMatchObject({ owner: 'Marie', due: null, startSeconds: 9 });
    expect(structure.timestampsAvailable).toBe(true);
  });

  test('forbids the model from emitting times at all', async () => {
    const { complete, sent } = stub(payload);
    await extractStructure(segments, { selection, complete });
    expect(sent[0]!.system).toMatch(/never output a timestamp/i);
    // The model is shown indexes, so it can cite them.
    expect(JSON.parse(sent[0]!.user).segments[0]).toMatchObject({ i: 0 });
  });

  test('drops a link when the model cites a segment that does not exist', async () => {
    const { complete } = stub(JSON.stringify({ decisions: [{ text: 'Invented.', segmentIndex: 99 }] }));
    const structure = await extractStructure(segments, { selection, complete });
    expect(structure.decisions[0]).toMatchObject({ startSeconds: null, segmentIndex: null });
  });

  test('yields no timestamp for an untimed segment rather than zero', async () => {
    const untimed: EditableSegment[] = [{ start: Number.NaN, end: Number.NaN, text: 'No timing at all.' }];
    const { complete } = stub(JSON.stringify({ decisions: [{ text: 'Something.', segmentIndex: 0 }] }));
    const structure = await extractStructure(untimed, { selection, complete });
    expect(structure.decisions[0]!.startSeconds).toBeNull();
    expect(structure.timestampsAvailable).toBe(false);
  });

  test('keeps an unstated owner and due date null', async () => {
    const { complete } = stub(JSON.stringify({
      actionItems: [{ text: 'Do the thing.', segmentIndex: 0 }],
    }));
    const structure = await extractStructure(segments, { selection, complete });
    expect(structure.actionItems[0]).toMatchObject({ owner: null, due: null });
  });

  test('treats placeholder owners and dates as unknown', async () => {
    // Models write "unknown"/"TBD" instead of omitting the field.
    const { complete } = stub(JSON.stringify({
      actionItems: [
        { text: 'A.', owner: 'Unknown', due: 'TBD', segmentIndex: 0 },
        { text: 'B.', owner: 'N/A', due: 'not stated', segmentIndex: 0 },
      ],
    }));
    const structure = await extractStructure(segments, { selection, complete });
    expect(structure.actionItems.map(item => [item.owner, item.due])).toEqual([[null, null], [null, null]]);
  });

  test('keeps a due date verbatim rather than resolving it to a date', async () => {
    const { complete } = stub(JSON.stringify({
      actionItems: [{ text: 'Ship it.', owner: 'Marie', due: 'next Friday', segmentIndex: 2 }],
    }));
    const structure = await extractStructure(segments, { selection, complete });
    expect(structure.actionItems[0]!.due).toBe('next Friday');
  });

  test('accepts JSON wrapped in a code fence or prose', async () => {
    const { complete } = stub('Here you go:\n```json\n{"decisions":[{"text":"Yes.","segmentIndex":0}]}\n```');
    const structure = await extractStructure(segments, { selection, complete });
    expect(structure.decisions[0]!.text).toBe('Yes.');
  });

  test('rejects malformed and non-conforming responses', async () => {
    await expect(extractStructure(segments, { selection, complete: stub('not json at all').complete }))
      .rejects.toMatchObject({ code: 'provider_unstructured' });
    await expect(extractStructure(segments, { selection, complete: stub('{"chapters":[{"title":""}]}').complete }))
      .rejects.toMatchObject({ code: 'provider_unstructured' });
  });

  test('returns empty lists when the model finds nothing', async () => {
    const { complete } = stub('{}');
    const structure = await extractStructure(segments, { selection, complete });
    expect(structure).toMatchObject({ chapters: [], decisions: [], actionItems: [], openQuestions: [] });
  });

  test('refuses a transcript with no segments', async () => {
    const { complete, sent } = stub('{}');
    await expect(extractStructure([], { selection, complete })).rejects.toMatchObject({ code: 'no_segments' });
    expect(sent).toHaveLength(0);
  });
});
