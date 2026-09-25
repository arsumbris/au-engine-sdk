# Changelog

Notable changes to `@arsumbris/au-engine-sdk`.

The package stays at `0.0.0`; entries are date-grouped, newest first.
Release markers (`## 0.0.2-alpha`) group the dated entries that shipped in that
arsumbris release. Dated entries above the newest marker are not released yet.

## 0.0.2-alpha

Tracks au-engine wire schema **29** (unchanged). Breaking for consumers:

- divergent fields appear once per origin in `type_closure` / `effective_fields`.
  Key fields by `(name, origin)`.
- `PreviewMutationOp` gained `rename`, `move_dir` and `delete_dir`. An exhaustive
  `switch` over it needs the new cases.
- `untracked_files` is always present on `WireMutateResult`.
- `readInstanceCounts()` with no arguments also counts meta origins.

## 2026-09-25

### Added

- `DaemonClient.setWorkspaceMemberDisabled(name, disabled, options?)`, the
  `set_workspace_member_disabled` composition verb.
  - `true` appends `name` to `workspace.yaml`'s `disabled:` overlay, `false`
    removes it. The role lists are untouched.
  - takes `CompositionMutateOptions` (`root`, `expectedHash`), resolves
    `TypedMutate`.
  - rejects an absent `workspace.yaml`, disabling the containing repo, an
    undeclared name or an already-disabled one, and re-enabling a name not in
    `disabled:`.
  - `fixesFor` completes its `root` like the other composition verbs.
  - Additive, no `schema_version` bump.

### Changed

- The composition verbs' docs follow the engine's behaviour (no wire change).
  - `CompositionMutateOptions.root`: absent really means the served entry,
    never a sibling at its depth. Any path canonicalizing to a member root
    resolves.
  - `removeWorkspaceMember` rejects the containing repo, and removes the name
    from every list holding it, `disabled:` included.

- `runAuMembers` takes `timeoutMs?` and `signal?: AbortSignal` in
  `RunAuMembersOptions`, so a wedged `au` cannot hang the caller.
  - on either, the child is SIGKILLed and the call rejects once with
    `AuMembersError`, `exitCode: null`.
  - `AuMembersFailureKind` gains `timeout` and `aborted`, distinct from
    `unexpected`.
  - an already-aborted signal rejects `aborted` without spawning.
  - SDK-side only, no wire change.

## 2026-09-24

### Added

- `readPreviewMutation` previews the `ensure_mixins` rider.
  - the `write_file`, `edit_file`, and `rename` members of `PreviewMutationOp`
    gain `ensureMixins?` / `ensureMixinsStrict?`, the mutation's own names and
    defaults (strict defaults true).
  - `WirePreviewProduct` gains `ensure_mixins?: EnsureMixinOutcome[]`, present
    only when the op carried mixins. `target.identities` / `diagnostics`
    reflect the mixin-changed `type:` claim.
  - an un-appliable mixin under strict, or a stamp or mixin on a type-def
    target, is a `{ reject }`.
  - Additive, no `schema_version` bump.
- `runAuMembers(binaryPath, entryPath, { env? })`, root export, node-only.
  Runs `au members <entry> --json`, the daemon-less member resolution, so a
  launcher knows which declared members will mount before any daemon starts.
  - resolves with `WireAuMembersOutput`
    (`{ schema_version, entry, complete, incomplete, members, diagnostics }`),
    each member `WireAuMembersMember` (`{ name, role, tier, path?, code? }`).
    Only `tier: 'unmounted'` wants a locate.
  - rejects with `AuMembersError` (`kind`, `exitCode`, `stderr`):
    `environment` on exit `2`, `not-a-repo` on exit `5`, `unexpected` for any
    other exit, a spawn failure, or unparseable stdout.
  - rejects with `WireSchemaMismatchError` on another `schema_version`.
- `WireMember` (so the `members` read and `overview.members`) gains
  `tier: WireMountedMemberTier`, the tier that first located the member
  (`entry` / `sibling` / `registry` / `cache` / `disabled`). `WireMemberTier`
  adds `unmounted`, which only `au members` reports.
  Additive, `schema_version` stays 29.
- `WireTypeDef` (so `types` full mode, `type`, `type_batch`, `subtypes`) gains
  the inherited, resolved view. `fields` / `meta_blocks` stay the def's OWN.
  - `effective_fields: WireClosureField[]`, the fields the validator checks an
    instance against, each with its declaring `origin`.
  - `effective_meta: WireEffectiveMeta[]`, one entry per meta type IDENTITY
    (`meta_type: WireMetaTypeIdentity`, `{ name, hash, type_owners }`) with its
    surviving `blocks: WireInheritedMetaBlock[]` (a `WireMetaBlock` plus
    `from`, the declaring def). More than one block is a conflict or duplicate,
    reported whole, none picked.
  - absent on a `summary` entry.
- `WireClosureField` gains `divergent: boolean`. A divergent field is one entry
  PER ORIGIN, on `type_closure` and `effective_fields` alike, so a `name` can
  repeat: key by `(name, origin)`, never by `name` alone.
- Additive, `schema_version` stays 29.

## 2026-09-23

### Added

- The `type-claim` semantic token gains `resolved?: WireTypeIdentity`, the
  identity the claim resolves to (`name` alone, the `repo` the claim names,
  the closure `hash`). Join it onto an `instance_counts` `by_type` row by
  `(name, hash)`. Absent when the claim does not resolve. The token's `name`
  stays the authored form. Additive, `schema_version` stays 29.
