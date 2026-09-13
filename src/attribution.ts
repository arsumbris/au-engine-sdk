// The `attribution` write rider (WIRE.md, the Attribution rider), carried by
// `write_file` / `edit_file` / `delete_file`: an optional LIST of `{ key, value }`
// trailers the engine folds into the mutation's commit beside `Mutation-Id`,
// VERBATIM and UNINTERPRETED. A `session` / `span` stays a caller concept and the
// engine stays domain-pure; read back by `commit_meta`'s `trailers`.
//
// Pure interface + pure function, no node imports — renderer-safe (`./reads`
// re-exports it, so `AttributionEntry` is reachable from the DOM-free renderer
// surface as well as the node root export). Sits beside `stamps.ts` and
// `ensure-mixins.ts` as the third write rider.
//
// The wire shape `{ key, value }` is already flat (no camelCase transform, unlike
// `stamps`' `matchOn`), so the consumer type IS the wire trailer shape — see
// `WireTrailer` in `./reads`, which this and `commit_meta.trailers` share. The
// normalizer exists only for the absent/empty omission rule.

/**
 * One entry of the `attribution` write rider: a `{ key, value }` trailer folded
 * into the mutation's commit. The read-back twin is `WireTrailer` on
 * `commit_meta.trailers`.
 *
 * The engine enforces (NOT the SDK): `key` must be a well-formed trailer token
 * (non-empty, no `:` or newline; `value` carries no newline) and may NOT collide
 * with a reserved engine key (`Mutation-Id` / `Mutation-Members` / `Moved` /
 * `Reverts` / `Traced`, case-insensitive). A malformed or reserved-colliding key
 * REJECTS the whole mutation before any write — an `error` frame — so nothing
 * lands half-attributed.
 *
 * ADVISORY, trace-tier: a trailer is unsigned free text, forgeable, and its
 * `sha`-mapping rides the append-only invariant, so a consumer treats read-back
 * attribution as a claim, not proof.
 */
export interface AttributionEntry {
  key: string
  value: string
}

/**
 * Normalize a consumer-facing `attribution` request rider to the wire field on
 * `write_file` / `edit_file` / `delete_file`, so each carrying verb spreads
 * `...toWireAttribution(...)`. An absent OR empty list omits the key entirely —
 * absent = empty = no attribution, per the wire (writes no trailer). The pairs
 * pass through verbatim; the engine validates and folds them.
 */
export function toWireAttribution(
  attribution?: AttributionEntry[],
): { attribution: AttributionEntry[] } | Record<string, never> {
  if (attribution === undefined || attribution.length === 0) return {}
  return { attribution: attribution.map((entry) => ({ key: entry.key, value: entry.value })) }
}
