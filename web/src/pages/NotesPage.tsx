import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ArrowLeft, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Download, FilePlus2, FileText, Folder, FolderPlus, History, Inbox, Loader2, MoreHorizontal, NotebookPen, Pencil, RefreshCw, RotateCcw, Save, Search, Send, Sparkles, Star, Trash2, Upload, X } from "@/components/icons"
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { DocumentCanvas } from '@/components/DocumentCanvas'
import { FolderSelect, NoteDialog, SendNoteDialog } from '@/components/NoteDialogs'
import { notesApi, folderPaths, type NoteFolder, type NoteDocument, type NotePage, type NoteVersion } from '@/lib/notes-api'
import { exportDocument, safeDocumentName } from '@/lib/document-export'
import './notes.css'

const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'This operation could not be completed.'
const shortDate = (date: string) => new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
const emptyPage: NotePage = { documents: [], total: 0, limit: 30, offset: 0 }
const draftKey = (id: string) => `openplod.note-draft.v1.${id}`
function clearDraft(id: string) { try { sessionStorage.removeItem(draftKey(id)) } catch { /* Browser storage may be disabled. */ } }

export function NotesPage() {
  const [params, setParams] = useSearchParams()
  const selectedId = params.get('document') || ''
  const [folders, setFolders] = useState<NoteFolder[]>([])
  const [view, setView] = useState('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('updated')
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<NotePage>(emptyPage)
  const [document, setDocument] = useState<NoteDocument | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [folderDraft, setFolderDraft] = useState('')
  const [mode, setMode] = useState<'edit' | 'preview'>('preview')
  const [loading, setLoading] = useState(true)
  const [documentLoading, setDocumentLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [folderDialog, setFolderDialog] = useState<'new' | NoteFolder | null>(null)
  const [sendOpen, setSendOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const importRef = useRef<HTMLInputElement>(null)
  const dirty = !!document && (title !== document.title || content !== document.content || folderDraft !== (document.folderId || ''))
  const selectedFolder = folders.find(folder => folder.id === view)
  const targetFolder = selectedFolder?.id || null
  const viewName = selectedFolder?.name || ({ all: 'All notes', inbox: 'Inbox', starred: 'Starred', trash: 'Trash' }[view] ?? 'Notes')

  const applyDocument = useCallback((document: NoteDocument) => {
    clearDraft(document.id)
    setDocument(document); setTitle(document.title); setContent(document.content); setFolderDraft(document.folderId || '')
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    notesApi.folders(controller.signal).then(setFolders).catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)) })
    return () => controller.abort()
  }, [refresh])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    const timer = window.setTimeout(() => {
      const request: Record<string, string> = { q: query, sort, offset: String(offset), view: view === 'starred' || view === 'trash' ? view : 'all' }
      if (view !== 'all' && view !== 'starred' && view !== 'trash') request.folderId = view
      notesApi.list(request, controller.signal).then(result => { if (!controller.signal.aborted) setPage(result) })
        .catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)) })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, query ? 200 : 0)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [view, query, sort, offset, refresh])
  useEffect(() => {
    if (!selectedId) { setDocument(null); setDocumentLoading(false); return }
    const controller = new AbortController()
    setDocumentLoading(true); setError('')
    notesApi.get(selectedId, controller.signal).then(result => {
      if (controller.signal.aborted) return
      let draft: {title: string; content: string; folderId: string; revision: number} | null = null
      try {
        const saved = JSON.parse(sessionStorage.getItem(draftKey(result.id)) || 'null')
        if (saved && typeof saved.title === 'string' && typeof saved.content === 'string' && typeof saved.folderId === 'string' && Number.isSafeInteger(saved.revision) && saved.revision > 0) draft = saved
      } catch { /* Invalid or unavailable cached drafts do not prevent loading saved notes. */ }
      applyDocument(result)
      if (draft && !result.deletedAt && (draft.title !== result.title || draft.content !== result.content || draft.folderId !== (result.folderId || ''))) {
        setDocument({ ...result, revision: draft.revision }); setTitle(draft.title); setContent(draft.content); setFolderDraft(draft.folderId); setMode('edit')
        setNotice(draft.revision === result.revision ? 'Unsaved draft recovered' : 'Draft recovered from an older revision. Reload the saved note before resolving the conflict.')
      }
    })
      .catch(error => { if (!controller.signal.aborted) { setDocument(null); setError(errorMessage(error)) } })
      .finally(() => { if (!controller.signal.aborted) setDocumentLoading(false) })
    return () => controller.abort()
  }, [selectedId, applyDocument])
  useEffect(() => {
    if (!document || document.id !== selectedId) return
    if (!dirty || document.deletedAt) { clearDraft(document.id); return }
    try { sessionStorage.setItem(draftKey(document.id), JSON.stringify({ title, content, folderId: folderDraft, revision: document.revision })) }
    catch { /* The unload guard still protects drafts when session storage is full. */ }
  }, [document, selectedId, dirty, title, content, folderDraft])
  useEffect(() => {
    if (!dirty) return
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    const navigate = (event: MouseEvent) => {
      const link = (event.target as Element)?.closest('a[href]')
      if (!link || link.getAttribute('target') === '_blank' || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (!window.confirm('Leave without saving your note changes?')) { event.preventDefault(); event.stopPropagation() }
      else if (document) clearDraft(document.id)
    }
    window.addEventListener('beforeunload', unload)
    window.document.addEventListener('click', navigate, true)
    return () => { window.removeEventListener('beforeunload', unload); window.document.removeEventListener('click', navigate, true) }
  }, [dirty, document])

  const canLeave = () => {
    if (!dirty) return true
    if (!window.confirm('Discard the unsaved changes to this note?')) return false
    if (document) clearDraft(document.id)
    return true
  }
  const selectDocument = (id: string) => {
    if (busy || !canLeave()) return
    setNotice(''); setError(''); setParams(id ? { document: id } : {}); setMode('preview')
  }
  const selectView = (next: string) => {
    if (busy || !canLeave()) return
    setView(next); setOffset(0); setParams({}); setError(''); setNotice(''); setSidebarOpen(false)
  }
  const mutate = async (operation: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await operation(); setRefresh(value => value + 1) }
    catch (error) { setError(errorMessage(error)) }
    finally { setBusy(false) }
  }
  const createNote = () => {
    if (!canLeave()) return
    void mutate(async () => {
      const note = await notesApi.create({ title: 'Untitled note', content: '', folderId: targetFolder, idempotencyKey: crypto.randomUUID() })
      setParams({ document: note.id }); applyDocument(note); setMode('edit')
    })
  }
  const save = () => {
    if (!document || busy || !dirty || !title.trim() || document.deletedAt) return
    void mutate(async () => {
      applyDocument(await notesApi.update(document.id, { title, content, folderId: folderDraft || null, revision: document.revision }))
      setNotice('Note saved')
    })
  }
  const exportNote = (format: 'md' | 'json') => {
    if (!document) return
    void exportDocument({ filename: `${safeDocumentName(document.title)}.${format}`, content: format === 'md' ? document.content : JSON.stringify(document, null, 2), mime: format === 'md' ? 'text/markdown' : 'application/json' })
      .catch(error => setError(errorMessage(error)))
  }
  const importFiles = async (files: File[]) => {
    if (!files.length || !canLeave()) return
    if (files.length > 20) { setError('Import up to 20 Markdown files at once.'); return }
    await mutate(async () => {
      let imported = 0
      for (const file of files) {
        try {
          if (!/\.(md|markdown)$/i.test(file.name) || file.size > 524288) throw new Error('Choose a Markdown file up to 512 KB.')
          const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
          await notesApi.create({ title: file.name.replace(/\.(md|markdown)$/i, ''), content: text, folderId: targetFolder, idempotencyKey: crypto.randomUUID() }); imported++
        } catch (error) {
          setRefresh(value => value + 1)
          throw new Error(`${imported} imported. ${file.name}: ${errorMessage(error)}`)
        }
      }
      setNotice(`${imported} Markdown file${imported === 1 ? '' : 's'} imported`)
    })
  }

  return <div className="notes-workspace" data-document={!!selectedId}>
    <input type="file" ref={importRef} multiple accept=".md,.markdown,text/markdown" className="sr-only" onChange={event => { const files = [...(event.target.files || [])]; event.target.value = ''; void importFiles(files) }} />
    {error && <div className="notes-message note-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Dismiss error"><X /></button></div>}
    {notice && <div className="notes-message" role="status"><Check /><span>{notice}</span></div>}
    <div className="notes-columns">
      <header className="notes-heading"><div><h1>Documents</h1></div><div>
        <IconButton asChild label="Open transcripts"><Link to="/transcripts"><FileText /></Link></IconButton>
        <IconButton label="Import Markdown" disabled={busy} onClick={() => importRef.current?.click()}><Upload /></IconButton>
        <Button size="sm" disabled={busy} onClick={createNote}><FilePlus2 />New note</Button>
      </div></header>
      <aside className={`notes-folders ${sidebarOpen ? 'is-open' : ''}`} aria-label="Note folders">
        <div className="notes-folders-title"><span>Workspace</span><Button size="icon" variant="ghost" title="New folder" aria-label="New folder" disabled={busy} onClick={() => setFolderDialog('new')}><FolderPlus /></Button></div>
        {([{ id: 'all', name: 'All notes', icon: NotebookPen }, { id: 'inbox', name: 'Inbox', icon: Inbox }, { id: 'starred', name: 'Starred', icon: Star }] as const).map(({ id, name, icon: Icon }) =>
          <button type="button" key={id} className={view === id ? 'selected' : ''} aria-current={view === id ? 'page' : undefined} onClick={() => selectView(id)}><Icon /><span>{name}</span></button>)}
        <div className="notes-folder-tree">{folderPaths(folders).map(({ folder, depth, path }) => <button type="button" key={folder.id} title={path} style={{ paddingLeft: `${10 + Math.min(depth, 6) * 12}px` }} className={view === folder.id ? 'selected' : ''} aria-current={view === folder.id ? 'page' : undefined} onClick={() => selectView(folder.id)}><Folder /><span>{folder.name}</span><small>{folder.documentCount}</small></button>)}</div>
        <button type="button" className={view === 'trash' ? 'selected' : ''} aria-current={view === 'trash' ? 'page' : undefined} onClick={() => selectView('trash')}><Trash2 /><span>Trash</span></button>
      </aside>
      <section className="notes-list" aria-label="Documents">
        <header><button className="notes-folder-toggle" type="button" aria-label="Toggle folders" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(value => !value)}><Folder /></button><h2>{viewName}</h2><span>{page.total}</span>
          {selectedFolder ? <DropdownMenu.Root><DropdownMenu.Trigger asChild><Button size="icon" variant="ghost" aria-label="Folder actions" title="Folder actions"><MoreHorizontal /></Button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="action-menu" align="end">
            <DropdownMenu.Item onSelect={() => setFolderDialog(selectedFolder)}><Pencil />Edit folder</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => { if (window.confirm('Delete this empty folder? Documents and subfolders must be moved first.')) void mutate(async () => { await notesApi.deleteFolder(selectedFolder.id, selectedFolder.revision); selectView('all') }) }}><Trash2 />Delete empty folder</DropdownMenu.Item>
          </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root> : <Button size="icon" variant="ghost" title="Refresh notes" aria-label="Refresh notes" onClick={() => setRefresh(value => value + 1)}><RefreshCw /></Button>}
        </header>
        <label className="notes-search"><Search /><input aria-label="Search notes" value={query} placeholder="Search notes" maxLength={200} onChange={event => { setQuery(event.target.value); setOffset(0) }} /></label>
        <select className="notes-sort" aria-label="Sort notes" value={sort} onChange={event => { setSort(event.target.value); setOffset(0) }}><option value="updated">Last edited</option><option value="title">Title A to Z</option></select>
        <div className="notes-list-items" aria-busy={loading}>
          {loading ? <div className="notes-empty" role="status"><Loader2 className="animate-spin" />Loading notes</div> : page.documents.map(note => <button type="button" key={note.id} className={`notes-list-item ${selectedId === note.id ? 'selected' : ''}`} onClick={() => selectDocument(note.id)}>
            <FileText className="notes-list-file" /><div className="notes-list-copy"><div><strong>{note.title}</strong>{note.starred && <Star className="note-star" />}</div><p>{note.excerpt || 'Empty note'}</p><small>{shortDate(note.updatedAt)}<span>{note.sourceRecordingId ? 'Transcript' : 'Markdown'}</span></small></div>
          </button>)}
          {!loading && page.documents.length === 0 && <div className="notes-empty"><FileText /><p>{view === 'trash' ? 'Trash is empty' : query ? 'No matching notes' : 'No notes here yet'}</p>{view !== 'trash' && !query && <Button size="sm" variant="outline" onClick={createNote}><FilePlus2 />New note</Button>}</div>}
        </div>
        {page.total > page.limit && <footer className="notes-pagination"><Button size="icon" variant="ghost" aria-label="Previous page" title="Previous page" disabled={offset === 0 || loading} onClick={() => setOffset(value => Math.max(0, value - page.limit))}><ChevronLeft /></Button><span>{Math.floor(offset / page.limit) + 1} / {Math.ceil(page.total / page.limit)}</span><Button size="icon" variant="ghost" aria-label="Next page" title="Next page" disabled={offset + page.limit >= page.total || loading} onClick={() => setOffset(value => value + page.limit)}><ChevronRight /></Button></footer>}
      </section>
      <section className="notes-editor" aria-label="Note editor">
        {documentLoading ? <div className="notes-empty" role="status"><Loader2 className="animate-spin" />Opening note</div> : document && document.id === selectedId ? <>
          <header className="notes-document-heading">
            <IconButton className="notes-back" label="Back to notes" onClick={() => selectDocument('')}><ArrowLeft /></IconButton>
            <div className="notes-document-identity"><div><input className="notes-title-input" aria-label="Note title" value={title} maxLength={180} disabled={busy || !!document.deletedAt} onChange={event => setTitle(event.target.value)} />
              <IconButton label={document.starred ? 'Unstar note' : 'Star note'} disabled={busy || dirty || !!document.deletedAt} onClick={() => void mutate(async () => applyDocument(await notesApi.update(document.id, { starred: !document.starred, revision: document.revision })))}><Star className={document.starred ? 'note-star' : ''} /></IconButton></div>
              <div className="notes-document-meta"><time dateTime={document.updatedAt}>Edited {shortDate(document.updatedAt)}</time><span>Revision {document.revision}</span>{document.sourceOrigin?.startsWith('ai:mistral:') && <span>Mistral</span>}</div>
            </div>
            <div className="notes-document-commands">
              <span className="notes-save-state" data-dirty={dirty} role="status">{busy ? <Loader2 className="animate-spin" /> : dirty ? <Pencil /> : <Check />}{busy ? 'Saving...' : dirty ? 'Unsaved' : 'Saved'}</span>
              <IconButton label="Save note" variant={dirty ? 'default' : 'ghost'} disabled={busy || !dirty || !!document.deletedAt || !title.trim()} onClick={save}><Save /></IconButton>
              <IconButton label="Send note" disabled={dirty || busy || !!document.deletedAt} onClick={() => setSendOpen(true)}><Send /></IconButton>
              <DropdownMenu.Root><DropdownMenu.Trigger asChild><Button size="sm" variant="outline" aria-label="Export note" disabled={dirty || busy}><Download /><span>Export</span><ChevronDown /></Button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="action-menu" align="end"><DropdownMenu.Item onSelect={() => exportNote('md')}><FileText />Markdown file</DropdownMenu.Item><DropdownMenu.Item onSelect={() => exportNote('json')}><FileText />JSON with metadata</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
              {document.sourceRecordingId && <Button asChild size="sm" className="notes-ask-ai"><Link to={`/ai?recording=${document.sourceRecordingId}`}><Sparkles /><span>Ask AI</span></Link></Button>}
              <DropdownMenu.Root><DropdownMenu.Trigger asChild><IconButton label="Document actions"><MoreHorizontal /></IconButton></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="action-menu" align="end">
                <DropdownMenu.Item disabled={busy} onSelect={() => { if (canLeave()) void mutate(async () => applyDocument(await notesApi.get(document.id))) }}><RefreshCw />Reload saved note</DropdownMenu.Item>
                <DropdownMenu.Item disabled={dirty || busy} onSelect={() => {
                  if (!navigator.clipboard) { setError('Clipboard unavailable. Export the Markdown file instead.'); return }
                  void navigator.clipboard.writeText(document.content).then(() => setNotice('Markdown copied')).catch(() => setError('Clipboard unavailable. Export the Markdown file instead.'))
                }}><Copy />Copy Markdown</DropdownMenu.Item>
                <DropdownMenu.Item disabled={dirty || busy} onSelect={() => setHistoryOpen(true)}><History />Note history</DropdownMenu.Item>
                {document.sourceRecordingId && <DropdownMenu.Item asChild><Link to={`/transcripts/${document.sourceRecordingId}`}><FileText />Source transcript</Link></DropdownMenu.Item>}
                {!document.deletedAt && <><DropdownMenu.Separator /><DropdownMenu.Item className="destructive" disabled={dirty || busy} onSelect={() => { if (window.confirm('Move this note to Trash for 30 days? Source recordings are kept.')) void mutate(async () => applyDocument(await notesApi.trash(document.id, document.revision))) }}><Trash2 />Move note to Trash</DropdownMenu.Item></>}
              </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
            </div>
          </header>
          {document.deletedAt ? <div className="notes-trash-banner"><span>In Trash since {shortDate(document.deletedAt)}</span><Button size="sm" variant="outline" disabled={busy} onClick={() => void mutate(async () => { applyDocument(await notesApi.restore(document.id, document.revision)); setNotice('Note restored') })}><RotateCcw />Restore</Button><Button size="icon" variant="ghost" title="Delete permanently" aria-label="Delete permanently" disabled={busy} onClick={() => { if (window.confirm('Permanently delete this note and its saved versions? This cannot be undone. Source audio is not affected.')) void mutate(async () => { await notesApi.purge(document.id, document.revision); setParams({}); setDocument(null) }) }}><Trash2 /></Button></div>
            : <div className="notes-location"><Folder /><FolderSelect folders={folders} value={folderDraft} onChange={setFolderDraft} disabled={busy} />{document.sourceRecordingId && <Link to={`/transcripts/${document.sourceRecordingId}`}><FileText />Source transcript</Link>}</div>}
          <DocumentCanvas key={document.id} document={document} content={content} onChange={setContent} mode={mode} onModeChange={setMode} busy={busy} onSave={save} />
          {sendOpen && <SendNoteDialog document={document} onClose={() => setSendOpen(false)} />}
          {historyOpen && <NoteHistory document={document} onClose={() => setHistoryOpen(false)} onRestored={note => { applyDocument(note); setRefresh(value => value + 1); setHistoryOpen(false); setNotice('Version restored as a new revision') }} />}
        </> : <div className="notes-empty notes-editor-empty"><NotebookPen /><h2>Your Markdown workspace</h2><Button variant="outline" onClick={createNote}><FilePlus2 />New note</Button></div>}
      </section>
    </div>
    {folderDialog && <FolderForm folder={folderDialog === 'new' ? null : folderDialog} folders={folders} parentId={targetFolder} onClose={() => setFolderDialog(null)} onSaved={() => { setFolderDialog(null); setRefresh(value => value + 1) }} />}
  </div>
}

