import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Layout } from '@/components/Layout'
import { Loader2 } from 'lucide-react'
import { RuntimeGate } from '@/components/RuntimeGate'
import { SharedAudioRouter } from '@/components/SharedAudioRouter'

const DevicesPage = lazy(() => import('@/pages/DevicesPage').then(module => ({ default: module.DevicesPage })))

const Dashboard = lazy(() => import('@/pages/Dashboard').then(module => ({ default: module.Dashboard })))
const RecordingDetail = lazy(() => import('@/pages/RecordingDetail').then(module => ({ default: module.RecordingDetail })))
const TranscriptsPage = lazy(() => import('@/pages/TranscriptsPage').then(module => ({ default: module.TranscriptsPage })))
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
        <SharedAudioRouter />
        <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/devices" element={<DevicesPage />} />
              <Route path="/" element={<Dashboard />} />
              <Route path="/recording/:id" element={<RecordingDetail />} />
              <Route path="/record" element={<RecordingPage />} />
              <Route path="/transcripts" element={<TranscriptsPage />} />
              <Route path="/transcripts/:id" element={<RecordingDetail backPath="/transcripts" />} />
              <Route path="/search" element={<Navigate to="/transcripts" replace />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </RuntimeGate>
  )
}
