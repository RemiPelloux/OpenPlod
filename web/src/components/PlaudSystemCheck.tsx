import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Bluetooth, CheckCircle2, Loader2, Monitor, RefreshCw } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { api, type EnvironmentCheck, type PlaudEnvironment } from '@/lib/api'
import './plaud-system-check.css'

/**
 * What this computer can actually do, autodetected.
 *
 * Direct Bluetooth transfer needs a desktop Bluetooth backend, the bridge
 * helper, a powered adapter, ffmpeg/ffprobe and a recorder authorization.
 * Before 0.6.0 any one of those failing surfaced as the same "Bluetooth scan
 * failed", which sent people looking in the wrong place. Each is now reported
 * on its own line with the fix for this platform.
 */

const BACKEND_LABELS: Record<string, string> = {
  corebluetooth: 'CoreBluetooth',
  bluez: 'BlueZ',
  winrt: 'Windows Runtime',
}

const PLATFORM_LABELS: Record<string, string> = {
  darwin: 'macOS',
  linux: 'Linux',
  win32: 'Windows',
}

const describeHost = (environment: PlaudEnvironment) => {
  const os = PLATFORM_LABELS[environment.platform] ?? environment.platform
  const backend = environment.backend ? BACKEND_LABELS[environment.backend] ?? environment.backend : 'no Bluetooth backend'
  return `${os} · ${environment.arch} · ${backend}`
}

function CheckRow({ check }: { check: EnvironmentCheck }) {
  return (
    <li className="plaud-check" data-ok={check.ok}>
      <span className="plaud-check-icon" aria-hidden="true">
        {check.ok ? <CheckCircle2 /> : <AlertCircle />}
      </span>
      <div className="plaud-check-body">
        <p className="plaud-check-label">
          {check.label}
          <span className="plaud-check-state">{check.ok ? 'Ready' : 'Action needed'}</span>
        </p>
        <p className="plaud-check-detail">{check.detail}</p>
        {check.remediation && <p className="plaud-check-fix">{check.remediation}</p>}
      </div>
    </li>
  )
}

export function PlaudSystemCheck({ onReadyChange }: { onReadyChange?: (ready: boolean) => void } = {}) {
  const [environment, setEnvironment] = useState<PlaudEnvironment | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const mounted = useRef(true)
  // Held in a ref so a caller passing an inline callback cannot restart detection.
  const notify = useRef(onReadyChange)
  useEffect(() => { notify.current = onReadyChange }, [onReadyChange])

  // State is only touched after the request settles, so mounting this panel
  // never re-renders synchronously during the effect that starts it.
  const load = useCallback(async (refresh: boolean) => {
    try {
      const value = await api.getPlaudEnvironment({ refresh })
      if (!mounted.current) return
      setEnvironment(value); setError('')
      notify.current?.(value.ready)
    } catch {
      if (mounted.current) setError('The system check could not run. Is the vault service running?')
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void load(false)
    return () => { mounted.current = false }
  }, [load])

  const recheck = () => { setLoading(true); void load(true) }

  return (
    <section className="plaud-system-check" aria-labelledby="plaud-system-check-heading">
      <div className="plaud-section-heading">
        <span className="plaud-section-icon"><Monitor /></span>
        <div>
          <h2 id="plaud-system-check-heading">This computer</h2>
          <p>{environment ? describeHost(environment) : 'Detecting the host Bluetooth stack…'}</p>
        </div>
        <Button variant="outline" size="sm" onClick={recheck} disabled={loading}>
          {loading ? <Loader2 className="plaud-spin" /> : <RefreshCw />}
          Re-check
        </Button>
      </div>

      {error && <p className="plaud-check-error" role="alert">{error}</p>}

      {environment && (
        <>
          <p className="plaud-system-summary" data-ready={environment.ready}>
            <Bluetooth aria-hidden="true" />
            {environment.ready
              ? 'This computer is ready for direct Bluetooth transfer.'
              : `${environment.blockers.length} thing${environment.blockers.length === 1 ? '' : 's'} left before direct Bluetooth transfer works.`}
          </p>
          <ul className="plaud-check-list">
            {environment.checks.map(check => <CheckRow key={check.id} check={check} />)}
          </ul>
          {environment.bridgePath && (
            <p className="plaud-check-footnote">
              Bridge: <code>{environment.bridgePath}</code>
              {environment.bridgeBackend === 'swift' && ' (macOS Swift fallback)'}
              {environment.adapter && <> · Adapter: <code>{environment.adapter}</code></>}
            </p>
          )}
        </>
      )}
    </section>
  )
}
