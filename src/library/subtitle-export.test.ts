import { describe, expect, test } from 'bun:test';
import {
  isSubtitleFormat, renderSubtitles, subtitleReadiness, toSrt, toVtt,
} from './subtitle-export';

const timed = [
  { start: 0, end: 1.5, text: 'Hello there.', speaker: 0 },
  { start: 1.5, end: 4.25, text: 'General Kenobi.', speaker: 1 },
];

describe('subtitle readiness', () => {
  test('accepts genuine segment timings', () => {
    const readiness = subtitleReadiness(timed);
    expect(readiness.exportable).toBe(true);
    expect(readiness.cues).toHaveLength(2);
    expect(readiness.reason).toBeNull();
  });

  test('refuses a transcript with no segments', () => {
    expect(subtitleReadiness([]).reason).toBe('no-segments');
    expect(subtitleReadiness(null).reason).toBe('no-segments');
    expect(subtitleReadiness('not an array').reason).toBe('no-segments');
  });

  test('refuses segments that carry text but no timing', () => {
    const readiness = subtitleReadiness([{ text: 'No timings here.' }]);
    expect(readiness.reason).toBe('no-timing');
    expect(readiness.exportable).toBe(false);
  });

  test('treats all-zero provider timings as no timing, not as valid cues', () => {
    // Several providers emit 0/0 rather than admitting they have no timing.
    const readiness = subtitleReadiness([
      { start: 0, end: 0, text: 'One.' },
      { start: 0, end: 0, text: 'Two.' },
    ]);
    expect(readiness.reason).toBe('no-timing');
  });

  test('refuses negative and non-finite timings', () => {
    expect(subtitleReadiness([{ start: -2, end: -1, text: 'Before zero.' }]).reason).toBe('invalid-timing');
    expect(subtitleReadiness([{ start: Number.NaN, end: 4, text: 'Broken.' }]).reason).toBe('no-timing');
    expect(subtitleReadiness([{ start: 0, end: Number.POSITIVE_INFINITY, text: 'Endless.' }]).reason).toBe('no-timing');
  });

  test('refuses segments whose text is only whitespace', () => {
    expect(subtitleReadiness([{ start: 0, end: 1, text: '   ' }]).reason).toBe('empty-text');
  });

  test('keeps the usable cues when only some segments are broken', () => {
    const readiness = subtitleReadiness([
      { start: 0, end: 1, text: 'Good.' },
      { start: 5, end: 5, text: 'Collapsed.' },
      { start: 6, end: 7, text: 'Also good.' },
    ]);
    expect(readiness.exportable).toBe(true);
    expect(readiness.cues.map(cue => cue.text)).toEqual(['Good.', 'Also good.']);
  });

  test('orders cues by start time without altering them', () => {
    const readiness = subtitleReadiness([
      { start: 9, end: 10, text: 'Later.' },
      { start: 1, end: 2, text: 'Earlier.' },
    ]);
    expect(readiness.cues.map(cue => cue.text)).toEqual(['Earlier.', 'Later.']);
    expect(readiness.cues[0]).toMatchObject({ start: 1, end: 2 });
  });
});

describe('SRT rendering', () => {
  test('numbers cues from one and uses comma milliseconds', () => {
    expect(toSrt(timed)).toBe(
      '1\n00:00:00,000 --> 00:00:01,500\nHello there.\n\n'
      + '2\n00:00:01,500 --> 00:00:04,250\nGeneral Kenobi.\n',
    );
  });

  test('formats hours, minutes and milliseconds correctly', () => {
    const output = toSrt([{ start: 3661.007, end: 3662, text: 'Past an hour.' }]);
    expect(output).toContain('01:01:01,007 --> 01:01:02,000');
  });

  test('adds speaker labels only when asked', () => {
    expect(toSrt(timed, { speakerLabels: true })).toContain('Speaker 1: Hello there.');
    expect(toSrt(timed, { speakerLabels: true })).toContain('Speaker 2: General Kenobi.');
    expect(toSrt(timed)).not.toContain('Speaker');
  });

  test('never emits a blank line inside a cue, which would truncate it', () => {
    const output = toSrt([{ start: 0, end: 1, text: 'First line.\n\n\nSecond line.' }]);
    expect(output).toContain('First line.\nSecond line.');
  });

  test('throws with the refusal detail rather than emitting fake timings', () => {
    expect(() => toSrt([{ text: 'No timing.' }])).toThrow(/no timings/i);
  });
});

describe('WebVTT rendering', () => {
  test('starts with the WEBVTT header and uses dot milliseconds', () => {
    const output = toVtt(timed);
    expect(output.startsWith('WEBVTT\n\n')).toBe(true);
    expect(output).toContain('00:00:00.000 --> 00:00:01.500');
    expect(output).not.toContain(',500 -->');
  });

  test('throws for an untimed transcript', () => {
    expect(() => toVtt([])).toThrow(/no segments/i);
  });
});

describe('format selection', () => {
  test('recognizes only the supported formats', () => {
    expect(isSubtitleFormat('srt')).toBe(true);
    expect(isSubtitleFormat('vtt')).toBe(true);
    expect(isSubtitleFormat('sub')).toBe(false);
    expect(isSubtitleFormat('')).toBe(false);
  });

  test('renders the requested format', () => {
    expect(renderSubtitles('srt', timed)).toContain(',500');
    expect(renderSubtitles('vtt', timed)).toContain('WEBVTT');
  });
});
