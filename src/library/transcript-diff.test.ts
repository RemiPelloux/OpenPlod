import { describe, expect, test } from 'bun:test';
import { classifyChange, compareVersions, diffTranscripts } from './transcript-diff';

const rebuild = (parts: { op: string; text: string }[], side: 'before' | 'after') =>
  parts.filter(part => part.op === 'equal' || part.op === (side === 'before' ? 'delete' : 'insert'))
    .map(part => part.text).join('');

describe('word diff', () => {
  test('reports identical text as unchanged', () => {
    const diff = diffTranscripts('the same words', 'the same words');
    expect(diff.stats.identical).toBe(true);
    expect(diff.stats.inserted).toBe(0);
    expect(diff.stats.deleted).toBe(0);
    expect(diff.parts.every(part => part.op === 'equal')).toBe(true);
  });

  test('is losslessly reversible into both original texts', () => {
    const before = 'The quick brown fox jumps over the lazy dog.';
    const after = 'The quick red fox leaps over a lazy dog.';
    const diff = diffTranscripts(before, after);
    expect(rebuild(diff.parts, 'before')).toBe(before);
    expect(rebuild(diff.parts, 'after')).toBe(after);
  });

  test('counts inserted and deleted words', () => {
    const diff = diffTranscripts('one two three', 'one three four');
    expect(diff.stats.deleted).toBe(1);
    expect(diff.stats.inserted).toBe(1);
    expect(diff.stats.unchanged).toBe(2);
    expect(diff.stats.identical).toBe(false);
  });

  test('groups a rewritten run into single operations', () => {
    const diff = diffTranscripts('intro alpha beta gamma outro', 'intro delta epsilon outro');
    const deletes = diff.parts.filter(part => part.op === 'delete');
    const inserts = diff.parts.filter(part => part.op === 'insert');
    expect(deletes).toHaveLength(1);
    expect(inserts).toHaveLength(1);
    expect(deletes[0]!.text.trim()).toBe('alpha beta gamma');
  });

  test('handles pure insertion and pure deletion', () => {
    expect(diffTranscripts('', 'brand new').stats).toMatchObject({ inserted: 2, deleted: 0 });
    expect(diffTranscripts('all gone', '').stats).toMatchObject({ inserted: 0, deleted: 2 });
  });

  test('handles two empty texts', () => {
    const diff = diffTranscripts('', '');
    expect(diff.stats.identical).toBe(true);
    expect(diff.parts).toEqual([]);
  });

  test('preserves newlines so paragraph structure survives the diff', () => {
    const before = 'First line.\nSecond line.';
    const after = 'First line.\nChanged line.';
    const diff = diffTranscripts(before, after);
    expect(rebuild(diff.parts, 'before')).toBe(before);
    expect(rebuild(diff.parts, 'after')).toBe(after);
  });

  test('uses word granularity for ordinary transcripts', () => {
    expect(diffTranscripts('a b c', 'a b d').granularity).toBe('word');
  });

  test('a small edit to a huge transcript stays a word diff', () => {
    // Trimming the shared head and tail keeps the quadratic step tiny.
    const huge = Array.from({ length: 20000 }, (_, i) => `word${i}`).join(' ');
    const diff = diffTranscripts(huge, huge + ' extra');
    expect(diff.granularity).toBe('word');
    expect(diff.stats).toMatchObject({ inserted: 1, deleted: 0 });
  });

  test('a large but identical transcript still reports identical', () => {
    const huge = Array.from({ length: 20000 }, (_, i) => `word${i}`).join(' ');
    expect(diffTranscripts(huge, huge).stats.identical).toBe(true);
  });

  test('a wholesale rewrite of a huge transcript degrades instead of hanging', () => {
    const before = Array.from({ length: 6000 }, (_, i) => `alpha${i}`).join('\n');
    const after = Array.from({ length: 6000 }, (_, i) => `beta${i}`).join('\n');
    const started = Date.now();
    const diff = diffTranscripts(before, after);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(diff.granularity).toBe('block');
    expect(diff.stats.identical).toBe(false);
  });

  test('a moderate multi-line rewrite uses a line diff', () => {
    // Too many changed words for a word diff, few enough lines for a line diff.
    const before = Array.from({ length: 400 }, (_, i) => `line ${i} alpha beta gamma delta epsilon`).join('\n');
    const after = Array.from({ length: 400 }, (_, i) => `line ${i} zeta eta theta iota kappa`).join('\n');
    expect(diffTranscripts(before, after).granularity).toBe('line');
  });
});

describe('change classification', () => {
  test('separates manual corrections from model regenerations', () => {
    expect(classifyChange('generated', 'edited')).toBe('manual-correction');
    expect(classifyChange('generated', 'generated')).toBe('regeneration');
    expect(classifyChange('edited', 'edited')).toBe('manual-revision');
  });

  test('flags model output replacing a manual edit', () => {
    // This is the case that silently loses a correction, so it gets its own label.
    expect(classifyChange('edited', 'generated')).toBe('reverted-to-generated');
  });
});

describe('version comparison', () => {
  const before = {
    versionId: 'v1', fullText: 'Hello world.', origin: 'generated',
    createdAt: '2026-01-01T00:00:00.000Z', provenance: { provider: 'mistral' },
  };
  const after = {
    versionId: 'v2', fullText: 'Hello there world.', origin: 'edited',
    createdAt: '2026-01-02T00:00:00.000Z', provenance: null,
  };

  test('returns both sides without their full text and a labelled diff', () => {
    const comparison = compareVersions(before, after);
    expect(comparison.before).toEqual({
      versionId: 'v1', origin: 'generated', createdAt: '2026-01-01T00:00:00.000Z',
      provenance: { provider: 'mistral' },
    });
    expect(comparison.before).not.toHaveProperty('fullText');
    expect(comparison.changeKind).toBe('manual-correction');
    expect(comparison.diff.stats.inserted).toBe(1);
  });

  test('normalizes a missing provenance to null', () => {
    const comparison = compareVersions({ ...before, provenance: undefined }, after);
    expect(comparison.before.provenance).toBeNull();
  });
});
