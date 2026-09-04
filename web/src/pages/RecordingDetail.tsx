import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { useParams, Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Play, Pause, SkipBack, SkipForward, Loader2, Sparkles, ListChecks, FileText, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { api, type Recording, type TranscriptSegment } from '@/lib/api'
import { formatDuration } from '@/lib/utils'

const speakerColors = [
  'text-blue-400', 'text-emerald-400', 'text-amber-400', 'text-rose-400',
  'text-violet-400', 'text-cyan-400', 'text-orange-400', 'text-pink-400',
]

const waveformHeights = Array.from({ length: 120 }, (_, index) => {
  const wave = Math.sin(index * 0.31) * 24 + Math.sin(index * 0.73) * 13
  return Math.max(16, Math.min(92, 48 + wave))
})

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

export function RecordingDetail() {
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const [recording, setRecording] = useState<Recording | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [action, setAction] = useState<'transcribing' | 'summarizing' | null>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const audioRef = useRef<HTMLAudioElement>(null)
  const waveformRef = useRef<HTMLDivElement>(null)
  const [activeSegment, setActiveSegment] = useState<string | null>(null)

  const loadRecording = useCallback(async () => {
    if (!id) return
    setError('')
    try {
      setRecording(await api.getRecording(id))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load recording')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { void loadRecording() }, [loadRecording])

  const speakerMap = useMemo(() => {
    const nextMap = new Map<string, number>()
    recording?.segments?.forEach(segment => {
      if (!nextMap.has(segment.speaker)) nextMap.set(segment.speaker, nextMap.size)
    })
    return nextMap
  }, [recording?.segments])

  const togglePlay = useCallback(() => {
    if (!audioRef.current) return
    if (playing) audioRef.current.pause()
    else void audioRef.current.play().catch(() => setPlaying(false))
    setPlaying(current => !current)
  }, [playing])

  const seekTo = useCallback((time: number) => {
    if (!audioRef.current) return
    audioRef.current.currentTime = time
    setCurrentTime(time)
    if (!playing) {
      void audioRef.current.play().catch(() => setPlaying(false))
      setPlaying(true)
    }
  }, [playing])

  const handleTimeUpdate = () => {
    if (!audioRef.current) return
    const t = audioRef.current.currentTime
    setCurrentTime(t)
    const seg = recording?.segments ? findActiveSegment(recording.segments, t) : undefined
    setActiveSegment(seg?.id ?? null)
  }

  const handleLoadedMetadata = () => {
    const audio = audioRef.current
    if (!audio) return
    setDuration(Number.isFinite(audio.duration) ? audio.duration : recording?.duration ?? 0)
    const requestedTime = Number(searchParams.get('t'))
    if (Number.isFinite(requestedTime) && requestedTime > 0) {
      audio.currentTime = requestedTime
      setCurrentTime(requestedTime)
    }
  }

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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

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
    <div className="p-6 md:p-8 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link to="/">
          <Button variant="ghost" size="icon" aria-label="Back to recordings" title="Back to recordings"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{recording.title}</h1>
          <p className="text-sm text-muted-foreground">
            {new Date(recording.recordedAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            {' · '}{formatDuration(recording.duration)}
          </p>
        </div>
        <Badge variant={recording.status === 'complete' ? 'success' : recording.status === 'failed' ? 'destructive' : 'warning'}>{recording.status}</Badge>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Audio Player */}
      <Card>
        <CardContent className="p-5 space-y-4">
          <audio
            ref={audioRef}
            src={api.getAudioUrl(recording.id)}
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            onEnded={() => setPlaying(false)}
            preload="metadata"
          />
          {/* Waveform placeholder */}
          <div ref={waveformRef} className="relative h-20 bg-secondary/50 rounded-lg overflow-hidden cursor-pointer"
            onClick={e => {
              const rect = e.currentTarget.getBoundingClientRect()
              const pct = (e.clientX - rect.left) / rect.width
              seekTo(pct * (duration || recording.duration))
            }}
          >
            {/* Fake waveform bars */}
            <div className="absolute inset-0 flex items-center gap-[2px] px-2">
              {waveformHeights.map((height, i) => {
                const pct = i / 120
                const isPlayed = pct <= currentTime / (duration || recording.duration || 1)
                return (
                  <div
                    key={i}
                    className={`flex-1 rounded-full transition-colors ${isPlayed ? 'bg-primary' : 'bg-muted-foreground/20'}`}
                    style={{ height: `${height}%` }}
                  />
                )
              })}
            </div>
            {/* Progress overlay */}
            <div className="pointer-events-none absolute inset-0 origin-left bg-primary/5" style={{ transform: `scaleX(${currentTime / (duration || recording.duration || 1)})` }} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground font-mono">{formatDuration(currentTime)}</span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => seekTo(Math.max(0, currentTime - 15))} aria-label="Back 15 seconds" title="Back 15 seconds">
                <SkipBack className="h-4 w-4" />
              </Button>
              <Button size="icon" className="h-11 w-11 rounded-full" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause' : 'Play'}>
                {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 ml-0.5" />}
              </Button>
              <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => seekTo(Math.min(duration || recording.duration, currentTime + 15))} aria-label="Forward 15 seconds" title="Forward 15 seconds">
                <SkipForward className="h-4 w-4" />
              </Button>
            </div>
            <span className="text-xs text-muted-foreground font-mono">{formatDuration(duration || recording.duration)}</span>
          </div>
        </CardContent>
      </Card>

      {/* Content grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Transcript */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="h-4 w-4" /> Transcript
              </CardTitle>
            </CardHeader>
            <CardContent className="max-h-[500px] overflow-y-auto space-y-3">
              {recording.segments && recording.segments.length > 0 ? (
                recording.segments.map(seg => (
                  <button
                    type="button"
                    key={seg.id}
                    className={`transcript-segment flex w-full gap-3 rounded-lg p-3 text-left transition-colors ${
                      activeSegment === seg.id ? 'bg-primary/10 ring-1 ring-primary/20' : 'hover:bg-accent/50'
                    }`}
                    onClick={() => seekTo(seg.startTime)}
                  >
                    <div className="shrink-0 w-20">
                      <span className={`text-xs font-medium ${speakerColors[speakerMap.get(seg.speaker) ?? 0]}`}>
                        {seg.speaker}
                      </span>
                      <p className="text-[10px] text-muted-foreground font-mono mt-0.5">{formatDuration(seg.startTime)}</p>
                    </div>
                    <p className="text-sm leading-relaxed">{seg.text}</p>
                  </button>
                ))
              ) : recording.transcriptText ? (
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{recording.transcriptText}</p>
              ) : (
                <div className="text-center py-10 text-muted-foreground">
                  <p className="text-sm">No transcript available</p>
                  <Button size="sm" className="mt-3" onClick={() => void runAction('transcribing')} disabled={action !== null}>
                    {action === 'transcribing' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Transcribe now
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Sidebar: Summary + Action Items */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Sparkles className="h-4 w-4" /> Summary
              </CardTitle>
            </CardHeader>
            <CardContent>
              {recording.summary ? (
                <p className="text-sm leading-relaxed text-muted-foreground">{recording.summary}</p>
              ) : (
                <div className="text-center py-6 text-muted-foreground">
                  <p className="text-sm">No summary yet</p>
                  <Button size="sm" variant="outline" className="mt-3" onClick={() => void runAction('summarizing')} disabled={action !== null}>
                    {action === 'summarizing' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Generate summary
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {recording.actionItems && recording.actionItems.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <ListChecks className="h-4 w-4" /> Action Items
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {recording.actionItems.map((item, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <div className="h-5 w-5 shrink-0 rounded border flex items-center justify-center mt-0.5">
                        <div className="h-2 w-2 rounded-sm bg-primary/30" />
                      </div>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
