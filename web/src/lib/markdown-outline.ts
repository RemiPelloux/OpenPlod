import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { toString } from 'mdast-util-to-string'

const parser = unified().use(remarkParse).use(remarkGfm)
export function markdownOutline(content: string) {
  const tree = parser.parse(content)
  const headings: { id: string; label: string; level: number }[] = []
  const visit = (node: typeof tree | typeof tree.children[number]) => {
    if (node.type === 'heading') headings.push({ id: `document-heading-${node.position?.start.offset}`, label: toString(node), level: node.depth })
    if ('children' in node) for (const child of node.children) visit(child as typeof tree.children[number])
  }
  visit(tree)
  return headings
}
