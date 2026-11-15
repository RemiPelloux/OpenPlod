import { t } from '@/i18n'

/** Translate both API errors and native command rejections at their UI boundary. */
export function plaudErrorMessage(error: unknown): string {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : 'Could not authorize the recorder.'
  let match = /^Not enough available memory to import this (\d+) MiB recording\./.exec(message)
  if (match) return t('Not enough memory for this {size} MiB recording. Close other applications and retry. The original stays on Plaud.', { size: match[1] })
  match = /^(ffmpeg|ffprobe) made no progress for ([\d.]+) seconds\./.exec(message)
  if (match) return t('{tool} stopped progressing for {seconds} seconds. Downloaded audio is kept for retry.', { tool: match[1], seconds: match[2] })
  match = /^(ffmpeg|ffprobe) failed \(exit (-?\d+)\): ([\s\S]*)\. Downloaded audio is kept for retry\.$/.exec(message)
  if (match) return t('{tool} failed (code {code}). Downloaded audio is kept for retry. Details: {details}', { tool: match[1], code: match[2], details: match[3] })
  match = /^Plaud access was blocked by an HTML response \(HTTP (\d+), (sn-sign|gen_key)\)\./.exec(message)
  if (match) return t('Plaud access was blocked (HTTP {status}, {step}). This does not mean your session is invalid.', { status: match[1], step: match[2] })
  match = /^Plaud refused authorization \(HTTP (\d+), (sn-sign|gen_key)\)\./.exec(message)
  if (match) return t('Plaud refused recorder authorization (HTTP {status}, {step}). Sign in with the linked account.', { status: match[1], step: match[2] })
  match = /^Plaud authorization failed \(HTTP (\d+)\)\.$/.exec(message)
  if (match) return t('Plaud authorization failed (HTTP {status}).', { status: match[1] })
  match = /^Sign-in navigation blocked: (.+)\. No token is displayed\./.exec(message)
  if (match) return t('Sign-in navigation blocked: {destination}. No token is displayed. Report this destination to correct the filter.', { destination: match[1] })
  return t(message)
}
