// Result types for the daemon's read catalog, per au-engine
// `crates/au-engine/WIRE.md` (schema_version 29) and the serde shapes in
// `crates/au-engine/src/{wire,serve}.rs` / `au-diagnostics` / `au-references`.
//
// The result envelope (schema 17): every read's `result` is an object carrying
// its payload under the read's OWN name, reached uniformly as `result[verb]`.
// The typed helpers unwrap it through one generic accessor in `./read-helpers`;
// the result types below are the UNWRAPPED payloads (except the few that keep
// envelope-level metadata siblings — `instances`, `candidates`, `subtypes`).
//
// The engine is the source of truth for these shapes.
// Names stay snake_case, as on the wire; consumers normalize at their edge.
//
// Optionality mirrors serde exactly:
// - a field serde skips when absent/empty is optional (`?:`)
// - a plain `Option` field is present-but-nullable (`| null`)
//
// Closed enum sets are typed as literal unions; consumers must still
// tolerate unknown values per additive wire evolution.
//
// Types and pure shapes only — this module is renderer-safe (`./reads`
// subpath, no node imports). The typed helpers over these shapes live in
// `./read-helpers.ts`, re-exported here so the subpath is the one
// read surface. The pure byte-offset → position converter for the spans
// these reads carry lives in `./positions.ts`, re-exported the same way.

export * from './read-helpers.ts'
export * from './positions.ts'
// The `stamps` write rider shape, shared by the mutate verbs (`./` root) and the
// `preview_mutation` read helper. Pure + renderer-safe, so it rides the `./reads`
// subpath alongside the read surface.
export * from './stamps.ts'
// The `ensure_mixins` write rider (schema 25), the type-claim analog of `stamps`,
// carried by `write_file` / `edit_file` / `rename`. Pure + renderer-safe, so the
// response outcome type (`WireMutateResult.ensure_mixins`) rides `./reads` too.
export * from './ensure-mixins.ts'
// The `attribution` write rider (schema 26), the third write rider beside
// `stamps` / `ensure_mixins`, carried by `write_file` / `edit_file` /
// `delete_file`. Pure + renderer-safe; its `{ key, value }` shape is the twin of
// `commit_meta`'s `trailers` (`WireTrailer`), so it rides `./reads` too.
export * from './attribution.ts'
// `export *` re-exports but does not bind locally; `WireMutateResult` uses the
// type directly, so import it explicitly too.
import type { EnsureMixinOutcome } from './ensure-mixins.ts'

// ---------------------------------------------------------------------------
// Spans

/** A 1-based line/column position. `col` counts UTF-8 bytes from the line start, plus one. */
export interface WireLineCol {
  line: number
  col: number
}

/** Both endpoints of a byte range as line/column. */
export interface WireLineColRange {
  start: WireLineCol
  end: WireLineCol
}

/** Half-open UTF-8 byte range into a single file. */
export interface WireByteRange {
  start: number
  end: number
}

/**
 * The common span shape: canonical byte offsets plus the derived line/column
 * rendering. `line_col` is absent for spans into files the build never read.
 */
export interface WireSpan extends WireByteRange {
  line_col?: WireLineColRange
}

/** Where a type-def or meta sub-region lives in source. */
export interface WireSourceLoc {
  file: string
  span: WireSpan
}

// ---------------------------------------------------------------------------
// The shared parse-kind vocabulary

/**
 * How the build parsed a catalogued file — ONE vocabulary across every read
 * that serves a file's kind: `hubs.kind`, a `neighborhood` node's `file_kind`,
 * and `files.kind`. The engine derives all three from one function
 * (`crates/au-engine/src/parse.rs::served_file_kind`), so the vocabulary cannot
 * drift between them; this single type is the mirror of that.
 *
 * - `instance` — a file carrying a `type:` claim.
 * - `type-def` — a type definition.
 * - `note` — a markdown file the build DID read and found no `type:` on.
 * - `asset` — a catalogued file the build NEVER read. Recorded by path alone,
 *   precisely so `file*` resolves against it. Distinct from `note`: an unread
 *   PDF is not prose, and reporting it as one ranked it as a hub and described
 *   it wrong.
 *
 * NOT `WireFileKind`, which is `resolve_target`'s classification
 * (`type-def` / `instance` / `repo-registry` / `workspace` / `repo-lock` /
 * `unclassified`) and answers a different question. The two collide only in the
 * English word "kind".
 *
 * Closed set; consumers still tolerate unknown values per additive evolution.
 */
export type WireParseKind = 'instance' | 'type-def' | 'note' | 'asset'

// ---------------------------------------------------------------------------
// diagnostics

/**
 * A diagnostic's severity. `drift` is its own tier, ranked between `error` and
 * `warning` (above an ordinary warning, below an error): it flags a diverged
 * edge that still resolves — a commit-pinned reference whose live counterpart at
 * HEAD moved (`pinned-reference-drifted`). Advisory, never a hard failure. The
 * `diagnostics` read/channel `severity` filter accepts it like any other value.
 */
export type WireDiagnosticSeverity = 'error' | 'drift' | 'warning' | 'hint'

/** A diagnostic's span: the file beside the range, unlike the embedded `WireSpan`. */
export interface WireDiagnosticSpan {
  file: string
  range: WireByteRange
  line_col?: WireLineColRange
}

/** Advisory text only — never auto-applied. */
export interface WireSuggestedFix {
  description: string
}

/**
 * The cross-repo diagnostic codes, a switching aid for consumers reading
 * `WireDiagnostic.code`. NOT exhaustive and NOT closed: `code` stays a bare
 * `string` because the engine's catalog is larger and grows additively, so a
 * consumer must tolerate unknown values. These are the codes the cross-repo
 * type-resolution surface introduced or extended to fire across a repo
 * boundary; see au-engine `crates/au-core/src/codes.rs`.
 */
export type WireCrossRepoDiagnosticCode =
  | 'reference-repo-unknown'
  | 'reference-repo-unavailable'
  | 'reference-target-type-mismatch'
  | 'wikilink-empty-repo'
  | 'wikilink-fragment-order'
  | 'undeclared-peer'
  | 'peer-unmounted'
  | 'peer-out-of-scope'
  // The member-outcome codes, re-keyed on the member role (**schema 16**). The
  // former location-keyed `workspace-member-unmounted` is retired, its cases
  // split across these role-keyed codes; `workspace-ambiguous` is retired too
  // (the folder-repo entry removed the multi-manifest ambiguity that fired it).
  | 'edit-member-unmounted'
  | 'edit-member-read-only'
  | 'discover-member-unmounted'
  | 'discover-member-is-a-dependency'
  // A `disabled:` overlay entry naming no declared member (`warning`): the name
  // sits in the manifest's `disabled:` list but is absent from `edit:` /
  // `discover:`, so there is nothing to disable.
  | 'disabled-member-not-declared'
  | 'parent-references-absent-type'
  | 'repo-registry-parse-error'
  | 'repo-name-missing'
  | 'duplicate-repo-name'
  // The cross-repo type-vocabulary gate: a `::repo`-qualified type checked at
  // the use site against the declared peers. A resolvable `::repo` is silent.
  | 'type-repo-unknown'
  | 'type-repo-unavailable'
  | 'peer-type-not-found'
  | 'type-repo-empty'
  | 'type-repo-self'
  // The peer gate: a `::repo` TYPE crossing into a mounted member that is not a
  // declared `dep` of the source's repo (**schema 16**). A plain value link is
  // unaffected; only a type crossing gates.
  | 'type-repo-not-a-dependency'

/**
 * The package-manager diagnostic codes, a third switching aid beside
 * `WireCrossRepoDiagnosticCode`. Like it, NOT exhaustive and NOT closed —
 * `code` stays a bare `string`, so tolerate unknown values. These fire around
 * dependency resolution and the cache snapshot; see au-engine
 * `crates/au-core/src/codes.rs`.
 * - `dependency-path-escapes-snapshot` — `error`, a dependency `path:` escaping
 *   the cache snapshot; the mount-choke-point security guard, not mounted or locked.
 * - `dependency-cache-miss` — `warning`, a transitive locked dependency absent
 *   from the cache.
 * - `dependency-identity-conflict` — `error`, one name resolving to two
 *   different remotes.
 * - `dependency-path-overridden` — `hint`, a dependency served from a local
 *   path override rather than its locked snapshot.
 */
export type WirePackageManagerDiagnosticCode =
  | 'dependency-path-escapes-snapshot'
  | 'dependency-cache-miss'
  | 'dependency-identity-conflict'
  | 'dependency-path-overridden'

/**
 * The commit-pinned-reference diagnostic codes, a second switching aid beside
 * `WireCrossRepoDiagnosticCode`. Like it, NOT exhaustive and NOT closed —
 * `code` stays a bare `string`, so tolerate unknown values. These fire around
 * the `@commit` pin and the `*@` enforced-pinned slot; see au-engine
 * `crates/au-core/src/codes.rs` and `crates/au-references/src/codes.rs`.
 * - `value-not-pinned` — `error`, an unpinned (or non-reference) value in a
 *   `*@` slot, whose contract is that every value carries a `@commit` pin.
 * - `pinned-reference-drifted` — `drift`, the live counterpart of a pin at HEAD
 *   has diverged; the pinned edge still resolves, so it is advisory, not an error.
 * - `wikilink-empty-commit` — `warning`, an `@` pin with no commit value
 *   (`[[note::@]]` / `[[note::base@]]`).
 */
export type WirePinnedReferenceDiagnosticCode =
  | 'value-not-pinned'
  | 'pinned-reference-drifted'
  | 'wikilink-empty-commit'

/**
 * The value-refinement + range-cardinality diagnostic codes, a switching aid
 * beside `WirePinnedReferenceDiagnosticCode`. Like it, NOT exhaustive and NOT
 * closed — `code` stays a bare `string`, so tolerate unknown values. These fire
 * around `Base{predicate}` refinement and `T[x..y]` cardinality (**schema 27**);
 * see au-engine `crates/au-core/src/codes.rs` and `crates/au-grammar/src/lib.rs`.
 * - `value-out-of-refinement` — `error`, a value of the right base type that
 *   falls outside its slot's refinement (`-1` in a `Number{>=0}` slot). Suppressed
 *   when the refinement is provably empty (that fires `refinement-unsatisfiable`).
 * - `refinement-unsatisfiable` — `warning`, a type-def refinement whose meet
 *   admits no value (`Number{>=5 & <=1}`); surfaced once on the def instead of
 *   per value.
 * - `refinement-bad-shape` — a malformed refinement: a predicate invalid for its
 *   base, a duplicate-kind predicate, a bad number literal, an unterminated regex,
 *   or an empty / non-primitive refinement. Also at load for a non-compiling
 *   regex or bad temporal literal.
 * - `cardinality-bad-shape` — a malformed cardinality suffix: an inverted range
 *   (`[5..1]`), a non-integer or negative bound, or the redundant `[..]`.
 */
export type WireRefinementDiagnosticCode =
  | 'value-out-of-refinement'
  | 'refinement-unsatisfiable'
  | 'refinement-bad-shape'
  | 'cardinality-bad-shape'

/**
 * The scoped-config diagnostic codes, a switching aid beside the other
 * `Wire*DiagnosticCode` families. Like them, NOT exhaustive and NOT closed —
 * `code` stays a bare `string`, so tolerate unknown values. Both are ADVISORY:
 * the `config` read / `set_config` write never HARD-fail on them (a config write
 * is deliberately relaxed), so they surface as feedback, never a rejection. See
 * au-engine `crates/au-core/src/codes.rs`.
 * - `config-type-unresolved` — `warning`, the file's declared / written `type`
 *   does not resolve in the scope's graph. The value is stored AS-IS (never the
 *   hard `unknown-type-claim` a walked node would raise).
 * - `config-type-unwritten` — `drift`, the file carries no written `type:` key,
 *   so the declared floor was stamped rather than authored. The `set_config`
 *   writer injects `type:` precisely to avoid this on a governed write.
 */
export type WireConfigDiagnosticCode = 'config-type-unresolved' | 'config-type-unwritten'

export interface WireDiagnostic {
  /**
   * The diagnostic code. A bare string, open and additive — the engine's
   * catalog grows, so tolerate unknown values. `WireCrossRepoDiagnosticCode`,
   * `WirePackageManagerDiagnosticCode`, `WirePinnedReferenceDiagnosticCode`,
   * `WireRefinementDiagnosticCode`, and `WireConfigDiagnosticCode` enumerate known
   * code families as a switching aid. They are FAMILIES, not the catalog: most
   * codes belong to none of them.
   */
  code: string
  severity: WireDiagnosticSeverity
  span: WireDiagnosticSpan
  message: string
  related?: WireDiagnosticSpan[]
  fix?: WireSuggestedFix
}

/**
 * The `diagnostics` read/channel filters. All optional, all compose (AND);
 * no args is whole-knowledge-base. An unknown arg or severity value is an `error`
 * frame, never silently ignored. The read AND the `diagnostics` subscription
 * channel share this struct, so their filtering can never diverge.
 */
export interface WireDiagnosticsFilter {
  /** Diagnostics in exactly this file. A LOCATION PIN: flips the `scope` default to `all`. */
  path?: string
  /** Diagnostics in files under this directory, matched on whole path components. A LOCATION PIN: flips the `scope` default to `all`. */
  path_prefix?: string
  severity?: WireDiagnosticSeverity
  /** One exact diagnostic code. */
  code?: string
  /**
   * Diagnostics owned by exactly this member (by the deepest-containing-repo
   * rule over the diagnostic's `span.file`); absent spans every mounted member.
   * A LOCATION PIN: flips the `scope` default to `all`. Orthogonal to `scope`,
   * which selects the CLASS. **Schema 17**.
   */
  repo?: string
  /**
   * ACTIONABILITY scope: `own` (default) hides read-only dependencies'
   * diagnostics; `all` includes them. **Defaults to `own`** (an actionability
   * read), UNLESS a location pin (`repo` / `path` / `path_prefix`) is present, in
   * which case it defaults to `all` — so `diagnostics({path: <dep file>})`
   * returns that file's diagnostics instead of a silent empty. An explicit
   * `scope` always wins and composes (AND). **Schema 17**.
   */
  scope?: WireTypeScope
}

/**
 * Read-only paging for the `diagnostics` read, beside the filters. The
 * subscription channel ignores both (it streams the full set), so paging is
 * not part of `WireDiagnosticsFilter`. A consumer pages until a short page
 * (`< limit`), or asks `diagnostic_counts` for the total — no total rides the
 * page.
 */
export interface WireDiagnosticsPage {
  /** At most this many entries, after `offset`. Absent returns the whole filtered set. */
  limit?: number
  /** Skip this many filtered entries before the page. Absent is 0. */
  offset?: number
}

/**
 * Result of the `diagnostics` read: an array of the in-scope diagnostics, in
 * the served stream's stable order (by source path, then by position). When
 * `WireDiagnosticsPage` paged the read, this is the page, not the whole set.
 */
export type WireDiagnosticsResult = WireDiagnostic[]

/**
 * Result of the `diagnostic_counts` read: the shape of the problem over the
 * filtered set without materializing every entry. Same filters as
 * `diagnostics`; `limit` / `offset` do not apply (counts are over the full
 * filtered set).
 */
export interface WireDiagnosticCountsResult {
  /** The filtered count. */
  total: number
  /** Severity → count, only present severities, name-sorted. */
  by_severity: Partial<Record<WireDiagnosticSeverity, number>>
  /** Code → count, name-sorted. `code` is an open string, like `WireDiagnostic.code`. */
  by_code: Record<string, number>
}

// ---------------------------------------------------------------------------
// mutate

/**
 * The `result` object of a successful `mutate` (any primitive). The reply
 * rides the read-response envelope (`ready: true`, with `version`), so the
 * typed mutate outcome surfaces both — see the client's `TypedMutate`.
 *
 * `hash` is the held knowledge base's content hash for the touched file, ready
 * as the next `expected_hash`; null for a file the build never read. `reflected`
 * says whether the held knowledge base already reflects this write: `true` in the common
 * case, `false` when the disk write landed but the rebuild has not caught up —
 * then `hash` and `diagnostics` predate the write, so await a later `version`
 * rather than re-issuing the mutation (its `expected_hash` would now conflict).
 * `id` / `ref` are present only for `assign_block_id` (the engine-assigned `^:`
 * id and its `[[target^id]]` reference).
 *
 * The mutation carries two commit fields that answer different questions, since
 * a mutation is a local saga over its touched repos and commits once per
 * committing member (a rename rewriting referrers across repos makes N commits).
 *
 * `commit` is the anchor — "what do I pin `path` at?". It is HEAD of `path`'s
 * OWN repo, the pin anchor for the file the response is about. `null` ONLY
 * off-git (`path` not under a git working tree). After a committing mutation it
 * is the new sha; after an idempotent no-op it is the unchanged HEAD — still a
 * valid anchor, NOT null. Symmetric with the content read's `commit` (the same
 * HEAD anchor). It never reports a different repo's sha than `path`'s.
 *
 * `commits` is the provenance — "what did THIS mutation commit?". Every
 * committing repo as `{ [repo]: sha }`, keyed by repo name, nothing dropped.
 * `{}` when nothing committed (every touched member off-git, or a no-op that
 * wrote nothing); a member written but not committed (off-git in a mixed saga)
 * has no entry. `path`'s own repo is always among the committers when the saga
 * commits anything, so a non-empty `commits` means `commit` is the sha that just
 * changed `path`; an empty `commits` means `commit` is a pre-existing HEAD.
 *
 * `last_live_commit` is the DELETE-only tombstone anchor — set ONLY by a
 * `delete_file` mutation, and only on-git. It is the LAST-LIVE commit, the
 * parent of the deletion commit (HEAD immediately before the delete), the last
 * commit where the file still EXISTED. Absent off-git (no deletion commit,
 * nothing to pin) and absent on every non-delete primitive.
 *
 * PIN A DELETE TOMBSTONE AT THIS, NOT AT `commit`. `commit` / `commits` name the
 * DELETION commit, where the file is ABSENT — a tombstone pinned there resolves
 * to an absent target (`pinned-path-absent`). A delete tombstone `[[<path>::@<sha>]]`
 * must use `last_live_commit` so the file's last content still reads back from
 * history. A write / edit tombstone, by contrast, pins `commit` (the file is
 * present at that commit). The pin target DIVERGES by primitive; this field
 * exists so the delete case is unambiguous rather than a `commit` look-alike.
 * The clean-at-HEAD precondition guarantees the file was present at the parent,
 * and an untracked (never-committed) file's delete rejects before any commit, so
 * a surfaced `last_live_commit` ALWAYS resolves the file.
 */
