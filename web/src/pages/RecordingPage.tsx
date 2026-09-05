import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Check, FileAudio, Loader2, Mic, Pause, Play, RotateCcw, Square, UploadCloud, WifiOff, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PlaudImportDialog } from '@/components/PlaudImportDialog'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { getRuntime } from '@/lib/runtime'
import { latestPendingCapture, removePendingCapture, savePendingCapture, type PendingCapture } from '@/lib/recording-outbox'
import { formatDuration } from '@/lib/utils'
import { completePendingAndroidShare, readPendingAndroidShare } from '@/lib/android-share'

type CaptureState = 'idle' | 'requesting' | 'recording' | 'paused' | 'review' | 'uploading' | 'stored'

const WAVE_BAR_COUNT = 48

export function RecordingPage() {
  const navigate = useNavigate()
  const runtime = getRuntime()
  const [state, setState] = useState<CaptureState>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [capture, setCapture] = useState<PendingCapture | null>(null)
  const [audioUrl, setAudioUrl] = useState('')
  const [title, setTitle] = useState(defaultTitle)
  const [context, setContext] = useState('')
  const [error, setError] = useState('')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const animationRef = useRef<number | null>(null)
  const activeStartedAtRef = useRef(0)
  const accumulatedMsRef = useRef(0)
  const recordedAtRef = useRef('')

  const releaseMicrophone = useCallback(() => {
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current)
    animationRef.current = null
    void audioContextRef.current?.close()
    audioContextRef.current = null
    analyserRef.current = null
  }, [])

  useEffect(() => {
    const restoreCapture = async () => {
      const shared = await readPendingAndroidShare()
      const pending = shared ?? await latestPendingCapture()
      if (!pending) return
      if (shared) {
        await savePendingCapture(shared)
        if (shared.nativeShareId) completePendingAndroidShare(shared.nativeShareId)
      }
      setCapture(pending)
      setTitle(pending.title)
      setContext(pending.context)
      setElapsedMs(pending.durationMs)
      setAudioUrl(URL.createObjectURL(pending.blob))
      setState('review')
    }
    void restoreCapture().catch(importError => {
      setError(importError instanceof Error ? importError.message : 'The shared recording could not be opened.')
    })
  }, [])

  useEffect(() => {
    if (state !== 'recording') return
    const update = () => setElapsedMs(accumulatedMsRef.current + performance.now() - activeStartedAtRef.current)
    update()
    const timer = window.setInterval(update, 200)
    return () => window.clearInterval(timer)
  }, [state])

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (state !== 'recording' && state !== 'paused') return
      event.preventDefault()
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [state])

  useEffect(() => () => {
    releaseMicrophone()
    if (audioUrl) URL.revokeObjectURL(audioUrl)
  }, [audioUrl, releaseMicrophone])

  const drawWaveform = useCallback(function draw() {
    const canvas = canvasRef.current
    const analyser = analyserRef.current
    if (!canvas || !analyser) return
    const ratio = window.devicePixelRatio || 1
    const width = Math.max(1, canvas.clientWidth)
    const height = Math.max(1, canvas.clientHeight)
    if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
      canvas.width = width * ratio
      canvas.height = height * ratio
    }
    const context2d = canvas.getContext('2d')
    if (!context2d) return
    context2d.setTransform(ratio, 0, 0, ratio, 0, 0)
    context2d.clearRect(0, 0, width, height)
    const samples = new Uint8Array(analyser.frequencyBinCount)
    analyser.getByteFrequencyData(samples)
    const gap = 4
    const barWidth = Math.max(2, (width - gap * (WAVE_BAR_COUNT - 1)) / WAVE_BAR_COUNT)
    const step = Math.max(1, Math.floor(samples.length / WAVE_BAR_COUNT))
    context2d.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()
    for (let index = 0; index < WAVE_BAR_COUNT; index += 1) {
      const strength = samples[index * step] / 255
      const barHeight = Math.max(4, strength * height * 0.9)
      const x = index * (barWidth + gap)
      const y = (height - barHeight) / 2
      context2d.beginPath()
      context2d.roundRect(x, y, barWidth, barHeight, barWidth / 2)
      context2d.fill()
    }
    animationRef.current = requestAnimationFrame(draw)
  }, [])

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Microphone recording is not supported on this device.')
      return
    }
    setState('requesting')
    setError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      streamRef.current = stream
      const mimeType = preferredMimeType()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorderRef.current = recorder
      chunksRef.current = []
      accumulatedMsRef.current = 0
      activeStartedAtRef.current = monotonicNow()
      recordedAtRef.current = new Date().toISOString()
      const audioContext = new AudioContext()
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.78
      audioContext.createMediaStreamSource(stream).connect(analyser)
      audioContextRef.current = audioContext
      analyserRef.current = analyser
      recorder.ondataavailable = event => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onstop = () => void finalizeCapture(recorder.mimeType || mimeType || 'audio/webm')
      recorder.start(1000)
      setElapsedMs(0)
      setState('recording')
      animationRef.current = requestAnimationFrame(drawWaveform)
    } catch (permissionError) {
      releaseMicrophone()
      setState('idle')
      setError(permissionError instanceof Error && permissionError.name === 'NotAllowedError'
        ? 'Microphone access is off. Allow OpenPlod in your system settings, then try again.'
        : 'The microphone could not be started.')
    }
  }

  const pauseRecording = () => {
    const recorder = recorderRef.current
    if (!recorder) return
    if (state === 'recording') {
      recorder.pause()
      accumulatedMsRef.current += monotonicNow() - activeStartedAtRef.current
      setElapsedMs(accumulatedMsRef.current)
      setState('paused')
    } else if (state === 'paused') {
      recorder.resume()
      activeStartedAtRef.current = monotonicNow()
      setState('recording')
    }
  }

  const stopRecording = () => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    if (state === 'recording') accumulatedMsRef.current += monotonicNow() - activeStartedAtRef.current
    setElapsedMs(accumulatedMsRef.current)
    recorder.stop()
    releaseMicrophone()
  }

  const finalizeCapture = async (mimeType: string) => {
    const blob = new Blob(chunksRef.current, { type: mimeType })
    const pending: PendingCapture = {
      id: crypto.randomUUID(),
      blob,
      filename: `${slugify(title)}.${extensionForMimeType(mimeType)}`,
      title,
      context,
      recordedAt: recordedAtRef.current || new Date().toISOString(),
      durationMs: accumulatedMsRef.current,
    }
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    setCapture(pending)
    setAudioUrl(URL.createObjectURL(blob))
    setState('review')
    try {
      await savePendingCapture(pending)
    } catch {
      setError('The recording is ready, but an offline copy could not be saved. Export or store it before leaving.')
    }
  }

  const upload = async () => {
    if (!capture) return
    setState('uploading')
    setError('')
    const extension = extensionForMimeType(capture.blob.type)
    const filename = `${slugify(title)}.${extension}`
    const pending = { ...capture, title, context, filename }
    try {
      await savePendingCapture(pending)
      const acknowledgement = await api.uploadRecording(
        new File([capture.blob], filename, { type: capture.blob.type }),
        runtime.mode === 'mobile',
        {
          recordedAt: capture.recordedAt,
          context,
          recordingType: 'other',
          sourceProvider: capture.sourceProvider,
          sourceTransport: capture.sourceTransport,
          sourceRecordingId: capture.sourceRecordingId,
          durationMs: capture.durationMs,
        },
      )
      await removePendingCapture(capture.id)
      setState('stored')
      window.setTimeout(() => navigate(`/recording/${acknowledgement.recordingId}`, { replace: true }), 550)
    } catch (uploadError) {
      setState('review')
      setError(uploadError instanceof Error
        ? `Local recording retained. ${uploadError.message}`
        : 'Local recording retained. Check the vault connection and retry.')
    }
  }

  const discard = async () => {
    if (capture && !window.confirm('Discard this local recording?')) return
    if (capture) await removePendingCapture(capture.id).catch(() => undefined)
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    setCapture(null)
    setAudioUrl('')
    setElapsedMs(0)
    setError('')
    setTitle(defaultTitle())
    setContext('')
    setState('idle')
  }

  const goBack = () => {
    if ((state === 'recording' || state === 'paused') && !window.confirm('Stop and leave this recording?')) return
    if (state === 'recording' || state === 'paused') stopRecording()
    navigate('/')
  }

  const isCapturing = state === 'recording' || state === 'paused'

  return (
    <div className="capture-page">
      <header className="capture-header">
        <Button variant="ghost" size="icon" onClick={goBack} aria-label="Back to library" title="Back to library"><ArrowLeft /></Button>
        <span>{capture?.sourceProvider === 'plaud' ? 'Import Plaud recording' : state === 'review' || state === 'uploading' ? 'Review recording' : 'New recording'}</span>
        {state === 'review' ? <Button variant="ghost" size="icon" onClick={() => void discard()} aria-label="Discard recording" title="Discard recording"><X /></Button> : <span className="h-10 w-10" />}
      </header>

      <main className="capture-stage">
        {state === 'idle' || state === 'requesting' ? (
          <div className="capture-ready">
            <div className="capture-orbit"><Mic aria-hidden="true" /></div>
            <div>
              <h1>New recording</h1>
            </div>
            <button className="record-trigger" type="button" onClick={() => void startRecording()} disabled={state === 'requesting'} aria-label="Start recording">
              {state === 'requesting' ? <Loader2 className="animate-spin" /> : <Mic />}
            </button>
            <div className="capture-import-option"><span>or</span><PlaudImportDialog variant="outline" /></div>
          </div>
        ) : isCapturing ? (
          <div className="capture-live">
            <div className="capture-state"><span className={state === 'paused' ? 'paused' : ''} />{state === 'paused' ? 'Paused' : 'Recording'}</div>
            <div className="capture-timer">{formatDuration(elapsedMs / 1000)}</div>
            <canvas ref={canvasRef} className={state === 'paused' ? 'capture-wave paused' : 'capture-wave'} aria-hidden="true" />
            <div className="capture-controls">
              <button type="button" className="capture-control secondary" onClick={pauseRecording} aria-label={state === 'paused' ? 'Resume recording' : 'Pause recording'}>
                {state === 'paused' ? <Play /> : <Pause />}
              </button>
              <button type="button" className="capture-control stop" onClick={stopRecording} aria-label="Stop recording"><Square /></button>
            </div>
          </div>
        ) : state === 'stored' ? (
          <div className="capture-stored" role="status"><span><Check /></span><h1>Stored in your vault</h1><p>Opening the recording...</p></div>
        ) : (
          <div className="capture-review">
            {capture?.sourceProvider === 'plaud' && <div className="capture-source"><FileAudio />Plaud audio received</div>}
            <div className="capture-review-time">{formatDuration(elapsedMs / 1000)}</div>
            {audioUrl && <audio className="capture-audio" src={audioUrl} controls preload="metadata" />}
            <div className="capture-fields">
              <label>Title<Input value={title} onChange={event => setTitle(event.target.value)} maxLength={120} /></label>
              <label>Context<textarea value={context} onChange={event => setContext(event.target.value)} placeholder="Meeting, idea, voice note..." rows={3} /></label>
            </div>
            <Button size="lg" className="capture-upload" onClick={() => void upload()} disabled={state === 'uploading' || !title.trim()}>
              {state === 'uploading' ? <Loader2 className="animate-spin" /> : <UploadCloud />}
              {state === 'uploading' ? 'Storing in vault...' : 'Store in desktop vault'}
            </Button>
            {error && <div className="capture-offline" role="alert"><WifiOff /><span>{error}</span></div>}
            <Button variant="ghost" onClick={() => void discard()} disabled={state === 'uploading'}><RotateCcw />Record again</Button>
          </div>
        )}
        {error && state === 'idle' && <div className="capture-error" role="alert">{error}</div>}
      </main>
    </div>
  )
}

function preferredMimeType(): string {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
    .find(type => MediaRecorder.isTypeSupported(type)) ?? ''
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'm4a'
  if (mimeType.includes('ogg')) return 'ogg'
  return 'webm'
}

function slugify(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '-').slice(0, 90) || 'recording'
}

function defaultTitle(): string {
  const now = new Date()
  return `Recording ${now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}

function monotonicNow(): number {
  return performance.now()
}
