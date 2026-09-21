import { useCallback, useEffect, useState } from 'react'
import { Check, KeyRound, Loader2, ShieldCheck, Trash2 } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { api, type PlaudIdentityStatus, type PlaudStatus } from '@/lib/api'
import './plaud-device-authorization.css'

/**
 * Authorizes this computer to read recordings off the paired recorder.
 *
 * A Plaud recorder refuses downloads unless the client can present a key pair,
 * a serial signature and a binding token minted by Plaud. Those are obtained
 * here from the account's sign-in token, so no macOS client is required.
 *
 * `status` is optional: when the recorder has already been scanned the serial
 * and address are shown up front, otherwise the backend scans while authorizing.
 */
export function PlaudDeviceAuthorization({ status, onAuthorized, variant = 'page' }: {
  status?: PlaudStatus | null
  onAuthorized?: () => void
  variant?: 'page' | 'dialog'
}) {
  const [identity, setIdentity] = useState<PlaudIdentityStatus | null>(null)
  const [token, setToken] = useState('')
  const [domain, setDomain] = useState('platform-us.plaud.ai')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    try { setIdentity(await api.getPlaudIdentity()) } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not read the recorder authorization.') }
  }, [])
  useEffect(() => { void load() }, [load])

  const authorize = async () => {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await api.authorizePlaudDevice({
        token: token.trim() || undefined, domain,
        serial: status?.deviceSerial || undefined, identifier: status?.deviceIdentifier || undefined,
      })
      setToken('')
      setNotice(`${result.deviceType} ${result.serial} is now authorized on this computer.`)
      await load(); onAuthorized?.()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not authorize the recorder.')
    } finally { setBusy(false) }
  }

  const forget = async () => {
    setBusy(true); setError(''); setNotice('')
    try {
      await api.clearPlaudIdentity()
      setNotice('Device authorization removed from this computer.')
      await load(); onAuthorized?.()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not remove the authorization.')
    } finally { setBusy(false) }
  }

  const domains = identity?.domains?.length ? identity.domains : ['platform-us.plaud.ai', 'platform-jp.plaud.ai']
  // Without a scan result there is nothing to check yet; the backend scans during authorization.
  const waitingForDevice = status ? !status.deviceSerial : false

  return <section className={`plaud-authorize plaud-authorize--${variant}`} aria-label="Authorize this Plaud recorder">
    <div className="plaud-authorize-heading">
      <KeyRound />
      <h2>Authorize this Note Pro</h2>
      {identity?.authorized && <Check className="plaud-authorize-done" aria-label="Authorized" />}
    </div>
    {identity?.authorized ? <>
      <p>This computer can read and download recordings from the recorder over Bluetooth.</p>
      <dl className="plaud-authorize-facts">
        {identity.deviceType && <div><dt>Model</dt><dd>{identity.deviceType}</dd></div>}
        <div><dt>Serial number</dt><dd>{identity.serial}</dd></div>
        <div><dt>Bluetooth address</dt><dd>{identity.identifier}</dd></div>
      </dl>
      <div className="plaud-authorize-actions">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void forget()}>{busy ? <Loader2 className="animate-spin" /> : <Trash2 />}Remove authorization</Button>
      </div>
    </> : <>
      <p>Your Note Pro only accepts downloads from a client it has authorized. Paste a Plaud sign-in token to authorize this computer.</p>
      {waitingForDevice
        ? <p>Wake the Note Pro and keep it near this computer so its serial number and Bluetooth address can be read.</p>
        : status?.deviceSerial && <p>Recorder detected: {status.deviceName || 'Plaud'} / <code>{status.deviceSerial}</code></p>}
      <label className="plaud-authorize-field"><span>Plaud sign-in token</span>
        <input type="password" autoComplete="off" spellCheck={false} value={token} placeholder="Paste tokenstr from web.plaud.ai" aria-label="Plaud sign-in token" onChange={event => setToken(event.target.value)} />
      </label>
      <label className="plaud-authorize-field"><span>Plaud region</span>
        <select value={domain} aria-label="Plaud region" onChange={event => setDomain(event.target.value)}>{domains.map(value => <option key={value} value={value}>{value}</option>)}</select>
      </label>
      {identity?.developerCredentialsAvailable && <p>Plaud developer credentials are configured on this computer, so the token may be left empty.</p>}
      <div className="plaud-authorize-actions">
        <Button disabled={busy || waitingForDevice} onClick={() => void authorize()}>{busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}Authorize this computer</Button>
      </div>
      <details className="plaud-authorize-help"><summary>Where do I find this token?</summary>
        <p>Sign in at <a href="https://web.plaud.ai" target="_blank" rel="noreferrer">web.plaud.ai</a>, then open your browser developer tools, go to Application / Local Storage / <code>https://web.plaud.ai</code> and copy the value of <code>tokenstr</code>.</p>
      </details>
    </>}
    {notice && <p role="status" className="plaud-authorize-notice">{notice}</p>}
    {error && <p role="alert" className="plaud-authorize-error">{error}</p>}
  </section>
}
