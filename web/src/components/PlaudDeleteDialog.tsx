import { useRef, useState } from 'react'
import { NoteDialog } from './NoteDialogs'
import { Button } from './ui/button'
import { ShieldCheck, Trash2 } from './icons'
import { api, type DeviceRecording } from '@/lib/api'
import { t } from '@/i18n'

export function PlaudDeleteDialog({ session, label, onClose, onDeleted }: {
  session: DeviceRecording; label: string; onClose: () => void; onDeleted: () => void
}) {
  const [receipt, setReceipt] = useState<{ token: string; expiresAt: number } | null>(null)
  const [phase, setPhase] = useState<'idle' | 'verifying' | 'deleting'>('idle')
  const [error, setError] = useState('')
  const running = useRef(false)
  const busy = phase !== 'idle'
  const act = async () => {
    if (running.current) return
    running.current = true; setError('')
    const confirmation = receipt
    setPhase(confirmation ? 'deleting' : 'verifying')
    try {
      if (confirmation) {
        setReceipt(null)
        if (Date.now() >= confirmation.expiresAt) throw new Error('Deletion confirmation expired or invalid. Verify the backup again.')
        await api.confirmDeviceDeletion(confirmation.token)
        onDeleted()
      } else {
        setReceipt(await api.prepareDeviceDeletion(session.recordingId!, session.sessionId))
      }
    } catch (failure) { setReceipt(null); setError(t(failure instanceof Error ? failure.message : 'Backup verification failed.')) }
    finally { running.current = false; setPhase('idle') }
  }
  return <NoteDialog title={t('Delete from Plaud')} description={`${label} · ${t('Session {id}', { id: session.sessionId })}`} busy={busy} onClose={onClose}>
    <p className="plaud-confirm-copy">{t('This permanently deletes this recording from your Plaud. The verified audio and original file stay in your OpenPlod vault.')}</p>
    <p className="plaud-confirm-copy" role="status">{phase === 'verifying' ? t('Checking the local audio, original file and device recording…')
      : phase === 'deleting' ? t('Rechecking the backup, deleting from Plaud and confirming the device list…')
      : receipt ? t('Backup verified. Confirm deletion within two minutes. Keep your Plaud nearby and awake.')
      : t('Verify your local backup before confirming deletion.')}</p>
    {error && <p role="alert" className="note-error">{error}</p>}
    <footer><Button autoFocus variant="ghost" disabled={busy} onClick={onClose}>{t('Cancel')}</Button>
      <Button style={{ transitionProperty: 'none' }} variant={receipt ? 'destructive' : 'outline'} className={`h-auto min-h-9 whitespace-normal ${receipt ? 'bg-destructive text-destructive-foreground hover:bg-destructive' : ''}`} disabled={busy} onClick={() => void act()}>
        {receipt ? <Trash2 /> : <ShieldCheck />}{receipt ? t('Permanently delete from Plaud') : t('Verify backup')}
      </Button></footer>
  </NoteDialog>
}
