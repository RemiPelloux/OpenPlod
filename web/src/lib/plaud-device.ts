import { invoke } from '@tauri-apps/api/core'
import { getRuntime } from './runtime'

export interface DeviceRecording {
  sessionId: string
  size: number
  scene: number
}

export interface LocalPlaudRecording {
  sessionId: string
  sourceRecordingId: string
  filename: string
  durationMs: number
  fingerprint: string
  recordedAt: string
  desktopRecordingId: string | null
}

export interface DeviceSnapshot {
  configured: boolean
  busy: boolean
  autoImport: boolean
  lastNotice: string | null
  lastCheck: number
  state: 'not_configured' | 'authenticating' | 'disconnected' | 'scanning' | 'connecting' | 'ready'
  error: string | null
  serial: string | null
  battery: number | null
  listLoaded: boolean
  files: DeviceRecording[]
  devices: { serial: string; name: string; rssi: number }[]
  localRecordings: LocalPlaudRecording[]
  downloading: boolean
  progress: number
  playingId: string | null
}

export const supportsPlaudDevice = () => getRuntime().mode === 'mobile' && /Android/i.test(navigator.userAgent)

export async function deviceCommand<T = DeviceSnapshot>(action: string, args: Record<string, unknown> = {}): Promise<T> {
  try { return await invoke<T>('plaud_command', { action, args }) }
  catch (error) { throw new Error(typeof error === 'string' ? error : 'The Plaud connection could not be reached.') }
}

export function vaultArguments() {
  const runtime = getRuntime()
  return { origin: runtime.serviceOrigin, pairingToken: runtime.pairingToken }
}
