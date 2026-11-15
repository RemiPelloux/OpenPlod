import { useState, useSyncExternalStore } from 'react'
import { Download, Loader2, RefreshCw } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { getRuntime } from '@/lib/runtime'
import { autoInstallEnabled, checkDesktopUpdate, getUpdateState, installDesktopUpdate, setAutoInstall, subscribeUpdate } from '@/lib/desktop-updates'
import { t } from '@/i18n'

const useUpdates = () => useSyncExternalStore(subscribeUpdate, getUpdateState)

function InstallButton({ version }: { version: string }) {
  return <Button onClick={() => void installDesktopUpdate()}><Download />{t('Install {version}', { version })}</Button>
}

export function UpdateNotice() {
  const state = useUpdates()
  if (state.kind === 'installing' || state.kind === 'installed') {
    return <p className="border-b px-4 py-2 text-sm" role="status">
      {state.kind === 'installing' ? t('Installing…') : t('Update installed. Quit and reopen OpenPlod to finish.')}
    </p>
  }
  if (state.kind !== 'ready') return null
  return <aside className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 text-sm" aria-label={t('Software updates')}>
    <p role="status">{t('Version {version} is downloaded and ready to install.', { version: state.version })}</p>
    <InstallButton version={state.version} />
  </aside>
}

export function UpdatePanel() {
  const state = useUpdates()
  const [auto, setAuto] = useState(autoInstallEnabled)
  if (getRuntime().mode !== 'desktop') return null
  if (!getRuntime().updaterEnabled) return <p className="text-sm text-muted-foreground">{t('Updates are not configured for this build.')}</p>
  const busy = ['checking', 'downloading', 'installing'].includes(state.kind)
  return <div className="grid gap-2 pt-2 text-sm">
    <label className="flex items-center gap-2"><input type="checkbox" checked={auto} onChange={event => {
      setAutoInstall(event.target.checked); setAuto(event.target.checked)
    }} />{t('Install downloaded updates automatically when OpenPlod next opens')}</label>
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" disabled={busy || state.kind === 'ready' || state.kind === 'installed'} onClick={() => void checkDesktopUpdate()}>
        {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}{t('Check for updates')}
      </Button>
      {state.kind === 'ready' && <InstallButton version={state.version} />}
    </div>
    <p role="status" className="text-muted-foreground">
      {state.kind === 'current' && t('OpenPlod is up to date.')}
      {state.kind === 'downloading' && (state.percent === null ? t('Downloading update…') : t('Downloading update {percent}%', { percent: state.percent }))}
      {state.kind === 'ready' && t('Version {version} is downloaded and ready to install.', { version: state.version })}
      {state.kind === 'installing' && t('Installing…')}
      {state.kind === 'installed' && t('Update installed. Quit and reopen OpenPlod to finish.')}
      {state.kind === 'error' && (state.message || t('The update could not be installed. Your current version is unchanged.'))}
    </p>
  </div>
}
