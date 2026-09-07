import { useEffect, useRef, useState } from 'react'
import { Check, Loader2, Plus, RefreshCw, Tag, X } from "@/components/icons"
import { NoteDialog } from './NoteDialogs'
import { Button } from './ui/button'
import { api, type Recording } from '@/lib/api'
import { addRecordingTags } from '@/lib/recording-tags'
import './recording-tags.css'

export function RecordingTagsDialog({ recording, onSaved, onClose }: {
  recording: Recording
  onSaved: (recording: Recording) => void
  onClose: () => void
}) {
  const [saved, setSaved] = useState<Recording | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let disposed = false
    api.getRecording(recording.id).then(row => {
      if (disposed) return
      setSaved(row); setTags(row.tags); setInput('')
    }).catch(failure => {
      if (!disposed) setError(failure instanceof Error ? failure.message : 'Could not load tags.')
    }).finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [recording.id, reload])
  useEffect(() => { if (!loading) inputRef.current?.focus() }, [loading])

  const pendingTags = addRecordingTags(tags, input)
  const changed = saved && JSON.stringify(pendingTags) !== JSON.stringify(saved.tags)
  const add = () => { setTags(pendingTags); setInput(''); inputRef.current?.focus() }
  return <NoteDialog title="Edit tags" description={recording.title} onClose={onClose} busy={busy}>
    <form onSubmit={async event => {
      event.preventDefault()
      if (!saved || !changed || loading || busy) return
      setBusy(true); setError('')
      try {
        const updated = await api.updateRecording(recording.id, { tags: pendingTags, revision: saved.revision })
        onSaved(updated); onClose()
      } catch (failure) {
        setError(failure instanceof Error && failure.message === 'revision_conflict'
          ? 'This recording changed elsewhere. Reload tags before saving again.'
          : failure instanceof Error ? failure.message : 'Could not save tags.')
      } finally { setBusy(false) }
    }}>
      {loading ? <p role="status" className="recording-tags-loading"><Loader2 className="animate-spin" />Loading tags...</p> : <>
        <ul className="recording-tag-list" aria-label="Recording tags">
          {tags.map(tag => <li key={tag}><Tag aria-hidden="true" /><span>{tag}</span><button type="button" disabled={busy} aria-label={`Remove tag ${tag}`} title={`Remove ${tag}`} onClick={() => setTags(current => current.filter(value => value !== tag))}><X /></button></li>)}
        </ul>
        <label htmlFor="recording-tag-input">Add a tag</label>
        <div className="recording-tag-input">
          <input ref={inputRef} id="recording-tag-input" value={input} disabled={busy || !saved} autoComplete="off" onChange={event => setInput(event.target.value)} onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && input.trim()) { event.preventDefault(); add() }
          }} />
          <Button type="button" variant="outline" size="icon" aria-label="Add tag" title="Add tag" disabled={busy || !saved || !input.trim()} onClick={add}><Plus /></Button>
        </div>
      </>}
      {error && <div className="recording-tags-error"><p role="alert" className="note-error">{error}</p><Button type="button" size="sm" variant="ghost" disabled={busy || loading} onClick={() => { setLoading(true); setError(''); setSaved(null); setReload(value => value + 1) }}><RefreshCw />Reload tags</Button></div>}
      <footer><Button type="button" variant="ghost" disabled={busy} onClick={onClose}><X />Cancel</Button><Button disabled={loading || busy || !changed}>{busy ? <Loader2 className="animate-spin" /> : <Check />}Save tags</Button></footer>
    </form>
  </NoteDialog>
}
