import { describe, expect, test } from 'bun:test';
import { toFtsQuery } from './transcripts';

describe('toFtsQuery', () => {
  test('normalizes words into safe prefix terms', () => {
    expect(toFtsQuery('  Product roadmap  ')).toBe('"Product"* AND "roadmap"*');
    expect(toFtsQuery('cafe\u0301')).toBe('"café"*');
  });

  test('drops punctuation-only input and caps query complexity', () => {
    expect(toFtsQuery('---')).toBe('');
    expect(toFtsQuery('one two three four five six seven eight nine')).toBe(
      '"one"* AND "two"* AND "three"* AND "four"* AND "five"* AND "six"* AND "seven"* AND "eight"*',
    );
  });
});
