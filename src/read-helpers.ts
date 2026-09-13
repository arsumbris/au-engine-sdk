// Typed helpers over the read catalog: issue the read, narrow the result.
// No policy — retries, caching, and readiness handling are consumer
// concerns (or the optional hardening utilities).
//
// Helpers run over any `WireReader`: a `DaemonClient` or a projection's
// `MountHost.engine`. Both transports answer the same wire read; the
// helper normalizes their envelopes into one `TypedRead`.
//
// Pure functions, type-only imports — renderer-safe (`./reads` subpath).

import { WireError } from './wire.ts'
import type { EngineReadResult, ReadRequest, ResponseFrame } from './wire.ts'
import { toWireStamps, type Stamp } from './stamps.ts'
import type {
  WireReferencesInResult,
  WireAnchorsResult,
  WireBlockIdsResult,
  WireCandidateCountsResult,
  WireCandidatesArgs,
  WireCandidatesResult,
  WireCandidatesSummaryResult,
  WireDirEntriesResult,
  WireConfigArgs,
  WireConfigResult,
  WireContentResult,
  WireDeviceConfigResult,
  WireDiagnosticCountsResult,
  WireDiagnosticsFilter,
  WireDiagnosticsPage,
  WireDiagnosticsResult,
  WireFilesArgs,
  WireFilesResult,
  WireFrontmatterResult,
  WireIgnoresArgs,
  WireIgnoresResult,
  WireHubsArgs,
  WireHubsResult,
  WireGraphShapeArgs,
  WireGraphShapeResult,
  WireLinkGraphArgs,
  WireLinkGraphResult,
  WireTypeGraphArgs,
  WireTypeGraphResult,
  WireInstanceCountsResult,
  WireInstancesOfArgs,
  WireInstancesOfResult,
  WireInstancesResult,
  WireImportsResult,
  WireMembersResult,
  WireNeighborhoodArgs,
  WireNeighborhoodResult,
  WireOverviewArgs,
  WireOverviewResult,
  WirePinsResult,
  WireCommitMetaInput,
  WireCommitMetaResult,
  WireFileHistoryResult,
  WireRecentCommitsArgs,
  WireRecentCommitsResult,
  WireTopLevelDirsArgs,
  WireLifecycleResult,
  WireReferencesOutResult,
  WireTypeClosureResult,
  WireValidateValueResult,
  WirePreviewMutationResult,
  WireResolveAnchorResult,
  WireResolveBlockIdResult,
  WireInstanceResult,
  WireResolveMemberResult,
  WireResolveTargetResult,
  WireSemanticTokensResult,
  WireSubtypesResult,
  WireTopLevelDirsResult,
  WireTypeBatchResult,
  WireTypeCountsResult,
  WireTypeResult,
  WireTypeScope,
  WireTypesArgs,
  WireTypesResult,
  WireTypesSummaryResult,
  WireTypeTreeResult,
} from './reads.ts'

/**
 * The minimal surface helpers read over. `DaemonClient` satisfies it
 * directly; so does `MountHost['engine']`.
 */
export interface WireReader {
  read(request: ReadRequest): Promise<ResponseFrame | EngineReadResult>
}

/**
 * A read's typed outcome — three arms, so a consumer renders every case
 * without a try/catch:
 * - `{ ok: false }` — the daemon rejected the read (a wire error frame, or
 *   the mount host's in-band `ok: false`). The connection is fine; the
 *   request was bad. Discriminate first: only this arm carries `ok`.
 * - `{ ready: false }` — the ref is still Deriving. Subscribe to `lifecycle`
 *   or retry rather than polling.
 * - `{ ready: true; … }` — the result, at the version it was observed.
 *
 * A transport failure (socket death, closed client) is NOT an arm: it
 * still throws, because it is not an answer to the read.
 */
export type TypedRead<T> =
  | { ok: false; error: string }
  | { ready: false }
  | { ready: true; version: number; result: T }

/**
 * Issue a read over either transport, normalize the envelope, narrow the result.
 *
 * The result envelope (schema 17): every read's `result` is an object carrying
 * its payload under the read's OWN name, so `result[verb]` reaches every
 * payload — a list read wraps its array, a nullable read wraps its null
 * (`{ type: null }`), a record read wraps its record. The verb is the request's
 * own `read`, so this ONE accessor unwraps the whole catalog; no per-read
 * table.
 *
 * `unwrap` is true by default. The few reads whose `result` carries
 * envelope-level metadata BESIDE the payload key (`instances` →
 * `{ count, aborted_at_load, instances }`, `candidates` →
 * `{ aborted_at_load, candidates }`, `subtypes` → `{ base, subtypes }`) pass
 * `unwrap: false` to keep the whole object, so their `count` / `aborted_at_load`
 * / `base` are not dropped.
 */
async function issueRead<T>(
  reader: WireReader,
  request: ReadRequest,
  unwrap = true,
): Promise<TypedRead<T>> {
  let response: ResponseFrame | EngineReadResult
  try {
    response = await reader.read(request)
  } catch (err) {
    // A wire error frame: the request was bad, the connection survives.
    // Anything else (socket death, closed client) is transport failure.
    if (err instanceof WireError) return { ok: false, error: err.message }
    throw err
  }
  // The mount host reports the same wire error in-band instead of rejecting.
  if ('ok' in response && !response.ok) return { ok: false, error: response.error }
  if (!response.ready) return { ready: false }
  // Both transports now guarantee `version` once ready — no cast needed.
  // The `?.` guards a malformed/absent envelope: the wire always sends the
  // object once ready, so this only avoids a throw on a contract violation.
  const env = response.result as Record<string, unknown> | null | undefined
  const payload = unwrap ? env?.[request.read] : env
  return { ready: true, version: response.version, result: payload as T }
}

