import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowUp, ChevronDown, Download, FileAudio, Loader2, MessageSquare, Plus, Square } from "@/components/icons"
import { Button } from '@/components/ui/button'
import { api, type TranscriptDocument } from '@/lib/api'
import { aiRequest, askRecordings, type AiAnswer, type AiConversation } from '@/lib/recording-ai'
import { exportDocument } from '@/lib/document-export'
import { formatDuration } from '@/lib/utils'
import './ai.css'

const stages: Record<string, string> = { context: 'Reading selected transcripts', mistral: 'Mistral is answering', citations: 'Checking source citations', saved: 'Saving answer' }
export function AiPage() {
  const [params] = useSearchParams()
  const [recordings, setRecordings] = useState<TranscriptDocument[]>([])
  const [selected, setSelected] = useState<string[]>(() => { const id = params.get('recording'); return id && /^[0-9a-f-]{36}$/i.test(id) ? [id] : [] })
  const [conversationId, setConversationId] = useState<string>(() => crypto.randomUUID())
  const [conversations, setConversations] = useState<AiConversation[]>([])
  const [answers, setAnswers] = useState<AiAnswer[]>([])
  const [question, setQuestion] = useState(() => (params.get('question') || '').slice(0, 4000))
  const [consent, setConsent] = useState(false)
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [stage, setStage] = useState('')
  const [error, setError] = useState('')
  const active = useRef<AbortController | null>(null)
  const end = useRef<HTMLDivElement>(null)
  const request = useRef(0)
  useEffect(() => {
    const controller = new AbortController()
    api.getTranscriptDocuments({ source: '', offset: 0, signal: controller.signal }).then(result => { setRecordings(result.data); setMore(result.pagination.hasMore) })
      .catch(e => { if (!controller.signal.aborted) setError(e.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    aiRequest<AiConversation[]>('/conversations').then(setConversations).catch(() => {})
    return () => { controller.abort(); active.current?.abort() }
  }, [])
  useEffect(() => { if (answers.length || stage) end.current?.scrollIntoView({ block: 'nearest' }) }, [answers, stage])
  const fresh = () => { request.current++; active.current?.abort(); active.current = null; setStage(''); setConversationId(crypto.randomUUID()); setAnswers([]); setError('') }
  const send = async () => {
    if (active.current || !question.trim() || !selected.length || !consent) return
    const controller = new AbortController(); active.current = controller; const ticket = ++request.current
    setError(''); setStage('context')
    try {
      const answer = await askRecordings({ id: crypto.randomUUID(), conversationId, question, recordingIds: selected, consent: true }, setStage, controller.signal)
      if (ticket !== request.current) return
      setAnswers(rows => [...rows, answer]); setQuestion('')
      setConversations(await aiRequest<AiConversation[]>('/conversations'))
    } catch (e) { if (ticket === request.current) setError(controller.signal.aborted ? 'Question cancelled. Completed answers remain in history.' : (e as Error).message) }
    finally { if (ticket === request.current) { active.current = null; setStage('') } }
  }
  const open = async (conversation: AiConversation) => {
    fresh(); setLoading(true); const ticket = ++request.current
    try { const rows = await aiRequest<AiAnswer[]>(`/conversations/${conversation.id}`); if (ticket === request.current) { setConversationId(conversation.id); setAnswers(rows); setSelected(conversation.recordingIds) } }
    catch (e) { setError((e as Error).message) } finally { if (ticket === request.current) setLoading(false) }
  }
  const loadMore = async () => {
    setLoading(true)
    try { const result = await api.getTranscriptDocuments({ source: '', offset: recordings.length }); setRecordings(rows => [...rows, ...result.data]); setMore(result.pagination.hasMore) }
    catch (e) { setError((e as Error).message) } finally { setLoading(false) }
  }
  const exportAnswer = async (answer: AiAnswer) => {
    try { await exportDocument({ filename: `openplod-answer-${answer.id}.md`, mime: 'text/markdown', content: `# ${answer.question}\n\n${answer.answer}\n\n## Sources\n\n${answer.citations.map(c => { const source = answer.sources.find(s => s.id === c.sourceId)!; return `- [${c.sourceId}] ${source.title}${source.start === null ? '' : ` (${formatDuration(source.start)})`}: ${c.quote}` }).join('\n')}\n\nMistral / ${answer.model}` }) }
    catch (e) { setError((e as Error).message) }
  }
  return <div className="ai-page">
    <header className="ai-heading"><div><h1>AI</h1><span>Mistral / Recordings</span></div><Button variant="outline" size="sm" onClick={fresh}><Plus />New conversation</Button></header>
    <div className="ai-workspace">
      <aside className="ai-context" aria-label="Recording context">
        <h2>Context <span>{selected.length}/12</span></h2>
        {answers.length > 0 && <p className="text-xs text-muted-foreground">Context is fixed for this conversation.</p>}
        <div className="ai-source-list">{recordings.map(recording => <label key={recording.recordingId} className="ai-source-choice"><input type="checkbox" checked={selected.includes(recording.recordingId)} disabled={!!stage || answers.length > 0 || (!selected.includes(recording.recordingId) && selected.length >= 12)} onChange={e => { fresh(); setSelected(rows => e.target.checked ? [...rows, recording.recordingId] : rows.filter(id => id !== recording.recordingId)) }} /><FileAudio /><span><strong>{recording.filename || 'Untitled recording'}</strong><small>{recording.wordCount ?? 0} words</small></span></label>)}</div>
        {!loading && !recordings.length && <p className="ai-empty-copy">No transcripts yet. <Link to="/">Open recordings</Link></p>}
        {loading && <Loader2 className="size-4 animate-spin" aria-label="Loading transcripts" />}
        {more && <Button variant="ghost" size="sm" disabled={loading} onClick={() => void loadMore()}>{loading ? <Loader2 className="animate-spin" /> : <ChevronDown />}Load more recordings</Button>}
        <details className="ai-history"><summary>Recent conversations</summary>
        {conversations.map(row => <button className="ai-history-row" key={row.id} disabled={!!stage} onClick={() => void open(row)}><MessageSquare /><span>{row.question}</span></button>)}
        {!conversations.length && <p className="ai-empty-copy">No saved conversations.</p>}</details>
      </aside>
      <section className="ai-conversation" aria-label="Conversation">
        <div className="ai-messages">
          {!answers.length && !stage && <div className="ai-empty"><MessageSquare /><h2>Ask your recordings</h2></div>}
          {answers.map(answer => <article key={answer.id} className="ai-answer">
            <h2>{answer.question}</h2>
            <div className="markdown-document"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: () => null, a: ({ children }) => <span>{children}</span> }}>{answer.answer}</ReactMarkdown></div>
            {answer.citations.length > 0 && <details className="ai-citations"><summary>{answer.citations.length} source references</summary>{answer.citations.map((citation, i) => { const source = answer.sources.find(s => s.id === citation.sourceId)!; return <div key={`${source.id}-${i}`}><Link to={`/recording/${source.recordingId}?${new URLSearchParams({ ...(source.start === null ? {} : { t: String(source.start) }), ...(source.versionId ? { version: source.versionId } : {}) })}`}><FileAudio />[{source.id}] {source.title}{source.start === null ? '' : ` / ${formatDuration(source.start)}`}</Link><blockquote>{citation.quote}</blockquote><small>{source.origin} transcript</small></div> })}</details>}
            <footer><span>{answer.model}</span><details><summary>Activity</summary>{answer.trace.map(step => <p key={step.stage}>{stages[step.stage] || step.stage}</p>)}</details><Button size="icon" variant="ghost" title="Export answer as Markdown" aria-label="Export answer as Markdown" onClick={() => void exportAnswer(answer)}><Download /></Button></footer>
          </article>)}
          {stage && <p className="ai-progress" role="status"><Loader2 className="animate-spin" />{stages[stage] || stage}</p>}
          <div ref={end} />
        </div>
        <form className="ai-composer" onSubmit={e => { e.preventDefault(); void send() }}>
          {error && <p className="device-error" role="alert">{error}</p>}
          <label className="ai-consent"><input type="checkbox" checked={consent} disabled={!!stage} onChange={e => setConsent(e.target.checked)} /><span>Allow sending selected transcript text to Mistral.</span></label>
          <div className="ai-input"><textarea aria-label="Question about selected recordings" placeholder="Ask a question..." rows={3} maxLength={4000} value={question} disabled={!!stage} onChange={e => setQuestion(e.target.value)} />{stage ? <Button type="button" size="icon" variant="outline" aria-label="Cancel question" title="Cancel question" onClick={() => active.current?.abort()}><Square /></Button> : <Button type="submit" size="icon" disabled={!consent || !selected.length || !question.trim() || loading} aria-label="Send question" title="Send question"><ArrowUp /></Button>}</div>
        </form>
      </section>
    </div>
  </div>
}
