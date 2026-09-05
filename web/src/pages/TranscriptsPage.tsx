import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Bluetooth, FileText, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api, type TranscriptDocument } from '@/lib/api'
import { formatDuration, formatRelativeDate } from '@/lib/utils'
import './transcripts.css'

export function TranscriptsPage() {
  const [documents, setDocuments] = useState<TranscriptDocument[]>([])
  const [source, setSource] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const request = useRef(0)

  useEffect(() => {
    const controller = new AbortController()
    request.current++
    setLoading(true); setError(''); setDocuments([])
    api.getTranscriptDocuments({ source, offset: 0, signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return
      setDocuments(result.data); setHasMore(result.pagination.hasMore)
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Transcripts are unavailable.')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [source, refreshKey])

  const loadMore = async () => {
    if (loading) return
    const current = request.current
    setLoading(true); setError('')
    try {
      const result = await api.getTranscriptDocuments({ source, offset: documents.length })
      if (current !== request.current) return
      setDocuments(rows => [...rows, ...result.data]); setHasMore(result.pagination.hasMore)
    } catch (failure) { if (current === request.current) setError(failure instanceof Error ? failure.message : 'Could not load more transcripts.') }
    finally { if (current === request.current) setLoading(false) }
  }

  return <div className="transcripts-page">
    <header className="transcripts-heading">
      <h1>Transcripts</h1>
      <Button size="icon" variant="ghost" aria-label="Refresh transcripts" title="Refresh transcripts" disabled={loading} onClick={() => setRefreshKey(key => key + 1)}><RefreshCw /></Button>
    </header>
    <div className="transcripts-toolbar">
      <label>Source<select value={source} onChange={event => setSource(event.target.value)}>
        <option value="">All recordings</option><option value="plaud">Plaud Note Pro</option><option value="opennotes">Phone</option><option value="upload">Imported audio</option>
      </select></label>
      <Button asChild variant="ghost" size="sm"><Link to="/devices"><Bluetooth />Plaud recordings</Link></Button>
    </div>
    {error && <div className="transcripts-error" role="alert"><p>{error}</p><Button variant="outline" size="sm" onClick={() => setRefreshKey(key => key + 1)}>Retry</Button></div>}
    <div className="transcript-documents">
      {documents.map(document => <Link key={document.recordingId} to={`/transcripts/${document.recordingId}`} className="transcript-document">
        <FileText aria-hidden="true" />
        <div><h2>{document.filename?.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ') || 'Untitled transcript'}</h2>
          <p className="transcript-excerpt">{document.excerpt || 'Empty transcript'}</p>
          <div className="transcript-document-meta"><span>{formatRelativeDate(document.recordedAt)}</span><span>{document.sourceProvider === 'plaud' ? 'Plaud Note Pro' : document.sourceProvider === 'opennotes' ? 'Phone' : 'Imported audio'}</span><span>{document.wordCount ?? 0} words</span>{!!document.durationSeconds && <span>{formatDuration(document.durationSeconds)}</span>}</div>
        </div><ArrowRight aria-hidden="true" />
      </Link>)}
    </div>
    {loading && <div className="transcripts-loading" role="status" aria-label="Loading transcripts"><Loader2 className="animate-spin" /></div>}
    {!loading && !error && documents.length === 0 && <section className="transcripts-empty"><FileText /><h2>No transcripts yet</h2><div><Button asChild><Link to="/">Recordings</Link></Button><Button asChild variant="outline"><Link to="/devices">Connect Plaud</Link></Button></div></section>}
    {hasMore && documents.length > 0 && <Button className="transcripts-more" variant="outline" disabled={loading} onClick={() => void loadMore()}>Load more</Button>}
  </div>
}
