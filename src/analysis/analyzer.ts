/**
 * Recording analyzer — generates summaries and extracts tasks from transcripts.
 * Extracted from hub/src/services/recording-analysis-service.ts.
 * Uses fetch to call OpenAI-compatible API (configurable).
 */

import { db } from '../db/client';
import { transcripts, recordings, analyses } from '../db/schema';
import { eq } from 'drizzle-orm';

export interface RecordingSummary {
  overview: string;
  keyPoints: string[];
  participants?: string[];
  topics?: string[];
}

export interface ExtractedTask {
  title: string;
  description?: string;
  assignee?: string;
  priority?: 'low' | 'medium' | 'high';
  dueDate?: string;
  context: string;
}

export interface AnalysisResult {
  summary: RecordingSummary;
  extractedTasks: ExtractedTask[];
  analyzedAt: string;
}

async function chatCompletion(messages: Array<{ role: string; content: string }>, opts?: { temperature?: number; maxTokens?: number }): Promise<string> {
  const baseUrl = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
  const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';

  if (!apiKey) throw new Error('No LLM API key configured. Set LLM_API_KEY or OPENAI_API_KEY');

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts?.temperature ?? 0.3,
      max_tokens: opts?.maxTokens ?? 2000,
    }),
  });

  if (!resp.ok) throw new Error(`LLM API error: ${resp.status} ${await resp.text()}`);
  const data = await resp.json() as any;
  return data.choices?.[0]?.message?.content || '';
}

export class RecordingAnalyzer {
  async analyze(recordingId: string, force = false): Promise<AnalysisResult> {
    const [transcript] = await db.select().from(transcripts).where(eq(transcripts.recordingId, recordingId)).limit(1);
    if (!transcript) throw new Error('No transcript found');

    // Return cached
    if (!force && transcript.summary && transcript.analyzedAt) {
      return {
        summary: transcript.summary as unknown as RecordingSummary,
        extractedTasks: (transcript.extractedTasks as unknown as ExtractedTask[]) || [],
        analyzedAt: transcript.analyzedAt,
      };
    }

    const [recording] = await db.select().from(recordings).where(eq(recordings.id, recordingId)).limit(1);
    const fullText = transcript.fullText;
    if (!fullText || fullText.length < 50) throw new Error('Transcript too short');

    const truncated = fullText.length > 100000 ? fullText.slice(0, 100000) + '\n\n[Truncated...]' : fullText;

    const [summary, tasks] = await Promise.all([
      this.generateSummary(truncated, recording?.originalFilename || 'Recording'),
      this.extractTasks(truncated),
    ]);

    const analyzedAt = new Date().toISOString();

    // Save to transcript
    await db.update(transcripts).set({
      summary: summary as any,
      extractedTasks: tasks as any,
      analyzedAt,
    }).where(eq(transcripts.id, transcript.id));

    // Also save to analyses table
    await db.insert(analyses).values({
      recordingId,
      summary: summary as any,
      extractedTasks: tasks as any,
      analyzedAt,
    });

    return { summary, extractedTasks: tasks, analyzedAt };
  }

  private async generateSummary(text: string, title: string): Promise<RecordingSummary> {
    const content = await chatCompletion([
      {
        role: 'system',
        content: `Summarize this transcript. Respond in JSON: {"overview":"...","keyPoints":["..."],"participants":["..."],"topics":["..."]}`,
      },
      { role: 'user', content: `Transcript "${title}":\n\n${text}` },
    ], { temperature: 0.3, maxTokens: 2000 });

    try {
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('No JSON');
      return JSON.parse(match[0]);
    } catch {
      return { overview: content, keyPoints: [] };
    }
  }

  private async extractTasks(text: string): Promise<ExtractedTask[]> {
    const content = await chatCompletion([
      {
        role: 'system',
        content: `Extract action items from this transcript. Return JSON array: [{"title":"...","description":"...","assignee":"...","priority":"low|medium|high","context":"exact quote"}]. Return [] if none.`,
      },
      { role: 'user', content: text },
    ], { temperature: 0.2, maxTokens: 3000 });

    try {
      const match = content.match(/\[[\s\S]*\]/);
      if (!match) return [];
      return (JSON.parse(match[0]) as ExtractedTask[]).filter(t => t.title).slice(0, 20);
    } catch {
      return [];
    }
  }
}

export const recordingAnalyzer = new RecordingAnalyzer();
