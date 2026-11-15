import type { PlaudImportProgress as Progress } from '@/lib/api'
import { t } from '@/i18n'
import './plaud-import-progress.css'

const labels: Record<Progress['stage'], string> = {
  connecting: 'Connecting to your Plaud', downloading: 'Downloading audio from Plaud',
  decrypting: 'Decrypting the downloaded audio', converting: 'Converting audio for playback',
  verifying: 'Verifying audio and source retention', saving: 'Saving to your vault', complete: 'Recording saved',
}
const mib = (bytes: number) => (bytes / 1048576).toFixed(1)

export function PlaudImportProgress({ progress, sessionId }: { progress: Progress | null; sessionId: number | null }) {
  const stage = progress?.stage ?? 'connecting'
  const percent = progress?.percent ?? null
  const label = t(labels[stage])
  const resumed = (progress?.resumedBytes ?? 0) > 0
  const completeDownload = resumed && progress!.resumedBytes >= progress!.totalBytes
  return <div className="plaud-live-progress">
    <div className="plaud-progress-ring" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={percent ?? undefined} aria-valuetext={percent === null ? t('In progress') : `${percent}%`}>
      <svg viewBox="0 0 80 80" aria-hidden="true"><circle className="plaud-ring-track" cx="40" cy="40" r="34" />
        <circle className={`plaud-ring-value${percent === null ? ' is-indeterminate' : ''}`} cx="40" cy="40" r="34"
          pathLength="100" strokeDasharray="100" strokeDashoffset={percent === null ? 75 : 100 - percent} /></svg>
      <strong>{percent === null ? '…' : `${percent}%`}</strong>
    </div>
    <div className="plaud-progress-copy">
      <strong aria-live="polite">{label}</strong>
      <span>{t('Recording {id}', { id: sessionId ?? '' })}</span>
      {stage === 'downloading' && progress && <span>{t('{received} / {total} MiB received', { received: mib(progress.receivedBytes), total: mib(progress.totalBytes) })}</span>}
      {percent !== null && stage !== 'complete' && <small>{t('Progress of this step')}</small>}
      {resumed && <small className="plaud-resume-note">{completeDownload ? t('Download already complete. Reusing the local file.') : t('Resuming from {size} MiB already received.', { size: mib(progress!.resumedBytes) })}</small>}
      <small>{t('Original recording stays on your Plaud.')}</small>
    </div>
  </div>
}
