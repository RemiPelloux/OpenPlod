import { describe, expect, test } from 'bun:test';
import { parseByteRange } from './audio';

describe('parseByteRange', () => {
  test('returns no range when the header is absent', () => {
    expect(parseByteRange(undefined, 100)).toBeNull();
  });

  test('parses bounded, open-ended, and suffix ranges', () => {
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseByteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
  });

  test('clamps the end and rejects unsatisfiable ranges', () => {
    expect(parseByteRange('bytes=90-200', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=100-101', 100)).toBe('invalid');
    expect(parseByteRange('bytes=20-10', 100)).toBe('invalid');
    expect(parseByteRange('items=0-10', 100)).toBe('invalid');
  });
});
