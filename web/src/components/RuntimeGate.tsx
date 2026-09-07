import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, Keyboard, Loader2, Radio, ScanLine, ShieldCheck, X } from "@/components/icons"
import { Brand } from '@/components/Brand'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { initializeRuntime, pairMobile, type RuntimeConfig } from '@/lib/runtime'

export function RuntimeGate({ children }: { children: ReactNode }) {
  const [runtime, setRuntime] = useState<RuntimeConfig | null>(null)
  const [error, setError] = useState('')
  const [address, setAddress] = useState('')
  const [token, setToken] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [manualEntry, setManualEntry] = useState(false)
  const [scanning, setScanning] = useState(false)

  useEffect(() => {
    let disposed = false
    initializeRuntime()
      .then(async config => {
        if (config.mode === 'desktop') await waitForDesktop(config.serviceOrigin)
        if (!disposed) setRuntime(config)
      })
      .catch(initError => {
        if (!disposed) setError(initError instanceof Error ? initError.message : 'OpenPlod could not start.')
      })
    return () => { disposed = true }
  }, [])

  const connect = async (nextAddress = address, nextToken = token) => {
    setConnecting(true)
    setError('')
    try {
      setRuntime(await pairMobile(nextAddress, nextToken))
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : 'Could not pair this device.')
    } finally {
      setConnecting(false)
    }
  }

  if (!runtime && !error) {
    return (
      <div className="runtime-loading" role="status">
        <Brand />
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    )
  }

  if (runtime?.mode === 'mobile' && !runtime.paired) {
    const handleQrCode = async (value: string) => {
      try {
        const payload = JSON.parse(value) as { type?: string; origin?: string; token?: string }
        if (payload.type !== 'openplod-pairing' || !payload.origin || !payload.token) {
          throw new Error('This is not an OpenPlod pairing code.')
        }
        setAddress(payload.origin)
        setToken(payload.token)
        setScanning(false)
        await connect(payload.origin, payload.token)
      } catch (scanError) {
        setError(scanError instanceof Error ? scanError.message : 'Could not read this pairing code.')
      }
    }

    return (
      <main className="pairing-screen">
        <section className="pairing-panel" aria-labelledby="pairing-title">
          <Brand />
          <div className="pairing-icon"><Radio aria-hidden="true" /></div>
          <div>
            <h1 id="pairing-title">Connect to your vault</h1>
            <p>Keep your phone and desktop on the same Wi-Fi, then scan the code shown in desktop Settings.</p>
          </div>
          {scanning ? (
            <QrScanner onResult={handleQrCode} onCancel={() => setScanning(false)} onError={setError} />
          ) : (
            <Button size="lg" onClick={() => { setError(''); setScanning(true) }}>
              <ScanLine className="h-5 w-5" />Scan desktop code
            </Button>
          )}
          {manualEntry && !scanning && (
            <div className="pairing-manual">
              <label>
                Desktop address
                <Input inputMode="url" autoCapitalize="none" autoCorrect="off" placeholder="192.168.1.24:3487" value={address} onChange={event => setAddress(event.target.value)} />
              </label>
              <label>
                Pairing code
                <Input autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="Private code" value={token} onChange={event => setToken(event.target.value)} />
              </label>
              <Button variant="outline" onClick={() => void connect()} disabled={connecting || !address.trim() || !token.trim()}>
                {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                Connect manually
              </Button>
            </div>
          )}
          {error && <p className="pairing-error" role="alert">{error}</p>}
          {!scanning && (
            <button type="button" className="manual-pairing-toggle" onClick={() => setManualEntry(value => !value)}>
              <Keyboard className="h-4 w-4" />{manualEntry ? 'Hide manual setup' : 'Enter details manually'}
            </button>
          )}
          <p className="pairing-private"><ShieldCheck className="h-4 w-4" /> Audio remains in your private OpenPlod vault.</p>
        </section>
      </main>
    )
  }

  if (!runtime) {
    return (
      <div className="runtime-loading" role="alert">
        <Brand />
        <p>{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>Try again</Button>
      </div>
    )
  }

  return children
}

function QrScanner({ onResult, onCancel, onError }: { onResult: (value: string) => void; onCancel: () => void; onError: (message: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    let stopped = false
    let controls: { stop: () => void } | undefined
    void import('@zxing/browser').then(async ({ BrowserQRCodeReader }) => {
      if (!videoRef.current || stopped) return
      const reader = new BrowserQRCodeReader()
      try {
        controls = await reader.decodeFromVideoDevice(undefined, videoRef.current, result => {
          if (!result || stopped) return
          stopped = true
          controls?.stop()
          onResult(result.getText())
        })
      } catch (cameraError) {
        if (!stopped) onError(cameraError instanceof Error ? cameraError.message : 'Camera access is unavailable.')
      }
    })
    return () => {
      stopped = true
      controls?.stop()
    }
  }, [onError, onResult])

  return (
    <div className="qr-scanner">
      <video ref={videoRef} muted playsInline aria-label="QR code camera preview" />
      <span className="qr-frame" aria-hidden="true" />
      <Button variant="secondary" size="icon" onClick={onCancel} aria-label="Close scanner" title="Close scanner"><X className="h-4 w-4" /></Button>
    </div>
  )
}

async function waitForDesktop(origin: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return
    } catch {
      // The bundled service may still be opening its database.
    }
    await new Promise(resolve => window.setTimeout(resolve, 150))
  }
  throw new Error('The local recording service did not start.')
}
