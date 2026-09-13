// Wire frames per au-engine `crates/au-engine/WIRE.md` (schema_version 29).
//
// The engine is the source of truth for this shape.
// Frames carry snake_case as on the wire; consumers normalize at their edge.
// Unknown fields, frame types, and enum values must be ignored (additive evolution).

/**
 * The wire schema version this SDK mirrors. Every daemon frame carries its
 * own; the engine bumps it on removals, renames, and type changes —
 * additive evolution (new fields, new frame types) does not.
 */
export const WIRE_SCHEMA_VERSION = 29

/**
 * A daemon error frame surfaced as a thrown value: the request named no
 * known read or subscription, or failed to parse. Distinct from a transport
 * failure (socket death, closed client) — the connection stays usable, so
 * the typed read helpers convert this into a read outcome rather than
 * letting it propagate. Renderer-safe: a plain Error subclass.
 */
export class WireError extends Error {
  readonly name = 'WireError'
  /**
   * The error frame's optional `detail`: machine-usable context the daemon
   * attaches to a rejection (e.g. `current_hash` on a `mutate: write_file`
   * staleness conflict, `occurrences` on a non-unique `edit_file`). Absent for
   * errors that carry none. Explicit field + assignment, not a parameter
   * property — node's strip-only type stripping rejects those.
   */
  readonly detail?: unknown
  constructor(message: string, detail?: unknown) {
    super(message)
    this.detail = detail
  }
}

/**
 * The human-facing wording for a wire schema mismatch. Names both versions
 * and which side to update — written for a consumer's UI, not just logs.
 * Shared by the explicit `checkSchemaVersion` probe and the client's automatic
 * per-frame guard, so the two never drift.
 */
export function schemaMismatchMessage(actual: number, expected: number = WIRE_SCHEMA_VERSION): string {
  return (
    `wire schema mismatch: the daemon speaks schema_version ${actual}, ` +
    `this consumer expects ${expected} — ` +
    (actual > expected
      ? 'update the consumer (or its SDK) to the daemon’s wire'
      : 'update the daemon to the consumer’s wire')
  )
}

/**
 * A wire schema mismatch detected on a live frame: the daemon speaks a
 * different `schema_version` than this SDK mirrors. Unlike `WireError` (a
 * per-request failure the connection survives), this is fatal to the
 * connection — the client fails its pending work and closes, because a
 * half-spoken protocol must not keep settling reads. Carries both versions so
 * a consumer can render them; reconnecting to the same daemon will mismatch
 * again, so a consumer should not blindly retry on this. Renderer-safe.
 */
export class WireSchemaMismatchError extends Error {
  readonly name = 'WireSchemaMismatchError'
  // Explicit fields + constructor assignment rather than parameter properties:
  // the SDK is consumed as TS source, and node's strip-only type stripping
  // (the documented plain-node path) rejects parameter properties.
  readonly actual: number
  readonly expected: number
  constructor(actual: number, expected: number = WIRE_SCHEMA_VERSION) {
    super(schemaMismatchMessage(actual, expected))
    this.actual = actual
    this.expected = expected
  }
}

/** A read request: names a capability, arguments are sibling keys. */
export type ReadRequest = { read: string } & Record<string, unknown>

/** A subscribe request: names a channel, arguments are sibling keys. */
export type SubscribeRequest = { subscribe: string } & Record<string, unknown>

export interface FrameBase {
  type: string
  schema_version: number
}

/**
 * The correlation id echoed on a request's direct reply (`response`, `ack`,
 * `error`). The client sets a unique id per request and settles replies by
 * it, not by arrival order. Post-ack subscription frames carry only
 * `subscription_id`; the client maps the two through the ack. The SDK always
 * sends one, so it is present on every reply to an SDK request.
 */
type CorrelationId = number

interface ResponseFrameReady extends FrameBase {
  type: 'response'
  ready: true
  /** Guaranteed once ready: the version the result was observed at. */
  version: number
  result?: unknown
  id?: CorrelationId
}

interface ResponseFramePending extends FrameBase {
  type: 'response'
  ready: false
  /** Absent for a plain pending read; the `lifecycle` read still answers with its result while pending. */
  version?: number
  result?: unknown
  id?: CorrelationId
}

/**
 * Reply to a read. Discriminated on `ready`: once ready, `version` is
 * present; the `lifecycle` read is the one channel that also carries `result`
 * while still pending.
 */
