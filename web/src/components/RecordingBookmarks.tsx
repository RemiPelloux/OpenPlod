import { useEffect, useState } from 'react'
import { BookmarkPlus, Play, Trash2 } from "@/components/icons"
import { Button } from './ui/button'
import { apiUrl, authenticatedHeaders } from '@/lib/runtime'
import { formatDuration } from '@/lib/utils'
type Bookmark = { id: string; seconds: number; label: string }
export function RecordingBookmarks({ recordingId, currentTime, seek }: { recordingId: string; currentTime: number; seek: (seconds: number) => void }) {
  const [rows, setRows] = useState<Bookmark[]>([]), [label, setLabel] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    fetch(apiUrl(`/recordings/${recordingId}/bookmarks`), { headers: authenticatedHeaders(), signal: abort.signal }).then(async response => {
      const data = await response.json(); if (!response.ok) throw new Error(data.error); setRows(data.data)
    }).catch(e => { if (!abort.signal.aborted) setError(e.message) })
    return () => abort.abort()
  }, [recordingId])
  const update = async (id?: string) => {
    setBusy(true); setError('')
    try {
      const response = await fetch(apiUrl(`/recordings/${recordingId}/bookmarks${id ? `/${id}` : ''}`), { method: id ? 'DELETE' : 'POST', headers: authenticatedHeaders({ 'Content-Type': 'application/json' }),
        body: id ? undefined : JSON.stringify({ id: crypto.randomUUID(), seconds: currentTime, label: label.trim() || `Bookmark at ${formatDuration(currentTime)}` }) })
      const data = await response.json(); if (!response.ok) throw new Error(data.error); setRows(data.data); setLabel('')
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <section><div className="inspector-heading"><span>Bookmarks</span><BookmarkPlus /></div>
    <div className="flex gap-2"><input className="min-w-0 w-full border rounded p-2 text-xs" aria-label="Bookmark label" placeholder={`At ${formatDuration(currentTime)}`} maxLength={160} value={label} onChange={e => setLabel(e.target.value)} /><Button size="icon" variant="outline" title="Bookmark current time" aria-label="Bookmark current time" disabled={busy} onClick={() => void update()}><BookmarkPlus /></Button></div>
    {rows.map(row => <div key={row.id} className="flex gap-1 items-center py-2"><button className="flex gap-2 text-left text-xs min-w-0 flex-1" onClick={() => seek(row.seconds)}><Play className="size-3 shrink-0" /><span className="break-words">{formatDuration(row.seconds)} {row.label}</span></button><Button size="icon" variant="ghost" title="Delete bookmark" aria-label={`Delete bookmark ${row.label}`} disabled={busy} onClick={() => void update(row.id)}><Trash2 className="size-3" /></Button></div>)}
    {error && <p role="alert" className="device-error">{error}</p>}
  </section>
}
