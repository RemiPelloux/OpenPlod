import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, Play, Pause, SkipBack, SkipForward, Loader2, Sparkles, ListChecks, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { api, type Recording, type TranscriptSegment } from '@/lib/api'
import { formatDuration } from '@/lib/utils'

const speakerColors = [
  'text-blue-400', 'text-emerald-400', 'text-amber-400', 'text-rose-400',
  'text-violet-400', 'text-cyan-400', 'text-orange-400', 'text-pink-400',
]

export function RecordingDetail() {
  const { id } = useParams<{ id: string }>()
  const [recording, setRecording] = useState<Recording | null>(null)
  const [loading, setLoading] = useState(true)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const audioRef = useRef<HTMLAudioElement>(null)
  const waveformRef = useRef<HTMLDivElement>(null)
  const [activeSegment, setActiveSegment] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    api.getRecording(id)
      .then(setRecording)
      .catch(() => setRecording(mockRecording))
      .finally(() => setLoading(false))
  }, [id])

  const togglePlay = useCallback(() => {
    if (!audioRef.current) return
    if (playing) audioRef.current.pause()
    else audioRef.current.play()
    setPlaying(!playing)
  }, [playing])

  const seekTo = useCallback((time: number) => {
    if (!audioRef.current) return
    audioRef.current.currentTime = time
    setCurrentTime(time)
    if (!playing) {
      audioRef.current.play()
      setPlaying(true)
    }
  }, [playing])

  const handleTimeUpdate = () => {
    if (!audioRef.current) return
    const t = audioRef.current.currentTime
    setCurrentTime(t)
    // Find active segment
    const seg = recording?.segments?.find(s => t >= s.startTime && t < s.endTime)
    setActiveSegment(seg?.id ?? null)
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
      <div className="p-8 text-center text-muted-foreground">Recording not found</div>
    )
  }

  const speakerMap = new Map<string, number>()
  recording.segments?.forEach(s => {
    if (!speakerMap.has(s.speaker)) speakerMap.set(s.speaker, speakerMap.size)
  })

  return (
    <div className="p-6 md:p-8 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link to="/">
          <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
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

      {/* Audio Player */}
      <Card>
        <CardContent className="p-5 space-y-4">
          <audio
            ref={audioRef}
            src={api.getAudioUrl(recording.id)}
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={() => setDuration(audioRef.current?.duration ?? recording.duration)}
            onEnded={() => setPlaying(false)}
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
              {Array.from({ length: 120 }, (_, i) => {
                const h = 20 + Math.sin(i * 0.3) * 30 + Math.random() * 20
                const pct = i / 120
                const isPlayed = pct <= currentTime / (duration || recording.duration || 1)
                return (
                  <div
                    key={i}
                    className={`flex-1 rounded-full transition-colors ${isPlayed ? 'bg-primary' : 'bg-muted-foreground/20'}`}
                    style={{ height: `${h}%` }}
                  />
                )
              })}
            </div>
            {/* Progress overlay */}
            <div
              className="absolute top-0 left-0 h-full bg-primary/5"
              style={{ width: `${(currentTime / (duration || recording.duration || 1)) * 100}%` }}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground font-mono">{formatDuration(currentTime)}</span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => seekTo(Math.max(0, currentTime - 15))}>
                <SkipBack className="h-4 w-4" />
              </Button>
              <Button size="icon" className="h-11 w-11 rounded-full" onClick={togglePlay}>
                {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 ml-0.5" />}
              </Button>
              <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => seekTo(currentTime + 15)}>
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
                  <div
                    key={seg.id}
                    className={`flex gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
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
                  </div>
                ))
              ) : recording.transcriptText ? (
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{recording.transcriptText}</p>
              ) : (
                <div className="text-center py-10 text-muted-foreground">
                  <p className="text-sm">No transcript available</p>
                  <Button size="sm" className="mt-3" onClick={() => id && api.transcribe(id)}>
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
                  <Button size="sm" variant="outline" className="mt-3" onClick={() => id && api.summarize(id)}>
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

const mockRecording: Recording = {
  id: '1',
  title: 'MBA 560 - Business Analytics Lecture',
  filename: 'rec_001.wav',
  filePath: '',
  duration: 4820,
  fileSize: 48200000,
  recordingType: 'class',
  context: null,
  recordedAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  status: 'complete',
  summary: 'Professor covered regression analysis fundamentals, including simple and multiple linear regression, R-squared interpretation, and practical applications in business decision making. Key emphasis on avoiding overfitting and the importance of cross-validation.',
  actionItems: [
    'Complete homework 3 on regression analysis by Friday',
    'Read Chapter 7 on logistic regression',
    'Form groups for the final project by next Tuesday',
    'Review the Kaggle dataset for practice',
  ],
  segments: [
    { id: 's1', speaker: 'Professor', text: 'Alright, let\'s get started. Today we\'re going to dive into regression analysis, which is really the foundation of predictive analytics.', startTime: 0, endTime: 12 },
    { id: 's2', speaker: 'Professor', text: 'The basic idea is simple — we want to understand the relationship between variables and use that to make predictions.', startTime: 12, endTime: 22 },
    { id: 's3', speaker: 'Student 1', text: 'Is this different from correlation analysis?', startTime: 22, endTime: 25 },
    { id: 's4', speaker: 'Professor', text: 'Great question. Correlation tells you that two things move together. Regression tells you by how much, and lets you predict one from the other.', startTime: 25, endTime: 35 },
    { id: 's5', speaker: 'Professor', text: 'Let me show you with a real example. Say you have advertising spend and revenue data...', startTime: 35, endTime: 45 },
    { id: 's6', speaker: 'Student 2', text: 'Can we use multiple variables at once?', startTime: 45, endTime: 48 },
    { id: 's7', speaker: 'Professor', text: 'Absolutely. That\'s multiple linear regression. You can have as many predictors as you want, but be careful of overfitting — which we\'ll discuss next.', startTime: 48, endTime: 60 },
  ],
}
