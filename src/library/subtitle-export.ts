/**
 * Subtitle export (roadmap TS-09).
 *
 * SRT and WebVTT are timing formats: a cue without a real start and end is not
 * a subtitle. Transcription providers vary in what they return — some give word
 * timings, some segment timings, some none at all — and several return
 * placeholder zeros rather than admitting they have no timing.
 *
 * This module therefore refuses to invent, interpolate or space out timings. It
 * either exports the timings a provider genuinely produced, or reports exactly
 * why it cannot, so the UI can disable the option honestly instead of shipping
 * a file whose timings are fiction.
 */

/** One stored transcript segment. Only `start`/`end`/`text` matter here. */
export interface SubtitleSegment {
  start: number;
  end: number;
  text: string;
  speaker?: number | null;
}

/** Why a transcript cannot be exported as subtitles. */
export type SubtitleRefusal =
  | 'no-segments'
  | 'no-timing'
  | 'invalid-timing'
  | 'empty-text';

export interface SubtitleReadiness {
  exportable: boolean;
  /** Cues that would be written. Empty when `exportable` is false. */
  cues: SubtitleSegment[];
  reason: SubtitleRefusal | null;
  detail: string;
}

const REFUSAL_DETAIL: Record<SubtitleRefusal, string> = {
  'no-segments': 'This transcript has no segments, so it has no timings to export.',
  'no-timing': 'The transcription provider returned no timings for this recording. Subtitles need real start and end times.',
  'invalid-timing': 'The stored segment timings are not usable as subtitles (negative, non-finite, or zero-length cues).',
  'empty-text': 'The stored segments contain no text to caption.',
};

/** Segments arrive from JSON columns and provider payloads, so nothing is assumed. */
function readSegments(value: unknown): SubtitleSegment[] | null {
  if (!Array.isArray(value)) return null;
  const segments: SubtitleSegment[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const text = typeof record.text === 'string' ? record.text : '';
    const speaker = typeof record.speaker === 'number' && Number.isInteger(record.speaker) ? record.speaker : null;
    segments.push({
      start: typeof record.start === 'number' ? record.start : Number.NaN,
      end: typeof record.end === 'number' ? record.end : Number.NaN,
      text,
      speaker,
    });
  }
  return segments;
}

/**
 * Decide whether these segments can honestly become subtitles.
 *
 * A provider that returns all-zero timings is treated as having no timing at
 * all, because a file of zero-length cues at 00:00:00 is worse than no file.
 */
export function subtitleReadiness(rawSegments: unknown): SubtitleReadiness {
  const refuse = (reason: SubtitleRefusal): SubtitleReadiness =>
    ({ exportable: false, cues: [], reason, detail: REFUSAL_DETAIL[reason] });

  const segments = readSegments(rawSegments);
  if (segments === null || segments.length === 0) return refuse('no-segments');

  const withText = segments.filter(segment => segment.text.trim().length > 0);
  if (withText.length === 0) return refuse('empty-text');

  // Distinguish "provider gave us nothing" from "provider gave us nonsense".
  const timed = withText.filter(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end));
  if (timed.length === 0) return refuse('no-timing');

  const usable = timed.filter(segment => segment.start >= 0 && segment.end > segment.start);
  if (usable.length === 0) {
    // All-zero or collapsed timings are a provider that reported no timing.
    const allCollapsed = timed.every(segment => segment.start === segment.end);
    return refuse(allCollapsed ? 'no-timing' : 'invalid-timing');
  }

  // Ordering is presentation, not invention: the same cues, sorted.
  const cues = [...usable].sort((a, b) => a.start - b.start || a.end - b.end);
  return { exportable: true, cues, reason: null, detail: `${cues.length} timed cue${cues.length === 1 ? '' : 's'}.` };
}

/** `HH:MM:SS` plus a fractional part, with `,` for SRT and `.` for WebVTT. */
function stamp(seconds: number, separator: ',' | '.'): string {
  const total = Math.max(0, Math.round(seconds * 1000));
  const ms = total % 1000;
  const wholeSeconds = Math.floor(total / 1000);
  const hh = Math.floor(wholeSeconds / 3600);
  const mm = Math.floor((wholeSeconds % 3600) / 60);
  const ss = wholeSeconds % 60;
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}${separator}${pad(ms, 3)}`;
}

/** Cue text: CR stripped, blank lines dropped so a cue never terminates early. */
function cueText(segment: SubtitleSegment, speakerLabels: boolean): string {
  const body = segment.text.replace(/\r/g, '').split('\n').map(line => line.trim()).filter(Boolean).join('\n');
  return speakerLabels && typeof segment.speaker === 'number' ? `Speaker ${segment.speaker + 1}: ${body}` : body;
}

export interface SubtitleOptions {
  /** Prefix each cue with its speaker, when the transcript has diarization. */
  speakerLabels?: boolean;
}

/** Render SubRip (`.srt`). Throws when the transcript has no usable timing. */
export function toSrt(rawSegments: unknown, options: SubtitleOptions = {}): string {
  const readiness = subtitleReadiness(rawSegments);
  if (!readiness.exportable) throw new Error(readiness.detail);
  return readiness.cues
    .map((cue, index) =>
      `${index + 1}\n${stamp(cue.start, ',')} --> ${stamp(cue.end, ',')}\n${cueText(cue, options.speakerLabels ?? false)}\n`)
    .join('\n');
}

/** Render WebVTT (`.vtt`). Throws when the transcript has no usable timing. */
export function toVtt(rawSegments: unknown, options: SubtitleOptions = {}): string {
  const readiness = subtitleReadiness(rawSegments);
  if (!readiness.exportable) throw new Error(readiness.detail);
  const cues = readiness.cues
    .map((cue, index) =>
      `${index + 1}\n${stamp(cue.start, '.')} --> ${stamp(cue.end, '.')}\n${cueText(cue, options.speakerLabels ?? false)}\n`)
    .join('\n');
  return `WEBVTT\n\n${cues}`;
}

export const SUBTITLE_FORMATS = ['srt', 'vtt'] as const;
export type SubtitleFormat = (typeof SUBTITLE_FORMATS)[number];
export const isSubtitleFormat = (value: string): value is SubtitleFormat =>
  (SUBTITLE_FORMATS as readonly string[]).includes(value);

export const SUBTITLE_MIME: Record<SubtitleFormat, string> = {
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
};

/** Render whichever subtitle format was asked for. */
export function renderSubtitles(format: SubtitleFormat, rawSegments: unknown, options: SubtitleOptions = {}): string {
  return format === 'srt' ? toSrt(rawSegments, options) : toVtt(rawSegments, options);
}
