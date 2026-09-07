import { describe, expect, test } from 'bun:test'
import { editMarkdown } from './markdown-edit'

describe('Markdown toolbar', () => {
  test('formats a selection without changing surrounding content', () => {
    expect(editMarkdown('one two three', 4, 7, 'bold')).toEqual({ text: 'one **two** three', start: 6, end: 9 })
  })
  test('selects a placeholder at an empty cursor', () => {
    expect(editMarkdown('', 0, 0, 'italic')).toEqual({ text: '_text_', start: 1, end: 5 })
  })
  test('replaces heading level on the current line', () => {
    expect(editMarkdown('before\n# Title\nafter', 11, 11, 'h2').text).toBe('before\n## Title\nafter')
  })
  test('formats multiline lists and preserves the following line', () => {
    expect(editMarkdown('one\ntwo\nthree', 0, 8, 'numbered').text).toBe('1. one\n2. two\nthree')
  })
  test('handles the beginning and end of a document', () => {
    expect(editMarkdown('text\nlast', 0, 0, 'h1').text).toBe('# text\nlast')
    expect(editMarkdown('text\n', 5, 5, 'quote').text).toBe('text\n> ')
    expect(editMarkdown('\ntext', 0, 0, 'h2').text).toBe('## \ntext')
  })
  test('creates links and inline code', () => {
    expect(editMarkdown('OpenPlod', 0, 8, 'link').text).toBe('[OpenPlod](https://)')
    expect(editMarkdown('x', 0, 1, 'code').text).toBe('`x`')
  })
})