export interface WireMutateResult {
  path: string
  hash: string | null
  diagnostics: WireDiagnostic[]
  reflected: boolean
  commit: string | null
  commits: Record<string, string>
  /**
   * The delete tombstone's pin anchor: the last commit where the file existed
   * (parent of the deletion commit). Present ONLY on a `delete_file` result and
   * only on-git; absent elsewhere. See the type doc — a delete tombstone pins
   * THIS, never `commit`.
   */
  last_live_commit?: string
  id?: string
  ref?: string
  /**
   * The per-mixin report of the `ensure_mixins` write rider (`write_file` /
   * `edit_file` / `rename` only, schema 25). Present ONLY when the write carried
   * mixins; omitted otherwise. A STRICT reject is the `error` frame, never this.
   * See `EnsureMixinOutcome`.
   */
  ensure_mixins?: EnsureMixinOutcome[]
}

// ---------------------------------------------------------------------------
// types / type

/** A `fills:` contract. The `!:` form sets `exclusive`. */
export interface WireFillsContract {
  fields: string[]
  exclusive: boolean
}

/**
 * One body-template item. A section's nested `body` recurses with the same
 * shape: `null` when no `body:` was declared at that section, `[]` when
 * declared but empty.
 */
export type WireBodyItem =
  // `target` is the `use:` target verbatim; a cross-repo one reads `name::repo`.
  | { kind: 'use'; target: string }
  | {
      kind: 'section'
      name: string
      optional: boolean
      fills?: WireFillsContract
      guidance?: string
      body: WireBodyItem[] | null
    }
  | { kind: 'fills'; contract: WireFillsContract }

/** A built-in primitive slot type. Closed set; consumers still tolerate unknown values per additive evolution. */
export type WirePrimitiveName = 'String' | 'Number' | 'Boolean' | 'Date' | 'DateTime' | 'Url'

/**
 * The parsed slot shape: a tagged union on `kind` mirroring the engine's
 * `WireShape`. References carry bare names, not nested shapes; only `list`
 * wraps an inner shape.
 *
 * Two built-ins are reference-by-name, NOT their own kind: the any-repo-file
 * slot is `reference` with `name: "file"` (there is no `file` kind), and the
 * reference forms of the no-type slot — `any*` / `any&` — are `reference` /
 * `inline-or-reference` with `name: "any"`. The bare no-type slot `any` itself
 * is the payload-free `{ kind: "any" }` (below), distinct from those.
 *
 * Shared by `WireField.shape_ast` and the `semantic_tokens` read's
 * `field-value` token, so it is decoded once. Kind literals carry hyphens,
 * as on the wire.
 */
export type WireShape =
  | { kind: 'primitive'; name: WirePrimitiveName }
  /**
   * The no-type inline slot, bare `any`; no payload. Its `any*` / `any&`
   * reference forms ride `reference` / `inline-or-reference` named `"any"`, not
   * this kind. Post-split, `any` is the INTERPRETED top type ⊤: the shape
   * constraint is trivially satisfied, but the value is still read (a nested
   * `type:` is a real inline claim, `[[...]]` are real edges, candidates scan).
   * For a stored-but-never-read slot use `opaque`.
   */
  | { kind: 'any' }
  /**
   * The uninterpreted inline slot, bare `opaque`; no payload. A value of any
   * shape, stored but never read: no shape check, no nested-`type:` claim, no
   * candidate scan, a body fence reads verbatim. Inline-only — there is no
   * `opaque*` / `opaque&` (those are shape-syntax errors; use `any*` / `any&`).
   * Additive, no `schema_version` bump (stays 29); a consumer that does not know
   * it treats `opaque` as an unconstrained slot like `any`.
   */
  | { kind: 'opaque' }
  | { kind: 'enum'; members: string[] }
  | { kind: 'reference'; name: string }
  | { kind: 'record'; name: string }
  | { kind: 'inline-or-reference'; name: string }
  /**
   * `inner[min..max]` range cardinality: `min` the inclusive lower bound on the
   * element count, `max` the inclusive upper (OMITTED = unbounded above). Source
   * sugar maps as `[]`=`{min:0}`, `[+]`=`{min:1}`, `[n]`=`{min:n,max:n}`,
   * `[..m]`=`{min:0,max:m}`. Replaced the former `non_empty` boolean at
   * schema 27. The first of the two inner-wrapping kinds, beside `pinned`.
   */
  | { kind: 'list'; min: number; max?: number; inner: WireShape }
  | { kind: 'union'; branches: WireShape[] }
  | { kind: 'intersection'; branches: WireShape[] }
  | {
      kind: 'compound-reference'
      mode: 'ref' | 'inline-or-ref'
      op: 'union' | 'intersection'
      branches: string[]
    }
  /**
   * A typed reference to a type-def, the def-axis sibling of `reference`
   * (`T*`): `type*` (unconstrained, `bound` absent) or `type<…>*` (the
   * `bound` constrains the target def's parent closure). Reference-only — no
   * inline / `&` form.
   */
  | { kind: 'def-reference'; bound?: WireDefBound }
  /**
   * A commit-pinned reference slot, the `*@` enforced-pinned postfix: `inner`
   * is the wrapped reference shape (`file*@`, `T*@`, `T&@`, `<a | b>*@`,
   * `type<T>*@`), so every value filling it must carry a `@commit` pin. The
   * second wrapper kind beside `list`; an unpinned value here raises
   * `value-not-pinned`.
   */
  | { kind: 'pinned'; inner: WireShape }
  /**
   * A field-level value refinement, the `Base{predicate}` form: `base` is the
   * refined primitive, `refinement` the predicate meet narrowing its value
   * lattice (`Number{>=0 & integer}`, `String{/^[a-z0-9-]+$/}`,
   * `Date{>=2020-01-01}`). Not a wrapper — `base` is a bare primitive name, not
   * a nested `WireShape`. Introduced at schema 27.
   */
  | { kind: 'refined'; base: WirePrimitiveName; refinement: WireRefinement }
  /**
   * A tuple `(A, B, …)`, a fixed-arity positional product: `elements` are the
   * per-position shapes, ORDER-SIGNIFICANT. Not a wrapper of one inner shape
   * (unlike `list` / `pinned`); it carries an ordered array. Reached as a brand's
   * `shape` (`shape: (Number, Number)`) as well as a field's `shape_ast`.
   * Additive — a new `kind` value on the existing tagged union, NO
   * `schema_version` bump. The precedent is the schema-27 `refined` / `list`
   * additions.
   */
  | { kind: 'tuple'; elements: WireShape[] }

/**
 * A value refinement's predicate meet, on `WireShape`'s `refined` kind. A FLAT
 * bag: comparison bounds, an `integer` flag, and a regex `pattern`, at most one
 * of each, absent members OMITTED. Faithful to the engine's internal refinement
 * meet, and additive for future predicates, so kept flat rather than
 * base-tagged (see WIRE.md, the `refined` producer invariant).
 *
 * PRODUCER INVARIANT: the `base` determines which members can appear, so a
 * consumer MAY narrow this type by `base`. `String` carries only `pattern`;
 * `Number` only `lower` / `upper` / `integer`; `Date` / `DateTime` only `lower`
 * / `upper`. `Boolean` / `Url` are never refined. The engine emits no other
 * combination.
 */
export interface WireRefinement {
  /** The lower comparison bound (`>` / `>=`), on an ordered base (`Number` / `Date` / `DateTime`). Absent when none. */
  lower?: WireRefinementBound
  /** The upper comparison bound (`<` / `<=`), on an ordered base. Absent when none. */
  upper?: WireRefinementBound
  /** The `integer` flag, `Number` base only. Absent (never `false`) when not set. */
  integer?: boolean
  /** The regex pattern (its source, brace-free), `String` base only. Absent when none. */
  pattern?: string
}

/**
 * A comparison bound in a `WireRefinement`. `value` is the raw literal AS A
 * STRING on the wire, for every base — `"0"` for a `Number`, `"2020-01-01"` for
 * a `Date` — preserving the exact literal. `inclusive` is `>=` / `<=` versus the
 * strict `>` / `<`.
 */
export interface WireRefinementBound {
  value: string
  inclusive: boolean
}

/**
 * The ceiling on a `def-reference` (`type<…>*`): the def-axis bound the target
 * type-def's parent closure must satisfy. `single` is `type<T>*`; `compound`
 * is `type<a | b>*` / `type<a & b>*` (branch order significant). Absent on the
 * unconstrained `type*`, which admits any type-def.
 */
export type WireDefBound =
  | { kind: 'single'; name: string }
  | { kind: 'compound'; op: 'union' | 'intersection'; branches: string[] }

export interface WireField {
  name: string
  /** Source-form slot expression (e.g. `String`, `[low, moderate]`, `decision*[]`). */
  shape: string
  /** The `shape` parsed, beside the source form; `null` when it does not parse (see the `shape-syntax-error` diagnostic). */
  shape_ast: WireShape | null
  required: boolean
  /** The field's own `#:` docstring; advisory, never validated. Absent when none. */
  doc?: string
  /**
   * The byte span of the field NAME in the owning type-def's source, for
   * go-to-def onto the field's declaration line. File-relative, so the field's
   * file is the type-def's `source.file` (on `WireTypeDef`); the span alone
   * suffices. Absent on `type_closure` fields, gathered across origins with no
   * per-origin source site.
   */
  key_span?: WireSpan
}

/** One body field inside a meta sub-region: key name plus value as JSON. */
export interface WireMetaField {
  name: string
  value: unknown
}

export interface WireMetaBlock {
  type_name: string
  body: WireMetaField[]
  source: WireSourceLoc
}

/**
 * A type-def's BRAND, present on `WireTypeDef.brand` when the def declares a
 * `shape:` instead of `fields:` — naming a reusable, documented, queryable type
 * (a branded scalar, named enum, named union, or tuple). Absent for a record
 * def; when present the owning def's `fields` is empty. Additive, no
 * `schema_version` bump.
 */
export interface WireBrand {
  /**
   * The underlying shape as a `WireShape`, the same AST a field's `shape_ast`
   * uses. A named enum renders as `{ kind: 'enum', members }`, a tuple as
   * `{ kind: 'tuple', elements }`, a named union as `{ kind: 'union', branches }`,
   * a branded scalar as `{ kind: 'primitive', name }` (or `refined`).
   */
  shape: WireShape
  /**
   * Per-enum-member `#:` docstrings, a `{ member: doc }` map, documented members
   * only. Advisory, never validated. OMITTED when empty (never `{}`), so absent
   * for a non-enum brand or an undocumented enum.
   */
  member_docs?: Record<string, string>
}

export interface WireTypeDef {
  /**
   * The repo this entry is reported from. On the workspace `types` / `type`
   * read (no `repo` arg) it is the owner — the entries are deduped to owner
   * copies. On a repo-scoped read it is the holder (the scoped repo).
   */
  repo: string
  name: string
  /**
   * The type's identity: the closure-hash half of its `TypeId`, hex. Equal
   * hashes are the same type across repos; two same-named entries from different
   * repos are the same identity iff their `hash` matches. The same hash the
   * `instances_of` / `imports` reads carry. Always present
   * on every type view (`types`, `type`, `subtypes`, and the `types`
   * subscription's initial value, which rides the `types` shape).
   */
  hash: string
  /** The declared direct parents, verbatim; a cross-repo parent reads `name::repo`. */
  parents: string[]
  /**
   * `true` when the type-def declares `abstract: true` — a non-claimable but
   * open base (**schema 18**). Orthogonal to `sealed` (which also closes the
   * branch set); a consumer's non-claimable check is `abstract || sealed`.
   */
  abstract: boolean
  /**
   * The type-def's OWN `required:` meta obligations, in authored form (each may
   * carry a `::repo`), `[]` when none (**schema 18**). Every non-abstract type
   * whose closure includes this def must carry each named meta.
   */
  required_meta: string[]
  /**
   * The required-meta names a NON-abstract type does not satisfy, sorted, `[]`
   * when satisfied or exempt (**schema 18**). The read half of the
   * `subtype-missing-required-meta` computation — a consumer gates on it without
   * parsing diagnostics. Always `[]` on an abstract def (exempt).
   */
  unmet_required_meta: string[]
  /**
   * The type-def's own `#:` docstring — a leading `#:` block before the first
   * top-level key. Advisory, never validated. Absent when none.
   */
  doc?: string
  /**
   * The sealed branch list, verbatim; a cross-repo branch reads `name::repo`.
   * `null` when the type-def is not sealed. Never empty.
   */
  sealed: string[] | null
  fields: WireField[]
  /**
   * Declared meta sub-regions. `null` when the `meta:` key is absent,
   * `[]` for the explicit `meta: []` suppression marker.
   */
  meta_blocks: WireMetaBlock[] | null
  /**
   * Source-form `body:` template. `null` when the type-def has no `body:`
   * key, `[]` for explicit empty `body: []`.
   */
  body: WireBodyItem[] | null
  /** Post-splice template, every top-level `use:` resolved. `null` when no own body. */
  effective_body: WireBodyItem[] | null
  /**
   * The type-def's BRAND, present when it declares a `shape:` instead of
   * `fields:` (`fields` is then empty). Absent for a record def. Additive, no
   * `schema_version` bump; a consumer that ignores it sees a def with empty
   * `fields`, as before.
   */
  brand?: WireBrand
  source: WireSourceLoc
}

/**
 * The own-vs-all vocabulary filter shared by the workspace-wide type reads
 * (`types`, `type_tree`, `type_counts`, `subtypes`, `imports`), default
 * `all` (**schema 11**):
 * - `all` — every mounted repo's vocabulary (unchanged behaviour).
 * - `own` — only the user's OWN repos, an editable authoring surface (the entry
 *   or an `edit` member, role-derived at **schema 16**), hiding every dependency
 *   and the `au.engine.*` builtin. Now hides by ROLE, not location: a live-tree
 *   dep is still hidden, a cache-only `edit` member is now shown. Orthogonal to
 *   a `repo` filter: a named dependency repo under `own` returns an empty set.
 * Closed set; tolerate unknown values per additive evolution.
 */
export type WireTypeScope = 'own' | 'all'

/**
 * Optional args for the `types` read: scope, projection, and paging. All
 * optional; no args is the full-detail workspace-wide read. An unknown arg is
 * an `error` frame, never a silently-unfiltered set.
 * - `repo` scopes resolution to one member's whole graph by its declared name
 *   (absent is the workspace-wide owner-deduped read).
 * - `scope` (`all` default / `own`) filters the vocabulary to the user's own
 *   repos — see `WireTypeScope`. Orthogonal to `repo`.
 * - `summary: true` projects each entry to `WireTypeSummary`, the lightweight
 *   browse form; absent / `false` is full detail.
 * - `limit` / `offset` page the name-sorted set (`limit` entries after
 *   `offset`); a short page (`< limit`) signals the end. No total rides the
 *   array — page until a short page, or ask `type_counts`.
 */
export interface WireTypesArgs {
  repo?: string
  scope?: WireTypeScope
  summary?: boolean
  limit?: number
  offset?: number
}

/**
 * The lightweight `summary` projection of a `types` entry: the identity and
 * navigation fields, with the same values and semantics they carry on a full
 * `WireTypeDef`. The heavy detail (`fields`, `meta_blocks`, `body`,
 * `effective_body`, `source`, and the `abstract` / `required_meta` /
 * `unmet_required_meta` batch) is dropped — the full `types` read or the single
 * `type` read serves it, keyed by the `name` / `hash` this entry carries. In
 * summary mode the heavy payload never crosses the wire (nor is materialized).
 */
export interface WireTypeSummary {
  /** The repo the entry is reported from: the owner for the workspace read, the scoped repo for a per-repo read. */
  repo: string
  name: string
  /** The type's closure-hash identity, hex — the same value a full entry carries. */
  hash: string
  /** The declared direct parents, verbatim; a cross-repo parent reads `name::repo`. */
  parents: string[]
  /** The sealed branch list, verbatim; `null` when not sealed. Never empty. */
  sealed: string[] | null
  /** The type-def's own `#:` docstring; absent when none. */
  doc?: string
}

/**
 * Result of the `types` read, an array of type-defs each carrying `repo`:
 * - no `repo` arg — the workspace-wide read: every type-def across all members,
 *   deduped to its owner copy (which carries `meta_blocks`), name-sorted, each
 *   `repo` the owner. A type owned by no mounted member (only borrowed copies)
 *   does not appear.
 * - `repo: X` — that member's whole graph, each `repo` the holder. `null` for an
 *   unknown repo.
 *
 * Breaking vs. the old scope: no `repo` was the root repo; it is now
 * workspace-wide. The root's declared name as `repo` recovers the old scope.
 */
export type WireTypesResult = WireTypeDef[]

/**
 * Result of the `types` read under `summary: true`: the same array shape as
 * `WireTypesResult`, each entry projected to its lightweight `WireTypeSummary`.
 * Null for an unknown `repo`, like the full read.
 */
export type WireTypesSummaryResult = WireTypeSummary[]

/**
 * Result of the `type_counts` read: the shape of the vocabulary without
 * materializing every def, the type dual of `diagnostic_counts`. `null` for an
 * unknown `repo`, matching `types`. Counts are over the full set for the given
 * `repo` scope, so `summary` / `limit` / `offset` are meaningless and rejected.
 */
export interface WireTypeCounts {
  /**
   * The count over the same entry set the `types` read spans for the same
   * `repo` scope: absent `repo` the owner-deduped workspace set, a present
   * `repo` that member's whole graph (borrowed copies included).
   */
  total: number
  /**
   * Repo → count, name-sorted. Absent `repo` histograms the owner repos; a
   * present `repo` has the single scoped-repo entry.
   */
  by_repo: Record<string, number>
}

/** Result of the `type_counts` read: `{ total, by_repo }`, or null for an unknown `repo`. */
export type WireTypeCountsResult = WireTypeCounts | null

// ---------------------------------------------------------------------------
// instance_counts

/**
 * One row of the `instance_counts` `by_type` array: a type identity and the
 * number of instance sites counting toward it.
 *
 * IDENTITY-KEYED, not a bare `name → count`: `hash` is the closure-hash, so two
 * same-named cross-repo identities are DISTINCT rows. A consumer joins the count
 * onto a `types` summary row by `(name, hash)` — the same identity that row
 * carries. `type_owners` is the repos owning a def with this identity, like
 * `instances_of`.
 */
