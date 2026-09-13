import { describe, expect, it } from 'vitest'

import { byteRangeToPositions, byteToPosition, makeByteToPosition } from '../src/positions.ts'

describe('byteToPosition', () => {
  it('maps ASCII offsets 1:1 with line/character/offset', () => {
    const text = 'abc\ndef\nghi'
    expect(byteToPosition(text, 0)).toEqual({ line: 0, character: 0, offset: 0 })
    expect(byteToPosition(text, 2)).toEqual({ line: 0, character: 2, offset: 2 })
    // The newline itself sits at the end of its line.
    expect(byteToPosition(text, 3)).toEqual({ line: 0, character: 3, offset: 3 })
    // Just past the newline opens the next line at column 0.
    expect(byteToPosition(text, 4)).toEqual({ line: 1, character: 0, offset: 4 })
    expect(byteToPosition(text, 8)).toEqual({ line: 2, character: 0, offset: 8 })
  })

  it('shifts the column for a multi-byte codepoint (em-dash: 3 bytes / 1 UTF-16 unit)', () => {
    const text = 'a—b' // 'a' (1 byte) '—' (3 bytes) 'b' (1 byte) = 5 bytes, 3 UTF-16 units
    expect(byteToPosition(text, 0)).toEqual({ line: 0, character: 0, offset: 0 })
    // Byte 1 = start of the em-dash → UTF-16 column 1.
    expect(byteToPosition(text, 1)).toEqual({ line: 0, character: 1, offset: 1 })
    // Byte 4 = the 'b', three bytes past the dash but only one UTF-16 unit.
    expect(byteToPosition(text, 4)).toEqual({ line: 0, character: 2, offset: 2 })
  })

  it('counts an astral codepoint as 2 UTF-16 units / 4 bytes', () => {
    const text = '😀x' // emoji (4 bytes, 2 UTF-16 units) then 'x'
    expect(byteToPosition(text, 0)).toEqual({ line: 0, character: 0, offset: 0 })
    expect(byteToPosition(text, 4)).toEqual({ line: 0, character: 2, offset: 2 })
  })

  it('snaps an offset inside a multi-byte codepoint to that codepoint start', () => {
    const text = 'a—b'
    // Bytes 2 and 3 fall inside the em-dash; both snap to its start (column 1).
    expect(byteToPosition(text, 2)).toEqual({ line: 0, character: 1, offset: 1 })
    expect(byteToPosition(text, 3)).toEqual({ line: 0, character: 1, offset: 1 })
  })

  it('clamps out-of-range offsets to start and end', () => {
    const text = 'abc\ndef'
    expect(byteToPosition(text, -5)).toEqual({ line: 0, character: 0, offset: 0 })
    // >= byte length → end position (after the last char of the last line).
    expect(byteToPosition(text, 7)).toEqual({ line: 1, character: 3, offset: 7 })
    expect(byteToPosition(text, 999)).toEqual({ line: 1, character: 3, offset: 7 })
  })

  it('handles empty text', () => {
    expect(byteToPosition('', 0)).toEqual({ line: 0, character: 0, offset: 0 })
    expect(byteToPosition('', 5)).toEqual({ line: 0, character: 0, offset: 0 })
  })

  it('places a trailing-newline end at the start of the empty final line', () => {
    const text = 'abc\n'
    expect(byteToPosition(text, 4)).toEqual({ line: 1, character: 0, offset: 4 })
  })
})

describe('makeByteToPosition', () => {
  it('reuses one index across many lookups, matching the one-shot form', () => {
    const text = 'héllo\nwörld' // 'é' and 'ö' are 2 bytes / 1 UTF-16 unit each
    const map = makeByteToPosition(text)
    for (const byte of [0, 1, 2, 3, 6, 7, 8]) {
      expect(map(byte)).toEqual(byteToPosition(text, byte))
    }
  })
})

describe('byteRangeToPositions', () => {
  it('maps both endpoints of a byte range', () => {
    const text = 'one\ntwo\nthree'
    expect(byteRangeToPositions(text, { start: 4, end: 7 })).toEqual({
      start: { line: 1, character: 0, offset: 4 },
      end: { line: 1, character: 3, offset: 7 },
    })
  })
})
