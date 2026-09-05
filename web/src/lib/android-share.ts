import type { PendingCapture } from '@/lib/recording-outbox'

interface SharedAudioMetadata {
  id: string
  filename: string
  mimeType: string
  size: number
  durationMs: number
  sourcePackage: string
}

interface OpenPlodShareBridge {
  metadata(): string
  readChunk(id: string, offset: number, length: number): string
  complete(id: string): boolean
}

declare global {
  interface Window {
    OpenPlodShare?: OpenPlodShareBridge
  }
}

const CHUNK_SIZE = 256 * 1024

export function hasPendingAndroidShare(): boolean {
  return Boolean(readMetadata())
}

export async function readPendingAndroidShare(): Promise<PendingCapture | null> {
  const bridge = window.OpenPlodShare
  const metadata = readMetadata()
  if (!bridge || !metadata) return null

  const chunks: BlobPart[] = []
  for (let offset = 0; offset < metadata.size; offset += CHUNK_SIZE) {
    const encoded = bridge.readChunk(metadata.id, offset, Math.min(CHUNK_SIZE, metadata.size - offset))
    if (!encoded) throw new Error('Android stopped sharing the recording before it was copied.')
    chunks.push(decodeBase64(encoded))
    await new Promise<void>(resolve => window.setTimeout(resolve, 0))
  }

  const filename = cleanFilename(metadata.filename)
  const title = filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ') || 'Plaud recording'
  const fromPlaud = metadata.sourcePackage.toLocaleLowerCase().includes('plaud')
  return {
    id: crypto.randomUUID(),
    blob: new Blob(chunks, { type: metadata.mimeType || 'audio/mp4' }),
    filename,
    title,
    context: fromPlaud ? 'Imported from Plaud' : 'Imported from Android share',
    recordedAt: new Date().toISOString(),
    durationMs: metadata.durationMs,
    sourceProvider: fromPlaud ? 'plaud' : 'upload',
    sourceTransport: 'mobile',
    nativeShareId: metadata.id,
  }
}

export function completePendingAndroidShare(id: string): boolean {
  return window.OpenPlodShare?.complete(id) ?? false
}

function readMetadata(): SharedAudioMetadata | null {
  const raw = window.OpenPlodShare?.metadata()
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<SharedAudioMetadata>
    if (!value.id || !value.filename || !Number.isFinite(value.size) || Number(value.size) <= 0) return null
    return {
      id: value.id,
      filename: value.filename,
      mimeType: value.mimeType || 'audio/mp4',
      size: Number(value.size),
      durationMs: Number(value.durationMs) || 0,
      sourcePackage: value.sourcePackage || 'android-share',
    }
  } catch {
    return null
  }
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = window.atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function cleanFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 160) || 'plaud-recording.m4a'
}
