/**
 * Playback/transcript synchronisation (roadmap TS-01).
 *
 * Two levels of following, and the difference between them matters:
 *
 *  - **Segment following** works whenever segments carry timings, which is the
 *    normal case.
 *  - **Word highlighting** only works when a provider genuinely returned
 *    per-word timings. Most do not. Rather than interpolating a word position
 *    from a segment's span — which looks precise and is invented — the caller
 *    is told no word timing exists and falls back to the segment.
 *
 * All lookups are binary searches so following stays cheap on a long
 * transcript at the browser's timeupdate rate.
 */

export interface SyncWord {
  start: number
  end: number
  text: string
}

export interface SyncSegment {
  id: string
  startTime: number
  endTime: number
  /** Present only when the provider supplied real per-word timings. */
  words?: SyncWord[] | null
}

const usableSpan = (start: number, end: number) =>
  Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start

/** True when at least one segment carries real per-word timings. */
export function hasWordTiming(segments: readonly SyncSegment[]): boolean {
  return segments.some(segment =>
    Array.isArray(segment.words) && segment.words.some(word => usableSpan(word.start, word.end) && word.end > word.start))
}

/**
 * Index of the segment covering `time`, or -1.
 *
 * Segments are assumed sorted by start, which is how they are stored. A gap
 * between segments yields -1 rather than the nearest neighbour: silence is not
 * part of a segment, and pretending otherwise makes the highlight stick.
 */
export function activeSegmentIndex(segments: readonly SyncSegment[], time: number): number {
  if (!Number.isFinite(time) || segments.length === 0) return -1
  let low = 0
  let high = segments.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    const segment = segments[mid]!
    if (!usableSpan(segment.startTime, segment.endTime)) return -1
    if (time < segment.startTime) high = mid - 1
    else if (time >= segment.endTime) low = mid + 1
    else { found = mid; break }
  }
  return found
}

/**
 * Index of the word covering `time` within a segment, or -1.
 *
 * Returns -1 for a segment with no word timings, so a caller can distinguish
 * "between words" from "this transcript has no word timing at all".
 */
export function activeWordIndex(words: readonly SyncWord[] | null | undefined, time: number): number {
  if (!words || words.length === 0 || !Number.isFinite(time)) return -1
  let low = 0
  let high = words.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const word = words[mid]!
    if (!usableSpan(word.start, word.end)) return -1
    if (time < word.start) high = mid - 1
    else if (time >= word.end) low = mid + 1
    else return mid
  }
  return -1
}

/**
 * The segment to keep in view.
 *
 * During a gap the previous segment is held rather than clearing the view, so
 * the transcript does not jump back to the top through every pause. The
 * *highlight* still clears; only the scroll anchor persists.
 */
export function followedSegmentIndex(segments: readonly SyncSegment[], time: number, previous: number): number {
  const active = activeSegmentIndex(segments, time)
  if (active !== -1) return active
  if (previous < 0 || previous >= segments.length) return -1
  // Hold the previous anchor only while playback is still past its start;
  // seeking backwards must not leave the view stranded further down.
  const held = segments[previous]!
  return Number.isFinite(time) && time >= held.startTime ? previous : -1
}
