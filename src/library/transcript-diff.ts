/**
 * Transcript version comparison (roadmap TS-03).
 *
 * Every transcript version is either `generated` (a model produced it) or
 * `edited` (a person corrected it). Comparing two versions has to keep those
 * apart, because "what did the model change?" and "what did I change?" are
 * different questions, and answering them with one undifferentiated diff is
 * how a manual correction gets silently reverted.
 *
 * The diff is a word-level longest-common-subsequence, which reads naturally
 * for prose. Transcript edits are usually local, so the shared head and tail
 * are stripped before the quadratic part runs; only the genuinely changed
 * middle reaches the LCS table. That keeps a small correction to a long
 * transcript cheap, and bounds the table for the cases it does not.
 */

export type DiffOp = 'equal' | 'insert' | 'delete';

export interface DiffPart {
  op: DiffOp;
  /** The token run this part covers, already joined for display. */
  text: string;
}

export interface DiffStats {
  inserted: number;
  deleted: number;
  unchanged: number;
  /** True when the two versions are textually identical. */
  identical: boolean;
}

export interface TranscriptDiff {
  parts: DiffPart[];
  stats: DiffStats;
  /**
   * How the texts were compared:
   * - `word`: word-level, the normal case
   * - `line`: the changed region was too large for a word diff
   * - `block`: the changed region was too large even for a line diff, so it is
   *   reported as one wholesale replacement rather than a misleading detail
   */
  granularity: 'word' | 'line' | 'block';
}

/**
 * Per-side token bound for the quadratic step. The table is
 * (n+1)*(m+1) Uint32 entries, so 2000 caps one comparison at about 16 MB.
 */
const WORD_DIFF_LIMIT = 2000;
const LINE_DIFF_LIMIT = 2000;

/**
 * A comparison unit: `key` is what the diff matches on, `text` is what is
 * emitted. Separating them lets the diff treat "three" and "three " as the
 * same word while still reproducing the original spacing exactly.
 */
interface Token { key: string; text: string }

/**
 * Split into word tokens, each carrying the whitespace that follows it.
 *
 * Whitespace is deliberately *not* a token of its own: a lone space would
 * otherwise anchor an LCS match in the middle of a rewritten passage and
 * split one replaced run into several confusing fragments. Concatenating
 * every `text` reproduces the input exactly.
 */
function tokenizeWords(value: string): Token[] {
  const words = value.match(/\S+\s*/g) ?? [];
  const tokens: Token[] = words.map(text => ({ key: text.trimEnd(), text }));
  const leading = value.match(/^\s+/)?.[0];
  if (leading === undefined) return tokens;
  // Leading whitespace belongs to the first token so nothing is lost.
  if (tokens.length === 0) return [{ key: '', text: leading }];
  tokens[0] = { key: tokens[0]!.key, text: leading + tokens[0]!.text };
  return tokens;
}

const tokenizeLines = (value: string): Token[] =>
  value.split(/(?<=\n)/).filter(Boolean).map(text => ({ key: text, text }));

/** Count the words in a token run, for statistics. */
const wordCount = (text: string): number => text.match(/\S+/g)?.length ?? 0;

/** Append to the previous part when the operation matches, so runs stay whole. */
function pusher(parts: DiffPart[]) {
  return (op: DiffOp, text: string) => {
    if (text === '') return;
    const last = parts[parts.length - 1];
    if (last && last.op === op) last.text += text;
    else parts.push({ op, text });
  };
}

/** Longest-common-subsequence edit script over two bounded token lists. */
function lcsParts(before: Token[], after: Token[], push: (op: DiffOp, text: string) => void): void {
  const n = before.length;
  const m = after.length;
  // table[i][j] = LCS length of before[i..] and after[j..]
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = table[i]!;
    const nextRow = table[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = before[i]!.key === after[j]!.key ? nextRow[j + 1]! + 1 : Math.max(nextRow[j]!, row[j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i]!.key === after[j]!.key) { push('equal', before[i]!.text); i++; j++; }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) { push('delete', before[i]!.text); i++; }
    else { push('insert', after[j]!.text); j++; }
  }
  while (i < n) { push('delete', before[i]!.text); i++; }
  while (j < m) { push('insert', after[j]!.text); j++; }
}

