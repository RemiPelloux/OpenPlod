import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import * as Switch from '@radix-ui/react-switch'
import { Check, Download, FileText, KeyRound, Loader2, Settings2, ShieldCheck, Smartphone, Speech, X } from "@/components/icons"
import { Button } from './ui/button'
import { api, type Settings } from '@/lib/api'
import { apiUrl, authenticatedHeaders } from '@/lib/runtime'
import { deviceCommand, vaultArguments } from '@/lib/plaud-device'
import { formatDate, t } from '@/i18n'

async function plaudRequest<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(apiUrl(`/plaud${path}`), { method: method || (body ? 'POST' : 'GET'),
    headers: authenticatedHeaders({ 'Content-Type': 'application/json' }), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) })
  const result = await response.json()
  if (!response.ok || !result.success) throw new Error(result.error || t('Plaud request failed.'))
  return result.data
}
type Enrollment = { id: string; name: string; code: string; expiresAt: number; state: string }
type AutoImportStatus = { enabled: boolean; running: boolean; lastChecked: string | null; error: string | null; events: { id: number; recordingId: string; createdAt: string }[] }
export function DesktopImportPreferences() {
  const [state, setState] = useState<AutoImportStatus | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [settings, setSettings] = useState<Settings | null>(null)
  useEffect(() => { let stopped = false; api.getSettings().then(value => { if (!stopped) setSettings(value) }).catch(e => { if (!stopped) setError((e as Error).message) }); return () => { stopped = true } }, [])
  useEffect(() => {
    let stopped = false
    const poll = async () => { try { const next = await plaudRequest<AutoImportStatus>('/auto-import'); if (!stopped) setState(next) } catch (e) { if (!stopped) setError((e as Error).message) } }
    void poll(); const timer = setInterval(() => void poll(), 10000); return () => { stopped = true; clearInterval(timer) }
  }, [])
  const toggle = async (enabled: boolean) => {
    setBusy(true); setError('')
    try { setState(await plaudRequest<AutoImportStatus>('/auto-import', { enabled }, 'PATCH')) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const updateProcessing = async (key: 'autoTranscribe' | 'autoSummarize', enabled: boolean) => {
    setBusy(true); setError('')
    try { setSettings(await api.updateSettings({ [key]: enabled })) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <section className="device-section plaud-preferences"><div className="device-section-heading"><Settings2 /><h2>{t('Import preferences')}</h2></div>
    <label className="plaud-preference-row"><Download /><span><strong>{t('Automatically import new recordings')}</strong><small>{t('Check every minute while OpenPlod is running')}</small></span><Switch.Root className="plaud-switch" aria-label={t('Automatically import new recordings')} checked={state?.enabled || false} disabled={busy || !state} onCheckedChange={enabled => void toggle(enabled)}><Switch.Thumb /></Switch.Root></label>
    <div className="plaud-preference-row"><ShieldCheck /><span><strong>{t('Keep originals on device')}</strong><small>{t('Direct imports never delete Plaud audio')}</small></span><Check className="plaud-positive" aria-label={t('Always retained')} /></div>
    <label className="plaud-preference-row"><Speech /><span><strong>{t('Transcribe after import')}</strong><small>{settings?.openWhistleForwarding ? t('Processing is managed by OpenWhistle') : t('Use your configured transcription provider')}</small></span><Switch.Root className="plaud-switch" aria-label={t('Transcribe after import')} checked={settings?.autoTranscribe || false} disabled={busy || !settings || settings.openWhistleForwarding} onCheckedChange={enabled => void updateProcessing('autoTranscribe', enabled)}><Switch.Thumb /></Switch.Root></label>
    <label className="plaud-preference-row"><FileText /><span><strong>{t('Summarize after transcription')}</strong><small>{t('Generate an AI summary when transcription finishes')}</small></span><Switch.Root className="plaud-switch" aria-label={t('Summarize after transcription')} checked={settings?.autoSummarize || false} disabled={busy || !settings || settings.openWhistleForwarding} onCheckedChange={enabled => void updateProcessing('autoSummarize', enabled)}><Switch.Thumb /></Switch.Root></label>
    {state?.running && <p role="status" className="device-muted">{t('Checking and importing recordings...')}</p>}
    {state?.lastChecked && <p className="device-muted">{t('Last checked {time}', { time: formatDate(state.lastChecked, { timeStyle: 'medium' }) })}</p>}
    {(error || state?.error) && <p className="device-error" role="alert">{error || state?.error}</p>}
    {state?.events.slice(0, 3).map(event => <p className="device-muted" key={event.id}>{t('Saved to vault / {date}', { date: formatDate(event.createdAt) })}</p>)}
  </section>
}

export function PhoneAuthorization({ onDone }: { onDone: () => void }) {
  const [request, setRequest] = useState<Enrollment | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async () => {
    setBusy(true); setError('')
    try {
      if (!request || request.expiresAt <= Date.now()) setRequest(await deviceCommand<Enrollment>('requestAuthorization', vaultArguments()))
      else { await deviceCommand('finishAuthorization', vaultArguments()); onDone() }
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <section className="device-section" aria-label={t('Authorize phone')}>
    <div className="device-section-heading"><h2><KeyRound className="inline size-4 mr-2" />{t('Add your Plaud recorder')}</h2></div>
    <p className="device-muted">{request ? t('On your desktop, open Plaud device and approve this verification code.') : t('Authorize this phone once from your paired desktop. Audio will download directly over this phone\'s Bluetooth.')}</p>
    {request && <p className="text-2xl font-mono py-4" aria-label={t('Verification code')}>{request.code}</p>}
    {error && <p role="alert" className="device-error">{error}</p>}
    <Button disabled={busy} onClick={() => void run()}>{busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}{request && request.expiresAt > Date.now() ? t('I approved on my desktop') : t('Request authorization')}</Button>
  </section>
}

export function DesktopAuthorizations() {
  const [requests, setRequests] = useState<Enrollment[]>([])
  const [codes, setCodes] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  useEffect(() => {
    let stopped = false
    const poll = async () => { try { const rows = await plaudRequest<Enrollment[]>('/authorizations'); if (!stopped) setRequests(rows.filter(r => r.state === 'pending')) } catch (e) { if (!stopped) setError((e as Error).message) } }
    void poll(); const timer = setInterval(() => void poll(), 5000)
    return () => { stopped = true; clearInterval(timer) }
  }, [])
  const act = async (request: Enrollment, approve: boolean) => {
    setBusy(request.id); setError('')
    try { await plaudRequest(`/authorizations/${request.id}${approve ? '/approve' : ''}`, approve ? { confirm: true, code: codes[request.id] || '' } : undefined, approve ? 'POST' : 'DELETE'); setRequests(rows => rows.filter(r => r.id !== request.id)) }
    catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  return <section className="device-section" aria-label={t('Phone authorizations')}>
    <div className="device-section-heading"><Smartphone className="size-5" /><h2>{t('Authorize a phone')}</h2><Button asChild size="sm" variant="outline"><Link to="/settings#pairing"><Smartphone />{t('Pair a phone')}</Link></Button></div>
    {requests.length === 0 && <p className="device-muted">{t('Request access from the phone\'s Plaud screen. Approving copies your existing device authorization, encrypted for that phone.')}</p>}
    {requests.map(request => <div key={request.id} className="device-recording-row">
      <span><strong>{request.name}</strong><small>{t('Enter the six-character code displayed on that phone.')}</small></span>
      <input className="w-24 min-w-0 rounded border p-2 font-mono" aria-label={t('Verification code for {name}', { name: request.name })} maxLength={6} value={codes[request.id] || ''} onChange={e => setCodes(v => ({ ...v, [request.id]: e.target.value.toUpperCase() }))} />
      <Button size="icon" title={t('Approve phone')} aria-label={t('Approve phone')} disabled={!!busy || codes[request.id]?.length !== 6} onClick={() => void act(request, true)}><Check /></Button>
      <Button size="icon" variant="ghost" title={t('Decline phone')} aria-label={t('Decline phone')} disabled={!!busy} onClick={() => void act(request, false)}><X /></Button>
    </div>)}
    {error && <p className="device-error" role="alert">{error}</p>}
  </section>
}
