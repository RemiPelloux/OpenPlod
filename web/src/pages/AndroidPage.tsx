import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { QRCodeSVG } from 'qrcode.react'
import { Bluetooth, Check, ChevronRight, Copy, HardDrive, Loader2, Monitor, RefreshCw, ShieldCheck, Smartphone, Unplug } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { NoteDialog } from '@/components/NoteDialogs'
import { apiUrl, authenticatedHeaders, forgetMobilePairing, getRuntime } from '@/lib/runtime'
import './android.css'

export function AndroidPage() {
  const runtime = getRuntime()
  const desktop = runtime.mode === 'desktop'
  const mobile = runtime.mode === 'mobile'
  const canPair = desktop && !!runtime.lanAddress && !!runtime.pairingToken
  const [revealed, setRevealed] = useState(false)
  const [forgetting, setForgetting] = useState(false)
  const [check, setCheck] = useState(0)
  const [health, setHealth] = useState<'checking' | 'available' | 'unavailable'>('checking')
  useEffect(() => {
    const controller = new AbortController()
    fetch(apiUrl('/info'), { headers: authenticatedHeaders(), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) })
      .then(async response => {
        if (!response.ok || (await response.json()).status !== 'ok') throw new Error('Unavailable')
        if (!controller.signal.aborted) setHealth('available')
      }).catch(() => { if (!controller.signal.aborted) setHealth('unavailable') })
    return () => controller.abort()
  }, [check])
  useEffect(() => {
    if (!revealed) return
    const hide = () => { if (document.hidden) setRevealed(false) }
    const timer = window.setTimeout(() => setRevealed(false), 60000)
    document.addEventListener('visibilitychange', hide)
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', hide) }
  }, [revealed])
  return <div className="android-page">
    <header className="android-heading"><div><h1>Android</h1><span>Connections</span></div><IconButton label="Check vault connection" disabled={health === 'checking'} onClick={() => { setHealth('checking'); setCheck(v => v + 1) }}>{health === 'checking' ? <Loader2 className="animate-spin" /> : <RefreshCw />}</IconButton></header>
    <div className="android-workspace">
      <section className="android-pairing" aria-labelledby="android-pairing-title">
        <div className="android-section-title"><Smartphone /><div><h2 id="android-pairing-title">{mobile ? 'Paired desktop' : 'Pair your phone'}</h2><p>{desktop ? 'Local network / Private vault' : mobile ? 'Desktop vault connection' : 'Desktop app required'}</p></div></div>
        {desktop ? <>
          <div className="android-qr-area">
            {revealed && canPair ? <div className="android-qr" aria-label="Private pairing QR code"><QRCodeSVG value={JSON.stringify({ type: 'openplod-pairing', version: 1, origin: runtime.lanAddress, token: runtime.pairingToken })} size={200} marginSize={3} level="M" /></div> : <div className="android-qr-hidden"><ShieldCheck /><span>{canPair ? 'Private pairing code' : 'Network address unavailable'}</span></div>}
            <Button variant={revealed ? 'outline' : 'default'} disabled={!canPair} onClick={() => setRevealed(v => !v)}><Smartphone />{revealed ? 'Hide pairing QR' : 'Show pairing QR'}</Button>
          </div>
          <p className="android-privacy">The pairing code grants access to your vault. Share it only with a trusted phone on your local network.</p>
          <details className="android-manual"><summary>Manual connection</summary><ConnectionValue label="Desktop address" value={runtime.lanAddress || ''} /><ConnectionValue label="Private pairing code" value={runtime.pairingToken} secret /></details>
        </> : mobile ? <>
          <ConnectionValue label="Desktop address" value={runtime.serviceOrigin} />
          <Button variant="outline" onClick={() => setForgetting(true)}><Unplug />Forget desktop</Button>
        </> : <div className="android-browser-state"><Monitor /><h3>Open OpenPlod on your Mac</h3><p>Pairing credentials are available only in the installed app.</p><a href="https://github.com/RemiPelloux/OpenPlod/releases" target="_blank" rel="noreferrer">Releases & build instructions<ChevronRight /></a></div>}
      </section>
      <aside className="android-details" aria-label="Connection details">
        <section><div className="android-section-title"><HardDrive /><h2>Recording vault</h2></div><dl><div><dt>Service</dt><dd className={`android-health ${health}`} role="status">{health === 'checking' ? 'Checking...' : health === 'available' ? 'Reachable' : 'Unavailable'}</dd></div><div><dt>Access</dt><dd>{mobile ? 'Paired desktop' : desktop ? 'This Mac' : 'Browser'}</dd></div>{desktop && <div><dt>Phone connection</dt><dd>Not monitored</dd></div>}</dl>{health === 'unavailable' && <p className="android-status-error" role="alert">The vault did not respond. Check the desktop app and network, then retry.</p>}</section>
        <section><div className="android-section-title"><Bluetooth /><h2>Plaud Note Pro</h2></div><Link className="android-destination" to="/devices"><span>Device access<small>Bluetooth & recordings</small></span><ChevronRight /></Link></section>
        <section><div className="android-section-title"><ShieldCheck /><h2>Storage & privacy</h2></div><dl><div><dt>Original audio</dt><dd>Desktop vault</dd></div><div><dt>Mobile storage</dt><dd>Local cache & queue</dd></div></dl></section>
      </aside>
    </div>
    {forgetting && <NoteDialog title="Forget this desktop?" description="Local pairing credentials will be removed. Recordings in the desktop vault are not deleted." onClose={() => setForgetting(false)}><footer><Button variant="ghost" onClick={() => setForgetting(false)}>Cancel</Button><Button variant="destructive" onClick={() => { forgetMobilePairing(); window.location.reload() }}><Unplug />Forget desktop</Button></footer></NoteDialog>}
  </div>
}

function ConnectionValue({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  return <div className="android-value"><label>{label}</label><div><code>{value ? secret ? '************************' : value : 'Unavailable'}</code><IconButton label={copied ? `${label} copied` : `Copy ${label}`} disabled={!value} onClick={async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setError(''); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 2000) }
    catch { setError('Clipboard unavailable.') }
  }}>{copied ? <Check /> : <Copy />}</IconButton></div>{error && <p role="alert">{error}</p>}</div>
}
