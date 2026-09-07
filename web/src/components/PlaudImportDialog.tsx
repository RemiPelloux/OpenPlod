import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Link } from 'react-router-dom'
import { ArrowUpRight, Bluetooth, Check, Download, FileAudio, Loader2, RefreshCw, RotateCcw, ShieldCheck, X } from "@/components/icons"
import { Button } from '@/components/ui/button'
import { api, type DeviceRecording } from '@/lib/api'
import { getRuntime } from '@/lib/runtime'
import './plaud-import.css'

const bytesLabel = (bytes: number) => bytes < 1024 * 1024
  ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

export function PlaudImportDialog({ variant = 'default' }: { variant?: 'default' | 'outline' }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<DeviceRecording[] | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState('device')
  const [busy, setBusy] = useState<'loading' | 'importing' | 'restoring' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [progress, setProgress] = useState({ current: 0, total: 0, sessionId: 0 })
  const operation = useRef<AbortController | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const keyboard = useRef(false)
  const mobile = getRuntime().mode === 'mobile'

  useEffect(() => () => { operation.current?.abort() }, [])

  const load = async () => {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy('loading'); setError(''); setNotice('')
    try {
      const result = await api.getDeviceRecordings(controller.signal)
      setRows(result); setSelected([])
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not read the Plaud. Wake it and try again.')
    } finally {
      if (operation.current === controller) { operation.current = null; setBusy(null) }
    }
  }

  const importSelected = async () => {
    if (operation.current || !selected.length) return
    const controller = new AbortController()
    operation.current = controller
    const queue = rows?.filter(row => !row.recordingId && selected.includes(row.sessionId)) ?? []
    setBusy('importing'); setError(''); setNotice('')
    let completed = 0
    try {
      for (const row of queue) {
        controller.signal.throwIfAborted()
        setProgress({ current: completed, total: queue.length, sessionId: row.sessionId })
        const id = await api.importDeviceRecording(row.sessionId, controller.signal)
        controller.signal.throwIfAborted()
        completed++
        setRows(current => current?.map(item => item.sessionId === row.sessionId ? { ...item, recordingId: id, retentionState: 'active' } : item) ?? null)
        setSelected(current => current.filter(value => value !== row.sessionId))
        window.dispatchEvent(new CustomEvent('plaud:sync-complete'))
      }
      setNotice(`${completed} recording${completed === 1 ? '' : 's'} saved in your vault.`)
    } catch (failure) {
      if (!controller.signal.aborted) setError(`${completed ? `${completed} saved. ` : ''}${failure instanceof Error ? failure.message : 'Import failed.'} Refresh the list before retrying.`)
    } finally {
      if (operation.current === controller) { operation.current = null; setBusy(null) }
    }
  }

  const cancel = async () => {
    if (cancelling || !operation.current) return
    setCancelling(true)
    try {
      await api.cancelDeviceOperation()
      operation.current?.abort(); operation.current = null
      setBusy(null); setNotice('Stopped. Any completed imports remain in your vault. Refresh to check their status.')
    } catch { setError('Could not stop the operation. Keep this window open and retry.') }
    finally { setCancelling(false) }
  }

  const restore = async (row: DeviceRecording) => {
    if (busy || !row.recordingId) return
    setBusy('restoring'); setError('')
    try {
      await api.restoreRecording(row.recordingId)
      setRows(current => current?.map(item => item.sessionId === row.sessionId ? { ...item, retentionState: 'active' } : item) ?? null)
      window.dispatchEvent(new CustomEvent('plaud:sync-complete'))
    } catch { setError('Could not restore the recording. Try again from Trash.') }
    finally { setBusy(null) }
  }

  const visible = (rows ?? []).filter(row => filter === 'all' || (filter === 'new' ? !row.recordingId : !!row.recordingId))
    .sort((a, b) => sort === 'size' ? b.size - a.size : b.sessionId - a.sessionId)
  const newRows = visible.filter(row => !row.recordingId)
  const allSelected = newRows.length > 0 && newRows.every(row => selected.includes(row.sessionId))
  const selectedBytes = (rows ?? []).filter(row => selected.includes(row.sessionId) && !row.recordingId).reduce((sum, row) => sum + row.size, 0)

  if (mobile) return <Button asChild variant={variant}><Link to="/devices"><Bluetooth />Get from Plaud</Link></Button>

  return <Dialog.Root open={open} onOpenChange={value => {
    if (!value && busy) return
    setOpen(value)
    if (value) { setRows(null); setSelected([]); setError(''); setNotice(''); setFilter('all') }
  }}>
    <Dialog.Trigger asChild><Button variant={variant} className="plaud-import-trigger" onPointerDown={() => { keyboard.current = false }} onKeyDown={() => { keyboard.current = true }}><Bluetooth aria-hidden="true" />Get from Plaud</Button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="plaud-import-overlay" />
      <Dialog.Content className="plaud-import-dialog" data-keyboard={keyboard.current} onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onInteractOutside={event => { if (busy) event.preventDefault() }}>
        <header className="plaud-import-heading">
          <div><Dialog.Title>Get from Plaud</Dialog.Title><Dialog.Description>{mobile ? 'Note Pro / Via your paired Mac' : 'Note Pro / Direct Bluetooth'}</Dialog.Description></div>
          <Dialog.Close asChild><Button size="icon" variant="ghost" disabled={!!busy} aria-label="Close Plaud import" title="Close"><X /></Button></Dialog.Close>
        </header>
        <div className="plaud-import-body">
          <div className="plaud-import-device"><span className="plaud-import-device-icon"><Bluetooth /></span><div><strong>Plaud Note Pro</strong><span>{busy === 'loading' ? 'Connecting and reading device storage...' : rows ? `${rows.length} recording${rows.length === 1 ? '' : 's'} on device` : 'Ready to connect'}</span></div>
            <Button variant="outline" size={rows ? 'icon' : 'default'} disabled={!!busy} title={rows ? 'Refresh recordings' : undefined} aria-label={rows ? 'Refresh recordings' : undefined} onClick={() => void load()}>{busy === 'loading' ? <Loader2 className="animate-spin" /> : rows ? <RefreshCw /> : <Bluetooth />}{!rows && 'Connect'}</Button>
          </div>
          {error && <div className="plaud-import-error" role="alert">{error}</div>}
          {notice && <div className="plaud-import-notice" role="status"><Check />{notice}</div>}
          {rows === null ? <div className="plaud-import-empty"><FileAudio /><h3>{busy === 'loading' ? 'Reading your recordings' : 'Bring your recordings home'}</h3><p>{mobile ? 'Keep the Plaud near your paired Mac and wake the device.' : 'Wake your Plaud and keep it near this Mac.'}</p><span>Originals stay on the Plaud.</span></div> : <>
            <div className="plaud-import-toolbar">
              <div className="plaud-import-tabs" role="group" aria-label="Recording filter">{[['all', 'All'], ['new', 'New'], ['saved', 'Saved']].map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>
              <select aria-label="Sort device recordings" value={sort} onChange={event => setSort(event.target.value)}><option value="device">Device order</option><option value="size">Largest first</option></select>
            </div>
            {newRows.length > 0 && <label className="plaud-import-select-all"><input type="checkbox" checked={allSelected} disabled={!!busy} onChange={() => setSelected(current => allSelected ? current.filter(id => !newRows.some(row => row.sessionId === id)) : [...new Set([...current, ...newRows.map(row => row.sessionId)])])} />Select all new<span>{newRows.length}</span></label>}
            <div className="plaud-import-recordings" aria-label="Device recordings">
              {visible.map(row => <div className="plaud-import-row" key={row.sessionId}>
                <label><input type="checkbox" aria-label={`Select recording ${row.sessionId}`} disabled={!!row.recordingId || !!busy} checked={selected.includes(row.sessionId)} onChange={event => setSelected(current => event.target.checked ? [...current, row.sessionId] : current.filter(id => id !== row.sessionId))} /><FileAudio /><span><strong>Recording {row.sessionId}</strong><small>{bytesLabel(row.size)} / {row.retentionState === 'trash' ? 'In Trash' : row.recordingId ? 'Saved in vault' : 'Not imported'}</small></span></label>
                {row.retentionState === 'trash' ? <Button variant="ghost" size="icon" disabled={!!busy} title="Restore from Trash" aria-label={`Restore recording ${row.sessionId}`} onClick={() => void restore(row)}><RotateCcw /></Button>
                  : row.recordingId ? <Button asChild variant="ghost" size="icon" disabled={!!busy}><Link onClick={event => { if (busy) event.preventDefault(); else setOpen(false) }} aria-label={`Open recording ${row.sessionId}`} title="Open recording" to={`/recording/${row.recordingId}`}><ArrowUpRight /></Link></Button> : null}
              </div>)}
              {visible.length === 0 && <div className="plaud-import-empty"><Check /><h3>{rows.length ? 'Nothing in this view' : 'No completed recordings'}</h3><p>{rows.length ? 'Choose another filter to see your recordings.' : 'Finish a recording on your Plaud, then refresh.'}</p></div>}
            </div>
          </>}
        </div>
        <footer className="plaud-import-footer">
          {busy === 'importing' ? <div className="plaud-import-progress" role="status"><Loader2 className="animate-spin" /><span>Importing {progress.current + 1} of {progress.total}<small>Recording {progress.sessionId}</small></span><progress max={progress.total} value={progress.current} aria-label="Completed recordings" /></div>
            : <div className="plaud-import-retention"><ShieldCheck /><span>{selected.length ? `${selected.length} selected / ${bytesLabel(selectedBytes)}` : 'Originals kept on device'}</span></div>}
          {busy ? <Button variant="outline" disabled={cancelling || busy === 'restoring'} onClick={() => void cancel()}>{cancelling ? 'Stopping...' : 'Cancel'}</Button>
            : <Button disabled={!selected.length} onClick={() => void importSelected()}><Download />Import{selected.length ? ` ${selected.length}` : ''}</Button>}
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
