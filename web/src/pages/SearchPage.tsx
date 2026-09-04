import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Search, Loader2, Mic } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { api, type SearchResult } from '@/lib/api'
import { formatDuration, formatRelativeDate } from '@/lib/utils'

export function SearchPage() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const normalizedQuery = query.trim()
    if (normalizedQuery.length < 2) {
      setResults([])
      setSearched(false)
      setLoading(false)
      setError('')
      return
    }

    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setLoading(true)
      setSearched(true)
      setError('')
      try {
        setResults(await api.search(normalizedQuery, controller.signal))
      } catch (searchError) {
        if (searchError instanceof DOMException && searchError.name === 'AbortError') return
        setResults([])
        setError(searchError instanceof Error ? searchError.message : 'Search failed')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, 250)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  const highlight = (text: string, q: string) => {
    if (!q || q.length < 2) return text
    const regex = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
    const parts = text.split(regex)
    return parts.map((part, i) =>
      part.toLocaleLowerCase() === q.toLocaleLowerCase()
        ? <mark key={i} className="bg-primary/30 text-foreground rounded px-0.5">{part}</mark>
        : part
    )
  }

  return (
    <div className="p-6 md:p-8 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Search</h1>
        <p className="text-sm text-muted-foreground mt-1">Search across all your transcripts</p>
      </div>

      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
        <Input
          placeholder="Search transcripts..."
          className="pl-12 h-12 text-base"
          value={query}
          onChange={e => setQuery(e.target.value)}
          autoFocus
        />
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="text-center py-20 text-muted-foreground" role="alert">
          <Search className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="text-lg font-medium text-foreground">Search unavailable</p>
          <p className="text-sm">{error}</p>
        </div>
      ) : results.length > 0 ? (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{results.reduce((a, r) => a + r.segments.length, 0)} matches across {results.length} recordings</p>
          {results.map(result => (
            <Card key={result.recordingId}>
              <CardContent className="p-5 space-y-3">
                <Link to={`/recording/${result.recordingId}`} className="flex items-center gap-3 group">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                    <Mic className="h-3.5 w-3.5 text-primary" />
                  </div>
                  <div>
                    <p className="font-medium group-hover:text-primary transition-colors">{result.recordingTitle}</p>
                    <p className="text-xs text-muted-foreground">{formatRelativeDate(result.recordedAt)}</p>
                  </div>
                </Link>
                <div className="space-y-2 pl-11">
                  {result.segments.map(seg => (
                    <Link
                      key={seg.id}
                      to={`/recording/${result.recordingId}?t=${seg.startTime}`}
                      className="block p-2.5 rounded-lg bg-secondary/50 hover:bg-secondary transition-colors"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-medium text-primary">{seg.speaker}</span>
                        <span className="text-[10px] text-muted-foreground font-mono">{formatDuration(seg.startTime)}</span>
                      </div>
                      <p className="text-sm leading-relaxed">{highlight(seg.text, query)}</p>
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : searched ? (
        <div className="text-center py-20 text-muted-foreground">
          <Search className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="text-lg font-medium">No results found</p>
          <p className="text-sm">Try a different search term</p>
        </div>
      ) : (
        <div className="text-center py-20 text-muted-foreground">
          <Search className="h-12 w-12 mx-auto mb-3 opacity-20" />
          <p className="text-sm">Type to search across all your transcripts</p>
        </div>
      )}
    </div>
  )
}