export interface WireInstanceTypeCount {
  name: string
  /** The closure-hash (hex), the identity half of the type's `TypeId`. */
  hash: string
  /** The repos owning a def with this `(name, hash)` identity. */
  type_owners: string[]
  /**
   * The number of instance sites whose closure includes this type. CLOSURE-
   * INCLUSIVE: a site counts toward every type in its closure (claim + ancestors),
   * so this equals the length of the matching `instances_of` drill-in over the
   * file/nested origins.
   */
  count: number
}

/**
 * Result of the `instance_counts` read: per-type instance counts, the instances
 * dual of `type_counts`. Lets a consumer render a browsable vocabulary-with-
 * counts overview in ONE round-trip, instead of N `instances_of` reads.
 */
export interface WireInstanceCountsView {
  /**
   * True when a broken vocabulary aborted a repo's load, matching
   * `candidate_counts` — closures can be incomplete then, so a count from an
   * aborted load stays distinct from a settled one.
   */
  aborted_at_load: boolean
  /**
   * Total AUTHORED instance SITES in scope — file-level instances and nested
   * inline records — each counted once regardless of how broad its closure is.
   * Type-def `meta` blocks are EXCLUDED (annotations, not browsable documents);
   * engine-schema config-file instances (a repo's `.arsumbris/repo.yaml` is an
   * `au.engine.repo`) DO count. Because `by_type` is closure-inclusive, the
   * `by_type` counts do NOT sum to `total`.
   */
  total: number
  /** Per-type counts, identity-keyed, sorted by `(name, hash)`. */
  by_type: WireInstanceTypeCount[]
}

/**
 * Result of the `instance_counts` read: the `{ aborted_at_load, total, by_type }`
 * view, or null for an unknown `repo`.
 */
export type WireInstanceCountsResult = WireInstanceCountsView | null

/**
 * Result of the `type` read: one type-def by name (in the `types` shape,
 * carrying `repo` and `hash`), or null when absent.
 *
 * The read names its target by the authored form — bare or `::repo`-qualified,
 * with no separate `repo` key (the `instances_of` arg convention; the structured
 * `repo` filter is the enumeration `types`'). A caller that once scoped with a
 * `repo` arg folds it into the name (`type::repo`):
 * - bare `foo` — resolves the name to its owner copy across all members (the
 *   single-type dual of the workspace `types` read), so a hover resolves a
 *   member-defined type without knowing its repo. `null` when no member owns it.
 * - `foo::repo` — scopes resolution to that member's graph, the identity that
 *   repo holds; `null` when the type is absent there or the repo is unknown.
 */
export type WireTypeResult = WireTypeDef | null

/**
 * Result of the `type` read's batch `names: [..]` form: one result per
 * requested name, in request order — each the single-`name` result
 * (`WireTypeResult`), or null for a name no member owns / absent from a scoped
 * repo / an unknown repo. The detail-on-demand dual of the `types` summary:
 * drill into N summary entries in one round-trip, not N reads. The single and
 * batch selectors are mutually exclusive; naming neither is an error frame.
 */
export type WireTypeBatchResult = WireTypeResult[]

// ---------------------------------------------------------------------------
// type_tree

/**
 * One node of the `type_tree` forest: an owner-deduped type-def reduced to its
 * cross-repo parent/child adjacency.
 */
export interface WireTypeTreeNode {
  /** The owner repo of this type-def. */
  repo: string
  name: string
  /** The type's identity (closure-hash, hex), the same value the `types` view carries. */
  hash: string
  /**
   * The declared direct parents, verbatim — including any whose owner repo is
   * not mounted (so a parent name here need not appear as a node).
   */
  parents: string[]
  /** Direct children present in the node set, name-sorted. */
  children: string[]
}

/**
 * Result of the argless `type_tree` read: the workspace's owner-deduped
 * type-defs as a cross-repo parent/child adjacency forest, owner-annotated per
 * node. Composable from the workspace `types` read plus `parents`, served
 * first-class as the agent-friendly tree form.
 *
 * Type-defs form a DAG (a type may extend several parents), so this is
 * adjacency, not a nested tree: a multi-parent node appears once and is
 * referenced by each parent's `children`. Edges are by type name, which is
 * global, so a subtype in one member links to a base owned in another.
 */
export interface WireTypeTree {
  /**
   * The node names with no parent present in the node set (typically no parents
   * at all), name-sorted. Descending `children` from the roots reaches every node.
   */
  roots: string[]
  /** One per owner-deduped type-def, name-sorted. */
  nodes: WireTypeTreeNode[]
}

/** Result of the `type_tree` read. Argless and always present (never null). */
export type WireTypeTreeResult = WireTypeTree

// ---------------------------------------------------------------------------
// subtypes

/**
 * One subtype of the queried base: a full type-def (the same fields the `types`
 * read yields) plus the owner `repo` it lives in. Deduped to the owner copy —
 * the one that carries `meta_blocks`.
 */
export type WireSubtype = WireTypeDef

/**
 * Result of the `subtypes` read: every type-def across the workspace whose
 * closure includes `base`, the type-level dual of `instances_of`. `subtypes` is
 * name-sorted, one per matching type-def deduped to its owner copy, the base
 * itself excluded. Workspace-wide — the engine walks every member's graph, so a
 * consumer gets "all subtypes of X" (with the owner repo + runtime meta) in one
 * read, no per-repo `types` enumeration fan-out.
 */
export interface WireSubtypesResult {
  /** The base name echoed. */
  base: string
  subtypes: WireSubtype[]
}

// ---------------------------------------------------------------------------
// instances_of

/**
 * The kind of site an `instances_of` match was found at, and the `origins`
 * request filter's vocabulary (**schema 13**):
 * - `file` — a file whose top-level `type:` claims the type (the old behaviour).
 * - `nested` — a nested inline record inside another instance's field value, at
 *   any depth.
 * - `meta` — a `meta:` block on a type-def.
 * Closed set; tolerate unknown values per additive evolution.
 */
export type WireInstanceOrigin = 'file' | 'nested' | 'meta'

/**
 * The locator for a `nested` match: the record's identity within its host
 * `path`. `field_path` is a structured mixed array of field names and list
 * indices addressing the record from the host's body root, e.g.
 * `["phases", 0, "actions", 1]`. `block_id` is the record's `^` id, or `null`
 * when it carries none (stability is opt-in via `assign_block_id`).
 */
export interface WireNestedLocator {
  kind: 'nested'
  field_path: (string | number)[]
  block_id: string | null
}

/**
 * The locator for a `meta` match: the semantic key of the `meta:` block on the
 * host type-def. `meta_type` is the meta block's type name; `repo` is its
 * `::repo` qualifier, `null` for an own meta type.
 */
export interface WireMetaLocator {
  kind: 'meta'
  meta_type: string
  repo: string | null
}

/**
 * The origin-specific identity of a match within its `path`, discriminated by
 * `kind`. `null` on a `file` match (the file itself is the identity); a
 * `WireNestedLocator` for `nested`, a `WireMetaLocator` for `meta`.
 */
export type WireInstanceLocator = WireNestedLocator | WireMetaLocator

/**
 * One `instances_of` match record: an (instance, matched identity) pair, not a
 * whole instance, at a site of any `origin` (`file` / `nested` / `meta`). A
 * bare `type` query matches every distinct identity of that name across the
 * workspace, so one instance can yield several records under distinct `hash`es;
 * a `type::repo` query matches the one identity that repo owns. The `type:`
 * claim rides `claim`, not `fields`; body-surface contributions are not folded
 * in — the opt-in `instance` field (under `instance: true`) carries the full
 * provenance.
 */
export interface WireInstanceMatch {
  /**
   * The FILE that contains the instance: the instance file for a `file` match,
   * the host instance file for a `nested` match, the host type-def file for a
   * `meta` match. Use `span` / `locator` to address the site within it.
   */
  path: string
  /** The instance's effective `type:` claim in authored form; a `::repo` claim stays qualified (the `name::repo` form). */
  claim: string[]
  /**
   * The instance's OWN field values as JSON: the nested record's or meta
   * block's body, or the file's frontmatter for a `file` match. The `type:`
   * claim rides `claim`, not here.
   */
  fields: Record<string, unknown>
  /** The matched type's name. */
  name: string
  /** The matched type's closure-hash identity, hex. Equal hashes are the same type. */
  hash: string
  /**
   * The repos defining this TYPE identity; several when they share a
   * byte-identical definition (the dedup). **Schema 17**: renamed from `owners`,
   * which misled a consumer into reading it as the instance's owner — it names
   * who owns the TYPE. The instance FILE's owner is `member`.
   */
  type_owners: string[]
  /**
   * The declared name of the workspace member owning the instance FILE, always
   * present (**schema 17**). The natural grouping / attribution key, self-describing
   * beside `type_owners`. A STRING, not the full `resolve_member` record — a
   * consumer needing `root` / `editable` / `role` calls `members` ONCE and joins
   * by name.
   */
  member: string
  /** True when the instance directly claims this identity in its `type:`. */
  claimed: boolean
  /** True when this identity is a transitive ancestor of a type the instance claims. */
  inherited: boolean
  /** The site kind this match was found at. */
  origin: WireInstanceOrigin
  /** The byte range of the instance within `path`, always present, for tooling resolution. */
  span: WireSpan
  /** The origin-specific identity within `path`; `null` for a `file` match. */
  locator: WireInstanceLocator | null
  /**
   * The instance's own `#:` head docstring — a leading `#:` block before its
   * first key. The value-surface twin of the type-def `doc` the `types` read
   * carries; advisory, never validated. A plain `#` comment stays incidental,
   * never surfaced. Additive, no `schema_version` bump. Absent when none.
   */
  doc?: string
  /**
   * Field name to that field's `#:` docstring, documented fields only. The
   * value-surface twin of `WireField.doc`; advisory, never validated. Present
   * on `file` / `nested` / `meta` origins alike. Additive, no `schema_version`
   * bump. Absent when no field is documented.
   */
  field_docs?: Record<string, string>
  /**
   * The resolved view of the match's FILE (the `instance` read's payload),
   * present ONLY under the `instance: true` arg (**schema 17**). Keyed by the
   * match's file and computed once per unique path — server-side composition that
   * collapses a consumer's `1 + kN` round trips into one call.
   */
  instance?: WireInstance
  /**
   * The match file's markdown BODY (the prose after frontmatter), present ONLY
   * under the `body: true` arg (**schema 17**); `null` when the file is
   * unreadable or opens an unterminated frontmatter. A file with no frontmatter
   * is all body. Named `body`, not `content`: the whole-file text is the
   * standalone `content` read, so this serves only the body a consumer would
   * otherwise strip by hand.
   */
  body?: string | null
}

/**
 * Optional args for the `instances_of` read. All optional; an unknown arg is an
 * `error` frame, so a mistyped `instance` / `body` never quietly answers with the
 * fact absent.
 * - `origins` — an include-set filter over the site kinds to return; absent means
 *   ALL (**schema 13**).
 * - `instance` — `true` splices each match's resolved view (the `instance` read's
 *   payload) onto its record (**schema 17**), default false.
 * - `body` — `true` splices each match's markdown body onto its record
 *   (**schema 17**), default false.
 * The two flags are independent (either / both / neither), each opt-in server-side
 * composition that collapses a consumer's `1 + kN` round trips into one call.
 */
export interface WireInstancesOfArgs {
  origins?: WireInstanceOrigin[]
  instance?: boolean
  body?: boolean
}

/**
 * Result of the `instances_of` read: match records, one per (instance, matched
 * identity), across all requested origins (see `WireInstancesOfArgs`).
 *
 * BREAKING vs schema 16 (**schema 17**): `owners` is now `type_owners`, a new
 * always-present `member` names the instance file's owner, and the opt-in
 * `instance` / `body` fields splice per-match facts under the `instance: true` /
 * `body: true` args.
 *
 * BREAKING vs schema 12: the default returns `nested` + `meta` matches in
 * addition to `file` (pass `origins: ["file"]` for the old file-only stream),
 * and each record gains `origin` / `span` / `locator`. `path` is the containing
 * file and `fields` the instance's own body.
 */
export type WireInstancesOfResult = WireInstanceMatch[]

// ---------------------------------------------------------------------------
// imports

/**
 * One `imports` record: an (importing repo, imported peer identity) pair.
 * The fold-axis `::repo` use — a `type:` claim, parent, `use:` target, or meta
 * `type:` that names a peer repo — not a field-shape `foo::repo*` reference (the
 * seam), which is excluded. An unresolvable `::repo` is excluded here too; the
 * gate diagnostics (`type-repo-*` / `peer-type-not-found`) own that feedback.
 */
export interface WireImportRecord {
  /** The repo whose files authored the `::repo` use. */
  importer: string
  /** The imported peer type's name. */
  name: string
  /** The peer repo it is imported from, the `::repo` as authored. */
  owner: string
  /** The resolved closure-hash identity, hex; equal hashes are the same type. */
  hash: string
}

/**
 * Result of the argless `imports` read: the discovered fold-axis `::repo`
 * use set across the workspace, one record per (importing repo, imported peer
 * identity).
 */
export type WireImportsResult = WireImportRecord[]

// ---------------------------------------------------------------------------
// type identity (shared: type_closure, validate_value)

/**
 * A cross-repo type identity: the `(name, repo, closure-hash)` triple every
 * cross-repo type result carries. Equal `hash`es are the same type across repos.
 */
export interface WireTypeIdentity {
  name: string
  repo: string
  /** The closure-hash half of the `TypeId`, hex. */
  hash: string
}

// ---------------------------------------------------------------------------
// type_closure

/**
 * One field of a `type_closure` entry: a `WireField` (the same `name` / `shape` /
 * `shape_ast` / `required` / `doc` the `types` read renders) plus `origin`, the
 * type-def identity that DECLARES it — go-to-definition on a field key without a
 * client-side closure walk. `key_span` is absent here (fields are gathered
 * across origins with no per-origin source site); use `origin` for navigation.
 */
export interface WireClosureField extends WireField {
  /** The type-def that declares this field, owner-resolved. */
  origin: WireTypeIdentity
}

/**
 * One `type_closure` entry: the resolved ancestor closure and effective field
 * set of one type identity. One traversal answers the three queries consumers
 * were each re-deriving client-side — effective fields, field origin, and
 * ancestor / kind membership — and it is the same walk the validator runs.
 */
export interface WireTypeClosureEntry {
  /** The type this closure is for. */
  identity: WireTypeIdentity
  /**
   * The ancestor closure, SELF FIRST then name-sorted, each OWNER-RESOLVED to the
   * repo that actually owns it (so a `parent::repo` edge reports the peer, not the
   * importing member).
   */
  ancestors: WireTypeIdentity[]
  /**
   * The effective field set: own fields plus every ancestor's, deduped by name
   * and name-sorted. A field auto-unified across origins reports the lex-min one.
   * A DIVERGENT field (origins disagreeing on shape) is now PRESENT too
   * (**schema 28**), reporting its canonical lex-min origin here; its per-origin
   * shapes live on the instance-level `effective_shape`. Previously such a field
   * was excluded from this read.
   */
  fields: WireClosureField[]
}

/**
 * Result of the `type_closure` read (**schema 17**, NEW): MULTI-FIT, an ARRAY,
 * one entry per matching identity. A BARE `name` conflates across mounted repos,
 * so it answers one closure per identity, each owner-and-hash qualified; a
 * `::repo` (or the `repo` arg) scopes to the 0-or-1 identity that repo owns. An
 * unknown name is an EMPTY array — the zero case reached the same way as one and
 * N, never a null or an error.
 *
 * FLAG: a consumer expecting a single object will read `[0]`-shaped data wrong.
 */
export type WireTypeClosureResult = WireTypeClosureEntry[]

// ---------------------------------------------------------------------------
// hubs

/** What kind of file a `hubs` entry is. Reuses the `overview.hubs` element shape (`WireHub`). */
export interface WireHubsArgs {
  /** Scope to one member (absent spans every mounted member). A location pin: flips the `scope` default to `all`. */
  repo?: string
  /** `own` (default) / `all`; see the scope-default rules on `readHubs`. */
  scope?: WireTypeScope
  /** At most this many hubs, after `offset`. Absent = the engine's top-N (the bound `overview.hubs` carries). */
  limit?: number
  /** Skip this many ranked hubs before the page. Absent is 0. */
  offset?: number
}

/**
 * Result of the `hubs` read (**schema 17**, NEW — promoted out of `overview`):
 * the most-referenced files over the typed reference graph, ranked
 * `refs_structural` desc, then `refs_total` desc, then path. A file with no
 * inbound edges never appears. Scoping happens BEFORE ranking and truncation, so
 * a large dependency cannot crowd own content out of the top-N.
 */
export type WireHubsResult = WireHub[]

// ---------------------------------------------------------------------------
// graph_shape / link_graph — the whole-graph reads over the backlink index

/**
 * Args for the `graph_shape` read. All optional.
 * - `repo` scopes to one member's graph (absent spans the workspace). A location
 *   pin: flips the `scope` default to `all`.
 * - `scope` (`own` default / `all`); an explicit value wins over the `repo` flip.
 * - `orphan_paths` opts into the unbounded orphan path list (`orphans.paths`),
 *   off by default so a fragmented corpus's thousands of orphans stay behind a
 *   flag — counts are always present.
 */
export interface WireGraphShapeArgs {
  repo?: string
  scope?: WireTypeScope
  orphan_paths?: boolean
}

/** One orphan file in `graph_shape`, `kind` tagging which orphan sense it satisfies. */
export interface WireGraphOrphanPath {
  path: string
  /** `no_inbound` (nothing points at it) or the stricter `isolated` (no inbound AND no outbound). */
  kind: 'no_inbound' | 'isolated'
}

/**
 * The two orphan senses. `no_inbound` counts files nothing points at (the useful
 * sense); `isolated` counts files with no inbound AND no outbound (the strict
 * subset, a singleton component). `paths` is present only with `orphan_paths: true`.
 */
export interface WireGraphOrphans {
  no_inbound: number
  isolated: number
  /** Present only when the read's `orphan_paths` is set; sorted by path. */
  paths?: WireGraphOrphanPath[]
}

/** One bucket of a degree histogram: `count` nodes carry exactly `degree` edges on that axis. */
export interface WireDegreeBin {
  degree: number
  count: number
}

/** The in- and out-degree distributions, each a histogram sorted by `degree`. The distribution SHAPE is the signal; `hubs` serves the per-node top. */
export interface WireDegreeDistribution {
  in: WireDegreeBin[]
  out: WireDegreeBin[]
}

