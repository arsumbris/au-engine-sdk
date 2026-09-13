// Frame codec per au-engine `crates/au-engine/WIRE.md`.
//
// Each message is a 4-byte big-endian length prefix, then that many bytes
// of JSON. Pure byte-level framing, no socket knowledge — the client wires
// it to the connection. Node-only (Buffer), root export.

/** Encode a message as one wire frame: length prefix plus JSON body. */
export function encodeFrame(message: object): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(body.length, 0)
  return Buffer.concat([prefix, body])
}

/** Default cap on one frame's body: 64 MiB. Override per-decoder for larger reads. */
export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024

/**
 * A frame's length prefix exceeded the decoder's cap. The prefix is read
 * before the body is buffered, so this fires without allocating for the
 * oversized frame — but the stream is now desynced past recovery, so the
 * caller must drop the connection rather than continue decoding.
 */
export class FrameTooLargeError extends Error {
  readonly name = 'FrameTooLargeError'
  // Explicit fields, not parameter properties: node's strip-only type stripping
  // (the documented plain-node path) rejects parameter properties.
  readonly length: number
  readonly max: number
  constructor(length: number, max: number) {
    super(`frame length ${length} exceeds maximum ${max}`)
    this.length = length
    this.max = max
  }
}

/**
 * Incremental frame decoder. Feed it chunks as they arrive; it buffers
 * partial frames and yields the JSON value of every completed one.
 * A body that fails to parse is skipped — the stream stays usable.
 * A length prefix over the cap throws `FrameTooLargeError`: the only
 * unrecoverable case, since a desynced prefix mis-frames everything after.
 */
export class FrameDecoder {
  // Chunks are buffered as received, never recopied on arrival. A single
  // growing `Buffer.concat` per push is O(n²) while a large frame accumulates
  // across many chunks; deferring the copy until a whole frame has landed
  // makes reassembly O(frame size) instead.
  private chunks: Buffer[] = []
  private buffered = 0
  // Explicit field, not a parameter property: node's strip-only type stripping
  // (the documented plain-node path) rejects parameter properties.
  private readonly maxFrameBytes: number

  constructor(maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES) {
    this.maxFrameBytes = maxFrameBytes
  }

  push(chunk: Buffer): unknown[] {
    if (chunk.length > 0) {
      this.chunks.push(chunk)
      this.buffered += chunk.length
    }
    const values: unknown[] = []
    while (this.buffered >= 4) {
      const length = this.readPrefix()
      // Checked against the cap before the body is materialized, so an
      // oversized frame allocates nothing (the stream is then unrecoverable).
      if (length > this.maxFrameBytes) throw new FrameTooLargeError(length, this.maxFrameBytes)
      if (this.buffered < 4 + length) break
      const frame = this.take(4 + length)
      try {
        values.push(JSON.parse(frame.toString('utf8', 4)))
      } catch {
        // Unparseable body: drop the frame, keep the stream.
      }
    }
    return values
  }

  /** The big-endian uint32 length prefix, reading across chunk boundaries. */
  private readPrefix(): number {
    let value = 0
    let read = 0
    for (const chunk of this.chunks) {
      for (let i = 0; i < chunk.length && read < 4; i++, read++) {
        value = value * 256 + chunk[i]
      }
      if (read >= 4) break
    }
    return value
  }

  /** Consume exactly `n` bytes from the front, returning them as one Buffer. */
  private take(n: number): Buffer {
    this.buffered -= n
    // Fast path: the leading chunk already holds the whole frame — slice it,
    // no copy, and keep the remainder as the new leading chunk.
    const head = this.chunks[0]
    if (head.length >= n) {
      if (head.length === n) this.chunks.shift()
      else this.chunks[0] = head.subarray(n)
      return head.subarray(0, n)
    }
    // Spanning path: copy just this frame's bytes out of the leading chunks.
    const out = Buffer.allocUnsafe(n)
    let offset = 0
    while (offset < n) {
      const chunk = this.chunks[0]
      const want = n - offset
      if (chunk.length <= want) {
        chunk.copy(out, offset)
        offset += chunk.length
        this.chunks.shift()
      } else {
        chunk.copy(out, offset, 0, want)
        this.chunks[0] = chunk.subarray(want)
        offset += want
      }
    }
    return out
  }
}