/**
 * The `diagnostics` read: the in-scope diagnostics, in the served stream's
 * stable order. `filter` composes (AND); `page` (`limit` / `offset`) takes a
 * read-only window — absent `limit` returns the whole filtered set. No total
 * rides the page: page until a short page (`< limit`), or call
 * `readDiagnosticCounts` for the total.
 *
 * ACTIONABILITY read (**schema 17**): `filter.scope` defaults to `own` (a
 * read-only dependency's diagnostics are hidden), UNLESS a location pin
 * (`repo` / `path` / `path_prefix`) flips the default to `all` — so asking for a
 * dependency file's diagnostics does not silently answer empty. See
 * `WireDiagnosticsFilter`.
 */
export function readDiagnostics(
  reader: WireReader,
  filter?: WireDiagnosticsFilter,
  page?: WireDiagnosticsPage,
): Promise<TypedRead<WireDiagnosticsResult>> {
  return issueRead(reader, { read: 'diagnostics', ...filter, ...page })
}

/**
 * The `diagnostic_counts` read: `{ total, by_severity, by_code }` over the same
 * filtered set as `readDiagnostics`, without materializing every entry — the
 * shape of the problem (e.g. "79 navigational-target-not-found" as one line).
 * `limit` / `offset` do not apply; counts are always over the full filtered set.
 */
export function readDiagnosticCounts(
  reader: WireReader,
  filter?: WireDiagnosticsFilter,
): Promise<TypedRead<WireDiagnosticCountsResult>> {
  return issueRead(reader, { read: 'diagnostic_counts', ...filter })
}

/**
 * Type-defs across the workspace, each entry carrying its `repo`. All of `repo`
 * / `summary` / `limit` / `offset` are optional; no args is the full-detail
 * workspace-wide read (every type-def deduped to its owner copy, name-sorted).
 *
 * - `repo` scopes resolution to one member's whole graph by its declared name,
 *   borrowed copies included. An unknown `repo` resolves to a null result (the
 *   wire's unresolved-lookup signal), distinct from a known repo with no types
 *   (an empty array).
 * - `scope` (`all` default / `own`) filters to the user's own repos, hiding
 *   dependencies and the `au.engine.*` builtin (see `WireTypeScope`). Orthogonal
 *   to `repo` — a named dependency under `own` returns an empty set.
 * - `summary: true` projects each entry to the lightweight `WireTypeSummary`
 *   browse form; the return type narrows to `WireTypesSummaryResult` via the
 *   overload. Drill into a summary entry with `readType` / `readTypeBatch`,
 *   keyed by the `name` / `hash` it carries.
 * - `limit` / `offset` page the name-sorted set; a short page (`< limit`)
 *   signals the end. No total rides the array — page until a short page, or ask
 *   `readTypeCounts`.
 *
 * Breaking (from the schema-8 signature): args moved from a positional `repo`
 * to an options bag; `readTypes(r, "x")` → `readTypes(r, { repo: "x" })`. Absent
 * `repo` is workspace-wide, not the root repo — pass the root's declared name to
 * recover the old scope.
 */
export function readTypes(
  reader: WireReader,
  args: WireTypesArgs & { summary: true },
): Promise<TypedRead<WireTypesSummaryResult>>
export function readTypes(reader: WireReader, args?: WireTypesArgs): Promise<TypedRead<WireTypesResult>>
export function readTypes(
  reader: WireReader,
  args: WireTypesArgs = {},
): Promise<TypedRead<WireTypesResult | WireTypesSummaryResult>> {
  return issueRead(reader, { read: 'types', ...args })
}

/**
 * The shape of the vocabulary without pulling every def: `{ total, by_repo }`
 * over the same entry set `readTypes` spans for the same `repo` scope — the type
 * dual of `readDiagnosticCounts`. `repo` is the same scope filter as `readTypes`
 * (absent the owner-deduped workspace set, present that member's whole graph);
 * an unknown `repo` yields a null result. `scope` (`all` default / `own`) is the
 * same own-vs-all filter as `readTypes`. `summary` / `limit` / `offset` do not
 * apply — counts are always over the full set. Lets a consumer show "42 types
 * across 3 repos" and page `readTypes` until a short page, instead of pulling
 * the whole set to count it.
 */
export function readTypeCounts(
  reader: WireReader,
  repo?: string,
  scope?: WireTypeScope,
): Promise<TypedRead<WireTypeCountsResult>> {
  return issueRead(reader, {
    read: 'type_counts',
    ...(repo !== undefined && { repo }),
    ...(scope !== undefined && { scope }),
  })
}

/**
 * Per-type instance counts, the instances dual of `readTypeCounts`: for each
 * type identity in scope, how many instance sites count toward it. Lets a
 * consumer render a browsable vocabulary-with-counts overview in ONE round-trip,
 * instead of N `readInstancesOf` reads.
 *
 * `repo` / `scope` take the SAME shape and defaults as `readTypeCounts`
 * (`scope` `all` default / `own`), but scoping filters the instance SITE by the
 * repo it is authored in, not the type identity's owner — so `repo=<dependency>,
 * scope=own` returns empty. An unknown `repo` yields a null result.
 *
 * `by_type` is IDENTITY-KEYED (`{ name, hash, type_owners, count }`, sorted by
 * `(name, hash)`): a consumer joins a count onto a `types` summary row by
 * `(name, hash)`. It is CLOSURE-INCLUSIVE — a site counts toward every type in
 * its closure (claim + ancestors), so a `count` equals the length of the
 * matching `readInstancesOf` drill-in and the counts do NOT sum to `total`.
 */
export function readInstanceCounts(
  reader: WireReader,
  repo?: string,
  scope?: WireTypeScope,
): Promise<TypedRead<WireInstanceCountsResult>> {
  return issueRead(reader, {
    read: 'instance_counts',
    ...(repo !== undefined && { repo }),
    ...(scope !== undefined && { scope }),
  })
}

