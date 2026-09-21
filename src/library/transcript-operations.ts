/**
 * Transcript editing operations (roadmap TS-02).
 *
 * Speaker rename/merge, segment split/merge and find/replace, expressed as
 * pure functions over a segment list so they can be tested exhaustively and
 * reused by the API, the editor and batch work alike.
 *
 * Two invariants hold across every operation in this module:
 *
 *  1. **Source timing is never invented.** An operation may narrow or join
 *     existing spans, but it never fabricates a timestamp for a segment that
 *     had none, and it never shifts a span to make an edit fit.
 *  2. **Text is never silently dropped.** Splitting preserves the whole
 *     original text across the two halves; merging concatenates in order.
 *
 * `fullText` is derived from the segments so the stored document and the
 * segment list cannot drift apart after an edit.
 */

/** A transcript segment as stored in the `transcripts.segments` JSON column. */
export interface EditableSegment {
  start: number;
  end: number;
  text: string;
  /** Diarization label: an index, a name, or absent. */
  speaker?: number | string | null;
  confidence?: number | null;
}

export class TranscriptOperationError extends Error {}

const fail = (message: string): never => {
  throw new TranscriptOperationError(message);
};

/** Segments arrive from a JSON column, so nothing about their shape is assumed. */
export function parseSegments(value: unknown): EditableSegment[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) fail('Stored transcript segments are not a list.');
  return (value as unknown[]).map((entry, index) => {
    if (!entry || typeof entry !== 'object') return fail(`Segment ${index} is not an object.`);
    const record = entry as Record<string, unknown>;
    if (typeof record.text !== 'string') return fail(`Segment ${index} has no text.`);
    const speaker = typeof record.speaker === 'number' || typeof record.speaker === 'string' ? record.speaker : null;
    return {
      start: typeof record.start === 'number' ? record.start : Number.NaN,
      end: typeof record.end === 'number' ? record.end : Number.NaN,
      text: record.text,
      speaker,
      confidence: typeof record.confidence === 'number' ? record.confidence : null,
    };
  });
}

/**
 * Rebuild the flat document from segments.
 *
 * The editor and the stored `fullText` must agree after every operation, so
 * this is the single definition of how segments become a document.
 */
export const segmentsToText = (segments: EditableSegment[]): string =>
  segments.map(segment => segment.text.trim()).filter(Boolean).join('\n');

/** Distinct speaker labels, in first-appearance order. */
export function speakerLabels(segments: EditableSegment[]): (number | string)[] {
  const seen = new Set<string>();
  const labels: (number | string)[] = [];
  for (const segment of segments) {
    if (segment.speaker === null || segment.speaker === undefined) continue;
    const key = `${typeof segment.speaker}:${segment.speaker}`;
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(segment.speaker);
  }
  return labels;
}

const sameSpeaker = (a: EditableSegment['speaker'], b: number | string) =>
  a !== null && a !== undefined && String(a) === String(b);

/**
 * Rename one speaker. Renaming onto an existing label merges the two, which is
 * the same operation a user means by "these are the same person".
 */
export function renameSpeaker(
  segments: EditableSegment[],
  from: number | string,
  to: number | string,
): EditableSegment[] {
  if (typeof to === 'string' && to.trim() === '') fail('A speaker name cannot be blank.');
  if (!segments.some(segment => sameSpeaker(segment.speaker, from))) fail('That speaker does not appear in this transcript.');
  const target = typeof to === 'string' ? to.trim() : to;
  return segments.map(segment => (sameSpeaker(segment.speaker, from) ? { ...segment, speaker: target } : segment));
}

/** Merge several speakers into one label. */
export function mergeSpeakers(
  segments: EditableSegment[],
  sources: (number | string)[],
  target: number | string,
): EditableSegment[] {
  if (sources.length === 0) fail('Select at least one speaker to merge.');
  const destination = typeof target === 'string' ? target.trim() : target;
  if (typeof destination === 'string' && destination === '') fail('A speaker name cannot be blank.');
  const present = sources.filter(source => segments.some(segment => sameSpeaker(segment.speaker, source)));
  if (present.length === 0) fail('None of those speakers appear in this transcript.');
  return segments.map(segment =>
    present.some(source => sameSpeaker(segment.speaker, source)) ? { ...segment, speaker: destination } : segment);
}

/**
 * Split one segment in two at a character offset within its text.
 *
 * The split point in *time* is interpolated across the segment's own span in
 * proportion to the text offset. That is an estimate, so it is only done when
 * the segment has a real span to divide; a segment without usable timing
 * yields two halves that inherit the original's (unusable) values rather than
 * inventing a boundary.
 */
export function splitSegment(segments: EditableSegment[], index: number, offset: number): EditableSegment[] {
  const segment = segments[index];
  if (!segment) fail('That segment does not exist.');
  const text = segment!.text;
  if (!Number.isInteger(offset) || offset <= 0 || offset >= text.length) {
    fail('Split position must fall inside the segment text.');
  }
  const head = text.slice(0, offset);
  const tail = text.slice(offset);
  if (!head.trim() || !tail.trim()) fail('Both halves of a split must contain text.');

  const timed = Number.isFinite(segment!.start) && Number.isFinite(segment!.end) && segment!.end > segment!.start;
  let boundary = segment!.end;
  if (timed) {
    // Proportional to characters: an estimate, and only within the real span.
    const ratio = offset / text.length;
    boundary = segment!.start + (segment!.end - segment!.start) * ratio;
  }
  const first: EditableSegment = { ...segment!, text: head, end: timed ? boundary : segment!.end };
  const second: EditableSegment = { ...segment!, text: tail, start: timed ? boundary : segment!.start };
  return [...segments.slice(0, index), first, second, ...segments.slice(index + 1)];
}

