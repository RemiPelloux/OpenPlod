import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Bluetooth, FileText, FolderHeart, Loader2, Mic, Moon, Settings, Sun, Upload } from 'lucide-react'
import { Brand } from '@/components/Brand'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { getRuntime } from '@/lib/runtime'
import { useTheme } from '@/hooks/useTheme'

const nav = [
  { to: '/', icon: FolderHeart, label: 'Library' },
  { to: '/transcripts', icon: FileText, label: 'Transcripts' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]

const desktopNav = [
  nav[0],
  { to: '/devices', icon: Bluetooth, label: 'Plaud' },
  { to: '/record', icon: Mic, label: 'Record' },
  ...nav.slice(1),
]

export function Layout() {
  const { dark, toggle } = useTheme()
  const location = useLocation()
  const navigate = useNavigate()
  const runtime = getRuntime()
  const [uploading, setUploading] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')
  const clearMessageTimer = useRef<number | null>(null)
  const uploadRef = useRef<HTMLInputElement>(null)
  const pageScrollRef = useRef<HTMLElement>(null)
  const captureMode = location.pathname === '/record'

  useLayoutEffect(() => {
    pageScrollRef.current?.scrollTo({ top: 0 })
  }, [location.pathname])

  useEffect(() => () => {
    if (clearMessageTimer.current) window.clearTimeout(clearMessageTimer.current)
  }, [])

  const announce = (message: string) => {
    setSyncMessage(message)
    if (clearMessageTimer.current) window.clearTimeout(clearMessageTimer.current)
    clearMessageTimer.current = window.setTimeout(() => setSyncMessage(''), 4000)
  }

  const handleSync = () => navigate('/devices')

  const handleUpload = async (file: File) => {
    setUploading(true)
    try {
      await api.uploadRecording(file, runtime.mode === 'mobile')
      announce('Recording stored in your vault')
      window.dispatchEvent(new CustomEvent('plaud:sync-complete'))
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (uploadRef.current) uploadRef.current.value = ''
    }
  }

  return (
    <div className="app-shell">
      <aside className="desktop-sidebar">
        <div className="sidebar-brand"><Brand /></div>
        <nav className="sidebar-nav" aria-label="Main navigation">
          {desktopNav.map(({ to, icon: Icon, label }) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
              <Icon aria-hidden="true" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-actions">
          <Button variant="ghost" size="sm" className="w-full justify-start gap-3" onClick={() => uploadRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Import audio
          </Button>
          <Button variant="ghost" size="sm" className="w-full justify-start gap-3" onClick={toggle}>
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            {dark ? 'Light mode' : 'Dark mode'}
          </Button>
          <div className="vault-state"><span />{runtime.mode === 'desktop' ? 'Vault on this Mac' : 'Desktop vault paired'}</div>
        </div>
      </aside>

      <div className="app-content">
        {!captureMode && <header className="mobile-header">
          <Brand />
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-9 w-9" onClick={handleSync} aria-label="Open Plaud" title="Open Plaud">
              <Bluetooth className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-9 w-9" onClick={toggle} aria-label={dark ? 'Use light mode' : 'Use dark mode'} title={dark ? 'Use light mode' : 'Use dark mode'}>
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
          </div>
        </header>}

        {syncMessage && <div className="sync-toast" role="status">{syncMessage}</div>}
        <main ref={pageScrollRef} className={captureMode ? 'page-scroll capture-scroll' : 'page-scroll'}><Outlet /></main>

        <input ref={uploadRef} type="file" accept="audio/*" className="sr-only" onChange={event => {
          const file = event.target.files?.[0]
          if (file) void handleUpload(file)
        }} />
        {!captureMode && <nav className="mobile-nav" aria-label="Main navigation">
          {nav.slice(0, 2).map(({ to, icon: Icon, label }) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `mobile-nav-item ${isActive ? 'active' : ''}`}>
              <Icon aria-hidden="true" /><span>{label}</span>
            </NavLink>
          ))}
          <button className="capture-action" type="button" onClick={() => navigate('/record')} aria-label="Record audio" title="Record audio">
            <Mic />
          </button>
          <NavLink to="/settings" className={({ isActive }) => `mobile-nav-item mobile-nav-settings ${isActive ? 'active' : ''}`}>
            <Settings aria-hidden="true" /><span>Settings</span>
          </NavLink>
          <NavLink to="/devices" className={({ isActive }) => `mobile-nav-item ${isActive ? 'active' : ''}`}>
            <Bluetooth aria-hidden="true" /><span>Plaud</span>
          </NavLink>
        </nav>}
      </div>
    </div>
  )
}
