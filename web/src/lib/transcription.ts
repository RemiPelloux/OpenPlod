import { READ_ONLY_SETTINGS, type AiConfig, type AiSettings, type CostEstimate, type ProfileInput, type SpeechProvider } from './ai-settings'
import { t, tn } from '@/i18n'

/** Languages offered in transcription pickers; `auto` lets the provider detect it. */
export const LANGUAGES: [string, string][] = [
  ['auto', 'Detect automatically'], ['en', 'English'], ['fr', 'French'], ['de', 'German'], ['es', 'Spanish'],
  ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['ja', 'Japanese'], ['zh', 'Chinese'],
]
/** Language names in the UI language; call at render time. */
function languageNames(): Record<string, string> {
  return {
    auto: t('Detect automatically'), en: t('English'), fr: t('French'), de: t('German'), es: t('Spanish'),
    it: t('Italian'), pt: t('Portuguese'), nl: t('Dutch'), ja: t('Japanese'), zh: t('Chinese'),
  }
}
/** Translates the labels of a language list for display. */
export const localizeLanguages = (list: [string, string][] = LANGUAGES): [string, string][] => {
  const names = languageNames()
  return list.map(([code, label]) => [code, names[code] ?? label])
}
export const languageLabel = (code: string | null) => (code ? languageNames()[code] : undefined) ?? code ?? ''
/** A processing job status in the UI language; unknown statuses are shown as sent. */
export function jobStatusLabel(status: string): string {
  const names: Record<string, string> = { pending: t('pending'), running: t('running'), complete: t('complete'), completed: t('complete'), failed: t('failed'), cancelled: t('cancelled') }
  return names[status] ?? status
}
/** Joins short labels as a natural list: "a, b or c". */
export function joinLabels(items: string[], type: 'conjunction' | 'disjunction'): string {
  if (items.length < 2) return items[0] ?? ''
  const first = items.slice(0, -1).join(', '), last = items[items.length - 1]
  return type === 'conjunction' ? t('{first} and {last}', { first, last }) : t('{first} or {last}', { first, last })
}
export const PROMPT_LIMIT = 1000

/** What a profile will and will not send to one provider, for an honest preview before a job runs. */
export function profileFit(profile: Pick<ProfileInput, 'prompt' | 'vocabulary' | 'diarize' | 'engine'>, settings: AiSettings, engine: SpeechProvider = profile.engine ?? settings.transcriptionEngine) {
  const capability = settings.capabilities[engine]
  const ignored = [
    profile.prompt && !capability.prompt && t('context prompt'),
    profile.vocabulary.length && !capability.vocabulary && t('vocabulary'),
    profile.diarize && !capability.diarization && t('speaker labels'),
  ].filter((value): value is string => Boolean(value))
  return { engine, label: capability.label, ignored }
}

/** The AI config without the read-only fields the settings endpoint adds. */
export function configOf(settings: AiSettings): AiConfig {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => !(READ_ONLY_SETTINGS as readonly string[]).includes(key))) as AiConfig
}

/**
 * Languages to offer for one provider and model. When the capability registry
 * documents a list, only those languages (and automatic detection) are shown;
 * when it does not, every picker language stays available and the provider decides.
 */
export function languagesFor(settings: Pick<AiSettings, 'capabilities'>, engine: SpeechProvider, model?: string | null): [string, string][] {
  const capability = settings.capabilities[engine]
  const documented = (capability.languages as Record<string, readonly string[] | null>)[model || capability.models[0]] ?? null
  return localizeLanguages(Array.isArray(documented) ? LANGUAGES.filter(([code]) => code === 'auto' || documented.includes(code.split('-')[0])) : LANGUAGES)
}

/** Mirrors the server rule: a custom endpoint stays on this computer only on loopback. */
export function customEndpointIsLocal(value: string): boolean {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && (['localhost', '[::1]'].includes(url.hostname) || /^127(\.\d{1,3}){3}$/.test(url.hostname)) } catch { return false }
}

/** USD with enough precision for small per-minute charges; unknown stays unknown. */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return t('unknown')
  return `$${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`
}

/** One honest sentence about an estimate: always labelled as an estimate, never as a bill. */
export function describeEstimate(estimate: Pick<CostEstimate, 'totalUsd' | 'unknownCount' | 'local' | 'pricesAsOf'>): string {
  if (estimate.local) return t('Runs on this computer; no provider charges.')
  if (estimate.totalUsd === null) return estimate.unknownCount
    ? tn(estimate.unknownCount, 'Estimated cost unknown for {count} recording (no documented price or unknown duration).', 'Estimated cost unknown for {count} recordings (no documented price or unknown duration).')
    : t('Estimated cost unknown (no documented price or unknown duration).')
  return t('Estimated cost {cost} from list prices as of {date}. Not a bill; the provider may charge differently.', { cost: formatUsd(estimate.totalUsd), date: estimate.pricesAsOf })
}