/**
 * One type-def by `name`, carrying its `repo` and `hash`; null when absent. The
 * `name` is the authored form — bare (`foo`) or `::repo`-qualified (`foo::repo`),
 * the way `readInstancesOf` takes its `type`. There is no separate `repo` arg
 * (that scoping now folds into the name): a bare name resolves to the owner copy
 * across all members, a `foo::repo` scopes to the identity that repo holds
 * (null when absent there or the repo is unknown). The structured `repo` filter
 * lives on the enumeration `readTypes`, not here.
 */
export function readType(reader: WireReader, name: string): Promise<TypedRead<WireTypeResult>> {
  return issueRead(reader, { read: 'type', name })
}

/**
 * The batch form of {@link readType}: resolve several type names in one
 * round-trip. Each `name` is the authored form, bare (`foo`) or `::repo`-qualified
 * (`foo::repo`), as `readType` takes it. The result is one entry per requested
 * name, in request order — each the single-`name` result (a `WireTypeDef`) or
 * null for a name no member owns / absent from a scoped repo / an unknown repo.
 * The detail-on-demand dual of the `readTypes` summary: drill into N summary
 * entries at once, paying one round-trip instead of N `readType` calls.
 * **Schema 17**: the batch form is its OWN verb, `type_batch` — one verb
 * answering two cardinalities under one payload key was the envelope rule's only
 * ambiguous case, so it is two verbs, each mono-shaped.
 */
export function readTypeBatch(reader: WireReader, names: string[]): Promise<TypedRead<WireTypeBatchResult>> {
  return issueRead(reader, { read: 'type_batch', names })
}

/**
 * The workspace's owner-deduped type-defs as a cross-repo parent/child
 * adjacency forest (`{ roots, nodes }`), owner-annotated per node — the
 * agent-friendly tree form, composable from `readTypes()` plus `parents` but
 * served first-class. DAG-honest: a multi-parent node appears once, referenced
 * by each parent's `children`. `scope` (`all` default / `own`) is the same
 * own-vs-all filter as `readTypes` — `own` builds the tree over only the user's
 * own repos' types.
 */
export function readTypeTree(
  reader: WireReader,
  scope?: WireTypeScope,
): Promise<TypedRead<WireTypeTreeResult>> {
  return issueRead(reader, { read: 'type_tree', ...(scope !== undefined && { scope }) })
}

/**
 * Match records for a type, one per (instance, matched identity), at any site
 * `origin` (`file` / `nested` / `meta`). `type` is a type name, bare or
 * `::repo`-qualified: bare matches every distinct identity of that name across
 * the workspace (so one instance can appear under several `hash`es), a
 * `type::repo` matches the one identity that repo owns.
 *
 * `args` (all optional):
 * - `origins` — an include-set filter over the site kinds; absent means ALL
 *   origins (**schema 13**, breaking — the old default was file-only, recovered
 *   with `origins: ['file']`).
 * - `instance: true` / `body: true` — opt-in server-side composition
 *   (**schema 17**), splicing each match's resolved view / markdown body onto its
 *   record, collapsing `1 + kN` round trips into one. Independent, either / both /
 *   neither.
 *
 * Breaking (**schema 17**): args moved from a positional `origins` to an options
 * bag; `readInstancesOf(r, t, ['file'])` → `readInstancesOf(r, t, { origins: ['file'] })`.
 */
export function readInstancesOf(
  reader: WireReader,
  type: string,
  args: WireInstancesOfArgs = {},
): Promise<TypedRead<WireInstancesOfResult>> {
  return issueRead(reader, { read: 'instances_of', type, ...args })
}

/**
 * The workspace's discovered fold-axis `::repo` use set — one record per
 * (importing repo, imported peer identity). A field-shape `foo::repo*` is a
 * reference (the seam), not an import, and is excluded, as is an unresolvable
 * `::repo` (the gate diagnostics own that feedback). `scope` (`all` default /
 * `own`) keeps only imports MADE BY the user's own repos and drops the automatic
 * `au.engine.*` builtin fold (owned by the builtin, not a user-authored edge).
 */
export function readImports(
  reader: WireReader,
  scope?: WireTypeScope,
): Promise<TypedRead<WireImportsResult>> {
  return issueRead(reader, { read: 'imports', ...(scope !== undefined && { scope }) })
}

/**
 * Every type-def across the workspace whose closure includes `base` — the
 * type-level dual of `readInstancesOf`. The result's `subtypes` is name-sorted,
 * closure-based (transitive subtypes included, the base itself excluded), and
 * workspace-wide: the engine walks every member's graph, so the caller skips the
 * per-repo `readTypes` enumeration fan-out.
 * Each match is deduped to its owner copy (the one carrying `meta_blocks`) and
 * carries that owner's `repo` beside the usual type-def fields, so a consumer
 * gets name + owner repo + owner `source` + runtime meta in one read. `base` is
 * bare (`foo`) or `::repo`-qualified. `scope` (`all` default / `own`) is the same
 * own-vs-all filter as `readTypes` — `own` keeps only subtypes owned by the
 * user's own repos.
 */
export function readSubtypes(
  reader: WireReader,
  base: string,
  scope?: WireTypeScope,
): Promise<TypedRead<WireSubtypesResult>> {
  // Whole-envelope: `{ base, subtypes }` carries the echoed `base` beside the payload.
  return issueRead(reader, { read: 'subtypes', base, ...(scope !== undefined && { scope }) }, false)
}

