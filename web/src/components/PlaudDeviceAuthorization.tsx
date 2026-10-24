import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react'
import { Check, KeyRound, Loader2, ShieldCheck, Trash2 } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { api, type PlaudIdentityStatus, type PlaudStatus } from '@/lib/api'
import { needsManualSerial, plaudModelName } from '@/lib/plaud-model'
import { t } from '@/i18n'
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
  const [serial, setSerial] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // The advertised serial is enough for a Note Pro. A Plaud Note advertises a
  // shorter string than the one its account is registered under, so the detected
  // value is only a default the user can correct.
  useEffect(() => { setSerial(status?.deviceSerial ?? '') }, [status?.deviceSerial])

  const model = plaudModelName(identity?.deviceType ?? status?.deviceModel)
  const manualSerial = needsManualSerial(plaudModelName(status?.deviceModel), status?.deviceSerial)

  const load = useCallback(async () => {
    try { setIdentity(await api.getPlaudIdentity()) } catch (failure) { setError(failure instanceof Error ? failure.message : t('Could not read the recorder authorization.')) }
  }, [])
  useEffect(() => { void load() }, [load])

  const authorize = async () => {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await api.authorizePlaudDevice({
        token: token.trim() || undefined, domain,
        serial: serial.trim().toUpperCase() || undefined,
        identifier: status?.deviceIdentifier || undefined,
      })
      setToken('')
      setNotice(t('{device} {serial} is now authorized on this computer.', {
        device: plaudModelName(result.deviceType) ?? result.deviceType, serial: result.serial,
      }))
      await load(); onAuthorized?.()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('Could not authorize the recorder.'))
    } finally { setBusy(false) }
  }

  const forget = async () => {
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
      <h2>{model ? t('Authorize this {model}', { model }) : t('Authorize this Plaud recorder')}</h2>
      {identity?.authorized && <Check className="plaud-authorize-done" aria-label={t('Authorized')} />}
    </div>
    {identity?.authorized ? <>
      <p>{t('This computer can read and download recordings from the recorder over Bluetooth.')}</p>
      <dl className="plaud-authorize-facts">
        {identity.deviceType && <div><dt>{t('Model')}</dt><dd>{plaudModelName(identity.deviceType) ?? identity.deviceType}</dd></div>}
        <div><dt>{t('Serial number')}</dt><dd>{identity.serial}</dd></div>
        <div><dt>{t('Bluetooth address')}</dt><dd>{identity.identifier}</dd></div>
      </dl>
      <div className="plaud-authorize-actions">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void forget()}>{busy ? <Loader2 className="animate-spin" /> : <Trash2 />}{t('Remove authorization')}</Button>
      </div>
    </> : <>
      <p>{t('Your Plaud recorder only accepts downloads from a client it has authorized. Paste a Plaud sign-in token to authorize this computer.')}</p>
      {waitingForDevice
        ? <p>{t('Wake the recorder and keep it near this computer so its serial number and Bluetooth address can be read.')}</p>
        : status?.deviceSerial && <p>{rich(t('Recorder detected: {name} / {serial}'), { name: status.deviceName || 'Plaud', serial: <code>{status.deviceSerial}</code> })}</p>}
      <label className="plaud-authorize-field"><span>{t('Plaud sign-in token')}</span>
        <input type="password" autoComplete="off" spellCheck={false} value={token} placeholder={t('Paste tokenstr from web.plaud.ai')} aria-label={t('Plaud sign-in token')} onChange={event => setToken(event.target.value)} />
      </label>
      <label className="plaud-authorize-field"><span>{t('Serial number (optional)')}</span>
        <input value={serial} autoComplete="off" spellCheck={false} maxLength={18} placeholder={t('Detected automatically when possible')} aria-label={t('Serial number (optional)')} onChange={event => setSerial(event.target.value)} />
      </label>
      {manualSerial && <p className="plaud-authorize-hint">{t('A Plaud Note uses an 18-character serial number, shown in the Plaud app under device information. Enter it if the detected serial is shorter.')}</p>}
      <label className="plaud-authorize-field"><span>{t('Plaud region')}</span>
        <select value={domain} aria-label={t('Plaud region')} onChange={event => setDomain(event.target.value)}>{domains.map(value => <option key={value} value={value}>{value}</option>)}</select>
      </label>
      {identity?.developerCredentialsAvailable && <p>{t('Plaud developer credentials are configured on this computer, so the token may be left empty.')}</p>}
      <div className="plaud-authorize-actions">
        <Button disabled={busy || waitingForDevice} onClick={() => void authorize()}>{busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}{t('Authorize this computer')}</Button>
      </div>
      <details className="plaud-authorize-help"><summary>{t('Where do I find this token?')}</summary>
        <p>{rich(t('Sign in at {site}, then open your browser developer tools, go to Application / Local Storage / {origin} and copy the value of {key}.'), {
          site: <a href="https://web.plaud.ai" target="_blank" rel="noreferrer">web.plaud.ai</a>,
          origin: <code>https://web.plaud.ai</code>,
          key: <code>tokenstr</code>,
        })}</p>
      </details>
    </>}
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
