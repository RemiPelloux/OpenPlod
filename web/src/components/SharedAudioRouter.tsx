import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { hasPendingAndroidShare } from '@/lib/android-share'

export function SharedAudioRouter() {
  const navigate = useNavigate()

  useEffect(() => {
    const openImport = () => {
      if (hasPendingAndroidShare()) navigate('/record?shared=1')
    }
    openImport()
    window.addEventListener('openplod:shared-audio', openImport)
    return () => window.removeEventListener('openplod:shared-audio', openImport)
  }, [navigate])

  return null
}