/**
 * Validate a transient JSON `value` against a named type-def — the "validate"
 * half of validation decoupled from "is a file". The value never touches disk.
 *
 * **Schema 17**: MULTI-FIT and FAILS CLOSED. The result is an ARRAY of verdicts,
 * one per mounted identity the name denotes: a bare `typeName` owned by N repos
 * returns N verdicts, each validated against its OWN identity's shape; a `repo`
 * arg (absent = EVERY mounted identity, NOT the root repo) or a `::repo` in
 * `typeName` (which wins over `repo`) narrows to the 0-or-1 that repo owns. An
 * unknown name returns ONE verdict with `identity: null` carrying
 * `unknown-type-claim` — never `[]`, so fold `diagnostics` across the verdicts
 * and a miss shows as an error, not a clean bill of health. A non-object `value`
 * returns `instance-not-a-mapping`. Spans index a synthesized document, so the
 * codes/messages are the verdict, not the positions.
 */
export function readValidateValue(
  reader: WireReader,
  typeName: string,
  value: unknown,
  repo?: string,
): Promise<TypedRead<WireValidateValueResult>> {
  return issueRead(reader, {
    read: 'validate_value',
    type_name: typeName,
    value,
    ...(repo !== undefined && { repo }),
  })
}

/**
 * The op a `preview_mutation` simulates, discriminated by `op`. Mirrors the v1
 * deterministic mutation catalog (`write_file` / `edit_file` / `delete_file`),
 * reusing their argument shapes so a consumer previews the exact call it would
 * then mutate with. Consumer-facing camelCase; `readPreviewMutation` normalizes
 * to the wire (`oldString` → `old_string`, `replaceAll` → `replace_all`, and
 * `stamps` folded via `toWireStamps`). NO `expectedHash`: a concurrency guard is
 * about the write moment, not the product.
 */
export type PreviewMutationOp =
  | { op: 'write_file'; path: string; content: string; stamps?: Stamp[] }
  | {
      op: 'edit_file'
      path: string
      oldString: string
      newString: string
      replaceAll?: boolean
      stamps?: Stamp[]
    }
  | { op: 'delete_file'; path: string }

/**
 * Dry-run a deterministic mutation and read its product WITHOUT committing: the
 * would-be file's resolved type identities + whole-file diagnostics, plus a
 * per-file blast radius. It simulates the op over an overlay of the current
 * snapshot and rolls it away — no disk write, no commit. Git-free: the type and
 * diagnostics come from the same recompute a real rebuild runs, so the preview
 * cannot disagree with what the write would land, and it determines the ACTUAL
 * type from the would-be content (a `type:` claim in junk cannot pass).
 *
 * The result is a `WirePreviewMutationResult` — DISCRIMINATE with `'reject' in
 * result`: a `{ reject }` is a structural refusal (an edit/delete of an absent
 * file, an absent or non-unique `oldString`, a stamp on a non-list field, a path
 * that mounts nowhere), returned as DATA on a successful read, not an error frame.
 * Otherwise a `{ target, blast_radius }` built product. `target.identities` is
 * EMPTY for a plain note and for a delete; `target.hash` is `null` for a delete.
 *
 * Additive (**schema stays 24**). v1 is physical files only; the structural
 * refactors are not previewable yet.
 */
export function readPreviewMutation(
  reader: WireReader,
  op: PreviewMutationOp,
): Promise<TypedRead<WirePreviewMutationResult>> {
  const request: ReadRequest =
    op.op === 'write_file'
      ? { read: 'preview_mutation', op: 'write_file', path: op.path, content: op.content, ...toWireStamps(op.stamps) }
      : op.op === 'edit_file'
        ? {
            read: 'preview_mutation',
            op: 'edit_file',
            path: op.path,
            old_string: op.oldString,
            new_string: op.newString,
            ...(op.replaceAll !== undefined && { replace_all: op.replaceAll }),
            ...toWireStamps(op.stamps),
          }
        : { read: 'preview_mutation', op: 'delete_file', path: op.path }
  return issueRead(reader, request)
}

/**
 * The resolved ancestor closure and effective field set of a type identity
 * (**schema 17**, NEW). `name` is bare (`foo`) or `::repo`-qualified; `repo` is
 * the same scoping as an arg (a `::repo` in `name` says the same thing and wins).
 *
 * MULTI-FIT: the result is an ARRAY, one entry per matching identity. A bare
 * `name` conflates across mounted repos, so it answers one closure per identity;
 * a qualifier scopes to the 0-or-1 that repo owns. An unknown name is an EMPTY
 * array (never null or an error). Each entry carries `identity`, `ancestors`
 * (self first, owner-resolved), and `fields` (effective set, each with its
 * declaring `origin`) — one read replaces the client-side closure / field-origin
 * walks, and it is the same walk the validator runs.
 *
 * FLAG: a consumer expecting a single object will read `[0]`-shaped data wrong.
 */
export function readTypeClosure(
  reader: WireReader,
  name: string,
  repo?: string,
): Promise<TypedRead<WireTypeClosureResult>> {
  return issueRead(reader, { read: 'type_closure', name, ...(repo !== undefined && { repo }) })
}

export function readInstances(reader: WireReader): Promise<TypedRead<WireInstancesResult>> {
  // Whole-envelope: `{ count, aborted_at_load, instances }` — the metadata siblings are kept.
  return issueRead(reader, { read: 'instances' }, false)
}

/**
 * The implicit-identity candidate scan, grouped by file — every scanned file,
 * candidate-bearing or not (so scanned-and-empty stays distinct from
 * not-scanned). All of `summary` / `limit` / `offset` are optional; no args is
 * the full-detail scan. The scan is knowledge-base-wide, so there is no `repo` scope.
 *
 * - `summary: true` projects each file to `WireFileCandidatesSummary` (a flat
 *   array of candidate type names); the return type narrows to
 *   `WireCandidatesSummaryResult` via the overload. Pair with
 *   `readCandidateCounts` for the totals.
 * - `limit` / `offset` page the file list in the catalog's sorted order; a
 *   short page (`< limit`) signals the end.
 */