/**
 * The `graph_shape` read result: the scalar whole-graph summary folded from the
 * catalog + backlink index — the "your knowledge base is 14 disconnected
 * components" signal. Raw facts, NO thresholds; the consumer applies its own
 * policy (the same fact-not-policy split `hubs` took). The node universe is the
 * CONTENT catalog (engine-schema files excluded); edges are the resolved backlink
 * index with both endpoints in scope. Mirrored by `overview.graph_shape` (with
 * `orphan_paths` off). Additive, no `schema_version` bump.
 */
export interface WireGraphShape {
  /** The RESOLVED `repo` / `scope`, echoed back, same as `overview`. */
  repo: string | null
  scope: WireTypeScope
  node_count: number
  edge_count: number
  /** The `edge_count` split by the `slot != null` partition `hubs` uses, so density per basis is derivable. */
  edges_structural: number
  edges_navigational: number
  /** Weakly-connected-component count over the undirected COMBINED graph (structural + navigational joined — any link joins two files into one island). */
  components: number
  /** The node count of the biggest component — distinguishes "14 tiny islands" from "one web plus 13 strays". */
  largest_component: number
  orphans: WireGraphOrphans
  degree: WireDegreeDistribution
  /** `edge_count / node_count`, a convenience over the raw counts. */
  density: number
}

export type WireGraphShapeResult = WireGraphShape

/**
 * Args for the `link_graph` read: the same `repo` / `scope` pair as
 * `graph_shape`. Richer server-side filters (edge kinds, type filters, path
 * prefix) are a deferred engine follow-on; an unknown arg is an `error` frame.
 */
export interface WireLinkGraphArgs {
  repo?: string
  scope?: WireTypeScope
}

/**
 * One node in a `link_graph` (and in the `link-graph` subscription's
 * `nodes_added` delta): one in-scope CONTENT file, isolated ones INCLUDED (a
 * graph view draws floating orphans). Carries the same inbound hub counts `hubs`
 * computes, for free node-sizing. Counts are over the IN-SCOPE inbound edges, so
 * a node's `refs_total` equals its inbound-edge count in the same payload
 * (`refs_navigational` is `refs_total - refs_structural`).
 */
export interface WireGraphNode {
  path: string
  /** The owning repo, or null. */
  repo: string | null
  kind: WireParseKind
  refs_structural: number
  refs_total: number
}

/**
 * One resolved reference edge in a `link_graph`, source to target. Resolved
 * edges only — a dangling link is a diagnostic (`reference-target-missing`),
 * never an edge here. Edge multiplicity is preserved (two links to one target
 * are two edges), so `refs_total` and the edge rows agree. `kind` / `surface`
 * reuse the coarse `references_in` vocabulary.
 */
export interface WireGraphEdge {
  from: string
  to: string
  /** The coarse edge kind (`field` / `contributing` / `navigational`). */
  kind: WireReferenceInKind
  /** The referrer surface (`frontmatter` / `body`). */
  surface: WireReferenceInSurface
}

/**
 * The `link_graph` read result: the full node+edge payload a whole-graph
 * (force-directed) visualization lays out. The un-ranked, un-truncated sibling of
 * `hubs`, and the global-unseeded complement of the seeded `neighborhood` walk.
 * `nodes` sorted by `path`, `edges` sorted by `(from, to, kind, surface)`, so the
 * payload is deterministic and the `link-graph` subscription diff is stable. A
 * consumer keeps it fresh via the `link-graph` SUBSCRIPTION, which streams
 * node/edge deltas rather than re-shipping the payload. Additive, no
 * `schema_version` bump.
 */
export interface WireLinkGraph {
  /** The RESOLVED `repo` / `scope`, echoed back. */
  repo: string | null
  scope: WireTypeScope
  nodes: WireGraphNode[]
  edges: WireGraphEdge[]
}

export type WireLinkGraphResult = WireLinkGraph

// ---------------------------------------------------------------------------
// type_graph — the SCHEMA graph as a node+edge payload, the type-side sibling
// of link_graph (distinct from the reference/wikilink graph link_graph folds).

/**
 * A `type_graph` edge relation, direction source to target.
 * - `subtype` — target is a declared parent of source.
 * - `field-type` — source declares a field typed as target (weighted by `count`).
 * - `instance-of` — a claiming instance node to its type-def (opt-in via `edges`).
 * - `meta` — a type-def to the type-def that types it (opt-in via `edges`).
 */
export type WireTypeGraphRelation = 'subtype' | 'field-type' | 'instance-of' | 'meta'

/**
 * Args for the `type_graph` read: the same `repo` / `scope` pair as `link_graph`,
 * plus an optional `edges` relation filter. Absent `edges` is
 * `["subtype", "field-type"]`, the type-to-type backbone; `instance-of` (adds
 * claiming-instance nodes) and `meta` are opt-in. An unknown `edges` value is an
 * `error` frame. `scope` defaults to `own`; a `repo` pin flips it to `all`, an
 * explicit `scope` wins.
 */
export interface WireTypeGraphArgs {
  repo?: string
  scope?: WireTypeScope
  edges?: WireTypeGraphRelation[]
}

/**
 * One node in a `type_graph` (and in the `type_graph` subscription's
 * `nodes_added` delta): an in-scope type-def, plus a claiming instance when
 * `instance-of` is requested. Node identity is `path`, so the payload merges with
 * `link_graph` by path. NO ref counts here — the reference-graph counts stay on
 * `link_graph`; node sizing derives from the edges (subtype / instance-of in-degree).
 */
export interface WireTypeGraphNode {
  path: string
  /** The owning repo, or null. */
  repo: string | null
  /** `type-def` for a schema node, `instance` for a claiming-instance node. */
  kind: 'type-def' | 'instance'
}

/**
 * One resolved edge in a `type_graph`, source to target, induced on in-scope
 * endpoints (an edge counts only when BOTH endpoints are in scope, like
 * `link_graph`). Unique per `(from, to, relation)`; the `type_graph` subscription
 * UPSERTs on that key (see `TypeGraphHint`).
 */
export interface WireTypeGraphEdge {
  from: string
  to: string
  relation: WireTypeGraphRelation
  /** Weights a `field-type` edge by the number of field references to the target; 1 for the others. */
  count: number
}

/**
 * The `type_graph` read result: the SCHEMA graph as a node+edge payload, the
 * type-side sibling of `link_graph`, drawn beside it and merged by `path`. The
 * type graph is a distinct held structure from the reference (wikilink) graph
 * `link_graph` folds. `nodes` sorted by `path`, `edges` sorted by
 * `(from, to, relation)`, so the payload is deterministic and the `type_graph`
 * subscription diff is stable. Keep it fresh via the `type_graph` SUBSCRIPTION,
 * which streams node/edge deltas. Additive within the schema 23 bump.
 */
export interface WireTypeGraph {
  /** The RESOLVED `repo` / `scope`, echoed back. */
  repo: string | null
  scope: WireTypeScope
  nodes: WireTypeGraphNode[]
  edges: WireTypeGraphEdge[]
}

export type WireTypeGraphResult = WireTypeGraph

// ---------------------------------------------------------------------------
// validate_value

/**
 * One `validate_value` verdict: the diagnostics one mounted identity's shape
 * gives the value. `identity` is `null` for the unknown-name verdict (see
 * `WireValidateValueResult`).
 */
export interface WireValidateValueVerdict {
  /** The identity validated against; `null` for the fail-closed unknown-name verdict. */
  identity: WireTypeIdentity | null
  /** The verdict for that one identity — the same shape and codes as the `diagnostics` read. */
  diagnostics: WireDiagnostic[]
  /**
   * The value keys not in this identity's effective shape. ADVISORY, not a
   * diagnostic: undeclared fields are LEGAL under open-world validation. It
   * surfaces them so a caller can catch a typo'd extra that quietly passed, even
   * when the extra is not a near-miss of a required field. EMPTY for a null
   * identity (no shape to compare). The injected `type` claim and prefixed
   * `origin:field` keys are excluded — they are not plain fields.
   */
  undeclared_fields: string[]
}

/**
 * Result of the `validate_value` read (**schema 17**): MULTI-FIT and FAILS
 * CLOSED. One verdict PER mounted identity the name denotes — a bare name owned
 * by N repos returns N verdicts, each validated against ITS OWN identity's shape;
 * a `repo` arg or a `::repo` narrows to the 0-or-1 identity that repo owns.
 *
 * FAILS CLOSED on an unknown name: a name no mounted repo owns returns ONE verdict
 * with `identity: null` carrying `unknown-type-claim` (plus any structural
 * diagnostics the value itself has), NEVER an empty array — a consumer folding
 * `diagnostics` across the verdicts must see the miss as an error, not read `[]`
 * as a clean bill of health and wave an unvalidated value through.
 */
export type WireValidateValueResult = WireValidateValueVerdict[]

// ---------------------------------------------------------------------------
// preview_mutation

/**
 * The target verdict of a `preview_mutation`: the would-be file's resolved type
 * identities and its diagnostics, plus its resulting path and content hash.
 * Git-free — type + diagnostics come from the same recompute a real rebuild
 * runs, so a preview cannot disagree with what the write would land.
 */
export interface WirePreviewTarget {
  /** The resolved target path. */
  path: string
  /**
   * The would-be content hash — doubles as the `expected_hash` a later real write
   * can guard on. `null` for a `delete_file` (the file is gone).
   */
  hash: string | null
  /**
   * The `(name, repo, hash)` identities the would-be file CLAIMS, each resolved in
   * the file's own repo. EMPTY for a plain note (no `type:`) and for a delete. The
   * pre-tool gate "is this a valid `X`" checks `identities` contains `X` AND
   * `diagnostics` carry no error-severity finding.
   */
  identities: WireTypeIdentity[]
  /**
   * The would-be file's diagnostics — the same shape and codes as the
   * `diagnostics` read, WHOLE-file (body typing runs too, unlike
   * `validate_value`'s frontmatter-only verdict).
   */
  diagnostics: WireDiagnostic[]
}

/**
 * One `blast_radius` entry: another file whose diagnostics DIFFER from the current
 * knowledge base because of the previewed write (a delete's dangled referrers, a
 * type-def edit's broken dependents, a write's fixed referrers), and its would-be
 * diagnostics. Per-FILE only; a repo-level diagnostic change is not projected here.
 */
export interface WirePreviewBlastEntry {
  path: string
  diagnostics: WireDiagnostic[]
}

/**
 * The built product of a `preview_mutation`: the target verdict plus the blast
 * radius. The other arm of `WirePreviewMutationResult` is a `{ reject }`.
 */
export interface WirePreviewProduct {
  target: WirePreviewTarget
  blast_radius: WirePreviewBlastEntry[]
}

/**
 * A structural reject arm of `preview_mutation`: the op refused before any product
 * existed (an edit or delete of an absent file, an absent or non-unique
 * `old_string`, a stamp on a non-list field, a path that mounts nowhere). A reject
 * is DATA on a SUCCESSFUL read, not an error frame.
 */
export interface WirePreviewReject {
  reject: {
    message: string
    /** Machine-usable context on the refusal, primitive-specific; absent for most. */
    detail?: unknown
  }
}

/**
 * Result of the `preview_mutation` read: simulate a deterministic mutation over an
 * overlay of the current snapshot and report its product, with NO disk write and
 * NO commit. Untagged union of the two arms — DISCRIMINATE with `'reject' in
 * result`: a `{ reject }` is a structural refusal, else it is a
 * `{ target, blast_radius }` built product.
 *
 * Additive (**schema stays 24**). v1 covers `write_file` / `edit_file` /
 * `delete_file` on PHYSICAL files; the structural refactors (rename / promote /
 * inline / rename_type) are not previewable yet.
 */
export type WirePreviewMutationResult = WirePreviewProduct | WirePreviewReject

// ---------------------------------------------------------------------------
// The value layer (instances, instance)

/** One root-to-leaf section path entry. `index` is the 1-based sibling index. */
export interface WireSectionPathSegment {
  index: number
  text: string
}

/**
 * Which surface a contribution originated from.
 *
 * `body_fence` is a marked body fence, ` ```[:field] ` (**schema 19**, RENAMED
 * from `body_yaml_block`, no alias). The fence is the MULTI-LINE CARRIER and
 * its content-form comes from the slot, so the surface names the carrier,
 * never a content type — which is why `yaml` had to go. See
 * `WireContributionValue` for the kind the carrier yields.
 *
 * The fence's language tag carries NO engine meaning: ` ```yaml [:f] `,
 * ` ```md [:f] `, and a bare ` ```[:f] ` are the same contribution, and a tag
 * disagreeing with the slot is silent. A consumer must not read the tag as the
 * content-form.
 */
export type WireContributionSurface = 'frontmatter' | 'body_wikilink' | 'body_fence' | 'body_inline_code'

/** File plus byte range of a contribution. */
export interface WireLocation {
  file: string
  byte_range: WireSpan
}

/**
 * A wikilink's block-id fragment on a REFERENCE surface: the id, plus the mode
 * the sigil selected. Mirrors au-references `BlockId`. The mode is the link's
 * own, decided locally, never the target's typed-ness:
 * - `referent: true` — a `^^id` block-referent; the block's typed value fills
 *   the slot.
 * - `referent: false` — a bare `^id`; navigational, the FILE is the referent
 *   and `^id` is a jump anchor into it.
 *
 * `referent` is always present on the wire (a plain bool, never skipped). Block
 * DECLARATION surfaces (`WireRecordBlockId.id`, a fenced block's
 * `trailing_block_id`, `WireReferenceIn.source_block_id`, the `assign_block_id`
 * result id) stay bare strings — they carry no mode.
 */
export interface WireBlockId {
  id: string
  referent: boolean
}

/**
 * One element of a `tuple` contribution value: the element's own resolved
 * value, plus the brand it was written with. A tuple element's brand sits HERE,
 * on the element (`"color"` for a `color(1)` element of
 * `rgb(color(1), color(2), color(3))`), NOT duplicated onto its inner `value` —
 * read a tuple element's brand from the element, and the inner `value` carries
 * no `brand` of its own. `value` is a nested contribution value, recursive.
 */
export interface WireTupleElement {
  value: WireContributionValue
  /** The element's written brand name, omitted for a bare (unbranded) element. */
  brand?: string
}

/**
 * One nested field of an `inline_record` contribution value (**schema 29**):
 * the field key plus its resolved values, `values` being that nested field's
 * list of contribution values (one for a scalar slot, N for a list slot), each
 * recursively resolved. So a tuple / brand / reference INSIDE a nested record
 * reads resolved exactly like a top-level field, to any depth.
 */
export interface WireInlineRecordField {
  field: string
  values: WireContributionValue[]
}

/**
 * A resolved contribution value. The wikilink `:field` fragment is identity,
 * not a value, so `reference` intentionally does not carry it.
 *
 * The value model interprets each authored value exactly ONCE and serves the
 * resolved model on every read: no read surfaces a raw constructor string, a
 * raw tuple string, or a lossy reference. The union is TOTAL — a value that
 * fails to parse still gets a named node (`malformed_constructor` /
 * `malformed_reference`), never a lossy `scalar`.
 *
 * A `body_fence` contribution's kind follows the SLOT (**schema 19**), so the
 * same fence syntax now produces either kind — do NOT narrow the surface to a
 * kind:
 * - a `String` or `any` slot yields `scalar`, holding the content VERBATIM.
 *   Verbatim means verbatim: blank lines and indentation survive, nothing is
 *   trimmed or folded. It previously yielded `inline_record`, yaml-parsed.
 * - a record-bearing slot is unchanged, still `inline_record`.
 * - a UNION slot disambiguates by the inline `type:`: content parsing wholly as
 *   a mapping that carries `type:` takes the record branch, anything else the
 *   text branch.
 */
export type WireContributionValue =
  | {
      kind: 'scalar'
      /**
       * ALWAYS the resolved underlying form: `meter(5)` and a bare `5` both
       * yield `value: 5`.
       */
      value: unknown
      /**
       * The brand constructor NAME the author wrote (`"meter"` for `meter(5)`,
       * a peer brand keeps its qualifier `"meter::units"`) — the discriminator
       * at a union brand, a round-trip signal elsewhere. Omitted for a bare
       * value and for a reserved-primitive escape (`String("x")`, not a brand).
       * Additive, no `schema_version` bump.
       */
      brand?: string
    }
  | {
      kind: 'reference'
      target: string
      anchor: string | null
      block_id: WireBlockId | null
      /**
       * The `::repo` qualifier when the contribution's link crosses a repo
       * boundary; omitted for an own-repo link. Mirrors `WireReferenceOut.repo`
       * (omitted, not null), so two contributions differing only by repo stay
       * distinct — `[[bar]]` and `[[bar::other]]` no longer collapse.
       */
      repo?: string
      /**
       * The `@commit` pin for a commit-pinned reference (`[[bar::@a1b2c3d]]`);
       * omitted for an unpinned link. Round-trips now, mirroring
       * `WireReferenceOut.commit`. Additive, no `schema_version` bump.
       */
      commit?: string
    }
  /**
   * A tuple `(a, b)` / `Name(a, b)` value, a fixed-arity positional product.
   * `elements` are the per-position resolved values, order significant. The
   * INLINE value form is the PAREN form — a `[...]` bracket is always a LIST,
   * never a tuple. Additive value kind, no `schema_version` bump; where a tuple
   * previously read as a raw-constructor `scalar` it now reads structured.
   */
  | {
      kind: 'tuple'
      elements: WireTupleElement[]
      /**
       * The tuple brand's written name (`"point"` for `point(20, 30)`); omitted
       * for the nameless inline form `(20, 30)`.
       */
      brand?: string
    }
  /**
   * A nested record value (**schema 29**, BREAKING): `fields` REPLACES the
   * former `value: <raw JSON mapping>`, whose inner tuple / brand / reference
   * values were unresolved strings. Each field's `values` are recursively
   * resolved, so a nested value reads exactly like a top-level field, to any
   * depth. A nested field whose record type does not resolve degrades to
   * faithful untyped `scalar` values, never absent, never a raw mapping.
   */
  | { kind: 'inline_record'; fields: WireInlineRecordField[] }
  /**
   * A wikilink-shaped value at a reference slot that did not parse (an
   * out-of-order fragment, a non-oid pin, an invalid field name). `raw` is the
   * verbatim surface. Names what previously read as a lossy `scalar`, so a read
   * never surfaces a broken reference. Additive value kind, no `schema_version`
   * bump; the malformed-wikilink diagnostic is unchanged.
   */
  | { kind: 'malformed_reference'; raw: string }
  /**
   * A value that opens a `Name(...)` constructor at a brand slot but does not
   * close well-formed (`meter(42`). `raw` is the verbatim surface. Names what
   * previously read as a lossy `scalar`. Additive value kind, no `schema_version`
   * bump; the `malformed-constructor` warning is unchanged.
   */
  | { kind: 'malformed_constructor'; raw: string }

