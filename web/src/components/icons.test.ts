import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as icons from './icons'

describe('OpenPlod custom SVG icons', () => {
  test('every glyph renders locally with a stable viewBox and distinct identity', () => {
    expect(Object.keys(icons)).toHaveLength(91)
    for (const Icon of Object.values(icons)) {
      const markup = renderToStaticMarkup(createElement(Icon))
      expect(markup).toContain('viewBox="0 0 24 24"')
      expect(markup).toContain('data-openplod-icon=')
      expect(markup).toContain('aria-hidden="true"')
      expect(markup).not.toContain('<image')
      expect(markup).not.toContain('<use')
      expect(markup).toMatch(/<(path|rect|circle)/)
    }
  })
  test('labeled status icons are accessible and keep caller sizing', () => {
    const markup = renderToStaticMarkup(createElement(icons.Check, { 'aria-label': 'Downloaded', size: 18, className: 'status-icon' }))
    expect(markup).toContain('role="img"')
    expect(markup).not.toContain('aria-hidden="true"')
    expect(markup).toContain('aria-label="Downloaded"')
    expect(markup).toContain('width="18"')
    expect(markup).toContain('class="status-icon"')
  })
  test('semantically identical cloud upload imports share one glyph', () => {
    expect(icons.UploadCloud).toBe(icons.CloudUpload)
  })
})
