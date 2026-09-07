import { Copy, ExternalLink, Workflow } from "@/components/icons"
import { useState } from 'react'
import { getRuntime } from '@/lib/runtime'
import { Button } from '@/components/ui/button'
export function DeveloperPage() {
  const runtime = getRuntime(), [message, setMessage] = useState('')
  const origin = runtime.serviceOrigin || window.location.origin
  const endpoints = ['/api/recordings', '/api/transcripts', '/api/v1/documents', '/api/v1/folders', '/api/ai/conversations']
  return <div className="studio-secondary-page"><header><h1>API &amp; MCP</h1><Workflow /></header><section><h2>Desktop API</h2><div className="developer-endpoints">{endpoints.map(path => <div key={path}><span>GET</span><code>{path}</code><Button variant="ghost" size="icon" aria-label={`Copy ${path} URL`} title="Copy endpoint URL" onClick={() => { void navigator.clipboard.writeText(`${origin}${path}`).then(() => setMessage('Endpoint URL copied')).catch(() => setMessage('Clipboard unavailable')) }}><Copy /></Button></div>)}</div><p className="device-muted">Private requests require the X-OpenPlod-Token header.</p><a className="developer-doc-link" href="https://github.com/RemiPelloux/OpenPlod/blob/main/docs/api.md" target="_blank" rel="noreferrer">API documentation<ExternalLink /></a></section><section><h2>Model Context Protocol</h2><code className="developer-command">bun run mcp</code><p className="device-muted">Read-only tools by default. Write access is opt-in.</p><a className="developer-doc-link" href="https://github.com/RemiPelloux/OpenPlod/blob/main/docs/mcp.md" target="_blank" rel="noreferrer">MCP configuration<ExternalLink /></a></section>{message && <p role="status">{message}</p>}</div>
}
