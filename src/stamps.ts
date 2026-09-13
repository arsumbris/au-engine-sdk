// The `stamps` write rider, shared by the mutate verbs and the `preview_mutation`
// read. The one point that mirrors the wire's snake_case for the rider.
//
// Pure interface + pure function, no node imports — renderer-safe (`./reads`
// re-exports it, so `Stamp` is reachable from the DOM-free renderer surface as
// well as the node root export). Kept out of `client.ts` so the renderer-safe
// `preview_mutation` read helper can reuse the same normalizer.

/**
 * One entry of the `stamps` write rider (WIRE.md, the Stamps rider), carried as a
 * LIST by every write-mutation verb EXCEPT `deleteFile` and `renameType`: a
 * caller-supplied record the engine idempotently ensures into a named frontmatter
 * list-field of the file the write touches, all folded into the write's OWN
 * commit. The stamped file is the verb's primary file (`rename` the destination
 * `to`, `promote` the new `to`, `inline` the host `into`, every other verb its
 * `path`).
 *
 * The list applies IN ORDER, each entry seeing the effect of the ones before it:
 * DIFFERENT fields are independent ensures; the SAME field takes N order-stable
 * appends into one list, each deduped by its own `matchOn`. The SDK carries the
 * shape, not the semantics.
 *
 * OPAQUE to the engine: it validates nothing about `field` / `record` /
 * `matchOn`'s meaning; a record violating the field's declared type is an
 * ordinary advisory diagnostic on the next build, never a rejection.
 * Un-forgeability is the mediator's (the sole write path), not the engine's.
 */
export interface Stamp {
  /** The frontmatter sequence key the record is ensured into. */
  field: string
  /**
   * The record to ensure: an arbitrary structured value, rendered to YAML by
   * the engine. Opaque — the engine reads none of its meaning.
   */
  record: unknown
  /**
   * The optional dedup predicate, a map of element-slot to value. With it, the
   * stamp is a NO-OP when some existing element of `field` carries every pair;
   * else `record` is appended. Without it, `record` is always appended. A key
   * names a top-level element slot; the key `type` matches the element's `type:`
   * CLAIM, not a field. Serialized as `match_on` on the wire.
   */
  matchOn?: Record<string, unknown>
}

/**
 * Normalize a consumer-facing `Stamp[]` to the wire stamps rider (each element's
 * `matchOn` → `match_on`, `record` passed through opaque). The single point that
 * mirrors the wire's snake_case for the rider, so each carrying verb (and the
 * `preview_mutation` read) spreads `...toWireStamps(stamps)`. An absent OR empty
 * list omits the key entirely — absent = empty = no stamp, per the wire.
 */
export function toWireStamps(stamps?: Stamp[]): { stamps: Array<{ field: string; record: unknown; match_on?: Record<string, unknown> }> } | Record<string, never> {
  if (stamps === undefined || stamps.length === 0) return {}
  return {
    stamps: stamps.map((stamp) => ({
      field: stamp.field,
      record: stamp.record,
      ...(stamp.matchOn !== undefined ? { match_on: stamp.matchOn } : {}),
    })),
  }
}
