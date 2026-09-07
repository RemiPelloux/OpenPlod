import { useEffect, useRef, useState } from 'react'
import { Save, Loader2, AlertCircle, Copy, Monitor, Smartphone, Unplug } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { api, type Settings } from '@/lib/api'
import { forgetMobilePairing, getRuntime } from '@/lib/runtime'
import { QRCodeSVG } from 'qrcode.react'

function Toggle({ checked, onChange, label, description }: { checked: boolean; onChange: (v: boolean) => void; label: string; description: string }) {
  return (
    <div className="flex items-center justify-between py-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 rounded-full transition-colors ${checked ? 'bg-primary' : 'bg-secondary'}`}
      >
        <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform shadow-sm ${checked ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  )
}

const engines = [
  { id: 'whisper' as const, name: 'Whisper (Local)', desc: 'Free, runs on your machine. Slower but private.' },
  { id: 'mistral' as const, name: 'Mistral Voxtral', desc: 'Fast multilingual cloud transcription with timestamps.' },
  { id: 'deepgram' as const, name: 'Deepgram', desc: 'High accuracy with diarization. Requires API key.' },
]

export function SettingsPage() {
  const runtime = getRuntime()
  const pairingPayload = runtime.mode === 'desktop' && runtime.lanAddress
    ? JSON.stringify({ type: 'openplod-pairing', version: 1, origin: runtime.lanAddress, token: runtime.pairingToken })
    : ''
  const [settings, setSettings] = useState<Settings>({
    transcriptionEngine: 'whisper',
    mistralApiKey: '',
    deepgramApiKey: '',
    mistralApiKeyConfigured: false,
    deepgramApiKeyConfigured: false,
    syncFolderPath: '~/Documents/PlaudSync',
    autoTranscribe: true,
    autoSummarize: false,
    autoImport: false,
    plaudRecordingTypes: ['class', 'meeting', 'conversation', 'other'],
    deleteSourceAfterImport: false,
    openWhistleForwarding: false,
    openWhistleBaseUrl: '',
    openWhistleApiKey: '',
    openWhistleApiKeyConfigured: false,
    openWhistleAgentId: '',
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const savedTimer = useRef<number | null>(null)

  useEffect(() => {
    api.getSettings().then(setSettings).catch(loadError => {
      setError(loadError instanceof Error ? loadError.message : 'Could not load settings')
    })
    return () => {
      if (savedTimer.current) window.clearTimeout(savedTimer.current)
    }
  }, [])

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      setSettings(await api.updateSettings(settings))
      setSaved(true)
      if (savedTimer.current) window.clearTimeout(savedTimer.current)
      savedTimer.current = window.setTimeout(() => setSaved(false), 2000)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save settings')
    } finally {
      setSaving(false)
    }
  }

  const update = (patch: Partial<Settings>) => setSettings(s => ({ ...s, ...patch }))

  return (
    <div className="settings-page">
      <div className="flex items-center justify-between">
        <div>
          <h1>Settings</h1>
        </div>
        <Button onClick={save} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
          {saved ? 'Saved!' : 'Save'}
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <details className="border-b pb-4">
        <summary className="cursor-pointer text-sm text-muted-foreground">Mobile pairing</summary>
      <Card className="mt-4">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            {runtime.mode === 'desktop' ? <Monitor className="h-4 w-4" /> : <Smartphone className="h-4 w-4" />}
            {runtime.mode === 'desktop' ? 'Mobile pairing' : runtime.mode === 'mobile' ? 'Paired desktop' : 'App pairing'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {runtime.mode === 'desktop' ? (
            <>
              <p className="text-sm text-muted-foreground">Use these details in OpenPlod on iPhone or Android while both devices are on the same Wi-Fi.</p>
              {pairingPayload && (
                <div className="pairing-qr">
                  <QRCodeSVG value={pairingPayload} size={184} level="M" marginSize={2} />
                  <div><p className="font-medium">Scan with OpenPlod mobile</p><p>One scan securely fills the address and private code.</p></div>
                </div>
              )}
              <PairingValue label="Desktop address" value={runtime.lanAddress ?? 'Local network address unavailable'} />
              <PairingValue label="Private pairing code" value={runtime.pairingToken} secret />
            </>
          ) : runtime.mode === 'mobile' ? (
            <>
              <PairingValue label="Desktop address" value={runtime.serviceOrigin} />
              <Button variant="outline" onClick={() => { forgetMobilePairing(); window.location.reload() }}>
                <Unplug className="mr-2 h-4 w-4" />Forget this desktop
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Pairing details are available in the installed desktop and mobile apps.</p>
          )}
        </CardContent>
      </Card>
      </details>

      {/* Transcription Engine */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Transcription Engine</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {engines.map(engine => (
            <button
              type="button"
              key={engine.id}
              onClick={() => update({ transcriptionEngine: engine.id })}
              className={`flex w-full items-center gap-4 rounded-lg border-2 p-4 text-left transition-colors ${
                settings.transcriptionEngine === engine.id
                  ? 'border-primary bg-primary/5'
                  : 'border-transparent bg-secondary/50 hover:bg-secondary'
              }`}
            >
              <div className={`h-4 w-4 rounded-full border-2 flex items-center justify-center ${
                settings.transcriptionEngine === engine.id ? 'border-primary' : 'border-muted-foreground/30'
              }`}>
                {settings.transcriptionEngine === engine.id && (
                  <div className="h-2 w-2 rounded-full bg-primary" />
                )}
              </div>
              <div>
                <p className="text-sm font-medium">{engine.name}</p>
                <p className="text-xs text-muted-foreground">{engine.desc}</p>
              </div>
            </button>
          ))}
        </CardContent>
      </Card>

      {/* API Keys */}
      {(settings.transcriptionEngine === 'mistral' || settings.transcriptionEngine === 'deepgram') && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">API Keys</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {settings.transcriptionEngine === 'mistral' && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Mistral API key</label>
                <Input
                  type="password"
                  placeholder={settings.mistralApiKeyConfigured ? 'Saved key (enter a new key to replace)' : 'Enter your Mistral API key'}
                  value={settings.mistralApiKey || ''}
                  onChange={e => update({ mistralApiKey: e.target.value })}
                />
              </div>
            )}
            {settings.transcriptionEngine === 'deepgram' && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Deepgram API Key</label>
                <Input
                  type="password"
                  placeholder={settings.deepgramApiKeyConfigured ? 'Saved key (enter a new key to replace)' : 'Enter your Deepgram API key'}
                  value={settings.deepgramApiKey || ''}
                  onChange={e => update({ deepgramApiKey: e.target.value })}
                />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Sync */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Sync</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Plaud Sync Folder</label>
            <Input
              value={settings.syncFolderPath}
              onChange={e => update({ syncFolderPath: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">Path to your PlaudSync folder on this machine</p>
          </div>
        </CardContent>
      </Card>

      {/* Automation */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Automation</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          <Toggle
            checked={settings.autoImport}
            onChange={v => update({ autoImport: v })}
            label="Auto-import Plaud recordings"
            description="Import new files when they appear in the Plaud sync folder"
          />
          <div className="py-3">
            <p className="text-sm font-medium">Recording types</p>
            <p className="mb-3 text-xs text-muted-foreground">Choose which detected Plaud exports are imported automatically</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {['class', 'meeting', 'conversation', 'other'].map(type => (
                <label key={type} className="flex items-center gap-2 text-sm capitalize">
                  <input
                    type="checkbox"
                    checked={settings.plaudRecordingTypes.includes(type)}
                    onChange={() => update({
                      plaudRecordingTypes: settings.plaudRecordingTypes.includes(type)
                        ? settings.plaudRecordingTypes.filter(value => value !== type)
                        : [...settings.plaudRecordingTypes, type],
                    })}
                  />
                  {type}
                </label>
              ))}
            </div>
          </div>
          <Toggle
            checked={settings.deleteSourceAfterImport}
            onChange={v => update({ deleteSourceAfterImport: v })}
            label="Delete exported file after import"
            description="Keep the durable vault copy and remove the source export"
          />
          <Toggle
            checked={settings.autoTranscribe}
            onChange={v => update({ autoTranscribe: v })}
            label="Auto-transcribe"
            description="Automatically transcribe new recordings when synced"
          />
          <Toggle
            checked={settings.autoSummarize}
            onChange={v => update({ autoSummarize: v })}
            label="Auto-summarize"
            description="Generate AI summary after transcription completes"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">OpenWhistle</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Toggle
            checked={settings.openWhistleForwarding}
            onChange={v => update({ openWhistleForwarding: v })}
            label="Forward recordings"
            description="Send imported audio to OpenWhistle for agents and connectors"
          />
          <div className="space-y-2">
            <label className="text-sm font-medium">API base URL</label>
            <Input value={settings.openWhistleBaseUrl} onChange={e => update({ openWhistleBaseUrl: e.target.value })} placeholder="https://openwhistle.pro/api/v1" />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Agent ID</label>
            <Input value={settings.openWhistleAgentId} onChange={e => update({ openWhistleAgentId: e.target.value })} />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">API key</label>
            <Input type="password" value={settings.openWhistleApiKey || ''} onChange={e => update({ openWhistleApiKey: e.target.value })} placeholder={settings.openWhistleApiKeyConfigured ? 'Saved key (enter a new key to replace)' : 'owk_...'} />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function PairingValue({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const copy = () => void navigator.clipboard.writeText(value)
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex min-w-0 items-center gap-2 rounded-md border bg-secondary/40 px-3 py-2">
        <code className="min-w-0 flex-1 truncate text-xs">{secret ? value.replace(/.(?=.{6})/g, '*') : value}</code>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={copy} aria-label={`Copy ${label}`} title={`Copy ${label}`}>
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}
