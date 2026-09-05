import { invoke } from '@tauri-apps/api/core'
import { getRuntime } from './runtime'
import type { Recording } from './api'

export function recordingMarkdown(recording: Recording, text: string, version?: { versionId: string | null; origin: string | null }): string {
  const metadata = [
    `- Recorded: ${recording.recordedAt}`,
    `- Source: ${recording.sourceProvider === 'plaud' ? 'Plaud Note Pro' : recording.sourceProvider || 'Audio import'}`,
    `- Recording ID: ${recording.id}`,
    ...(version?.origin ? [`- Transcript origin: ${version.origin}`] : []),
    ...(version?.versionId ? [`- Transcript version: ${version.versionId}`] : []),
    ...(recording.context ? [`- Context: ${recording.context}`] : []),
    ...(recording.tags.length ? [`- Tags: ${recording.tags.join(', ')}`] : []),
  ].join('\n')
  return [`# ${recording.title}`, metadata, '## Transcript', text,
    ...(recording.summary ? ['## Summary', recording.summary] : []),
    ...(recording.notes ? ['## Notes', recording.notes] : []),
  ].join('\n\n') + '\n'
}

export async function exportDocument(options: { filename: string; content: string; mime: string }): Promise<void> {
  if (getRuntime().mode === 'desktop') {
    await invoke('export_document', { filename: options.filename, content: options.content })
    return
  }
  if (getRuntime().mode === 'mobile' && /Android/i.test(navigator.userAgent)) {
    await invoke('plaud_command', { action: 'exportDocument', args: options })
    return
  }
  const url = URL.createObjectURL(new Blob([options.content], { type: `${options.mime};charset=utf-8` }))
  const link = document.createElement('a')
  link.href = url; link.download = options.filename
  document.body.append(link); link.click(); link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function exportOriginalAudio(recording: Recording, audioUrl: string): Promise<void> {
  if (getRuntime().mode === 'desktop') {
    await invoke('export_audio', { recordingId: recording.id, filename: recording.filename || 'recording.wav' })
    return
  }
  const link = document.createElement('a')
  link.href = audioUrl
  link.download = recording.filename || `${safeDocumentName(recording.title)}.webm`
  document.body.append(link); link.click(); link.remove()
}

export function safeDocumentName(value: string): string {
  return value.replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '-').slice(0, 90) || 'recording'
}
