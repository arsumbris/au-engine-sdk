// The engine's content-hash algorithm, mirrored client-side.
//
// The engine (au-engine `crates/au-engine/src/ir.rs`, `ContentHash::of`) owns the
// algorithm: FNV-1a 64-bit over a file's raw bytes, rendered as 16 lowercase hex
// digits. WIRE.md ("Content hash") blesses it as a DECLARED SDK contract — a
// consumer holding a file's bytes computes the identical hash LOCALLY, with no
// engine round-trip, to arm read-before-write CAS. The engine's write floor still
// compares its own authoritative hash at write time, so correctness is unchanged.
//
// This is the canonical TS mirror. Keep it in lockstep with the engine — the
// vector corpus in `tests/content-hash.test.ts` (vendored from the engine's
// `content-hash-vectors.json`) is the drift guard. The algorithm MAY migrate
// later (e.g. to a git blob oid) but only as a COORDINATED change: the vector
// file and this mirror update together, never silently.
//
// u64 exceeds JS `number` precision (2^53), so the arithmetic is BigInt, masked
// back to 64 bits after each multiply. A plain-number implementation silently
// corrupts the hash.
//
// Renderer-safe (`./content-hash`): a pure function, no node imports, DOM-free.

const U64_MASK = 0xffffffffffffffffn
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n

/**
 * The FNV-1a-64 of a byte string, as a wrapping u64. `hash = offset_basis`; for
 * each byte `b`: `hash = (hash ^ b) * prime`, masked to 64 bits each step.
 * Mirrors the engine's `ContentHash::of` exactly. Exported as a bigint for a
 * caller that wants the numeric value; most callers want `contentHash`.
 */
export function fnv1a64(bytes: Uint8Array): bigint {
  let hash = FNV_OFFSET_BASIS
  for (const b of bytes) {
    hash ^= BigInt(b)
    hash = (hash * FNV_PRIME) & U64_MASK
  }
  return hash
}

/**
 * A file's content hash: the FNV-1a-64 of its raw bytes, as 16 lowercase
 * zero-padded hex digits — the identical string the engine renders where the
 * hash crosses the wire (e.g. the `content` read's `hash`). Pass the file's
 * bytes; hash them locally to arm read-before-write CAS without an engine
 * round-trip. Mirrors au-engine `ContentHash::of` (`ir.rs`), the blessed SDK
 * contract in WIRE.md.
 */
export function contentHash(bytes: Uint8Array): string {
  return fnv1a64(bytes).toString(16).padStart(16, '0')
}
