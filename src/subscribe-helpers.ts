// Typed channel-paired subscribe helpers, per au-engine WIRE.md's
// subscription catalog. Each helper issues the right `{ subscribe: <channel> }`
// and types both the initial value (the channel's paired-read shape) and the
// change event's `scope_hint`.
//
// They run over the normalized `SubscriptionEvent` surface — the single
// `onEvent` callback `MountHost.engine.subscribe` provides. The raw
// multi-handler `DaemonClient.subscribe` is a different shape; wrap it with
// `toTypedSubscriber` to feed the same helpers.
//
// Types and pure functions only — renderer-safe (`./subscriptions` subpath).

import type { SubscribeHandlers, SubscribeRequest, SubscriptionCloseReason, SubscriptionEvent } from './wire.ts'
import type {
  WireDiagnosticsFilter,
  WireDiagnosticsResult,
  WireGraphEdge,
  WireGraphNode,
  WireLifecycleResult,
  WireLinkGraph,
  WireLinkGraphArgs,
  WireRecentCommit,
  WireRecentCommitsArgs,
  WireRecentCommitsResult,
  WireTypeGraph,
  WireTypeGraphArgs,
  WireTypeGraphEdge,
  WireTypeGraphNode,
  WireTypesResult,
} from './reads.ts'

/** The normalized subscribe surface; `MountHost['engine']` satisfies it directly. */
export interface TypedSubscriber {
  subscribe(request: SubscribeRequest, onEvent: (event: SubscriptionEvent) => void): () => void
}

/**
 * A channel's event stream, typed to that channel: a typed initial value,
 * a typed change-event `scopeHint`, and the shared `closed` end.
 * `Initial` is `never` for `changes`, the one channel with no initial value.
 */
export type TypedSubscriptionEvent<Initial, Hint> =
  | { kind: 'initial-value'; atVersion: number; result: Initial }
  | { kind: 'change'; changeKind: string; atVersion: number; scopeHint: Hint }
  | { kind: 'closed'; error?: string; reason: SubscriptionCloseReason }

// --- Per-channel scope-hint shapes (WIRE.md §change_event) ------------------

/** The `lifecycle` hint. **schema 21**: `scope` was `vault`. */
export interface LifecycleHint {
  scope: 'knowledge-base'
}
/**
 * A cross-repo type identity handle in a `types` change event: which same-named
 * type changed, scoped by its owner `repo` and pinned by its `hash`. The diff
 * keys on `(name, repo)`, so two mounted repos owning a same-named type are
 * distinct entries — a bare name could not tell them apart.
 */
export interface TypesHandle {
  name: string
  repo: string
  hash: string
}
/** The `types` change hint (**schema 23**: was the `type-graph` channel's `TypeGraphHint`). */
export interface TypesHint {
  scope: 'types'
  added: TypesHandle[]
  removed: TypesHandle[]
  changed: TypesHandle[]
}
export interface FilesHint {
  scope: 'files'
  added: string[]
  removed: string[]
}
export interface ChangesHint {
  scope: 'files'
  added: string[]
  removed: string[]
  modified: string[]
}
export interface DiagnosticsHint {
  scope: 'files'
  files: string[]
}
/**
 * The `link_graph` change hint: the node/edge delta, applied DIRECTLY (unlike the
 * re-read channels), since the payload is large. `nodes_added` are full node
 * records (a node re-emits when its record changes — kind, repo, or ref counts —
 * not only on first appearance), `nodes_removed` are paths; the edge lists are
 * full edge records and diff as a MULTISET, so preserved multiplicity carries
 * (pure add / remove). **schema 23**: `scope` was `link-graph` (the channel
 * renamed to match its `link_graph` read); the event kind stays kebab-case.
 */
export interface LinkGraphHint {
  scope: 'link_graph'
  nodes_added: WireGraphNode[]
  nodes_removed: string[]
  edges_added: WireGraphEdge[]
  edges_removed: WireGraphEdge[]
}

/**
 * The `type_graph` change hint: the schema-graph node/edge delta, applied
 * DIRECTLY like `link_graph` (the payload is large). `nodes_added` are full node
 * records, `nodes_removed` are paths.
 *
 * IMPORTANT — the edge-delta shape DIFFERS from `LinkGraphHint`, despite the
 * sibling framing. `type_graph` edges are unique per `(from, to, relation)` and
 * UPSERT: a `count` change re-emits the edge in `edges_added` ONLY, never
 * `edges_removed`. So key `edges_added` by `(from, to, relation)` and REPLACE —
 * do not blindly append, as one may for the multiset `LinkGraphHint`.
 */
