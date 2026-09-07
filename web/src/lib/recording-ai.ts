import { apiUrl, authenticatedHeaders } from './runtime'
import type { AiAnswer } from '../../../src/organizer/recording-ai-types'
export type { AiAnswer } from '../../../src/organizer/recording-ai-types'
export type AiConversation = { id: string; question: string; recordingIds: string[]; createdAt: string }
export async function aiRequest<T>(path: string): Promise<T> {
  const response = await fetch(apiUrl(`/ai${path}`), { headers: authenticatedHeaders(), signal: AbortSignal.timeout(15000) })
  const body = await response.json(); if (!response.ok || !body.success) throw new Error(body.error || 'AI workspace unavailable.'); return body.data
}
export async function askRecordings(data: { id: string; conversationId: string; recordingIds: string[]; question: string; consent: true }, onStage: (stage: string) => void, signal: AbortSignal): Promise<AiAnswer> {
  const response = await fetch(apiUrl('/ai/ask'), { method: 'POST', headers: authenticatedHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(data), signal: AbortSignal.any([signal, AbortSignal.timeout(110000)]) })
  if (!response.ok || !response.body) { const payload = await response.json().catch(() => null); throw new Error(payload?.error || 'AI request failed.') }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = '', answer: AiAnswer | undefined
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break; buffer += value
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const lines = buffer.slice(0, boundary).split('\n'); buffer = buffer.slice(boundary + 2)
        const type = lines.find(l => l.startsWith('event:'))?.slice(6).trim()
        const json = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')
        if (!json) continue
        const payload = JSON.parse(json)
        if (type === 'error') throw new Error(payload.error)
        if (type === 'progress') onStage(payload.stage)
        if (type === 'result') answer = payload
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  if (!answer) throw new Error('Connection ended before an answer was received. Check conversation history before retrying.')
  return answer
}
