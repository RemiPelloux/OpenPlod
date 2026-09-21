import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, CheckCircle2, CloudUpload, Download, FileAudio, FileText, Link2, Loader2, RefreshCw, Sparkles, Trash2, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { api, type PlaudCloudImportJob, type PlaudCloudStatus } from '@/lib/api'
import './plaud-cloud-import.css'

const bytes = (value: number) => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : value >= 1024 ? `${Math.round(value / 1024)} KB` : `${value} B`
const date = (value: string) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })

/**
 * Imports audio (and Plaud's own transcripts + summaries) straight from the
 * Plaud cloud account. This needs no Bluetooth and no recorder identity, so it
 * works on every platform, including a fresh Linux install.
 */
export function PlaudCloudImport() {
  const [status, setStatus] = useState<PlaudCloudStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [includeTrash, setIncludeTrash] = useState(false)
  const [job, setJob] = useState<PlaudCloudImportJob | null>(null)
  const mounted = useRef(true)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    try {
      const next = await api.getPlaudCloud()
      if (mounted.current) { setStatus(next); setError('') }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'Could not reach the Plaud cloud.')
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
      if (pollTimer.current) clearTimeout(pollTimer.current)
    }
  }, [load])

  const stopPolling = () => {
    if (pollTimer.current) { clearTimeout(pollTimer.current); pollTimer.current = null }
  }

  const poll = useCallback((id: string) => {
    stopPolling()
    pollTimer.current = setTimeout(async () => {
      if (!mounted.current) return
      try {
        const next = await api.getPlaudCloudImport(id)
        if (!mounted.current) return
        setJob(next)
        if (next.state === 'running') poll(id)
        else {
          setJob(next)
          window.dispatchEvent(new CustomEvent('plaud:sync-complete'))
          void load()
        }
      } catch (failure) {
        if (mounted.current) {
          setError(failure instanceof Error ? failure.message : 'Lost the import progress. Check the library before retrying.')
          setJob(null)
        }
      }
    }, 1000)
  }, [load])

  const link = async () => {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await api.linkPlaudCloud(token.trim())
      setToken('')
      setNotice(`Linked. Found ${result.count} recordings (${bytes(result.bytes)}) in the ${result.region || 'Plaud'} cloud.`)
      await load()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not link that token.')
    } finally { setBusy(false) }
  }

  const unlink = async () => {
    setBusy(true); setError(''); setNotice('')
    try {
      await api.unlinkPlaudCloud()
      setSelected([]); setJob(null)
      setNotice('Plaud cloud unlinked. Recordings already imported stay in the vault.')
      await load()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not unlink the Plaud cloud.')
    } finally { setBusy(false) }
  }

  const startImport = async (ids?: string[]) => {
    if (job?.state === 'running') return
    setBusy(true); setError(''); setNotice('')
    try {
      const started = await api.importPlaudCloud({ ...(ids ? { ids } : {}), includeTrash })
      setJob({ id: started.id, state: 'running', total: 0, completed: 0, totalBytes: 0, receivedBytes: 0, current: null, imported: [], failures: [], transcripts: 0, summaries: 0, transcriptFailures: [] })
      poll(started.id)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not start the import.')
    } finally { setBusy(false) }
  }

  const cancel = async () => {
    try { await api.cancelPlaudCloudImport() } catch { /* the poll will observe the cancellation */ }
  }

  if (loading) {
    return <section className="device-section plaud-cloud" aria-label="Plaud cloud import"><div className="device-section-heading"><CloudUpload /><h2>Import from Plaud cloud</h2></div><p className="device-muted"><Loader2 className="animate-spin inline size-4 mr-2" />Checking the Plaud cloud…</p></section>
  }

  const linked = status?.linked ?? false
  const recordings = status?.recordings ?? []
  const available = recordings.filter(recording => !recording.imported && (!recording.isTrash || includeTrash))
  const running = job?.state === 'running'

  const toggle = (id: string) => setSelected(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id])
  const allSelected = available.length > 0 && available.every(recording => selected.includes(recording.id))

  const finished = job && job.state !== 'running'

  return <section className="device-section plaud-cloud" aria-label="Import from Plaud cloud">
    <div className="device-section-heading">
      <CloudUpload />
      <h2>Import from Plaud cloud</h2>
      {linked && <span className="plaud-cloud-badge" data-linked><CheckCircle2 />Linked</span>}
    </div>

    {!linked ? <>
      <p className="device-muted">Get every recording off your Plaud account over the internet — no Bluetooth, no recorder authorization. Audio, transcripts and AI summaries come along.</p>
      <label className="plaud-cloud-field"><span>Plaud sign-in token</span>
        <input type="password" autoComplete="off" spellCheck={false} value={token} placeholder="Paste workspaceToken (or tokenstr) from web.plaud.ai" aria-label="Plaud sign-in token" onChange={event => setToken(event.target.value)} />
      </label>
      <div className="plaud-cloud-actions">
        <Button disabled={busy || !token.trim()} onClick={() => void link()}>{busy ? <Loader2 className="animate-spin" /> : <Link2 />}Link account &amp; list recordings</Button>
      </div>
      <details className="plaud-cloud-help"><summary>Where do I find this token?</summary>
        <p>Sign in at <a href="https://web.plaud.ai" target="_blank" rel="noreferrer">web.plaud.ai</a>, open your browser's developer tools, go to <em>Application → Local Storage → https://web.plaud.ai</em>, and copy the value of <code>workspaceToken</code> (inside the <code>…:workspaceList</code> entry). Some versions call the key <code>tokenstr</code> instead.</p>
      </details>
    </> : <>
      {status?.account && <div className="plaud-cloud-account">
        <span>{status.account.region ?? 'Plaud'}</span>
        {status.account.expiresAt && <span>Token valid until {new Date(status.account.expiresAt * 1000).toLocaleString()}</span>}
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void unlink()}>{busy ? <Loader2 className="animate-spin" /> : <Trash2 />}Unlink</Button>
      </div>}
      {status && <p className="device-muted">{status.totals.count} recordings / {bytes(status.totals.bytes)} — {status.totals.importedCount} already in the vault{status.totals.trashCount ? `, ${status.totals.trashCount} in Trash` : ''}.</p>}

      {running && job && <div className="plaud-cloud-progress" role="status">
        <div className="plaud-cloud-progress-head"><span><Loader2 className="animate-spin" />Importing {job.completed} / {job.total}{job.current ? ` — ${job.current}` : ''}</span><small>{job.totalBytes ? `${Math.round(job.receivedBytes / job.totalBytes * 100)}%` : ''}</small></div>
        {job.totalBytes > 0 && <div className="plaud-cloud-bar"><i style={{ width: `${Math.min(100, Math.round(job.receivedBytes / job.totalBytes * 100))}%` }} /></div>}
        <Button variant="ghost" size="sm" onClick={() => void cancel()}><X />Cancel</Button>
      </div>}

      {finished && job && <div className={`plaud-cloud-result ${job.state === 'failed' ? 'is-error' : ''}`} role="status">
        <p>{job.state === 'complete' ? <>Saved <strong>{job.imported.length}</strong> recording{job.imported.length === 1 ? '' : 's'}{job.transcripts ? <> with <strong>{job.transcripts}</strong> transcript{job.transcripts === 1 ? '' : 's'}</> : ''}{job.summaries ? <> and <strong>{job.summaries}</strong> summar{job.summaries === 1 ? 'y' : 'ies'}</> : ''}.</> : job.state === 'cancelled' ? 'Import cancelled. Recordings already saved stay in the vault.' : `Import failed${job.error ? `: ${job.error}` : '.'}`}</p>
        {job.failures.length > 0 && <ul>{job.failures.map(failure => <li key={failure.sourceId}><strong>{failure.title}</strong>: {failure.error}</li>)}</ul>}
        {job.transcriptFailures.length > 0 && <details><summary>{job.transcriptFailures.length} transcript{job.transcriptFailures.length === 1 ? '' : 's'} unavailable</summary><ul>{job.transcriptFailures.map(failure => <li key={failure.sourceId}><strong>{failure.title}</strong>: {failure.error}</li>)}</ul></details>}
      </div>}

      <div className="plaud-cloud-toolbar">
        <label className="plaud-cloud-include"><input type="checkbox" checked={includeTrash} onChange={event => { setIncludeTrash(event.target.checked); setSelected([]) }} />Include Trash</label>
        <label className="plaud-cloud-select"><input type="checkbox" aria-label="Select all importable recordings" checked={allSelected} disabled={busy || !available.length} onChange={event => setSelected(event.target.checked ? available.map(recording => recording.id) : [])} /><span>Select all</span></label>
        <span className="plaud-cloud-toolbar-spacer" />
        <Button variant="outline" size="sm" disabled={busy || running || !selected.length} onClick={() => void startImport(selected)}><Download />Import selected{selected.length ? ` (${selected.length})` : ''}</Button>
        <Button size="sm" disabled={busy || running || !available.length} onClick={() => void startImport()}><CloudUpload />Import all{available.length ? ` (${available.length})` : ''}</Button>
      </div>

      {recordings.length === 0 ? <div className="plaud-cloud-empty"><FileAudio /><p>No recordings found on this account.</p></div> : <div className="plaud-cloud-list">
        {recordings.map(recording => {
          const selectable = !recording.imported && (!recording.isTrash || includeTrash)
          return <div className="plaud-cloud-row" key={recording.id} data-imported={recording.imported}>
            <input type="checkbox" aria-label={`Select ${recording.filename}`} disabled={busy || !selectable} checked={selected.includes(recording.id)} onChange={() => toggle(recording.id)} />
            <FileAudio />
            <div className="plaud-cloud-name"><strong>{recording.filename}</strong><small>{date(recording.recordedAt)} · {recording.serial ? `SN ${recording.serial}` : 'Plaud'}</small></div>
            <span className="plaud-cloud-size">{bytes(recording.sizeBytes)}</span>
            <span className="plaud-cloud-tags">
              {recording.hasTranscript && <span title="Transcript"><FileText /></span>}
              {recording.hasSummary && <span title="Summary"><Sparkles /></span>}
              {recording.isTrash && <span className="plaud-cloud-trash" title="In Trash"><Trash2 /></span>}
            </span>
            <span className="plaud-cloud-state" data-imported={recording.imported}>{recording.imported ? 'Imported' : 'New'}</span>
            {recording.imported && recording.recordingId ? <IconButton asChild label="Open recording"><Link to={`/recording/${recording.recordingId}`}><Check /></Link></IconButton> : null}
          </div>
        })}
      </div>}
      {!running && recordings.length > 0 && <Button variant="ghost" size="sm" onClick={() => void load()}><RefreshCw />Refresh list</Button>}
    </>}

    {notice && <p role="status" className="plaud-cloud-notice"><CheckCircle2 />{notice}</p>}
    {error && <p role="alert" className="device-error">{error}</p>}
  </section>
}
