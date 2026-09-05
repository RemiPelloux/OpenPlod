import { invoke } from '@tauri-apps/api/core'

export type RuntimeMode = 'browser' | 'desktop' | 'mobile'

export interface RuntimeConfig {
  mode: RuntimeMode
  serviceOrigin: string
  pairingToken: string
  lanAddress: string | null
  paired: boolean
}

interface NativeRuntimeInfo {
  mode: 'desktop' | 'mobile'
  serviceOrigin: string | null
  pairingToken: string | null
  lanAddress: string | null
}

const STORAGE_ORIGIN = 'openplod.serviceOrigin'
const STORAGE_TOKEN = 'openplod.pairingToken'

let runtime: RuntimeConfig = {
  mode: 'browser',
  serviceOrigin: '',
  pairingToken: '',
  lanAddress: null,
  paired: true,
}

function normalizeOrigin(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

export async function initializeRuntime(): Promise<RuntimeConfig> {
  if (!('__TAURI_INTERNALS__' in window)) return runtime

  const native = await invoke<NativeRuntimeInfo>('runtime_info')
  if (native.mode === 'desktop') {
    runtime = {
      mode: 'desktop',
      serviceOrigin: native.serviceOrigin ?? 'http://127.0.0.1:3487',
      pairingToken: native.pairingToken ?? '',
      lanAddress: native.lanAddress,
      paired: true,
    }
    return runtime
  }

  const serviceOrigin = normalizeOrigin(localStorage.getItem(STORAGE_ORIGIN) ?? '')
  const pairingToken = localStorage.getItem(STORAGE_TOKEN)?.trim() ?? ''
  runtime = {
    mode: 'mobile',
    serviceOrigin,
    pairingToken,
    lanAddress: null,
    paired: Boolean(serviceOrigin && pairingToken),
  }
  return runtime
}

export function getRuntime(): RuntimeConfig {
  return runtime
}

export function apiUrl(path: string): string {
  return `${runtime.serviceOrigin}/api${path}`
}

export function authenticatedHeaders(initial?: HeadersInit): Headers {
  const headers = new Headers(initial)
  if (runtime.pairingToken) headers.set('X-OpenPlod-Token', runtime.pairingToken)
  return headers
}

export async function pairMobile(serviceOrigin: string, pairingToken: string): Promise<RuntimeConfig> {
  const origin = normalizeOrigin(serviceOrigin)
  const token = pairingToken.trim()
  if (!origin || !token) throw new Error('Enter the desktop address and pairing code.')

  const response = await fetch(`${origin}/api/info`, {
    headers: authenticatedHeadersFor(token),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(payload?.error || 'OpenPlod desktop could not be reached.')
  }

  localStorage.setItem(STORAGE_ORIGIN, origin)
  localStorage.setItem(STORAGE_TOKEN, token)
  runtime = { mode: 'mobile', serviceOrigin: origin, pairingToken: token, lanAddress: null, paired: true }
  return runtime
}

export function forgetMobilePairing(): RuntimeConfig {
  localStorage.removeItem(STORAGE_ORIGIN)
  localStorage.removeItem(STORAGE_TOKEN)
  runtime = { mode: 'mobile', serviceOrigin: '', pairingToken: '', lanAddress: null, paired: false }
  return runtime
}

function authenticatedHeadersFor(token: string): Headers {
  const headers = new Headers()
  headers.set('X-OpenPlod-Token', token)
  return headers
}
