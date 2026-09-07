import { useEffect, useRef, useState } from 'react'
import { FileAudio, FolderOpen, Loader2, RefreshCw, Upload } from "@/components/icons"
import { Button } from '@/components/ui/button'
import { PlaudImportDialog } from '@/components/PlaudImportDialog'
import { api, type AvailableRecording } from '@/lib/api'
import { getRuntime } from '@/lib/runtime'
export function ImportPage() {
  const [files, setFiles] = useState<AvailableRecording[]>([]), [selected, setSelected] = useState<string[]>([]), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('')
  const picker = useRef<HTMLInputElement>(null)
  const refresh = async () => { setBusy(true); setError(''); try { setFiles(await api.getAvailableRecordings()) } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }
  useEffect(() => { let stopped = false; api.getAvailableRecordings().then(rows => { if (!stopped) setFiles(rows) }).catch(e => { if (!stopped) setError(e.message) }); return () => { stopped = true } }, [])
  const upload = async (file: File) => { setBusy(true); setError(''); try { await api.uploadRecording(file, getRuntime().mode === 'mobile'); setMessage('Recording saved to your vault.'); window.dispatchEvent(new CustomEvent('plaud:sync-complete')) } catch (e) { setError((e as Error).message) } finally { setBusy(false); if (picker.current) picker.current.value = '' } }
  const importFiles = async () => { if (!selected.length || !window.confirm(`Import ${selected.length} selected files into your vault?`)) return; setBusy(true); setError(''); try { await api.importRecordings(selected); setSelected([]); setMessage('Import completed.'); window.dispatchEvent(new CustomEvent('plaud:sync-complete')); await refresh() } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }
  return <div className="studio-secondary-page"><header><h1>Import</h1><div><Button disabled={busy} onClick={() => picker.current?.click()}>{busy ? <Loader2 className="animate-spin" /> : <Upload />}Upload audio</Button><PlaudImportDialog variant="outline" /></div></header><input className="sr-only" ref={picker} type="file" accept="audio/*" onChange={e => { const file = e.target.files?.[0]; if (file) void upload(file) }} />
    {error && <p role="alert" className="device-error">{error}</p>}{message && <p role="status">{message}</p>}
    <section><div className="studio-section-heading"><h2><FolderOpen />Export folder</h2><Button variant="ghost" size="icon" aria-label="Refresh folder" title="Refresh folder" disabled={busy} onClick={() => void refresh()}><RefreshCw /></Button></div>
      {!files.length ? <div className="studio-empty"><FileAudio /><h2>No audio files available</h2><p>Choose an audio file or connect your Plaud.</p></div> : files.map(file => <label className="device-recording-row" key={file.fingerprint}><input type="checkbox" disabled={busy || file.imported} checked={selected.includes(file.path)} onChange={e => setSelected(rows => e.target.checked ? [...rows, file.path] : rows.filter(path => path !== file.path))} /><span><strong>{file.filename}</strong><small>{file.imported ? 'Already imported' : `${Math.round(file.size / 1024)} KB`}</small></span></label>)}
      {!!files.length && <Button disabled={busy || !selected.length} onClick={() => void importFiles()}><Upload />Import selected</Button>}
    </section></div>
}