- Folder verbs on `DaemonClient`, each ONE saga (one commit per git working
  tree), no riders:
  - `moveDir(path, to)`: move or rename a folder. Path-addressed referrers are
    re-pointed; a bare `[[name]]` that still resolves is left byte-identical.
    The result adds `rewrites` and `untracked_dirs`; `hash` is null.
  - `deleteDir(path)`: delete a folder, raw, nothing rewritten. The result adds
    `stranded`, `untracked_dirs`, and `last_live_commit` (only when it
    committed).
  - both need a git working tree for a folder holding files.
- `readPreviewMutation` previews `rename` (`{ op, path, to, stamps? }`),
  `move_dir` (`{ op, path, to }`), and `delete_dir` (`{ op, path }`). A folder
  op's `target` is the folder (`hash` null, `identities` empty). A preview
  rejects exactly where the verb would, as data.
- `WirePreviewProduct` gains `rewrites?` (`rename` / `move_dir`, only the
  referrers the move ACTUALLY changes), `stranded?` (`delete_dir`),
  `untracked_dirs?` (folder ops), and `untracked_files` (every op). New types
  `WireRewrite` / `WireRewriteLink` / `WireStranded` / `WireStrandedLink`.
- `WireMutateResult` gains `untracked_files: string[]`, always present: the
  absolute paths a mutation wrote, moved, or removed outside git (a git-ignored
  `.DS_Store`). Plus `rewrites?` / `stranded?` / `untracked_dirs?` for the
  folder verbs. Additive, `schema_version` stays 29.

## 2026-09-22

### Added

- `origins?` arg on `readInstanceCounts`, mirroring `readInstancesOf`'s
  `origins` (`WireInstanceOrigin[]`, `'file' | 'nested' | 'meta'`). Added as a
  third positional param — `readInstanceCounts(reader, repo?, scope?, origins?)`
  — keeping the shape consistent with its sibling `readTypeCounts`. Makes the
  read the true count-dual of `readInstancesOf`: `origins: ['file']` yields the
  file-only count that matches a file-only `instances_of` drill-in, so a
  consumer reads a per-type COUNT without fetching the rows. Additive, no
  `schema_version` bump.

### Changed

- `readInstanceCounts` default now counts ALL origins (`file` + `nested` +
  `meta`), unified with `readInstancesOf`'s no-arg set. It was `file` + `nested`
  (meta excluded). A no-arg count therefore now INCLUDES type-def `meta` blocks
  (among them the always-present `au.engine.*` builtins); pass
  `origins: ['file', 'nested']` for the former default, or `origins: ['file']`
  for the clean authored-document overview. A value-behaviour change, not a
  wire-shape change (engine did not bump either).

## 2026-09-17

### Added

- `WireShape` renderers, the SDK owning the human-facing renderers of the shape
  it owns (`./reads`, renderer-safe). Pure `(shape: WireShape) => string`, total
  over the union.
  - `shapeLabel(shape)` — a compact display annotation (`decision*`,
    `Number{>=0 & integer}`, `enum[low, moderate]`, `file*[]`). Adopted from
    au-host and made total: `pinned` / `tuple` / `compound-reference` /
    `def-reference` now render (they fell through to the bare kind name before),
    and `list` carries its real cardinality (`[+]` / `[n]` / `[x..y]`) instead of
    a flat `[]`.
  - `describeShape(shape)` — a plain-English gloss for a hover or an agent
    surface (`decision*` → "a reference to a file whose type is decision, or a
    subtype"). New.

- Machine-applicable fixes on diagnostics. Mirrors the engine's enriched `fix`
  shape (WIRE.md, the `diagnostics` read's `fix`) and ships a consumer-facing
  helper. Additive, no `schema_version` bump.
  - `WireSuggestedFix` grows an optional `actions?: WireFixAction[]` beside
    `description` (absent when empty, so an advisory-only fix is unchanged).
  - New `WireFixAction { verb, title, args? }` — `verb` names a real `mutate`
    catalog verb, `args` are keyed by that verb's own wire arg names.
  - `appliableFix(client, diag): AppliableFix[]` — turns a diagnostic's fix
    actions into runnable `{ title, apply }` entries. Branch-free: dispatches by
    verb, no per-code switch. Completes the `root` topology arg (via
    `resolve_member`) for the composition verbs; runs self-contained verbs
    (`edit_file`) as-is. Returns `[]` for an advisory-only or fixless diagnostic.
    A LIST, so a fix may offer a choice of alternatives.
  - `mutateByVerb(verb, args)` on `DaemonClient` — the raw dispatch door beneath
    the typed mutation helpers, for running an engine-authored action whose verb
    is only known at runtime. Args are wire-shaped (snake_case), un-normalized.

## 2026-09-16

### Added

- Five COMPOSITION-sort mutation verbs on `DaemonClient`, authoring an editable
  member's `.arsumbris/repo.yaml` (`deps:`) or `.arsumbris/workspace.yaml`
  (`edit:` / `discover:`). Additive, no `schema_version` bump; each rides the
  standard mutation frame.
  - `addRepoDependency(name, { remote?, ref?, root?, expectedHash? })` — add a
    `deps:` entry (does not fetch; the peer stays `peer-unmounted` until `resolve`).
  - `removeRepoDependency(name, { root?, expectedHash? })`.
  - `addWorkspaceMember(name, role, { root?, expectedHash? })` — `role` is
    `"edit"` | `"discover"`; creates `workspace.yaml` self-complete when absent.
  - `removeWorkspaceMember(name, { root?, expectedHash? })`.
  - `setWorkspaceMemberRole(name, role, { root?, expectedHash? })` — `role` is the
    target list.
  - New exported types `WorkspaceRole`, `CompositionMutateOptions`,
    `AddRepoDependencyOptions`.

## 0.0.1-alpha

The first public release. Tracks au-engine wire schema 29.
