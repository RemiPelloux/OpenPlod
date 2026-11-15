import { useEffect, useState } from 'react'
import { aiSettingsApi, profilesApi, type AiSettings, type AiConfig, type SpeechProvider, type TextProvider, type ProcessingJob, type TranscriptionProfile, type MonthSpend } from '@/lib/ai-settings'
import { PROMPT_LIMIT, configOf, customEndpointIsLocal, formatUsd, jobStatusLabel, languageLabel, languagesFor } from '@/lib/transcription'
import { omitsTranscriptionHints } from '../../../src/ai/capabilities'
import { t, tn } from '@/i18n'
import { PROFILES_CHANGED } from '@/components/TranscriptionProfilesPanel'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Save, RefreshCw, X, Loader2 } from '@/components/icons'

const speech: SpeechProvider[] = ['whisper', 'mistral', 'deepgram', 'openai', 'assemblyai', 'custom']
const text: TextProvider[] = ['mistral', 'openai', 'anthropic', 'gemini', 'ollama', 'custom']
const labels: Record<string, string> = { whisper: 'Whisper.cpp', mistral: 'Mistral', deepgram: 'Deepgram', openai: 'OpenAI', assemblyai: 'AssemblyAI', anthropic: 'Anthropic', ollama: 'Ollama', gemini: 'Gemini', custom: 'Custom endpoint' }
const providerName = (provider: string) => provider === 'custom' ? t('Custom endpoint') : labels[provider]
const tasks = ['analysis', 'document', 'chat'] as const
const selectClass = 'h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm'
const usdValue = (value: string) => value.trim() === '' ? null : Math.max(0, Number(value))
export function AiSettingsPanel() {
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [serverModels, setServerModels] = useState<string[]>([])
  const [keyEndpoint, setKeyEndpoint] = useState('')
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [vocabulary, setVocabulary] = useState('')
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [models, setModels] = useState<string[]>([]), [jobs, setJobs] = useState<ProcessingJob[]>([])
  const [contexts, setContexts] = useState<Record<string, number | null>>({}), [spend, setSpend] = useState<MonthSpend | null>(null)
  useEffect(() => { let active = true; aiSettingsApi.get().then(value => { if (active) { setSettings(value); setVocabulary(value.transcriptionVocabulary.join(', ')) } }).catch(e => { if (active) setError(e.message) }); aiSettingsApi.spending().then(value => { if (active) setSpend(value) }).catch(() => {}); return () => { active = false } }, [])
  const [profiles, setProfiles] = useState<TranscriptionProfile[]>([])
  useEffect(() => {
    const load = () => { profilesApi.list().then(value => setProfiles(value.profiles)).catch(() => setProfiles([])) }
    load(); window.addEventListener(PROFILES_CHANGED, load)
    return () => window.removeEventListener(PROFILES_CHANGED, load)
  }, [])
  const update = (patch: Partial<AiConfig>) => {
    setNotice('')
    if (patch.transcriptionVocabulary) setVocabulary(patch.transcriptionVocabulary.join(', '))
    if (patch.customBaseUrl !== undefined && patch.customBaseUrl !== settings?.customBaseUrl) {
      setServerModels([])
      if (settings?.transcriptionEngine === 'custom') patch = { ...patch, transcriptionModel: '' }
    }
    setSettings(value => value ? { ...value, ...patch } : value)
  }
  const action = async (run: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await run() } catch (e) { setError(e instanceof Error ? e.message : t('AI settings unavailable.')) } finally { setBusy(false) } }
  const save = () => action(async () => {
    if (!settings) return
    const config = configOf(settings)
    config.transcriptionVocabulary = vocabulary.split(',').map(value => value.trim()).filter(Boolean)
    if (keys.customApiKey && keyEndpoint && keyEndpoint !== settings.customBaseUrl) {
      throw new Error(t('Re-enter the custom API key for this endpoint.'))
    }
    await aiSettingsApi.save(config, keys); setKeys({}); setKeyEndpoint(''); setSettings(await aiSettingsApi.get()); setSpend(await aiSettingsApi.spending().catch(() => null)); setNotice(t('AI settings saved'))
  })
  const loadServerModels = () => action(async () => {
    if (!settings) return
    const endpoint = settings.customBaseUrl
    const key = !keyEndpoint || keyEndpoint === endpoint ? keys.customApiKey : undefined
    if (key && endpoint && !keyEndpoint) setKeyEndpoint(endpoint)
    const result = await aiSettingsApi.customModels(endpoint, key)
    setServerModels(result.models)
    setNotice(t('Server models loaded. Audio and speaker-label support depend on the selected model.'))
  })
  // Context windows of the selected local models, so long transcripts are refused up front rather than truncated.
  const loadModels = () => action(async () => {
    const installed = await aiSettingsApi.models(); setModels(installed)
    const selected = settings ? [...new Set(tasks.filter(task => settings[`${task}Provider`] === 'ollama').map(task => settings[`${task}Model`]).filter(model => installed.includes(model)))] : []
    const found = await Promise.all(selected.map(async model => [model, (await aiSettingsApi.ollamaContext(model).catch(() => null))?.contextLength ?? null] as const))
    setContexts(Object.fromEntries(found))
  })
  if (!settings) return <section className="border-t pt-5" aria-label={t('AI providers')}>{error ? <p role="alert">{error}</p> : <p role="status">{t('Loading AI settings...')}</p>}<Button variant="ghost" onClick={() => action(async () => setSettings(await aiSettingsApi.get()))}><RefreshCw />{t('Retry')}</Button></section>
  const ignoresContext = omitsTranscriptionHints(settings.transcriptionEngine, settings.transcriptionDiarize)
  const local = settings.privacyMode === 'local-only', capability = settings.capabilities[settings.transcriptionEngine]
  const customLocal = customEndpointIsLocal(settings.customBaseUrl)
  const isLocalText = (provider: TextProvider) => provider === 'ollama' || (provider === 'custom' && customLocal)
  const textUsed = tasks.flatMap(task => [settings[`${task}Provider`], ...settings[`${task}Fallback`].map(entry => entry.provider)])
  const used = [...new Set([settings.transcriptionEngine, ...settings.transcriptionFallback, ...textUsed])].filter(provider => !['whisper', 'ollama'].includes(provider))
  const languages = languagesFor(settings, settings.transcriptionEngine, settings.transcriptionModel)
  const languageOptions = languages.some(([code]) => code === settings.transcriptionLanguage) ? languages : [...languages, [settings.transcriptionLanguage, t('{language} (not documented for this model)', { language: languageLabel(settings.transcriptionLanguage) })] as [string, string]]
  return <section className="border-t pt-5 space-y-5" aria-label={t('AI providers')}>
    <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold">{t('AI providers')}</h2><Button disabled={busy} onClick={save}>{busy ? <Loader2 className="animate-spin" /> : <Save />}{t('Save AI')}</Button></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
    <label className="grid gap-2 text-sm">{t('Processing privacy')}<select className={selectClass} disabled={busy} value={settings.privacyMode} onChange={e => update(e.target.value === 'local-only' ? { privacyMode: 'local-only', transcriptionEngine: 'whisper', transcriptionModel: '', transcriptionDiarize: false, transcriptionVocabulary: [], transcriptionFallback: [], analysisProvider: 'ollama', analysisModel: '', documentProvider: 'ollama', documentModel: '', chatProvider: 'ollama', chatModel: '', analysisFallback: [], documentFallback: [], chatFallback: [] } : { privacyMode: 'selected-providers' })}><option value="selected-providers">{t('Selected providers')}</option><option value="local-only">{t('Local only')}</option></select></label>
    <fieldset disabled={busy} className="grid min-w-0 gap-4 sm:grid-cols-2"><legend className="mb-3 text-sm font-semibold">{t('Transcription')}</legend>
      <label className="grid gap-2 text-sm">{t('Provider')}<select className={selectClass} value={settings.transcriptionEngine} onChange={e => update({ transcriptionEngine: e.target.value as SpeechProvider, transcriptionModel: '', transcriptionDiarize: false, transcriptionVocabulary: [], transcriptionFallback: [], ...(settings.capabilities[e.target.value as SpeechProvider].prompt ? {} : { transcriptionPrompt: '' }) })}>{speech.map(provider => <option key={provider} disabled={local && provider !== 'whisper' && provider !== 'custom'} value={provider}>{providerName(provider)}</option>)}</select></label>
      <label className="grid gap-2 text-sm">{t('Model')}<select className={selectClass} value={settings.transcriptionModel} onChange={e => update({ transcriptionModel: e.target.value })}><option value="">{settings.transcriptionEngine === 'custom' ? t('Select server model') : t('{model} (default)', { model: capability.models[0] })}</option>{(settings.transcriptionEngine === 'custom' ? [...new Set([...serverModels, settings.transcriptionModel].filter(Boolean))] : capability.models).map(model => <option key={model}>{model}</option>)}</select></label>
      {settings.transcriptionEngine === 'custom' && <div className="grid gap-2 sm:col-span-2"><label className="grid gap-2 text-sm">{t('Custom OpenAI-compatible endpoint')}<Input value={settings.customBaseUrl} placeholder="http://127.0.0.1:18080/v1" onChange={e => update({ customBaseUrl: e.target.value.trim() })} /></label><Button type="button" variant="outline" onClick={loadServerModels}><RefreshCw />{t('Load server models')}</Button></div>}
      <label className="grid gap-2 text-sm">{t('Language')}<select className={selectClass} value={settings.transcriptionLanguage} onChange={e => update({ transcriptionLanguage: e.target.value })}>{languageOptions.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!capability.diarization} checked={settings.transcriptionDiarize} onChange={e => update({ transcriptionDiarize: e.target.checked })} />{t('Speaker labels')}</label>
      {ignoresContext && <p className="text-sm text-muted-foreground sm:col-span-2">{t('Speaker labels are on. Context and vocabulary won’t be sent.')}</p>}
      <label className="grid gap-2 text-sm sm:col-span-2">{t('Vocabulary hints')}<Input disabled={!capability.vocabulary || ignoresContext} value={vocabulary} onChange={e => { setVocabulary(e.target.value); setNotice('') }} /></label>
      <label className="grid gap-2 text-sm sm:col-span-2">{t('Default profile')}<select className={selectClass} value={settings.transcriptionProfile} onChange={e => update({ transcriptionProfile: e.target.value })}><option value="">{t('None')}</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}{settings.transcriptionProfile && !profiles.some(profile => profile.id === settings.transcriptionProfile) && <option value={settings.transcriptionProfile}>{t('Missing profile')}</option>}</select></label>
      <label className="grid gap-2 text-sm sm:col-span-2">{t('Context prompt')}<textarea className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm" disabled={!capability.prompt || ignoresContext} maxLength={PROMPT_LIMIT} rows={3} value={capability.prompt ? settings.transcriptionPrompt : ''} placeholder={capability.prompt ? t('Describe your usual recordings: who speaks, the topic, names to spell.') : t('{provider} does not accept a context prompt.', { provider: capability.label })} onChange={e => update({ transcriptionPrompt: e.target.value })} /></label>
      <label className="grid gap-2 text-sm sm:col-span-2">{t('Fallback provider')}<select className={selectClass} value={settings.transcriptionFallback[0] || ''} onChange={e => update({ transcriptionFallback: e.target.value ? [e.target.value as AiConfig['transcriptionFallback'][number]] : [] })}><option value="">{t('None')}</option>{speech.filter(provider => provider !== settings.transcriptionEngine && provider !== 'custom').map(provider => <option key={provider} disabled={local && provider !== 'whisper' && provider !== 'custom'} value={provider}>{providerName(provider)}</option>)}</select></label>
      <label className="grid gap-2 text-sm sm:col-span-2">{t('Split recordings longer than (minutes, 0 = only when a provider size limit requires it)')}<Input type="number" min={0} max={1440} step={1} value={settings.transcriptionChunkAboveMinutes} onChange={e => update({ transcriptionChunkAboveMinutes: Math.max(0, Math.min(1440, Math.round(Number(e.target.value) || 0))) })} /></label>
    </fieldset>
    <fieldset disabled={busy} className="space-y-4 border-t pt-4"><legend className="text-sm font-semibold">{t('Text AI')}</legend>{tasks.map(task => {
      const provider = settings[`${task}Provider`], model = settings[`${task}Model`], fallback = settings[`${task}Fallback`][0]?.provider ?? ''
      return <div key={task} className="grid gap-3 sm:grid-cols-3">
        <label className="grid gap-2 text-sm">{task === 'analysis' ? t('Summaries') : task === 'document' ? t('Documents') : t('Chat')}<select className={selectClass} value={provider} onChange={e => update({ [`${task}Provider`]: e.target.value, [`${task}Model`]: '', [`${task}Fallback`]: [] })}>{text.map(item => <option key={item} value={item} disabled={local && !isLocalText(item)}>{providerName(item)}</option>)}</select></label>
        <label className="grid gap-2 text-sm">{t('Model')}{provider === 'ollama' ? <select className={selectClass} value={model} onChange={e => update({ [`${task}Model`]: e.target.value })}><option value="">{t('Select installed model')}</option>{models.map(item => <option key={item}>{item}</option>)}</select> : <Input value={model} placeholder={provider === 'custom' ? t('Model name (required)') : t('{model} (default)', { model: settings.textCapabilities[provider]?.defaultModel ?? t('Provider') })} onChange={e => update({ [`${task}Model`]: e.target.value })} />}
          {provider === 'ollama' && model in contexts && <span className="text-xs text-muted-foreground">{contexts[model] ? t('Context window: {tokens} tokens (roughly {size} KB of text). Longer transcripts are refused, never sent to a cloud provider.', { tokens: contexts[model]!, size: Math.round(contexts[model]! * 4 / 1000) }) : t('Ollama did not report a context window for this model.')}</span>}</label>
        <label className="grid gap-2 text-sm">{t('Fallback')}<select className={selectClass} value={fallback} onChange={e => update({ [`${task}Fallback`]: e.target.value ? [{ provider: e.target.value as TextProvider, model: '' }] : [] })}><option value="">{t('None')}</option>{text.filter(item => item !== provider && !['ollama', 'custom'].includes(item)).map(item => <option key={item} value={item} disabled={local && !isLocalText(item)}>{labels[item]}</option>)}</select></label>
      </div>
    })}
    <p className="text-xs text-muted-foreground">{t('A fallback is used only when the first provider fails, and only the one you choose here. The provider that answered is recorded with each result.')}</p>
    {[...textUsed].includes('custom') && settings.transcriptionEngine !== 'custom' && <label className="grid gap-2 text-sm">{t('Custom OpenAI-compatible endpoint')}<Input value={settings.customBaseUrl} placeholder="https://example.com/v1" onChange={e => update({ customBaseUrl: e.target.value.trim() })} /><span className="text-xs text-muted-foreground">{customLocal ? t('Loopback endpoint: treated as local.') : t('Treated as a cloud provider. HTTPS is required (plain HTTP only on this computer); redirects are refused; JSON mode is not assumed.')}</span></label>}
    {textUsed.includes('ollama') && <Button variant="outline" onClick={loadModels}><RefreshCw />{t('Load local models')}</Button>}</fieldset>
    <fieldset disabled={busy} className="grid min-w-0 gap-4 border-t pt-4 sm:grid-cols-2"><legend className="mb-3 text-sm font-semibold">{t('Cloud spending')}</legend>
      <label className="grid gap-2 text-sm">{t('Monthly budget (USD)')}<Input type="number" min={0} step="0.01" value={settings.monthlyBudgetUsd ?? ''} placeholder={t('No budget')} onChange={e => update({ monthlyBudgetUsd: usdValue(e.target.value) })} /></label>
      <label className="grid gap-2 text-sm">{t('Ask before a job over (USD)')}<Input type="number" min={0} step="0.01" value={settings.confirmAboveUsd ?? ''} placeholder={t('Never ask')} onChange={e => update({ confirmAboveUsd: usdValue(e.target.value) })} /></label>
      <p className="text-xs text-muted-foreground sm:col-span-2">{spend ? `${t('Estimated this month ({month}, UTC): {amount}', { month: spend.month, amount: formatUsd(spend.estimatedUsd) })}${spend.unknownEntries ? tn(spend.unknownEntries, ', plus {count} job with unknown cost', ', plus {count} jobs with unknown cost') : ''}${spend.budgetUsd !== null ? t('; {remaining} of {budget} left', { remaining: formatUsd(spend.remainingUsd), budget: formatUsd(spend.budgetUsd) }) : ''}. ` : ''}{settings.pricing.label} {t('Prices as of {date}. Jobs over the budget or threshold need your confirmation; providers do not enforce this limit.', { date: settings.pricing.pricesAsOf })}</p>
    </fieldset>
    {used.length > 0 && <fieldset disabled={busy} className="space-y-4 border-t pt-4"><legend className="text-sm font-semibold">{t('Credentials')}</legend>{used.map(provider => <div key={provider} className="flex items-end gap-2"><label className="grid flex-1 gap-2 text-sm">{provider === 'custom' ? t('{provider} API key (optional)', { provider: providerName(provider) }) : t('{provider} API key', { provider: labels[provider] })}<Input type="password" autoComplete="off" value={keys[`${provider}ApiKey`] || ''} placeholder={settings.credentials[`${provider}ApiKey`] ? t('Saved key') : t('Not configured')} onChange={e => { if (provider === 'custom') setKeyEndpoint(settings.customBaseUrl); setKeys(value => ({ ...value, [`${provider}ApiKey`]: e.target.value })) }} /></label><Button variant="outline" disabled={Object.keys(keys).length > 0} onClick={() => action(async () => { await aiSettingsApi.check(provider); setNotice(t('{provider} connection verified', { provider: providerName(provider) })) })}>{t('Check')}</Button></div>)}</fieldset>}
    <details className="border-t pt-4"><summary className="cursor-pointer text-sm">{t('Processing jobs')}</summary><Button variant="ghost" className="my-2" onClick={() => action(async () => setJobs(await aiSettingsApi.jobs()))}><RefreshCw />{t('Refresh')}</Button><ul className="divide-y">{jobs.slice().reverse().map(job => <li key={job.id} className="flex items-center gap-2 py-3 text-sm"><div className="min-w-0 flex-1"><p className="truncate">{(job.provider ? providerName(job.provider) : '') || t('Processing')} / {jobStatusLabel(job.status)}{job.checkpoint?.progress ? ` / ${t('chunk {done} of {total}', { done: Math.min(job.checkpoint.progress.done + (job.status === 'running' ? 1 : 0), job.checkpoint.progress.total), total: job.checkpoint.progress.total })}` : ''}</p><p className="break-words text-xs text-muted-foreground">{job.error || job.checkpoint?.phase || job.recordingId}</p></div>{['running', 'pending'].includes(job.status) && <Button variant="ghost" size="icon" title={t('Cancel processing')} onClick={() => action(async () => { await aiSettingsApi.cancel(job.id); setJobs(await aiSettingsApi.jobs()) })}><X /></Button>}{(job.checkpoint?.remoteId || job.checkpoint?.inFlight === false) && ['failed', 'cancelled'].includes(job.status) && <Button variant="outline" onClick={() => action(async () => { await aiSettingsApi.resume(job.id); setJobs(await aiSettingsApi.jobs()) })}>{t('Resume')}</Button>}</li>)}</ul></details>
  </section>
}
