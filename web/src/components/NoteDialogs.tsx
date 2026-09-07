import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import * as Dialog from '@radix-ui/react-dialog'
import { Copy, Download, Loader2, NotebookPen, Send, Sparkles, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { folderPaths, generateDocument, notesApi, type DocumentGeneration, type NoteDocument, type NoteFolder, type NoteDestination, type NoteDelivery } from '@/lib/notes-api'
import { exportDocument, safeDocumentName } from '@/lib/document-export'
import './notes-dialog.css'

export function NoteDialog({ title, description, children, onClose, busy = false }: {title: string; description: string; children: ReactNode; onClose: () => void; busy?: boolean}) {
  const returnFocus = useRef(window.document.activeElement as HTMLElement | null)
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose() }}><Dialog.Portal>
    <Dialog.Overlay className="note-dialog-overlay" />
    <Dialog.Content className="note-dialog" onCloseAutoFocus={event => { event.preventDefault(); returnFocus.current?.focus() }} onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onInteractOutside={event => event.preventDefault()}>
      <header><div><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description></div>
        <Button size="icon" variant="ghost" disabled={busy} onClick={onClose} aria-label="Close dialog" title="Close"><X /></Button></header>
      {children}
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}

export function FolderSelect({ folders, value, onChange, rootLabel = 'Inbox', disabled = false, exclude }: {folders: NoteFolder[]; value: string; onChange: (value: string) => void; rootLabel?: string; disabled?: boolean; exclude?: string}) {
  return <select aria-label="Folder" value={value} onChange={event => onChange(event.target.value)} disabled={disabled}>
    <option value="">{rootLabel}</option>{folderPaths(folders).filter(row => row.folder.id !== exclude).map(row => <option key={row.folder.id} value={row.folder.id}>{row.path}</option>)}
  </select>
}

export function SaveTranscriptDialog({ recordingId, versionId, title, disabled }: {recordingId: string; versionId: string | null; title: string; disabled?: boolean}) {
  const [open, setOpen] = useState(false)
  return <><Button size="sm" title="Structure this transcript into a document with Mistral" disabled={disabled} onClick={() => setOpen(true)}><Sparkles />Create document</Button>
    {open && <SaveTranscriptForm recordingId={recordingId} versionId={versionId} title={title} onClose={() => setOpen(false)} />}</>
}

function SaveTranscriptForm({ recordingId, versionId, title, onClose }: {recordingId: string; versionId: string | null; title: string; onClose: () => void}) {
  const navigate = useNavigate()
  const [folders, setFolders] = useState<NoteFolder[]>([])
  const [folderId, setFolderId] = useState('')
  const [name, setName] = useState(title)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [style, setStyle] = useState<'notes' | 'meeting' | 'brief'>('notes')
  const [instructions, setInstructions] = useState('')
  const [generation, setGeneration] = useState<DocumentGeneration | null>(null)
  const [stage, setStage] = useState('')
  const generationController = useRef<AbortController | null>(null)
  useEffect(() => () => generationController.current?.abort(), [])
  useEffect(() => {
    const controller = new AbortController()
    notesApi.folders(controller.signal).then(setFolders).catch(error => { if (!controller.signal.aborted) setError(error.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [])
  return <NoteDialog title={generation ? 'Review document' : 'Create document with Mistral'} description={title} onClose={onClose} busy={busy}>
    <form onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('')
      try {
        if (generation) {
          const saved = await notesApi.saveGeneration(generation.id, folderId || null)
          onClose(); navigate(`/notes?document=${saved.id}`)
        } else {
          const controller = new AbortController(); generationController.current = controller
          setStage('transcript')
          setGeneration(await generateDocument({ recordingId, versionId, title: name, style, instructions, idempotencyKey: crypto.randomUUID() }, setStage, controller.signal))
          generationController.current = null
        }
      } catch (error) { setError(error instanceof Error && error.name === 'AbortError' ? 'Generation cancelled. Nothing was saved to Notes.' : error instanceof Error ? error.message : 'Could not create document.') }
      finally { setBusy(false) }
    }}><label>Title<input value={name} onChange={event => setName(event.target.value)} maxLength={180} required disabled={busy || !!generation} /></label>
      {!generation && <>
        <label>Document style<select value={style} onChange={event => setStyle(event.target.value as typeof style)} disabled={busy}><option value="notes">Structured notes</option><option value="meeting">Meeting minutes</option><option value="brief">Project brief</option></select></label>
        <label>Focus (optional)<textarea value={instructions} onChange={event => setInstructions(event.target.value)} maxLength={2000} rows={3} disabled={busy} /></label>
        <p className="note-ai-disclosure">The transcript will be sent to Mistral. Original audio and transcript stay unchanged.</p>
      </>}
      {busy && !generation && <p className="note-ai-progress" role="status"><Loader2 className="animate-spin" />{stage === 'transcript' ? 'Reading saved transcript...' : stage === 'ready' ? 'Preparing preview...' : 'Mistral is structuring your document...'}</p>}
      {generation && <>
        <details className="note-ai-trace"><summary>Generated by Mistral</summary><p>{generation.model}</p><ol>{generation.steps.map(step => <li key={step.stage}>{step.stage === 'transcript' ? 'Source transcript retrieved' : step.stage === 'mistral' ? 'Mistral generation requested' : 'Structured document received'}</li>)}</ol><small>Generation {generation.id}</small></details>
        <div className="note-ai-preview markdown-document"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: () => null, a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> }}>{generation.content}</ReactMarkdown></div>
      </>}
      <label>Folder<FolderSelect folders={folders} value={folderId} onChange={setFolderId} disabled={loading || busy} /></label>
      {error && <p role="alert" className="note-error">{error}</p>}
      <footer>{busy && !generation ? <Button type="button" variant="outline" onClick={() => generationController.current?.abort()}>Cancel generation</Button> : <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>}
        {generation && <Button type="button" variant="outline" disabled={busy} onClick={() => { setGeneration(null); setError('') }}>Start again</Button>}
        <Button disabled={loading || busy || !name.trim()}>{busy ? <Loader2 className="animate-spin" /> : generation ? <NotebookPen /> : <Sparkles />}{generation ? 'Save document' : 'Generate with Mistral'}</Button></footer>
    </form>
  </NoteDialog>
}

