import { plaudErrorMessage } from '@/lib/plaud-errors'
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, KeyRound, Loader2, ShieldCheck, Trash2 } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { api, type PlaudIdentityStatus, type PlaudStatus } from '@/lib/api'
import { t } from '@/i18n'
import { invoke } from '@tauri-apps/api/core'
import { getRuntime } from '@/lib/runtime'
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
  const [accountType, setAccountType] = useState<'personal' | 'partner'>('personal')
  const [domain, setDomain] = useState('platform-us.plaud.ai')
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'signing-in' | 'authorizing' | 'verifying'>('idle')
  const [verified, setVerified] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const operation = useRef<{ id: string; controller: AbortController; verifying?: boolean } | null>(null)
  const desktop = getRuntime().mode === 'desktop'
  const automatic = desktop && accountType === 'personal'
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    try { setIdentity(await api.getPlaudIdentity()) } catch (failure) { setError(failure instanceof Error ? failure.message : t('Could not read the recorder authorization.')) }
  }, [])
  useEffect(() => {
    void load()
    return () => {
      const current = operation.current
      if (!current) return
      current.controller.abort()
      if (getRuntime().mode === 'desktop') void invoke('plaud_cancel_sign_in').catch(() => undefined)
      void api.cancelPlaudAuthorization(current.id).catch(() => undefined)
      if (current.verifying) void api.cancelDeviceOperation().catch(() => undefined)
    }
  }, [load])

  const cancel = async () => {
    const current = operation.current
    if (!current) return
    setCancelling(true)
    current.controller.abort()
    try {
      // Cancelling the backend is explicit: closing a browser request alone is insufficient.
      await Promise.all([
        getRuntime().mode === 'desktop' ? invoke('plaud_cancel_sign_in') : Promise.resolve(),
        api.cancelPlaudAuthorization(current.id),
        phase === 'verifying' ? api.cancelDeviceOperation() : Promise.resolve(),
      ])
    } catch {
      setError(t('Cancellation could not be confirmed. Refresh the authorization status before retrying.'))
    } finally { setCancelling(false); await load() }
  }

  const authorize = async (verifyOnly = false) => {
    if (operation.current || cancelling) return
    const current = { id: crypto.randomUUID(), controller: new AbortController(), verifying: false }
    operation.current = current
    setBusy(true); setError(''); setNotice(''); setVerified(false)
    let credential = ''
    try {
      if (!verifyOnly) {
        setPhase(automatic ? 'signing-in' : 'authorizing')
        credential = automatic ? await invoke<string>('plaud_sign_in') : token.trim()
        current.controller.signal.throwIfAborted()
        setPhase('authorizing')
        try {
          await api.authorizePlaudDevice({
            token: credential || undefined, accountType, domain, operationId: current.id,
            serial: status?.deviceSerial || undefined, identifier: status?.deviceIdentifier || undefined,
          }, current.controller.signal)
        } finally { credential = ''; setToken('') }
        await load()
      }
      current.controller.signal.throwIfAborted()
      current.verifying = true
      setPhase('verifying')
      await api.getDeviceRecordings(current.controller.signal)
      current.controller.signal.throwIfAborted()
      setVerified(true)
      setNotice(t('Bluetooth access verified. Your recordings can now be listed.'))
      onAuthorized?.()
    } catch (failure) {
      if (!verifyOnly && !current.verifying) await api.cancelPlaudAuthorization(current.id).catch(() => undefined)
      if (current.controller.signal.aborted) setNotice(t('Operation cancelled. Saved authorization status is shown below.'))
      else setError(plaudErrorMessage(failure))
    } finally {
      credential = ''; setToken(''); await load()
      operation.current = null; setBusy(false); setPhase('idle')
    }
  }

  const forget = async () => {
    if (!window.confirm(t('Remove local authorization and keys? Recordings on the Mac and Plaud will be kept.'))) return
    setVerified(false)
    setBusy(true); setError(''); setNotice('')
    try {
      await api.clearPlaudIdentity()
      setNotice(t('Device authorization removed from this computer.'))
      await load(); onAuthorized?.()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('Could not remove the authorization.'))
    } finally { setBusy(false) }
  }

  const domains = identity?.domains?.length ? identity.domains : ['platform-us.plaud.ai', 'platform-jp.plaud.ai']
  // Without a scan result there is nothing to check yet; the backend scans during authorization.
  const waitingForDevice = status ? !status.deviceSerial : false

  return <section className={`plaud-authorize plaud-authorize--${variant}`} aria-label={t('Authorize this Plaud recorder')}>
    <div className="plaud-authorize-heading">
      <KeyRound />
      <h2>{t('Authorize this Note Pro')}</h2>
      {verified && <Check className="plaud-authorize-done" aria-label={t('Authorized')} />}
    </div>
    {identity?.authorized ? <>
      <p>{t('Authorization keys are saved on this computer. Verify Bluetooth access to confirm the recorder is reachable.')}</p>
      <dl className="plaud-authorize-facts">
        {identity.deviceType && <div><dt>{t('Model')}</dt><dd>{identity.deviceType}</dd></div>}
        <div><dt>{t('Serial number')}</dt><dd>{identity.serial}</dd></div>
        <div><dt>{t('Bluetooth address')}</dt><dd>{identity.identifier}</dd></div>
      </dl>
      <div className="plaud-authorize-actions">
        <Button variant="outline" size="sm" disabled={busy || cancelling} onClick={() => void authorize(true)}>{t('Verify Bluetooth access')}</Button>
        {automatic && <Button variant="outline" size="sm" disabled={busy || cancelling} onClick={() => void authorize()}>{t('Reconnect Plaud account')}</Button>}
        <Button variant="outline" size="sm" disabled={busy || cancelling} onClick={() => void forget()}>{busy ? <Loader2 className="animate-spin" /> : <Trash2 />}{t('Remove authorization')}</Button>
      </div>
    </> : <>
      <p>{automatic ? t('Connect your Plaud account. Authorization and Bluetooth verification then run automatically.') : t('Authorize this computer using the Plaud account already linked to your recorder. This does not reset or rebind it.')}</p>
      <label className="plaud-authorize-field"><span>{t('Plaud account type')}</span>
        <select disabled={busy || cancelling} value={accountType} aria-label={t('Plaud account type')} onChange={event => { setAccountType(event.target.value as 'personal' | 'partner'); setToken(''); setError('') }}>
          <option value="personal">{t('Personal Plaud account')}</option>
          <option value="partner">{t('Plaud Partner account')}</option>
        </select>
      </label>
      {waitingForDevice
        ? <p>{t('Wake the Note Pro and keep it near this computer so its serial number and Bluetooth address can be read.')}</p>
        : status?.deviceSerial && <p>{rich(t('Recorder detected: {name} / {serial}'), { name: status.deviceName || 'Plaud', serial: <code>{status.deviceSerial}</code> })}</p>}
      {!automatic && <label className="plaud-authorize-field"><span>{t('Plaud sign-in token')}</span>
        <input type="password" autoComplete="off" spellCheck={false} value={token} placeholder={accountType === 'personal' ? t('Paste the pld_ut cookie from web.plaud.ai') : t('Paste your Plaud Partner user access token')} aria-label={t('Plaud sign-in token')} onChange={event => setToken(event.target.value)} />
      </label>}
      {accountType === 'partner' && <label className="plaud-authorize-field"><span>{t('Plaud region')}</span>
        <select value={domain} aria-label={t('Plaud region')} onChange={event => setDomain(event.target.value)}>{domains.map(value => <option key={value} value={value}>{value}</option>)}</select>
      </label>}
      {accountType === 'partner' && identity?.developerCredentialsAvailable && <p>{t('Plaud developer credentials are configured on this computer, so the token may be left empty.')}</p>}
      <div className="plaud-authorize-actions">
        <Button disabled={busy || cancelling || (accountType === 'personal' && !automatic && !token.trim())} onClick={() => void authorize()}>{busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}{automatic ? t('Connect my Plaud') : t('Authorize this computer')}</Button>
      </div>
      {!automatic && <details className="plaud-authorize-help"><summary>{t('Where do I find this token?')}</summary>
        {accountType === 'personal' ? <><p>{rich(t('Sign in at {site}. In your browser developer tools, open Application (or Storage), then Cookies for Plaud, and copy the value of {key}.'), {
          site: <a href="https://web.plaud.ai" target="_blank" rel="noreferrer">web.plaud.ai</a>,
          key: <code>pld_ut</code>,
        })}</p><p>{t('Use the account cookie, not tokenstr from Local Storage. Keep it private. It is used for authorization and is not saved by OpenPlod.')}</p></> : <p>{t('Use a Plaud Partner user access token, or the developer credentials configured on this computer. A personal Web token does not work with the Partner API.')}</p>}
      </details>}
    </>}
    {busy && phase !== 'idle' && <div role="status">
      <p>{phase === 'signing-in' ? t('Complete sign-in in the Plaud window. Closing it cancels sign-in.') : phase === 'authorizing' ? t('Retrieving recorder authorization…') : t('Verifying encrypted Bluetooth access…')}</p>
      <Button variant="outline" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? t('Cancelling…') : t('Cancel')}</Button>
    </div>}
    {notice && <p role="status" className="plaud-authorize-notice">{notice}</p>}
    {error && <p role="alert" className="plaud-authorize-error">{error}</p>}
  </section>
}

/** Splits a translated sentence on its {placeholders} and drops the given elements in their place. */
function rich(text: string, nodes: Record<string, ReactNode>): ReactNode {
  return text.split(/(\{\w+\})/).map((part, index) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1]
    return <Fragment key={index}>{name && name in nodes ? nodes[name] : part}</Fragment>
  })
}
