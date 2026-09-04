import { NavLink, Outlet } from 'react-router-dom'
import { LayoutDashboard, Mic, Search, Settings, Moon, Sun, RefreshCw } from 'lucide-react'
import { useTheme } from '@/hooks/useTheme'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { useEffect, useRef, useState } from 'react'

const nav = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/search', icon: Search, label: 'Search' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]

export function Layout() {
  const { dark, toggle } = useTheme()
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')
  const clearMessageTimer = useRef<number | null>(null)

  useEffect(() => () => {
    if (clearMessageTimer.current) window.clearTimeout(clearMessageTimer.current)
  }, [])

  const handleSync = async () => {
    setSyncing(true)
    setSyncMessage('')
    try {
      const result = await api.sync()
      setSyncMessage(result.added > 0 ? `${result.added} added` : 'Up to date')
      window.dispatchEvent(new CustomEvent('plaud:sync-complete'))
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'Sync failed')
    } finally {
      setSyncing(false)
      clearMessageTimer.current = window.setTimeout(() => setSyncMessage(''), 4000)
    }
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="hidden md:flex w-[220px] flex-col border-r bg-card">
        <div className="flex items-center gap-2 px-6 py-5 border-b">
          <Mic className="h-5 w-5 text-primary" />
          <span className="font-semibold text-lg">OpenPlod</span>
        </div>
        <nav className="flex-1 p-3 space-y-1" aria-label="Main navigation">
          {nav.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                }`
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="p-3 border-t space-y-1">
          <Button variant="ghost" size="sm" className="w-full justify-start gap-3" onClick={handleSync} disabled={syncing}>
            <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
            Sync
          </Button>
          {syncMessage && <p className="px-3 text-xs text-muted-foreground" role="status">{syncMessage}</p>}
          <Button variant="ghost" size="sm" className="w-full justify-start gap-3" onClick={toggle}>
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            {dark ? 'Light mode' : 'Dark mode'}
          </Button>
        </div>
      </aside>

      {/* Mobile header */}
      <div className="flex flex-col flex-1 overflow-hidden">
        <header className="md:hidden flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <Mic className="h-5 w-5 text-primary" />
            <span className="font-semibold">OpenPlod</span>
          </div>
          <div className="flex items-center gap-1">
            {nav.map(({ to, icon: Icon, label }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                className={({ isActive }) =>
                  `p-2 rounded-lg ${isActive ? 'text-primary bg-primary/10' : 'text-muted-foreground'}`
                }
                aria-label={label}
                title={label}
              >
                <Icon className="h-4 w-4" />
              </NavLink>
            ))}
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleSync} disabled={syncing} aria-label="Sync recordings" title="Sync recordings">
              <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={toggle} aria-label={dark ? 'Use light mode' : 'Use dark mode'} title={dark ? 'Use light mode' : 'Use dark mode'}>
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
