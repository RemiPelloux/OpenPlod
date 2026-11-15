import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle, Check, Download, FileText, History, Loader2, Plus, Search, Sparkles, Speech, Trash2,
  Undo2, Wand2,
} from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  api, speakerLabel, type CleanupProposal, type CustomAction, type CustomActionResult, type ProviderComparisonRun,
  type Recording, type SavedStructure, type StructureExportFormat, type StructureProposal, type StudioSegment,
  type TranscriptDiff, type TranscriptStructure, type TranscriptVersion, type TranslationProposal, type VersionComparison,
} from '@/lib/api'
import { exportDocument, safeDocumentName } from '@/lib/document-export'
import { apiUrl, authenticatedHeaders } from '@/lib/runtime'
import { providerVersionPair, versionTitle } from '@/lib/provider-versions'
import { jobStatusLabel } from '@/lib/transcription'
import { formatDate, t, tn } from '@/i18n'
import './transcript-studio.css'

/**
 * Transcript Studio (roadmap TS-02..TS-06, TS-09, TS-11).
 *
 * Every destructive or AI-assisted action here is a two-step: propose, show
 * exactly what would change, then save on an explicit confirmation. Nothing in
 * this component writes on the first click, and every panel that can produce
 * an empty or unavailable result says why rather than rendering blank.
 */

const changeKindLabel = (kind: VersionComparison['changeKind']) => ({
  'manual-correction': t('Your correction to generated text'),
  regeneration: t('Model output replacing earlier model output'),
  'manual-revision': t('Your revision of your own edit'),
  'reverted-to-generated': t('Model output replacing your edit'),
} satisfies Record<VersionComparison['changeKind'], string>)[kind]

