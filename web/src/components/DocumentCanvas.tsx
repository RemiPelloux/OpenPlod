import { createElement, useDeferredValue, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { Link } from 'react-router-dom'
import ReactMarkdown, { type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Bold, Code, FileAudio, Heading1, Heading2, Heading3, Italic, Link2, List, ListOrdered, ListTree, PanelRightClose, Quote, TextSelect } from "@/components/icons"
import { IconButton } from './ui/icon-button'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { editMarkdown, type MarkdownAction } from '@/lib/markdown-edit'
import { markdownOutline } from '@/lib/markdown-outline'
import type { NoteDocument } from '@/lib/notes-api'

const tools = [
  ['h1', 'Heading 1', Heading1], ['h2', 'Heading 2', Heading2], ['h3', 'Heading 3', Heading3],
  ['bold', 'Bold', Bold], ['italic', 'Italic', Italic], ['bullet', 'Bulleted list', List],
  ['numbered', 'Numbered list', ListOrdered], ['link', 'Insert link', Link2], ['code', 'Inline code', Code], ['quote', 'Blockquote', Quote],
] as const

const heading = (tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') => ({ node, children, ...props }: ComponentProps<'h1'> & ExtraProps) =>
  createElement(tag, { ...props, id: `document-heading-${node?.position?.start.offset}` }, children)
const headingComponents = { h1: heading('h1'), h2: heading('h2'), h3: heading('h3'), h4: heading('h4'), h5: heading('h5'), h6: heading('h6') }

export function DocumentCanvas({ document, content, onChange, mode, onModeChange, busy, onSave }: {
  document: NoteDocument; content: string; onChange: (content: string) => void;
  mode: 'edit' | 'preview'; onModeChange: (mode: 'edit' | 'preview') => void; busy: boolean; onSave: () => void;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null)
  const preview = useRef<HTMLDivElement>(null)
  const deferred = useDeferredValue(content)
  const [panel, setPanel] = useState<'outline' | 'source' | null>(null)
  const headings = useMemo(() => panel === 'outline' ? markdownOutline(deferred) : [], [deferred, panel])
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null)
  const readOnly = busy || !!document.deletedAt

  useEffect(() => {
    if (!selection || mode !== 'edit') return
    textarea.current?.focus()
    textarea.current?.setSelectionRange(selection.start, selection.end)
  }, [selection, mode])

  const format = (action: MarkdownAction) => {
    if (readOnly) return
    const input = textarea.current
    const result = editMarkdown(content, input?.selectionStart ?? content.length, input?.selectionEnd ?? content.length, action)
    if (result.text.length > 524288) return
    onChange(result.text); onModeChange('edit'); setSelection({ start: result.start, end: result.end })
  }
  const toggleOutline = () => {
    setPanel(panel === 'outline' ? null : 'outline')
    if (panel !== 'outline') onModeChange('preview')
  }

  return <div className="document-canvas">
    <div className="document-format-bar" role="toolbar" aria-label="Markdown formatting">
      <ToggleGroup type="single" size="sm" className="notes-mode" value={mode} onValueChange={value => { if (value === 'edit' || value === 'preview') onModeChange(value) }} aria-label="Document mode">
        <ToggleGroupItem value="edit" disabled={!!document.deletedAt}>Markdown</ToggleGroupItem><ToggleGroupItem value="preview">Preview</ToggleGroupItem>
      </ToggleGroup>
      <div className="document-format-tools">{tools.map(([action, label, Icon]) => <IconButton key={action} label={label} disabled={readOnly || content.length >= 524288} onMouseDown={event => event.preventDefault()} onClick={() => format(action)}><Icon /></IconButton>)}</div>
      <span className="document-word-count">{content.trim() ? content.trim().split(/\s+/).length : 0} words</span>
    </div>
    <div className="document-canvas-columns" data-panel={!!panel}>
      <div className="notes-document-body">
        {mode === 'edit' && !document.deletedAt ? <textarea ref={textarea} className="notes-markdown-input" aria-label="Markdown content" value={content} maxLength={524288} spellCheck onChange={event => onChange(event.target.value)} disabled={busy} placeholder="# Your note" onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); onSave() } }} />
          : <div ref={preview} className="notes-markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ ...headingComponents, img: ({ alt }) => <span className="notes-image-placeholder">[Image: {alt || 'external image'}]</span>, a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> }}>{deferred || '*Empty note*'}</ReactMarkdown></div>}
      </div>
      {panel && <aside className="document-inspector" aria-label={panel === 'outline' ? 'Document outline' : 'Document source'}>
        <header><h3>{panel === 'outline' ? 'Outline' : 'Source'}</h3><IconButton label="Close document panel" onClick={() => setPanel(null)}><PanelRightClose /></IconButton></header>
        {panel === 'outline' ? mode === 'edit' ? <button className="document-outline-preview" onClick={() => onModeChange('preview')}>Show document outline</button> : headings.length ? <nav>{headings.map(heading => <button key={heading.id} style={{ paddingLeft: 12 + (heading.level - 1) * 10 }} onClick={() => {
          const node = preview.current?.querySelector<HTMLElement>(`#${heading.id}`)
          node?.scrollIntoView({ block: 'start', behavior: 'instant' }); node?.setAttribute('tabindex', '-1'); node?.focus({ preventScroll: true })
        }}>{heading.label}</button>)}</nav> : <p>No headings in this document.</p> : <>
          <dl><div><dt>Original</dt><dd>{document.sourceOrigin?.startsWith('ai:mistral:') ? 'Mistral' : document.sourceRecordingId ? 'Transcript' : 'Markdown'}</dd></div><div><dt>Saved version</dt><dd>Revision {document.revision}</dd></div><div><dt>Created</dt><dd>{new Date(document.createdAt).toLocaleDateString()}</dd></div><div><dt>Last edited</dt><dd>{new Date(document.updatedAt).toLocaleString()}</dd></div></dl>
          {document.sourceRecordingId && <Link to={`/transcripts/${document.sourceRecordingId}`}><FileAudio />Source transcript</Link>}
        </>}
      </aside>}
      <nav className="document-tool-rail" aria-label="Document tools">
        <IconButton label="Document outline" aria-pressed={panel === 'outline'} onClick={toggleOutline}><ListTree /></IconButton>
        <IconButton label="Document source" aria-pressed={panel === 'source'} onClick={() => setPanel(panel === 'source' ? null : 'source')}><TextSelect /></IconButton>
      </nav>
    </div>
  </div>
}
