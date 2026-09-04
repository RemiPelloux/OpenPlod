import { useEffect, useRef, useState } from 'react'
import { Save, Loader2, AlertCircle } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { api, type Settings } from '@/lib/api'

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
  { id: 'groq' as const, name: 'Groq', desc: 'Fast cloud transcription. Requires API key.' },
  { id: 'deepgram' as const, name: 'Deepgram', desc: 'High accuracy with diarization. Requires API key.' },
]

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({
    transcriptionEngine: 'whisper',
    groqApiKey: '',
    deepgramApiKey: '',
    groqApiKeyConfigured: false,
    deepgramApiKeyConfigured: false,
    syncFolderPath: '~/Documents/PlaudSync',
    autoTranscribe: true,
    autoSummarize: false,
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
    <div className="p-6 md:p-8 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">Configure transcription and sync</p>
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
      {(settings.transcriptionEngine === 'groq' || settings.transcriptionEngine === 'deepgram') && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">API Keys</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {settings.transcriptionEngine === 'groq' && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Groq API Key</label>
                <Input
                  type="password"
                  placeholder={settings.groqApiKeyConfigured ? 'Saved key (enter a new key to replace)' : 'gsk_...'}
                  value={settings.groqApiKey || ''}
                  onChange={e => update({ groqApiKey: e.target.value })}
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
    </div>
  )
}