export function readCandidates(
  reader: WireReader,
  args: WireCandidatesArgs & { summary: true },
): Promise<TypedRead<WireCandidatesSummaryResult>>
export function readCandidates(reader: WireReader, args?: WireCandidatesArgs): Promise<TypedRead<WireCandidatesResult>>
export function readCandidates(
  reader: WireReader,
  args: WireCandidatesArgs = {},
): Promise<TypedRead<WireCandidatesResult | WireCandidatesSummaryResult>> {
  // Whole-envelope: `{ aborted_at_load, candidates }` — the `aborted_at_load` sibling is kept.
  return issueRead(reader, { read: 'candidates', ...args }, false)
}

/**
 * The shape of the candidate scan without materializing every file's
 * candidates: `{ aborted_at_load, total_files, files_with_candidates, by_type }`
 * — the candidates dual of `readDiagnosticCounts`. `by_type` is the "N untyped
 * files could claim type X" histogram, counting FILES. Argless and knowledge-base-wide;
 * `aborted_at_load` matches `readCandidates`, so a zero count from a skipped
 * scan stays distinct from an empty one.
 */
export function readCandidateCounts(reader: WireReader): Promise<TypedRead<WireCandidateCountsResult>> {
  return issueRead(reader, { read: 'candidate_counts' })
}

/**
 * One instance's resolved view (the full value layer), null when `path` is not a
 * parsed instance. **Schema 17**: the read is `instance` (renamed from
 * `resolved`, which collided with this view's own `resolved` boolean field); it
 * is now the singular of `instances`, as `type` is of `types`.
 */
export function readInstance(reader: WireReader, path: string): Promise<TypedRead<WireInstanceResult>> {
  return issueRead(reader, { read: 'instance', path })
}

/**
 * EVERY outgoing wikilink edge of `path`, frontmatter then body, each classified
 * by `surface` + `kind` (**schema 17**: the read was body-only, now complete).
 * The `kind` is load-bearing — it decides how to traverse the edge and how
 * severe a break is (see `WireReferenceOutKind`). Derives from the same single
 * traversal as `readReferencesIn`, so the two directions cannot disagree.
 */
export function readReferencesOut(reader: WireReader, path: string): Promise<TypedRead<WireReferencesOutResult>> {
  return issueRead(reader, { read: 'references_out', path })
}

/**
 * The inbound reference edges to `path`. **Schema 17**: the read is
 * `references_in` (renamed from `backlinks`), so it now reads as one pair with
 * `readReferencesOut` and derives from the same single traversal.
 */
export function readReferencesIn(reader: WireReader, path: string): Promise<TypedRead<WireReferencesInResult>> {
  return issueRead(reader, { read: 'references_in', path })
}

/**
 * The `pins` read: every commit-pinned reference naming `target` whose source
 * file contains an instance of `sourceType`. The reverse-by-target lookup for
 * commit-pinned references — an inert pin forms no inbound backlink, so this is
 * a fold over the retained OUTBOUND pins, not a `readReferencesIn` question.
 *
 * Both args are REQUIRED: `sourceType` scopes the candidate file set to
 * `instances_of(sourceType)`, keeping the fold off the whole graph; there is no
 * unscoped whole-graph form. NO time awareness and no live resolution — a
 * since-reused name returns EVERY pin naming it, the consumer windows by rename
 * time. Additive, so it rides `schema_version` 25 with no bump. See
 * {@link WirePinRecord}.
 */
export function readPins(
  reader: WireReader,
  target: string,
  sourceType: string,
): Promise<TypedRead<WirePinsResult>> {
  return issueRead(reader, { read: 'pins', target, source_type: sourceType })
}

/**
 * The `commit_meta` read (**schema 26**, additive, no bump): per-commit
 * metadata for `commits`, member-aware, off the build path. The git-enrichment
 * join partner for `readPins` — collect the distinct `{ commit, repo? }` set
 * and call once; general, reusable for any commit.
 *
 * The result is POSITIONAL: one record per input, in input order, so a consumer
 * maps a record back to its query by index (an abbreviated input resolves to
 * the full `commit` oid on its record). An unavailable commit is
 * `available: false` with every metadata field omitted. See
 * {@link WireCommitMeta}.
 */
export function readCommitMeta(
  reader: WireReader,
  commits: WireCommitMetaInput[],
): Promise<TypedRead<WireCommitMetaResult>> {
  return issueRead(reader, { read: 'commit_meta', commits })
}

/**
 * The `file_history` read (**schema 26**, additive, no bump): the commit stream
 * that touched `path`, member-aware, off the build path. Newest-first (git's log
 * order, a PARTIAL order over a DAG — not a total order across unrelated
 * branches). `repo` names the member whose tree resolves `path`; absent = the
 * entry repo.
 *
 * A `.git`-free member or a path with no history yields an EMPTY array, named,
 * not an error. `message` is the SUBJECT line only; the full body is a
 * `readCommitMeta` join away. See {@link WireFileHistoryEntry}.
 */
export function readFileHistory(
  reader: WireReader,
  path: string,
  repo?: string,
): Promise<TypedRead<WireFileHistoryResult>> {
  return issueRead(reader, {
    read: 'file_history',
    path,
    ...(repo !== undefined ? { repo } : {}),
  })
}

/**
 * The `recent_commits` read (**schema 29**, additive, no bump): a bounded,
 * newest-first commit stream merged across the workspace's working trees,
 * member-aware, off the build path. `file_history` generalized to no-path /
 * all-trees / bounded, with `trailers` on every row and a per-tree tag. Serves a
 * cross-repo git ACTIVITY view.
 *
 * All args optional. `members` filters by member name (each mapped to its owning
 * tree, deduped); with NEITHER `limit` nor `since` a default cap (100) applies,
 * so the read always bounds; given BOTH they intersect. Newest-first by
 * committer timestamp, tie-broken by oid. A `.git`-free member contributes
 * nothing, named. The live form is {@link subscribeRecentCommits}. See
 * {@link WireRecentCommit}.
 */
