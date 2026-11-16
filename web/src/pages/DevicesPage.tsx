import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bluetooth, RefreshCw, Download, Play, Square, UploadCloud, Loader2, Check, Unplug, X, Share2 } from "@/components/icons"
import { Button } from '@/components/ui/button'
import { deviceCommand, supportsPlaudDevice, vaultArguments, type DeviceSnapshot } from '@/lib/plaud-device'
import { formatDuration } from '@/lib/utils'
import { DesktopPlaud } from './DesktopPlaud'
import { plaudModelFromSerial, plaudModelName } from '@/lib/plaud-model'
import { PhoneAuthorization } from '@/components/PlaudAuthorization'
import { formatDate, t } from '@/i18n'

export function DevicesPage() {
  const supported = supportsPlaudDevice()
  const [snapshot, setSnapshot] = useState<DeviceSnapshot | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const mounted = useRef(true)
  const queue = useRef(0)
  const running = useRef(false)

  const refresh = useCallback(async () => {
    const result = await deviceCommand('snapshot')
    if (mounted.current) setSnapshot(result)
    return result
  }, [])

  useEffect(() => {
    mounted.current = true
    const queueRef = queue
    return () => { mounted.current = false; queueRef.current++ }
  }, [])

  useEffect(() => {
    if (!supported) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await deviceCommand('snapshot')
        if (!disposed) setSnapshot(result)
      } catch (failure) { if (!disposed) setError(String(failure)) }
      if (!disposed) timer = setTimeout(poll, document.hidden ? 5000 : 1000)
    }
    void poll()
    return () => { disposed = true; clearTimeout(timer) }
  }, [supported])

  const run = async (label: string, action: () => Promise<unknown>) => {
    if (running.current) return
    running.current = true
    setBusy(label); setError('')
    try { await action(); await refresh() }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { running.current = false; if (mounted.current) setBusy('') }
  }

  const connect = () => run('Connecting', async () => {
    await deviceCommand('permissions')
    await deviceCommand('initialize', vaultArguments())
    await deviceCommand('scan')
  })

  const downloadSelected = () => run('Downloading', async () => {
    const attempt = ++queue.current
    for (const sessionId of selected) {
      if (queue.current !== attempt) return
      await deviceCommand('download', { sessionId })
      let current = await refresh()
      const deadline = Date.now() + 16 * 60_000
      while (current.busy) {
        if (queue.current !== attempt) return
        if (Date.now() > deadline) throw new Error(t('Download status timed out. Reconnect and check the saved recordings.'))
        await new Promise(resolve => setTimeout(resolve, 1000))
        current = await refresh()
      }
      if (current.error) throw new Error(current.error)
      if (!current.localRecordings.some(row => row.sourceRecordingId === `${current.serial}:${sessionId}`)) {
        throw new Error(t('The recording has not been saved on this phone. Reconnect and retry.'))
      }
      if (mounted.current) setSelected(values => values.filter(id => id !== sessionId))
    }
  })

  const cancelDownload = async () => {
    queue.current++
    try { await deviceCommand('cancel'); await refresh() }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
  }

  const upload = (sourceRecordingId: string) => run('Sending to vault', async () => {
    await deviceCommand('upload', { ...vaultArguments(), sourceRecordingId })
    window.dispatchEvent(new CustomEvent('plaud:sync-complete'))
  })

  const device = plaudModelName(plaudModelFromSerial(snapshot?.serial)) ?? t('Plaud recorder')
  const localIds = new Set(snapshot?.localRecordings.map(row => row.sourceRecordingId))
  const connecting = snapshot?.busy
  const status = !snapshot ? t('Checking connection...') : snapshot.state === 'ready'
    ? snapshot.listLoaded ? t('{count} on device', { count: snapshot.files.length }) : t('Reading recordings...')
    : snapshot?.state === 'connecting' ? t('Authenticating {device}...', { device })
      : snapshot?.state === 'scanning' ? t('Searching nearby...')
        : snapshot?.state === 'authenticating' ? t('Verifying device authorization...') : t('Disconnected')

  if (!supported) return <DesktopPlaud />

  return <div className="device-page">
    <header className="device-heading"><div><h1>Plaud</h1><p>{device}</p></div><Bluetooth aria-hidden="true" /></header>
    <>
      {snapshot && !snapshot.configured && <PhoneAuthorization onDone={() => void refresh()} />}
      <section className="device-connection" aria-label={t('Plaud connection')}>
        <div><h2>{status}</h2><p>{snapshot?.serial || device}{snapshot?.battery != null ? ` · ${t('{percent}% battery', { percent: snapshot.battery })}` : ''}</p></div>
        {snapshot?.state === 'ready' ? <div className="device-actions">
          <Button variant="ghost" size="icon" disabled={!!busy || snapshot.downloading} title={t('Refresh device recordings')} aria-label={t('Refresh device recordings')} onClick={() => void run('Refreshing', () => deviceCommand('refresh'))}><RefreshCw /></Button>
          <Button variant="ghost" size="icon" disabled={!!busy || snapshot.downloading} title={t('Disconnect device')} aria-label={t('Disconnect device')} onClick={() => void run('Disconnecting', () => deviceCommand('disconnect'))}><Unplug /></Button>
        </div> : <Button disabled={!!busy || connecting || !snapshot?.configured} onClick={() => void connect()}>{busy || connecting ? <Loader2 className="animate-spin" /> : <Bluetooth />}{t('Connect directly')}</Button>}
      </section>
      {snapshot?.configured && <label className="device-recording-row"><input type="checkbox" checked={snapshot.autoImport} disabled={!!busy} onChange={e => void run('Updating import settings', async () => { await deviceCommand('permissions'); await deviceCommand('autoImport', { enabled: e.target.checked }) })} /><span><strong>{t('Automatic imports')}</strong><small>{t('All new completed recordings. Originals retained on Plaud.')}</small></span></label>}
      {snapshot?.lastNotice && <p className="device-muted" role="status">{snapshot.lastNotice}</p>}
      {(error || snapshot?.error) && <p className="device-error" role="alert">{error || snapshot?.error}</p>}
      {(snapshot?.state === 'scanning' || snapshot?.state === 'disconnected') && snapshot.devices.map(device => <button key={device.serial} className="device-scan-result" disabled={!!busy} onClick={() => { setSelected([]); void run('Authenticating', () => deviceCommand('connect', { serial: device.serial })) }}>
        <Bluetooth /><span>{device.name}<small>{device.serial}</small></span><span>{t('Connect')}</span>
      </button>)}
      {snapshot?.state === 'ready' && <section className="device-section">
        <div className="device-section-heading"><h2>{t('On {device}', { device })}</h2><Button size="sm" disabled={!!busy || selected.length === 0 || snapshot.downloading} onClick={() => void downloadSelected()}><Download />{selected.length ? t('Download ({count})', { count: selected.length }) : t('Download')}</Button></div>
        {!snapshot.listLoaded ? <p className="device-muted">{snapshot.error ? t('Recording list unavailable') : t('Reading device storage...')}</p> : snapshot.files.length === 0 ? <p className="device-muted">{t('No completed recordings returned by the device.')}</p> : snapshot.files.map(file => {
          const downloaded = localIds.has(`${snapshot.serial}:${file.sessionId}`)
          return <label className="device-recording-row" key={file.sessionId}>
            <input type="checkbox" disabled={downloaded || !!busy || snapshot.downloading} checked={selected.includes(file.sessionId)} onChange={event => setSelected(values => event.target.checked ? [...values, file.sessionId] : values.filter(id => id !== file.sessionId))} />
            <span><strong>{formatDate(Number(file.sessionId) * 1000)}</strong><small>{t('{value} KB', { value: (file.size / 1024).toFixed(0) })}</small></span>
            {downloaded && <Check aria-label={t('Downloaded')} />}
          </label>
        })}
      </section>}
      {snapshot?.downloading && <div className="device-progress" role="status"><span>{t('Downloading audio')}</span><progress aria-label={t('Audio download')} max={100} value={snapshot.progress} /><span>{snapshot.progress}%</span><Button size="icon" variant="ghost" aria-label={t('Cancel download')} title={t('Cancel download')} onClick={() => void cancelDownload()}><X /></Button></div>}
      <section className="device-section">
        <div className="device-section-heading"><h2>{t('On this phone')}</h2><span>{snapshot?.localRecordings.length ?? '...'}</span></div>
        {snapshot?.localRecordings.map(row => <article className="device-recording-row" key={row.sourceRecordingId}>
          <Button size="icon" variant="ghost" disabled={!!busy} title={snapshot.playingId === row.sourceRecordingId ? t('Stop playback') : t('Play recording')} aria-label={snapshot.playingId === row.sourceRecordingId ? t('Stop playback') : t('Play recording')} onClick={() => void run('Playback', () => deviceCommand(snapshot.playingId === row.sourceRecordingId ? 'stopPlayback' : 'play', { sourceRecordingId: row.sourceRecordingId }))}>{snapshot.playingId === row.sourceRecordingId ? <Square /> : <Play />}</Button>
          <span><strong>{formatDate(row.recordedAt)}</strong><small>{formatDuration(row.durationMs / 1000)} · {row.desktopRecordingId ? t('In desktop vault') : row.lastUploadError ? t('Saved on phone · upload failed ({attempts}x): {error}', { attempts: row.uploadAttempts ?? 1, error: row.lastUploadError }) : t('Saved on phone')}</small></span>
          <Button size="icon" variant="ghost" disabled={!!busy} title={t('Export audio')} aria-label={t('Export audio')} onClick={() => void run('Exporting', () => deviceCommand('exportRecording', { sourceRecordingId: row.sourceRecordingId }))}><Share2 /></Button>
          {row.desktopRecordingId ? <Button asChild size="sm" variant="ghost"><Link to={`/recording/${row.desktopRecordingId}`}>{t('Open')}</Link></Button> : <Button size="icon" variant="ghost" disabled={!!busy} title={t('Store in desktop vault')} aria-label={t('Store in desktop vault')} onClick={() => void upload(row.sourceRecordingId)}><UploadCloud /></Button>}
        </article>)}
        {snapshot?.localRecordings.length === 0 && <p className="device-muted">{t('No downloaded recordings yet.')}</p>}
      </section>
    </>
  </div>
}