export function SendNoteDialog({ document, onClose }: {document: NoteDocument; onClose: () => void}) {
  const [destinations, setDestinations] = useState<NoteDestination[]>([])
  const [history, setHistory] = useState<NoteDelivery[]>([])
  const [destinationId, setDestinationId] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState<NoteDelivery | null>(null)
  const [key] = useState(() => crypto.randomUUID())
  useEffect(() => {
    let cancelled = false
    Promise.all([notesApi.destinations(), notesApi.deliveries(document.id)]).then(([destinations, history]) => {
      if (!cancelled) { setDestinations(destinations); setHistory(history); setDestinationId(destinations[0]?.id || '') }
    }).catch(error => { if (!cancelled) setError(error.message) }).finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [document.id])
  const destination = destinations.find(row => row.id === destinationId)
  return <NoteDialog title="Send document" description={`${document.title} / Saved revision ${document.revision}`} busy={busy} onClose={onClose}>
    <div className="note-send-local"><Button variant="outline" size="sm" disabled={busy} onClick={() => void exportDocument({ filename: `${safeDocumentName(document.title)}.md`, content: document.content, mime: 'text/markdown' }).catch(error => setError(error instanceof Error ? error.message : 'Export failed.'))}><Download />Markdown file</Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => {
        if (!navigator.clipboard) { setError('Clipboard unavailable. Export the Markdown file instead.'); return }
        void navigator.clipboard.writeText(document.content).then(() => setError('')).catch(() => setError('Clipboard unavailable. Export the Markdown file instead.'))
      }}><Copy />Copy Markdown</Button></div>
    <form onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('')
      try { const delivery = await notesApi.send(document.id, destinationId, document.revision, key); setSent(delivery); setHistory(await notesApi.deliveries(document.id)) }
      catch (error) { setError(error instanceof Error ? error.message : 'Delivery could not be confirmed. Retry only to check this delivery.') }
      finally { setBusy(false) }
    }}>
      <label>Destination<select value={destinationId} disabled={busy || !!sent} onChange={event => setDestinationId(event.target.value)}>
        <option value="" disabled>{loaded ? 'No destination selected' : 'Loading destinations...'}</option>
        {destinations.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
      </select></label>
      {destination && <p className="note-send-warning">The saved Markdown and source references will be sent to <strong>{destination.host}</strong>.</p>}
      {loaded && !error && !destinations.length && <p>No destinations configured.</p>}
      {error && <p role="alert" className="note-error">{error}</p>}
      {sent && <p role="status">{sent.state === 'sent' ? 'Destination accepted the document.' : 'Delivery unconfirmed. Check the destination before starting another delivery.'}</p>}
      {history.length > 0 && <section className="note-delivery-history"><h3>Recent deliveries</h3>{history.slice(0, 5).map(row => <div key={row.id}><span>{destinations.find(item => item.id === row.destinationId)?.name || row.destinationId}</span><span>{row.state === 'sent' ? 'Accepted' : row.state === 'pending' ? 'Pending' : 'Unconfirmed'}</span><small>{new Date(row.createdAt).toLocaleString()}</small></div>)}</section>}
      <footer><Button type="button" variant="outline" disabled={busy} onClick={onClose}>Close</Button><Button disabled={busy || !destinationId || !!sent}>{busy ? <Loader2 className="animate-spin" /> : <Send />}Send document</Button></footer>
    </form>
  </NoteDialog>
}
