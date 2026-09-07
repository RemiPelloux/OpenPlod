import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronDown,
  CloudUpload,
  Download,
  FileAudio,
  FileText,
  History,
  Loader2,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Save,
  SkipBack,
  SkipForward,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SaveTranscriptDialog } from '@/components/NoteDialogs'
import { api, type Recording, type TranscriptSegment, type TranscriptVersion } from '@/lib/api'
import { formatDuration } from '@/lib/utils'
import { exportDocument, exportOriginalAudio, recordingMarkdown, safeDocumentName as safeName } from '@/lib/document-export'
import { deviceCommand, supportsPlaudDevice, vaultArguments } from '@/lib/plaud-device'

type BusyAction = 'transcribing' | 'summarizing' | 'saving' | 'forwarding' | null
type DocumentMode = 'preview' | 'edit' | 'timestamps'

function findActiveSegment(segments: TranscriptSegment[], time: number): TranscriptSegment | undefined {
  let low = 0
  let high = segments.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const segment = segments[middle]
    if (time < segment.startTime) high = middle - 1
    else if (time >= segment.endTime) low = middle + 1
    else return segment
  }
}

export function RecordingDetail({ backPath = '/' }: { backPath?: string }) {
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [recording, setRecording] = useState<Recording | null>(null)
  const [versions, setVersions] = useState<TranscriptVersion[]>([])
  const [selectedVersion, setSelectedVersion] = useState<TranscriptVersion | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [action, setAction] = useState<BusyAction>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [audioUrl, setAudioUrl] = useState('')
  const [documentMode, setDocumentMode] = useState<DocumentMode>('preview')
  const [editingMetadata, setEditingMetadata] = useState(false)
  const [activeSegment, setActiveSegment] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [contextDraft, setContextDraft] = useState('')
  const [notesDraft, setNotesDraft] = useState('')
  const [tagsDraft, setTagsDraft] = useState('')
  const [transcriptDraft, setTranscriptDraft] = useState('')
  const audioRef = useRef<HTMLAudioElement>(null)
  const audioKey = recording ? recording.fingerprint || recording.filePath : null

  const loadRecording = useCallback(async () => {
    if (!id) return
    setError('')
    try {
      const [nextRecording, nextVersions] = await Promise.all([
        api.getRecording(id),
        api.getTranscriptVersions(id),
      ])
      setRecording(nextRecording)
      setVersions(nextVersions)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load recording')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { void loadRecording() }, [loadRecording])

  useEffect(() => {
    if (!recording || !['pending', 'transcribing', 'summarizing'].includes(recording.status)) return
    const poll = window.setInterval(() => void loadRecording(), 2500)
    return () => window.clearInterval(poll)
  }, [loadRecording, recording])

  useEffect(() => {
    if (!id || !audioKey) return
    let disposed = false
    let objectUrl = ''
    api.getAudioObjectUrl(id).then(url => {
      objectUrl = url
      if (!disposed) setAudioUrl(url)
      else URL.revokeObjectURL(url)
    }).catch(audioError => {
      if (!disposed) setError(audioError instanceof Error ? audioError.message : 'Could not load audio')
    })
    return () => {
      disposed = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [id, audioKey])

  useEffect(() => {
    if (!recording) return
    setTitleDraft(recording.title)
    setContextDraft(recording.context ?? '')
    setNotesDraft(recording.notes ?? '')
    setTagsDraft(recording.tags.join(', '))
    setTranscriptDraft(recording.transcriptText ?? '')
  }, [recording])

  const displayText = selectedVersion?.fullText ?? recording?.transcriptText ?? ''
  const sourceLabel = recording?.sourceProvider === 'plaud'
    ? 'Plaud Note Pro'
    : recording?.sourceProvider === 'opennotes' ? 'OpenPlod mobile' : 'Local import'

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) void audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
    else {
      audio.pause()
      setPlaying(false)
    }
  }, [])

  const seekTo = useCallback((time: number, autoplay = true) => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = time
    setCurrentTime(time)
    if (autoplay) void audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
  }, [])

  const runAction = async (nextAction: 'transcribing' | 'summarizing') => {
    if (!id) return
    setAction(nextAction)
    setError('')
    try {
      if (nextAction === 'transcribing') {
        await api.transcribe(id)
        setRecording(current => current ? { ...current, status: 'pending' } : current)
      } else {
        await api.summarize(id)
        await loadRecording()
      }
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Action failed')
    } finally {
      setAction(null)
    }
  }

  const saveMetadata = async () => {
    if (!recording) return
    setAction('saving')
    setError('')
    try {
      await api.updateRecording(recording.id, {
        title: titleDraft,
        context: contextDraft || null,
        notes: notesDraft || null,
        tags: tagsDraft.split(',').map(tag => tag.trim()).filter(Boolean),
        revision: recording.revision,
      })
      await loadRecording()
      setEditingMetadata(false)
      flashSaved(setSaved)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save recording')
    } finally {
      setAction(null)
    }
  }

  const saveTranscript = async () => {
    if (!recording) return
    setAction('saving')
    setError('')
    try {
      await api.updateTranscript(recording.id, transcriptDraft, recording.revision)
      await loadRecording()
      setDocumentMode('preview')
      flashSaved(setSaved)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save transcript')
    } finally {
      setAction(null)
    }
  }

  const forward = async () => {
    if (!recording) return
    setAction('forwarding')
    setError('')
    try {
      await api.forwardRecording(recording.id)
      await loadRecording()
    } catch (forwardError) {
      setError(forwardError instanceof Error ? forwardError.message : 'Forwarding failed')
    } finally {
      setAction(null)
    }
  }

  const trashRecording = async () => {
    if (!recording || !window.confirm('Move this recording to Trash for 30 days?')) return
    await api.trashRecording(recording.id)
    navigate('/')
  }

  const exportCurrent = (format: 'md' | 'txt' | 'json') => {
    if (!recording) return
    const provenance = { versionId: selectedVersion?.id ?? recording.transcriptVersionId ?? null,
      origin: selectedVersion?.origin ?? recording.transcriptOrigin ?? null }
    const content = format === 'md' ? recordingMarkdown(recording, displayText, provenance) : format === 'txt' ? displayText : JSON.stringify({
      recordingId: recording.id, title: recording.title, recordedAt: recording.recordedAt,
      sourceProvider: recording.sourceProvider, sourceRecordingId: recording.sourceRecordingId,
      transcript: displayText, versionId: selectedVersion?.id ?? recording.transcriptVersionId ?? null, origin: selectedVersion?.origin ?? recording.transcriptOrigin ?? null,
      segments: selectedVersion ? undefined : recording.segments, notes: recording.notes, tags: recording.tags,
    }, null, 2)
    void exportDocument({ filename: `${safeName(recording.title)}.${format}`, content,
      mime: format === 'md' ? 'text/markdown' : format === 'txt' ? 'text/plain' : 'application/json',
    }).catch(failure => setError(failure instanceof Error ? failure.message : String(failure)))
  }

  const exportAudio = () => {
    if (!recording) return
    if (supportsPlaudDevice()) {
      void deviceCommand('exportVaultRecording', { ...vaultArguments(), recordingId: recording.id, filename: recording.filename })
        .catch(failure => setError(failure instanceof Error ? failure.message : String(failure)))
      return
    }
    if (!audioUrl) return
    void exportOriginalAudio(recording, audioUrl).catch(failure => setError(failure instanceof Error ? failure.message : String(failure)))
  }

  const speakerMap = useMemo(() => {
    const nextMap = new Map<string, number>()
    recording?.segments?.forEach(segment => {
      if (!nextMap.has(segment.speaker)) nextMap.set(segment.speaker, nextMap.size)
    })
    return nextMap
  }, [recording?.segments])

  if (loading) return <div className="flex h-full items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>

  if (!recording) {
    return (
      <div className="flex flex-col items-center p-8 text-center text-muted-foreground" role="alert">
        <AlertCircle className="mb-3 h-10 w-10 opacity-40" />
        <p className="font-medium text-foreground">Recording unavailable</p>
        <p className="mt-1 text-sm">{error || 'Recording not found'}</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={() => void loadRecording()}>Retry</Button>
      </div>
    )
  }

  return (
    <div className="recording-page">
      <header className="recording-toolbar">
        <Link to={backPath} className="recording-back" aria-label={backPath === '/transcripts' ? 'Back to transcripts' : 'Back to library'}><ArrowLeft /></Link>
        <div className="recording-title-block">
          {editingMetadata ? (
            <input value={titleDraft} onChange={event => setTitleDraft(event.target.value)} className="recording-title-input" aria-label="Recording title" />
          ) : <h1>{recording.title}</h1>}
          <p>{formatRecordingDate(recording.recordedAt)} <span /> {sourceLabel}</p>
        </div>
        <div className="recording-toolbar-actions">
          <SaveTranscriptDialog recordingId={recording.id} versionId={selectedVersion?.id ?? recording.transcriptVersionId ?? null} title={recording.title} disabled={recording.transcriptText === undefined || action !== null || documentMode === 'edit'} />
          {saved && <span className="saved-state"><Check />Saved</span>}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button variant="outline" size="sm"><Download />Export<ChevronDown /></Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="action-menu" align="end" sideOffset={6}>
                <DropdownMenu.Item onSelect={() => exportCurrent('md')}><FileText />Markdown document</DropdownMenu.Item>
                <DropdownMenu.Item onSelect={() => exportCurrent('txt')}><FileText />Transcript text</DropdownMenu.Item>
                <DropdownMenu.Item onSelect={() => exportCurrent('json')}><FileText />JSON with metadata</DropdownMenu.Item>
                <DropdownMenu.Item onSelect={exportAudio}><FileAudio />Original audio</DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild><Button variant="ghost" size="icon" aria-label="More recording actions"><MoreHorizontal /></Button></DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="action-menu" align="end" sideOffset={6}>
                <DropdownMenu.Item onSelect={() => setEditingMetadata(true)}><Pencil />Edit details</DropdownMenu.Item>
                <DropdownMenu.Item onSelect={() => void forward()}><CloudUpload />Send to OpenWhistle</DropdownMenu.Item>
                <DropdownMenu.Item onSelect={() => void runAction('transcribing')}><RotateCcw />Transcribe again</DropdownMenu.Item>
                <DropdownMenu.Separator />
                <DropdownMenu.Item className="danger" onSelect={() => void trashRecording()}><Trash2 />Move to Trash</DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </header>

      {error && <div className="recording-error" role="alert"><AlertCircle /><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Dismiss error"><X /></button></div>}

      <section className="player-strip" aria-label="Audio player">
        <audio
          ref={audioRef}
          src={audioUrl || undefined}
          preload="metadata"
          onTimeUpdate={() => {
            const time = audioRef.current?.currentTime ?? 0
            setCurrentTime(time)
            const segment = recording.segments ? findActiveSegment(recording.segments, time) : undefined
            setActiveSegment(segment?.id ?? null)
          }}
          onLoadedMetadata={() => {
            const audio = audioRef.current
            if (!audio) return
            setDuration(Number.isFinite(audio.duration) ? audio.duration : recording.duration)
            const requestedTime = Number(searchParams.get('t'))
            if (Number.isFinite(requestedTime) && requestedTime > 0) seekTo(requestedTime, false)
          }}
          onEnded={() => setPlaying(false)}
          onPause={() => setPlaying(false)}
          onPlay={() => setPlaying(true)}
        />
        <Button className="player-main" size="icon" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>{playing ? <Pause /> : <Play />}</Button>
        <div className="player-timeline">
          <input type="range" className="audio-timeline" min={0} max={duration || recording.duration || 1} step={0.1} value={currentTime} onChange={event => seekTo(Number(event.target.value), false)} aria-label="Seek in audio" aria-valuetext={`${formatDuration(currentTime)} of ${formatDuration(duration || recording.duration)}`} />
          <div className="player-time"><span>{formatDuration(currentTime)}</span><span>{formatDuration(duration || recording.duration)}</span></div>
        </div>
        <div className="player-skip">
          <Button variant="ghost" size="icon" onClick={() => seekTo(Math.max(0, currentTime - 15))} aria-label="Back 15 seconds"><SkipBack /></Button>
          <Button variant="ghost" size="icon" onClick={() => seekTo(Math.min(duration || recording.duration, currentTime + 15))} aria-label="Forward 15 seconds"><SkipForward /></Button>
        </div>
      </section>

      <div className="recording-workspace">
        <main className="document-pane">
          <div className="document-toolbar">
            <ToggleGroup type="single" className="document-modes" value={documentMode} onValueChange={value => { if (value === 'preview' || value === 'edit' || value === 'timestamps') { if (value === 'edit') setSelectedVersion(null); setDocumentMode(value) } }} aria-label="Transcript view">
              <ToggleGroupItem value="preview">Markdown</ToggleGroupItem><ToggleGroupItem value="edit">Edit</ToggleGroupItem><ToggleGroupItem value="timestamps">Transcript</ToggleGroupItem>
            </ToggleGroup>
            {documentMode === 'edit' && (
              <Button size="sm" onClick={() => void saveTranscript()} disabled={action !== null || recording.transcriptText === undefined}><Save />Save version</Button>
            )}
          </div>

          {selectedVersion && (
            <div className="version-banner"><History /><span>Viewing {selectedVersion.origin} version from {formatVersionDate(selectedVersion.createdAt)}</span><button type="button" onClick={() => setSelectedVersion(null)}>Back to current</button></div>
          )}

          <article className="document-surface">
            {documentMode === 'edit' ? (
              recording.transcriptText !== undefined ? (
                <textarea className="markdown-editor" aria-label="Transcript Markdown" value={transcriptDraft} onChange={event => setTranscriptDraft(event.target.value)} spellCheck />
              ) : <TranscriptEmpty action={action} onTranscribe={() => void runAction('transcribing')} />
            ) : documentMode === 'timestamps' ? (
              recording.segments?.length ? (
                <div className="segment-list">
                  {recording.segments.map(segment => (
                    <button key={segment.id} type="button" className={activeSegment === segment.id ? 'segment-row active' : 'segment-row'} onClick={() => seekTo(segment.startTime)}>
                      <span className={`speaker-mark speaker-${(speakerMap.get(segment.speaker) ?? 0) % 6}`} />
                      <span className="segment-time">{formatDuration(segment.startTime)}</span>
                      <span className="segment-copy"><strong>{segment.speaker}</strong>{segment.text}</span>
                    </button>
                  ))}
                </div>
              ) : <TranscriptEmpty action={action} onTranscribe={() => void runAction('transcribing')} />
            ) : displayText ? (
              <div className="markdown-document"><ReactMarkdown remarkPlugins={[remarkGfm]}>{displayText}</ReactMarkdown></div>
            ) : <TranscriptEmpty action={action} onTranscribe={() => void runAction('transcribing')} />}
          </article>
        </main>

        <aside className="recording-inspector">
          <section>
            <div className="inspector-heading"><span>Details</span><button type="button" onClick={() => setEditingMetadata(value => !value)} aria-label="Edit recording details"><Pencil /></button></div>
            {editingMetadata ? (
              <div className="metadata-form">
                <label>Context<input value={contextDraft} onChange={event => setContextDraft(event.target.value)} placeholder="What was this about?" /></label>
                <label>Tags<input value={tagsDraft} onChange={event => setTagsDraft(event.target.value)} placeholder="meeting, idea" /></label>
                <label>Notes<textarea value={notesDraft} onChange={event => setNotesDraft(event.target.value)} rows={5} /></label>
                <div className="metadata-buttons"><Button size="sm" onClick={() => void saveMetadata()} disabled={action !== null}><Save />Save</Button><Button size="sm" variant="ghost" onClick={() => setEditingMetadata(false)}>Cancel</Button></div>
              </div>
            ) : (
              <dl className="metadata-list">
                <div><dt>Status</dt><dd><Badge variant={recording.status === 'complete' ? 'success' : recording.status === 'failed' ? 'destructive' : 'warning'}>{recording.status}</Badge></dd></div>
                <div><dt>Duration</dt><dd>{formatDuration(duration || recording.duration)}</dd></div>
                <div><dt>Context</dt><dd>{recording.context || 'None'}</dd></div>
                <div><dt>Tags</dt><dd>{recording.tags.length ? recording.tags.join(', ') : 'None'}</dd></div>
              </dl>
            )}
            <label className="replace-audio"><Upload />Replace original audio<input type="file" accept="audio/*" onChange={event => {
              const file = event.target.files?.[0]
              if (!file) return
              void api.replaceAudio(recording.id, file, recording.revision).then(loadRecording).catch(replaceError => setError(replaceError instanceof Error ? replaceError.message : 'Could not replace audio'))
            }} /></label>
          </section>

          <section>
            <div className="inspector-heading"><span>Summary</span><Sparkles /></div>
            {recording.summary ? <div className="inspector-summary"><ReactMarkdown remarkPlugins={[remarkGfm]}>{recording.summary}</ReactMarkdown></div> : (
              <div className="inspector-empty"><p>No summary yet.</p><Button variant="outline" size="sm" onClick={() => void runAction('summarizing')} disabled={action !== null}>{action === 'summarizing' ? <Loader2 className="animate-spin" /> : <Sparkles />}Generate</Button></div>
            )}
          </section>

          <section>
            <div className="inspector-heading"><span>Version history</span><History /></div>
            {versions.length ? (
              <div className="version-list">
                {versions.map(version => (
                  <button type="button" key={version.id} onClick={() => { setSelectedVersion(version); setDocumentMode('preview') }}>
                    <span className={`version-origin ${version.origin}`}>{version.origin === 'edited' ? 'Edited' : 'Generated'}</span>
                    <span>{formatVersionDate(version.createdAt)}</span>
                  </button>
                ))}
              </div>
            ) : <p className="inspector-muted">Versions appear after transcription or an edit.</p>}
          </section>
        </aside>
      </div>
    </div>
  )
}

function TranscriptEmpty({ action, onTranscribe }: { action: BusyAction; onTranscribe: () => void }) {
  return (
    <div className="document-empty">
      <FileText />
      <h2>No transcript yet</h2>
      <p>Transcribe this audio with your configured engine, then edit it as Markdown.</p>
      <Button onClick={onTranscribe} disabled={action !== null}>{action === 'transcribing' ? <Loader2 className="animate-spin" /> : <Sparkles />}Transcribe audio</Button>
    </div>
  )
}

function formatRecordingDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Date unavailable'
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
}

function formatVersionDate(value: string): string {
  const date = new Date(value.endsWith('Z') ? value : `${value}Z`)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function flashSaved(setSaved: (value: boolean) => void) {
  setSaved(true)
  window.setTimeout(() => setSaved(false), 1800)
}
