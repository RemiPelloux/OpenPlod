import { describe, expect, test } from 'bun:test'
import {
  activeSegmentIndex, activeWordIndex, followedSegmentIndex, hasWordTiming, type SyncSegment,
} from './transcript-sync'

const segments: SyncSegment[] = [
  { id: 'a', startTime: 0, endTime: 2 },
  { id: 'b', startTime: 2, endTime: 5 },
  // A deliberate gap between 5 and 6: silence belongs to no segment.
  { id: 'c', startTime: 6, endTime: 9 },
]

const worded: SyncSegment[] = [
  {
    id: 'w', startTime: 0, endTime: 3,
    words: [
      { start: 0, end: 0.5, text: 'Hello' },
      { start: 0.5, end: 1.2, text: 'there' },
      { start: 2.0, end: 3.0, text: 'friend' },
    ],
  },
]

describe('segment following', () => {
  test('finds the segment covering a time', () => {
    expect(activeSegmentIndex(segments, 0)).toBe(0)
    expect(activeSegmentIndex(segments, 1.9)).toBe(0)
    expect(activeSegmentIndex(segments, 2)).toBe(1)
    expect(activeSegmentIndex(segments, 8.9)).toBe(2)
  })

  test('treats a segment end as exclusive so boundaries do not double-match', () => {
    expect(activeSegmentIndex(segments, 2)).toBe(1)
    expect(activeSegmentIndex(segments, 5)).toBe(-1)
  })

  test('returns nothing during a gap rather than the nearest segment', () => {
    // Silence is not part of a segment; sticking the highlight there is a lie.
    expect(activeSegmentIndex(segments, 5.5)).toBe(-1)
  })

  test('returns nothing before the first and after the last segment', () => {
    expect(activeSegmentIndex(segments, -1)).toBe(-1)
    expect(activeSegmentIndex(segments, 99)).toBe(-1)
  })

  test('handles an empty list and a non-finite time', () => {
    expect(activeSegmentIndex([], 1)).toBe(-1)
    expect(activeSegmentIndex(segments, Number.NaN)).toBe(-1)
  })

  test('refuses to follow segments with unusable timings', () => {
    const untimed: SyncSegment[] = [{ id: 'x', startTime: Number.NaN, endTime: Number.NaN }]
    expect(activeSegmentIndex(untimed, 1)).toBe(-1)
  })

  test('agrees with a linear scan across the whole timeline', () => {
    for (let time = 0; time < 10; time += 0.25) {
      const expected = segments.findIndex(s => time >= s.startTime && time < s.endTime)
      expect(activeSegmentIndex(segments, time)).toBe(expected)
    }
  })
})

describe('word highlighting', () => {
  test('detects real word timings', () => {
    expect(hasWordTiming(worded)).toBe(true)
    expect(hasWordTiming(segments)).toBe(false)
  })

  test('does not count empty or zero-length word timings as real', () => {
    expect(hasWordTiming([{ id: 'z', startTime: 0, endTime: 1, words: [] }])).toBe(false)
    expect(hasWordTiming([{ id: 'z', startTime: 0, endTime: 1, words: [{ start: 1, end: 1, text: 'x' }] }])).toBe(false)
    expect(hasWordTiming([{ id: 'z', startTime: 0, endTime: 1, words: null }])).toBe(false)
  })

  test('finds the word covering a time', () => {
    const words = worded[0]!.words!
    expect(activeWordIndex(words, 0)).toBe(0)
    expect(activeWordIndex(words, 0.6)).toBe(1)
    expect(activeWordIndex(words, 2.5)).toBe(2)
  })

  test('returns nothing between words and outside the range', () => {
    const words = worded[0]!.words!
    expect(activeWordIndex(words, 1.5)).toBe(-1)
    expect(activeWordIndex(words, 5)).toBe(-1)
  })

  test('returns nothing when a segment has no word timing at all', () => {
    // -1 here means "no word timing", which the caller renders as a
    // segment-level highlight instead of inventing a word position.
    expect(activeWordIndex(undefined, 1)).toBe(-1)
    expect(activeWordIndex(null, 1)).toBe(-1)
    expect(activeWordIndex([], 1)).toBe(-1)
  })
})

describe('scroll anchor', () => {
  test('follows the active segment while one is playing', () => {
    expect(followedSegmentIndex(segments, 3, -1)).toBe(1)
  })

  test('holds the previous segment through a gap so the view does not jump', () => {
    expect(followedSegmentIndex(segments, 5.5, 1)).toBe(1)
  })

  test('releases the anchor when seeking back before it', () => {
    expect(followedSegmentIndex(segments, 0.5, 2)).toBe(0)
    expect(followedSegmentIndex(segments, -1, 2)).toBe(-1)
  })

  test('ignores an out-of-range previous anchor', () => {
    expect(followedSegmentIndex(segments, 5.5, 99)).toBe(-1)
    expect(followedSegmentIndex(segments, 5.5, -1)).toBe(-1)
  })
})
