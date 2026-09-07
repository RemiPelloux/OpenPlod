import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AudioLines, Bluetooth, Check, CheckCircle2, Clock3, Download, FileAudio, FolderOpen, HardDrive, Loader2, Radio, RefreshCw, ShieldCheck, X } from "@/components/icons"
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { NoteDialog } from '@/components/NoteDialogs'
import { DesktopAuthorizations, DesktopImportPreferences } from '@/components/PlaudAuthorization'
import { api, type DashboardStats, type DeviceRecording, type PlaudStatus } from '@/lib/api'
import './desktop-plaud.css'

const sessionDate = (session: DeviceRecording) => new Date(session.sessionId * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })

export function DesktopPlaud() {
  const [status, setStatus] = useState<PlaudStatus | null>(null)
  const [phase, setPhase] = useState<'idle' | 'scanning' | 'listing' | 'downloading' | 'cancelling'>('idle')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [sessions, setSessions] = useState<DeviceRecording[] | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [confirmation, setConfirmation] = useState<DeviceRecording[] | null>(null)
  const [downloading, setDownloading] = useState<number | null>(null)
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [statsError, setStatsError] = useState('')
  const mounted = useRef(true)
  const active = useRef<AbortController | null>(null)
  const cancelling = useRef(false)
  const recordingSection = useRef<HTMLElement>(null)
  const busy = phase !== 'idle'
  const pending = sessions?.filter(session => !session.recordingId) || []

  const loadStats = useCallback(() => {
    void api.getStats().then(value => { if (mounted.current) { setStats(value); setStatsError('') } })
      .catch(() => { if (mounted.current) setStatsError('Vault summary unavailable') })
  }, [])
  useEffect(() => {
    mounted.current = true; loadStats()
    window.addEventListener('plaud:sync-complete', loadStats)
    return () => { mounted.current = false; active.current?.abort(); window.removeEventListener('plaud:sync-complete', loadStats) }
  }, [loadStats])

  const scan = async () => {
    if (active.current) return
    const controller = new AbortController(); active.current = controller
    setPhase('scanning'); setError(''); setNotice(''); setSessions(null); setSelected([]); setStatus(null); setCheckedAt(null)
    try {
      const result = await api.getPlaudStatus(controller.signal)
      if (controller.signal.aborted) return
      setStatus(result)
      if (result.directTransferAvailable) {
        setPhase('listing')
        const files = await api.getDeviceRecordings(controller.signal)
        if (!controller.signal.aborted) { setSessions(files); setCheckedAt(new Date()) }
      }
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Bluetooth scan failed.')
    } finally { if (active.current === controller && !cancelling.current) { active.current = null; if (mounted.current) setPhase('idle') } }
  }

  const download = async () => {
    if (active.current || !confirmation?.length) return
    const items = confirmation
    const controller = new AbortController(); active.current = controller
    setConfirmation(null); setPhase('downloading'); setError(''); setNotice('')
    let saved = 0
    try {
      for (const session of items) {
        controller.signal.throwIfAborted(); setDownloading(session.sessionId)
        const id = await api.importDeviceRecording(session.sessionId, controller.signal)
        if (controller.signal.aborted) return
        saved++
        setSessions(current => current?.map(item => item.sessionId === session.sessionId ? { ...item, recordingId: id, retentionState: 'active' } : item) ?? null)
        setSelected(current => current.filter(value => value !== session.sessionId))
        setNotice(`${saved} recording${saved === 1 ? '' : 's'} saved to your vault`)
        window.dispatchEvent(new CustomEvent('plaud:sync-complete'))
      }
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Download failed')
    } finally {
      if (active.current === controller && !cancelling.current) { active.current = null; if (mounted.current) { setPhase('idle'); setDownloading(null) } }
    }
  }
  const cancel = async () => {
    if (cancelling.current) return
    cancelling.current = true; setPhase('cancelling')
    active.current?.abort()
    try { await api.cancelDeviceOperation(); if (mounted.current) setNotice('Operation cancelled. Recordings already saved remain in the vault.') }
    catch { if (mounted.current) setError('Could not confirm cancellation. Check the library before retrying.') }
    finally { cancelling.current = false; active.current = null; if (mounted.current) { setPhase('idle'); setDownloading(null) } }
  }

  const access = sessions !== null
  const statusLabel = phase === 'cancelling' ? 'Cancelling' : phase === 'scanning' ? 'Searching nearby' : phase === 'listing' ? 'Reading device' : phase === 'downloading' ? 'Importing audio' : access ? 'Access verified' : status?.deviceDetected ? 'Device detected' : status ? 'Not detected' : 'Not connected'
  const states = [
    { icon: Radio, name: 'Bluetooth discovery', value: status ? status.deviceDetected ? 'Detected' : 'Not detected' : phase === 'scanning' ? 'Searching' : 'Not checked', ok: !!status?.deviceDetected },
    { icon: Bluetooth, name: 'Bluetooth connection', value: access || status?.connectionVerified ? 'Verified' : 'Not verified', ok: access || !!status?.connectionVerified },
    { icon: FileAudio, name: 'Recording access', value: access ? 'Verified' : phase === 'listing' ? 'Checking' : 'Unknown', ok: access },
    { icon: ShieldCheck, name: 'Device authorization', value: status ? status.directTransferAvailable ? 'Configured' : 'Not configured' : 'Not checked', ok: !!status?.directTransferAvailable },
    { icon: AudioLines, name: 'Recordings found', value: sessions === null ? 'Unknown' : String(sessions.length), ok: access },
  ]

  return <div className="plaud-workspace">
    <header className="plaud-page-heading"><div className="plaud-page-title"><span className="plaud-heading-icon"><Bluetooth /></span><div><h1>Plaud Note Pro</h1><p>Device, recordings &amp; imports</p></div></div>
      <div className="plaud-status-strip" role="status"><span className="plaud-state" data-verified={access}><i />{statusLabel}</span>{checkedAt && <span className="plaud-checked"><Clock3 />Checked {checkedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>}</div>
    </header>
    {(error || notice) && <div className={`plaud-feedback ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>{error ? <Radio /> : <Check />}<span>{error || notice}</span><IconButton label="Dismiss device message" onClick={() => { setError(''); setNotice('') }}><X /></IconButton></div>}
    <div className="plaud-workspace-grid">
      <section className="plaud-device-overview" aria-label="Desktop Plaud connection">
        <div className="plaud-product-image"><img src="/plaud-note-pro.png" alt="Plaud Note Pro recorder" width="220" height="280" /></div>
        <div className="plaud-device-info"><h2>{status?.deviceName || 'Plaud Note Pro'}</h2><p>AI voice recorder</p>
          <dl><div><dt><Bluetooth />Bluetooth</dt><dd className="plaud-state" data-verified={access}><i />{statusLabel}</dd></div><div><dt><FileAudio />On device</dt><dd>{sessions === null ? 'Unknown' : `${sessions.length} recordings`}</dd></div><div><dt><ShieldCheck />Original audio</dt><dd>Kept on Plaud</dd></div></dl>
          <div className="plaud-connect-actions"><Button disabled={busy} onClick={() => void scan()}>{busy ? <Loader2 className="animate-spin" /> : status ? <RefreshCw /> : <Bluetooth />}{phase === 'scanning' ? 'Connecting' : phase === 'listing' ? 'Reading recordings' : status ? 'Refresh recordings' : 'Connect Note Pro'}</Button>
            {busy && <IconButton label="Cancel device operation" onClick={() => void cancel()}><X /></IconButton>}</div>
          <div className="plaud-secondary-actions"><Button size="sm" variant="outline" disabled={busy || !pending.length} onClick={() => setConfirmation(pending)}><Download />Import new</Button><Button asChild variant="outline" size="sm"><Link to="/recordings"><FolderOpen />Open library</Link></Button></div>
        </div>
      </section>
      <section className="plaud-health" aria-label="Connection health"><header className="plaud-section-heading"><span className="plaud-section-icon"><ShieldCheck /></span><div><h2>Connection health</h2><p>{access ? 'Recording list verified on this Mac' : 'Awaiting verified device access'}</p></div>{access && <CheckCircle2 className="plaud-positive" />}</header>
        <dl>{states.map(({ icon: Icon, name, value, ok }) => <div key={name}><dt><Icon />{name}</dt><dd className="plaud-state" data-verified={ok}><i />{value}</dd></div>)}</dl>
        {status?.detail && <details className="plaud-diagnostics"><summary>Connection details</summary><p>{status.detail}</p></details>}
      </section>
      <section className="plaud-device-recordings" aria-label="Recordings on Note Pro" ref={recordingSection}>
        <header className="plaud-section-heading"><span className="plaud-section-icon"><FileAudio /></span><div><h2>On your Note Pro</h2><p>{sessions === null ? 'Recording count unknown' : `${sessions.length} recordings / ${pending.length} new`}</p></div><Button size="sm" disabled={busy || !selected.length} onClick={() => setConfirmation(pending.filter(session => selected.includes(session.sessionId)))}><Download /><span>Import selected{selected.length ? ` (${selected.length})` : ''}</span></Button></header>
        {sessions === null ? <div className="plaud-recordings-empty">{busy ? <Loader2 className="animate-spin" /> : <Bluetooth />}<h3>{busy ? 'Reading your Note Pro' : 'Connect to see recordings'}</h3><p>{status && !status.directTransferAvailable ? 'Device authorization is not configured on this Mac.' : error ? 'The device list is unavailable. No recording count has been reported.' : 'No recording list has been received yet.'}</p>{!busy && <Button variant="outline" size="sm" onClick={() => void scan()}><RefreshCw />{error ? 'Try again' : 'Check device'}</Button>}</div>
          : sessions.length === 0 ? <div className="plaud-recordings-empty"><FileAudio /><h3>No completed recordings returned</h3><p>Finish a recording on the Note Pro, then refresh.</p></div> : <>
            <label className="plaud-select-all"><input type="checkbox" aria-label="Select all new recordings" checked={pending.length > 0 && selected.length === pending.length} ref={node => { if (node) node.indeterminate = selected.length > 0 && selected.length < pending.length }} disabled={busy || !pending.length} onChange={event => setSelected(event.target.checked ? pending.map(session => session.sessionId) : [])} /><span>Select all new</span><small>{sessions.length} on device</small></label>
            <div className="plaud-session-list">{sessions.map(session => <div className="plaud-session" key={session.sessionId}>
              <input type="checkbox" aria-label={`Select recording ${session.sessionId}`} disabled={busy || !!session.recordingId} checked={selected.includes(session.sessionId)} onChange={event => setSelected(current => event.target.checked ? [...current, session.sessionId] : current.filter(id => id !== session.sessionId))} />
              <FileAudio /><div className="plaud-session-name"><strong>{sessionDate(session)}</strong><small>Session {session.sessionId}</small></div><span className="plaud-session-size">{Math.round(session.size / 1024)} KB</span>
              <span className="plaud-session-state" data-imported={!!session.recordingId}>{session.retentionState === 'trash' ? 'In Trash' : session.recordingId ? 'Imported' : 'New'}</span>
              {session.recordingId ? <Button asChild variant="ghost" size="icon"><Link title="Open recording" aria-label={`Open recording ${session.sessionId}`} to={`/recording/${session.recordingId}`}><FolderOpen /></Link></Button> : <IconButton label={`Import recording ${session.sessionId}`} disabled={busy} onClick={() => setConfirmation([session])}>{downloading === session.sessionId ? <Loader2 className="animate-spin" /> : <Download />}</IconButton>}
            </div>)}</div>
          </>}
        {phase === 'downloading' && <div className="plaud-import-progress" role="status"><Loader2 className="animate-spin" /><span>Importing session {downloading}</span><Button variant="ghost" size="sm" onClick={() => void cancel()}><X />Cancel</Button></div>}
      </section>
      <div className="plaud-vault-column">
        <section className="plaud-vault-summary" aria-label="Saved recordings"><header className="plaud-section-heading"><span className="plaud-section-icon"><HardDrive /></span><div><h2>Saved recordings</h2><p>Stored in your desktop vault</p></div><IconButton asChild label="Open saved recordings"><Link to="/recordings"><FolderOpen /></Link></IconButton></header>
          {statsError ? <p className="plaud-muted" role="status">{statsError} <button onClick={loadStats}>Retry</button></p> : <div className="plaud-vault-count"><strong>{stats?.totalRecordings ?? '...'}</strong><span>Total recordings in vault</span>{stats && <small>{stats.totalHours.toFixed(1)} h of audio</small>}</div>}
        </section>
        <DesktopImportPreferences />
      </div>
      <div className="plaud-authorizations"><DesktopAuthorizations /></div>
    </div>
    {confirmation && <NoteDialog title="Import from Plaud" description={`${confirmation.length} recording${confirmation.length === 1 ? '' : 's'}`} busy={false} onClose={() => setConfirmation(null)}>
      <p className="plaud-confirm-copy">Save the selected audio to your OpenPlod vault? Original recordings will stay on your Plaud.</p><ul className="plaud-confirm-list">{confirmation.map(session => <li key={session.sessionId}><FileAudio /><span>{sessionDate(session)}</span><small>{Math.round(session.size / 1024)} KB</small></li>)}</ul>
      <footer><Button variant="ghost" onClick={() => setConfirmation(null)}><X />Cancel</Button><Button onClick={() => void download()}><Download />Import {confirmation.length} recording{confirmation.length === 1 ? '' : 's'}</Button></footer>
    </NoteDialog>}
  </div>
}
