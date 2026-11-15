import { expect, test } from 'bun:test'
import { setLocale } from '../i18n'
import { plaudErrorMessage } from './plaud-errors'

test('Plaud errors are localized without provider assumptions or manual-cookie instructions', () => {
  setLocale('fr')
  try {
    expect(plaudErrorMessage('Your Plaud session has expired. Sign in again.')).toBe('Votre session Plaud a expiré. Reconnectez-vous.')
    expect(plaudErrorMessage('Plaud refused authorization (HTTP 401, sn-sign). Recorder access is not authorized.')).toContain('compte associé')
    expect(plaudErrorMessage('Not enough available memory to import this 105 MiB recording.')).toContain('105 Mio')
    expect(plaudErrorMessage('ffmpeg made no progress for 45 seconds.')).toContain('45 secondes')
    expect(plaudErrorMessage('ffmpeg failed (exit 7): codec unavailable. Downloaded audio is kept for retry.')).toContain('code 7')
    expect(plaudErrorMessage('A Plaud sign-in is already running.')).toContain('déjà en cours')
  } finally { setLocale('en') }
})
