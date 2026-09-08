import { useEffect, useState } from 'react'
import { NoteDialog } from './NoteDialogs'
import { Button } from './ui/button'
import { AudioLines, Loader2, X } from './icons'
import { aiSettingsApi, type AiSettings, type SpeechProvider } from '@/lib/ai-settings'
import { api } from '@/lib/api'

export function TranscribeDialog({ recordingId, title, onClose, onQueued }: { recordingId: string; title: string; onClose: () => void; onQueued: () => void }) {
  const [settings, setSettings] = useState<AiSettings | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => { let active = true; aiSettingsApi.get().then(value => { if (active) setSettings(value) }).catch(e => { if (active) setError(e.message) }); return () => { active = false } }, [])
  const capability = settings?.capabilities[settings.transcriptionEngine]
  return <NoteDialog title="Transcribe recording" description={title} onClose={onClose} busy={busy}><form onSubmit={async event => {
    event.preventDefault(); if (!settings) return; setBusy(true); setError('')
    try { await api.transcribe(recordingId, { transcriptionEngine: settings.transcriptionEngine, transcriptionModel: settings.transcriptionModel, transcriptionFallback: [], transcriptionLanguage: settings.transcriptionLanguage, transcriptionDiarize: settings.transcriptionDiarize, transcriptionVocabulary: settings.transcriptionVocabulary }); onQueued(); onClose() }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not queue transcription.') } finally { setBusy(false) }
  }}>
    {settings && capability ? <>
      <label>Provider<select disabled={busy} value={settings.transcriptionEngine} onChange={e => setSettings({ ...settings, transcriptionEngine: e.target.value as SpeechProvider, transcriptionModel: '', transcriptionDiarize: false, transcriptionVocabulary: [] })}>{Object.entries(settings.capabilities).map(([id, item]) => <option key={id} value={id} disabled={settings.privacyMode === 'local-only' && !item.local}>{item.label}</option>)}</select></label>
      <label>Model<select disabled={busy} value={settings.transcriptionModel} onChange={e => setSettings({ ...settings, transcriptionModel: e.target.value })}><option value="">{capability.models[0]} (default)</option>{capability.models.map(model => <option key={model}>{model}</option>)}</select></label>
      <label>Language<select disabled={busy} value={settings.transcriptionLanguage} onChange={e => setSettings({ ...settings, transcriptionLanguage: e.target.value })}>{[['auto', 'Detect automatically'], ['fr', 'French'], ['en', 'English'], ['de', 'German'], ['es', 'Spanish'], ['it', 'Italian'], ['pt', 'Portuguese']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <p className="note-ai-disclosure">{capability.local ? 'Audio will be processed on this Mac.' : `Audio will be sent to ${capability.label}. Provider charges may apply.`} No fallback provider. Original audio and manual edits are retained.</p>
    </> : <p role="status">Loading transcription settings...</p>}
    {error && <p role="alert" className="note-error">{error}</p>}
    <footer><Button type="button" variant="ghost" disabled={busy} onClick={onClose}><X />Cancel</Button><Button disabled={!settings || busy}>{busy ? <Loader2 className="animate-spin" /> : <AudioLines />}Transcribe</Button></footer>
  </form></NoteDialog>
}
