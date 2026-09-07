import type WaveSurfer from 'wavesurfer.js'

type BlobPlayer = Pick<WaveSurfer, 'loadBlob' | 'on'>

// Pass bytes directly: fetching an object URL violates the desktop connect-src policy.
export function loadWaveform(player: BlobPlayer, blob: Blob, signal: AbortSignal, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let removeError: (() => void) | undefined = undefined
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      removeError?.()
      if (error) reject(error)
      else resolve()
    }
    const abort = () => finish(new DOMException('Audio loading cancelled.', 'AbortError'))
    const timer = setTimeout(() => finish(new Error('Audio took too long to load. Retry playback.')), timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    removeError = player.on('error', () => finish(new Error('This audio could not be decoded. Download the original or retry playback.')))
    player.loadBlob(blob).then(() => finish(), () => finish(new Error('This audio could not be decoded. Download the original or retry playback.')))
  })
}
