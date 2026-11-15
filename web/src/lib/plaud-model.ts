/**
 * Display names for the recorder types the backend resolves from the serial prefix.
 *
 * The authorization flow is shared by every model, but the copy used to name the
 * Note Pro explicitly. Recorders differ in wording as well as protocol: a Plaud
 * Note only accepts an 18-character serial, which the user copies from the Plaud
 * app, while a Note Pro is detected from its own advertisement.
 */
const NAMES: Record<string, string> = {
  note: 'Plaud Note',
  notepro: 'Plaud Note Pro',
  notepin: 'Plaud NotePin',
  notepins: 'Plaud NotePin S',
  plaudone: 'Plaud One',
}

export function plaudModelName(type?: string | null): string | null {
  if (!type) return null
  return NAMES[type.toLowerCase()] ?? null
}

/** True when the recorder reports a serial that is shorter than its registry serial. */
export function needsManualSerial(model: string | null, serial?: string | null): boolean {
  return model === 'note' && (!serial || serial.length < 18)
}
