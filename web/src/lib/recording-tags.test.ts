import { expect, test } from 'bun:test'
import { addRecordingTags } from './recording-tags'

test('adds trimmed comma-separated tags and ignores blank or duplicate entries', () => {
  expect(addRecordingTags(['Work'], ' work, Meeting, ,meeting, Idea ')).toEqual(['Work', 'Meeting', 'Idea'])
})

test('preserves existing tags, spelling, and star state without mutating the source', () => {
  const tags = ['Starred', 'R&D']
  expect(addRecordingTags(tags, 'starred, Product roadmap')).toEqual(['Starred', 'R&D', 'Product roadmap'])
  expect(tags).toEqual(['Starred', 'R&D'])
  expect(addRecordingTags([], ' , ')).toEqual([])
})
