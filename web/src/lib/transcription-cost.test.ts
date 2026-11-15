import { expect, test } from 'bun:test'
import { configOf, customEndpointIsLocal, describeEstimate, formatUsd, languagesFor } from './transcription'
import type { AiSettings } from './ai-settings'

const capabilities = {
  custom: { models: [], languages: {} },
  mistral: { models: ['voxtral-mini-latest'], languages: { 'voxtral-mini-latest': ['en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'hi'] } },
  deepgram: { models: ['nova-2', 'nova-3'], languages: { 'nova-2': null, 'nova-3': null } },
} as unknown as AiSettings['capabilities']

test('language picker narrows to documented languages and keeps everything when the list is unknown', () => {
  const mistral = languagesFor({ capabilities }, 'mistral').map(([code]) => code)
  expect(mistral).toContain('auto'); expect(mistral).toContain('fr'); expect(mistral).not.toContain('ja')
  expect(languagesFor({ capabilities }, 'deepgram', 'nova-3').map(([code]) => code)).toContain('ja')
})

test('estimates are always labelled, and unknown costs stay unknown', () => {
  expect(formatUsd(null)).toBe('unknown'); expect(formatUsd(0.0025)).toBe('$0.0025'); expect(formatUsd(1.5)).toBe('$1.50')
  expect(describeEstimate({ totalUsd: 0.06, unknownCount: 0, local: false, pricesAsOf: '2025-08-01' })).toContain('Not a bill')
  expect(describeEstimate({ totalUsd: null, unknownCount: 2, local: false, pricesAsOf: '2025-08-01' })).toContain('unknown for 2 recordings')
  expect(describeEstimate({ totalUsd: 0, unknownCount: 0, local: true, pricesAsOf: '2025-08-01' })).toContain('this computer')
})

test('saving strips every read-only settings field, and only loopback endpoints count as local', () => {
  const settings = { privacyMode: 'local-only', credentials: {}, capabilities: {}, textCapabilities: {}, pricing: {} } as unknown as AiSettings
  expect(Object.keys(configOf(settings))).toEqual(['privacyMode'])
  expect(customEndpointIsLocal('http://127.0.0.1:8080/v1')).toBe(true)
  expect(customEndpointIsLocal('https://llm.example.com/v1')).toBe(false)
  expect(customEndpointIsLocal('not a url')).toBe(false)
})


test('custom model names matching object properties do not break the language picker', () => {
  const expected = languagesFor({ capabilities }, 'custom', 'other-model')
  for (const model of ['constructor', 'toString', '__proto__']) {
    expect(languagesFor({ capabilities }, 'custom', model)).toEqual(expected)
  }
})
