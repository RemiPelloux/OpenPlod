import { useEffect, useState } from 'react'
import { api } from './api'
import { getRuntime } from './runtime'

/**
 * Plaud recorder models, resolved from the serial prefix the same way the backend
 * does (`deviceTypeForSerial`). Every screen names and pictures the recorder from
 * here, so a Plaud Note and a Plaud Note Pro are each shown as what they are.
 */
const NAMES: Record<string, string> = {
  note: 'Plaud Note',
  notepro: 'Plaud Note Pro',
  notepin: 'Plaud NotePin',
  notepins: 'Plaud NotePin S',
  plaudone: 'Plaud One',
}

const PREFIXES: Record<string, string> = {
  '860': 'plaudone', '880': 'notepin', '881': 'notepro', '882': 'notepins', '883': 'notepro', '888': 'note',
}

const IMAGES: Record<string, string> = {
  note: '/plaud-note.png',
  notepro: '/plaud-note-pro.png',
}

export function plaudModelName(type?: string | null): string | null {
  if (!type) return null
  return NAMES[type.toLowerCase()] ?? null
}

/** Model type (`note`, `notepro`, …) from a recorder serial, or null when unknown. */
export function plaudModelFromSerial(serial?: string | null): string | null {
  if (!serial || !/^[0-9A-Fa-f]{16,18}$/.test(serial)) return null
  return PREFIXES[serial.slice(0, 3)] ?? null
}

/** Model type from a vault provenance id such as `888000000000000101:1700000000`. */
export function plaudModelFromSourceId(sourceRecordingId?: string | null): string | null {
  return plaudModelFromSerial(sourceRecordingId?.split(':')[0])
}

/** Product picture for a model; the Note Pro image is the neutral default. */
export function plaudModelImage(type?: string | null): string {
  return (type && IMAGES[type.toLowerCase()]) || '/plaud-note-pro.png'
}

/** True when the recorder reports a serial that is shorter than its registry serial. */
export function needsManualSerial(model: string | null, serial?: string | null): boolean {
  return model === 'note' && (!serial || serial.length < 18)
}

/**
 * The model of this computer's recorder: the one detected nearby when a scan has
 * identified it, otherwise the one this computer is authorized for.
 */
export function usePlaudModel(detected?: string | null, refreshKey?: unknown): string | null {
  const [authorized, setAuthorized] = useState<string | null>(null)
  useEffect(() => {
    if (getRuntime().mode === 'mobile') return
    const controller = new AbortController()
    api.getPlaudIdentity(controller.signal)
      .then(identity => setAuthorized(identity.authorized ? identity.deviceType ?? plaudModelFromSerial(identity.serial) : null))
      .catch(() => {})
    return () => controller.abort()
  }, [refreshKey])
  return detected ?? authorized
}
