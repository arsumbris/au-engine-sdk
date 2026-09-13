// Pure byte-offset → text-position conversion.
//
// Engine wire spans are UTF-8 byte offsets — the payload self-describes this
// (`byte_offset_encoding: "utf-8"`). Consumers render those spans into JS
// string buffers, whose columns are UTF-16 code units (what CodeMirror and
// VS Code both address by). For pure-ASCII text the two coincide; a multi-byte
// codepoint (an em-dash `—` is 3 bytes / 1 code unit, an emoji 4 bytes / 2)
// shifts the column. This module bridges the two, with no DOM or editor
// coupling — every consumer that renders a span needs it, so it lives once
// here rather than re-derived per consumer.
//
// Coordinates are 0-indexed and JS-native, deliberately distinct from the
// wire's `WireLineCol` (1-based line, UTF-8-byte column): use these for an
// editor buffer, use a read's `line_col` when you want the engine's own
// 1-based rendering. `offset` is the absolute UTF-16 index — what CodeMirror
// addresses by directly, so the host need not recombine `line` + `character`.
//
// Pure functions, type-only imports — renderer-safe (re-exported through the
// `./reads` subpath, beside the span types these offsets index into).

import type { WireByteRange } from './reads.ts'

/**
 * A position in a JS string buffer, all 0-indexed and UTF-16-native:
 * - `line` — newline count before the offset.
 * - `character` — UTF-16 code-unit column from the line start (a VS Code /
 *   CodeMirror column).
 * - `offset` — absolute UTF-16 code-unit index (a CodeMirror document offset).
 */
export interface BytePosition {
  line: number
  character: number
  offset: number
}

/** Both endpoints of a byte range as positions. */
export interface BytePositionRange {
  start: BytePosition
  end: BytePosition
}

/** UTF-8 byte length of a Unicode code point. */
function utf8Len(codePoint: number): number {
  if (codePoint < 0x80) return 1
  if (codePoint < 0x800) return 2
  if (codePoint < 0x10000) return 3
  return 4
}

/**
 * Pre-index `text` once, returning a converter from a UTF-8 byte offset to a
 * {@link BytePosition}. Use this form when mapping many offsets on one buffer
 * (e.g. every token or backlink span per fetch): the O(n) index is built once,
 * each lookup is then O(log n). For a single offset, {@link byteToPosition} is
 * the one-shot wrapper.
 *
 * Out-of-range offsets clamp: `<= 0` → the start, `>= text`'s byte length →
 * the end. An offset landing inside a multi-byte codepoint snaps to that
 * codepoint's start (engine spans never do this, but the clamp is total).
 */
export function makeByteToPosition(text: string): (byteOffset: number) => BytePosition {
  // Parallel arrays, one entry per codepoint boundary (plus a leading 0):
  // the cumulative byte offset, the cumulative UTF-16 offset, the line at that
  // boundary, and the UTF-16 offset the line started at.
  const byteAt = [0]
  const charAt = [0]
  const lineAt = [0]
  const lineStart = [0]
  let b = 0
  let c = 0
  let line = 0
  let ls = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    b += utf8Len(cp)
    c += ch.length
    if (cp === 0x0a) {
      // A newline ends its line; the boundary after it opens the next one at
      // column 0, so a position just past the `\n` reads as the next line's start.
      line += 1
      ls = c
    }
    byteAt.push(b)
    charAt.push(c)
    lineAt.push(line)
    lineStart.push(ls)
  }
  const totalBytes = b
  const last = byteAt.length - 1
  return (byteOffset: number): BytePosition => {
    if (byteOffset <= 0) return { line: 0, character: 0, offset: 0 }
    if (byteOffset >= totalBytes) {
      return { line: lineAt[last], character: charAt[last] - lineStart[last], offset: charAt[last] }
    }
    // Largest boundary whose byte offset is <= the query.
    let lo = 0
    let hi = last
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (byteAt[mid] <= byteOffset) lo = mid
      else hi = mid - 1
    }
    return { line: lineAt[lo], character: charAt[lo] - lineStart[lo], offset: charAt[lo] }
  }
}

/**
 * Convert one UTF-8 byte offset into `text` to a {@link BytePosition}. A
 * one-shot wrapper over {@link makeByteToPosition}; for many lookups on the
 * same buffer, build the factory once instead — this rebuilds the index each call.
 */
export function byteToPosition(text: string, byteOffset: number): BytePosition {
  return makeByteToPosition(text)(byteOffset)
}

/**
 * Convert a byte range (a {@link WireByteRange}, e.g. a `WireSpan` or a
 * backlink's `{ span_start, span_end }`) to its two endpoint positions. Builds
 * one index for the pair; for many ranges on a buffer, hold a
 * {@link makeByteToPosition} converter and map both endpoints yourself.
 */
export function byteRangeToPositions(text: string, span: WireByteRange): BytePositionRange {
  const map = makeByteToPosition(text)
  return { start: map(span.start), end: map(span.end) }
}
