import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Pencil, Save, X } from "@/components/icons"
import { Button } from './ui/button'
import { api, type Recording, type TranscriptSegment } from '@/lib/api'
export function SegmentEditor({ recording, segment, onSaved }: { recording: Recording; segment: TranscriptSegment; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false), [text, setText] = useState(segment.text), [speaker, setSpeaker] = useState(segment.speaker)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const save = async () => {
    setBusy(true); setError('')
    try {
      const segments = (recording.segments || []).map(s => ({ start: s.startTime, end: s.endTime, text: s.id === segment.id ? text : s.text, speaker: s.speaker === segment.speaker ? speaker : s.speaker }))
      await api.updateTranscript(recording.id, segments.map(s => s.text).join('\n\n'), recording.revision, segments)
      await onSaved(); setOpen(false)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <Dialog.Root open={open} onOpenChange={value => { if (!busy) { setOpen(value); setText(segment.text); setSpeaker(segment.speaker); setError('') } }}><Dialog.Trigger asChild><Button size="icon" variant="ghost" title="Correct transcript segment" aria-label="Correct transcript segment"><Pencil className="size-3" /></Button></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="plaud-import-overlay" /><Dialog.Content className="plaud-import-dialog p-6" onEscapeKeyDown={e => { if (busy) e.preventDefault() }} onInteractOutside={e => { if (busy) e.preventDefault() }}>
    <div className="flex items-center justify-between mb-4"><Dialog.Title className="font-semibold">Correct transcript</Dialog.Title><Dialog.Close asChild><Button size="icon" variant="ghost" disabled={busy} aria-label="Close correction"><X /></Button></Dialog.Close></div>
    <Dialog.Description className="text-xs text-muted-foreground mb-4">Creates an edited version and preserves timestamps. Speaker changes apply to all segments with this label.</Dialog.Description>
    <label className="text-sm">Speaker<input className="block border rounded p-2 w-full mt-1 mb-4" value={speaker} maxLength={80} onChange={e => setSpeaker(e.target.value)} /></label>
    <label className="text-sm">Transcript<textarea className="block border rounded p-2 w-full mt-1 mb-4" rows={6} maxLength={50000} value={text} onChange={e => setText(e.target.value)} /></label>
    {error && <p role="alert" className="device-error">{error}</p>}<Button disabled={busy || !text.trim() || !speaker.trim()} onClick={() => void save()}><Save />Save version</Button>
  </Dialog.Content></Dialog.Portal></Dialog.Root>
}
