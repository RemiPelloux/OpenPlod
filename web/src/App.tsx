import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Layout } from '@/components/Layout'
import { Loader2 } from 'lucide-react'
import { RuntimeGate } from '@/components/RuntimeGate'

const Dashboard = lazy(() => import('@/pages/Dashboard').then(module => ({ default: module.Dashboard })))
const RecordingDetail = lazy(() => import('@/pages/RecordingDetail').then(module => ({ default: module.RecordingDetail })))
const SearchPage = lazy(() => import('@/pages/SearchPage').then(module => ({ default: module.SearchPage })))
const SettingsPage = lazy(() => import('@/pages/SettingsPage').then(module => ({ default: module.SettingsPage })))
const RecordingPage = lazy(() => import('@/pages/RecordingPage').then(module => ({ default: module.RecordingPage })))

function PageFallback() {
  return (
    <div className="flex h-full items-center justify-center" role="status" aria-label="Loading page">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  )
}

export default function App() {
  return (
    <RuntimeGate>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/recording/:id" element={<RecordingDetail />} />
              <Route path="/record" element={<RecordingPage />} />
              <Route path="/search" element={<SearchPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </RuntimeGate>
  )
}
