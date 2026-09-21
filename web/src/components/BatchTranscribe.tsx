import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, Loader2, RotateCcw, Speech, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { api, type BatchEstimate, type BatchJob, type Recording } from '@/lib/api'
import './batch-transcribe.css'

/**
 * Batch transcription (roadmap TS-10).
 *
 * Two-step by design: the first click reports what would run and whether it
 * reaches a paid provider; only the second starts work. Progress is per item,
 * so one failure is visible as one failure rather than a dead batch, and
 * "Retry failed" re-submits exactly the failed items — re-running a succeeded
 * one against a paid provider is a second charge, not a retry.
 */

const POLL_MS = 1500

export function BatchTranscribe({ recordings, onFinished }: {
  recordings: Recording[]
  onFinished: () => void
}) {
  const [estimate, setEstimate] = useState<BatchEstimate | null>(null)
  const [job, setJob] = useState<BatchJob | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const finished = useRef(onFinished)
  useEffect(() => { finished.current = onFinished }, [onFinished])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  // Only recordings that have no transcript are candidates; re-transcribing a
  // finished one is a separate, deliberate action on that recording.
  const candidates = recordings.filter(row => !row.transcriptText?.trim() && row.retentionState === 'active')

  const fail = (failure: unknown) => {
    if (mounted.current) setError(failure instanceof Error ? failure.message : 'The batch could not run.')
  }

  // Poll while a batch is active; stop as soon as it settles.
  useEffect(() => {
    if (!job?.active) return
    const timer = window.setInterval(() => {
      void api.getBatch(job.id)
        .then(next => {
          if (!mounted.current) return
          setJob(next)
          if (!next.active) finished.current()
        })
        .catch(() => {})
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [job?.id, job?.active])

  const check = useCallback(async () => {
    setBusy(true); setError('')
    try { setEstimate(await api.estimateBatch(candidates.map(row => row.id))) }
    catch (failure) { fail(failure) }
    finally { if (mounted.current) setBusy(false) }
  }, [candidates])

  const start = async (retryOf?: string) => {
    setBusy(true); setError('')
    try {
      const ids = retryOf ? [] : candidates.map(row => row.id)
      setJob(await api.startBatch(ids, retryOf ? { retryOf } : {}))
      setEstimate(null)
    } catch (failure) { fail(failure) }
    finally { if (mounted.current) setBusy(false) }
  }

  if (candidates.length === 0 && !job) return null

  return (
    <div className="batch-transcribe">
      {error && <p className="batch-error" role="alert"><AlertCircle />{error}</p>}

      {!job && (
        <div className="batch-bar">
          <span>{candidates.length} recording{candidates.length === 1 ? '' : 's'} without a transcript</span>
          {estimate
            ? (
              <>
                <span className="batch-confirm">
                  {estimate.usesCloudProvider
                    ? `This sends ${estimate.wouldRun} recording${estimate.wouldRun === 1 ? '' : 's'} to ${estimate.provider}, which may be billed. Cost is not estimated here because ${estimate.provider} prices per second of audio.`
                    : `This runs ${estimate.wouldRun} recording${estimate.wouldRun === 1 ? '' : 's'} locally with ${estimate.provider ?? 'the configured engine'}.`}
                </span>
                <Button size="sm" disabled={busy} onClick={() => void start()}>
                  {busy ? <Loader2 className="batch-spin" /> : <Check />}Start
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEstimate(null)}><X />Cancel</Button>
              </>
            )
            : (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void check()}>
                {busy ? <Loader2 className="batch-spin" /> : <Speech />}Transcribe all
              </Button>
            )}
        </div>
      )}

      {job && (
        <div className="batch-progress">
          <div className="batch-bar">
            <span>
              {job.active ? 'Transcribing' : 'Batch finished'}: {job.summary.complete} done
              {job.summary.failed > 0 && `, ${job.summary.failed} failed`}
              {job.summary.cancelled > 0 && `, ${job.summary.cancelled} cancelled`}
              {' '}of {job.summary.total}
            </span>
            {job.active
              ? <Button size="sm" variant="ghost" onClick={() => void api.cancelBatch(job.id).catch(() => {})}><X />Cancel</Button>
              : (
                <>
                  {job.summary.failed > 0 && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void start(job.id)}>
                      <RotateCcw />Retry {job.summary.failed} failed
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => { setJob(null); setEstimate(null) }}><X />Dismiss</Button>
                </>
              )}
          </div>
          {job.summary.failed > 0 && (
            <ul className="batch-failures">
              {job.items.filter(item => item.state === 'failed').map(item => (
                <li key={item.recordingId}>
                  <code>{item.recordingId.slice(0, 8)}</code> {item.error ?? 'Failed.'}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
