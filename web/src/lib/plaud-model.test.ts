import { describe, expect, test } from 'bun:test'
import { needsManualSerial, plaudModelFromSerial, plaudModelFromSourceId, plaudModelImage, plaudModelName } from './plaud-model'

describe('Plaud model helpers', () => {
  test('resolve the model from 16- and 18-character serials', () => {
    expect(plaudModelFromSerial('888000000000000101')).toBe('note')
    expect(plaudModelFromSerial('8810000000000001')).toBe('notepro')
    expect(plaudModelFromSerial('8830000000000001')).toBe('notepro')
    expect(plaudModelFromSerial('9990000000000001')).toBeNull()
    expect(plaudModelFromSerial('not-a-serial')).toBeNull()
    expect(plaudModelFromSerial(null)).toBeNull()
  })

  test('read the model from a vault provenance id', () => {
    expect(plaudModelFromSourceId('888000000000000101:1700000000')).toBe('note')
    expect(plaudModelFromSourceId('8810000000000001:42')).toBe('notepro')
    expect(plaudModelFromSourceId(undefined)).toBeNull()
  })

  test('name and picture each model', () => {
    expect(plaudModelName('note')).toBe('Plaud Note')
    expect(plaudModelName('notepro')).toBe('Plaud Note Pro')
    expect(plaudModelName(null)).toBeNull()
    expect(plaudModelImage('note')).toBe('/plaud-note.png')
    expect(plaudModelImage('notepro')).toBe('/plaud-note-pro.png')
    expect(plaudModelImage(null)).toBe('/plaud-note-pro.png')
  })

  test('ask for a manual serial only when a Plaud Note reports a short one', () => {
    expect(needsManualSerial('note', '888000000000000101')).toBe(false)
    expect(needsManualSerial('note', '8880000000000001')).toBe(true)
    expect(needsManualSerial('note', null)).toBe(true)
    expect(needsManualSerial('notepro', '8810000000000001')).toBe(false)
  })
})