export function readRecentCommits(
  reader: WireReader,
  args: WireRecentCommitsArgs = {},
): Promise<TypedRead<WireRecentCommitsResult>> {
  return issueRead(reader, { read: 'recent_commits', ...args })
}

/**
 * The `neighborhood` read (**schema 20**): a bounded N-hop reference-graph walk
 * from `args.path`, returning the reachable SUBGRAPH (`nodes` plus the `edges`
 * traversed), not an edge list. Generalizes `readReferencesOut` / `readReferencesIn`
 * — `direction` and `depth` make one verb cover the whole axis. `kinds` is
 * REQUIRED past depth 1 (an unfiltered deep walk explodes through navigational
 * fan-out); `content` / `body` / `instance` splice payloads onto nodes for one
 * round trip instead of `1 + kN`. A semantically-invalid arg (unknown kind,
 * absent `kinds` past depth 1, `max_nodes: 0`) surfaces as a read-level error.
 */
export function readNeighborhood(
  reader: WireReader,
  args: WireNeighborhoodArgs,
): Promise<TypedRead<WireNeighborhoodResult>> {
  return issueRead(reader, { read: 'neighborhood', ...args })
}

/**
 * Resolve a wikilink target to its file. `target` carries the wikilink fragment
 * grammar, so an embedded `::repo` qualifier is honored. `origin` is the file the
 * link appears in: passing it scopes resolution to that source's repo (a bare
 * target repo-local, a `::repo` target cross-repo), identical to `references_out`
 * — the go-to-definition path. Absent `origin`, a `::repo` target resolves against
 * the named repo while a bare target resolves scopelessly across every index (and
 * a name present in two repos is ambiguous → null).
 */
export function readResolveTarget(
  reader: WireReader,
  target: string,
  origin?: string,
): Promise<TypedRead<WireResolveTargetResult>> {
  return issueRead(reader, { read: 'resolve_target', target, ...(origin !== undefined && { origin }) })
}

/** Resolve a block id within a target; `target`/`origin` scope as on {@link readResolveTarget}. */
export function readResolveBlockId(
  reader: WireReader,
  target: string,
  blockId: string,
  origin?: string,
): Promise<TypedRead<WireResolveBlockIdResult>> {
  return issueRead(reader, {
    read: 'resolve_block_id',
    target,
    block_id: blockId,
    ...(origin !== undefined && { origin }),
  })
}

/** Resolve a heading anchor within a target; `target`/`origin` scope as on {@link readResolveTarget}. */
export function readResolveAnchor(
  reader: WireReader,
  target: string,
  anchor: string,
  origin?: string,
): Promise<TypedRead<WireResolveAnchorResult>> {
  return issueRead(reader, { read: 'resolve_anchor', target, anchor, ...(origin !== undefined && { origin }) })
}

/**
 * Every heading in a target file, in document order — the LISTING dual of
 * {@link readResolveAnchor}, serving the `#anchor` position of a wikilink. That
 * verb answers whether one anchor resolves; this answers what an anchor can
 * address, so a consumer completing `[[file#` enumerates instead of guessing.
 *
 * Takes a wikilink `target`, NOT a path — a consumer completing a half-typed
 * link holds a target — with `target`/`origin` scoping as on
 * {@link readResolveTarget}.
 *
 * **Null is not empty.** An unresolved `target` answers null; a resolved file
 * with no headings answers `[]`. See `WireAnchorsResult` — collapsing the two
 * would offer an empty menu for a typo.
 */
export function readAnchors(
  reader: WireReader,
  target: string,
  origin?: string,
): Promise<TypedRead<WireAnchorsResult>> {
  return issueRead(reader, { read: 'anchors', target, ...(origin !== undefined && { origin }) })
}

/**
 * Every addressable id in a target file, in document order — the LISTING dual of
 * {@link readResolveBlockId}, serving the `^block_id` position of a wikilink.
 * Carries BOTH id surfaces (frontmatter inline-record `^:` and body occurrences:
 * typed `[:field]` fence ids, untyped fence ids, bare `^id` markers), span-sorted;
 * a regex over the body catches only the last of those.
 *
 * Takes a wikilink `target`, NOT a path, with `target`/`origin` scoping as on
 * {@link readResolveTarget}.
 *
 * **Every occurrence is listed, duplicates included** — the array is not
 * id-unique, and deliberately disagrees with `resolve_block_id`'s
 * first-match-wins cardinality. Typedness rides `kind`: a `^^` referent filters
 * to `record` / `typed_block`. Null-vs-empty as on {@link readAnchors}.
 */
export function readBlockIds(
  reader: WireReader,
  target: string,
  origin?: string,
): Promise<TypedRead<WireBlockIdsResult>> {
  return issueRead(reader, { read: 'block_ids', target, ...(origin !== undefined && { origin }) })
}

/**
 * Every catalogued file, path-sorted — the LISTING dual of
 * {@link readResolveTarget}, serving the `[[` target position. Each entry carries
 * `path` / `stem` / `repo` / `kind`; the catalogue IS the resolvable set, so this
 * is what a wikilink can reach.
 *
 * **An ASSET appears**, unread and hashless — the walker catalogues it by path
 * precisely so `file*` resolves against it. The implicit-identity
 * {@link readCandidates} scan reaches only PARSED files, so reading that for the
 * file set silently omits every asset.
 *
 * VOCABULARY read: `scope` defaults to **`all`**, inverting the `own` default the
 * actionability reads ({@link readHubs}, {@link readTopLevelDirs},
 * {@link readOverview}) take. A wikilink into a dependency is legal, so the
 * resolvable target set is what exists to link against; defaulting to `own` would
 * hide targets the validator accepts. A `repo` pin and `scope` compose (AND), and
 * a `repo` pin does NOT flip the default here — there is nothing to flip.
 *
 * The read dual of the `files` SUBSCRIPTION channel, which streams the same path
 * set and its deltas: read once, subscribe for change.
 */
