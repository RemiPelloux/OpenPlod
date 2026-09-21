import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle, Check, Download, FileText, History, Loader2, Plus, Search, Sparkles, Speech, Trash2,
  Undo2, Wand2,
} from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  api, type CleanupProposal, type CustomAction, type CustomActionResult, type Recording,
  type StudioSegment, type TranscriptDiff, type TranscriptStructure, type TranscriptVersionRow,
  type TranslationProposal, type VersionComparison,
} from '@/lib/api'
import './transcript-studio.css'

/**
 * Transcript Studio (roadmap TS-02..TS-06, TS-09).
 *
 * Every destructive or AI-assisted action here is a two-step: propose, show
 * exactly what would change, then save on an explicit confirmation. Nothing in
 * this component writes on the first click, and every panel that can produce
 * an empty or unavailable result says why rather than rendering blank.
 */

const CHANGE_KIND_LABEL: Record<VersionComparison['changeKind'], string> = {
  'manual-correction': 'Your correction to generated text',
  regeneration: 'Model output replacing earlier model output',
  'manual-revision': 'Your revision of your own edit',
  'reverted-to-generated': 'Model output replacing your edit',
}

const formatTime = (seconds: number | null) => {
  if (seconds === null) return null
  const total = Math.max(0, Math.floor(seconds))
  const hh = Math.floor(total / 3600)
  const mm = Math.floor((total % 3600) / 60)
  const ss = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`
}

const message = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.')

/** Inline word diff. Identical text is stated rather than shown as a blank. */
function DiffView({ diff }: { diff: TranscriptDiff }) {
  if (diff.stats.identical) return <p className="tstudio-empty">The model returned the text unchanged.</p>
  return (
    <>
      <p className="tstudio-diff-stats">
        +{diff.stats.inserted} / −{diff.stats.deleted} words
        {diff.granularity !== 'word' && <span> · compared by {diff.granularity}</span>}
      </p>
      <div className="tstudio-diff" aria-label="Proposed changes">
        {diff.parts.map((part, index) => (
          <span key={index} className={`tstudio-diff-${part.op}`}>{part.text}</span>
        ))}
      </div>
    </>
  )
}

export function TranscriptStudio({ recording, onChanged }: { recording: Recording; onChanged: () => Promise<void> | void }) {
  const [tab, setTab] = useState<'edit' | 'versions' | 'ai' | 'structure' | 'actions'>('edit')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const segments: StudioSegment[] = useMemo(
    () => (recording.segments ?? []).map(segment => ({
      start: segment.startTime, end: segment.endTime, text: segment.text, speaker: segment.speaker,
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
    <section className="transcript-studio" aria-label="Transcript Studio">
      <nav className="tstudio-tabs" role="tablist">
        {([['edit', 'Edit', Speech], ['versions', 'Versions', History], ['ai', 'AI cleanup', Wand2], ['structure', 'Structure', Sparkles], ['actions', 'Actions', Plus]] as const)
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
        ? <p className="tstudio-empty">Transcribe this recording to use the Transcript Studio.</p>
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
}

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
      <h3>Find and replace</h3>
      <div className="tstudio-row">
        <label className="tstudio-field"><span>Find</span>
          <input value={search} onChange={event => { setSearch(event.target.value); setPreview(null) }} maxLength={2000} placeholder="Text to find" />
        </label>
        <label className="tstudio-field"><span>Replace with</span>
          <input value={replacement} onChange={event => setReplacement(event.target.value)} maxLength={2000} placeholder="Replacement" />
        </label>
      </div>
      <div className="tstudio-row tstudio-row--options">
        <label><input type="checkbox" checked={matchCase} onChange={event => setMatchCase(event.target.checked)} />Match case</label>
        <label><input type="checkbox" checked={wholeWord} onChange={event => setWholeWord(event.target.checked)} />Whole word</label>
        {speakers.length > 0 && (
          <label className="tstudio-field tstudio-field--inline"><span>Only speaker</span>
            <select value={scope} onChange={event => setScope(event.target.value)}>
              <option value="">All speakers</option>
              {speakers.map(speaker => <option key={String(speaker)} value={String(speaker)}>{String(speaker)}</option>)}
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
          {busy === 'preview' ? <Loader2 className="tstudio-spin" /> : <Search />}Preview
        </Button>
        <Button size="sm" disabled={!search || !preview?.count || Boolean(busy)}
          onClick={() => void run('replace', async () => {
            const result = await api.transcriptOperations(recording.id, [replaceOperation()], { revision: recording.revision })
            setPreview(null); setSearch('')
            await onChanged()
            return result.summaries.join('; ')
          })}>
          {busy === 'replace' ? <Loader2 className="tstudio-spin" /> : <Check />}Apply
        </Button>
      </div>
      {preview && (
        <p className="tstudio-preview">
          {preview.count === 0 ? 'No matches. Nothing would change.' : `${preview.summaries.join('; ')}. Nothing saved yet.`}
        </p>
      )}

      <h3>Speakers</h3>
      {speakers.length === 0
        ? <p className="tstudio-empty">This transcript has no speaker labels, so there is nothing to rename.</p>
        : (
          <>
            <div className="tstudio-row">
              <label className="tstudio-field"><span>Rename</span>
                <select value={renameFrom} onChange={event => setRenameFrom(event.target.value)}>
                  <option value="">Choose a speaker</option>
                  {speakers.map(speaker => <option key={String(speaker)} value={String(speaker)}>{String(speaker)}</option>)}
                </select>
              </label>
              <label className="tstudio-field"><span>To</span>
                <input value={renameTo} onChange={event => setRenameTo(event.target.value)} maxLength={80} placeholder="Name" />
              </label>
            </div>
            <p className="tstudio-hint">Renaming onto an existing name merges the two speakers.</p>
            <div className="tstudio-actions">
              <Button size="sm" disabled={!renameFrom || !renameTo.trim() || Boolean(busy)}
                onClick={() => void run('rename', async () => {
                  const result = await api.transcriptOperations(recording.id,
                    [{ op: 'rename-speaker', from: renameFrom, to: renameTo.trim() }], { revision: recording.revision })
                  setRenameFrom(''); setRenameTo('')
                  await onChanged()
                  return result.summaries.join('; ')
                })}>
                {busy === 'rename' ? <Loader2 className="tstudio-spin" /> : <Check />}Rename
              </Button>
            </div>
          </>
        )}
      <h3>Segments</h3>
      {segmentCount === 0
        ? <p className="tstudio-empty">This transcript has no segments, so it cannot be split or merged.</p>
        : (
          <>
            <div className="tstudio-row">
              <label className="tstudio-field"><span>Split segment</span>
                <select value={splitIndex} onChange={event => setSplitIndex(Number(event.target.value))}>
                  {segments.map((segment, index) => (
                    <option key={index} value={index}>{index + 1}. {segment.text.slice(0, 60)}</option>
                  ))}
                </select>
              </label>
              <label className="tstudio-field tstudio-field--inline"><span>At character</span>
                <input type="number" min={1} max={Math.max(1, (segments[splitIndex]?.text.length ?? 2) - 1)}
                  value={splitOffset} onChange={event => setSplitOffset(Number(event.target.value))} />
              </label>
            </div>
            <p className="tstudio-hint">
              Splits into “{(segments[splitIndex]?.text ?? '').slice(0, splitOffset).trim() || '…'}” and
              “{(segments[splitIndex]?.text ?? '').slice(splitOffset).trim() || '…'}”.
              The boundary is interpolated inside this segment's own span; an untimed segment stays untimed.
            </p>
            <div className="tstudio-actions">
              <Button variant="outline" size="sm" disabled={Boolean(busy)}
                onClick={() => void run('split', async () => {
                  const result = await api.transcriptOperations(recording.id,
                    [{ op: 'split-segment', index: splitIndex, offset: splitOffset }], { revision: recording.revision })
                  await onChanged()
                  return result.summaries.join('; ')
                })}>
                {busy === 'split' ? <Loader2 className="tstudio-spin" /> : <Check />}Split
              </Button>
            </div>

            <div className="tstudio-row">
              <label className="tstudio-field tstudio-field--inline"><span>Merge from segment</span>
                <input type="number" min={1} max={segmentCount} value={mergeStart + 1}
                  onChange={event => setMergeStart(Math.max(0, Number(event.target.value) - 1))} />
              </label>
              <label className="tstudio-field tstudio-field--inline"><span>How many</span>
                <input type="number" min={2} max={Math.max(2, segmentCount - mergeStart)} value={mergeCount}
                  onChange={event => setMergeCount(Number(event.target.value))} />
              </label>
            </div>
            <p className="tstudio-hint">Merging across different speakers clears the label rather than picking one.</p>
            <div className="tstudio-actions">
              <Button variant="outline" size="sm" disabled={Boolean(busy) || mergeStart + mergeCount > segmentCount}
                onClick={() => void run('merge', async () => {
                  const result = await api.transcriptOperations(recording.id,
                    [{ op: 'merge-segments', start: mergeStart, count: mergeCount }], { revision: recording.revision })
                  await onChanged()
                  return result.summaries.join('; ')
                })}>
                {busy === 'merge' ? <Loader2 className="tstudio-spin" /> : <Check />}Merge
              </Button>
            </div>
          </>
        )}

      <h3>Undo</h3>
      <p className="tstudio-hint">
        Undo restores the version before the current one. Because every edit is a saved version, this
        survives a reload and the undone version stays in history.
      </p>
      <div className="tstudio-actions">
        <Button variant="outline" size="sm" disabled={Boolean(busy)}
          onClick={() => void run('undo', async () => {
            const versions = await api.transcriptVersions(recording.id)
            const currentIndex = versions.findIndex(version => version.id === recording.transcriptVersionId)
            // Versions come back newest first, so the one after the current is its predecessor.
            const previous = currentIndex === -1 ? versions[1] : versions[currentIndex + 1]
            if (!previous) throw new Error('There is no earlier version to undo to.')
            await api.promoteTranscriptVersion(recording.id, previous.id, recording.revision)
            await onChanged()
            return `Restored the ${previous.origin} version from ${new Date(previous.createdAt).toLocaleString()}.`
          })}>
          {busy === 'undo' ? <Loader2 className="tstudio-spin" /> : <Undo2 />}Undo last change
        </Button>
      </div>

      <p className="tstudio-hint">{segmentCount} segments. Every change creates a new version; nothing is overwritten.</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// TS-03 — versions
// ---------------------------------------------------------------------------

function VersionsPanel({ recording, busy, run, onChanged }: {
  recording: Recording; busy: string; run: Runner; onChanged: () => Promise<void> | void
}) {
  const [versions, setVersions] = useState<TranscriptVersionRow[] | null>(null)
  const [before, setBefore] = useState('')
  const [after, setAfter] = useState('')
  const [comparison, setComparison] = useState<VersionComparison | null>(null)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    let active = true
    api.transcriptVersions(recording.id)
      .then(rows => { if (!active) return; setVersions(rows); setBefore(rows[1]?.id ?? ''); setAfter(rows[0]?.id ?? '') })
      .catch(failure => { if (active) setLoadError(message(failure)) })
    return () => { active = false }
  }, [recording.id, recording.revision])

  if (loadError) return <p className="tstudio-error" role="alert"><AlertCircle />{loadError}</p>
  if (!versions) return <p className="tstudio-empty">Loading versions…</p>
  if (versions.length === 0) return <p className="tstudio-empty">This transcript has no saved versions yet.</p>

  const label = (version: TranscriptVersionRow) =>
    `${version.origin} · ${new Date(version.createdAt).toLocaleString()}`

  return (
    <div className="tstudio-panel">
      <h3>Compare versions</h3>
      <div className="tstudio-row">
        <label className="tstudio-field"><span>Before</span>
          <select value={before} onChange={event => { setBefore(event.target.value); setComparison(null) }}>
            {versions.map(version => <option key={version.id} value={version.id}>{label(version)}</option>)}
          </select>
        </label>
        <label className="tstudio-field"><span>After</span>
          <select value={after} onChange={event => { setAfter(event.target.value); setComparison(null) }}>
            {versions.map(version => <option key={version.id} value={version.id}>{label(version)}</option>)}
          </select>
        </label>
      </div>
      <div className="tstudio-actions">
        <Button variant="outline" size="sm" disabled={!before || !after || before === after || Boolean(busy)}
          onClick={() => void run('compare', async () => { setComparison(await api.compareTranscriptVersions(recording.id, before, after)) })}>
          {busy === 'compare' ? <Loader2 className="tstudio-spin" /> : <History />}Compare
        </Button>
      </div>
      {before === after && <p className="tstudio-hint">Choose two different versions.</p>}

      {comparison && (
        <>
          <p className="tstudio-change-kind">{CHANGE_KIND_LABEL[comparison.changeKind]}</p>
          <DiffView diff={comparison.diff} />
        </>
      )}

      <h3>Versions</h3>
      <ul className="tstudio-versions">
        {versions.map(version => (
          <li key={version.id}>
            <div>
              <strong>{version.origin}</strong>
              <small>{new Date(version.createdAt).toLocaleString()}</small>
            </div>
            {version.id === recording.transcriptVersionId
              ? <span className="tstudio-current">Current</span>
              : (
                <Button variant="outline" size="sm" disabled={Boolean(busy)}
                  onClick={() => void run(`promote-${version.id}`, async () => {
                    await api.promoteTranscriptVersion(recording.id, version.id, recording.revision)
                    await onChanged()
                    return 'Version promoted. The replaced version is still in history.'
                  })}>
                  {busy === `promote-${version.id}` ? <Loader2 className="tstudio-spin" /> : null}Make current
                </Button>
              )}
          </li>
        ))}
      </ul>
    </div>
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
      <h3>Clean up</h3>
      <p className="tstudio-hint">Sends the transcript to your configured AI provider. Nothing is saved until you accept the result.</p>
      <div className="tstudio-row tstudio-row--options">
        <label><input type="checkbox" checked={punctuation} onChange={event => setPunctuation(event.target.checked)} />Punctuation</label>
        <label><input type="checkbox" checked={paragraphs} onChange={event => setParagraphs(event.target.checked)} />Paragraphs</label>
        <label><input type="checkbox" checked={removeFillers} onChange={event => setRemoveFillers(event.target.checked)} />Remove fillers</label>
        <label><input type="checkbox" checked={headings} onChange={event => setHeadings(event.target.checked)} />Headings</label>
      </div>
      <div className="tstudio-actions">
        <Button variant="outline" size="sm" disabled={Boolean(busy) || (!punctuation && !paragraphs && !removeFillers && !headings)}
          onClick={() => void run('cleanup', async () => {
            setCleanup(await api.proposeCleanup(recording.id, { punctuation, paragraphs, removeFillers, headings }))
          })}>
          {busy === 'cleanup' ? <Loader2 className="tstudio-spin" /> : <Wand2 />}Propose cleanup
        </Button>
        {cleanup && (
          <Button size="sm" disabled={Boolean(busy) || cleanup.diff.stats.identical}
            onClick={() => void run('cleanup-save', async () => {
              await api.saveCleanup(recording.id, cleanup.text, cleanup.sourceHash, recording.revision)
              setCleanup(null)
              await onChanged()
              return 'Cleanup saved as a new version. The original is still in history.'
            })}>
            {busy === 'cleanup-save' ? <Loader2 className="tstudio-spin" /> : <Check />}Accept
          </Button>
        )}
      </div>
      {cleanup && (
        <>
          <p className="tstudio-hint">{cleanup.provider} {cleanup.model}</p>
          <DiffView diff={cleanup.diff} />
        </>
      )}

      <h3>Translate</h3>
      <p className="tstudio-hint">A translation is saved as its own version. It never replaces the original transcript.</p>
      <div className="tstudio-row">
        <label className="tstudio-field tstudio-field--inline"><span>Target language</span>
          <input value={language} onChange={event => setLanguage(event.target.value)} maxLength={35} placeholder="fr, de, pt-BR…" />
        </label>
      </div>
      <div className="tstudio-actions">
        <Button variant="outline" size="sm" disabled={Boolean(busy) || !language.trim()}
          onClick={() => void run('translate', async () => { setTranslation(await api.proposeTranslation(recording.id, language.trim())) })}>
          {busy === 'translate' ? <Loader2 className="tstudio-spin" /> : <Speech />}Translate
        </Button>
        {translation && (
          <Button size="sm" disabled={Boolean(busy)}
            onClick={() => void run('translate-save', async () => {
              await api.saveTranslation(recording.id, translation.text, translation.targetLanguage, translation.sourceHash)
              setTranslation(null)
              await onChanged()
              return 'Translation saved as a separate version.'
            })}>
            {busy === 'translate-save' ? <Loader2 className="tstudio-spin" /> : <Check />}Save translation
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
      <h3>Saved actions</h3>
      <p className="tstudio-hint">A saved instruction you can re-run on any transcript. Running one shows the result; nothing is written.</p>
      {actions === null
        ? <p className="tstudio-empty">Loading actions…</p>
        : actions.length === 0
          ? <p className="tstudio-empty">No saved actions yet. Create one below.</p>
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
                      {busy === `action-${action.id}` ? <Loader2 className="tstudio-spin" /> : <Sparkles />}Run
                    </Button>
                    <Button variant="ghost" size="sm" disabled={Boolean(busy)}
                      onClick={() => void run(`delete-${action.id}`, async () => {
                        await api.deleteCustomAction(action.id)
                        await reload()
                        return `Deleted "${action.name}".`
                      })}>
                      <Trash2 />
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}

      {result && (
        <>
          <h4>{result.actionName}</h4>
          <p className="tstudio-hint">{result.provider} {result.model}. Review before relying on it.</p>
          <pre className="tstudio-translation">{result.text}</pre>
        </>
      )}

      <h3>New action</h3>
      <div className="tstudio-row">
        <label className="tstudio-field"><span>Name</span>
          <input value={name} onChange={event => setName(event.target.value)} maxLength={80} placeholder="Decisions" />
        </label>
      </div>
      <div className="tstudio-row">
        <label className="tstudio-field"><span>Instruction</span>
          <textarea value={instruction} onChange={event => setInstruction(event.target.value)} maxLength={4000} rows={3}
            placeholder="List every decision as a bullet." />
        </label>
      </div>
      <div className="tstudio-actions">
        <Button size="sm" disabled={!name.trim() || !instruction.trim() || Boolean(busy)}
          onClick={() => void run('create-action', async () => {
            await api.createCustomAction({ name: name.trim(), instruction: instruction.trim() })
            setName(''); setInstruction('')
            await reload()
            return 'Action saved.'
          })}>
          {busy === 'create-action' ? <Loader2 className="tstudio-spin" /> : <Plus />}Save action
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// TS-06 / TS-09 — structure and exports
// ---------------------------------------------------------------------------

function StructurePanel({ recording, busy, run }: { recording: Recording; busy: string; run: Runner }) {
  const [structure, setStructure] = useState<TranscriptStructure | null>(null)
  const [subtitles, setSubtitles] = useState<{ exportable: boolean; detail: string } | null>(null)

  useEffect(() => {
    let active = true
    api.subtitleReadiness(recording.id)
      .then(value => { if (active) setSubtitles(value) })
      .catch(() => { if (active) setSubtitles(null) })
    return () => { active = false }
  }, [recording.id, recording.revision])

  const download = (path: string) => { window.open(`/api/recordings/${recording.id}${path}`, '_blank', 'noopener') }

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
    <div className="tstudio-panel">
      <h3>Subtitles</h3>
      {subtitles === null
        ? <p className="tstudio-empty">Checking for usable timings…</p>
        : subtitles.exportable
          ? (
            <div className="tstudio-actions">
              <Button variant="outline" size="sm" onClick={() => download('/transcript/subtitles?format=srt')}><Download />SRT</Button>
              <Button variant="outline" size="sm" onClick={() => download('/transcript/subtitles?format=vtt')}><Download />VTT</Button>
              <Button variant="outline" size="sm" onClick={() => download('/transcript/subtitles?format=vtt&speakerLabels=1')}><Download />VTT with speakers</Button>
            </div>
          )
          : <p className="tstudio-empty">{subtitles.detail}</p>}

      <h3>Analyse</h3>
      <p className="tstudio-hint">Finds chapters, decisions, action items and open questions. Times come from the recording's own segments, never from the model.</p>
      <div className="tstudio-actions">
        <Button variant="outline" size="sm" disabled={Boolean(busy)}
          onClick={() => void run('structure', async () => { setStructure(await api.extractStructure(recording.id)) })}>
          {busy === 'structure' ? <Loader2 className="tstudio-spin" /> : <Sparkles />}Analyse transcript
        </Button>
        {structure && (
          <>
            <Button variant="outline" size="sm" onClick={() => download('/transcript/structure?format=markdown')}><FileText />Markdown</Button>
            <Button variant="outline" size="sm" onClick={() => download('/transcript/structure?format=csv')}><Download />Action items CSV</Button>
            <Button variant="outline" size="sm" onClick={() => download('/transcript/structure?format=html')}><FileText />Print / PDF</Button>
          </>
        )}
      </div>
      {structure && (
        <div className="tstudio-structure">
          {!structure.timestampsAvailable && <p className="tstudio-hint">This transcript has no timings, so items are not time-linked.</p>}
          {timedList('Chapters', structure.chapters.map(chapter => ({ text: chapter.title, startSeconds: chapter.startSeconds })))}
          {timedList('Decisions', structure.decisions)}
          {structure.actionItems.length > 0 && (
            <>
              <h4>Action items</h4>
              <ul className="tstudio-items">
                {structure.actionItems.map((item, index) => (
                  <li key={index}>
                    {item.startSeconds !== null && <span className="tstudio-time">{formatTime(item.startSeconds)}</span>}
                    {item.text}
                    <small> — owner: {item.owner ?? <span className="tstudio-unknown">not stated</span>}
                      , due: {item.due ?? <span className="tstudio-unknown">not stated</span>}</small>
                  </li>
                ))}
              </ul>
            </>
          )}
          {timedList('Open questions', structure.openQuestions)}
          {structure.chapters.length === 0 && structure.decisions.length === 0
            && structure.actionItems.length === 0 && structure.openQuestions.length === 0
            && <p className="tstudio-empty">Nothing was found in this transcript.</p>}
          <p className="tstudio-hint">Generated by {structure.provider} {structure.model}. Review before relying on it.</p>
        </div>
      )}
    </div>
  )
}
