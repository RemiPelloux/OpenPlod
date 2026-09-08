import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowUp, ChevronDown, Download, FileAudio, Loader2, MessageSquare, Plus, Square, ListTree, History, Copy, RefreshCw, X, FileText, ListChecks, Check } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { api, type TranscriptDocument } from '@/lib/api'
import { aiRequest, askRecordings, type AiAnswer, type AiConversation } from '@/lib/recording-ai'
import { exportDocument } from '@/lib/document-export'
import { formatDuration } from '@/lib/utils'
import './ai.css'
import { aiSettingsApi } from '@/lib/ai-settings'

const stages: Record<string, string> = { context: 'Reading selected transcripts', mistral: 'Mistral is answering', openai: 'OpenAI is answering', anthropic: 'Anthropic is answering', ollama: 'Ollama is answering locally', citations: 'Checking source citations', saved: 'Saving answer' }
const prompts = [
  { label: 'Summary', prompt: 'Summarize the selected recordings.', icon: FileText },
  { label: 'Action items', prompt: 'Extract action items and owners from the selected recordings.', icon: ListChecks },
  { label: 'Decisions', prompt: 'What decisions were made in these recordings?', icon: Check },
]
export function AiPage() {
  const [params] = useSearchParams()
  const [recordings, setRecordings] = useState<TranscriptDocument[]>([])
  const [selected, setSelected] = useState<string[]>(() => { const id = params.get('recording'); return id && /^[0-9a-f-]{36}$/i.test(id) ? [id] : [] })
  const [conversationId, setConversationId] = useState<string>(() => crypto.randomUUID())
  const [conversations, setConversations] = useState<AiConversation[]>([])
  const [answers, setAnswers] = useState<AiAnswer[]>([])
  const [question, setQuestion] = useState(() => (params.get('question') || '').slice(0, 4000))
  const [consent, setConsent] = useState(false)
  const [provider, setProvider] = useState('')
  useEffect(() => { let active = true; aiSettingsApi.get().then(value => { if (active) setProvider(value.chatProvider) }).catch(() => {}); return () => { active = false } }, [])
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [stage, setStage] = useState('')
  const [error, setError] = useState('')
  const [panel, setPanel] = useState('sources')
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 767)
  const [historyError, setHistoryError] = useState('')
  const [historyRefresh, setHistoryRefresh] = useState(0)
  const [opening, setOpening] = useState(false)
  const [copied, setCopied] = useState('')
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const active = useRef<AbortController | null>(null)
  const end = useRef<HTMLDivElement>(null)
  const request = useRef(0)
  const pagination = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    api.getTranscriptDocuments({ source: '', offset: 0, signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setRecordings(result.data); setMore(result.pagination.hasMore) } })
      .catch(e => { if (!controller.signal.aborted) setError(e.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    // Invalidate async conversation work on unmount; this ref is a counter, not a DOM node.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { controller.abort(); request.current++; active.current?.abort(); pagination.current?.abort(); if (copyTimer.current) clearTimeout(copyTimer.current) }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setHistoryError('')
    aiRequest<AiConversation[]>('/conversations', controller.signal).then(rows => { if (!controller.signal.aborted) setConversations(rows) }).catch(e => { if (!controller.signal.aborted) setHistoryError(e.message) })
    return () => controller.abort()
  }, [historyRefresh])
  useEffect(() => { if (answers.length || stage) end.current?.scrollIntoView({ block: 'nearest' }) }, [answers, stage])
  const fresh = () => { request.current++; active.current?.abort(); active.current = null; setStage(''); setOpening(false); setConversationId(crypto.randomUUID()); setAnswers([]); setError('') }
  const send = async () => {
    if (active.current || opening || loading || !question.trim() || !selected.length || !consent) return
    const controller = new AbortController(); active.current = controller; const ticket = ++request.current
    setError(''); setStage('context')
    try {
      const answer = await askRecordings({ id: crypto.randomUUID(), conversationId, question, recordingIds: selected, consent: true, expectedProvider: provider }, value => { if (ticket === request.current) setStage(value) }, controller.signal)
      if (ticket !== request.current) return
      setAnswers(rows => [...rows, answer]); setQuestion('')
      setHistoryRefresh(value => value + 1)
    } catch (e) { if (ticket === request.current) setError(controller.signal.aborted ? 'Question cancelled. Completed answers remain in history.' : (e as Error).message) }
    finally { if (ticket === request.current) { active.current = null; setStage('') } }
  }
  const open = async (conversation: AiConversation) => {
    fresh(); setOpening(true); setQuestion(''); const ticket = ++request.current
    try { const rows = await aiRequest<AiAnswer[]>(`/conversations/${conversation.id}`); if (ticket === request.current) { setConversationId(conversation.id); setAnswers(rows); setSelected(conversation.recordingIds) } }
    catch (e) { if (ticket === request.current) setError((e as Error).message) } finally { if (ticket === request.current) { setOpening(false); if (window.innerWidth <= 767) setPanelOpen(false) } }
  }
  const loadMore = async () => {
    if (loading) return
    const controller = new AbortController(); pagination.current = controller
    setLoading(true)
    try { const result = await api.getTranscriptDocuments({ source: '', offset: recordings.length, signal: controller.signal }); if (!controller.signal.aborted) { setRecordings(rows => [...rows, ...result.data]); setMore(result.pagination.hasMore) } }
    catch (e) { if (!controller.signal.aborted) setError((e as Error).message) } finally { if (!controller.signal.aborted) setLoading(false) }
  }
  const exportAnswer = async (answer: AiAnswer) => {
    try { await exportDocument({ filename: `openplod-answer-${answer.id}.md`, mime: 'text/markdown', content: `# ${answer.question}\n\n${answer.answer}\n\n## Sources\n\n${answer.citations.map(c => { const source = answer.sources.find(s => s.id === c.sourceId)!; return `- [${c.sourceId}] ${source.title}${source.start === null ? '' : ` (${formatDuration(source.start)})`}: ${c.quote}` }).join('\n')}\n\n${answer.provider} / ${answer.model}` }) }
    catch (e) { setError((e as Error).message) }
  }
  const copyAnswer = async (answer: AiAnswer) => {
    try { await navigator.clipboard.writeText(answer.answer); setCopied(answer.id); if (copyTimer.current) clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(''), 2000) }
    catch { setError('Clipboard unavailable. Export the answer as Markdown instead.') }
  }
  return <div className={`ai-page ${panelOpen ? 'panel-open' : ''}`}>
    <header className="ai-heading"><div><h1>AI Chat</h1><span className="capitalize">{provider || 'Provider unavailable'}</span></div><div className="ai-heading-actions"><IconButton label="Toggle sources and history" aria-expanded={panelOpen} aria-controls="ai-context-panel" onClick={() => setPanelOpen(v => !v)}><ListTree /></IconButton><Button variant="outline" size="sm" onClick={() => { fresh(); setQuestion(''); composer.current?.focus() }}><Plus />New conversation</Button></div></header>
    <div className="ai-workspace">
      <aside id="ai-context-panel" className="ai-context" aria-label="Recording context">
        <div className="ai-panel-toolbar"><ToggleGroup type="single" value={panel} onValueChange={v => { if (v) setPanel(v) }} aria-label="Chat sidebar"><ToggleGroupItem value="sources"><FileAudio />Sources</ToggleGroupItem><ToggleGroupItem value="history"><History />History</ToggleGroupItem></ToggleGroup></div>
        {panel === 'sources' ? <>
        <h2>Context <span>{selected.length}/12</span></h2>
        {answers.length > 0 && <p className="ai-context-fixed">Conversation sources locked</p>}
        <div className="ai-source-list">{recordings.map(recording => <label key={recording.recordingId} className={`ai-source-choice ${selected.includes(recording.recordingId) ? 'selected' : ''}`}><input type="checkbox" checked={selected.includes(recording.recordingId)} disabled={!!stage || opening || answers.length > 0 || (!selected.includes(recording.recordingId) && selected.length >= 12)} onChange={e => { const checked = e.target.checked; fresh(); setSelected(rows => checked ? [...rows, recording.recordingId] : rows.filter(id => id !== recording.recordingId)) }} /><FileAudio /><span><strong>{recording.filename || 'Untitled recording'}</strong><small>{recording.wordCount ?? 0} words{recording.durationSeconds ? ` / ${formatDuration(recording.durationSeconds)}` : ''}</small></span></label>)}</div>
        {!loading && !recordings.length && <p className="ai-empty-copy">No transcripts yet. <Link to="/">Open recordings</Link></p>}
        {loading && <Loader2 className="size-4 animate-spin" aria-label="Loading transcripts" />}
        {more && <Button variant="ghost" size="sm" disabled={loading} onClick={() => void loadMore()}>{loading ? <Loader2 className="animate-spin" /> : <ChevronDown />}Load more recordings</Button>}
        </> : <div className="ai-history"><header><h2>Recent conversations</h2><IconButton label="Refresh conversations" onClick={() => setHistoryRefresh(v => v + 1)}><RefreshCw /></IconButton></header>
        {historyError && <p className="ai-history-error" role="alert">{historyError}</p>}
        {conversations.map(row => <button className={`ai-history-row ${row.id === conversationId ? 'selected' : ''}`} key={row.id} disabled={!!stage} onClick={() => void open(row)}><MessageSquare /><span>{row.question}<small>{new Date(row.createdAt).toLocaleDateString()}</small></span></button>)}
        {!conversations.length && !historyError && <p className="ai-empty-copy">No saved conversations.</p>}</div>}
      </aside>
      <section className="ai-conversation" aria-label="Conversation">
        <div className="ai-messages">
          {opening && <div className="ai-progress" role="status"><Loader2 className="animate-spin" />Opening conversation</div>}
          {!answers.length && !stage && !opening && <div className="ai-empty"><MessageSquare /><h2>{selected.length ? 'What would you like to know?' : 'Choose your recordings'}</h2><button className="ai-source-shortcut" onClick={() => { setPanel('sources'); setPanelOpen(true) }}><FileAudio />{selected.length ? `${selected.length} source${selected.length === 1 ? '' : 's'} selected` : 'Select transcript sources'}<ChevronDown /></button>{selected.length > 0 && <div className="ai-prompts">{prompts.map(({ label, prompt, icon: Icon }) => <button key={label} onClick={() => { setQuestion(prompt); composer.current?.focus() }}><Icon />{label}</button>)}</div>}</div>}
          {answers.map(answer => <article key={answer.id} className="ai-answer">
            <h2>{answer.question}</h2>
            <div className="markdown-document"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: () => null, a: ({ children }) => <span>{children}</span> }}>{answer.answer}</ReactMarkdown></div>
            {answer.citations.length > 0 && <details className="ai-citations"><summary>{answer.citations.length} source references</summary>{answer.citations.map((citation, i) => { const source = answer.sources.find(s => s.id === citation.sourceId)!; return <div key={`${source.id}-${i}`}><Link to={`/recording/${source.recordingId}?${new URLSearchParams({ ...(source.start === null ? {} : { t: String(source.start) }), ...(source.versionId ? { version: source.versionId } : {}) })}`}><FileAudio />[{source.id}] {source.title}{source.start === null ? '' : ` / ${formatDuration(source.start)}`}</Link><blockquote>{citation.quote}</blockquote><small>{source.origin} transcript</small></div> })}</details>}
            <footer><span>{answer.model}</span><details><summary>Activity</summary>{answer.trace.map(step => <p key={step.stage}>{stages[step.stage] || step.stage}</p>)}</details><div className="ai-answer-tools"><IconButton label={copied === answer.id ? 'Answer copied' : 'Copy answer'} onClick={() => void copyAnswer(answer)}>{copied === answer.id ? <Check /> : <Copy />}</IconButton><IconButton label="Export answer as Markdown" onClick={() => void exportAnswer(answer)}><Download /></IconButton></div></footer>
          </article>)}
          {stage && <p className="ai-progress" role="status"><Loader2 className="animate-spin" />{stages[stage] || stage}</p>}
          <div ref={end} />
        </div>
        <form className="ai-composer" onSubmit={e => { e.preventDefault(); void send() }}>
          {error && <p className="device-error" role="alert">{error}</p>}
          <div className="ai-selected-sources">{selected.slice(0, 3).map(id => <span key={id}><FileAudio /><span>{recordings.find(r => r.recordingId === id)?.filename || 'Saved recording source'}</span>{!answers.length && !stage && !opening && <IconButton type="button" label={`Remove source ${recordings.find(r => r.recordingId === id)?.filename || 'recording'}`} onClick={() => setSelected(rows => rows.filter(value => value !== id))}><X /></IconButton>}</span>)}{selected.length > 3 && <small>+{selected.length - 3}</small>}</div>
          <div className="ai-input"><textarea ref={composer} aria-label="Question about selected recordings" placeholder="Ask about your recordings..." rows={3} maxLength={4000} value={question} disabled={!!stage || opening} onChange={e => setQuestion(e.target.value)} />{stage ? <IconButton type="button" variant="outline" label="Cancel question" onClick={() => active.current?.abort()}><Square /></IconButton> : <IconButton type="submit" variant="default" disabled={!consent || !selected.length || !question.trim() || loading || opening} label="Send question"><ArrowUp /></IconButton>}</div>
          <div className="ai-composer-footer"><label className="ai-consent"><input type="checkbox" checked={consent} disabled={!!stage || !provider} onChange={e => setConsent(e.target.checked)} /><span>{provider === 'ollama' ? 'Allow local Ollama to process selected transcripts.' : `Allow selected transcript text to be sent to ${provider || 'the configured provider'}.`}</span></label><span>{question.length}/4000</span></div>
        </form>
      </section>
    </div>
  </div>
}