export function readFiles(reader: WireReader, args: WireFilesArgs = {}): Promise<TypedRead<WireFilesResult>> {
  return issueRead(reader, { read: 'files', ...args })
}

/**
 * The direct entries of `dir` (files and subdirectories), hidden excluded and
 * catalog-derived (a directory holding no catalogued file does not appear).
 * **Schema 17**: the read is `dir_entries` (renamed from `children`, which
 * collided with `type_tree`'s graph-children meaning).
 */
export function readDirEntries(reader: WireReader, dir: string): Promise<TypedRead<WireDirEntriesResult>> {
  return issueRead(reader, { read: 'dir_entries', dir })
}

export function readFrontmatter(reader: WireReader, path: string): Promise<TypedRead<WireFrontmatterResult>> {
  return issueRead(reader, { read: 'frontmatter', path })
}

export function readContent(reader: WireReader, path: string): Promise<TypedRead<WireContentResult>> {
  return issueRead(reader, { read: 'content', path })
}

/**
 * The top-level directories of every mounted member in scope, each holding at
 * least one catalogued file (**schema 17**, renamed + rescoped from
 * `top_level_graphs`, which walked only the entry root). Each entry carries
 * `repo` / `name` / `path` / `member`.
 *
 * ACTIONABILITY read: `scope` defaults to `own`, so a read-only dependency's dirs
 * are not noise in the default. A location pin (`repo`) flips the default to
 * `all`; an explicit `scope` always wins. Pass `scope: "all"` for the old
 * workspace-wide numbers.
 */
export function readTopLevelDirs(
  reader: WireReader,
  args: WireTopLevelDirsArgs = {},
): Promise<TypedRead<WireTopLevelDirsResult>> {
  return issueRead(reader, { read: 'top_level_dirs', ...args })
}

/**
 * The `overview` read: the up-front orientation map, the one cheap read a
 * consumer loads first before drilling through the other reads. Each field is one
 * call to its own read with the resolved `repo` / `scope` (the mirror property),
 * echoed back on the result so a drill-down passes them verbatim. See
 * `WireOverviewResult`.
 *
 * ACTIONABILITY read: `scope` defaults to `own` (a location pin `repo` flips it to
 * `all`; an explicit `scope` wins). **Schema 17**: BREAKING — an argless call is
 * now `own`-scoped, so `type_counts` / `diagnostic_counts` / `hubs` /
 * `top_level_dirs` return different values than before; pass `scope: "all"` for
 * the old numbers.
 */
export function readOverview(
  reader: WireReader,
  args: WireOverviewArgs = {},
): Promise<TypedRead<WireOverviewResult>> {
  return issueRead(reader, { read: 'overview', ...args })
}

/**
 * The most-referenced files over the typed reference graph (**schema 17**, NEW —
 * promoted out of `overview`): the "start here" signal a generic search cannot
 * give, ranked `refs_structural` desc, then `refs_total` desc, then path. A file
 * with no inbound edges never appears; the `refs_structural` / `refs_navigational`
 * split is the neutral fact a consumer re-ranks by (no opaque score).
 *
 * ACTIONABILITY read: `scope` defaults to `own`, so a read-only dependency's
 * files are not noise in the default. A location pin (`repo`) flips the default
 * to `all`; an explicit `scope` always wins. Scoping happens BEFORE ranking and
 * truncation, so a large dependency cannot crowd own content out of the top-N.
 * `limit` absent = the engine's top-N (the bound `overview.hubs` carries).
 */
export function readHubs(
  reader: WireReader,
  args: WireHubsArgs = {},
): Promise<TypedRead<WireHubsResult>> {
  return issueRead(reader, { read: 'hubs', ...args })
}

/**
 * The `graph_shape` read: the scalar whole-graph summary folded from the catalog
 * + backlink index — component counts, orphan counts, degree histograms, density.
 * The "your knowledge base is N disconnected components" orientation signal, raw
 * facts with no thresholds. Mirrored by `overview.graph_shape` (with
 * `orphan_paths` off, since the unbounded path list is a drill, not a summary).
 *
 * `scope` defaults to `own`; a location pin (`repo`) flips the default to `all`,
 * an explicit `scope` always wins. `orphan_paths: true` adds the unbounded
 * `orphans.paths` list (counts are always present). Additive, no schema bump.
 */
export function readGraphShape(
  reader: WireReader,
  args: WireGraphShapeArgs = {},
): Promise<TypedRead<WireGraphShapeResult>> {
  return issueRead(reader, { read: 'graph_shape', ...args })
}

/**
 * The `link_graph` read: the full node+edge payload a whole-graph (force-directed)
 * visualization lays out — every in-scope content file (isolated ones included)
 * plus every resolved edge with both endpoints in scope. The un-ranked,
 * un-truncated sibling of `hubs`. An unbounded payload (NOT folded into
 * `overview`); keep it fresh via the `link-graph` subscription, which streams
 * node/edge deltas rather than re-shipping.
 *
 * `scope` defaults to `own`; a location pin (`repo`) flips the default to `all`,
 * an explicit `scope` always wins. Additive, no schema bump.
 */
export function readLinkGraph(
  reader: WireReader,
  args: WireLinkGraphArgs = {},
): Promise<TypedRead<WireLinkGraphResult>> {
  return issueRead(reader, { read: 'link_graph', ...args })
}