/** One contribution: surface, location, enclosing section chain, resolved value. */
export interface WireContribution {
  surface: WireContributionSurface
  location: WireLocation
  /** Root-to-leaf section chain; empty for frontmatter and body-preamble contributions. */
  section_path: WireSectionPathSegment[]
  value: WireContributionValue
  /**
   * The collision qualifier a body attribution wrote (**schema 28**), naming
   * which divergent origin it fills: the `field{type}` in `` `[:field{type}]` ``,
   * `[[x:field{type}]]`, or a ```` ```[:field{type}] ```` fence. `type_name` is
   * the origin type (bare); `repo` its `::repo` when the qualifier crosses a repo
   * boundary, omitted otherwise. Omitted entirely for a bare attribution or a
   * frontmatter contribution.
   */
  qualifier?: { type_name: string; repo?: string }
}

/** One unique value plus the contributions that produced it. */
export interface WireValueContainer {
  value: WireContributionValue
  contributions: WireContribution[]
}

/** One field's contribution set. */
export interface WireFieldValues {
  field: string
  containers: WireValueContainer[]
}

/** One declared top-level section's coverage in an instance. */
export interface WireSectionPresence {
  name: string
  optional: boolean
  /** 1 for top-level declared sections, 2 for sub-sections, … */
  depth: number
  /** Stripped name-only path from the body root to this section. */
  path: string[]
  present: boolean
  /** The matched heading's byte range; absent when not present. */
  span?: WireSpan
}

/**
 * The parsed breakdown of a wikilink's
 * `target[::repo][@commit][#anchor][^block_id][:field]` grammar (`^^` marks a
 * block-referent). Emitted as `body_events.wikilink.parsed`, and the shape the
 * SDK's own `parseWikilink` returns.
 */
export interface WireWikilinkParts {
  target: string
  /**
   * The `::repo` qualifier, the target repo crossed into; null for an
   * unqualified (repo-local) link. Present-but-nullable, unlike the omitted
   * `repo` on `references_out` / the semantic tokens.
   */
  repo: string | null
  /**
   * The `@commit` pin: the commit-ish whose tree the reference resolves
   * against, deletion-stable and version-exact. Binds to `::repo`, so it is
   * written `[[file::repo@commit]]`, or `[[file::@commit]]` to pin against this
   * repo. Verbatim commit-ish — validity is a resolution-time concern. null for
   * an unpinned link, resolved against the working tree. Present-but-nullable
   * here, like its sibling fragments; the resolved-edge `references_out` surface
   * carries the same pin as `WireReferenceOut.commit` (omitted there, not null).
   */
  commit: string | null
  anchor: string | null
  /** `{ id, referent }` on the reference surface, or null when the link carries no `^`. */
  block_id: WireBlockId | null
  field: string | null
}

/**
 * One raw body event. Wikilink events carry the `parsed` breakdown when the
 * raw text parses; malformed input still surfaces with `raw` alone.
 */
export type WireBodyEvent =
  | { kind: 'heading'; level: number; text: string; span: WireSpan }
  | { kind: 'fenced_block'; info: string; body: string; span: WireSpan; trailing_block_id?: string }
  | { kind: 'inline_code'; content: string; span: WireSpan }
  | { kind: 'wikilink'; raw: string; span: WireSpan; parsed?: WireWikilinkParts }
  | { kind: 'block_id_marker'; id: string; span: WireSpan }
  | { kind: 'unterminated_fence_open'; info: string; span: WireSpan }

/** One addressable inline record: `^:` id, effective claims, the id value's span. */
export interface WireRecordBlockId {
  id: string
  /**
   * Effective claim names, explicit or slot-pinned; empty for a claim-less
   * record. A cross-repo claim reads `name::repo` verbatim, like the instance
   * `type:` claim.
   */
  claims: string[]
  span: WireSpan
}

// ---------------------------------------------------------------------------
// instances

export interface WireEffectiveShapeOrigin {
  name: string
  /**
   * The owner of a folded cross-repo peer origin (**schema 28**), so two
   * divergent same-named origins `note` vs `note::base` stay distinct. Omitted
   * for an own-repo origin.
   */
  repo?: string
  origin_path: string
  /** This origin's OWN shape expression (**schema 28**); the discriminator when the field is `divergent`. */
  shape: string
  /** This origin's OWN required flag (**schema 28**). */
  required: boolean
}

export interface WireEffectiveShapeEntry {
  field: string
  /**
   * The shape expression; a folded cross-repo peer field reads `foo::repo*`, not
   * `foo*`. When `divergent` is `true` this is just ONE origin's (there is no
   * single shape) — read the per-origin `origins[].shape` instead.
   */
  shape: string
  required: boolean
  /**
   * `true` when the origins disagree on shape (**schema 28**): the field is kept
   * and resolved per-origin by a `field{type}` qualifier, not dropped. The
   * top-level `shape` / `required` are then one origin's; the per-origin shapes
   * live on `origins`. Previously such a field was excluded from the effective
   * shape and surfaced on a separate `collisions` channel (now REMOVED).
   */
  divergent: boolean
  /** One entry per contributing origin; multiple under a divergent field or auto-unify. */
  origins: WireEffectiveShapeOrigin[]
}

/** One resolved instance's full introspection. */
export interface WireInstanceEntry {
  file: string
  /** The instance's `type:` claim; a cross-repo claim reads `name::repo`. */
  claim: string[]
  /**
   * The type names the instance conforms to (its claim plus transitive
   * ancestors), rendered OWNER-RELATIVE: an ancestor a peer owns keeps its
   * `::repo` (a `card` extending `note::base` reads `["card", "note::base"]`),
   * one the instance's own repo defines stays bare. This is owner-relative, NOT
   * verbatim like `claim`: an in-sync identity written `note::base` whose own
   * repo also defines it can read bare `note`. A cross-repo diamond lists both
   * divergent same-named identities as distinct entries, so DO NOT dedupe
   * `closure` by base name.
   */
  closure: string[]
  effective_shape: WireEffectiveShapeEntry[]
  /** One entry per field with at least one contribution. */
  effective_values: WireFieldValues[]
  /**
   * Top-level declared sections. `null` when the instance's type has no
   * `body:` template, `[]` for a body-declaring type without `section:` items.
   */
  section_presence: WireSectionPresence[] | null
  /** `null` for pure-YAML instances, `[]` for markdown bodies producing no events. */
  body_events: WireBodyEvent[] | null
  /** Omitted when the instance carries no addressable inline records. */
  record_block_ids?: WireRecordBlockId[]
}

/**
 * Result of the `instances` read: `{ count, aborted_at_load, instances }`. The
 * payload is `instances`; `count` and `aborted_at_load` are envelope-level
 * metadata beside it, so the helper keeps the whole object. **Schema 17**: the
 * payload key was `entries`.
 */
export interface WireInstancesResult {
  /** Every PARSED instance; `instances` carries only the RESOLVED ones, so this can exceed their count. */
  count: number
  /** True when a broken vocabulary skipped instance validation, so `instances` is empty for that reason. */
  aborted_at_load: boolean
  instances: WireInstanceEntry[]
}

// ---------------------------------------------------------------------------
// candidates

export interface WireCandidateScope {
  file_path: string
  /** RFC 6901 JSON pointer to the scope inside the file (`""` = top level). */
  inline_path: string
}

/** One ranked candidate: a type the file could claim but does not. */
export interface WireCandidate {
  type_name: string
  scope: WireCandidateScope
  satisfied_required: string[]
  also_satisfied_optional: number
  /** Leaves of the same sealed family this candidate would supersede; empty for a clean addition. */
  supersedes: string[]
}

/** A file's candidates. Present even when empty, so scanned-and-empty is distinct from not-scanned. */
export interface WireFileCandidates {
  file: string
  candidates: WireCandidate[]
}

/**
 * Optional args for the `candidates` read: projection and paging. All optional;
 * no args is the full-detail scan. An unknown arg is an `error` frame. The scan
 * is knowledge-base-wide, so there is no `repo` scope.
 * - `summary: true` projects each file to `WireFileCandidatesSummary` (a flat
 *   array of candidate type names); absent / `false` is full per-candidate detail.
 * - `limit` / `offset` page the file list in the catalog's sorted order
 *   (`limit` files after `offset`); absent `limit` returns every scanned file.
 */
export interface WireCandidatesArgs {
  summary?: boolean
  limit?: number
  offset?: number
}

/**
 * Result of the `candidates` read: `{ aborted_at_load, candidates }`. The
 * payload is `candidates` (grouped by file); `aborted_at_load` is envelope-level
 * metadata beside it, so the helper keeps the whole object. **Schema 17**: the
 * payload key was `files`.
 */
export interface WireCandidatesResult {
  aborted_at_load: boolean
  candidates: WireFileCandidates[]
}

/**
 * A file's candidates under `summary: true`: the file plus a flat array of its
 * candidate `type_name`s in ranked order. The per-candidate detail (`scope`,
 * `satisfied_required`, `also_satisfied_optional`, `supersedes`) is dropped;
 * pair with `candidate_counts` for the totals.
 */
export interface WireFileCandidatesSummary {
  file: string
  candidates: string[]
}

/**
 * Result of the `candidates` read under `summary: true`: the same
 * `{ aborted_at_load, candidates }` envelope, each file projected to its
 * `WireFileCandidatesSummary`.
 */
export interface WireCandidatesSummaryResult {
  aborted_at_load: boolean
  candidates: WireFileCandidatesSummary[]
}

/**
 * Result of the argless `candidate_counts` read: the shape of the scan without
 * materializing every file's candidates, the candidates dual of
 * `diagnostic_counts`. Any arg is an `error` frame (knowledge-base-wide, over the full set).
 */
export interface WireCandidateCountsResult {
  /** True when a broken vocabulary skipped the scan, matching `candidates`, so a zero count from a skipped scan stays distinct from an empty one. */
  aborted_at_load: boolean
  /** Every scanned file (candidate-bearing or not), reconciling with the `candidates` read's file count. */
  total_files: number
  /** Files with at least one candidate. */
  files_with_candidates: number
  /**
   * Candidate type name → the number of FILES it is a candidate for ("N
   * untyped files could claim type X"), name-sorted. A type is counted once per
   * file even if it is a candidate at several scopes there.
   */
  by_type: Record<string, number>
}

// ---------------------------------------------------------------------------
// instance

/** A candidate as the `resolved` read carries it (scope flattened to the pointer). */
export interface WireResolvedCandidate {
  type_name: string
  inline_path: string
}

/**
 * One instance's resolved view. The result is null when the path is not a
 * parsed instance; a note has no typed value layer.
 */
export interface WireInstance {
  /** False when the claim doesn't resolve (no effective shape); `closure` is then empty. */
  resolved: boolean
  /** The instance's `type:` claim; a cross-repo claim reads `name::repo`. */
  claim: string[]
  /** Conformed type names (claim plus transitive ancestors), rendered OWNER-RELATIVE as on `instances`: a peer-owned ancestor keeps its `::repo`, an own-repo one stays bare. Don't dedupe by base name — a diamond lists both same-named identities. */
  closure: string[]
  candidates: WireResolvedCandidate[]
  effective_values: WireFieldValues[]
  section_presence: WireSectionPresence[] | null
  body_events: WireBodyEvent[] | null
  /** Omitted when none. */
  record_block_ids?: WireRecordBlockId[]
  /** This file's diagnostics. */
  diagnostics: WireDiagnostic[]
}

/** Result of the `instance` read. */
export type WireInstanceResult = WireInstance | null

// ---------------------------------------------------------------------------
// references_out / references_in

/**
 * The surface a `references_out` edge lives on: a `frontmatter` field value, a
 * `body` wikilink, or a `docstring` link — a `[[...]]` in a `#:` docstring on a
 * type-def or instance declaration (additive, no `schema_version` bump). A
 * `docstring` edge is always `kind: "navigational"`; the surface, not the kind,
 * tells a documentation reference from a prose one. A type-def now carries
 * outgoing edges for the first time via its docstring links.
 */
export type WireReferenceOutSurface = 'frontmatter' | 'body' | 'docstring'

/**
 * The classification of a `references_out` edge (**schema 17**). Load-bearing,
 * not cosmetic — the kind decides how a consumer acts on the edge and how severe
 * a break is:
 * - `field-reference` — a frontmatter value in a slot that ADMITS a reference,
 *   the value exactly one `[[...]]`. The structural edge: validated and
 *   closure-checked, a dangling one is an error. Traverse as a real dependency.
 * - `field-string-wikilink` — a `[[...]]` in a frontmatter value whose slot does
 *   NOT admit a reference (or one embedded in a longer string, or in an EXTRA
 *   field outside the effective shape). An intended-but-untyped pointer,
 *   navigational only.
 * - `contributing` — a body `[[target:field]]`, both a link and a data
 *   contribution; `field` names the field it supplies.
 * - `navigational` — a body prose `[[...]]` with no attribution, OR a `docstring`
 *   link (told apart by `surface`). A hint; a dangling one is a warning.
 * - `commit-referent` (**schema 22**) — a commit-only reference (`[[::@sha]]` /
 *   `[[::repo@sha]]`) that names a COMMIT, not a file. `resolved` is null and
 *   `commit` is set; the commit is anchored against `gc` but the edge is NEVER
 *   dangling, so a consumer must not read its null `resolved` as a broken link.
 *   Surface-independent, settled by the link's own syntax.
 * - `unknown` — a WHOLE-VALUE frontmatter wikilink on a TYPED instance whose slot
 *   the engine could not resolve (the `type:` claim did not resolve, or the
 *   repo's vocabulary aborted). NARROW: it needs a `type:` intent the engine
 *   could not honor. A note is definitively untyped, so its edges are never
 *   `unknown` — they are `field-string-wikilink`.
 *
 * The frontmatter split is decided by the SLOT, never the value's syntax:
 * `rel: "[[a]]"` (slot `note*`) and `see-also: "[[a]]"` (slot `String`) classify
 * differently. Closed set; tolerate unknown values per additive evolution.
 */
export type WireReferenceOutKind =
  | 'field-reference'
  | 'field-string-wikilink'
  | 'contributing'
  | 'navigational'
  | 'commit-referent'
  | 'unknown'

/**
 * One outgoing wikilink edge (**schema 17**): EVERY edge of the file, frontmatter
 * and body, each classified. Frontmatter edges come first (declaration order),
 * then body edges in source order. A list slot yields one edge per element.
 *
 * The read now derives from the same single traversal as `references_in`, so the
 * two directions cannot disagree; they differ in exactly one way, deliberately —
 * this read reports DANGLING edges (a null `resolved`), the index does not. The
 * LOCAL form (`[[^id]]`, `[[#head]]`) resolves to the source file itself and is
 * never dangling. A null `resolved` is not always dangling: a `commit-referent`
 * edge (**schema 22**) resolves to null because it names a commit, not a file,
 * and is anchored against `gc`, never dangling.
 */
export interface WireReferenceOut {
  target: string
  /** The resolved file path, or null when the target doesn't resolve. */
  resolved: string | null
  span: WireSpan
  /** The surface the edge lives on: `frontmatter` or `body`. */
  surface: WireReferenceOutSurface
  /** The edge's classification; see `WireReferenceOutKind`. */
  kind: WireReferenceOutKind
  /**
   * The `::repo` qualifier when the link crosses a repo boundary; omitted for
   * an unqualified link. `resolved` then points into that repo (null when the
   * repo is unavailable or the target is missing there).
   */
  repo?: string
  /**
   * The `@commit` pin, the commit-ish a pinned reference resolves against;
   * omitted for an unpinned link. Binds to `::repo` (`::repo@commit`, or
   * `::@commit` for this repo). The resolved-edge mirror of
   * `WireWikilinkParts.commit`, so the outgoing-edge set carries which edges are
   * pinned without a per-file `body_events` scan. Omitted here (not nullable),
   * unlike the present-but-nullable `commit` on the raw `parsed` breakdown.
   */
  commit?: string
  anchor?: string
  /** The `{ id, referent }` block-id fragment; omitted when the link carries no `^`. */
  block_id?: WireBlockId
  /**
   * The slot the edge fills: the frontmatter field key (the innermost key for a
   * nested value) for a frontmatter edge, or a body `contributing` link's
   * `:field` attribution. NOT body-only — EVERY frontmatter edge carries it,
   * whatever its `kind` (`field-reference` / `field-string-wikilink` /
   * `unknown`). A reference LIST slot yields one edge PER ELEMENT, each
   * attributed to its own field, so the `field` + `resolved` pair makes this
   * read a usable resolution surface for a `file*[]` slot. Omitted for a bare
   * `navigational` body link, which fills no field. Mirrors `references_in.slot`.
   */
  field?: string
  /**
   * The `^:` id of the enclosing inline record the edge originates from; omitted
   * otherwise. A DECLARATION, so a bare string with no mode — mirroring the field
   * of the same name on `references_in` (**schema 17**).
   */
  source_block_id?: string
}

/** Result of the `references_out` read: EVERY outgoing edge, frontmatter then body, each classified. */
export type WireReferencesOutResult = WireReferenceOut[]

/**
 * The surface an inbound edge lives on: `frontmatter`, `body`, or `docstring` — a
 * `[[...]]` in a `#:` docstring on a type-def or instance declaration (additive,
 * no `schema_version` bump). A `docstring` edge's `kind` is `navigational`; the
 * surface distinguishes a documentation reference from a prose one. Any file can
 * newly gain inbound edges with `surface: "docstring"`.
 */
export type WireReferenceInSurface = 'frontmatter' | 'body' | 'docstring'

/**
 * The classification of an inbound edge (**schema 20**). DERIVED from `surface`
 * and `slot`, so it never disagrees with them:
 * - `navigational` — a body prose link (no `:field` attribution) OR any
 *   `docstring`-surface link, told apart by `surface`. A hint; the explosive
 *   class a graph walk excludes past one hop.
 * - `contributing` — a body `[[target:field]]`, both a link and a data
 *   contribution.
 * - `field` — a frontmatter-surface edge.
 *
 * The inbound partner of `references_out`'s five kinds, but COARSER on the
 * frontmatter side: `references_out` splits a frontmatter edge into
 * `field-reference` / `field-string-wikilink` / `unknown`, which needs the
 * referrer's resolved shape. Inbound that split is deferred, so a frontmatter
 * edge is `field`, named by its surface alone — a consumer wanting the finer
 * forward split drills to `references_out`. A later refinement subdivides `field`
 * without moving the body kinds. `inbound-STRUCTURAL` is derivable as
 * `slot != null`; `kind` is the named form. Closed set; tolerate unknown values
 * per additive evolution.
 */