export type ResponseFrame = ResponseFrameReady | ResponseFramePending

/**
 * Reply to a subscribe, delivered immediately. `accepted` is always true: an
 * ack means the subscribe was accepted. A refused subscribe (unknown channel,
 * bad args) is an `error` frame with `for: 'subscribe'`, not an ack.
 */
export interface AckFrame extends FrameBase {
  type: 'ack'
  subscription_id: number
  channel: string
  accepted: boolean
  id?: CorrelationId
}

/** A channel's current state, delivered once after the ack (channels with none skip it). */
export interface InitialValueFrame extends FrameBase {
  type: 'initial_value'
  subscription_id: number
  at_version: number
  result: unknown
}

/** Notification that a subscribed channel changed. Carries no new state; re-query the paired read. */
export interface ChangeEventFrame extends FrameBase {
  type: 'change_event'
  subscription_id: number
  kind: string
  at_version: number
  scope_hint?: unknown
}

/** A resolved member in a `resolved` frame's `resolved` list. */
export interface ResolvedMember {
  /** The declared dependency name. */
  name: string
  /** The immutable snapshot sha the member locked to. */
  sha: string
  /** The git remote it resolved from. */
  remote: string
  /** The monorepo subpath; null for a repo-root package. */
  path: string | null
}

/**
 * A member that could not be delivered, in a `resolved` frame's `failed` list.
 * A non-empty `failed` means resolve was partial (per-repo independent — the
 * rest still locked and mounted).
 */
export interface ResolvedFailure {
  /** The declared dependency name. */
  name: string
  /** The human-readable delivery failure. */
  reason: string
  /** The failure code, `dependency-resolution-failed`. */
  code: string
}

/**
 * Reply to a `resolve` — the package-manager verb. Resolves the served
 * workspace's declared dependency closure into the device-global package cache,
 * writes + commits the package lock under `.arsumbris/`, and rebuilds. It echoes
 * the request's `id` (stamped at the dispatch layer), so the client settles it
 * by id. A resolve with no closure to resolve (a manifest-less tree-mode
 * workspace) is an `error` frame with `for: 'resolve'`, not this; resolving
 * while Deriving answers a not-ready `response`, like a read.
 */
export interface ResolvedFrame extends FrameBase {
  type: 'resolved'
  /** The resolved members, each locked to an immutable snapshot. */
  resolved: ResolvedMember[]
  /** Members that could not be delivered. Empty in the common case. */
  failed: ResolvedFailure[]
  /**
   * One message per package required at conflicting versions across the closure.
   * A conflicted package resolves to no single version, so it is excluded from
   * the lock and left unmounted (the engine never picks a winner). Empty in the
   * common case; non-empty means a conflicted package must be aligned.
   */
  conflicts: string[]
  /**
   * The lock commits, `{ [repo]: sha }`, one entry per editable repo whose own
   * `.arsumbris/repo.lock` committed this resolve — the dependency lock moved
   * per-repo (`schema 10`, replacing the former single `commit` scalar). One
   * `Mutation-Id` correlates the whole set. `{}` when nothing resolved, no repo
   * is a git tree, or every lock was unchanged (the idempotent no-op). Same
   * shape as the mutate frame's `commits`.
   */
  commits: Record<string, string>
  /**
   * Per-repo git errors from the lock commits, `{ [repo]: message }`, one entry
   * per repo whose lock commit failed (`schema 10`, replacing the former single
   * `commit_error` scalar). A present entry means that repo's lock is on disk
   * but uncommitted (soft-inconsistent). `{}` in the common case.
   */
  commit_errors: Record<string, string>
  /** The post-resolve knowledge-base version. */
  version: number
  id?: CorrelationId
}

/**
 * Reply to a successful `register` mutation — write/update one repo entry in
 * the per-user registry (`~/.arsumbris/au-engine/config/repos.yaml`), then rebuild so a
 * newly-locatable member mounts. Unlike a graph mutation, `register` is a
 * CONFIG-sort mutation over a DEVICE-GLOBAL file (outside every repo), so it
 * answers this distinct frame rather than the standard `response` envelope, and
 * there is no git commit. Like a mutation reply it echoes the request's `id`
 * (the daemon stamps it at the dispatch layer), so the client settles it by id.
 * A rejected register (invalid name, a `dependency-identity-conflict`, an
 * unreadable `repo.yaml`, no per-user config dir) is an `error` frame the
 * connection survives, not this.
 */
