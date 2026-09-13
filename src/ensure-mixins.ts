// The `ensure_mixins` write rider (WIRE.md, the Ensure-mixins rider, schema 25),
// the type-claim analog of the `stamps` rider: it ensures a `::repo`-qualified
// mixin on the written file's `type:` CLAIM, folded into the write's OWN commit.
// Carried by `write_file` / `edit_file` / `rename` only.
//
// Pure interface + pure function, no node imports — renderer-safe (`./reads`
// re-exports it, so `EnsureMixinOutcome` is reachable from the DOM-free renderer
// surface as well as the node root export). Sits beside `stamps.ts` as the other
// write rider.

/**
 * One entry of the response `ensure_mixins` report (WIRE.md, the Ensure-mixins
 * rider): the per-mixin outcome of a write that carried the rider. Present on a
 * `WireMutateResult` only when the write requested mixins; a STRICT reject is the
 * ordinary `error` frame instead, never this.
 *
 * The SDK carries the shape, not the semantics. The engine resolves each mixin
 * against the written file's `type:` claim closure and reports:
 * - `no_op` — the closure already includes the mixin (claimed directly, or a
 *   claimed type extends it), so nothing was written.
 * - `applied` — the name was appended to `type:` (or a `type: <mixin>` claim was
 *   created on a claimless note), introducing no new error-severity diagnostic.
 * - `skipped` — the mixin was UN-APPLIABLE (unresolvable/non-dependency repo,
 *   non-claimable target, mixin-collision, newly-unmet required field) and
 *   `ensure_mixins_strict` was LENIENT, so the write landed and the mixin was
 *   dropped. `reason` names why. A lenient skip is never silent.
 */
export interface EnsureMixinOutcome {
  /** The `::repo`-qualified type name the rider requested, echoed back. */
  mixin: string
  /** The engine's disposition for this mixin. */
  outcome: 'applied' | 'no_op' | 'skipped'
  /** Why a `skipped` mixin was un-appliable. Present on `skipped`, absent otherwise. */
  reason?: string
}

/**
 * Normalize a consumer-facing `ensure_mixins` request rider to the wire fields on
 * `write_file` / `edit_file` / `rename`, so each carrying verb spreads
 * `...toWireEnsureMixins(...)`. An absent OR empty mixin list omits BOTH keys
 * entirely — absent = empty = no mixin, per the wire, and `ensure_mixins_strict`
 * is meaningless without mixins. When mixins are present, `strict` is forwarded
 * only if the caller set it; omitted, the engine applies its own default (true).
 */
export function toWireEnsureMixins(
  ensureMixins?: string[],
  strict?: boolean,
): { ensure_mixins: string[]; ensure_mixins_strict?: boolean } | Record<string, never> {
  if (ensureMixins === undefined || ensureMixins.length === 0) return {}
  return {
    ensure_mixins: ensureMixins,
    ...(strict !== undefined ? { ensure_mixins_strict: strict } : {}),
  }
}