/**
 * Merge a run of adjacent segments into one.
 *
 * The merged span runs from the first segment's start to the last one's end,
 * both of which are real observed values.
 */
export function mergeSegments(segments: EditableSegment[], start: number, count: number): EditableSegment[] {
  if (!Number.isInteger(start) || start < 0 || start >= segments.length) fail('That segment does not exist.');
  if (!Number.isInteger(count) || count < 2) fail('Merging needs at least two segments.');
  if (start + count > segments.length) fail('That merge runs past the end of the transcript.');
  const run = segments.slice(start, start + count);
  const speakers = new Set(run.map(segment => (segment.speaker ?? '')).map(String));
  const merged: EditableSegment = {
    ...run[0]!,
    // A merged run spans from the first real start to the last real end.
    start: run[0]!.start,
    end: run[run.length - 1]!.end,
    text: run.map(segment => segment.text.trim()).filter(Boolean).join(' '),
    // Merging across speakers cannot keep a single truthful label.
    speaker: speakers.size === 1 ? run[0]!.speaker ?? null : null,
    confidence: null,
  };
  return [...segments.slice(0, start), merged, ...segments.slice(start + count)];
}

export interface ReplaceOptions {
  matchCase?: boolean;
  wholeWord?: boolean;
  /** Restrict the replacement to one speaker's segments. */
  speaker?: number | string | null;
}

export interface ReplaceResult {
  segments: EditableSegment[];
  /** Number of individual occurrences replaced. */
  replacements: number;
  /** Number of segments that changed. */
  segmentsChanged: number;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Find and replace across segment text.
 *
 * The search term is escaped, never treated as a pattern: a user typing `(a)`
 * means those three characters.
 */
export function findReplace(
  segments: EditableSegment[],
  search: string,
  replacement: string,
  options: ReplaceOptions = {},
): ReplaceResult {
  if (search === '') fail('Enter the text to find.');
  const flags = options.matchCase ? 'g' : 'gi';
  const body = escapeRegExp(search);
  // \b is meaningless next to a non-word character, so it is only applied
  // where the term actually begins or ends with one.
  const prefix = options.wholeWord && /^\w/.test(search) ? '\\b' : '';
  const suffix = options.wholeWord && /\w$/.test(search) ? '\\b' : '';
  const pattern = new RegExp(`${prefix}${body}${suffix}`, flags);

  let replacements = 0;
  let segmentsChanged = 0;
  const next = segments.map(segment => {
    if (options.speaker !== undefined && options.speaker !== null && !sameSpeaker(segment.speaker, options.speaker)) {
      return segment;
    }
    const matches = segment.text.match(pattern);
    if (!matches) return segment;
    replacements += matches.length;
    segmentsChanged += 1;
    return { ...segment, text: segment.text.replace(pattern, replacement) };
  });
  return { segments: next, replacements, segmentsChanged };
}

/** Count occurrences without changing anything, for a find-only preview. */
export function countMatches(segments: EditableSegment[], search: string, options: ReplaceOptions = {}): number {
  return findReplace(segments, search, search, options).replacements;
}

/** Every operation the transcript editor can apply, as a serializable request. */
export type TranscriptOperation =
  | { op: 'rename-speaker'; from: number | string; to: number | string }
  | { op: 'merge-speakers'; sources: (number | string)[]; target: number | string }
  | { op: 'split-segment'; index: number; offset: number }
  | { op: 'merge-segments'; start: number; count: number }
  | { op: 'replace'; search: string; replacement: string; matchCase?: boolean; wholeWord?: boolean; speaker?: number | string | null };

export interface OperationOutcome {
  segments: EditableSegment[];
  fullText: string;
  /** Human-readable description of what changed, for the editor's history. */
  summary: string;
}

/**
 * Apply one operation and return the new segments plus the rebuilt document.
 *
 * Undo/redo is the caller's stack of these outcomes: every operation is a pure
 * transformation, so stepping back is holding the previous value rather than
 * computing an inverse.
 */
export function applyOperation(segments: EditableSegment[], operation: TranscriptOperation): OperationOutcome {
  let next: EditableSegment[];
  let summary: string;
  switch (operation.op) {
    case 'rename-speaker':
      next = renameSpeaker(segments, operation.from, operation.to);
      summary = `Renamed speaker ${operation.from} to ${operation.to}`;
      break;
    case 'merge-speakers':
      next = mergeSpeakers(segments, operation.sources, operation.target);
      summary = `Merged ${operation.sources.length} speakers into ${operation.target}`;
      break;
    case 'split-segment':
      next = splitSegment(segments, operation.index, operation.offset);
      summary = `Split segment ${operation.index + 1}`;
      break;
    case 'merge-segments':
      next = mergeSegments(segments, operation.start, operation.count);
      summary = `Merged ${operation.count} segments from ${operation.start + 1}`;
      break;
    case 'replace': {
      const result = findReplace(segments, operation.search, operation.replacement, {
        matchCase: operation.matchCase, wholeWord: operation.wholeWord, speaker: operation.speaker,
      });
      next = result.segments;
      summary = `Replaced ${result.replacements} occurrence${result.replacements === 1 ? '' : 's'} of "${operation.search}"`;
      break;
    }
    default:
      return fail('Unsupported transcript operation.');
  }
  return { segments: next, fullText: segmentsToText(next), summary };
}
