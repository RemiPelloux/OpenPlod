import { describe, expect, test } from 'bun:test';
import {
  applyOperation, countMatches, findReplace, mergeSegments, mergeSpeakers, parseSegments,
  renameSpeaker, segmentsToText, speakerLabels, splitSegment, TranscriptOperationError,
  type EditableSegment,
} from './transcript-operations';

const conversation = (): EditableSegment[] => [
  { start: 0, end: 2, text: 'Bonjour tout le monde.', speaker: 0, confidence: 0.9 },
  { start: 2, end: 5, text: 'Hello everyone.', speaker: 1, confidence: 0.8 },
  { start: 5, end: 8, text: 'Shall we start?', speaker: 0, confidence: 0.95 },
];

describe('segment parsing', () => {
  test('accepts an absent segment list as empty', () => {
    expect(parseSegments(null)).toEqual([]);
    expect(parseSegments(undefined)).toEqual([]);
  });

  test('normalizes missing timing to NaN rather than zero', () => {
    // Zero is a real timestamp; absent timing must stay distinguishable from it.
    const [segment] = parseSegments([{ text: 'No timing.' }]);
    expect(Number.isNaN(segment!.start)).toBe(true);
    expect(Number.isNaN(segment!.end)).toBe(true);
  });

  test('rejects a non-list and a segment without text', () => {
    expect(() => parseSegments('nope')).toThrow(TranscriptOperationError);
    expect(() => parseSegments([{ start: 0, end: 1 }])).toThrow(/no text/i);
  });

  test('keeps string speaker labels as well as indexes', () => {
    expect(parseSegments([{ text: 'Hi', speaker: 'Alice' }])[0]!.speaker).toBe('Alice');
    expect(parseSegments([{ text: 'Hi', speaker: 2 }])[0]!.speaker).toBe(2);
  });
});

describe('document rebuilding', () => {
  test('joins trimmed segment text by line', () => {
    expect(segmentsToText(conversation())).toBe('Bonjour tout le monde.\nHello everyone.\nShall we start?');
  });

  test('drops blank segments without leaving empty lines', () => {
    expect(segmentsToText([{ start: 0, end: 1, text: '  ' }, { start: 1, end: 2, text: 'Real.' }])).toBe('Real.');
  });
});

describe('speaker labels', () => {
  test('lists distinct speakers in first-appearance order', () => {
    expect(speakerLabels(conversation())).toEqual([0, 1]);
  });

  test('ignores segments with no speaker', () => {
    expect(speakerLabels([{ start: 0, end: 1, text: 'x', speaker: null }])).toEqual([]);
  });
});

describe('speaker rename and merge', () => {
  test('renames every segment for that speaker and no others', () => {
    const next = renameSpeaker(conversation(), 0, 'Amelie');
    expect(next.map(s => s.speaker)).toEqual(['Amelie', 1, 'Amelie']);
  });

  test('renaming onto an existing label merges the two speakers', () => {
    const next = renameSpeaker(conversation(), 1, 0);
    expect(speakerLabels(next)).toEqual([0]);
  });

  test('refuses an unknown speaker and a blank name', () => {
    expect(() => renameSpeaker(conversation(), 7, 'X')).toThrow(/does not appear/i);
    expect(() => renameSpeaker(conversation(), 0, '   ')).toThrow(/blank/i);
  });

  test('trims a new speaker name', () => {
    expect(renameSpeaker(conversation(), 0, '  Amelie  ')[0]!.speaker).toBe('Amelie');
  });

  test('merges several speakers into one label', () => {
    const next = mergeSpeakers(conversation(), [0, 1], 'Panel');
    expect(next.every(s => s.speaker === 'Panel')).toBe(true);
  });

  test('merge ignores absent speakers but fails when none are present', () => {
    expect(speakerLabels(mergeSpeakers(conversation(), [0, 9], 'Host'))).toEqual(['Host', 1]);
    expect(() => mergeSpeakers(conversation(), [8, 9], 'Host')).toThrow(/none of those/i);
    expect(() => mergeSpeakers(conversation(), [], 'Host')).toThrow(/at least one/i);
  });

  test('never alters segment text or timing', () => {
    const before = conversation();
    const after = renameSpeaker(before, 0, 'Amelie');
    expect(after.map(s => [s.start, s.end, s.text])).toEqual(before.map(s => [s.start, s.end, s.text]));
  });
});

describe('segment splitting', () => {
  test('preserves the whole original text across both halves', () => {
    const next = splitSegment(conversation(), 1, 5);
    expect(next[1]!.text + next[2]!.text).toBe('Hello everyone.');
    expect(next).toHaveLength(4);
  });

  test('interpolates the boundary inside the original span only', () => {
    const next = splitSegment([{ start: 10, end: 20, text: 'abcdefghij' }], 0, 5);
    expect(next[0]!.start).toBe(10);
    expect(next[0]!.end).toBe(15);
    expect(next[1]!.start).toBe(15);
    expect(next[1]!.end).toBe(20);
  });

  test('does not invent a boundary for a segment with no usable timing', () => {
    const next = splitSegment([{ start: Number.NaN, end: Number.NaN, text: 'abcdef' }], 0, 3);
    expect(Number.isNaN(next[0]!.end)).toBe(true);
    expect(Number.isNaN(next[1]!.start)).toBe(true);
  });

  test('rejects offsets outside the text and splits that would blank a half', () => {
    expect(() => splitSegment(conversation(), 1, 0)).toThrow(/inside the segment/i);
    expect(() => splitSegment(conversation(), 1, 99)).toThrow(/inside the segment/i);
    // Offset 2 leaves "ab" and "   ": the tail is whitespace only.
    expect(() => splitSegment([{ start: 0, end: 1, text: 'ab   ' }], 0, 2)).toThrow(/must contain text/i);
  });

  test('rejects a segment index that does not exist', () => {
    expect(() => splitSegment(conversation(), 9, 2)).toThrow(/does not exist/i);
  });
});