const formatTime = (seconds: number | null) => {
  if (seconds === null) return null
  const total = Math.max(0, Math.floor(seconds))
  const hh = Math.floor(total / 3600)
  const mm = Math.floor((total % 3600) / 60)
  const ss = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`
}

const message = (error: unknown) => (error instanceof Error ? error.message : t('Something went wrong.'))
const dateTime = (value: string) => formatDate(value, { dateStyle: 'short', timeStyle: 'short' })
const originLabel = (origin: string) => origin === 'generated' ? t('generated') : origin === 'edited' ? t('edited') : origin

/** Inline word diff. Identical text is stated rather than shown as a blank. */
function DiffView({ diff }: { diff: TranscriptDiff }) {
  if (diff.stats.identical) return <p className="tstudio-empty">{t('The model returned the text unchanged.')}</p>
  return (
    <>
      <p className="tstudio-diff-stats">
        {t('+{inserted} / −{deleted} words', { inserted: diff.stats.inserted, deleted: diff.stats.deleted })}
        {diff.granularity !== 'word' && <span> · {t('compared by {unit}', { unit: diff.granularity === 'line' ? t('line') : t('block') })}</span>}
      </p>
      <div className="tstudio-diff" aria-label={t('Proposed changes')}>
        {diff.parts.map((part, index) => (
          <span key={index} className={`tstudio-diff-${part.op}`}>{part.text}</span>
        ))}
      </div>
    </>
  )
}

// Memoized: the recording page re-renders on every playback tick, and the Studio does not depend on the clock.
export const TranscriptStudio = memo(function TranscriptStudio({ recording, onChanged }: { recording: Recording; onChanged: () => Promise<void> | void }) {
  const [tab, setTab] = useState<'edit' | 'versions' | 'ai' | 'structure' | 'actions'>('edit')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const segments: StudioSegment[] = useMemo(
    () => (recording.segments ?? []).map(segment => ({
      start: segment.startTime, end: segment.endTime, text: segment.text, speaker: segment.speakerId,
    })),
    [recording.segments],
  )
  const speakers = useMemo(() => {
    const seen: (number | string)[] = []
    for (const segment of segments) {
      if (segment.speaker === null || segment.speaker === undefined) continue
      if (!seen.some(value => String(value) === String(segment.speaker))) seen.push(segment.speaker)
    }
    return seen
  }, [segments])

  /** Run an action with one busy flag, so two writes cannot overlap. */
  const run = useCallback(async (key: string, action: () => Promise<string | void>) => {
    setBusy(key); setError(''); setNotice('')
    try {
      const result = await action()
      if (mounted.current && typeof result === 'string') setNotice(result)
    } catch (failure) {
      if (mounted.current) setError(message(failure))
    } finally {
      if (mounted.current) setBusy('')
    }
  }, [])

  const hasTranscript = Boolean(recording.transcriptText?.trim())

  return (
    <section className="transcript-studio" aria-label={t('Transcript Studio')}>
      <nav className="tstudio-tabs" role="tablist">
        {([['edit', t('Edit'), Speech], ['versions', t('Versions'), History], ['ai', t('AI cleanup'), Wand2], ['structure', t('Structure'), Sparkles], ['actions', t('Actions'), Plus]] as const)
          .map(([value, label, Icon]) => (
            <button key={value} role="tab" aria-selected={tab === value} className="tstudio-tab"
              data-active={tab === value} onClick={() => { setTab(value); setError(''); setNotice('') }}>
              <Icon />{label}
            </button>
          ))}
      </nav>

      {error && <p className="tstudio-error" role="alert"><AlertCircle />{error}</p>}
      {notice && <p className="tstudio-notice" role="status"><Check />{notice}</p>}

      {!hasTranscript
        ? <p className="tstudio-empty">{t('Transcribe this recording to use the Transcript Studio.')}</p>
        : (
          <>
            {tab === 'edit' && <EditPanel recording={recording} speakers={speakers} segments={segments} busy={busy} run={run} onChanged={onChanged} />}
            {tab === 'versions' && <VersionsPanel recording={recording} busy={busy} run={run} onChanged={onChanged} />}
            {tab === 'ai' && <AiPanel recording={recording} busy={busy} run={run} onChanged={onChanged} />}
            {tab === 'structure' && <StructurePanel recording={recording} busy={busy} run={run} />}
            {tab === 'actions' && <ActionsPanel recording={recording} busy={busy} run={run} />}
          </>
        )}
    </section>
  )
})

type Runner = (key: string, action: () => Promise<string | void>) => Promise<void>

// ---------------------------------------------------------------------------
// TS-02 — speaker and text edits
// ---------------------------------------------------------------------------

function EditPanel({ recording, speakers, segments, busy, run, onChanged }: {
  recording: Recording; speakers: (number | string)[]; segments: StudioSegment[]; busy: string; run: Runner
  onChanged: () => Promise<void> | void
}) {
  const segmentCount = segments.length
  const [search, setSearch] = useState('')
  const [replacement, setReplacement] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [scope, setScope] = useState<string>('')
  const [preview, setPreview] = useState<{ summaries: string[]; count: number } | null>(null)
  const [renameFrom, setRenameFrom] = useState<string>('')
  const [renameTo, setRenameTo] = useState('')
  const [splitIndex, setSplitIndex] = useState(0)
  const [splitOffset, setSplitOffset] = useState(1)
  const [mergeStart, setMergeStart] = useState(0)
  const [mergeCount, setMergeCount] = useState(2)

  const replaceOperation = () => ({
    op: 'replace' as const, search, replacement, matchCase, wholeWord,
    speaker: scope === '' ? null : scope,
  })

  return (
    <div className="tstudio-panel">
      <h3>{t('Find and replace')}</h3>
      <div className="tstudio-row">
        <label className="tstudio-field"><span>{t('Find')}</span>
          <input value={search} onChange={event => { setSearch(event.target.value); setPreview(null) }} maxLength={2000} placeholder={t('Text to find')} />
        </label>
        <label className="tstudio-field"><span>{t('Replace with')}</span>
          <input value={replacement} onChange={event => setReplacement(event.target.value)} maxLength={2000} placeholder={t('Replacement')} />
        </label>
      </div>
      <div className="tstudio-row tstudio-row--options">
        <label><input type="checkbox" checked={matchCase} onChange={event => setMatchCase(event.target.checked)} />{t('Match case')}</label>
        <label><input type="checkbox" checked={wholeWord} onChange={event => setWholeWord(event.target.checked)} />{t('Whole word')}</label>
        {speakers.length > 0 && (
          <label className="tstudio-field tstudio-field--inline"><span>{t('Only speaker')}</span>
            <select value={scope} onChange={event => setScope(event.target.value)}>
              <option value="">{t('All speakers')}</option>
              {speakers.map(speaker => <option key={String(speaker)} value={String(speaker)}>{speakerLabel(speaker)}</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="tstudio-actions">
        <Button variant="outline" size="sm" disabled={!search || Boolean(busy)}
          onClick={() => void run('preview', async () => {
            const result = await api.transcriptOperations(recording.id, [replaceOperation()], { preview: true })
            const count = Number(result.summaries[0]?.match(/\d+/)?.[0] ?? 0)
            setPreview({ summaries: result.summaries, count })
          })}>
          {busy === 'preview' ? <Loader2 className="tstudio-spin" /> : <Search />}{t('Preview')}
        </Button>
        <Button size="sm" disabled={!search || !preview?.count || Boolean(busy)}
          onClick={() => void run('replace', async () => {
            const result = await api.transcriptOperations(recording.id, [replaceOperation()], { revision: recording.revision })
            setPreview(null); setSearch('')
            await onChanged()
            return result.summaries.join('; ')
          })}>
          {busy === 'replace' ? <Loader2 className="tstudio-spin" /> : <Check />}{t('Apply')}
        </Button>
      </div>
      {preview && (
        <p className="tstudio-preview">
          {preview.count === 0 ? t('No matches. Nothing would change.') : t('{summary}. Nothing saved yet.', { summary: preview.summaries.join('; ') })}
        </p>
      )}

      <h3>{t('Speakers')}</h3>
      {speakers.length === 0
        ? <p className="tstudio-empty">{t('This transcript has no speaker labels, so there is nothing to rename.')}</p>
        : (
          <>
            <div className="tstudio-row">
              <label className="tstudio-field"><span>{t('Rename')}</span>
                <select value={renameFrom} onChange={event => setRenameFrom(event.target.value)}>
                  <option value="">{t('Choose a speaker')}</option>
                  {speakers.map(speaker => <option key={String(speaker)} value={String(speaker)}>{speakerLabel(speaker)}</option>)}
                </select>
              </label>
              <label className="tstudio-field"><span>{t('To')}</span>
                <input value={renameTo} onChange={event => setRenameTo(event.target.value)} maxLength={80} placeholder={t('Name')} />
              </label>
            </div>
            <p className="tstudio-hint">{t('Renaming onto an existing name merges the two speakers.')}</p>
            <div className="tstudio-actions">
              <Button size="sm" disabled={!renameFrom || !renameTo.trim() || Boolean(busy)}
                onClick={() => void run('rename', async () => {
                  const result = await api.transcriptOperations(recording.id,
                    [{ op: 'rename-speaker', from: renameFrom, to: renameTo.trim() }], { revision: recording.revision })
                  setRenameFrom(''); setRenameTo('')
                  await onChanged()
                  return result.summaries.join('; ')
                })}>
                {busy === 'rename' ? <Loader2 className="tstudio-spin" /> : <Check />}{t('Rename')}
              </Button>
            </div>
          </>
        )}
      <h3>{t('Segments')}</h3>
      {segmentCount === 0
        ? <p className="tstudio-empty">{t('This transcript has no segments, so it cannot be split or merged.')}</p>
        : (
          <>
            <div className="tstudio-row">
              <label className="tstudio-field"><span>{t('Split segment')}</span>
                <select value={splitIndex} onChange={event => setSplitIndex(Number(event.target.value))}>
                  {segments.map((segment, index) => (
                    <option key={index} value={index}>{index + 1}. {segment.text.slice(0, 60)}</option>
                  ))}
                </select>
              </label>
              <label className="tstudio-field tstudio-field--inline"><span>{t('At character')}</span>
                <input type="number" min={1} max={Math.max(1, (segments[splitIndex]?.text.length ?? 2) - 1)}
                  value={splitOffset} onChange={event => setSplitOffset(Number(event.target.value))} />
              </label>
            </div>
            <p className="tstudio-hint">
              {t('Splits into “{first}” and “{second}”. The boundary is interpolated inside this segment’s own span; an untimed segment stays untimed.', {
                first: (segments[splitIndex]?.text ?? '').slice(0, splitOffset).trim() || '…',
                second: (segments[splitIndex]?.text ?? '').slice(splitOffset).trim() || '…',
              })}
            </p>
            <div className="tstudio-actions">
              <Button variant="outline" size="sm" disabled={Boolean(busy)}
                onClick={() => void run('split', async () => {
                  const result = await api.transcriptOperations(recording.id,
                    [{ op: 'split-segment', index: splitIndex, offset: splitOffset }], { revision: recording.revision })
                  await onChanged()
                  return result.summaries.join('; ')
                })}>
                {busy === 'split' ? <Loader2 className="tstudio-spin" /> : <Check />}{t('Split')}
              </Button>
            </div>

            <div className="tstudio-row">
              <label className="tstudio-field tstudio-field--inline"><span>{t('Merge from segment')}</span>
                <input type="number" min={1} max={segmentCount} value={mergeStart + 1}
                  onChange={event => setMergeStart(Math.max(0, Number(event.target.value) - 1))} />
              </label>
              <label className="tstudio-field tstudio-field--inline"><span>{t('How many')}</span>
                <input type="number" min={2} max={Math.max(2, segmentCount - mergeStart)} value={mergeCount}
                  onChange={event => setMergeCount(Number(event.target.value))} />
              </label>
            </div>
            <p className="tstudio-hint">{t('Merging across different speakers clears the label rather than picking one.')}</p>
            <div className="tstudio-actions">
              <Button variant="outline" size="sm" disabled={Boolean(busy) || mergeStart + mergeCount > segmentCount}
                onClick={() => void run('merge', async () => {
                  const result = await api.transcriptOperations(recording.id,
                    [{ op: 'merge-segments', start: mergeStart, count: mergeCount }], { revision: recording.revision })
                  await onChanged()
                  return result.summaries.join('; ')
                })}>
                {busy === 'merge' ? <Loader2 className="tstudio-spin" /> : <Check />}{t('Merge')}
              </Button>
            </div>
          </>
        )}

      <h3>{t('Undo')}</h3>
      <p className="tstudio-hint">
        {t('Undo restores the version before the current one. Because every edit is a saved version, this survives a reload and the undone version stays in history.')}
      </p>
      <div className="tstudio-actions">
        <Button variant="outline" size="sm" disabled={Boolean(busy)}
          onClick={() => void run('undo', async () => {
            const versions = await api.getTranscriptVersions(recording.id)
            const currentIndex = versions.findIndex(version => version.id === recording.transcriptVersionId)
            // Versions come back newest first, so the one after the current is its predecessor.
            const previous = currentIndex === -1 ? versions[1] : versions[currentIndex + 1]
            if (!previous) throw new Error(t('There is no earlier version to undo to.'))
            await api.promoteTranscriptVersion(recording.id, previous.id, recording.revision)
            await onChanged()
            return t('Restored the {origin} version from {date}.', { origin: originLabel(previous.origin), date: dateTime(previous.createdAt) })
          })}>
          {busy === 'undo' ? <Loader2 className="tstudio-spin" /> : <Undo2 />}{t('Undo last change')}
        </Button>
      </div>

      <p className="tstudio-hint">{tn(segmentCount, '{count} segment. Every change creates a new version; nothing is overwritten.', '{count} segments. Every change creates a new version; nothing is overwritten.')}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// TS-03 — versions
// ---------------------------------------------------------------------------

function VersionsPanel({ recording, busy, run, onChanged }: {
  recording: Recording; busy: string; run: Runner; onChanged: () => Promise<void> | void
}) {
  const [versions, setVersions] = useState<TranscriptVersion[] | null>(null)
  const [before, setBefore] = useState('')
  const [after, setAfter] = useState('')
  const [comparison, setComparison] = useState<VersionComparison | null>(null)
  const [loadError, setLoadError] = useState('')
  // Bumped when a provider comparison finishes, so its new version appears.
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let active = true
    api.getTranscriptVersions(recording.id)
      .then(rows => { if (!active) return; setVersions(rows); setBefore(rows[1]?.id ?? ''); setAfter(rows[0]?.id ?? '') })
      .catch(failure => { if (active) setLoadError(message(failure)) })
    return () => { active = false }
  }, [recording.id, recording.revision, refreshKey])

  if (loadError) return <p className="tstudio-error" role="alert"><AlertCircle />{loadError}</p>
  if (!versions) return <p className="tstudio-empty">{t('Loading versions…')}</p>
  if (versions.length === 0) return <p className="tstudio-empty">{t('This transcript has no saved versions yet.')}</p>

  const label = (version: TranscriptVersion) =>
    `${versionTitle(version)} · ${dateTime(version.createdAt)}`

  const providerPair = providerVersionPair(versions, recording.transcriptVersionId)
  const beforeVersion = versions.find(version => version.id === before)
  const afterVersion = versions.find(version => version.id === after)
  const acrossProviders = Boolean(beforeVersion?.provenance?.provider && afterVersion?.provenance?.provider
    && beforeVersion.provenance.provider !== afterVersion.provenance.provider)

  return (
    <div className="tstudio-panel">
      <h3>{t('Compare versions')}</h3>
      <div className="tstudio-row">
        <label className="tstudio-field"><span>{t('Before')}</span>
          <select value={before} onChange={event => { setBefore(event.target.value); setComparison(null) }}>
            {versions.map(version => <option key={version.id} value={version.id}>{label(version)}</option>)}
          </select>
        </label>
        <label className="tstudio-field"><span>{t('After')}</span>
          <select value={after} onChange={event => { setAfter(event.target.value); setComparison(null) }}>
            {versions.map(version => <option key={version.id} value={version.id}>{label(version)}</option>)}
          </select>
        </label>
      </div>
      <div className="tstudio-actions">
        <Button variant="outline" size="sm" disabled={!before || !after || before === after || Boolean(busy)}
          onClick={() => void run('compare', async () => { setComparison(await api.compareTranscriptVersions(recording.id, before, after)) })}>
          {busy === 'compare' ? <Loader2 className="tstudio-spin" /> : <History />}{t('Compare')}
        </Button>
      </div>
      {before === after && <p className="tstudio-hint">{t('Choose two different versions.')}</p>}
      {providerPair && (
        <div className="tstudio-actions">
          <Button variant="ghost" size="sm" disabled={Boolean(busy)}
            onClick={() => void run('compare-providers', async () => {
              const [first, second] = providerPair
              setBefore(first.id); setAfter(second.id)
              setComparison(await api.compareTranscriptVersions(recording.id, first.id, second.id))
            })}>
            {busy === 'compare-providers' ? <Loader2 className="tstudio-spin" /> : <History />}
            {t('Compare {first} with {second}', { first: String(providerPair[0].provenance?.provider ?? ''), second: String(providerPair[1].provenance?.provider ?? '') })}
          </Button>
        </div>
      )}

      {comparison && (
        <>
          {acrossProviders && beforeVersion && afterVersion
            ? <p className="tstudio-change-kind">
              {t('Two transcription providers: {before} (removed text) and {after} (added text)', { before: versionTitle(beforeVersion), after: versionTitle(afterVersion) })}
            </p>
            : <p className="tstudio-change-kind">{changeKindLabel(comparison.changeKind)}</p>}
          <DiffView diff={comparison.diff} />
        </>
      )}

      <h3>{t('Versions')}</h3>
      <ul className="tstudio-versions">
        {versions.map(version => (
          <li key={version.id}>
            <div>
              <strong>{versionTitle(version)}</strong>
              <small>{dateTime(version.createdAt)}</small>
            </div>
            {version.id === recording.transcriptVersionId
              ? <span className="tstudio-current">{t('Current')}</span>
              : (
                <Button variant="outline" size="sm" disabled={Boolean(busy)}
                  onClick={() => void run(`promote-${version.id}`, async () => {
                    await api.promoteTranscriptVersion(recording.id, version.id, recording.revision)
                    await onChanged()
                    return t('Version promoted. The replaced version is still in history.')
                  })}>
                  {busy === `promote-${version.id}` ? <Loader2 className="tstudio-spin" /> : null}{t('Make current')}
                </Button>
              )}
          </li>
        ))}
      </ul>

      <ProviderComparison recording={recording} busy={busy} run={run} onVersionAdded={() => setRefreshKey(key => key + 1)} />
    </div>
  )
}

const providerLabel = (name: string) => ({
  custom: t('Custom endpoint'), whisper: t('Whisper.cpp (local)'), mistral: 'Mistral Voxtral', deepgram: 'Deepgram', openai: 'OpenAI', assemblyai: 'AssemblyAI',
} as Record<string, string>)[name] ?? name

// ---------------------------------------------------------------------------
// TS-11 — compare transcription providers
// ---------------------------------------------------------------------------

const COMPARISON_POLL_MS = 3000

function ProviderComparison({ recording, busy, run, onVersionAdded }: {
  recording: Recording; busy: string; run: Runner; onVersionAdded: () => void
}) {
  const [runs, setRuns] = useState<ProviderComparisonRun[] | null>(null)
  const [available, setAvailable] = useState<Record<string, boolean>>({})
  const [provider, setProvider] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [loadError, setLoadError] = useState('')
  const added = useRef(onVersionAdded)
  useEffect(() => { added.current = onVersionAdded }, [onVersionAdded])

  const seen = useRef<ProviderComparisonRun[] | null>(null)
  const apply = useCallback((data: { runs: ProviderComparisonRun[]; available: Record<string, boolean> }) => {
    const previous = seen.current
    seen.current = data.runs
    // A run that just produced its version refreshes the version list.
    if (previous && data.runs.some(next => next.versionId && !previous.some(old => old.jobId === next.jobId && old.versionId))) added.current()
    setRuns(data.runs)
    setAvailable(data.available)
  }, [])
  const load = useCallback(async () => { apply(await api.providerComparisons(recording.id)) }, [apply, recording.id])

  useEffect(() => {
    let active = true
    api.providerComparisons(recording.id)
      .then(data => { if (active) apply(data) })
      .catch(failure => { if (active) setLoadError(message(failure)) })
    return () => { active = false }
  }, [apply, recording.id])

  const pending = runs?.some(item => item.status === 'pending' || item.status === 'running') ?? false
  useEffect(() => {
    if (!pending) return
    const timer = window.setInterval(() => { void load().catch(() => {}) }, COMPARISON_POLL_MS)
    return () => window.clearInterval(timer)
  }, [pending, load])

  const choices = Object.entries(available).filter(([, ok]) => ok).map(([name]) => name)
  const local = provider === 'whisper'

  return (
    <>
      <h3>{t('Compare transcription providers')}</h3>
      <p className="tstudio-hint">
        {t('Transcribes the same saved audio with another provider. The result is a separate version; it never replaces the current transcript unless you choose Make current.')}
      </p>
      {loadError && <p className="tstudio-error" role="alert"><AlertCircle />{loadError}</p>}
      {choices.length === 0
        ? <p className="tstudio-empty">{t('No transcription provider is configured. Add one in AI settings.')}</p>
        : (
          <>
            <div className="tstudio-row">
              <label className="tstudio-field tstudio-field--inline"><span>{t('Provider')}</span>
                <select value={provider} onChange={event => { setProvider(event.target.value); setConfirmed(false) }}>
                  <option value="">{t('Choose a provider')}</option>
                  {choices.map(name => <option key={name} value={name}>{providerLabel(name)}</option>)}
                </select>
              </label>
            </div>
            {provider && (
              <label className="tstudio-confirm">
                <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
                {local
                  ? t('I understand the audio is transcribed again locally with Whisper.cpp, which can take a while.')
                  : t('I understand the full audio is uploaded again to {provider} and this run may be billed by that provider. Cost is not estimated here.', { provider: providerLabel(provider) })}
              </label>
            )}
            <div className="tstudio-actions">
              <Button size="sm" disabled={!provider || !confirmed || Boolean(busy)}
                onClick={() => void run('provider-compare', async () => {
                  const result = await api.startProviderComparison(recording.id, provider)
                  setConfirmed(false)
                  await load()
                  return result.alreadyQueued
                    ? t('A {provider} comparison is already queued for this recording.', { provider: providerLabel(provider) })
                    : t('Queued. The {provider} version appears in the list above when it finishes.', { provider: providerLabel(provider) })
                })}>
                {busy === 'provider-compare' ? <Loader2 className="tstudio-spin" /> : <Speech />}{t('Run comparison')}
              </Button>
            </div>
          </>
        )}
      {runs && runs.length > 0 && (
        <ul className="tstudio-versions">
          {runs.map(item => (
            <li key={item.jobId}>
              <div>
                <strong>{providerLabel(item.provider)}</strong>
                <small>{dateTime(item.createdAt)} · {jobStatusLabel(item.status)}{item.error ? ` · ${item.error}` : ''}</small>
              </div>
              {item.versionId && <span className="tstudio-current">{t('Version saved')}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// TS-04 / TS-05 — reviewed cleanup and translation
// ---------------------------------------------------------------------------

function AiPanel({ recording, busy, run, onChanged }: {
  recording: Recording; busy: string; run: Runner; onChanged: () => Promise<void> | void
}) {
  const [punctuation, setPunctuation] = useState(true)
  const [paragraphs, setParagraphs] = useState(true)
  const [removeFillers, setRemoveFillers] = useState(false)
  const [headings, setHeadings] = useState(false)
  const [cleanup, setCleanup] = useState<CleanupProposal | null>(null)
  const [language, setLanguage] = useState('fr')
  const [translation, setTranslation] = useState<TranslationProposal | null>(null)

  return (
    <div className="tstudio-panel">
      <h3>{t('Clean up')}</h3>
      <p className="tstudio-hint">{t('Sends the transcript to your configured AI provider. Nothing is saved until you accept the result.')}</p>
      <div className="tstudio-row tstudio-row--options">
        <label><input type="checkbox" checked={punctuation} onChange={event => setPunctuation(event.target.checked)} />{t('Punctuation')}</label>
        <label><input type="checkbox" checked={paragraphs} onChange={event => setParagraphs(event.target.checked)} />{t('Paragraphs')}</label>
        <label><input type="checkbox" checked={removeFillers} onChange={event => setRemoveFillers(event.target.checked)} />{t('Remove fillers')}</label>
        <label><input type="checkbox" checked={headings} onChange={event => setHeadings(event.target.checked)} />{t('Headings')}</label>
      </div>
      <div className="tstudio-actions">
        <Button variant="outline" size="sm" disabled={Boolean(busy) || (!punctuation && !paragraphs && !removeFillers && !headings)}
          onClick={() => void run('cleanup', async () => {
            setCleanup(await api.proposeCleanup(recording.id, { punctuation, paragraphs, removeFillers, headings }))
          })}>
          {busy === 'cleanup' ? <Loader2 className="tstudio-spin" /> : <Wand2 />}{t('Propose cleanup')}
        </Button>
        {cleanup && (
          <Button size="sm" disabled={Boolean(busy) || cleanup.diff.stats.identical}
            onClick={() => void run('cleanup-save', async () => {
              await api.saveCleanup(recording.id, cleanup.text, cleanup.sourceHash, recording.revision)
              setCleanup(null)
              await onChanged()
              return t('Cleanup saved as a new version. The original is still in history.')
            })}>
            {busy === 'cleanup-save' ? <Loader2 className="tstudio-spin" /> : <Check />}{t('Accept')}
          </Button>
        )}
      </div>
      {cleanup && (
        <>
          <p className="tstudio-hint">{cleanup.provider} {cleanup.model}</p>
          <DiffView diff={cleanup.diff} />
        </>
      )}

      <h3>{t('Translate')}</h3>
      <p className="tstudio-hint">{t('A translation is saved as its own version. It never replaces the original transcript.')}</p>
      <div className="tstudio-row">
        <label className="tstudio-field tstudio-field--inline"><span>{t('Target language')}</span>
          <input value={language} onChange={event => setLanguage(event.target.value)} maxLength={35} placeholder="fr, de, pt-BR…" />
        </label>
      </div>
      <div className="tstudio-actions">
        <Button variant="outline" size="sm" disabled={Boolean(busy) || !language.trim()}
          onClick={() => void run('translate', async () => { setTranslation(await api.proposeTranslation(recording.id, language.trim())) })}>
          {busy === 'translate' ? <Loader2 className="tstudio-spin" /> : <Speech />}{t('Translate')}
        </Button>
        {translation && (
          <Button size="sm" disabled={Boolean(busy)}
            onClick={() => void run('translate-save', async () => {
              await api.saveTranslation(recording.id, translation.text, translation.targetLanguage, translation.sourceHash)
              setTranslation(null)
              await onChanged()
              return t('Translation saved as a separate version.')
            })}>
            {busy === 'translate-save' ? <Loader2 className="tstudio-spin" /> : <Check />}{t('Save translation')}
          </Button>
        )}
      </div>
      {translation && <pre className="tstudio-translation">{translation.text}</pre>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// TS-08 — reusable custom AI actions
// ---------------------------------------------------------------------------

function ActionsPanel({ recording, busy, run }: { recording: Recording; busy: string; run: Runner }) {
  const [actions, setActions] = useState<CustomAction[] | null>(null)
  const [name, setName] = useState('')
  const [instruction, setInstruction] = useState('')
  const [result, setResult] = useState<CustomActionResult | null>(null)
  const [loadError, setLoadError] = useState('')

  const reload = useCallback(async () => { setActions(await api.listCustomActions()) }, [])
  useEffect(() => {
    let active = true
    api.listCustomActions()
      .then(value => { if (active) setActions(value) })
      .catch(failure => { if (active) setLoadError(message(failure)) })
    return () => { active = false }
  }, [])

  if (loadError) return <p className="tstudio-error" role="alert"><AlertCircle />{loadError}</p>

  return (
    <div className="tstudio-panel">
      <h3>{t('Saved actions')}</h3>
      <p className="tstudio-hint">{t('A saved instruction you can re-run on any transcript. Running one shows the result; nothing is written.')}</p>
      {actions === null
        ? <p className="tstudio-empty">{t('Loading actions…')}</p>
        : actions.length === 0
          ? <p className="tstudio-empty">{t('No saved actions yet. Create one below.')}</p>
          : (
            <ul className="tstudio-versions">
              {actions.map(action => (
                <li key={action.id}>
                  <div>
                    <strong>{action.name}</strong>
                    <small>{action.description || action.instruction.slice(0, 90)}</small>
                  </div>
                  <span className="tstudio-actions">
                    <Button variant="outline" size="sm" disabled={Boolean(busy)}
                      onClick={() => void run(`action-${action.id}`, async () => {
                        setResult(await api.runCustomAction(recording.id, action.id))
                      })}>
                      {busy === `action-${action.id}` ? <Loader2 className="tstudio-spin" /> : <Sparkles />}{t('Run')}
                    </Button>
                    <Button variant="ghost" size="sm" disabled={Boolean(busy)}
                      onClick={() => void run(`delete-${action.id}`, async () => {
                        await api.deleteCustomAction(action.id)
                        await reload()
                        return t('Deleted “{name}”.', { name: action.name })
                      })}>
                      <Trash2 /><span className="sr-only">{t('Delete')}</span>
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}

      {result && (
        <>
          <h4>{result.actionName}</h4>
          <p className="tstudio-hint">{result.provider} {result.model}. {t('Review before relying on it.')}</p>
          <pre className="tstudio-translation">{result.text}</pre>
        </>
      )}

      <h3>{t('New action')}</h3>
      <div className="tstudio-row">
        <label className="tstudio-field"><span>{t('Name')}</span>
          <input value={name} onChange={event => setName(event.target.value)} maxLength={80} placeholder={t('Decisions')} />
        </label>
      </div>
      <div className="tstudio-row">
        <label className="tstudio-field"><span>{t('Instruction')}</span>
          <textarea value={instruction} onChange={event => setInstruction(event.target.value)} maxLength={4000} rows={3}
            placeholder={t('List every decision as a bullet.')} />
        </label>
      </div>
      <div className="tstudio-actions">
        <Button size="sm" disabled={!name.trim() || !instruction.trim() || Boolean(busy)}
          onClick={() => void run('create-action', async () => {
            await api.createCustomAction({ name: name.trim(), instruction: instruction.trim() })
            setName(''); setInstruction('')
            await reload()
            return t('Action saved.')
          })}>
          {busy === 'create-action' ? <Loader2 className="tstudio-spin" /> : <Plus />}{t('Save action')}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// TS-06 / TS-09 — structure and exports
// ---------------------------------------------------------------------------

const structureExports = (): { format: StructureExportFormat; label: string; extension: string; mime: string }[] => [
  { format: 'markdown', label: 'Markdown', extension: 'md', mime: 'text/markdown' },
  { format: 'pdf', label: 'PDF', extension: 'pdf', mime: 'application/pdf' },
  { format: 'csv', label: t('Action items CSV'), extension: 'csv', mime: 'text/csv' },
  { format: 'chapters', label: t('Chapters'), extension: 'txt', mime: 'text/plain' },
  { format: 'json', label: 'JSON', extension: 'json', mime: 'application/json' },
  { format: 'html', label: 'HTML', extension: 'html', mime: 'text/html' },
]

/** Read-only rendering of one structure. Unknown owners and dates are shown as not stated. */
function StructureView({ structure }: { structure: TranscriptStructure }) {
  const timedList = (title: string, items: { text: string; startSeconds: number | null }[]) => items.length > 0 && (
    <>
      <h4>{title}</h4>
      <ul className="tstudio-items">
        {items.map((item, index) => (
          <li key={index}>
            {item.startSeconds !== null && <span className="tstudio-time">{formatTime(item.startSeconds)}</span>}
            {item.text}
          </li>
        ))}
      </ul>
    </>
  )
  return (
    <div className="tstudio-structure">
      {!structure.timestampsAvailable && <p className="tstudio-hint">{t('This transcript has no timings, so items are not time-linked.')}</p>}
      {timedList(t('Chapters'), structure.chapters.map(chapter => ({ text: chapter.title, startSeconds: chapter.startSeconds })))}
      {timedList(t('Decisions'), structure.decisions)}
      {structure.actionItems.length > 0 && (
        <>
          <h4>{t('Action items')}</h4>
          <ul className="tstudio-items">
            {structure.actionItems.map((item, index) => (
              <li key={index}>
                {item.startSeconds !== null && <span className="tstudio-time">{formatTime(item.startSeconds)}</span>}
                {item.text}
                <small> — {t('owner:')} {item.owner ?? <span className="tstudio-unknown">{t('not stated')}</span>}
                  , {t('due:')} {item.due ?? <span className="tstudio-unknown">{t('not stated')}</span>}</small>
              </li>
            ))}
          </ul>
        </>
      )}
      {timedList(t('Open questions'), structure.openQuestions)}
      {structure.chapters.length === 0 && structure.decisions.length === 0
        && structure.actionItems.length === 0 && structure.openQuestions.length === 0
        && <p className="tstudio-empty">{t('Nothing was found in this transcript.')}</p>}
      <p className="tstudio-hint">{t('Generated by {provider} {model}.', { provider: structure.provider, model: structure.model })} {t('Review before relying on it.')}</p>
    </div>
  )
}

function StructurePanel({ recording, busy, run }: { recording: Recording; busy: string; run: Runner }) {
  const [proposal, setProposal] = useState<StructureProposal | null>(null)
  const [saved, setSaved] = useState<SavedStructure[] | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [loadError, setLoadError] = useState('')
  const [subtitles, setSubtitles] = useState<{ exportable: boolean; detail: string } | null>(null)

  useEffect(() => {
    let active = true
    api.subtitleReadiness(recording.id)
      .then(value => { if (active) setSubtitles(value) })
      .catch(() => { if (active) setSubtitles(null) })
    return () => { active = false }
  }, [recording.id, recording.revision])

  useEffect(() => {
    let active = true
    api.listStructures(recording.id)
      .then(rows => { if (!active) return; setSaved(rows); setSelectedId(current => current || rows[0]?.id || '') })
      .catch(failure => { if (active) setLoadError(message(failure)) })
    return () => { active = false }
  }, [recording.id])

  const reload = async (select?: string) => {
    const rows = await api.listStructures(recording.id)
    setSaved(rows)
    setSelectedId(select ?? rows[0]?.id ?? '')
  }

  // Fetched with the vault token and saved through the platform export path; a bare
  // window.open would carry no token and fail whenever API authentication is on.
  const download = async (path: string, extension: string) => {
    try {
      const response = await fetch(apiUrl(`/recordings/${recording.id}${path}`), { headers: authenticatedHeaders() })
      if (!response.ok) throw new Error(t('Subtitle export failed (HTTP {status}).', { status: response.status }))
      await exportDocument({ filename: `${safeDocumentName(recording.title)}.${extension}`, content: await response.text(), mime: extension === 'srt' ? 'application/x-subrip' : 'text/vtt' })
    } catch (failure) { setLoadError(message(failure)) }
  }
  const selected = saved?.find(row => row.id === selectedId) ?? null

  return (
    <div className="tstudio-panel">
      <h3>{t('Subtitles')}</h3>
      {subtitles === null
        ? <p className="tstudio-empty">{t('Checking for usable timings…')}</p>
        : subtitles.exportable
          ? (
            <div className="tstudio-actions">
              <Button variant="outline" size="sm" onClick={() => void download('/transcript/subtitles?format=srt', 'srt')}><Download />SRT</Button>
              <Button variant="outline" size="sm" onClick={() => void download('/transcript/subtitles?format=vtt', 'vtt')}><Download />VTT</Button>
              <Button variant="outline" size="sm" onClick={() => void download('/transcript/subtitles?format=vtt&speakerLabels=1', 'vtt')}><Download />{t('VTT with speakers')}</Button>
            </div>
          )
          : <p className="tstudio-empty">{subtitles.detail}</p>}

      <h3>{t('Analyse')}</h3>
      <p className="tstudio-hint">
        {t('Finds chapters, decisions, action items and open questions. Sends the transcript to your configured AI provider; nothing is saved until you choose Save. Times come from the recording’s own segments, never from the model.')}
      </p>
      <div className="tstudio-actions">
        <Button variant="outline" size="sm" disabled={Boolean(busy)}
          onClick={() => void run('structure', async () => { setProposal(await api.extractStructure(recording.id, recording.transcriptVersionId ?? null)) })}>
          {busy === 'structure' ? <Loader2 className="tstudio-spin" /> : <Sparkles />}{saved?.length ? t('Regenerate') : t('Analyse transcript')}
        </Button>
        {proposal && (
          <>
            <Button size="sm" disabled={Boolean(busy)}
              onClick={() => void run('structure-save', async () => {
                const row = await api.saveStructure(recording.id, proposal.proposalId)
                setProposal(null)
                await reload(row.id)
                return t('Analysis saved. Earlier analyses are kept.')
              })}>
              {busy === 'structure-save' ? <Loader2 className="tstudio-spin" /> : <Check />}{t('Save')}
            </Button>
            <Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => setProposal(null)}>{t('Discard')}</Button>
          </>
        )}
      </div>
      {proposal && (
        <>
          <p className="tstudio-preview">{t('Preview. Not saved yet.')}</p>
          <StructureView structure={proposal} />
        </>
      )}

      <h3>{t('Saved analyses')}</h3>
      {loadError
        ? <p className="tstudio-error" role="alert"><AlertCircle />{loadError}</p>
        : saved === null
          ? <p className="tstudio-empty">{t('Loading saved analyses…')}</p>
          : saved.length === 0
            ? <p className="tstudio-empty">{t('No saved analysis yet. Analyse the transcript, review the result, then save it.')}</p>
            : (
              <>
                <div className="tstudio-row">
                  <label className="tstudio-field"><span>{t('Analysis')}</span>
                    <select value={selectedId} onChange={event => setSelectedId(event.target.value)}>
                      {saved.map(row => (
                        <option key={row.id} value={row.id}>
                          {dateTime(row.createdAt)} · {row.provider} {row.model}{row.current ? '' : ` · ${t('older transcript version')}`}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {selected && (
                  <>
                    {!selected.current && (
                      <p className="tstudio-hint">{t('This analysis was made from an earlier transcript version. Regenerate to analyse the current one.')}</p>
                    )}
                    <div className="tstudio-actions">
                      {structureExports().map(item => (
                        <Button key={item.format} variant="outline" size="sm" disabled={Boolean(busy)}
                          onClick={() => void run(`export-${item.format}`, async () => {
                            const content = await api.structureExport(recording.id, selected.id, item.format)
                            await exportDocument({ filename: `${safeDocumentName(recording.title)}-${t('analysis')}.${item.extension}`, content, mime: item.mime })
                          })}>
                          {busy === `export-${item.format}` ? <Loader2 className="tstudio-spin" /> : item.format === 'csv' ? <Download /> : <FileText />}{item.label}
                        </Button>
                      ))}
                      <Button variant="ghost" size="sm" disabled={Boolean(busy)}
                        onClick={() => {
                          if (!window.confirm(t('Delete this saved analysis? The transcript is not affected.'))) return
                          void run('structure-delete', async () => {
                            await api.deleteStructure(recording.id, selected.id)
                            await reload()
                            return t('Analysis deleted.')
                          })
                        }}>
                        <Trash2 />{t('Delete')}
                      </Button>
                    </div>
                    <StructureView structure={selected.structure} />
                  </>
                )}
              </>
            )}
    </div>
  )
}