function FolderForm({ folder, folders, parentId, onClose, onSaved }: {folder: NoteFolder | null; folders: NoteFolder[]; parentId: string | null; onClose: () => void; onSaved: () => void}) {
  const [name, setName] = useState(folder?.name || '')
  const [parent, setParent] = useState(folder ? folder.parentId || '' : parentId || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <NoteDialog title={folder ? 'Edit folder' : 'New folder'} description={folder ? folder.name : 'Markdown workspace'} onClose={onClose} busy={busy}>
    <form onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('')
      try { if (folder) await notesApi.updateFolder(folder.id, { name, parentId: parent || null, revision: folder.revision }); else await notesApi.createFolder(name, parent || null); onSaved() }
      catch (error) { setError(errorMessage(error)) }
      finally { setBusy(false) }
    }}><label>Name<input autoFocus aria-label="Folder name" value={name} onChange={event => setName(event.target.value)} required maxLength={180} /></label>
      <label>Parent folder<FolderSelect folders={folders} value={parent} onChange={setParent} rootLabel="Workspace" exclude={folder?.id} disabled={busy} /></label>
      {error && <p role="alert" className="note-error">{error}</p>}<footer><Button type="button" variant="ghost" disabled={busy} onClick={onClose}><X />Cancel</Button><Button disabled={busy || !name.trim()}>{busy ? <Loader2 className="animate-spin" /> : <FolderPlus />}{folder ? 'Save folder' : 'Create folder'}</Button></footer>
    </form>
  </NoteDialog>
}

