import { expect, test } from 'bun:test'
import { markdownOutline } from './markdown-outline'

test('outline follows rendered Markdown, not headings inside code', () => {
  const headings = markdownOutline('# **Title**\n\n```md\n## Not a heading\n```\n\nSection\n-------\n\n> ### Nested [link](https://example.com)')
  expect(headings.map(({ label, level }) => [label, level])).toEqual([['Title', 1], ['Section', 2], ['Nested link', 3]])
})
test('duplicate labels have stable distinct anchors', () => {
  const headings = markdownOutline('## Same\n\n## Same')
  expect(new Set(headings.map(row => row.id)).size).toBe(2)
  expect(markdownOutline('no headings')).toEqual([])
})
