import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Mic, Clock, FileText, AlertCircle, Search, LayoutGrid, List, Loader2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { api, type Recording, type DashboardStats } from '@/lib/api'
import { formatDuration, formatRelativeDate } from '@/lib/utils'

const statusColors: Record<string, 'warning' | 'default' | 'success' | 'destructive'> = {
  pending: 'warning',
  transcribing: 'default',
  complete: 'success',
  failed: 'destructive',
}

function StatCard({ icon: Icon, label, value, sub }: { icon: any; label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <Icon className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="text-2xl font-bold tracking-tight">{value}</p>
            <p className="text-xs text-muted-foreground">{label}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export function Dashboard() {
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [view, setView] = useState<'grid' | 'list'>('list')
  const [statusFilter, setStatusFilter] = useState<string>('all')

  useEffect(() => {
    Promise.all([api.getRecordings(), api.getStats()])
      .then(([recs, s]) => { setRecordings(recs); setStats(s) })
      .catch(() => {
        // Use mock data for dev
        setRecordings(mockRecordings)
        setStats({ totalRecordings: 43, totalHours: 28.5, transcribedCount: 17, pendingCount: 26 })
      })
      .finally(() => setLoading(false))
  }, [])

  const filtered = recordings.filter(r => {
    if (statusFilter !== 'all' && r.status !== statusFilter) return false
    if (search && !r.title.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Mic} label="Total Recordings" value={stats?.totalRecordings?.toString() ?? '—'} />
        <StatCard icon={Clock} label="Total Hours" value={stats?.totalHours?.toFixed(1) ?? '—'} />
        <StatCard icon={FileText} label="Transcribed" value={stats?.transcribedCount?.toString() ?? '—'} />
        <StatCard icon={AlertCircle} label="Pending" value={stats?.pendingCount?.toString() ?? '—'} />
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search recordings..."
            className="pl-10"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="flex gap-2">
          {['all', 'complete', 'pending', 'failed'].map(s => (
            <Button
              key={s}
              variant={statusFilter === s ? 'default' : 'outline'}
              size="sm"
              onClick={() => setStatusFilter(s)}
              className="capitalize"
            >
              {s}
            </Button>
          ))}
        </div>
        <div className="flex gap-1 border rounded-lg p-1">
          <Button variant={view === 'list' ? 'secondary' : 'ghost'} size="icon" className="h-8 w-8" onClick={() => setView('list')}>
            <List className="h-4 w-4" />
          </Button>
          <Button variant={view === 'grid' ? 'secondary' : 'ghost'} size="icon" className="h-8 w-8" onClick={() => setView('grid')}>
            <LayoutGrid className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Recording List */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          <Mic className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="text-lg font-medium">No recordings found</p>
          <p className="text-sm">Sync your Plaud device to get started</p>
        </div>
      ) : view === 'list' ? (
        <div className="space-y-2">
          {filtered.map(r => (
            <Link key={r.id} to={`/recording/${r.id}`}>
              <Card className="hover:bg-accent/50 transition-colors cursor-pointer">
                <CardContent className="p-4 flex items-center gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <Mic className="h-4 w-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{r.title}</p>
                    <p className="text-xs text-muted-foreground">{formatRelativeDate(r.recordedAt)} · {formatDuration(r.duration)}</p>
                  </div>
                  <Badge variant={statusColors[r.status]}>{r.status}</Badge>
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
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
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
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

const mockRecordings: Recording[] = [
  { id: '1', title: 'MBA 560 - Business Analytics Lecture', filename: 'rec_001.wav', filePath: '', duration: 4820, fileSize: 48200000, recordingType: 'class', context: null, recordedAt: new Date().toISOString(), createdAt: new Date().toISOString(), status: 'complete', summary: 'Discussion on regression analysis and predictive modeling techniques.' },
  { id: '2', title: 'Strategy Team Meeting', filename: 'rec_002.wav', filePath: '', duration: 1800, fileSize: 18000000, recordingType: 'meeting', context: null, recordedAt: new Date(Date.now() - 86400000).toISOString(), createdAt: new Date().toISOString(), status: 'complete' },
  { id: '3', title: 'VC/PE Guest Speaker', filename: 'rec_003.wav', filePath: '', duration: 3600, fileSize: 36000000, recordingType: 'class', context: null, recordedAt: new Date(Date.now() - 172800000).toISOString(), createdAt: new Date().toISOString(), status: 'pending' },
  { id: '4', title: 'Entrepreneurship Through Acquisition', filename: 'rec_004.wav', filePath: '', duration: 5400, fileSize: 54000000, recordingType: 'class', context: null, recordedAt: new Date(Date.now() - 259200000).toISOString(), createdAt: new Date().toISOString(), status: 'pending' },
  { id: '5', title: 'Career Strategy Workshop', filename: 'rec_005.wav', filePath: '', duration: 2700, fileSize: 27000000, recordingType: 'meeting', context: null, recordedAt: new Date(Date.now() - 345600000).toISOString(), createdAt: new Date().toISOString(), status: 'complete' },
  { id: '6', title: 'Innovation Lab Brainstorm', filename: 'rec_006.wav', filePath: '', duration: 1200, fileSize: 12000000, recordingType: 'other', context: null, recordedAt: new Date(Date.now() - 432000000).toISOString(), createdAt: new Date().toISOString(), status: 'failed' },
]