/**
 * The `type_graph` read: the SCHEMA graph as a node+edge payload — the type-side
 * sibling of `link_graph`, drawn beside it and merged by `path` (a distinct held
 * structure from the reference/wikilink graph `link_graph` folds). Nodes are the
 * in-scope type-defs (plus claiming instances when `instance-of` is requested),
 * edges the resolved type relations induced on in-scope endpoints.
 *
 * `edges` filters the relations: absent is `["subtype", "field-type"]` (the
 * type-to-type backbone), `instance-of` / `meta` opt in. `scope` defaults to
 * `own`; a `repo` pin flips it to `all`, an explicit `scope` wins. Keep it fresh
 * via the `type_graph` subscription. Additive within the schema 23 bump.
 */
export function readTypeGraph(
  reader: WireReader,
  args: WireTypeGraphArgs = {},
): Promise<TypedRead<WireTypeGraphResult>> {
  return issueRead(reader, { read: 'type_graph', ...args })
}

/**
 * The workspace's declared members, name-sorted — each with its declared name,
 * its absolute root on this machine, and whether the root is scattered outside
 * the workspace tree. The member topology straight from the engine, so a
 * consumer need not reconstruct it. `repo` narrows to that one member
 * (**schema 17**), so `readMembers(r, repo)` mirrors `overview({repo}).members`.
 * `members` honors `repo` but NOT `scope` — it is the topology field.
 */
export function readMembers(reader: WireReader, repo?: string): Promise<TypedRead<WireMembersResult>> {
  return issueRead(reader, { read: 'members', ...(repo !== undefined && { repo }) })
}

/**
 * The declared member that owns `path` (workspace-relative or absolute), by the
 * same deepest-ancestor rule reads and writes use; null when the path lies under
 * no declared member.
 */
export function readResolveMember(
  reader: WireReader,
  path: string,
): Promise<TypedRead<WireResolveMemberResult>> {
  return issueRead(reader, { read: 'resolve_member', path })
}

/**
 * The two per-user device-global engine-schema files, `repos.yaml` and
 * `workspaces.yaml` — each `{ path, exists, content, diagnostics }`, or null
 * when the device-config dir cannot resolve (no `HOME`); they live under
 * `~/.arsumbris/au-engine/config/`. These sit OUTSIDE every knowledge base, so their field-shape
 * diagnostics land here, not on the workspace `readDiagnostics`. The paired
 * writer for `repos` is the `register` mutation; `workspaces` is user-authored.
 */
export function readDeviceConfig(reader: WireReader): Promise<TypedRead<WireDeviceConfigResult>> {
  return issueRead(reader, { read: 'device_config' })
}

/**
 * One scoped-config file's per-file view (`{ path, exists, content, diagnostics }`)
 * over the scoped-config channel — the read half of the `(scope, consumer, file,
 * type)` addressing (see `WireConfigArgs`). The same per-file shape
 * `readDeviceConfig` returns, but for ONE consumer-owned file and with a NULLABLE
 * `path` (null only when the scope has no resolvable base — machine scope, `$HOME`
 * unset).
 *
 * Read OUT-OF-BAND: the file is not a walked node, so its diagnostics are
 * field-shape only and land HERE, not on `readDiagnostics`. The consumer owns
 * merge / resolution / drift across scopes; the engine never merges. Pairs with
 * the `setConfig` mutation. An unknown repo-scope `root`, or a path-unsafe /
 * reserved `consumer` / `file`, is an `{ ok: false }` error (nothing read).
 * Additive — no `schema_version` bump.
 */
export function readConfig(reader: WireReader, args: WireConfigArgs): Promise<TypedRead<WireConfigResult>> {
  return issueRead(reader, { read: 'config', ...args })
}

/**
 * A member's file-scope rules, read out-of-band from `.arsumbris/.auignore` (no
 * walk): the editable `patterns`, the seeded `default_excludes`, the
 * unconditional `floor`. `repo` scopes to one member (unknown → empty
 * `members`); `resolve: true` adds the boundary-level effect (`resolved`) per
 * member at one bounded extra walk. Pairs with the `set_ignores` mutation, which
 * edits `patterns`.
 */
export function readIgnores(
  reader: WireReader,
  args: WireIgnoresArgs = {},
): Promise<TypedRead<WireIgnoresResult>> {
  return issueRead(reader, { read: 'ignores', ...args })
}

/** The file's typed highlight-token stream, sorted by `range.start`; null when the path is not a held file. */
export function readSemanticTokens(
  reader: WireReader,
  path: string,
): Promise<TypedRead<WireSemanticTokensResult>> {
  return issueRead(reader, { read: 'semantic_tokens', path })
}

/**
 * The `lifecycle` read's typed outcome (**schema 17**, renamed from `ready`).
 * The one read that answers with a result even when not ready, so its success
 * arm is not `TypedRead`'s: `states` always carries the lifecycle, `version`
 * only once ready. The error arm is shared, so a wire error still surfaces
 * without a throw.
 */
export type TypedLifecycleProbe =
  | { ok: false; error: string }
  | { ready: boolean; version?: number; states: WireLifecycleResult }

export async function readLifecycle(reader: WireReader): Promise<TypedLifecycleProbe> {
  let response: ResponseFrame | EngineReadResult
  try {
    response = await reader.read({ read: 'lifecycle' })
  } catch (err) {
    if (err instanceof WireError) return { ok: false, error: err.message }
    throw err
  }
  if ('ok' in response && !response.ok) return { ok: false, error: response.error }
  return {
    ready: response.ready,
    version: response.version,
    // schema 17: the lifecycle states are enveloped under the read's own name.
    states: ((response.result as Record<string, unknown> | undefined)?.lifecycle ?? {}) as WireLifecycleResult,
  }
}