interface Trimmed {
  head: Token[];
  beforeMiddle: Token[];
  afterMiddle: Token[];
  tail: Token[];
}

/** Strip the shared head and tail so only the changed region is compared. */
function trimCommon(before: Token[], after: Token[]): Trimmed {
  let start = 0;
  const limit = Math.min(before.length, after.length);
  while (start < limit && before[start]!.key === after[start]!.key) start++;
  let end = 0;
  while (end < limit - start && before[before.length - 1 - end]!.key === after[after.length - 1 - end]!.key) end++;
  return {
    head: before.slice(0, start),
    beforeMiddle: before.slice(start, before.length - end),
    afterMiddle: after.slice(start, after.length - end),
    tail: end ? before.slice(before.length - end) : [],
  };
}

/** Compare two transcript texts. */
export function diffTranscripts(before: string, after: string): TranscriptDiff {
  const parts: DiffPart[] = [];
  const push = pusher(parts);

  let granularity: TranscriptDiff['granularity'] = 'word';
  let trimmed = trimCommon(tokenizeWords(before), tokenizeWords(after));

  if (trimmed.beforeMiddle.length > WORD_DIFF_LIMIT || trimmed.afterMiddle.length > WORD_DIFF_LIMIT) {
    // Too much changed for a readable word diff; compare whole lines instead.
    granularity = 'line';
    trimmed = trimCommon(tokenizeLines(before), tokenizeLines(after));
  }

  const join = (tokens: Token[]) => tokens.map(token => token.text).join('');
  push('equal', join(trimmed.head));
  const overLineLimit = trimmed.beforeMiddle.length > LINE_DIFF_LIMIT || trimmed.afterMiddle.length > LINE_DIFF_LIMIT;
  if (granularity === 'line' && overLineLimit) {
    // Report one wholesale replacement rather than an unreadable detail diff.
    granularity = 'block';
    push('delete', join(trimmed.beforeMiddle));
    push('insert', join(trimmed.afterMiddle));
  } else {
    lcsParts(trimmed.beforeMiddle, trimmed.afterMiddle, push);
  }
  push('equal', join(trimmed.tail));

  const total = (op: DiffOp) =>
    parts.filter(part => part.op === op).reduce((sum, part) => sum + wordCount(part.text), 0);
  const inserted = total('insert');
  const deleted = total('delete');
  return {
    parts,
    granularity,
    stats: { inserted, deleted, unchanged: total('equal'), identical: inserted === 0 && deleted === 0 },
  };
}

/** One stored transcript version, as the comparison endpoint sees it. */
export interface VersionRecord {
  versionId: string;
  fullText: string;
  origin: string;
  createdAt: string;
  provenance?: Record<string, unknown> | null;
}

export interface VersionComparison {
  before: Omit<VersionRecord, 'fullText'>;
  after: Omit<VersionRecord, 'fullText'>;
  diff: TranscriptDiff;
  /**
   * What kind of change this is, so the UI can label it honestly:
   * - `manual-correction`: a person edited a model's output
   * - `regeneration`: a model replaced earlier model output
   * - `manual-revision`: a person edited their own earlier edit
   * - `reverted-to-generated`: model output replacing a manual edit
   */
  changeKind: 'manual-correction' | 'regeneration' | 'manual-revision' | 'reverted-to-generated';
}

/** Classify a pair of versions by where each one came from. */
export function classifyChange(beforeOrigin: string, afterOrigin: string): VersionComparison['changeKind'] {
  if (beforeOrigin === 'generated' && afterOrigin === 'edited') return 'manual-correction';
  if (beforeOrigin === 'generated' && afterOrigin === 'generated') return 'regeneration';
  if (beforeOrigin === 'edited' && afterOrigin === 'edited') return 'manual-revision';
  return 'reverted-to-generated';
}

/** Build the full side-by-side comparison of two versions. */
export function compareVersions(before: VersionRecord, after: VersionRecord): VersionComparison {
  const strip = (version: VersionRecord) => ({
    versionId: version.versionId, origin: version.origin,
    createdAt: version.createdAt, provenance: version.provenance ?? null,
  });
  return {
    before: strip(before),
    after: strip(after),
    diff: diffTranscripts(before.fullText, after.fullText),
    changeKind: classifyChange(before.origin, after.origin),
  };
}
