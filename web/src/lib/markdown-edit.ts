export type MarkdownAction = 'h1' | 'h2' | 'h3' | 'bold' | 'italic' | 'bullet' | 'numbered' | 'link' | 'code' | 'quote'

export function editMarkdown(text: string, start: number, end: number, action: MarkdownAction) {
  start = Math.max(0, Math.min(start, text.length))
  end = Math.max(start, Math.min(end, text.length))
  const selected = text.slice(start, end)
  const wrappers: Partial<Record<MarkdownAction, [string, string, string]>> = {
    bold: ['**', '**', 'text'], italic: ['_', '_', 'text'],
    link: ['[', '](https://)', 'link text'], code: ['`', '`', 'code'],
  }
  const wrapper = wrappers[action]
  if (wrapper) {
    const [before, after, placeholder] = wrapper
    const value = selected || placeholder
    return { text: text.slice(0, start) + before + value + after + text.slice(end), start: start + before.length, end: start + before.length + value.length }
  }
  const lineStart = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1
  const lineEnd = text.indexOf('\n', Math.max(start, end - 1))
  const stop = lineEnd === -1 ? text.length : lineEnd
  const lines = text.slice(lineStart, stop).split('\n')
  const value = lines.map((line, index) => {
    if (action.startsWith('h')) return `${'#'.repeat(Number(action[1]))} ${line.replace(/^#{1,6}\s+/, '')}`
    if (action === 'quote') return `> ${line}`
    return `${action === 'numbered' ? `${index + 1}.` : '-'} ${line.replace(/^(?:[-*+] |\d+\. )/, '')}`
  }).join('\n')
  return { text: text.slice(0, lineStart) + value + text.slice(stop), start: lineStart, end: lineStart + value.length }
}