describe('segment merging', () => {
  test('spans first start to last end and joins text in order', () => {
    const next = mergeSegments(conversation(), 0, 2);
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ start: 0, end: 5, text: 'Bonjour tout le monde. Hello everyone.' });
  });

  test('keeps a single speaker but clears a mixed one', () => {
    expect(mergeSegments(conversation(), 0, 2)[0]!.speaker).toBeNull();
    const sameSpeaker: EditableSegment[] = [
      { start: 0, end: 1, text: 'One.', speaker: 3 },
      { start: 1, end: 2, text: 'Two.', speaker: 3 },
    ];
    expect(mergeSegments(sameSpeaker, 0, 2)[0]!.speaker).toBe(3);
  });

  test('drops a merged confidence rather than averaging it', () => {
    expect(mergeSegments(conversation(), 0, 2)[0]!.confidence).toBeNull();
  });

  test('rejects out-of-range and too-small merges', () => {
    expect(() => mergeSegments(conversation(), 0, 1)).toThrow(/at least two/i);
    expect(() => mergeSegments(conversation(), 2, 2)).toThrow(/past the end/i);
    expect(() => mergeSegments(conversation(), 9, 2)).toThrow(/does not exist/i);
  });
});

describe('find and replace', () => {
  test('is case-insensitive by default and counts every occurrence', () => {
    const result = findReplace([{ start: 0, end: 1, text: 'cat CAT cat' }], 'cat', 'dog');
    expect(result.replacements).toBe(3);
    expect(result.segments[0]!.text).toBe('dog dog dog');
  });

  test('honours match case', () => {
    const result = findReplace([{ start: 0, end: 1, text: 'cat CAT' }], 'cat', 'dog', { matchCase: true });
    expect(result.replacements).toBe(1);
    expect(result.segments[0]!.text).toBe('dog CAT');
  });

  test('honours whole word', () => {
    const result = findReplace([{ start: 0, end: 1, text: 'cat catalogue' }], 'cat', 'dog', { wholeWord: true });
    expect(result.replacements).toBe(1);
    expect(result.segments[0]!.text).toBe('dog catalogue');
  });

  test('treats the search term literally, not as a pattern', () => {
    const result = findReplace([{ start: 0, end: 1, text: 'total (a) here' }], '(a)', '[b]');
    expect(result.segments[0]!.text).toBe('total [b] here');
    // A term of regex metacharacters must not match everything.
    expect(findReplace([{ start: 0, end: 1, text: 'abc' }], '.', '!').replacements).toBe(0);
  });

  test('applies whole word only where the term has word edges', () => {
    // "(a)" has no word character at either end, so \b must not be added.
    const result = findReplace([{ start: 0, end: 1, text: 'x (a) y' }], '(a)', 'Z', { wholeWord: true });
    expect(result.replacements).toBe(1);
  });

  test('can be scoped to one speaker', () => {
    const result = findReplace(conversation(), 'e', 'E', { speaker: 1 });
    expect(result.segmentsChanged).toBe(1);
    expect(result.segments[0]!.text).toBe('Bonjour tout le monde.');
  });

  test('reports segments changed separately from occurrences', () => {
    const result = findReplace([
      { start: 0, end: 1, text: 'a a' },
      { start: 1, end: 2, text: 'a' },
      { start: 2, end: 3, text: 'b' },
    ], 'a', 'c');
    expect(result).toMatchObject({ replacements: 3, segmentsChanged: 2 });
  });

  test('counts without changing anything', () => {
    const segments = conversation();
    expect(countMatches(segments, 'Hello')).toBe(1);
    expect(segments[1]!.text).toBe('Hello everyone.');
  });

  test('rejects an empty search term', () => {
    expect(() => findReplace(conversation(), '', 'x')).toThrow(/enter the text/i);
  });

  test('never alters timing', () => {
    const before = conversation();
    const after = findReplace(before, 'e', 'E').segments;
    expect(after.map(s => [s.start, s.end])).toEqual(before.map(s => [s.start, s.end]));
  });
});

describe('operation dispatch', () => {
  test('rebuilds fullText from the edited segments every time', () => {
    const outcome = applyOperation(conversation(), { op: 'replace', search: 'Hello', replacement: 'Hi' });
    expect(outcome.fullText).toContain('Hi everyone.');
    expect(outcome.fullText).toBe(segmentsToText(outcome.segments));
  });

  test('describes each operation for the editor history', () => {
    expect(applyOperation(conversation(), { op: 'rename-speaker', from: 0, to: 'Amelie' }).summary)
      .toBe('Renamed speaker 0 to Amelie');
    expect(applyOperation(conversation(), { op: 'merge-segments', start: 0, count: 2 }).summary)
      .toBe('Merged 2 segments from 1');
    expect(applyOperation(conversation(), { op: 'replace', search: 'Hello', replacement: 'Hi' }).summary)
      .toBe('Replaced 1 occurrence of "Hello"');
  });

  test('does not mutate the input segments, so undo can hold the previous value', () => {
    const before = conversation();
    const snapshot = JSON.stringify(before);
    applyOperation(before, { op: 'rename-speaker', from: 0, to: 'Amelie' });
    applyOperation(before, { op: 'merge-segments', start: 0, count: 2 });
    applyOperation(before, { op: 'split-segment', index: 0, offset: 4 });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  test('rejects an unsupported operation', () => {
    expect(() => applyOperation(conversation(), { op: 'nope' } as never)).toThrow(/unsupported/i);
  });
});
