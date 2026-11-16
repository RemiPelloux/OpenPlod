import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowLeft, AudioLines, Bluetooth, ChevronDown, Download, FileText, Loader2, MessageSquare, Pencil, RefreshCw } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SaveTranscriptDialog } from '@/components/NoteDialogs'
import { api, type Recording, type TranscriptDocument } from '@/lib/api'
import { formatDuration, formatRelativeDate } from '@/lib/utils'
import { exportDocument, recordingMarkdown, safeDocumentName } from '@/lib/document-export'
import { t, tn } from '@/i18n'
import './transcripts.css'

const sourceName = (source: string | null) => source === 'plaud' ? 'Plaud' : source === 'opennotes' ? t('Phone') : t('Imported')
export function TranscriptsPage() {
  const [params, setParams] = useSearchParams()
  const [documents, setDocuments] = useState<TranscriptDocument[]>([])
  const [source, setSource] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const request = useRef(0)
  const showReader = params.has('recording')
  const chosen = params.get('recording') || documents[0]?.recordingId || ''
  const [recording, setRecording] = useState<Recording | null>(null)
  const [reading, setReading] = useState(false)
  const [readerError, setReaderError] = useState('')
  const [mode, setMode] = useState('preview')
  useEffect(() => {
    const controller = new AbortController()
    request.current++
    setLoading(true); setError(''); setDocuments([]); setHasMore(false)
    api.getTranscriptDocuments({ source, offset: 0, signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return
      setDocuments(result.data); setHasMore(result.pagination.hasMore)
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t('Transcripts are unavailable.'))
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    // This is a request-generation counter, not a DOM ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { controller.abort(); request.current++ }
  }, [source, refreshKey])
  useEffect(() => {
    let cancelled = false
    setRecording(null); setReaderError(''); setReading(Boolean(chosen))
    if (chosen) api.getRecording(chosen).then(row => { if (!cancelled) setRecording(row) })
      .catch(e => { if (!cancelled) setReaderError(e.message) })
      .finally(() => { if (!cancelled) setReading(false) })
    return () => { cancelled = true }
  }, [chosen, refreshKey])
  const loadMore = async () => {
    if (loading) return
    const current = request.current
    setLoading(true); setError('')
    try {
      const result = await api.getTranscriptDocuments({ source, offset: documents.length })
      if (current !== request.current) return
      setDocuments(rows => [...rows, ...result.data]); setHasMore(result.pagination.hasMore)
    } catch (failure) { if (current === request.current) setError(failure instanceof Error ? failure.message : t('Could not load more transcripts.')) }
    finally { if (current === request.current) setLoading(false) }
  }
  const download = async (format: 'md' | 'txt' | 'json' | 'pdf') => {
    if (!recording) return
    try {
      // PDF is rendered by the server from the saved current version (TS-09).
      if (format === 'pdf') {
        await exportDocument({ filename: `${safeDocumentName(recording.title)}.pdf`, content: await api.transcriptPdf(recording.id, recording.transcriptVersionId ?? null), mime: 'application/pdf' })
        return
      }
      const text = recording.transcriptText || ''
      await exportDocument({ filename: `${safeDocumentName(recording.title)}.${format}`, content: format === 'md' ? recordingMarkdown(recording, text, { versionId: recording.transcriptVersionId ?? null, origin: recording.transcriptOrigin ?? null }) : format === 'txt' ? text : JSON.stringify({ recordingId: recording.id, versionId: recording.transcriptVersionId, origin: recording.transcriptOrigin, text, segments: recording.segments }, null, 2), mime: format === 'md' ? 'text/markdown' : format === 'txt' ? 'text/plain' : 'application/json' })
    } catch (e) { setReaderError((e as Error).message) }
  }
  return <div className={`transcripts-page ${showReader ? 'reader-open' : ''}`}>
    <header className="transcripts-heading"><div><h1>{t('Transcripts')}</h1><span>{documents.length}{hasMore ? '+' : ''}</span></div><div className="transcripts-heading-actions"><Button asChild size="sm" variant="outline"><Link to="/devices" aria-label={t('Get from Plaud')}><Bluetooth />{t('Get from Plaud')}</Link></Button><IconButton label={t('Refresh transcripts')} disabled={loading} onClick={() => setRefreshKey(key => key + 1)}><RefreshCw /></IconButton></div></header>
    <div className="transcripts-workspace">
      <aside className="transcripts-library" aria-label={t('Transcript library')}>
        <div className="transcripts-toolbar"><FileText /><select aria-label={t('Transcript source')} value={source} onChange={event => { setSource(event.target.value); setParams({}) }}><option value="">{t('All transcripts')}</option><option value="plaud">{t('Plaud recorder')}</option><option value="opennotes">{t('Phone')}</option><option value="upload">{t('Imported audio')}</option></select></div>
        {error && <div className="transcripts-error" role="alert"><p>{error}</p><Button size="sm" variant="ghost" onClick={() => setRefreshKey(v => v + 1)}><RefreshCw />{t('Retry')}</Button></div>}
        <div className="transcript-documents">{documents.map(document => <button type="button" key={document.recordingId} aria-pressed={chosen === document.recordingId} className="transcript-document" onClick={() => setParams({ recording: document.recordingId })}><FileText /><span className="transcript-document-copy"><strong>{document.filename?.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ') || t('Untitled transcript')}</strong><span className="transcript-excerpt">{document.excerpt || t('Empty transcript')}</span><span className="transcript-document-meta"><span>{formatRelativeDate(document.recordedAt)}</span><span>{sourceName(document.sourceProvider)}</span></span></span></button>)}</div>
        {loading && <div className="transcripts-loading" role="status" aria-label={t('Loading transcripts')}><Loader2 className="animate-spin" /></div>}
        {!loading && !error && !documents.length && <div className="transcripts-empty"><FileText /><h2>{t('No transcripts yet')}</h2><Button asChild variant="outline" size="sm"><Link to="/recordings"><AudioLines />{t('Recordings')}</Link></Button></div>}
        {hasMore && <Button className="transcripts-more" variant="ghost" disabled={loading} onClick={() => void loadMore()}><ChevronDown />{t('Load more')}</Button>}
      </aside>
      <section className="transcript-reader" aria-label={t('Transcript reader')} aria-busy={reading}>
        <header className="transcript-reader-heading"><IconButton className="transcript-back" label={t('Back to transcripts')} onClick={() => setParams({})}><ArrowLeft /></IconButton><div><h2>{recording?.title || (reading ? t('Loading transcript') : t('Transcript'))}</h2>{recording && <p>{formatRelativeDate(recording.recordedAt)}<span>{recording.transcriptOrigin === 'edited' ? t('Edited transcript') : t('Generated transcript')}</span></p>}</div><div className="transcript-reader-actions">{recording && <><IconButton asChild label={t('Edit transcript')}><Link to={`/transcripts/${recording.id}`}><Pencil /></Link></IconButton><IconButton asChild label={t('Ask AI about transcript')}><Link to={`/ai?recording=${recording.id}`}><MessageSquare /></Link></IconButton><DropdownMenu.Root><DropdownMenu.Trigger asChild><Button size="sm" variant="outline"><Download />{t('Export')}<ChevronDown /></Button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="action-menu" align="end">{(['md', 'txt', 'json', 'pdf'] as const).map(format => <DropdownMenu.Item key={format} onSelect={() => void download(format)}><Download />{format === 'md' ? t('Markdown file') : format === 'txt' ? t('Plain text') : format === 'json' ? t('JSON file') : t('PDF document')}</DropdownMenu.Item>)}</DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root></>}</div></header>
        {recording && <div className="transcript-reader-toolbar"><ToggleGroup type="single" value={mode} onValueChange={v => { if (v) setMode(v) }} aria-label={t('Transcript view')}><ToggleGroupItem value="preview">{t('Preview')}</ToggleGroupItem><ToggleGroupItem value="markdown">Markdown</ToggleGroupItem></ToggleGroup><SaveTranscriptDialog recordingId={recording.id} versionId={recording.transcriptVersionId ?? null} title={recording.title} disabled={!recording.transcriptText} /></div>}
        {readerError && <div className="transcripts-error" role="alert"><p>{readerError}</p><Button size="sm" variant="ghost" onClick={() => setRefreshKey(v => v + 1)}><RefreshCw />{t('Retry')}</Button></div>}
        <div className="transcript-reader-body">{reading ? <div className="transcripts-loading" role="status"><Loader2 className="animate-spin" /></div> : recording ? mode === 'preview' ? <div className="markdown-document transcript-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: () => null, a: ({ children }) => <span>{children}</span> }}>{recording.transcriptText || t('No transcript text.')}</ReactMarkdown></div> : <pre className="transcript-raw" aria-label={t('Transcript Markdown')}>{recording.transcriptText || ''}</pre> : !readerError && <div className="transcripts-empty"><FileText /><h2>{t('Select a transcript')}</h2></div>}</div>
        {recording && <footer className="transcript-reader-footer"><span>{tn(recording.transcriptText?.trim().split(/\s+/).filter(Boolean).length || 0, '{count} word', '{count} words')}</span><span>{formatDuration(recording.duration)}</span><Link to={`/recording/${recording.id}`}><AudioLines />{t('Open recording')}</Link></footer>}
      </section>
    </div>
  </div>
}
