import { useEffect, useMemo, useState } from 'react'
import { NoteDialog } from './NoteDialogs'
import { Button } from './ui/button'
import { AudioLines, Loader2, X } from './icons'
import { aiSettingsApi, profilesApi, type AiSettings, type CostEstimate, type SpeechProvider, type TranscriptionProfile } from '@/lib/ai-settings'
import { PROMPT_LIMIT, customEndpointIsLocal, describeEstimate, joinLabels, languagesFor, profileFit } from '@/lib/transcription'
import { omitsTranscriptionHints } from '../../../src/ai/capabilities'
import { t } from '@/i18n'
import { api } from '@/lib/api'
import './profiles.css'

export function TranscribeDialog({ recordingId, title, onClose, onQueued }: { recordingId: string; title: string; onClose: () => void; onQueued: () => void }) {
  const [settings, setSettings] = useState<AiSettings | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [serverModels, setServerModels] = useState<string[]>([])
  const [profiles, setProfiles] = useState<TranscriptionProfile[]>([])
  useEffect(() => {
    let active = true
    Promise.all([aiSettingsApi.get(), profilesApi.list().then(value => value.profiles).catch(() => [])])
      .then(([value, list]) => { if (active) { setSettings(value); setProfiles(list) } })
      .catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [])
  const profile = profiles.find(item => item.id === settings?.transcriptionProfile) ?? null
  // A provider-specific profile chooses its own engine, so the provider picker follows it.
  const engine = profile?.engine ?? settings?.transcriptionEngine
  const ignoresContext = engine !== undefined && omitsTranscriptionHints(engine, profile?.diarize ?? settings?.transcriptionDiarize ?? false)
  const capability = settings && engine ? settings.capabilities[engine] : undefined
  const customLocal = customEndpointIsLocal(settings?.customBaseUrl ?? '')
  const fit = settings && profile ? profileFit(profile, settings) : null
  const [estimate, setEstimate] = useState<CostEstimate | null>(null), [costAccepted, setCostAccepted] = useState(false)
  const overrides = useMemo(() => settings ? { transcriptionEngine: settings.transcriptionEngine, transcriptionModel: settings.transcriptionModel, transcriptionFallback: [], transcriptionLanguage: settings.transcriptionLanguage, transcriptionDiarize: settings.transcriptionDiarize, transcriptionVocabulary: settings.transcriptionVocabulary, transcriptionPrompt: capability?.prompt ? settings.transcriptionPrompt : '', transcriptionProfile: settings.transcriptionProfile } : null, [settings, capability?.prompt])
  // AI-10: the estimate follows the provider, model and profile chosen here.
  useEffect(() => {
    if (!overrides) return
    let active = true
    aiSettingsApi.estimate([recordingId], overrides).then(value => { if (active) { setEstimate(value); setCostAccepted(false) } }).catch(() => { if (active) setEstimate(null) })
    return () => { active = false }
  }, [recordingId, overrides])
  return <NoteDialog title={t('Transcribe recording')} description={title} onClose={onClose} busy={busy}><form onSubmit={async event => {
    event.preventDefault(); if (!settings) return; setBusy(true); setError('')
    try {
      let expectedCustomEndpoint: string | undefined
      if (engine === 'custom') {
        const fresh = await aiSettingsApi.get()
        const freshLocal = customEndpointIsLocal(fresh.customBaseUrl)
        if (fresh.customBaseUrl !== settings.customBaseUrl || freshLocal !== customLocal) {
          setSettings({ ...settings, customBaseUrl: fresh.customBaseUrl, privacyMode: fresh.privacyMode, transcriptionModel: '' })
          setServerModels([])
          setCostAccepted(false)
          throw new Error(t('The custom endpoint changed. Review the destination and confirm again.'))
        }
        if (fresh.privacyMode === 'local-only' && !freshLocal) {
          throw new Error(t('Local-only mode blocks this provider. Change AI settings before sending data.'))
        }
        expectedCustomEndpoint = fresh.customBaseUrl
      }
      await api.transcribe(recordingId, { ...overrides, expectedProvider: engine, expectedCustomEndpoint, ...(costAccepted ? { confirmCost: true } : {}) })
      onQueued(); onClose()
    } catch (e) { setError(e instanceof Error ? e.message : t('Could not queue transcription.')) } finally { setBusy(false) }
  }}>
    {settings && capability ? <>
      <label>{t('Profile')}<select disabled={busy} value={settings.transcriptionProfile} onChange={e => setSettings({ ...settings, transcriptionProfile: e.target.value })}>
        <option value="">{t('None')}</option>{profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      {profile && <p className="profile-hint" {...(fit?.ignored.length ? { 'data-warn': '' } : {})}>{profile.prompt || profile.description || t('No context prompt.')}{fit?.ignored.length ? ` ${t('{provider} will not receive the {items}.', { provider: fit.label, items: joinLabels(fit.ignored, 'disjunction') })}` : ''}</p>}
      <label>{t('Provider')}<select disabled={busy || Boolean(profile?.engine)} value={engine} onChange={e => { const next = e.target.value as SpeechProvider; setSettings({ ...settings, transcriptionEngine: next, transcriptionModel: '', transcriptionDiarize: false, transcriptionVocabulary: [], ...(settings.capabilities[next].prompt ? {} : { transcriptionPrompt: '' }) }) }}>{Object.entries(settings.capabilities).map(([id, item]) => <option key={id} value={id} disabled={settings.privacyMode === 'local-only' && !item.local && !(id === 'custom' && customLocal)}>{item.label}</option>)}</select></label>
      {!profile?.engine && <label>{t('Model')}<select disabled={busy} value={settings.transcriptionModel} onChange={e => setSettings({ ...settings, transcriptionModel: e.target.value })}><option value="">{engine === 'custom' ? t('Select server model') : t('{model} (default)', { model: capability.models[0] })}</option>{(engine === 'custom' ? [...new Set([...serverModels, settings.transcriptionModel].filter(Boolean))] : capability.models).map(model => <option key={model}>{model}</option>)}</select></label>}
      {engine === 'custom' && <Button type="button" variant="outline" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { setServerModels((await aiSettingsApi.customModels()).models) } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }}>{t('Load server models')}</Button>}
      {capability.diarization && <label><input type="checkbox" disabled={busy || profile?.diarize != null} checked={profile?.diarize ?? settings.transcriptionDiarize} onChange={e => setSettings({ ...settings, transcriptionDiarize: e.target.checked })} />{t('Speaker labels')}</label>}
      {!profile?.language && <label>{t('Language')}<select disabled={busy} value={settings.transcriptionLanguage} onChange={e => setSettings({ ...settings, transcriptionLanguage: e.target.value })}>{languagesFor(settings, engine!, profile?.engine ? profile.model : settings.transcriptionModel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
      {ignoresContext && <p className="note-ai-disclosure">{t('Speaker labels are on. Context and vocabulary won’t be sent.')}</p>}
      {capability.prompt && <label>{t('Context for this recording')}<textarea rows={2} maxLength={PROMPT_LIMIT} disabled={busy || ignoresContext} value={settings.transcriptionPrompt} placeholder={t('Optional: who speaks, the topic, names to spell')} onChange={e => setSettings({ ...settings, transcriptionPrompt: e.target.value })} /></label>}
      <p className="note-ai-disclosure">{capability.local || (engine === 'custom' && customLocal) ? t('Audio will be processed on this computer.') : t('Audio will be sent to {provider}. Provider charges may apply.', { provider: capability.label })} {t('No fallback provider. Original audio and manual edits are retained.')}</p>
      {estimate && <p className="note-ai-disclosure" role="status">{describeEstimate(estimate)}{estimate.items[0]?.unknownReason ? ` ${estimate.items[0].unknownReason}` : ''}</p>}
      {estimate?.confirmationRequired && <label className="profile-hint" data-warn=""><input type="checkbox" checked={costAccepted} disabled={busy} onChange={e => setCostAccepted(e.target.checked)} /> {estimate.reasons.join(' ')} {t('I accept this estimated cost.')}</label>}
    </> : <p role="status">{t('Loading transcription settings...')}</p>}
    {error && <p role="alert" className="note-error">{error}</p>}
    <footer><Button type="button" variant="ghost" disabled={busy} onClick={onClose}><X />{t('Cancel')}</Button><Button disabled={!settings || busy || Boolean(estimate?.confirmationRequired && !costAccepted)}>{busy ? <Loader2 className="animate-spin" /> : <AudioLines />}{t('Transcribe')}</Button></footer>
  </form></NoteDialog>
}