export interface TypeGraphHint {
  scope: 'type_graph'
  nodes_added: WireTypeGraphNode[]
  nodes_removed: string[]
  edges_added: WireTypeGraphEdge[]
  edges_removed: WireTypeGraphEdge[]
}

/**
 * The `recent_commits` change hint, carried by the `commits-appeared` event.
 *
 * DELIBERATELY has NO `scope` discriminant, unlike every other hint above — the
 * engine's `scope_hint` here carries only `commits`, the array of newly-appeared
 * rows (the read's row shape). APPEND-ONLY: the server emits new commits, never
 * removals; the client owns its bounded window and trims its own tail. A commit
 * is emitted once, keyed by oid, so an overlap between the seed
 * (`initial-value`) and the first event is an idempotent duplicate the client
 * dedups. A new commit inserts by committer timestamp, NOT always at the head
 * (clock skew across trees can date it below an existing row).
 */
export interface RecentCommitsHint {
  commits: WireRecentCommit[]
}

/** The `files` channel's initial value: catalogued paths, absolute, sorted. */
export interface WireCataloguedFile {
  path: string
}

/** Route a normalized event to the typed callback, narrowing result and hint to the channel's shapes. */
function subscribeChannel<Initial, Hint>(
  subscriber: TypedSubscriber,
  request: SubscribeRequest,
  onEvent: (event: TypedSubscriptionEvent<Initial, Hint>) => void,
): () => void {
  return subscriber.subscribe(request, (event) => {
    if (event.kind === 'initial-value') {
      onEvent({ kind: 'initial-value', atVersion: event.atVersion, result: event.result as Initial })
    } else if (event.kind === 'change') {
      onEvent({
        kind: 'change',
        changeKind: event.changeKind,
        atVersion: event.atVersion,
        scopeHint: event.scopeHint as Hint,
      })
    } else {
      onEvent(event)
    }
  })
}

/** `lifecycle`: initial lifecycle state, then a `lifecycle-changed` event on the Deriving→Ready transition (**schema 17**, renamed from `ready` / `ready-changed`). */
export function subscribeLifecycle(
  subscriber: TypedSubscriber,
  onEvent: (event: TypedSubscriptionEvent<WireLifecycleResult, LifecycleHint>) => void,
): () => void {
  return subscribeChannel(subscriber, { subscribe: 'lifecycle' }, onEvent)
}

/**
 * `types`: the initial value is the workspace-wide owner-annotated type-def set
 * (the `readTypes()` workspace read, each entry carrying its owner `repo` and
 * `hash`), then `types-changed` events whose `scopeHint` names the
 * added/removed/changed types as `{ name, repo, hash }` identity handles (not
 * bare names), so a consumer knows which same-named cross-repo type moved.
 * **schema 23**: this channel was `type-graph`, its event `type-graph-changed`;
 * the `type-graph` name is reassigned to the new drawable `subscribeTypeGraph`.
 */
export function subscribeTypes(
  subscriber: TypedSubscriber,
  onEvent: (event: TypedSubscriptionEvent<WireTypesResult, TypesHint>) => void,
): () => void {
  return subscribeChannel(subscriber, { subscribe: 'types' }, onEvent)
}

/**
 * `files`: the catalogued path set, then `files-changed` with the path delta.
 * **schema 21**: the channel was `vault.files` and the event `vault-files-changed`.
 */
export function subscribeFiles(
  subscriber: TypedSubscriber,
  onEvent: (event: TypedSubscriptionEvent<WireCataloguedFile[], FilesHint>) => void,
): () => void {
  return subscribeChannel(subscriber, { subscribe: 'files' }, onEvent)
}

/**
 * `changes`: no initial value; `knowledge-base-changed` carries the net
 * added/removed/modified delta. **schema 21**: the event was `vault-changed`.
 */
export function subscribeChanges(
  subscriber: TypedSubscriber,
  onEvent: (event: TypedSubscriptionEvent<never, ChangesHint>) => void,
): () => void {
  return subscribeChannel(subscriber, { subscribe: 'changes' }, onEvent)
}

/** `diagnostics`: the in-scope diagnostics, then `diagnostics-changed` naming the changed files. */
export function subscribeDiagnostics(
  subscriber: TypedSubscriber,
  onEvent: (event: TypedSubscriptionEvent<WireDiagnosticsResult, DiagnosticsHint>) => void,
  filter?: WireDiagnosticsFilter,
): () => void {
  return subscribeChannel(subscriber, { subscribe: 'diagnostics', ...filter }, onEvent)
}

