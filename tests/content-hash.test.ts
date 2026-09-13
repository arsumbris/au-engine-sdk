// The lockstep guard for the content-hash mirror. `contentHash` must reproduce
// every `input`->`hash` pair the engine publishes, or the mirror has drifted from
// `ContentHash::of`. The vector file is VENDORED from au-engine
// (`crates/au-engine/content-hash-vectors.json`); the engine's own
// `content_hash_vector_tests` pins the same file on its side, so the algorithm
// cannot change without breaking both builds. Re-copy this fixture when the
// engine coordinates an algorithm change.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { contentHash, fnv1a64 } from '../src/content-hash.ts'

interface Vector {
  input: string
  hash: string
}
interface VectorFile {
  algorithm: string
  vectors: Vector[]
}

const here = path.dirname(fileURLToPath(import.meta.url))
const vectorFile: VectorFile = JSON.parse(
  fs.readFileSync(path.join(here, 'content-hash-vectors.json'), 'utf8'),
)

describe('contentHash (FNV-1a-64 mirror, verified against the engine vector)', () => {
  it('has vectors to check (the fixture parsed and is non-empty)', () => {
    expect(vectorFile.vectors.length).toBeGreaterThan(0)
  })

  // The UTF-8 bytes of `input` are what the engine hashes ("over the raw bytes of
  // the UTF-8-encoded `input`"), so encode, don't hash code units. This covers
  // the empty string (offset basis), multibyte `café`, and a frontmatter file.
  for (const { input, hash } of vectorFile.vectors) {
    it(`matches the engine hash for ${JSON.stringify(input)}`, () => {
      const bytes = new TextEncoder().encode(input)
      expect(contentHash(bytes)).toBe(hash)
    })
  }

  it('renders 16 lowercase hex digits, zero-padded', () => {
    for (const { input, hash } of vectorFile.vectors) {
      expect(hash).toMatch(/^[0-9a-f]{16}$/)
      expect(contentHash(new TextEncoder().encode(input))).toMatch(/^[0-9a-f]{16}$/)
    }
  })

  it('exposes the raw u64 as a bigint via fnv1a64 (for a caller wanting the value)', () => {
    expect(fnv1a64(new Uint8Array())).toBe(0xcbf29ce484222325n) // the offset basis
    expect(fnv1a64(new TextEncoder().encode('a'))).toBe(0xaf63dc4c8601ec8cn)
  })
})