export type WireReferenceInKind = 'navigational' | 'contributing' | 'field'

/**
 * One inbound reference edge (the `references_in` read, **schema 17**, renamed
 * from `backlinks` — it now reads as one pair with `references_out` and sorts
 * adjacently). A `[[name::repo]]` source link forms a cross-repo inbound edge
 * into the named repo when it resolves there; an unqualified link is repo-local.
 * Edges are indexed under the target they resolve to; only resolving references
 * index (dangling / ambiguous ones ride diagnostics).
 */
export interface WireReferenceIn {
  source: string
  /**
   * The repo the referencing `source` lives in, present only when this inbound
   * edge crosses a repo boundary (the source sits in a different member than the
   * target); omitted for a repo-local edge. The provenance half of a cross-repo
   * inbound edge — which member reaches in — mirroring the omitted-when-absent `repo`
   * on `references_out` / the semantic tokens.
   */
  repo?: string
  /**
   * The slot the edge fills: a frontmatter field key (innermost for nested
   * values) or a body link's `:field` attribution; null for untyped prose links.
   */
  slot: string | null
  surface: WireReferenceInSurface
  /**
   * The edge's classification (**schema 20**), derived from `surface` + `slot`;
   * see `WireReferenceInKind`. Coarser than `references_out`'s five: a
   * frontmatter edge is `field`, the finer split lives on `references_out`.
   */
  kind: WireReferenceInKind
  /** The span sits in the referencing `source` file, not the target. */
  span_start: number
  span_end: number
  line_col?: WireLineColRange
  /**
   * The TARGET fragment (`[[file^id]]` / `[[file^^id]]`), not the source's, as
   * `{ id, referent }`; null when the edge carries no `^`. (The wire serializes
   * null here, never omits — despite WIRE.md's "omitted" wording.)
   */
  block_id: WireBlockId | null
  /**
   * The `^:` id of the inline record the reference lives in; omitted otherwise.
   * A DECLARATION, so a bare string with no mode.
   */
  source_block_id?: string
}

/** Result of the `references_in` read. */
export type WireReferencesInResult = WireReferenceIn[]

// ---------------------------------------------------------------------------
// pins

/**
 * The surface a pin sits on: a `frontmatter` field value, a `body` wikilink, or a
 * `docstring` link — a `[[…::@sha]]` in a `#:` docstring (additive, no
 * `schema_version` bump).
 */
export type WirePinSurface = 'frontmatter' | 'body' | 'docstring'

/**
 * One commit-pinned reference naming the queried `target`, from the `pins` read
 * — the reverse-by-target lookup for commit-pinned references. An inert pin
 * forms NO inbound backlink (see `references_in`), so "which sources pin this
 * name" is not a backlink question; it is a fold over the retained OUTBOUND
 * pins. A NEW read, additive: a new verb plus this response type, so it rides
 * `schema_version` 25 with no bump.
 *
 * The record is a RECORDED coordinate, never a live edge:
 * - `target` is the pinned name EXACTLY as recorded, not live-resolved. A
 *   since-reused name still lists every pin that ever named it; the read carries
 *   NO time awareness and no `resolved`, the consumer windows by rename time.
 * - `commit` is always present — a pin is a commit-bearing reference.
 *
 * The candidate FILE set is scoped by the read's `source_type` arg to
 * `instances_of(source_type)` (a file-level claim or a nested inline record,
 * both keyed to the containing file), so the fold stays off the whole graph;
 * there is no unscoped whole-graph form. See {@link readPins}.
 */
export interface WirePinRecord {
  /** The file holding the pin. */
  source: string
  /**
   * The `^:` id of the enclosing inline record when the pin sits in one (a
   * nested-record site); omitted for a top-level frontmatter or body pin.
   * Mirrors `WireReferenceIn.source_block_id` — a DECLARATION, a bare string
   * with no mode.
   */
  source_block_id?: string
  /**
   * The pin's byte span in `source`, plus derived `line_col`. The shared flat
   * `WireSpan` (`{ start, end, line_col? }`), as every span on the wire — NOT
   * the nested `{ range, line_col }` an earlier WIRE.md draft described.
   */
  span: WireSpan
  /**
   * The field the pin fills: a frontmatter field key (innermost for a nested
   * value) or a body `:field` attribution; omitted for an untyped prose pin.
   */
  slot?: string
  surface: WirePinSurface
  /** The pinned name EXACTLY as recorded, not live-resolved. */
  target: string
  /**
   * The `::repo` scope when the pin crosses a repo boundary; omitted for an
   * own-repo pin. Mirrors the omitted-when-absent `repo` on `references_in` /
   * `references_out`.
   */
  repo?: string
  /** The pinned commit-ish, ALWAYS present — a pin is a commit-bearing reference. */
  commit: string
  /**
   * The `^id` / `^^id` fragment on the pin, `{ id, referent }`; omitted when the
   * pin names no interior block. (Unlike `references_in.block_id`, which the wire
   * serializes as null; the pin record omits it.)
   */
  block_id?: WireBlockId
}

/** Result of the `pins` read: every commit-pinned reference naming the target within the scoped source set. */
export type WirePinsResult = WirePinRecord[]

// ---------------------------------------------------------------------------
// commit_meta

/**
 * One trailer line on a commit, `{ key, value }`, UNINTERPRETED. Carries the
 * engine's own trailers (`Mutation-Id`, `Moved`) and a caller `attribution`
 * line alike — the wire does not distinguish them. Shared by
 * {@link WireCommitMeta.trailers} (read back) and the mutation `attribution`
 * rider (written in); see {@link AttributionEntry}.
 *
 * ADVISORY, trace-tier: a trailer is unsigned free text, forgeable, and its
 * `sha`-mapping rides the append-only invariant. A consumer treats it as a
 * claim, not proof.
 */
export interface WireTrailer {
  key: string
  value: string
}

/**
 * One input to the `commit_meta` read: a commit-ish plus the OPTIONAL member
 * whose store resolves it. `repo` is per-commit (a folded pin set spans
 * members); absent defaults to the entry repo. See {@link readCommitMeta}.
 */
export interface WireCommitMetaInput {
  /** A commit-ish: a full oid or an abbreviated prefix. */
  commit: string
  /** The member whose git store resolves `commit`; absent = the entry repo. */
  repo?: string
}

/**
 * One record from the `commit_meta` read — per-commit metadata, member-aware,
 * off the build path. A NEW read, additive (a new verb and response type), so
 * NO `schema_version` bump; rides schema 26. The git-enrichment join partner
 * for `pins`: collect the distinct `{ commit, repo? }` set and call once.
 *
 * POSITIONAL: `commit_meta`'s result is one record per input, in input order,
 * so a consumer maps a record back to its query by POSITION (an abbreviated
 * input resolves to the full `commit` oid here).
 *
 * When `available` is false the metadata fields are OMITTED — the shape of a
 * `pinned-commit-unavailable` (an unknown repo, a `.git`-free member, a missing
 * sha, or a git failure). Metadata-only: the commit's BYTES are the
 * pin-resolution read's job, not this one. See {@link readCommitMeta}.
 */
export interface WireCommitMeta {
  /** The resolved full oid when present, else the requested input verbatim. */
  commit: string
  /** Whether the member's store holds the commit. False omits every field below. */
  available: boolean
  /** The committer date, unix seconds, when the commit entered history. Omitted when unavailable. */
  timestamp?: number
  /** `Name <email>` (an engine-written commit is `au-engine <au-engine@arsumbris.ai>`). Omitted when unavailable. */
  author?: string
  /** The RAW commit message (full body, unlike `file_history`'s subject line). Omitted when unavailable. */
  message?: string
  /**
   * Every trailer line, `[{ key, value }]`, uninterpreted. Always an array,
   * empty never absent. Omitted only when `available` is false. See
   * {@link WireTrailer} for the advisory, trace-tier caveat.
   */
  trailers?: WireTrailer[]
}

/** Result of the `commit_meta` read: one record per input commit, positional, input order. */
export type WireCommitMetaResult = WireCommitMeta[]

// ---------------------------------------------------------------------------
// file_history

/**
 * A commit's effect on the queried path, from `file_history`. `renamed` is
 * git's own SIMILARITY HEURISTIC, best-effort, NOT authoritative — adjudicating
 * a rename is a consumer's lineage tool, not this read.
 */
export type WireFileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed'

/**
 * One commit that touched the path, from the `file_history` read — a file's
 * commit stream, member-aware, off the build path. A NEW read, additive (a new
 * verb and response type), so NO `schema_version` bump; rides schema 26. Serves
 * an audit enumerating a file's commits, and a commit-stream UI.
 *
 * NEWEST FIRST (git's log order, a PARTIAL order over a DAG — a consumer must
 * not read it as a total order across unrelated branches). See
 * {@link readFileHistory}.
 */
export interface WireFileHistoryEntry {
  /** The full oid. */
  commit: string
  /** The committer date, unix seconds. */
  timestamp: number
  /** `Name <email>`. */
  author: string
  /** The commit SUBJECT line only (the first line); the full body is a `commit_meta` join away. */
  message: string
  /** The commit's effect on the path. `renamed` is git's raw heuristic, not authoritative. */
  status: WireFileChangeStatus
  /** The prior path on a `renamed` (git's heuristic match); omitted otherwise. */
  from?: string
}

/**
 * Result of the `file_history` read: the commits that touched the path, newest
 * first. An EMPTY array for a `.git`-free member (a package snapshot) or a path
 * with no history — named, not an error.
 */
export type WireFileHistoryResult = WireFileHistoryEntry[]

// ---------------------------------------------------------------------------
// recent_commits

/**
 * A commit author on a `recent_commits` row, SPLIT into `{ name, email }` so a
 * consumer tells a human commit from an engine one (`au-engine` /
 * `au-engine@arsumbris.ai`). This is the DELIBERATE divergence from
 * `commit_meta`'s `author`, a single `Name <email>` STRING: each read stays
 * faithful to its own wire shape, no reconciliation. See {@link WireRecentCommit}.
 */
export interface WireRecentCommitAuthor {
  name: string
  email: string
}

/**
 * One changed file on a `recent_commits` row, `{ path, status, from? }`. `status`
 * is git's `-M` similarity heuristic surfaced raw (best-effort, NOT
 * authoritative — adjudicating a rename is a consumer's lineage tool). Distinct
 * from `file_history`'s {@link WireFileHistoryEntry}, which carries no `path` (the
 * path is that read's query); this row spans many paths, so each entry names its
 * own. Reuses {@link WireFileChangeStatus}.
 */
export interface WireChangedFile {
  /** The changed path, relative to the owning working tree. */
  path: string
  /** The commit's effect on the path. `renamed` is git's raw heuristic, not authoritative. */
  status: WireFileChangeStatus
  /** The prior path on a `renamed` (git's heuristic match); omitted otherwise. */
  from?: string
}

/**
 * One merged commit from the `recent_commits` read — the cross-repo git ACTIVITY
 * stream, member-aware, off the build path. A NEW read, additive (a new verb and
 * response type), so NO `schema_version` bump; rides schema 29. `file_history`
 * generalized to no-path / all-trees / bounded, with `trailers` on every row and
 * a per-tree tag.
 *
 * NEWEST FIRST by committer `timestamp`, tie-broken by commit oid for a total,
 * deterministic order, cut to the effective bound. Keyed by the working-tree
 * `tree` root (the lane key). See {@link readRecentCommits}.
 */
export interface WireRecentCommit {
  /** The full commit oid. */
  commit: string
  /** The owning working-tree ROOT (the lane key, paralleling the `members` read's `git.root`). */
  tree: string
  /** The au-repo member names living in that tree. */
  members: string[]
  /** The author, SPLIT `{ name, email }` (unlike `commit_meta`'s single string). See {@link WireRecentCommitAuthor}. */
  author: WireRecentCommitAuthor
  /** The committer date, unix seconds. */
  timestamp: number
  /** The commit SUBJECT line only (the summary); the full body is a `commit_meta` join away. */
  subject: string
  /**
   * The changed paths, `[{ path, status, from? }]`. EMPTY for a merge commit,
   * whose diff git omits by default. See {@link WireChangedFile}.
   */
  changed_files: WireChangedFile[]
  /**
   * Every trailer line, `[{ key, value }]`, uninterpreted — the same advisory,
   * trace-tier data `commit_meta` returns. `Mutation-Id` / `Mutation-Members`
   * let a consumer collapse one mutation's cross-tree commits into one feed
   * entry client-side. See {@link WireTrailer} for the forgeable caveat.
   */
  trailers: WireTrailer[]
}

/**
 * Args for the `recent_commits` read (and subscription), all optional. With
 * NEITHER `limit` nor `since`, a default cap (100) applies, so the read always
 * bounds. Given both, they intersect: commits since the window, newest first, at
 * most `limit`. See {@link readRecentCommits}.
 */
export interface WireRecentCommitsArgs {
  /**
   * A list of member NAMES; each maps to its owning working tree and is deduped
   * (a monorepo's members share one tree). Absent = all trees.
   */
  members?: string[]
  /** A count ceiling on the merged result. */
  limit?: number
  /** A git time window, e.g. an ISO date or `2.weeks`. */
  since?: string
}

/**
 * Result of the `recent_commits` read: the merged commits across the workspace's
 * working trees, newest first, cut to the effective bound. A `.git`-free member
 * (a package snapshot) contributes nothing, named. Unwrapped from the
 * `{ recent_commits }` envelope per the `result[verb]` rule.
 */
export type WireRecentCommitsResult = WireRecentCommit[]

// ---------------------------------------------------------------------------
// neighborhood

/**
 * The direction a `neighborhood` walk follows edges (**schema 20**):
 * - `out` (default) — edges the node authors.
 * - `in` — edges pointing at it.
 * - `both` — either per hop, a true undirected walk (depth 2 reaches a co-cited
 *   sibling).
 */
export type WireNeighborhoodDirection = 'out' | 'in' | 'both'

/**
 * The COARSE walk vocabulary of the `neighborhood` read (**schema 20**). The
 * three `references_in.kind` carries (`WireReferenceInKind`) are symmetric in
 * both directions, derived from `surface` and the slot, and deliberately coarser
 * than `references_out`'s set; a consumer drills to `references_out` for the
 * finer forward split. Plus `commit-referent` (**schema 22**), an OUTBOUND-only
 * kind for a commit-only reference (`[[::@sha]]` / `[[::repo@sha]]`): it reaches
 * no node (`to` is null) but is NOT dangling. An inbound edge is never a
 * `commit-referent` — a commit-referent forms no backlink.
 */
export type WireNeighborhoodKind = WireReferenceInKind | 'commit-referent'

/**
 * Arguments to the `neighborhood` read (**schema 20**): a bounded N-hop
 * reference-graph walk from one seed, returning the reachable subgraph. A
 * semantically-invalid arg (an unknown `direction` / `kind`, an absent `kinds`
 * past depth 1, `max_nodes: 0`, an unknown arg key) comes back as an `error`
 * frame, the same frame shape a malformed read uses.
 */
export interface WireNeighborhoodArgs {
  /** The seed file, always a file node. Required. */
  path: string
  /** `out` (default) / `in` / `both`; an unknown value is a malformed-read error. */
  direction?: WireNeighborhoodDirection
  /**
   * The maximum hop count, default 1 (the seed plus its direct targets). A node
   * at `depth` is a leaf, discovered but not expanded.
   */
  depth?: number
  /**
   * An include-set of edge kinds, any of `navigational` / `contributing` /
   * `field` / `commit-referent` (**schema 22** adds the outbound-only
   * `commit-referent`). Absent means all kinds at depth 1, but is REQUIRED past
   * depth 1 — an unfiltered deep walk explodes through navigational fan-out. An
   * absent `kinds` at `depth > 1`, or an unknown kind value, is an `error` frame.
   */
  kinds?: WireNeighborhoodKind[]
  /**
   * `all` (default; a `path` is a location pin) or `own` (prune at the repo
   * boundary — a crossing edge into a dependency is reported but its target not
   * expanded).
   */
  scope?: WireTypeScope
  /** The node cap; absent is the engine's bound. The seed counts, so `1` returns the seed alone. */
  max_nodes?: number
  /** Splice the `content` read's payload onto each file node. Default false. */
  content?: boolean
  /** Splice the prose body onto each node. Default false. */
  body?: boolean
  /** Splice the resolved instance view onto each file node. Default false. */
  instance?: boolean
}

/**
 * A node reference in a `neighborhood` edge (**schema 20**): the file `path`,
 * plus `block_id` only when the endpoint is a `^^`-addressed block node.
 */
export interface WireNeighborhoodNodeRef {
  path: string
  /** Present only on a block-node endpoint. */
  block_id?: string
}

/**
 * One node in the reachable subgraph (**schema 20**). Nodes are sorted by
 * `(depth, path, block_id)` so two builds return one answer. A file node and a
 * block node inside it are DISTINCT nodes.
 */
export interface WireNeighborhoodNode {
  /** The file, or for a block node the file CONTAINING it. */
  path: string
  /**
   * Present only on a block node, the `^^`-addressed block. A block node exists
   * ONLY as the resolved target of a `^^` block-referent; a bare `^id` reaches
   * the FILE node with its anchor on the edge.
   */
  block_id?: string
  /** The MINIMUM hop count from the seed. */
  depth: number
  /** The owning member; omitted when the path belongs to none. */
  repo?: string
  /** The parse kind, the shared vocabulary `hubs` and `files` serve. */
  file_kind: WireParseKind
  /**
   * The byte length a consumer costs a whole-file FETCH by before paying for it
   * (the `content` read's `text` length). For a BLOCK node the block's SPAN
   * length. `null` for an unread asset, or a block whose `^^` id did not resolve.
   */
  bytes: number | null
  /**
   * The prose-body byte length (the `body` length). For a BLOCK node the block's
   * SPAN length (a block has no frontmatter to strip). `null` as for `bytes`.
   */
  body_bytes: number | null
  /**
   * Present only when `content` was requested, else absent. For a FILE node the
   * `{ text, hash, commit }` working-tree payload; for a BLOCK node the block's
   * span SLICE with `null` `hash` / `commit` (a block is not a git file). Present
   * even when null.
   */
  content?: WireContentRead | null
  /**
   * Present only when `body` was requested, else absent. The prose after
   * frontmatter for a FILE node; the block's span SLICE for a BLOCK node.
   * Present even when null.
   */
  body?: string | null
  /**
   * Present only when `instance` was requested, else absent. The resolved view
   * for a FILE node (`null` for a plain note); always `null` for a BLOCK node (a
   * block has no standalone resolved view). Present even when null.
   */
  instance?: WireInstance | null
}