/**
 * `link_graph`: the initial value is the full `link_graph` payload at the
 * subscribe version, then `link-graph-changed` events whose `scopeHint` carries
 * the node/edge delta (`LinkGraphHint`). A consumer applies the delta directly to
 * an interactive force-directed layout rather than re-reading — the payload is
 * large. A rebuild that leaves the in-scope graph unchanged does not fire. Takes
 * the same optional `repo` / `scope` args as the `link_graph` read. **schema 23**:
 * the channel was `link-graph`; the event kind `link-graph-changed` stays kebab.
 */
export function subscribeLinkGraph(
  subscriber: TypedSubscriber,
  onEvent: (event: TypedSubscriptionEvent<WireLinkGraph, LinkGraphHint>) => void,
  args?: WireLinkGraphArgs,
): () => void {
  return subscribeChannel(subscriber, { subscribe: 'link_graph', ...args }, onEvent)
}

/**
 * `type_graph`: the initial value is the full `type_graph` payload at the
 * subscribe version, then `type-graph-changed` events whose `scopeHint` carries
 * the schema-graph node/edge delta (`TypeGraphHint`). The type-side sibling of the
 * `link_graph` subscription — a consumer applies the delta directly rather than
 * re-reading. A rebuild that leaves the in-scope type graph unchanged does not
 * fire. Takes the same optional `repo` / `scope` / `edges` args as the
 * `type_graph` read. **schema 23**: `type-graph-changed` is reassigned here from
 * the old introspection stream, now `subscribeTypes` / `types-changed`.
 *
 * The edge-delta UPSERTs per `(from, to, relation)` — see `TypeGraphHint`.
 */
export function subscribeTypeGraph(
  subscriber: TypedSubscriber,
  onEvent: (event: TypedSubscriptionEvent<WireTypeGraph, TypeGraphHint>) => void,
  args?: WireTypeGraphArgs,
): () => void {
  return subscribeChannel(subscriber, { subscribe: 'type_graph', ...args }, onEvent)
}

/**
 * `recent_commits`: the initial value is the seed page (the `recent_commits`
 * read's row array) at the subscribe version, then `commits-appeared` events
 * whose `scopeHint` carries `commits`, the newly-appeared rows
 * ({@link RecentCommitsHint}). The live half of the cross-repo git ACTIVITY
 * view. Takes the same optional `members` / `limit` / `since` args as the
 * `recent_commits` read.
 *
 * LIVENESS IS THE REFLOG WATCHER, NOT THE VERSION SIGNAL — an out-of-band
 * terminal commit (advancing no knowledge-base version) surfaces live, exactly
 * what a version-driven channel misses. APPEND-ONLY: apply each event by oid,
 * dedup the seed/first-event overlap, and trim your own bounded window; the
 * server never emits removals. `atVersion` on an event is the held
 * knowledge-base version at emit, a monotonic stamp, NOT a git coherence cursor.
 * A history rewrite (`reset` / `amend` / `rebase`) is OUT OF SCOPE, not a delta
 * this channel models. See {@link readRecentCommits}.
 */
export function subscribeRecentCommits(
  subscriber: TypedSubscriber,
  onEvent: (event: TypedSubscriptionEvent<WireRecentCommitsResult, RecentCommitsHint>) => void,
  args?: WireRecentCommitsArgs,
): () => void {
  return subscribeChannel(subscriber, { subscribe: 'recent_commits', ...args }, onEvent)
}

/** The raw multi-handler subscribe surface; `DaemonClient` satisfies it. */
export interface RawFrameSubscriber {
  subscribe(request: SubscribeRequest, handlers: SubscribeHandlers): () => void
}

/**
 * Adapt a raw-frame subscriber (a `DaemonClient`) to the normalized
 * `TypedSubscriber` surface, so client-side consumers feed the same channel
 * helpers a host-mounted projection does. Normalizes snake_case frames to the
 * camelCase event shape; a rejected ack and a dead connection both end as
 * `closed`, distinguished by its `reason`.
 */
export function toTypedSubscriber(raw: RawFrameSubscriber): TypedSubscriber {
  return {
    subscribe(request, onEvent) {
      return raw.subscribe(request, {
        onInitialValue: (frame) =>
          onEvent({ kind: 'initial-value', atVersion: frame.at_version, result: frame.result }),
        onChangeEvent: (frame) =>
          onEvent({
            kind: 'change',
            changeKind: frame.kind,
            atVersion: frame.at_version,
            scopeHint: frame.scope_hint,
          }),
        onClose: (error, reason) => onEvent({ kind: 'closed', error, reason }),
      })
    },
  }
}
