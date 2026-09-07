import { expect, test } from 'bun:test'
import { loadWaveform } from './audio-loader'

function player(load: (blob: Blob) => Promise<void>) {
  let error: (() => void) | undefined
  let unsubscribed = false
  return {
    loadBlob: load,
    on: (() => { throw new Error('unexpected subscription') }) as Parameters<typeof loadWaveform>[0]['on'],
    initialize() {
      this.on = ((_event: string, callback: () => void) => { error = callback; return () => { unsubscribed = true } }) as typeof this.on
      return this
    },
    fail: () => error?.(),
    cleaned: () => unsubscribed,
  }.initialize()
}

test('waveform receives the original blob without refetching an object URL', async () => {
  const blob = new Blob(['audio'], { type: 'audio/mp4' })
  let received: Blob | undefined
  const media = player(async bytes => { received = bytes })
  await loadWaveform(media, blob, new AbortController().signal)
  expect(received).toBe(blob)
  expect(media.cleaned()).toBe(true)
})

test('missing metadata times out instead of leaving the play button spinning', async () => {
  const media = player(() => new Promise(() => {}))
  await expect(loadWaveform(media, new Blob(), new AbortController().signal, 5)).rejects.toThrow('too long')
  expect(media.cleaned()).toBe(true)
})

test('decode error and cancellation settle a stuck load and remove listeners', async () => {
  const media = player(() => new Promise(() => {}))
  const pending = loadWaveform(media, new Blob(), new AbortController().signal)
  media.fail()
  await expect(pending).rejects.toThrow('could not be decoded')
  expect(media.cleaned()).toBe(true)
  const controller = new AbortController()
  const cancelled = loadWaveform(player(() => new Promise(() => {})), new Blob(), controller.signal)
  controller.abort()
  await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
})

test('an already cancelled load does not start decoding', async () => {
  const controller = new AbortController(); controller.abort()
  let called = false
  await expect(loadWaveform(player(async () => { called = true }), new Blob(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(called).toBe(false)
})
