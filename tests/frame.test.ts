import { describe, expect, it } from 'vitest'

import { DEFAULT_MAX_FRAME_BYTES, encodeFrame, FrameDecoder, FrameTooLargeError } from '../src/frame.ts'

describe('encodeFrame', () => {
  it('prefixes the JSON body with its big-endian byte length', () => {
    const message = { read: 'ready' }
    const encoded = encodeFrame(message)
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    expect(encoded.readUInt32BE(0)).toBe(body.length)
    expect(encoded.subarray(4).equals(body)).toBe(true)
  })

  it('measures multi-byte characters in bytes, not code units', () => {
    const message = { read: 'content', path: 'näme — ünïcode.md' }
    const encoded = encodeFrame(message)
    expect(encoded.readUInt32BE(0)).toBe(Buffer.byteLength(JSON.stringify(message), 'utf8'))
  })
})

describe('FrameDecoder', () => {
  it('roundtrips a single frame', () => {
    const decoder = new FrameDecoder()
    const message = { type: 'response', schema_version: 2, ready: true, version: 7, result: { a: 1 } }
    expect(decoder.push(encodeFrame(message))).toEqual([message])
  })

  it('reassembles a frame split across chunks, including a split prefix', () => {
    const decoder = new FrameDecoder()
    const message = { type: 'change_event', subscription_id: 3, kind: 'graph', at_version: 12 }
    const encoded = encodeFrame(message)
    // Split inside the 4-byte prefix, then inside the body.
    expect(decoder.push(encoded.subarray(0, 2))).toEqual([])
    expect(decoder.push(encoded.subarray(2, 9))).toEqual([])
    expect(decoder.push(encoded.subarray(9))).toEqual([message])
  })

  it('yields every frame when one chunk carries several', () => {
    const decoder = new FrameDecoder()
    const a = { type: 'ack', subscription_id: 1, channel: 'graph', accepted: true }
    const b = { type: 'initial_value', subscription_id: 1, at_version: 4, result: null }
    const chunk = Buffer.concat([encodeFrame(a), encodeFrame(b)])
    expect(decoder.push(chunk)).toEqual([a, b])
  })

  it('yields a complete frame and buffers the trailing partial', () => {
    const decoder = new FrameDecoder()
    const a = { type: 'response', ready: true }
    const b = { type: 'response', ready: false }
    const second = encodeFrame(b)
    const chunk = Buffer.concat([encodeFrame(a), second.subarray(0, 5)])
    expect(decoder.push(chunk)).toEqual([a])
    expect(decoder.push(second.subarray(5))).toEqual([b])
  })

  it('drops an unparseable body and keeps decoding', () => {
    const decoder = new FrameDecoder()
    const garbage = Buffer.from('not json', 'utf8')
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32BE(garbage.length, 0)
    const next = { type: 'response', ready: true }
    const chunk = Buffer.concat([prefix, garbage, encodeFrame(next)])
    expect(decoder.push(chunk)).toEqual([next])
  })

  it('throws on a length prefix over the cap, before buffering the body', () => {
    const decoder = new FrameDecoder(1024)
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32BE(2048, 0)
    // Only the prefix is fed — no body — yet it must reject immediately.
    expect(() => decoder.push(prefix)).toThrowError(FrameTooLargeError)
  })

  it('rejects an oversize prefix split across chunks once the 4 bytes land', () => {
    const decoder = new FrameDecoder(1024)
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32BE(0xffffffff, 0)
    expect(decoder.push(prefix.subarray(0, 3))).toEqual([])
    expect(() => decoder.push(prefix.subarray(3))).toThrow(/exceeds maximum 1024/)
  })

  it('accepts a frame exactly at the cap', () => {
    const message = { type: 'response', ready: true }
    const encoded = encodeFrame(message)
    const decoder = new FrameDecoder(encoded.length - 4)
    expect(decoder.push(encoded)).toEqual([message])
  })

  it('reassembles a large frame fed in many small chunks', () => {
    const decoder = new FrameDecoder()
    // A multi-KiB body, so the frame spans far more chunks than the fast path.
    const message = { type: 'response', ready: true, version: 1, result: 'x'.repeat(8192) }
    const encoded = encodeFrame(message)

    const out: unknown[] = []
    for (let i = 0; i < encoded.length; i += 64) {
      out.push(...decoder.push(encoded.subarray(i, i + 64)))
    }
    expect(out).toEqual([message])
  })

  it('interleaves complete and spanning frames across chunks', () => {
    const decoder = new FrameDecoder()
    const a = { type: 'response', ready: true, version: 1 }
    const big = { type: 'initial_value', subscription_id: 1, at_version: 2, result: 'y'.repeat(4096) }
    const stream = Buffer.concat([encodeFrame(a), encodeFrame(big)])

    // First chunk carries all of `a` plus a slice of `big`'s prefix; the rest
    // dribbles in. `a` decodes immediately, `big` once its bytes complete.
    const first = stream.subarray(0, encodeFrame(a).length + 2)
    expect(decoder.push(first)).toEqual([a])
    const out: unknown[] = []
    for (let i = first.length; i < stream.length; i += 100) {
      out.push(...decoder.push(stream.subarray(i, i + 100)))
    }
    expect(out).toEqual([big])
  })

  it('defaults the cap to 64 MiB', () => {
    expect(DEFAULT_MAX_FRAME_BYTES).toBe(64 * 1024 * 1024)
  })
})
