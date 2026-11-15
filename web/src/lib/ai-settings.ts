import type { AiConfig, SpeechProvider, TextProvider } from '../../../src/ai/config'
import type { speechCapabilities } from '../../../src/ai/capabilities'
import type { speechPrices, textPrices } from '../../../src/ai/pricing'
import type { estimateRecordings, monthToDate } from '../../../src/ai/spending'
import { apiUrl, authenticatedHeaders } from './runtime'
import type { TranscriptionProfile, ProfilePreset, ProfileInput } from '../../../src/ai/transcription-profiles'
import type { OnboardingStatus } from '../../../src/api/onboarding'
export type { AiConfig, SpeechProvider, TextProvider, TranscriptionProfile, ProfilePreset, ProfileInput, OnboardingStatus }
export type TextCapability = { defaultModel: string | null; local: boolean; requiresKey: boolean }
export type AiSettings = AiConfig & {
  credentials: Record<string, boolean>; capabilities: typeof speechCapabilities
  textCapabilities: Record<TextProvider, TextCapability>
  pricing: { pricesAsOf: string; label: string; speech: typeof speechPrices; text: typeof textPrices }
}
/** Read-only fields the settings endpoint adds; they are never sent back on save. */
export const READ_ONLY_SETTINGS = ['credentials', 'capabilities', 'textCapabilities', 'pricing'] as const
export type CostEstimate = ReturnType<typeof estimateRecordings>
export type MonthSpend = ReturnType<typeof monthToDate>
export type ProcessingJob = { id: string; recordingId: string; provider?: string; status: string; error?: string; priority: number; attempts?: number; checkpoint?: { phase: string; remoteId?: string; inFlight?: boolean; progress?: { done: number; total: number } } }
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(apiUrl(path), { method, headers: authenticatedHeaders({ 'Content-Type': 'application/json' }), ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) })
  const payload = await response.json().catch(() => ({ success: false, error: `Request failed (HTTP ${response.status}).` }))
  if (!response.ok || !payload.success) throw new Error(payload.error || 'Request could not be completed.')
  return payload.data
}
export const aiSettingsApi = {
  get: () => request<AiSettings>('/ai-settings'),
  save: (settings: AiConfig, credentials: Record<string, string>) => request('/ai-settings', 'PUT', { ...settings, credentials }),
  check: (provider: string) => request(`/ai-settings/check/${provider}`, 'POST'),
  customModels: (customBaseUrl?: string, apiKey?: string) => request<{ reachable: boolean; models: string[] }>('/ai-settings/check/custom', 'POST', customBaseUrl === undefined ? undefined : { customBaseUrl, ...(apiKey === undefined ? {} : { apiKey }) }),
  models: () => request<string[]>('/ai-settings/ollama-models'),
  jobs: () => request<ProcessingJob[]>('/jobs'),
  cancel: (id: string) => request(`/jobs/${id}/cancel`, 'POST'),
  resume: (id: string) => request(`/jobs/${id}/resume`, 'POST'),
  /** Month-to-date estimated cloud spend (estimates only). */
  spending: () => request<MonthSpend>('/ai-settings/spending'),
  /** Cost estimate for transcribing recordings with optional per-job transcription overrides. */
  estimate: (recordingIds: string[], overrides?: Partial<AiConfig>) => request<CostEstimate>('/ai-settings/estimate', 'POST', { recordingIds, ...(overrides ? { overrides } : {}) }),
  ollamaContext: (model: string) => request<{ model: string; contextLength: number | null }>(`/ai-settings/ollama-context?model=${encodeURIComponent(model)}`),
}

/** Named context prompts and vocabularies for transcription (`/api/v1/transcription-profiles`). */
export const profilesApi = {
  list: () => request<{ profiles: TranscriptionProfile[]; presets: ProfilePreset[] }>('/v1/transcription-profiles'),
  create: (input: Partial<ProfileInput> | { preset: string; name?: string }) => request<TranscriptionProfile>('/v1/transcription-profiles', 'POST', input),
  update: (id: string, patch: Partial<ProfileInput>) => request<TranscriptionProfile>(`/v1/transcription-profiles/${id}`, 'PATCH', patch),
  remove: (id: string) => request(`/v1/transcription-profiles/${id}`, 'DELETE'),
}

/** First-run setup state; see `src/api/onboarding.ts`. */
export const onboardingApi = {
  status: () => request<OnboardingStatus>('/onboarding'),
  complete: (skipped = false) => request('/onboarding/complete', 'POST', { skipped }),
  reset: () => request('/onboarding/reset', 'POST', {}),
}
/** Fired to open the setup guide from anywhere (Settings, command palette). */
export const ONBOARDING_EVENT = 'openplod:onboarding'
