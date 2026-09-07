import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { PlaudImportDialog } from '@/components/PlaudImportDialog'
import { Link } from 'react-router-dom'
import { Mic, AlertCircle, Search, LayoutGrid, List, Loader2, RefreshCw, Bluetooth, Download, Trash2, RotateCcw, SlidersHorizontal, X, ArrowUpRight } from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { api, type Recording, type AvailableRecording } from '@/lib/api'
import { formatDuration, formatRelativeDate } from '@/lib/utils'

const statusColors: Record<string, 'warning' | 'default' | 'success' | 'destructive'> = {
  pending: 'warning',
  transcribing: 'default',
  complete: 'success',
  failed: 'destructive',
}

export function Dashboard() {
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [view, setView] = useState<'grid' | 'list'>('list')
  const [sort, setSort] = useState('newest')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [retention, setRetention] = useState<'active' | 'trash'>('active')
  const [available, setAvailable] = useState<AvailableRecording[]>([])
  const [selectedImports, setSelectedImports] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState(false)
  const [importing, setImporting] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const loadRevision = useRef(0)
  const invalidateLoad = useCallback(() => { loadRevision.current++ }, [])

  const loadDashboard = useCallback(async () => {
    const revision = ++loadRevision.current
    setLoading(true)
    setError('')
    try {
      const recs = await api.getRecordings({ retention, limit: '100' })
      if (revision === loadRevision.current) setRecordings(recs)
    } catch (loadError) {
      if (revision === loadRevision.current) setError(loadError instanceof Error ? loadError.message : 'Could not load recordings')
    } finally {
      if (revision === loadRevision.current) setLoading(false)
    }
  }, [retention])

  useEffect(() => {
    void loadDashboard()
    window.addEventListener('plaud:sync-complete', loadDashboard)
    return () => { invalidateLoad(); window.removeEventListener('plaud:sync-complete', loadDashboard) }
  }, [loadDashboard, invalidateLoad])

  useEffect(() => {
    let disposed = false
    const loadFolder = () => api.getAvailableRecordings()
      .then(rows => { if (!disposed) setAvailable(rows) })
      .catch(() => { if (!disposed) setAvailable([]) })
    void loadFolder()
    window.addEventListener('plaud:sync-complete', loadFolder)
    return () => { disposed = true; window.removeEventListener('plaud:sync-complete', loadFolder) }
  }, [])

  const deferredSearch = useDeferredValue(search)

  const filtered = useMemo(() => recordings.filter(r => {
    if (statusFilter !== 'all' && r.status !== statusFilter) return false
    if (deferredSearch && !r.title.toLocaleLowerCase().includes(deferredSearch.toLocaleLowerCase())) return false
    return true
  }).sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : (sort === 'oldest' ? 1 : -1) * (new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime())), [deferredSearch, recordings, statusFilter, sort])

  const unimported = available.filter(recording => !recording.imported)

  const scanPlaud = async () => {
    setScanning(true)
    setError('')
    try {
      setAvailable(await api.getAvailableRecordings())
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : 'Plaud scan failed')
    } finally {
      setScanning(false)
    }
  }

  const importSelected = async () => {
    const paths = selectedImports.size > 0 ? Array.from(selectedImports) : unimported.map(recording => recording.path)
    if (paths.length === 0) return
    if (!window.confirm(`Import ${paths.length} recording${paths.length === 1 ? '' : 's'} into the OpenPlod vault?`)) return
    setImporting(true)
    setError('')
    try {
      await api.importRecordings(paths)
      setSelectedImports(new Set())
      await loadDashboard()
      await scanPlaud()
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Import failed')
    } finally {
      setImporting(false)
    }
  }

  const restore = async (id: string) => {
    try { await api.restoreRecording(id); await loadDashboard() }
    catch (error) { setError(error instanceof Error ? error.message : 'Restore failed') }
  }

  const purge = async (id: string) => {
    if (!window.confirm('Permanently delete this recording and its audio? This cannot be undone.')) return
    try { await api.purgeRecording(id); await loadDashboard() }
    catch (error) { setError(error instanceof Error ? error.message : 'Deletion failed') }
  }

  return (
    <div className="library-page">
      <div className="library-heading">
        <div>
          <h1>Recordings</h1>
        </div>
        <div className="library-heading-actions"><PlaudImportDialog /></div>
      </div>

      <div className="library-controls">
        <ToggleGroup type="single" value={retention} onValueChange={value => { if (value === 'active' || value === 'trash') setRetention(value) }} aria-label="Recording library">
          <ToggleGroupItem value="active"><Mic />All recordings</ToggleGroupItem>
          <ToggleGroupItem value="trash"><Trash2 />Trash</ToggleGroupItem>
        </ToggleGroup>
        <span className="library-results">{loading ? 'Loading' : `${filtered.length} shown`}</span>
      </div>
      <div className="library-tools">
        <div className="library-search">
          <Search />
          <Input
            placeholder="Search recordings"
            aria-label="Search recordings"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <Button variant={statusFilter === 'all' ? 'outline' : 'secondary'} size="icon" className="size-9 shrink-0" onClick={() => setFiltersOpen(true)} aria-label="Filter recordings" title="Filter recordings">
          <SlidersHorizontal />
        </Button>
        <select className="library-sort" aria-label="Sort recordings" value={sort} onChange={event => setSort(event.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="title">Title A-Z</option></select>
        <ToggleGroup type="single" size="sm" variant="outline" className="library-layout-toggle" value={view} onValueChange={value => { if (value === 'list' || value === 'grid') setView(value) }} aria-label="Recording layout">
          <ToggleGroupItem value="list" aria-label="List view" title="List view"><List /></ToggleGroupItem>
          <ToggleGroupItem value="grid" aria-label="Grid view" title="Grid view"><LayoutGrid /></ToggleGroupItem>
        </ToggleGroup>
      </div>

      {retention === 'active' && available.length > 0 && (
        <section className="plaud-inbox" aria-labelledby="plaud-import-heading">
          <div className="plaud-inbox-content">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="plaud-inbox-copy">
                <span className="plaud-inbox-icon"><Bluetooth aria-hidden="true" /></span>
                <div>
                <h2 id="plaud-import-heading">Folder imports</h2>
                <p className="text-sm text-muted-foreground">
                  {unimported.length > 0 ? `${unimported.length} file${unimported.length === 1 ? '' : 's'} ready to import from the configured folder.` : 'All files in this folder are already in the vault.'}
                </p>
                </div>
              </div>
              <div className="plaud-inbox-actions">
                <Button variant="ghost" size="sm" onClick={() => void scanPlaud()} disabled={scanning}>
                  {scanning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                  Refresh folder
                </Button>
                  <Button size="sm" onClick={() => void importSelected()} disabled={importing || unimported.length === 0}>
                    {importing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                    Import {selectedImports.size || unimported.length || ''}
                  </Button>
              </div>
            </div>
            {unimported.length > 0 && (
              <div className="plaud-files">
                {unimported.slice(0, 8).map(recording => (
                  <label key={recording.fingerprint}>
                    <input
                      type="checkbox"
                      checked={selectedImports.has(recording.path)}
                      onChange={() => setSelectedImports(current => {
                        const next = new Set(current)
                        if (next.has(recording.path)) next.delete(recording.path)
                        else next.add(recording.path)
                        return next
                      })}
                    />
                    <span className="min-w-0 flex-1 truncate">{recording.filename}</span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(recording.modifiedAt).toLocaleString()}
                      {recording.durationMs !== null ? ` · ${formatDuration(recording.durationMs / 1000)}` : ''}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      <Dialog.Root open={filtersOpen} onOpenChange={setFiltersOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="mobile-filter-overlay" />
          <Dialog.Content className="mobile-filter-sheet" aria-describedby={undefined}>
            <div className="flex items-center justify-between">
              <Dialog.Title className="text-lg font-semibold">Filter recordings</Dialog.Title>
              <Dialog.Close asChild>
                <Button variant="ghost" size="icon" aria-label="Close filters" title="Close filters"><X className="h-4 w-4" /></Button>
              </Dialog.Close>
            </div>
            <ToggleGroup type="single" orientation="vertical" className="filter-options" value={statusFilter} onValueChange={value => { if (value) setStatusFilter(value) }} aria-label="Recording status">
              {['all', 'complete', 'pending', 'transcribing', 'failed'].map(status => (
                <ToggleGroupItem key={status} value={status}>
                  <span className="capitalize">{status}</span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Dialog.Close asChild><Button className="w-full">Show recordings</Button></Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Recording List */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center py-20 text-center text-muted-foreground" role="alert">
          <AlertCircle className="mb-3 h-10 w-10 opacity-40" />
          <p className="font-medium text-foreground">Could not load recordings</p>
          <p className="mt-1 max-w-md text-sm">{error}</p>
          <Button variant="outline" size="sm" className="mt-4 gap-2" onClick={() => void loadDashboard()}>
            <RefreshCw className="h-4 w-4" /> Retry
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="library-empty">
          {retention === 'trash' ? <Trash2 /> : <Mic />}
          <h2>{search || statusFilter !== 'all' ? 'No matching recordings' : retention === 'trash' ? 'Trash is empty' : 'No recordings yet'}</h2>
          {search || statusFilter !== 'all' ? <Button variant="outline" onClick={() => { setSearch(''); setStatusFilter('all') }}>Clear filters</Button> : retention === 'active' ? <Button asChild><Link to="/record"><Mic />New recording</Link></Button> : <p className="text-sm text-muted-foreground">Deleted recordings remain recoverable for 30 days.</p>}
        </div>
      ) : (
        <div className={view === 'list' ? 'recording-list' : 'library-grid'}>
          {view === 'list' && <div className="recording-table-head" data-trash={retention === 'trash'} aria-hidden="true"><span>Recording</span><span>Recorded</span><span>Duration</span><span>Transcript</span><span /></div>}
          {filtered.map(r => (
            <article key={r.id} className={view === 'list' ? 'recording-table-row' : 'recording-grid-item'} data-trash={retention === 'trash'}>
              <Link to={`/recording/${r.id}`} className="recording-row-link">
                <span className="recording-source-icon">{r.sourceProvider === 'plaud' ? <Bluetooth /> : <Mic />}</span>
                <span className="recording-row-copy"><strong>{r.title}</strong><small>{r.sourceProvider === 'plaud' ? 'Plaud' : 'Audio recording'}</small></span>
              </Link>
              <span className="recording-date">{formatRelativeDate(r.recordedAt)}</span>
              <span className="recording-duration">{formatDuration(r.duration)}</span>
              <div className="recording-state"><Badge variant={statusColors[r.status]}>{r.status === 'complete' ? 'Ready' : r.status === 'pending' ? 'Not started' : r.status}</Badge></div>
              {view === 'grid' && r.summary && <p className="recording-grid-summary">{r.summary}</p>}
              <div className="recording-row-actions">
                {retention === 'trash' ? <>
                  <Button variant="ghost" size="icon" className="size-8" onClick={() => void restore(r.id)} aria-label={`Restore ${r.title}`} title="Restore recording"><RotateCcw /></Button>
                  <Button variant="ghost" size="icon" className="size-8" onClick={() => void purge(r.id)} aria-label={`Permanently delete ${r.title}`} title="Permanently delete recording"><Trash2 /></Button>
                </> : <Button asChild variant="ghost" size="icon" className="size-8"><Link to={`/recording/${r.id}`} aria-label={`Open ${r.title}`} title="Open recording"><ArrowUpRight /></Link></Button>}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