export interface RegisteredFrame extends FrameBase {
  type: 'registered'
  /** Echoed: the registered repo name. */
  name: string
  /** Echoed, absolute: the local path recorded for the repo. */
  path: string
  /** The post-rebuild held knowledge-base version. */
  version: number
  id?: CorrelationId
}

/**
 * A request frame that named no known read or subscription, or failed to
 * parse. Self-routing: `for` names the request shape it answers, so a client
 * routes it even when it sent no `id`. A refused subscribe arrives here with
 * `for: 'subscribe'`, not as an `ack`.
 */
export interface ErrorFrame extends FrameBase {
  type: 'error'
  error: string
  /**
   * Machine-usable context on a rejection, primitive-specific. A `mutate`
   * reject carries it (e.g. `{ current_hash }` on a `write_file` staleness
   * conflict, `{ occurrences }` on a non-unique `edit_file`); most errors omit
   * it. Stays an opaque `unknown` — the engine's catalog grows additively.
   */
  detail?: unknown
  for?: 'read' | 'subscribe' | 'mutate' | 'resolve' | 'unknown'
  id?: CorrelationId
}

export type Frame =
  | ResponseFrame
  | AckFrame
  | InitialValueFrame
  | ChangeEventFrame
  | ResolvedFrame
  | RegisteredFrame
  | ErrorFrame

/**
 * Why a subscription ended, and whether retrying could ever help.
 * - `rejected` — the channel refused this subscribe (unknown channel, bad
 *   args; an `error` frame). The connection is fine, but this subscribe never
 *   will be — retrying it cannot fix it. Permanent.
 * - `transient` — the connection died (daemon restart, socket drop). A
 *   reconnect and resubscribe may succeed.
 * - `fatal` — the connection died unrecoverably (a wire schema mismatch).
 *   Reconnecting hits the same daemon and fails the same way, so retrying is
 *   futile. The fix is operational (restart the daemon), not a retry.
 */
export type SubscriptionCloseReason = 'rejected' | 'transient' | 'fatal'

/**
 * Per-subscription frame callbacks. A pure type over the wire frames, so it
 * lives here (renderer-safe) rather than beside the node client — the typed
 * subscribe helpers reference it without dragging in node code.
 */
export interface SubscribeHandlers {
  onAck?: (frame: AckFrame) => void
  onInitialValue?: (frame: InitialValueFrame) => void
  onChangeEvent?: (frame: ChangeEventFrame) => void
  /**
   * The subscription is over. `reason` classifies the end and whether a retry
   * could help — see `SubscriptionCloseReason`. Always supplied (the producer
   * knows which case it is): `rejected` and `fatal` are permanent, `transient`
   * is worth a reconnect.
   */
  onClose?: (error: string, reason: SubscriptionCloseReason) => void
}

/** Result of the `lifecycle` read (**schema 17**, renamed from `ready`). */
export interface LifecycleResult {
  engine?: string
  ref?: string
}

/**
 * The client's normalized view of a reachable daemon's readiness probe. Named
 * for the frame's `ready` FLAG (which the wire keeps), not the read — `probeReady`
 * issues the `lifecycle` read and reports its `ready` / `refState`.
 */
export interface ReadyProbe {
  ready: boolean
  version?: number
  engine?: string
  refState?: string
}

// --- Host-served engine edges ----------------------------------------------
// The mount host serves these normalized shapes; the typed read and subscribe
// helpers consume them over either transport. DOM-free, so they live here in
// the renderer- and node-safe wire layer rather than in `./mount` (which
// carries the projection entry's `HTMLElement`).

/**
 * The outcome of an engine read served by the host. Mirrors `ResponseFrame`:
 * once ready, `version` is guaranteed; the `lifecycle` read still carries
 * `result` while pending.
 */
export type EngineReadResult =
  | { ok: true; ready: true; version: number; result?: unknown }
  | { ok: true; ready: false; version?: number; result?: unknown }
  | { ok: false; error: string }

/**
 * A subscription event served by the host, normalized from the wire frames.
 * `closed` ends the subscription; `reason` says why and whether a retry could
 * help (see `SubscriptionCloseReason`). A host teardown is `transient`.
 */
export type SubscriptionEvent =
  | { kind: 'initial-value'; atVersion: number; result: unknown }
  | { kind: 'change'; changeKind: string; atVersion: number; scopeHint?: unknown }
  | { kind: 'closed'; error?: string; reason: SubscriptionCloseReason }
