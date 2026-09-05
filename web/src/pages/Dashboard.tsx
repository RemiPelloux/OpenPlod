import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { PlaudImportDialog } from '@/components/PlaudImportDialog'
import { Link } from 'react-router-dom'
import { Mic, AlertCircle, Search, LayoutGrid, List, Loader2, RefreshCw, Bluetooth, Download, Trash2, RotateCcw, SlidersHorizontal, X, FolderHeart, Check } from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import { Card, CardContent } from '@/components/ui/card'
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
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [retention, setRetention] = useState<'active' | 'trash'>('active')
  const [available, setAvailable] = useState<AvailableRecording[]>([])
  const [selectedImports, setSelectedImports] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState(false)
  const [importing, setImporting] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)

  const loadDashboard = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const recs = await api.getRecordings({ retention, limit: '100' })
      setRecordings(recs)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load recordings')
    } finally {
      setLoading(false)
    }
  }, [retention])

  useEffect(() => {
    void loadDashboard()
    window.addEventListener('plaud:sync-complete', loadDashboard)
    return () => window.removeEventListener('plaud:sync-complete', loadDashboard)
  }, [loadDashboard])

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
  }), [deferredSearch, recordings, statusFilter])

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
    await api.restoreRecording(id)
    await loadDashboard()
  }

  const purge = async (id: string) => {
    if (!window.confirm('Permanently delete this recording and its audio? This cannot be undone.')) return
    await api.purgeRecording(id)
    await loadDashboard()
  }

  return (
    <div className="library-page">
      <div className="library-heading">
        <div>
          <h1>Recordings</h1>
        </div>
        <PlaudImportDialog />
      </div>

      <div className="library-tools">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search recordings"
            className="pl-10"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <Button variant="outline" size="icon" className="shrink-0" onClick={() => setFiltersOpen(true)} aria-label="Filter recordings" title="Filter recordings">
          <SlidersHorizontal className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="icon" className="shrink-0 sm:hidden" onClick={() => setRetention(value => value === 'active' ? 'trash' : 'active')} aria-label={retention === 'active' ? 'Open Trash' : 'Return to Library'} title={retention === 'active' ? 'Open Trash' : 'Return to Library'}>
          {retention === 'active' ? <Trash2 className="h-4 w-4" /> : <FolderHeart className="h-4 w-4" />}
        </Button>
      </div>

      {retention === 'active' && <Link to="/devices" className="device-connection"><span><strong>Plaud Note Pro</strong><p>Device recordings</p></span><Bluetooth aria-hidden="true" /></Link>}
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

      <div className="hidden gap-3 sm:flex">
        <div className="ml-auto flex gap-1 border rounded-lg p-1">
          <Button variant={retention === 'active' ? 'secondary' : 'ghost'} size="sm" onClick={() => setRetention('active')}>
            <Mic className="mr-2 h-4 w-4" /> Library
          </Button>
          <Button variant={retention === 'trash' ? 'secondary' : 'ghost'} size="sm" onClick={() => setRetention('trash')}>
            <Trash2 className="mr-2 h-4 w-4" /> Trash
          </Button>
        </div>
        <div className="flex gap-1 border rounded-lg p-1">
          <Button variant={view === 'list' ? 'secondary' : 'ghost'} size="icon" className="h-8 w-8" onClick={() => setView('list')} aria-label="List view" title="List view">
            <List className="h-4 w-4" />
          </Button>
          <Button variant={view === 'grid' ? 'secondary' : 'ghost'} size="icon" className="h-8 w-8" onClick={() => setView('grid')} aria-label="Grid view" title="Grid view">
            <LayoutGrid className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <Dialog.Root open={filtersOpen} onOpenChange={setFiltersOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="mobile-filter-overlay" />
          <Dialog.Content className="mobile-filter-sheet" aria-describedby={undefined}>
            <div className="flex items-center justify-between">
              <Dialog.Title className="font-serif text-2xl font-semibold">Filter recordings</Dialog.Title>
              <Dialog.Close asChild>
                <Button variant="ghost" size="icon" aria-label="Close filters" title="Close filters"><X className="h-4 w-4" /></Button>
              </Dialog.Close>
            </div>
            <div className="filter-options" role="radiogroup" aria-label="Recording status">
              {['all', 'complete', 'pending', 'failed'].map(status => (
                <button key={status} type="button" role="radio" aria-checked={statusFilter === status} onClick={() => setStatusFilter(status)}>
                  <span className="capitalize">{status}</span>
                  {statusFilter === status && <Check className="h-4 w-4" />}
                </button>
              ))}
            </div>
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
        <div className="text-center py-20 text-muted-foreground">
          <Mic className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="text-lg font-medium">{retention === 'trash' ? 'Trash is empty' : 'No recordings yet'}</p>
          <p className="text-sm">{retention === 'trash' ? 'Deleted recordings stay here for 30 days.' : 'Tap the microphone to record your first note.'}</p>
        </div>
      ) : view === 'list' ? (
        <div className="recording-list">
          {filtered.map(r => (
            <Link key={r.id} to={`/recording/${r.id}`}>
              <Card className="recording-row">
                <CardContent className="p-4 flex items-center gap-4">
                  <div className="recording-source-icon">
                    <Mic className="h-4 w-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{r.title}</p>
                    <p className="text-xs text-muted-foreground">{formatRelativeDate(r.recordedAt)} · {formatDuration(r.duration)}</p>
                  </div>
                  <Badge className={`recording-status ${r.status === 'complete' ? 'recording-status-complete' : ''}`} variant={statusColors[r.status]}>{r.status}</Badge>
                  {retention === 'trash' && (
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={event => { event.preventDefault(); event.stopPropagation(); void restore(r.id) }} aria-label="Restore recording" title="Restore recording">
                        <RotateCcw className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={event => { event.preventDefault(); event.stopPropagation(); void purge(r.id) }} aria-label="Permanently delete recording" title="Permanently delete recording">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(r => (
            <Link key={r.id} to={`/recording/${r.id}`}>
              <Card className="hover:bg-accent/50 transition-colors cursor-pointer h-full">
                <CardContent className="p-5 space-y-3">
                  <div className="flex items-start justify-between">
                    <div className="recording-source-icon">
                      <Mic className="h-4 w-4 text-primary" />
                    </div>
                    <Badge variant={statusColors[r.status]}>{r.status}</Badge>
                  </div>
                  <div>
                    <p className="font-medium truncate">{r.title}</p>
                    <p className="text-xs text-muted-foreground mt-1">{formatRelativeDate(r.recordedAt)} · {formatDuration(r.duration)}</p>
                  </div>
                  {r.summary && (
                    <p className="text-xs text-muted-foreground line-clamp-2">{r.summary}</p>
                  )}
                  {retention === 'trash' && (
                    <div className="flex justify-end gap-1 border-t pt-2">
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={event => { event.preventDefault(); event.stopPropagation(); void restore(r.id) }} aria-label="Restore recording" title="Restore recording">
                        <RotateCcw className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={event => { event.preventDefault(); event.stopPropagation(); void purge(r.id) }} aria-label="Permanently delete recording" title="Permanently delete recording">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
