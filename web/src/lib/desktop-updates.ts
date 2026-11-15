import { invoke } from '@tauri-apps/api/core'
import type { Update } from '@tauri-apps/plugin-updater'
import { getRuntime } from './runtime'

type State =
  | { kind: 'idle' | 'checking' | 'current' | 'installing' | 'installed' }
  | { kind: 'downloading'; percent: number | null }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message?: string }

const autoKey = 'openplod.installUpdateOnRestart'
const attemptedKey = 'openplod.attemptedStartupUpdate'
let state: State = { kind: 'idle' }
let pending: Update | null = null
let startup: Promise<void> | undefined
const listeners = new Set<() => void>()

export const getUpdateState = () => state
export function subscribeUpdate(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function publish(value: State) {
  state = value
  listeners.forEach(listener => listener())
}

export const autoInstallEnabled = () => localStorage.getItem(autoKey) !== 'false'
export function setAutoInstall(enabled: boolean) {
  localStorage.setItem(autoKey, String(enabled))
}

export async function installDesktopUpdate(restart = false) {
  if (state.kind !== 'ready' || !pending) return
  const update = pending
  publish({ kind: 'installing' })
  // Never loop on a failed installer at the next startup.
  if (restart) localStorage.setItem(attemptedKey, update.version)
  try {
    await update.install()
    pending = null
    publish({ kind: 'installed' })
    if (restart) await invoke('restart_after_update')
  } catch (error) {
    pending = null
    publish({ kind: 'error', message: error instanceof Error ? error.message : typeof error === 'string' ? error : undefined })
  } finally {
    await update.close().catch(() => {})
  }
}

export async function checkDesktopUpdate(installOnStartup = false) {
  if (!getRuntime().updaterEnabled || ['checking', 'downloading', 'ready', 'installing', 'installed'].includes(state.kind)) return
  publish({ kind: 'checking' })
  let update: Update | null = null
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    update = await check({ timeout: 15000 })
    if (!update) {
      localStorage.removeItem(attemptedKey)
      publish({ kind: 'current' })
      return
    }
    const version = update.version
    let total = 0, received = 0
    publish({ kind: 'downloading', percent: null })
    await update.download(event => {
      if (event.event === 'Started') total = event.data.contentLength ?? 0
      if (event.event === 'Progress') {
        received += event.data.chunkLength
        publish({ kind: 'downloading', percent: total > 0 ? Math.min(100, Math.round(received / total * 100)) : null })
      }
    }, { timeout: 120000 })
    pending = update
    publish({ kind: 'ready', version })
    if (installOnStartup && localStorage.getItem(attemptedKey) !== version && autoInstallEnabled()) await installDesktopUpdate(true)
  } catch (error) {
    pending = null
    if (update) await update.close().catch(() => {})
    publish({ kind: 'error', message: error instanceof Error ? error.message : typeof error === 'string' ? error : undefined })
  }
}

/** Hold the workspace at startup only when automatic installation is enabled. */
export function startDesktopUpdates(): Promise<void> {
  if (!getRuntime().updaterEnabled) return Promise.resolve()
  if (startup) return startup
  const automatic = autoInstallEnabled()
  const check = checkDesktopUpdate(automatic)
  startup = automatic ? check : Promise.resolve()
  return startup
}