/**
 * One traversed edge, stored NATURAL-direction (`from` the referrer, `to` the
 * target), sorted by `(from, span)` (**schema 20**). Under `both` one physical
 * edge is reported once.
 */
export interface WireNeighborhoodEdge {
  /** The referrer node. */
  from: WireNeighborhoodNodeRef
  /**
   * The target node; `null` for a dangling edge (an outbound link resolving to
   * nothing), or a scope-/budget-excluded target absent from `nodes`. A
   * `commit-referent` edge's null `to` is NOT dangling (**schema 22**): it names
   * a commit, not a node, and is anchored against `gc`.
   */
  to: WireNeighborhoodNodeRef | null
  /** The coarse walk kind; see `WireNeighborhoodKind`. */
  kind: WireNeighborhoodKind
  surface: WireReferenceInSurface
  /** The reference's byte range in `from` (the referrer). */
  span_start: number
  span_end: number
  line_col?: WireLineColRange
  /** The slot / `:field` attribution; omitted when absent. */
  field?: string
  /** The enclosing inline record's `^:` id; omitted when absent. */
  source_block_id?: string
  /** The link's `{ id, referent }` fragment; omitted when absent. */
  block_id?: WireBlockId
  /**
   * The `::repo` / `@commit` / `#anchor` fragments, present only on an
   * OUTBOUND-discovered edge (an inbound edge's backlink index dropped the link).
   * Omitted otherwise.
   */
  repo?: string
  commit?: string
  anchor?: string
}

/**
 * A node cut by `max_nodes` truncation (**schema 20**): NAMED, not counted, so a
 * consumer surfaces or re-fetches exactly what was lost. A scope-pruned peer is a
 * POLICY exclusion, not budget, so it is NOT here — it is reported by its edge.
 */
export interface WireNeighborhoodDropped {
  path: string
  block_id?: string
  repo?: string
  depth: number
}

/**
 * The `neighborhood` read's subgraph (**schema 20**). Truncation is loud:
 * `truncated` is true when `max_nodes` cut an expansion that had more,
 * `truncated_at_depth` names where cutting began (omitted when not truncated),
 * and `dropped` names each cut node. Reaching `depth` is NOT truncation.
 */
export interface WireNeighborhoodResult {
  nodes: WireNeighborhoodNode[]
  edges: WireNeighborhoodEdge[]
  truncated: boolean
  /** Omitted when not truncated. */
  truncated_at_depth?: number
  dropped: WireNeighborhoodDropped[]
}

// ---------------------------------------------------------------------------
// resolve_target / resolve_block_id / resolve_anchor

/**
 * The engine's file classification. `repo-registry` is a `.arsumbris/`
 * registry marker, `workspace` a `.arsumbris/workspace.yaml` manifest (the
 * folder-repo's optional member composition, superseding the former free-floating
 * `<name>.au-workspace.yaml`, **schema 16**), `repo-lock` a `.arsumbris/` lock
 * file surfaced as a typed instance node — all first-class, none an instance
 * candidate. Closed set; consumers still tolerate unknown values per additive
 * evolution.
 */
export type WireFileKind =
  | 'type-def'
  | 'instance'
  | 'repo-registry'
  | 'workspace'
  | 'repo-lock'
  | 'unclassified'

export interface WireResolvedTarget {
  /** The resolved absolute file path. */
  path: string
  kind: WireFileKind
  /** The file's content hash — the mutation channel's `expected_hash` source; null for unread files. */
  hash: string | null
  /**
   * The openable container + container-relative span for a `type-def` target,
   * else null. The same `{ file, span }` the type reads carry: `file` is the
   * openable physical path (a def's own file), `span` is `{ start, end,
   * line_col }` into it. Null for any non-`type-def` target (a non-def `path`
   * is itself directly openable).
   */
  source: WireSourceLoc | null
}

/** Result of the `resolve_target` read: null when unresolved or ambiguous. */
export type WireResolveTargetResult = WireResolvedTarget | null

/**
 * Which addressable entity a block-id reached: `record` (inline `^:`),
 * `typed_block` (`[:field]` fence), or `marker` (navigational only,
 * never a typed-reference target).
 */
export type WireResolvedBlockKind = 'record' | 'typed_block' | 'marker'

export interface WireResolvedBlock {
  file_path: string
  /**
   * The record's effective claim; empty for a navigational `marker` and for a
   * claim-less record. A cross-repo claim reads `name::repo` verbatim.
   */
  type_claim: string[]
  span: WireSpan
  kind: WireResolvedBlockKind
}

/** Result of the `resolve_block_id` read: null when the target or id doesn't resolve. */
export type WireResolveBlockIdResult = WireResolvedBlock | null

export interface WireResolvedAnchor {
  file_path: string
  /** The heading line. */
  span: WireSpan
}

/** Result of the `resolve_anchor` read: null when the target or anchor doesn't resolve. */
export type WireResolveAnchorResult = WireResolvedAnchor | null

// ---------------------------------------------------------------------------
// anchors / block_ids / files — the addressable-enumeration reads
//
// Each is the LISTING dual of a resolve verb above: `anchors` of
// `resolve_anchor`, `block_ids` of `resolve_block_id`, `files` of
// `resolve_target`. A resolve verb answers whether ONE address resolves; a
// listing answers WHAT CAN BE ADDRESSED. One read per inhabitable wikilink
// fragment position — `[[` is `files`, `[[file#` is `anchors`, `[[file^` is
// `block_ids` — so a completion consumer enumerates instead of scanning text
// for a set that is always narrower than what resolves.
//
// `anchors` and `block_ids` take a wikilink `target`, NOT a `path`: a consumer
// completing a half-typed link holds a target, and the same `origin` scoping
// `resolve_target` documents applies.
//
// NEW reads are new request values, so these are additive — no schema bump.

/**
 * One heading in a file, as `anchors` serves it.
 *
 * `text` is exactly what a `#anchor` fragment matches: the heading text with
 * its trailing `^id` marker EXCLUDED. Serving the matched form means a
 * consumer inserts it verbatim and the link resolves. Matching stays
 * case-insensitive, so the served casing is one valid spelling, not the only
 * one.
 */
export interface WireAnchor {
  /** The heading text a `#anchor` matches, trailing `^id` marker excluded. */
  text: string
  /** The heading depth, 1..=6 — carried because the body scan already holds it, so an outline consumer needs no second read. */
  level: number
  /** The heading LINE — the same span `resolve_anchor` returns for that heading. */
  span: WireSpan
}

/**
 * Result of the `anchors` read: every heading in the target file, in document
 * order — or null.
 *
 * **The null-vs-empty split is a real distinction, deliberately NOT collapsed.**
 * An UNRESOLVED `target` answers null, the catalog's unresolved-lookup signal.
 * A target that RESOLVES but carries no markdown body (a pure-YAML instance, an
 * unread asset) answers an EMPTY array — it exists and simply has no headings.
 * The engine diverges from its resolve verbs here on purpose, so the SDK must
 * not re-collapse it: a consumer reading "no such file" as "no headings" offers
 * an empty menu for a typo instead of reporting the typo.
 *
 * An entry carries no `file_path` — it is the argument, so repeating it per
 * entry says nothing. What remains is `resolve_anchor`'s payload plus the key
 * that selects it, so list-then-pick costs no second round trip.
 */
export type WireAnchorsResult = WireAnchor[] | null

/**
 * One addressable id in a file, as `block_ids` serves it.
 *
 * BOTH surfaces of a block id are listed in one stream: frontmatter inline
 * records carrying `^:`, and body occurrences (typed `[:field]` fence ids,
 * untyped fence ids, bare `^id` markers). Sorted by span, so frontmatter
 * precedes the body the way the file does. A regex over the body catches only
 * the last of those, which is the gap this read closes.
 *
 * NOT `WireBlockId`, which is the wikilink `^id` REFERENCE shape
 * (`{ id, referent }`) an edge carries. This is what a file OFFERS, that is what
 * a link SPELLS.
 */
export interface WireBlockIdEntry {
  /** The bare id, WITHOUT its `^` sigil — as `[[file^id]]` spells it. */
  id: string
  /**
   * `resolve_block_id`'s vocabulary verbatim (hence the shared type).
   *
   * **Typedness rides `kind`, never a separate flag.** A `^^` block-referent
   * demands a typed value: satisfied by `record` and `typed_block`, never by
   * `marker`. So a consumer completing `^^` filters on `kind`, and one
   * completing a bare `^` does not.
   */
  kind: WireResolvedBlockKind
  /** The effective claim, explicit or slot-pinned, `::repo`-qualified where the claim is. Empty for a `marker` and for a claim-less record. */
  type_claim: string[]
  span: WireSpan
}

/**
 * Result of the `block_ids` read: every addressable id in the target file, in
 * document order — or null.
 *
 * **Every OCCURRENCE is listed, duplicates included**, so the array can carry
 * one id twice and is NOT id-unique. `resolve_block_id` returns the first and
 * ignores the rest, which is right for resolution and wrong for a listing:
 * dropping the later ones would hide exactly what `block-id-duplicate` reports.
 * The two reads deliberately disagree on cardinality — the listing is the
 * file's surface, the resolver is the verdict.
 *
 * The null-vs-empty split is `anchors`': an unresolved `target` is null, a
 * resolved file carrying no ids is an empty array. Entries carry no
 * `file_path`, for the same reason.
 */
export type WireBlockIdsResult = WireBlockIdEntry[] | null

/** Optional args for the `files` read; every field absent is the whole catalogue. */
export interface WireFilesArgs {
  /** Only this member's files. Absent spans every mounted member. */
  repo?: string
  /**
   * `all` (**DEFAULT**) or `own`.
   *
   * NOTE the inversion against the actionability reads (`hubs`,
   * `top_level_dirs`, `overview`), which default to `own`. A wikilink into a
   * dependency is legal — only a TYPE crossing gates on a declared dep — so the
   * resolvable target set is what exists to link against, the VOCABULARY side of
   * the scope split. Defaulting to `own` would hide targets the validator
   * accepts. A `repo` filter and `scope` compose (AND), as everywhere.
   */
  scope?: WireTypeScope
  /** At most this many entries, after `offset`, over the path-sorted set. Absent returns the whole catalogue. */
  limit?: number
  /** Skip this many entries before the page. Absent is 0. */
  offset?: number
}

/** One catalogued file, as `files` serves it. */
export interface WireFileEntry {
  path: string
  /**
   * The basename minus ONE extension — what a bare `[[name]]` resolves by:
   * `x.session.yaml` stems to `x.session`, `paper.pdf` to `paper`. Served so no
   * consumer re-derives the strip-one-extension rule, nor the extensionless-match
   * rule with it. A `*.type.yaml` keeps its `.type` tail (`task.type`), which is
   * why a wikilink by TYPE-NAME resolves through its own alias rather than the
   * stem.
   *
   * **NOT unique.** Two files sharing one are an ambiguous bare target, which
   * resolution reports as `reference-target-ambiguous`; the listing states what
   * exists and does not adjudicate.
   */
  stem: string
  /** The owning member; null when the path belongs to none. */
  repo: string | null
  kind: WireParseKind
}

/**
 * Result of the `files` read: every catalogued file, path-sorted.
 *
 * **Path-sorted means COMPONENT-WISE, not byte-lexical.** The order is the
 * engine's catalogue order (a Rust `PathBuf` key), which compares path segments
 * one at a time — so a directory sorts before a sibling file whose name extends
 * it: `content/broken/x.md` precedes `content/broken example.md`, where a
 * JavaScript string compare puts them the other way (`' '` < `'/'`). A consumer
 * re-sorting or merge-joining this array with `String` comparison will disagree
 * at exactly those boundaries. Paging (`limit` / `offset`) is a slice of this
 * order, applied AFTER `repo` / `scope` filtering.
 *
 * **The catalogue IS the resolvable set** — the reference index is built from
 * it, so what is catalogued is what a wikilink can reach. This is the target set
 * for a `[[` completion, and the listing dual of `resolve_target`.
 *
 * **An ASSET appears**, unread and hashless. The walker records it by path and
 * never reads it, precisely so `file*` resolves against it, so a consumer
 * completing `[[` can offer a target the validator accepts. The implicit-identity
 * `candidates` scan reaches only PARSED files, so reading THAT for the file set
 * silently omits every asset — the gap this read closes.
 *
 * An engine-schema file (`.arsumbris/repo.yaml`, `workspace.yaml`, the locks) is
 * catalogued and resolvable, so it is listed like any other file.
 *
 * The READ dual of the `files` SUBSCRIPTION channel, which streams the same path
 * set and its deltas: read once, subscribe for change, rather than choosing
 * between them. A projection of the held catalogue, so no walk and no disk read.
 */
export type WireFilesResult = WireFileEntry[]

// ---------------------------------------------------------------------------
// dir_entries / frontmatter / content / top_level_dirs

export interface WireDirEntry {
  path: string
  name: string
  kind: 'file' | 'directory'
}

/** Result of the `dir_entries` read: direct entries, hidden excluded. */
export type WireDirEntriesResult = WireDirEntry[]

/**
 * Result of the `frontmatter` read: the parsed frontmatter as a JSON map, or
 * null when the file is neither a typed instance nor a note. A typed instance
 * carries its claim under `type`; a note carries no `type` key. Type names ride
 * verbatim — the `type` claim and any nested inline-record `type:` read
 * `name::repo` for a cross-repo target; a consumer parsing them must accept the
 * qualified form.
 */
export type WireFrontmatterResult = Record<string, unknown> | null

/**
 * The `content` read's payload: the file's source text plus its content hash,
 * both from one disk read so the pair is coherent (the hash is the hash of the
 * `text` returned).
 *
 * The source string is `text`, NOT `content` (**schema 17**): the payload key is
 * the read's own name, so a `content` field inside it would make
 * `result.content.content` the way to the string — the envelope rule fixes the
 * collision on the inside.
 */
export interface WireContentRead {
  /** The file's source text, read from the working tree. */
  text: string
  /**
   * The content hash of the bytes read — the guard-usable `expected_hash` for
   * `write_file` / `delete_file`. Present whenever the file is readable, with
   * no dependence on catalog warmth; it is the value the mutate guard re-hashes
   * on disk, not the catalog hash.
   */
  hash: string
  /**
   * The pin anchor for the returned bytes: HEAD of the repo owning the file,
   * `null` only when the file is not under a git working tree. The returned
   * `text` is the working tree's (possibly dirty against HEAD), so `commit`
   * anchors a pin (`[[path::@<commit>]]`) but the bytes may differ from that
   * commit's tree. The same HEAD anchor `mutate`'s `result.commit` carries (a
   * read never commits, so `commit` is purely HEAD).
   */
  commit: string | null
}

/** Result of the `content` read: text + hash + commit, or null when unreadable. */
export type WireContentResult = WireContentRead | null

/**
 * One top-level directory: a top-level directory of a mounted member holding at
 * least one catalogued file, hidden excluded (**schema 17**, renamed from the
 * entry-scoped `top_level_graphs`; `folder_path` is now `path`, and `repo` /
 * `member` are new).
 *
 * A member may sit physically inside another repo; its folder then genuinely is
 * a directory of the container, so it is reported for BOTH — once under the
 * container's `repo`, again under the member's own tag — and `member` is what
 * makes the overlap legible.
 */
export interface WireTopLevelDir {
  /** The member that owns the directory. */
  repo: string
  name: string
  /** The directory path (was `folder_path` pre-schema-17). */
  path: string
  /** The declared name of the mounted member ROOTED at this directory, else null. Non-null only for a DECLARED member. */
  member: string | null
}

/**
 * Optional args for the `top_level_dirs` read. All optional; an unknown arg is an
 * `error` frame. See the scope-default rules on `readTopLevelDirs`.
 */
export interface WireTopLevelDirsArgs {
  /** Scope to one member (absent spans every mounted member). A LOCATION PIN: flips the `scope` default to `all`. */
  repo?: string
  /** ACTIONABILITY scope: `own` (default) / `all`. A location pin flips the default to `all`; an explicit `scope` wins. */
  scope?: WireTypeScope
}

/** Result of the `top_level_dirs` read. */
export type WireTopLevelDirsResult = WireTopLevelDir[]

// ---------------------------------------------------------------------------
// members / resolve_member

/**
 * The two orthogonal axes a member carries, plus the raw role
 * (**schema 16**, replacing the former location-derived `editable` + `primary`
 * pair):
 *
 * - `editable` — the ROLE axis: is the member an editable authoring surface?
 *   `true` for the entry or an `edit` member, `false` for a consumed member (a
 *   `dep` / `discover`), independent of on-disk location. A co-present dep is
 *   `editable: false`; an `edit` member present only in the cache stays
 *   `editable: true`. A caged agent's writes scope to the editable members.
 * - `local` — the LOCATION axis: is the member a live local working tree?
 *   `true` for a co-present sibling or a registry path, `false` for a read-only
 *   cache snapshot (under the device package cache). Independent of `editable`:
 *   a co-present dep is `editable: false, local: true` (consumed but writable in
 *   place, also carrying `dependency-path-overridden`); a cache-only edit member
 *   is `editable: true, local: false` (`edit-member-read-only`).
 * - `role` — the full four-way signal `editable` derives from
 *   (`entry` / `edit` / `discover` / `dep`), distinguishing a `discover` mount
 *   from a plain `dep`.
 *
 * Neutral facts — the consumer applies policy (hide consumed members with
 * `!editable`, scope physical writes with `editable && local`).
 */
export interface WireMemberRole {
  /** True for an editable authoring surface (entry or `edit` member); false for a consumed `dep` / `discover`. */
  editable: boolean
  /** True for a live local working tree; false for a read-only cache snapshot. */
  local: boolean
  /** The raw role: the full signal `editable` derives from. */
  role: WireMemberRoleName
}

/**
 * A member's raw role. Closed set; consumers still tolerate unknown values per
 * additive evolution.
 * - `entry` — the folder-repo the daemon entered on (self-homing root).
 * - `edit` — an editable authoring member declared in `workspace.yaml`.
 * - `discover` — a pinned member mounted for discovery, not a type-dependency.
 * - `dep` — a declared type-dependency, mounted from a sibling, registry, or cache.
 */
export type WireMemberRoleName = 'entry' | 'edit' | 'discover' | 'dep'

/**
 * One workspace member: its declared name, its absolute root on this machine,
 * whether the root sits outside the workspace tree, and its role
 * (`editable` / `local` / `role`).
 */