function NoteHistory({ document, onClose, onRestored }: {document: NoteDocument; onClose: () => void; onRestored: (document: NoteDocument) => void}) {
  const [versions, setVersions] = useState<Omit<NoteVersion, 'content'>[]>([])
  const [selected, setSelected] = useState<NoteVersion | null>(null)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { let cancelled = false; notesApi.versions(document.id).then(rows => { if (!cancelled) { setVersions(rows); setMore(rows.length === 30) } }).catch(error => { if (!cancelled) setError(errorMessage(error)) }); return () => { cancelled = true } }, [document.id])
  return <NoteDialog title="Note history" description={document.title} onClose={onClose} busy={busy}>
    {error && <p role="alert" className="note-error">{error}</p>}
    <div className="notes-history-list">{versions.map(version => <button type="button" disabled={busy} key={version.id} aria-pressed={selected?.id === version.id} onClick={async () => { setBusy(true); try { setSelected(await notesApi.version(document.id, version.id)) } catch (error) { setError(errorMessage(error)) } finally { setBusy(false) } }}><span>Revision {version.revision}</span><time>{new Date(version.createdAt).toLocaleString()}</time></button>)}</div>
    {more && <Button variant="ghost" disabled={busy} onClick={async () => { setBusy(true); try { const rows = await notesApi.versions(document.id, versions.length); setVersions(current => [...current, ...rows]); setMore(rows.length === 30) } catch (error) { setError(errorMessage(error)) } finally { setBusy(false) } }}><ChevronDown />Load older versions</Button>}
    {selected && <><h3 className="notes-history-title">{selected.title}</h3><pre className="notes-history-content">{selected.content}</pre></>}
    <footer><Button variant="outline" onClick={onClose} disabled={busy}><X />Close</Button><Button disabled={busy || !selected || selected.revision === document.revision} onClick={async () => { if (!selected || !window.confirm('Restore this content as a new revision? Current history will be kept.')) return; setBusy(true); try { onRestored(await notesApi.restoreVersion(document.id, selected.id, document.revision)) } catch (error) { setError(errorMessage(error)) } finally { setBusy(false) } }}><RotateCcw />Restore version</Button></footer>
  </NoteDialog>
}
