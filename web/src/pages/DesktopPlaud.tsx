import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bluetooth, Download, FileAudio, Loader2, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api, type DeviceRecording, type PlaudStatus } from '@/lib/api'
import './desktop-plaud.css'

export function DesktopPlaud() {
  const [status, setStatus] = useState<PlaudStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sessions, setSessions] = useState<DeviceRecording[] | null>(null)
  const [downloading, setDownloading] = useState<number | null>(null)
  const mounted = useRef(true)
  const scanning = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const scan = async () => {
    if (scanning.current) return
    scanning.current = true
    setBusy(true); setError(''); setStatus(null); setSessions(null)
    try {
      const result = await api.getPlaudStatus()
      if (mounted.current) setStatus(result)
      if (result.directTransferAvailable) {
        const files = await api.getDeviceRecordings()
        if (mounted.current) setSessions(files)
      }
    }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Bluetooth scan failed.') }
    finally { scanning.current = false; if (mounted.current) setBusy(false) }
  }

  const download = async (session: DeviceRecording) => {
    if (downloading !== null || !window.confirm('Download this recording to OpenPlod? The original will remain on your Plaud.')) return
    setDownloading(session.sessionId); setError('')
    try {
      const id = await api.importDeviceRecording(session.sessionId)
      if (mounted.current) setSessions(current => current?.map(item => item.sessionId === session.sessionId ? { ...item, recordingId: id, retentionState: 'active' } : item) ?? null)
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Download failed') }
    finally { if (mounted.current) setDownloading(null) }
  }

  return <div className="desktop-plaud">
    <section className="device-connection" aria-label="Desktop Plaud connection">
      <div><h2>{busy ? 'Scanning nearby...' : status?.deviceDetected ? status.deviceName || 'Plaud detected' : 'Note Pro connection'}</h2>
        <p>{status ? status.deviceDetected ? 'Detected on this Mac' : 'Not detected in this scan' : 'Bluetooth on this Mac'}</p></div>
      <Button disabled={busy || downloading !== null} onClick={() => void scan()}>{busy ? <Loader2 className="animate-spin" /> : status ? <RefreshCw /> : <Bluetooth />}{busy ? 'Connecting' : status ? 'Refresh recordings' : 'Connect Note Pro'}</Button>
    </section>
    {error && <p className="device-error" role="alert">{error}</p>}
    {status && <p className="desktop-probe-detail" role="status">{status.detail}</p>}
    <dl className="desktop-device-states">
      <div><dt>Bluetooth discovery</dt><dd>{busy ? 'Scanning' : status ? status.deviceDetected ? 'Nearby' : 'Not detected' : 'Not checked'}</dd></div>
      <div><dt>Bluetooth connection</dt><dd>{status?.connectionVerified ? 'Verified' : 'Not verified'}</dd></div>
      <div><dt>Recording access</dt><dd>{sessions !== null ? 'Verified' : busy ? 'Connecting' : 'Not verified'}</dd></div>
      <div><dt>Recordings on Note Pro</dt><dd>{sessions === null ? 'Unknown' : sessions.length}</dd></div>
    </dl>
    <section className="desktop-device-access">
      <h2>On your Note Pro</h2>
      {sessions === null ? <p>{status && !status.directTransferAvailable ? 'Device authorization is not configured on this Mac.' : 'Recording list not loaded.'}</p>
        : sessions.length === 0 ? <p>No completed recordings returned by the device.</p>
        : <div className="desktop-session-list">{sessions.map(session => <div className="desktop-session" key={session.sessionId}>
          <FileAudio aria-hidden="true" /><div><strong>Recording {session.sessionId}</strong><span>{Math.round(session.size / 1024)} KiB{session.retentionState === 'trash' ? ' / In Trash' : session.recordingId ? ' / In vault' : ''}</span></div>
          {session.recordingId ? <Button variant="outline" asChild><Link to={`/recording/${session.recordingId}`}>Open recording</Link></Button>
            : <Button disabled={busy || downloading !== null} onClick={() => void download(session)}>{downloading === session.sessionId ? <Loader2 className="animate-spin" /> : <Download />}Download</Button>}
        </div>)}</div>}
      {(busy || downloading !== null) && <Button variant="ghost" onClick={() => void api.cancelDeviceOperation().catch(() => setError('Could not cancel the device operation'))}><X />Cancel</Button>}
    </section>
    <section className="desktop-vault-link">
      <FileAudio aria-hidden="true" /><div><h2>Saved recordings</h2><p>Audio already stored in your desktop vault</p></div>
      <Button asChild variant="outline"><Link to="/">Open library</Link></Button>
    </section>
  </div>
}