export interface WireMember extends WireMemberRole {
  /** The declared member name (its `::repo` label). */
  repo: string
  /** The member's absolute root directory on this machine. */
  root: string
  /**
   * True when the root sits outside the workspace root, reached by absolute
   * path; false for a subdir of it.
   */
  scattered: boolean
  /**
   * True for a member declared in `edit:` / `discover:` but intentionally NOT
   * mounted (its name also sits in the manifest's `disabled:` overlay). A
   * MOUNTED member is `false`. A DISABLED member is `true`, keeping its declared
   * `edit` / `discover` `role` while carrying an empty `root` and `local: false`
   * — it is not resolved, its device location lives in the registry. Additive,
   * no `schema_version` bump; a consumer that ignores it sees every member as
   * mounted, as before.
   */
  disabled: boolean
}

/**
 * Result of the `members` read: the workspace's declared members, name-sorted.
 * Surfaces the member topology the engine holds internally, so a consumer
 * addresses a scattered member's files without reconstructing the set.
 *
 * The `members` read's result envelopes the array under the verb key
 * (`{ members: [...] }`), so the generic accessor unwraps it to this array
 * directly — the same array `overview.members` embeds.
 */
export type WireMembersResult = WireMember[]

/**
 * The owning workspace member of a path: its declared name, absolute root, and
 * role (`editable` / `local` / `role`, same meaning as on `WireMember`), so a
 * cage scopes a write by the member it lands in (`editable && local`).
 */
export interface WireMemberOf extends WireMemberRole {
  /** The declared member name (its `::repo` label). */
  repo: string
  /** The member's absolute root directory on this machine. */
  root: string
}

/**
 * Result of the `resolve_member` read: the declared member that owns the path,
 * by the same deepest-ancestor rule reads and writes use; null when the path
 * lies under no declared member.
 */
export type WireResolveMemberResult = WireMemberOf | null

// ---------------------------------------------------------------------------
// overview

/**
 * One hub: a most-referenced file over the typed reference graph, the "start
 * here" signal a generic search cannot give. The `refs_structural` /
 * `refs_navigational` split is the neutral fact a consumer re-ranks by — there
 * is no opaque score.
 */
export interface WireHub {
  /** The file path. */
  path: string
  /** The owning repo, or null. */
  repo: string | null
  kind: WireParseKind
  /** Inbound edges filling a typed slot. */
  refs_structural: number
  /** Inbound prose (navigational) links. */
  refs_navigational: number
  /** `refs_structural + refs_navigational`. */
  refs_total: number
}

/**
 * Optional args for the `overview` read (**schema 17**). See the scope-default
 * rules on `readOverview`.
 */
export interface WireOverviewArgs {
  /** Scope to one member. A LOCATION PIN: flips the `scope` default to `all`. */
  repo?: string
  /** ACTIONABILITY scope: `own` (default) / `all`. A location pin flips the default to `all`; an explicit `scope` wins. */
  scope?: WireTypeScope
}

/**
 * Result of the `overview` read: the up-front orientation map, the one cheap read
 * a consumer loads first before drilling through the other reads. Each field is
 * ONE CALL TO ITS OWN READ with the resolved `repo` / `scope` (the MIRROR
 * PROPERTY):
 * - `repo` / `scope` — the RESOLVED args echoed back (**schema 17**), so a
 *   consumer drilling from a field into its own read passes them verbatim instead
 *   of re-deriving a default it cannot see.
 * - `members` — the `members` read's array DIRECTLY (`WireMember[]`, NOT the
 *   `{ members: [...] }` wrapper), so a consumer reads `overview.members`. Honors
 *   `repo` but NOT `scope` — it is the TOPOLOGY field, and `members.editable` is
 *   how a consumer sees which repos `own` selected.
 * - `top_level_dirs` — the `top_level_dirs` read's array.
 * - `type_counts` — the `type_counts` read's object (`{ total, by_repo }`),
 *   always present here (never the null unknown-`repo` arm). The ONE field that
 *   keeps `all` (a vocabulary read), so it deliberately disagrees with an
 *   own-scoped `overview` — which is exactly why `repo` / `scope` are echoed.
 * - `diagnostic_counts` — the `diagnostic_counts` read's object
 *   (`{ total, by_severity, by_code }`).
 * - `hubs` — the `hubs` read's array, bounded to the engine's top-N.
 *
 * **Schema 17**: BREAKING beyond a shape change — `type_counts`,
 * `diagnostic_counts`, `hubs`, and `top_level_dirs` return DIFFERENT VALUES for
 * an argless call, since it is now `own`-scoped; pass `scope: "all"` for the old
 * numbers. `hubs` was promoted out into its own read, and `top_level_graphs`
 * became the rescoped `top_level_dirs`. Read-only, refreshed through the
 * `changes` subscription.
 */
export interface WireOverviewResult {
  /** The resolved `repo`, echoed back; absent when none was passed. */
  repo?: string
  /** The resolved `scope`, echoed back (`own` default). */
  scope: WireTypeScope
  members: WireMember[]
  top_level_dirs: WireTopLevelDir[]
  type_counts: WireTypeCounts
  diagnostic_counts: WireDiagnosticCountsResult
  hubs: WireHub[]
}

// ---------------------------------------------------------------------------
// device_config

/**
 * One device-global engine-schema file on the wire (`repos.yaml` or
 * `workspaces.yaml`): its resolved path, whether it is present, its raw content,
 * and the field-shape diagnostics. These files sit OUTSIDE every knowledge base, so their
 * diagnostics land here (on `device_config`), not on the workspace `diagnostics`
 * read.
 */
export interface WireDeviceConfigFile {
  /**
   * The absolute path this file resolves to under the per-user config dir,
   * present even when the file itself is absent — so a consumer knows where to
   * author.
   */
  path: string
  /**
   * True when the file exists and was read; false is a legitimate
   * not-yet-authored state (null `content`, empty `diagnostics` — the config is
   * optional).
   */
  exists: boolean
  /**
   * The raw file text when present and UTF-8; null when the file is absent or
   * not valid UTF-8 (the not-UTF-8 case still carries a diagnostic).
   */
  content: string | null
  /**
   * The field-shape verdict against the file's hardwired def (`au.engine.repos`
   * / `au.engine.workspaces`), the same shape and codes as the `diagnostics`
   * read, with spans into THIS real file. Empty for an absent or clean file
   * (always an array, never omitted). Field-shape only: no references, no
   * closure to walk.
   */
  diagnostics: WireDiagnostic[]
}

/**
 * Result of the `device_config` read (no args): the two per-user device-global
 * engine-schema files under `~/.arsumbris/au-engine/config/`. An entry is null
 * when its path cannot be resolved (no `HOME`). The paired
 * writer for `repos` is the `register` mutation; `workspaces` is user-authored.
 */
export interface WireDeviceConfigResult {
  repos: WireDeviceConfigFile | null
  workspaces: WireDeviceConfigFile | null
}

// ---------------------------------------------------------------------------
// config / set_config — the scoped-config channel

/**
 * The scope of a `config` read / `set_config` write, selecting the base the
 * `<consumer>/config/<file>` path hangs off. Closed set; consumers still tolerate
 * unknown values per additive evolution.
 * - `machine` — the per-user device-global file at
 *   `~/.arsumbris/<consumer>/config/<file>`. No git commit, device-wide.
 * - `repo` — the per-member file at `<repo>/.arsumbris/<consumer>/config/<file>`;
 *   the `root` arg names which member root (absent = the served entry). Commits.
 */
export type WireConfigScope = 'machine' | 'repo'

/**
 * Args for the `config` read (and, shared field-for-field, the `set_config`
 * write's addressing): one CONSUMER config file under the scoped-config channel.
 * - `scope`: `machine` / `repo` (see `WireConfigScope`).
 * - `consumer`: the owner segment, a namespacing convention (e.g. `au-host`).
 *   Path-safe, and NOT the engine's reserved `au-engine` (case-insensitive) — a
 *   reserved or path-unsafe `consumer` is an `error` frame, nothing read.
 * - `file`: the config filename under `<consumer>/config/`.
 * - `type`: the DECLARED type the value is field-shape-validated against — a
 *   FLOOR. A file's own written `type:` wins and may subtype it; an absent one is
 *   stamped and carries the `config-type-unwritten` drift.
 * - `root` (repo scope only): the member root whose `.arsumbris/` holds the file,
 *   a declared member root as `members` surfaces it; absent defaults to the served
 *   entry. Ignored at machine scope; an unknown repo-scope `root` is an `error`.
 */
export interface WireConfigArgs {
  scope: WireConfigScope
  consumer: string
  file: string
  type: string
  root?: string
}

/**
 * Result of the `config` read: the same per-file view `device_config` returns,
 * for ONE scoped-config file — its resolved path, presence, raw content, and the
 * field-shape diagnostics. Read OUT-OF-BAND by the verb: the file is NOT a walked
 * node, so no `instances_of`, no candidate scan, no reference-liveness on wikilink
 * values. The consumer owns merge, resolution, and drift across scopes; the engine
 * never merges.
 *
 * Unlike `WireDeviceConfigFile`, `path` is NULLABLE: null only when the scope has
 * no resolvable base (machine scope with `$HOME` unset). Present even when the
 * file is absent otherwise, so a consumer knows where to author.
 */
export interface WireConfigFile {
  /**
   * The resolved absolute path, present even when the file is absent; null ONLY
   * when the scope has no resolvable base (machine scope, `$HOME` unset).
   */
  path: string | null
  /**
   * True when the file exists and was read; false is a legitimate
   * not-yet-authored state (null `content`, empty `diagnostics`).
   */
  exists: boolean
  /** The raw file text when present and UTF-8; null when absent or not UTF-8 (the not-UTF-8 case still carries a diagnostic). */
  content: string | null
  /**
   * The field-shape verdict against the file's own `type:` (else the declared
   * `type` stamped), resolved in the scope's graph. Same shape and codes as the
   * `diagnostics` read, with spans into THIS real file. ADVISORY only: a
   * `config-type-unresolved` (warning, the type does not resolve — stored as-is)
   * or `config-type-unwritten` (drift, no written `type:`); see
   * `WireConfigDiagnosticCode`. Field-shape only: no references, no closure to walk.
   */
  diagnostics: WireDiagnostic[]
}

/** Result of the `config` read: the one scoped-config file's per-file view. */
export type WireConfigResult = WireConfigFile

// ---------------------------------------------------------------------------
// ignores

/** Arguments for the `ignores` read. */
export interface WireIgnoresArgs {
  /**
   * Scope to one member by declared name. Absent reads every member; an unknown
   * name yields an empty `members`.
   */
  repo?: string
  /**
   * Compute the boundary-level effect (`resolved`) at one bounded extra walk.
   * Default false. Present, each member entry carries `resolved`.
   */
  resolve?: boolean
}

/**
 * The boundary-level effect of a member's scope rules, present on a
 * `WireIgnoresMember` only when the `ignores` read ran with `resolve: true`.
 * Boundaries, NOT contents: a pruned directory is ONE `ignored_dirs` entry and
 * its contents are never enumerated (a pruned `node_modules` is one entry); an
 * individually-excluded file is one `ignored_files` entry. The unconditional
 * floor is not repeated here (it is the member's `floor` field).
 */
export interface WireIgnoresResolved {
  /** Pruned directory boundaries — one entry per pruned dir, contents not enumerated. */
  ignored_dirs: string[]
  /** Individually-excluded files. */
  ignored_files: string[]
}

/**
 * One member's file-scope rules, read out-of-band from `.arsumbris/.auignore`
 * (no walk). Pairs with the `set_ignores` mutation, which edits `patterns`.
 */
export interface WireIgnoresMember {
  /** The member's absolute root directory on this machine. */
  root: string
  /** The declared member name (its `::repo` label). */
  repo: string
  /**
   * The editable `.auignore` lines, verbatim — comments and blanks kept, so a
   * `set_ignores` round-trip preserves them. Empty when the file is absent.
   */
  patterns: string[]
  /**
   * The seeded, overridable default excludes (`["node_modules", "target"]`).
   * Overridable via `patterns`.
   */
  default_excludes: string[]
  /**
   * The unconditional floor (`[".git", ".arsumbris"]`), always excluded and NOT
   * editable — a `set_ignores` cannot lift it.
   */
  floor: string[]
  /**
   * The boundary-level effect, present ONLY when the read ran with
   * `resolve: true`; omitted otherwise.
   */
  resolved?: WireIgnoresResolved
}

/**
 * Result of the `ignores` read: one entry per member (or the one named by
 * `repo`), each carrying that member's editable `.auignore` rules, the seeded
 * default excludes, the unconditional floor, and — with `resolve: true` — the
 * boundary-level effect. The file-scope surface a scope-management UI reads and
 * (via `set_ignores`) edits.
 *
 * The `ignores` read's result envelopes the member array under the verb key
 * (`{ ignores: [...] }`), so the generic accessor unwraps it to this array
 * directly. **Schema 17**: the payload key was `members`, which collided in
 * shape-name with the `members` read while carrying a different element type;
 * and the array is now enveloped (was a bare `{ members: [...] }` object).
 */
export type WireIgnoresResult = WireIgnoresMember[]

// ---------------------------------------------------------------------------
// semantic_tokens

/**
 * One semantic-highlight token: a source `range` plus a `kind`-tagged payload
 * a generic grammar cannot produce (type-aware, reference-aware). `range`
 * reuses `WireSpan`; for a held file its `line_col` is always present.
 *
 * Kinds (hyphenated as on the wire):
 * - `wikilink-resolved` / `wikilink-broken` — a body or frontmatter wikilink;
 *   `resolved` (the file path) rides only the resolved arm. `repo` is the
 *   `::repo` qualifier when the link crosses a repo boundary (omitted otherwise);
 *   a `::repo` link resolves into the named repo, an unqualified one repo-local.
 *   The frontmatter case covers both a whole-value frontmatter wikilink and a
 *   link embedded inside a longer String value (the surrounding text rides
 *   `field-value`). The LOCAL form (an empty `target` with a locating fragment,
 *   `[[^id]]` / `[[#head]]` / `[[^^id]]`) resolves to the file itself, so it
 *   rides `wikilink-resolved` (`resolved` = that file), never broken.
 * - `wikilink-pinned` — a commit-pinned wikilink: a named pin (`[[file::@sha]]`)
 *   or the empty-target commit-referent (`[[::@sha]]` / `[[::repo@sha]]`).
 *   `target` (empty for a commit-referent, the pinned name for a named pin),
 *   optional `repo`, plus `commit` (the pinned sha). An inert coordinate into an
 *   immutable past, neither resolved nor broken, the token twin of the
 *   `commit-referent` edge on `references_out`.
 * - `field-value` — a typed scalar; `value_type` (a `WireShape`) is always
 *   present, declared or slot-pinned or inferred from the YAML literal as a
 *   bare primitive. A whole-value wikilink is a `wikilink-*` token, never this;
 *   but a String value with an EMBEDDED `[[...]]` emits both — a `wikilink-*`
 *   token for the link and `field-value` tokens for the surrounding text runs,
 *   so one string value can decode to several interleaved tokens.
 * - `type-claim` — a `type:` reference to a type-def, one per claimed name.
 * - `typed-block` — an inline `[:field]` fence; a container whose inner scalars
 *   ride their own `field-value` tokens (the one nesting).
 * - `block-id` — an addressable id (`^id` marker, trailing fence id, or `^:` record id).
 * - `anchor` — a heading line, the target a `#anchor` fragment resolves to.
 *
 * The type-def shape kinds, emitted ONLY for a type-def file (`*.type.yaml`):
 * - `field-shape` — a field's declared shape, a CONTAINER spanning the whole
 *   shape expression; `field` plus `value_type` (a `WireShape`, or null when the
 *   shape failed to parse). Encloses the leaf kinds below. A quoted shape (e.g.
 *   `r: "decision*"`) emits this container but NOT its leaves — the normalized
 *   scalar's offsets don't map onto the source, so the per-name leaves are
 *   dropped rather than mis-placed (never a wrong span).
 * - `type-ref` — a navigable type-def name (`name`): a field-shape name
 *   (record / reference / inline base, compound operand, def-ref bound) or a
 *   `sealed:` branch. Broken-ness rides the diagnostics read, never a token flag.
 * - `shape-builtin` — a built-in shape keyword (`name`): a primitive, `file`,
 *   `any`, or `type`.
 * - `enum-member` — an inline enum literal (`value`).
 *
 * A note (no `type:` claim) carries only the body-surface kinds:
 * `wikilink-*`, `block-id`, `anchor`. A type-def file carries only the shape
 * kinds (`field-shape` / `type-ref` / `shape-builtin` / `enum-member`) plus the
 * reused `type-claim` (its parent claims and `meta:` `type:`), no value-layer or
 * body-surface kinds.
 *
 * A `::repo`-qualified name now appears verbatim in the `name` fields — the
 * `type-claim` claim / parent / meta and the `type-ref` field-shape name read
 * `name::repo`, not the stripped base. A name never contains `:`, so `::`
 * separates the type name from the repo scope.
 */
export type WireSemanticToken =
  | { kind: 'wikilink-resolved'; range: WireSpan; target: string; repo?: string; resolved: string }
  | { kind: 'wikilink-broken'; range: WireSpan; target: string; repo?: string }
  | { kind: 'wikilink-pinned'; range: WireSpan; target: string; repo?: string; commit: string }
  | { kind: 'field-value'; range: WireSpan; field: string; value_type: WireShape }
  | { kind: 'type-claim'; range: WireSpan; name: string }
  | { kind: 'typed-block'; range: WireSpan; field: string }
  | { kind: 'block-id'; range: WireSpan; id: string }
  | { kind: 'anchor'; range: WireSpan; text: string }
  | { kind: 'field-shape'; range: WireSpan; field: string; value_type: WireShape | null }
  | { kind: 'type-ref'; range: WireSpan; name: string }
  | { kind: 'shape-builtin'; range: WireSpan; name: string }
  | { kind: 'enum-member'; range: WireSpan; value: string }

/**
 * Result of the `semantic_tokens` read: the file's tokens sorted ascending by
 * `range.start`, or null when the path is not a held file. Tokens reflect the
 * last build (disk); a consumer refreshes via the `changes` subscription.
 */
export type WireSemanticTokensResult = WireSemanticToken[] | null

// ---------------------------------------------------------------------------
// lifecycle

/**
 * Result of the `lifecycle` read (**schema 17**, renamed from `ready`): the
 * engine and ref lifecycle states. The envelope's `ready` flag / `version` carry
 * the probe; see `LifecycleResult` in `./wire.ts` for the client's normalized
 * view.
 */
export interface WireLifecycleResult {
  engine: string
  ref: string
}
