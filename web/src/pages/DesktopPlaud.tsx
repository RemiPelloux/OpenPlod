import { PlaudImportProgress } from '@/components/PlaudImportProgress'
import type { PlaudImportProgress as ImportProgress } from '@/lib/api'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AudioLines, Bluetooth, Check, CheckCircle2, Clock3, Download, FileAudio, FolderOpen, HardDrive, Loader2, Radio, RefreshCw, ShieldCheck, X } from "@/components/icons"
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { NoteDialog } from '@/components/NoteDialogs'
import { DesktopAuthorizations, DesktopImportPreferences } from '@/components/PlaudAuthorization'
import { PlaudCloudImport } from '@/components/PlaudCloudImport'
import { PlaudDeviceAuthorization } from '@/components/PlaudDeviceAuthorization'
import { PlaudSystemCheck } from '@/components/PlaudSystemCheck'
import { api, type DashboardStats, type DeviceRecording, type PlaudStatus } from '@/lib/api'
import { formatDate, t, tn } from '@/i18n'
import './desktop-plaud.css'

const sessionDate = (session: DeviceRecording) => formatDate(session.sessionId * 1000, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })

export function DesktopPlaud() {
  const [status, setStatus] = useState<PlaudStatus | null>(null)
  const [phase, setPhase] = useState<'idle' | 'scanning' | 'listing' | 'downloading' | 'cancelling'>('idle')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [sessions, setSessions] = useState<DeviceRecording[] | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [confirmation, setConfirmation] = useState<DeviceRecording[] | null>(null)
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null)
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
      .catch(() => { if (mounted.current) setStatsError(t('Vault summary unavailable')) })
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
      if (mounted.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : t('Bluetooth scan failed.'))
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
        controller.signal.throwIfAborted(); setDownloading(session.sessionId); setImportProgress(null)
        const id = await api.importDeviceRecording(session.sessionId, controller.signal, progress => { if (mounted.current && !controller.signal.aborted) setImportProgress(progress) })
        if (controller.signal.aborted) return
        saved++
        setSessions(current => current?.map(item => item.sessionId === session.sessionId ? { ...item, recordingId: id, retentionState: 'active' } : item) ?? null)
        setSelected(current => current.filter(value => value !== session.sessionId))
        setNotice(tn(saved, '{count} recording saved to your vault', '{count} recordings saved to your vault'))
        window.dispatchEvent(new CustomEvent('plaud:sync-complete'))
      }
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : t('Download failed'))
    } finally {
      if (active.current === controller && !cancelling.current) { active.current = null; if (mounted.current) { setPhase('idle'); setDownloading(null) } }
    }
  }
  const cancel = async () => {
    if (cancelling.current) return
    cancelling.current = true; setPhase('cancelling')
    active.current?.abort()
    try { await api.cancelDeviceOperation(); if (mounted.current) setNotice(t('Operation cancelled. Recordings already saved remain in the vault.')) }
    catch { if (mounted.current) setError(t('Could not confirm cancellation. Check the library before retrying.')) }
    finally { cancelling.current = false; active.current = null; if (mounted.current) { setPhase('idle'); setDownloading(null) } }
  }

  const access = sessions !== null
  const statusLabel = phase === 'cancelling' ? t('Cancelling') : phase === 'scanning' ? t('Searching nearby') : phase === 'listing' ? t('Reading device') : phase === 'downloading' ? t('Importing audio') : access ? t('Access verified') : status?.deviceDetected ? t('Device detected') : status ? t('Not detected') : t('Not connected')
  const states = [
    { icon: Radio, name: t('Bluetooth discovery'), value: status ? status.deviceDetected ? t('Detected') : t('Not detected') : phase === 'scanning' ? t('Searching') : t('Not checked'), ok: !!status?.deviceDetected },
    { icon: Bluetooth, name: t('Bluetooth connection'), value: access || status?.connectionVerified ? t('Verified') : t('Not verified'), ok: access || !!status?.connectionVerified },
    { icon: FileAudio, name: t('Recording access'), value: access ? t('Verified') : phase === 'listing' ? t('Checking') : t('Unknown'), ok: access },
    { icon: ShieldCheck, name: t('Device authorization'), value: status ? status.directTransferAvailable ? t('Configured') : t('Not configured') : t('Not checked'), ok: !!status?.directTransferAvailable },
    { icon: AudioLines, name: t('Recordings found'), value: sessions === null ? t('Unknown') : String(sessions.length), ok: access },
  ]

  return <div className="plaud-workspace">
    <header className="plaud-page-heading"><div className="plaud-page-title"><span className="plaud-heading-icon"><Bluetooth /></span><div><h1>Plaud Note Pro</h1><p>{t('Device, recordings & imports')}</p></div></div>
      <div className="plaud-status-strip" role="status"><span className="plaud-state" data-verified={access}><i />{statusLabel}</span>{checkedAt && <span className="plaud-checked"><Clock3 />{t('Checked {time}', { time: formatDate(checkedAt, { hour: '2-digit', minute: '2-digit' }) })}</span>}</div>
    </header>
    {(error || notice) && <div className={`plaud-feedback ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>{error ? <Radio /> : <Check />}<span>{error || notice}</span><IconButton label={t('Dismiss device message')} onClick={() => { setError(''); setNotice('') }}><X /></IconButton></div>}
    <div className="plaud-workspace-grid">
      <section className="plaud-device-overview" aria-label={t('Desktop Plaud connection')}>
        <div className="plaud-product-image"><img src="/plaud-note-pro.png" alt={t('Plaud Note Pro recorder')} width="220" height="280" /></div>
        <div className="plaud-device-info"><h2>{status?.deviceName || 'Plaud Note Pro'}</h2><p>{t('AI voice recorder')}</p>
          <dl><div><dt><Bluetooth />Bluetooth</dt><dd className="plaud-state" data-verified={access}><i />{statusLabel}</dd></div><div><dt><FileAudio />{t('On device')}</dt><dd>{sessions === null ? t('Unknown') : tn(sessions.length, '{count} recording', '{count} recordings')}</dd></div><div><dt><ShieldCheck />{t('Original audio')}</dt><dd>{t('Kept on Plaud')}</dd></div></dl>
          <div className="plaud-connect-actions"><Button disabled={busy} onClick={() => void scan()}>{busy ? <Loader2 className="animate-spin" /> : status ? <RefreshCw /> : <Bluetooth />}{phase === 'scanning' ? t('Connecting') : phase === 'listing' ? t('Reading recordings') : status ? t('Refresh recordings') : t('Connect Note Pro')}</Button>
            {busy && <IconButton label={t('Cancel device operation')} onClick={() => void cancel()}><X /></IconButton>}</div>
          <div className="plaud-secondary-actions"><Button size="sm" variant="outline" disabled={busy || !pending.length} onClick={() => setConfirmation(pending)}><Download />{t('Import new')}</Button><Button asChild variant="outline" size="sm"><Link to="/recordings"><FolderOpen />{t('Open library')}</Link></Button></div>
        </div>
      </section>
      <section className="plaud-health" aria-label={t('Connection health')}><header className="plaud-section-heading"><span className="plaud-section-icon"><ShieldCheck /></span><div><h2>{t('Connection health')}</h2><p>{access ? t('Recording list verified on this computer') : t('Awaiting verified device access')}</p></div>{access && <CheckCircle2 className="plaud-positive" />}</header>
        <dl>{states.map(({ icon: Icon, name, value, ok }) => <div key={name}><dt><Icon />{name}</dt><dd className="plaud-state" data-verified={ok}><i />{value}</dd></div>)}</dl>
        {status?.detail && <details className="plaud-diagnostics"><summary>{t('Connection details')}</summary><p>{status.detail}</p></details>}
      </section>
      <section className="plaud-device-recordings" aria-label={t('Recordings on Note Pro')} ref={recordingSection}>
        <header className="plaud-section-heading"><span className="plaud-section-icon"><FileAudio /></span><div><h2>{t('On your Note Pro')}</h2><p>{sessions === null ? t('Recording count unknown') : tn(sessions.length, '{count} recording / {pending} new', '{count} recordings / {pending} new', { pending: pending.length })}</p></div><Button size="sm" disabled={busy || !selected.length} onClick={() => setConfirmation(pending.filter(session => selected.includes(session.sessionId)))}><Download /><span>{selected.length ? t('Import selected ({count})', { count: selected.length }) : t('Import selected')}</span></Button></header>
        {sessions === null ? <div className="plaud-recordings-empty">{busy ? <Loader2 className="animate-spin" /> : <Bluetooth />}<h3>{busy ? t('Reading your Note Pro') : t('Connect to see recordings')}</h3><p>{status && !status.directTransferAvailable ? t('Device authorization is not configured on this computer.') : error ? t('The device list is unavailable. No recording count has been reported.') : t('No recording list has been received yet.')}</p>{!busy && <Button variant="outline" size="sm" onClick={() => void scan()}><RefreshCw />{error ? t('Try again') : t('Check device')}</Button>}</div>
          : sessions.length === 0 ? <div className="plaud-recordings-empty"><FileAudio /><h3>{t('No completed recordings returned')}</h3><p>{t('Finish a recording on the Note Pro, then refresh.')}</p></div> : <>
            <label className="plaud-select-all"><input type="checkbox" aria-label={t('Select all new recordings')} checked={pending.length > 0 && selected.length === pending.length} ref={node => { if (node) node.indeterminate = selected.length > 0 && selected.length < pending.length }} disabled={busy || !pending.length} onChange={event => setSelected(event.target.checked ? pending.map(session => session.sessionId) : [])} /><span>{t('Select all new')}</span><small>{t('{count} on device', { count: sessions.length })}</small></label>
            <div className="plaud-session-list">{sessions.map(session => <div className="plaud-session" key={session.sessionId}>
              <input type="checkbox" aria-label={t('Select recording {id}', { id: session.sessionId })} disabled={busy || !!session.recordingId} checked={selected.includes(session.sessionId)} onChange={event => setSelected(current => event.target.checked ? [...current, session.sessionId] : current.filter(id => id !== session.sessionId))} />
              <FileAudio /><div className="plaud-session-name"><strong>{sessionDate(session)}</strong><small>{t('Session {id}', { id: session.sessionId })}</small></div><span className="plaud-session-size">{t('{value} KB', { value: Math.round(session.size / 1024) })}</span>
              <span className="plaud-session-state" data-imported={!!session.recordingId}>{session.retentionState === 'trash' ? t('In Trash') : session.recordingId ? t('Imported') : t('New')}</span>
              {session.recordingId ? <Button asChild variant="ghost" size="icon"><Link title={t('Open recording')} aria-label={t('Open recording {id}', { id: session.sessionId })} to={`/recording/${session.recordingId}`}><FolderOpen /></Link></Button> : <IconButton label={t('Import recording {id}', { id: session.sessionId })} disabled={busy} onClick={() => setConfirmation([session])}>{downloading === session.sessionId ? <Loader2 className="animate-spin" /> : <Download />}</IconButton>}
            </div>)}</div>
          </>}
        {phase === 'downloading' && <div className="plaud-import-progress" role="status"><PlaudImportProgress progress={importProgress} sessionId={downloading} /><Button variant="ghost" size="sm" onClick={() => void cancel()}><X />{t('Cancel')}</Button></div>}
      </section>
      <div className="plaud-vault-column">
        <section className="plaud-vault-summary" aria-label={t('Saved recordings')}><header className="plaud-section-heading"><span className="plaud-section-icon"><HardDrive /></span><div><h2>{t('Saved recordings')}</h2><p>{t('Stored in your desktop vault')}</p></div><IconButton asChild label={t('Open saved recordings')}><Link to="/recordings"><FolderOpen /></Link></IconButton></header>
          {statsError ? <p className="plaud-muted" role="status">{statsError} <button onClick={loadStats}>{t('Retry')}</button></p> : <div className="plaud-vault-count"><strong>{stats?.totalRecordings ?? '...'}</strong><span>{t('Total recordings in vault')}</span>{stats && <small>{t('{hours} h of audio', { hours: stats.totalHours.toFixed(1) })}</small>}</div>}
        </section>
        <DesktopImportPreferences />
      </div>
      <div className="plaud-authorizations"><PlaudSystemCheck /><PlaudCloudImport /><PlaudDeviceAuthorization status={status} onAuthorized={() => void scan()} /><DesktopAuthorizations /></div>
    </div>
    {confirmation && <NoteDialog title={t('Import from Plaud')} description={tn(confirmation.length, '{count} recording', '{count} recordings')} busy={false} onClose={() => setConfirmation(null)}>
      <p className="plaud-confirm-copy">{t('Save the selected audio to your OpenPlod vault? Original recordings will stay on your Plaud.')}</p><ul className="plaud-confirm-list">{confirmation.map(session => <li key={session.sessionId}><FileAudio /><span>{sessionDate(session)}</span><small>{t('{value} KB', { value: Math.round(session.size / 1024) })}</small></li>)}</ul>
      <footer><Button variant="ghost" onClick={() => setConfirmation(null)}><X />{t('Cancel')}</Button><Button onClick={() => void download()}><Download />{tn(confirmation.length, 'Import {count} recording', 'Import {count} recordings')}</Button></footer>
    </NoteDialog>}
  </div>
}
