import { sqlite } from '../db/client';

interface TranscriptSearchRow {
  recordingId: string;
  recordingTitle: string | null;
  recordedAt: string;
  fullText: string;
  segments: string | null;
}

export interface TranscriptSearchSegment {
  id: string;
  speaker: string;
  text: string;
  startTime: number;
  endTime: number;
}

export interface TranscriptSearchResult {
  recordingId: string;
  recordingTitle: string;
  recordedAt: string;
  segments: TranscriptSearchSegment[];
}

export function toFtsQuery(input: string): string {
  const tokens = input.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu)?.slice(0, 8) ?? [];
  return tokens.map(token => `"${token.replaceAll('"', '""')}"*`).join(' AND ');
}

function parseSegments(value: string | null): Array<{ speaker?: number; text?: string; start?: number; end?: number }> {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function searchTranscripts(input: string, limit = 50): TranscriptSearchResult[] {
  const ftsQuery = toFtsQuery(input);
  if (!ftsQuery) return [];

  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const rows = sqlite.query<TranscriptSearchRow, [string, number]>(`
    SELECT
      r.id AS recordingId,
      r.original_filename AS recordingTitle,
      COALESCE(r.recorded_at, r.uploaded_at) AS recordedAt,
      t.full_text AS fullText,
      t.segments AS segments
    FROM transcripts_fts
    JOIN transcripts t ON t.rowid = transcripts_fts.rowid
    JOIN recordings r ON r.id = t.recording_id
    WHERE transcripts_fts MATCH ?
    ORDER BY bm25(transcripts_fts), r.recorded_at DESC
    LIMIT ?
  `).all(ftsQuery, safeLimit);

  const normalizedQuery = input.toLocaleLowerCase();
  return rows.map(row => {
    const matchingSegments = parseSegments(row.segments)
      .filter(segment => (segment.text ?? '').toLocaleLowerCase().includes(normalizedQuery))
      .slice(0, 5)
      .map((segment, index) => ({
        id: `s${index}`,
        speaker: segment.speaker !== undefined ? `Speaker ${segment.speaker}` : 'Speaker',
        text: segment.text ?? '',
        startTime: segment.start ?? 0,
        endTime: segment.end ?? 0,
      }));

    if (matchingSegments.length === 0) {
      const matchIndex = row.fullText.toLocaleLowerCase().indexOf(normalizedQuery);
      const excerptStart = Math.max(0, matchIndex - 80);
      matchingSegments.push({
        id: 's0',
        speaker: 'Speaker',
        text: row.fullText.slice(excerptStart, excerptStart + 240),
        startTime: 0,
        endTime: 0,
      });
    }

    return {
      recordingId: row.recordingId,
      recordingTitle: row.recordingTitle?.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ') || 'Untitled',
      recordedAt: row.recordedAt,
      segments: matchingSegments,
    };
  });
}
