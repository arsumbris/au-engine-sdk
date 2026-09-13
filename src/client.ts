// Daemon client over the Unix socket. Main-process only (uses node:net).
//
// Framing per WIRE.md: each message is a 4-byte big-endian length prefix,
// then that many bytes of JSON. One connection serves many round trips.
// Each request carries a unique correlation `id`; the daemon echoes it on the
// direct reply (response/ack/error), so the client settles replies by id, not
// by arrival order. Post-ack subscription frames route by `subscription_id`.

import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

import { contentHash } from './content-hash.ts'
import { encodeFrame, FrameDecoder } from './frame.ts'
import type { WireConfigArgs, WireMutateResult } from './reads.ts'
import { toWireStamps, type Stamp } from './stamps.ts'
import { toWireEnsureMixins } from './ensure-mixins.ts'
import { toWireAttribution, type AttributionEntry } from './attribution.ts'
import { WireError, WireSchemaMismatchError, WIRE_SCHEMA_VERSION } from './wire.ts'
import type {
  AckFrame,
  ErrorFrame,
  Frame,
  ReadRequest,
  ReadyProbe,
  LifecycleResult,
  RegisteredFrame,
  ResolvedFrame,
  ResponseFrame,
  SubscribeHandlers,
  SubscribeRequest,
  SubscriptionCloseReason,
} from './wire.ts'

/**
 * A `resolve`'s typed outcome, mirroring a read's three arms:
 * - `{ ok: false }` — the daemon rejected it (a manifest-less tree-mode
 *   workspace, with no declared closure to resolve): a wire error frame, the
 *   connection survives.
 * - `{ ready: false }` — the ref is still Deriving; retry once ready.
 * - `{ ready: true; result }` — the `resolved` frame (the resolved members plus
 *   any `failed` / `conflicts`, and the lock commit).
 * A transport failure (socket death, closed client) throws instead, as for a read.
 */
export type TypedResolve =
  | { ok: false; error: string }
  | { ready: false }
  | { ready: true; result: ResolvedFrame }

/**
 * A `mutate`'s typed outcome, mirroring a read's three arms:
 * - `{ ok: false }` — the daemon rejected it (bad args, path escape, hash
 *   mismatch): a wire error frame, the connection survives. `detail` carries
 *   the reject's machine-usable context when present (`current_hash` on a
 *   staleness conflict, `occurrences` on a non-unique edit).
 * - `{ ready: false }` — the engine is still Deriving; retry once ready.
 * - `{ ready: true; version; result }` — the write landed. The reply rides the
 *   read-response envelope, so `version` (the post-mutation knowledge-base version, the
 *   originator's echo-suppression key) and the `result` object both surface.
 * A transport failure (socket death, closed client) throws instead, as for a read.
 */
export type TypedMutate =
  | { ok: false; error: string; detail?: unknown }
  | { ready: false }
  | { ready: true; version: number; result: WireMutateResult }

/**
 * A `register`'s typed outcome. Unlike a graph mutation, `register` answers a
 * distinct `registered` frame and has no Deriving arm (the engine rebuilds
 * synchronously before replying), so there are only two arms:
 * - `{ ok: false }` — the daemon rejected it (an invalid repo name, a
 *   `dependency-identity-conflict`, an unreadable / absent `repo.yaml`, no
 *   per-user config dir): a wire error frame, the connection survives.
 * - `{ ok: true; result }` — the `registered` frame (the echoed `name` / `path`
 *   and the post-rebuild `version`).
 * A transport failure (socket death, closed client) throws instead, as for a read.
 */
export type TypedRegister = { ok: false; error: string } | { ok: true; result: RegisteredFrame }

/** Options for `writeFile`. */
export interface WriteFileOptions {
  /**
   * The read-before-write guard: the hash of the content the caller last read
   * (a prior read's or mutate's `hash`). A mismatch rejects without writing,
   * with `detail.current_hash`. Absent means overwrite-regardless; a new file
   * needs none.
   */
  expectedHash?: string
  /** The optional `stamps` write rider (see `Stamp`), all folded into this write's commit. */
  stamps?: Stamp[]
  /**
   * The optional `ensure_mixins` write rider (schema 25): a list of
   * `::repo`-qualified type names (e.g. `"provenance::au-provenance"`) the engine
   * idempotently ensures on the written file's `type:` claim, folded into this
   * write's own commit. Absent or empty is no mixin. See `EnsureMixinOutcome` for
   * the per-mixin response report.
   */
  ensureMixins?: string[]
  /**
   * Whether an UN-APPLIABLE mixin rejects the whole write (STRICT, default true)
   * or is silently skipped so the write lands (LENIENT, false). Ignored when
   * `ensureMixins` is absent or empty. Omitted here so the engine applies its own
   * default (true).
   */
  ensureMixinsStrict?: boolean
  /**
   * The optional `attribution` write rider (schema 26): a list of `{ key, value }`
   * trailers folded into this write's commit beside `Mutation-Id`, verbatim and
   * uninterpreted, read back by `commit_meta`'s `trailers`. Absent or empty writes
   * no trailer. A malformed or reserved-colliding key rejects the whole write. See
   * `AttributionEntry`.
   */
  attribution?: AttributionEntry[]
}

/**
 * The record locator for `promote`: exactly one of `at` (a byte offset inside
 * the record, for a record with no `^:` id) or `blockId` (the record's `^:` id,
 * the stable handle for one that has it). The union enforces the wire's
 * exactly-one rule — both supplied, or neither, rejects.
 */
export type PromoteLocator = { at: number } | { blockId: string }

/** Options for `editFile`. */
export interface EditFileOptions {
  /**
   * Lift the uniqueness requirement and replace every occurrence. Default
   * false: `oldString` must match exactly once (the match is its own
   * read-before-write precondition), and a non-unique match rejects with
   * `detail.occurrences`.
   */
  replaceAll?: boolean
  /** The optional `stamps` write rider (see `Stamp`), all folded into this write's commit. */
  stamps?: Stamp[]
  /**
   * The optional `ensure_mixins` write rider (schema 25): `::repo`-qualified type
   * names ensured on the edited file's `type:` claim, folded into this write's own
   * commit. See `WriteFileOptions.ensureMixins`.
   */
  ensureMixins?: string[]
  /**
   * STRICT (default true) rejects the write on an un-appliable mixin; LENIENT
   * (false) skips it. Ignored without `ensureMixins`. See
   * `WriteFileOptions.ensureMixinsStrict`.
   */
  ensureMixinsStrict?: boolean
  /**
   * The optional `attribution` write rider (schema 26): `{ key, value }` trailers
   * folded into this edit's commit. See `WriteFileOptions.attribution`.
   */
  attribution?: AttributionEntry[]
}

/**
 * Options for `deleteFile`. `delete_file` carries neither `stamps` nor
 * `ensure_mixins` (there is no surviving file to stamp or mix in), so its only
 * riders are the read-before-write guard and `attribution`.
 */
export interface DeleteFileOptions {
  /**
   * The read-before-write guard: the hash of the content the caller last read. A
   * mismatch rejects without deleting, with `detail.current_hash`. Absent means
   * delete-regardless.
   */
  expectedHash?: string
  /**
   * The optional `attribution` write rider (schema 26): `{ key, value }` trailers
   * folded into the deletion commit, read back by `commit_meta`'s `trailers` on
   * that commit. See `WriteFileOptions.attribution`.
   */
  attribution?: AttributionEntry[]
}

/**
 * Options for `rename`. Both write riders fold into the rename's OWN commit onto
 * the destination `to` (the verb's primary file).
 */
export interface RenameOptions {
  /** The optional `stamps` write rider (see `Stamp`), folded onto the destination `to`. */
  stamps?: Stamp[]
  /**
   * The optional `ensure_mixins` write rider (schema 25): `::repo`-qualified type
   * names ensured on the destination `to`'s `type:` claim, folded into the
   * rename's own commit. See `WriteFileOptions.ensureMixins`.
   */
  ensureMixins?: string[]
  /**
   * STRICT (default true) rejects the write on an un-appliable mixin; LENIENT
   * (false) skips it. Ignored without `ensureMixins`. See
   * `WriteFileOptions.ensureMixinsStrict`.
   */
  ensureMixinsStrict?: boolean
}

/** Shared options for the nested-record mutation verbs `editRecord` / `appendRecord`. */
export interface RecordMutateOptions {
  /**
   * The read-before-write guard, the same CAS `writeFile` / `deleteFile` use:
   * the hash of the content the caller last read. A mismatch rejects without
   * writing, with `detail.current_hash`. Absent means no guard.
   */
  expectedHash?: string
  /**
   * How the engine treats a change that RAISES the file's validation-error
   * count. `advise` (the engine default when omitted) lands the write and
   * surfaces the record's diagnostics; `reject` refuses on a raised error count,
   * writing nothing, the reject naming the new codes. A pre-existing error never
   * blocks either way. Omitted here so the engine applies its own default.
   */
  onInvalid?: 'advise' | 'reject'
  /** The optional `stamps` write rider (see `Stamp`), all folded into this write's commit. */
  stamps?: Stamp[]
}

/**
 * The write body of a `setConfig` mutation — EXACTLY ONE of `content` / `edit`,
 * modeled as a discriminated union so the caller cannot pass both or neither.
 * - `{ content }` — the whole file to write. Creates an absent file.
 * - `{ edit }` — one keyed-record splice over the EXISTING file (reusing
 *   `editRecord`'s byte-splice core, so comments, key order, and sibling records
 *   survive). `fieldPath` locates the record (empty `[]` = the file's top-level
 *   record); `patch` is a shallow field-to-scalar map (`type` re-types the record,
 *   a `^` key is rejected). Editing an ABSENT file rejects — create it with
 *   `content` first. No `onInvalid` gate: a config write is advisory (never
 *   refused on a field-shape verdict), though the splice's own structural check
 *   still rejects a change that would break the YAML.
 */
export type SetConfigBody =
  | { content: string }
  | { edit: { fieldPath: Array<string | number>; patch: Record<string, unknown> } }

/** Options for the `setConfig` mutation, beside its `WireConfigArgs` addressing and `SetConfigBody`. */
export interface SetConfigOptions {
  /**
   * Optional compare-and-set against the current file's content hash (a prior
   * `config` read's / `setConfig` write's `hash`). A mismatch — or an absent file
   * — REJECTS, nothing written. Absent means no guard.
   */
  expectedHash?: string
}

/**
 * The daemon's socket file name for an entry, `<hash>.sock`, mirroring
 * `au_engine::socket_file_name` (`serve.rs`). `<hash>` is the FNV-1a-64 of the
 * entry path's bytes, 16 lowercase zero-padded hex digits — the same algorithm
 * the engine blesses as the content hash, so the derivation reuses the canonical
 * `contentHash` mirror. The caller passes an already-canonicalized absolute path;
 * `socketPath` does the canonicalization.
 */
export function socketFileName(entry: string): string {
  return `${contentHash(Buffer.from(entry, 'utf8'))}.sock`
}

/**
 * The blessed category set of the `.arsumbris` layout, engine-owned.
 * A namespaced path is
 * `<owner>/<category>/...`; only `config/` carries substrate semantics, the rest
 * are owner convention. This is the SINGLE definition — the `AuDeviceCategory`
 * type and the custom-builder collision guard both derive from it, so a category
 * added to the spec is added in exactly one place here.
 */
export const AU_CATEGORIES = ['config', 'cache', 'logs', 'run', 'data'] as const

/**
 * A blessed `.arsumbris` category (`config` | `cache` | `logs` | `run` | `data`).
 * The typed door makes "only `config/` carries substrate semantics" visible in
 * the type — a caller cannot stringly-type a blessed name. Free-form `<other>/`
 * categories go through the `*Custom` builders instead.
 */
export type AuCategory = (typeof AU_CATEGORIES)[number]

/**
 * A single path segment guard: non-empty, no separator, not `.`/`..`. Stops a
 * caller injecting `../` or a nested path into an `<owner>`/`<category>` segment.
 */
function assertSegment(kind: string, value: string): void {
  if (value.length === 0) throw new Error(`au path builder: ${kind} must be non-empty`)
  if (value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
    throw new Error(
      `au path builder: ${kind} "${value}" must be a single path segment (no separators, not "." or "..")`,
    )
  }
}

/** Reject a blessed name from a `*Custom` builder, steering it to the typed door. */
function assertCustomCategory(category: string): void {
  if ((AU_CATEGORIES as readonly string[]).includes(category)) {
    throw new Error(
      `au path builder: "${category}" is a blessed category — use auDeviceDir/auRepoDir (the typed door), not the custom builder`,
    )
  }
}

/**
 * The SINGLE join site for the `<base>/.arsumbris/<owner>/<category>` layout.
 * Every device and in-repo builder routes here, so the `.arsumbris` literal and
 * the segment order live in exactly one place — the drift the layout port just
 * had to chase across every repo cannot recur.
 */
function ownerCategoryDir(base: string, owner: string, category: string): string {
  assertSegment('owner', owner)
  assertSegment('category', category)
  return path.join(base, '.arsumbris', owner, category)
}

/** Raw `$HOME` chain (temp dir when unset), NOT canonicalized — matches the daemon's bind side. */
function deviceBase(home?: string): string {
  return home ?? process.env.HOME ?? os.tmpdir()
}

/**
 * A DEVICE-root directory in the `.arsumbris` convention:
 * `$HOME/.arsumbris/<owner>/<category>`, for a blessed `category`.
 *
 * `owner` is the WRITING tenant's repo name (`au-engine`, `au-host`,
 * ...), never the containing repo. Follows RAW `$HOME` (temp dir when unset),
 * NOT canonicalized, so a consumer-derived path agrees byte-for-byte with what
 * the daemon binds and other tenants read. `home` overrides the base for a
 * consumer that threads its own per-call home (e.g. a test under a temp home
 * without mutating `process.env.HOME`).
 *
 * The convention is engine-owned; this
 * SDK is its single derivation home. Free-form `<other>/` categories go through
 * `auDeviceDirCustom`.
 */
export function auDeviceDir(owner: string, category: AuCategory, home?: string): string {
  return ownerCategoryDir(deviceBase(home), owner, category)
}

/**
 * `auDeviceDir` for a free-form `<other>/` category: a device-root
 * `$HOME/.arsumbris/<owner>/<category>` where `category` is any single segment
 * OUTSIDE the blessed set. Throws on a blessed name, so the blessed categories
 * have exactly one door (the typed `auDeviceDir`) and `<other>/` categories have
 * exactly one door (this). No overlap.
 */
export function auDeviceDirCustom(owner: string, category: string, home?: string): string {
  assertCustomCategory(category)
  return ownerCategoryDir(deviceBase(home), owner, category)
}

/**
 * An IN-REPO directory in the `.arsumbris` convention:
 * `<repoRoot>/.arsumbris/<owner>/<category>`, for a blessed `category`. The base
 * is the repo root, not `$HOME`, and is joined as-given (not canonicalized),
 * matching the raw-path rule of the device builders.
 *
 * Covers the `<owner>/<category>` sublayer only — e.g.
 * `<repo>/.arsumbris/au-engine/logs/trace/`,
 * `<repo>/.arsumbris/au-engine/run/saga.intent`. The foundational top-level
 * files (`repo.yaml`, the locks, `.auignore`) are NOT this builder's concern.
 */
export function auRepoDir(repoRoot: string, owner: string, category: AuCategory): string {
  return ownerCategoryDir(repoRoot, owner, category)
}

/** `auRepoDir` for a free-form `<other>/` category. Throws on a blessed name, as `auDeviceDirCustom` does. */
export function auRepoDirCustom(repoRoot: string, owner: string, category: string): string {
  assertCustomCategory(category)
  return ownerCategoryDir(repoRoot, owner, category)
}

/**
 * The daemon's socket DIRECTORY, `$HOME/.arsumbris/au-engine/run`, mirroring the
 * dir segment of `au_engine::socket_path`. A thin alias for
 * `auDeviceDir('au-engine', 'run', home)`, so `socketPath` and
 * `socketPathForHash` build on the one convention primitive and the `.arsumbris`
 * literal has a single site.
 *
 * Follows RAW `$HOME` (temp dir when unset), NOT canonicalized — the daemon
 * binds off raw `$HOME` too, so both sides agree. A consumer holding only a
 * `<hash>` reaches the same directory here without re-hardcoding the segment.
 * `home` overrides the base as on `auDeviceDir`.
 */
export function engineSocketDir(home?: string): string {
  return auDeviceDir('au-engine', 'run', home)
}

/**
 * The daemon's socket path for a `<hash>` (the entry-path hash, WITHOUT the
 * `.sock` suffix), `${engineSocketDir(home)}/<hash>.sock`. The hash-keyed door
 * onto the same path `socketPath` builds, for a consumer that holds only the
 * hash and never the entry (e.g. sweeping sibling workspaces named by hash
 * alone).
 *
 * `hash` is the 16-hex-digit string `socketFileName` embeds; this just appends
 * `.sock` and joins onto `engineSocketDir(home)`, so it inherits the raw-`$HOME`
 * rule and never re-derives the directory. `home` overrides the base the same
 * way `engineSocketDir` does.
 */
export function socketPathForHash(hash: string, home?: string): string {
  return path.join(engineSocketDir(home), `${hash}.sock`)
}

/**
 * The daemon's socket path for an entry point, mirroring
 * `au_engine::socket_path`: `$HOME/.arsumbris/au-engine/run/<hash>.sock`, OUTSIDE the
 * entry repo (a deep entry path can no longer overrun the Unix-socket `sun_path`
 * limit — the SUN_LEN fix).
 *
 * `entry` is the path the engine was pointed at: a folder-repo DIRECTORY (a
 * directory carrying `.arsumbris/repo.yaml`, **schema 16**), the entry the
 * daemon self-homes on. Each entry point derives its own socket, so distinct
 * folder-repos never collide. The former `*.au-workspace.yaml` file entry is
 * dropped; a folder entry hashes unchanged (realpath + FNV-1a-64).
 *
 * Both sides MUST hash an identical string, so this canonicalizes `entry`
 * (realpath) before hashing — exactly as the daemon canonicalizes before
 * binding. The socket directory comes from `engineSocketDir()` (raw `$HOME`),
 * the single source of the `.arsumbris/au-engine/run/` literal.
 */
export function socketPath(entry: string): string {
  const canonical = fs.realpathSync(entry)
  return path.join(engineSocketDir(), socketFileName(canonical))
}

/**
 * The daemon's PID-file path for a `<hash>`, `${engineSocketDir(home)}/<hash>.pid`
 * — the socket path with `.sock` swapped for `.pid`, same entry-derived hash, in
 * `~/.arsumbris/au-engine/run/`. Mirrors `au_cli::daemon::pid_path`.
 *
 * `au daemon start` writes this the instant it begins (before the cold build
 * binds the socket) and removes it on a clean stop, so a booting or wedged
 * daemon that has not yet answered its socket is still reachable by pid. A
 * signal-killed daemon leaves a stale pid behind; `readDaemonPid` + `pidAlive`
 * detect the dead pid so a reader never signals a reused one.
 *
 * Hash-keyed door for a consumer holding only the `<hash>`, mirroring
 * `socketPathForHash`; both inherit `engineSocketDir`'s raw-`$HOME` rule.
 */
export function pidPathForHash(hash: string, home?: string): string {
  return path.join(engineSocketDir(home), `${hash}.pid`)
}

/**
 * The daemon's PID-file path for an entry point: `socketPath(entry)` with the
 * `.sock` suffix replaced by `.pid`. Canonicalizes `entry` (realpath) exactly as
 * `socketPath` does, so the hash matches the daemon's byte-for-byte.
 */
export function pidPath(entry: string): string {
  const canonical = fs.realpathSync(entry)
  return path.join(engineSocketDir(), `${contentHash(Buffer.from(canonical, 'utf8'))}.pid`)
}

/**
 * The pid recorded in the daemon's `<hash>.pid` file for `entry`, or `null` when
 * the file is absent or unparseable. Mirrors the engine's read side: the file
 * holds a bare decimal pid, and a garbled file reads as absent so a corrupt pid
 * never signals a random process.
 */
export function readDaemonPid(entry: string): number | null {
  let raw: string
  try {
    raw = fs.readFileSync(pidPath(entry), 'utf8')
  } catch {
    return null // no pid file: no daemon recorded itself for this entry.
  }
  const pid = Number.parseInt(raw.trim(), 10)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/**
 * Whether `pid` names a live process, mirroring the engine's `kill(pid, 0)`
 * liveness check: signal 0 delivers nothing but validates the target. `ESRCH`
 * (no such process) throws → dead; `EPERM` (exists, not ours to signal) → alive.
 * Any other error is treated as not-alive, conservatively.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

type Pending = {
  resolve: (frame: ResponseFrame) => void
  reject: (err: Error) => void
}

/**
 * A pending `resolve`. Its reply is one of three id-stamped frames: a
 * `resolved` (success), a `response` (not-ready, while Deriving), or an
 * `error` — so `resolve` accepts either non-error frame.
 */
type PendingResolve = {
  resolve: (frame: ResolvedFrame | ResponseFrame) => void
  reject: (err: Error) => void
}

/**
 * A pending `mutate`. Unlike a `resolve`, both its outcomes ride the same
 * `response` frame: success (`ready: true`, carrying `version` + `result`) and
 * not-ready (`ready: false`, while Deriving). A reject is an id-stamped `error`
 * frame, routed through `reject`.
 */
type PendingMutate = {
  resolve: (frame: ResponseFrame) => void
  reject: (err: Error) => void
}

/**
 * A pending `register`. Its only success reply is the id-stamped `registered`
 * frame — no not-ready arm (the engine rebuilds synchronously). A reject is an
 * id-stamped `error` frame, routed through `reject`.
 */
type PendingRegister = {
  resolve: (frame: RegisteredFrame) => void
  reject: (err: Error) => void
}

type SubscriptionEntry = {
  /** The request correlation id, the key into `pendingSubscribes` until the ack. */
  requestId: number
  handlers: SubscribeHandlers
  /** The per-connection id assigned in the ack; the key into `subscriptions` after. */
  subscriptionId: number | null
  detached: boolean
}

export class DaemonClient {
  private socket: net.Socket
  private decoder = new FrameDecoder()
  private nextId = 1
  // Reads and subscribes share one id space; the daemon echoes the id on the
  // reply, so each map is keyed by the request's correlation id.
  private pendingReads = new Map<number, Pending>()
  private pendingResolves = new Map<number, PendingResolve>()
  private pendingMutates = new Map<number, PendingMutate>()
  private pendingRegisters = new Map<number, PendingRegister>()
  private pendingSubscribes = new Map<number, SubscriptionEntry>()
  // Keyed by the ack-assigned subscription_id, for the post-ack frames.
  private subscriptions = new Map<number, SubscriptionEntry>()
  private frameListeners = new Set<(frame: Frame) => void>()
  private closeListeners = new Set<(err?: Error) => void>()
  private closed = false
  private closeNotified = false
  // True once close() ran: the end was deliberate, so onClose reports no error.
  private userClosed = false

  private constructor(socket: net.Socket) {
    this.socket = socket
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('error', (err) => this.failAll(err))
    // A deliberate close() surfaces as no error; an unbidden close is a death.
    socket.on('close', () => this.failAll(this.userClosed ? undefined : new Error('daemon connection closed')))
  }

  /**
   * Connect to the daemon serving `entry` — the path the engine was pointed at,
   * a folder-repo DIRECTORY (a directory carrying `.arsumbris/repo.yaml`). Derives
   * the hashed out-of-tree socket path from it (see `socketPath`). Rejects when
   * no daemon is reachable there.
   */
  static connect(entry: string): Promise<DaemonClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath(entry))
      socket.once('connect', () => resolve(new DaemonClient(socket)))
      socket.once('error', (err) => reject(err))
    })
  }

  /** Issue a read, resolve its response frame. Rejects with `WireError` on an error frame, a plain Error on transport failure. */
  read(request: ReadRequest): Promise<ResponseFrame> {
    if (this.closed) return Promise.reject(new Error('client closed'))
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      // Send first; only register the pending read once the write succeeds.
      // A synchronous write failure becomes a rejection, matching the
      // `closed` path above, rather than escaping as a synchronous throw.
      try {
        this.send({ ...request, id })
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      this.pendingReads.set(id, { resolve, reject })
    })
  }

  /**
   * Issue a `resolve` — resolve the served workspace's declared dependency
   * closure into the device-global package cache, write + commit a per-repo
   * package lock under each editable repo's `.arsumbris/`, and rebuild. The
   * package-manager verb; variant-less (empty args). Resolves a typed outcome
   * mirroring a read (see `TypedResolve`): `{ ok: false }` for a daemon error
   * frame (a manifest-less
   * tree-mode workspace), `{ ready: false }` while the ref is Deriving,
   * `{ ready: true; result }` with the `resolved` frame (the resolved members
   * plus any `failed` / `conflicts` and the per-repo lock `commits` /
   * `commit_errors` maps). Rejects only on transport failure.
   */
  resolve(): Promise<TypedResolve> {
    if (this.closed) return Promise.reject(new Error('client closed'))
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      try {
        this.send({ resolve: {}, id })
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      this.pendingResolves.set(id, {
        // A `resolved` frame is success; a not-ready `response` frame means the
        // ref is still Deriving (same envelope a read gets).
        resolve: (frame) =>
          resolve(frame.type === 'resolved' ? { ready: true, result: frame } : { ready: false }),
        // A wire error frame is an in-band outcome (the connection survives);
        // any other rejection is a transport failure and propagates.
        reject: (err) =>
          err instanceof WireError ? resolve({ ok: false, error: err.message }) : reject(err),
      })
    })
  }

  /**
   * Issue a `mutate: register` — write or update repo `name`'s `{ name, remote,
   * path }` entry in the per-user registry (`~/.arsumbris/au-engine/config/repos.yaml`),
   * then rebuild so a newly-locatable member mounts. `path` is the repo's local
   * absolute path on this machine; `remote` is its optional git remote.
   *
   * The consumer-driven bootstrap for a `peer-unmounted` dependency: a folder
   * picker supplies `path`, `register` records it. A CONFIG-sort mutation over a
   * DEVICE-GLOBAL file (outside every repo), so — unlike `setIgnores` — there is
   * NO git commit; it answers a distinct `registered` frame rather than the
   * standard mutate envelope, and has no Deriving arm.
   *
   * A bare `{ name, path }` re-register (no `remote`) PRESERVES the entry's
   * recorded remote rather than clearing it. Resolves a `TypedRegister`:
   * `{ ok: true; result }` with the `registered` frame (echoed `name` / `path`,
   * post-rebuild `version`), or `{ ok: false }` on a reject the connection
   * survives — an invalid repo name, a newline in `path` / `remote`, a
   * `dependency-identity-conflict` (an existing entry with a different `remote`,
   * or a `path` whose `repo.yaml` declares another name), an unreadable / absent
   * `repo.yaml` at `path` (register-before-clone is unsupported), or no
   * resolvable per-user config dir. Rejects only on transport failure.
   */
  register(name: string, path: string, remote?: string): Promise<TypedRegister> {
    if (this.closed) return Promise.reject(new Error('client closed'))
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      try {
        this.send({ mutate: 'register', name, path, ...(remote !== undefined && { remote }), id })
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      this.pendingRegisters.set(id, {
        // The one success reply is the `registered` frame.
        resolve: (frame) => resolve({ ok: true, result: frame }),
        // A wire error frame is an in-band reject (the connection survives); any
        // other rejection is a transport failure and propagates.
        reject: (err) =>
          err instanceof WireError ? resolve({ ok: false, error: err.message }) : reject(err),
      })
    })
  }

  /**
   * Issue a `mutate: write_file` — full-content write, parent directories
   * created. `expectedHash` is the read-before-write guard (see
   * `WriteFileOptions`). Resolves a typed outcome (see `TypedMutate`); rejects
   * only on transport failure.
   */
  writeFile(path: string, content: string, options: WriteFileOptions = {}): Promise<TypedMutate> {
    return this.issueMutate({
      mutate: 'write_file',
      path,
      content,
      ...(options.expectedHash !== undefined ? { expected_hash: options.expectedHash } : {}),
      ...toWireStamps(options.stamps),
      ...toWireEnsureMixins(options.ensureMixins, options.ensureMixinsStrict),
      ...toWireAttribution(options.attribution),
    })
  }

  /**
   * Issue a `mutate: edit_file` — exact string replacement. `oldString` must
   * match exactly; by default it must be unique (its own read-before-write
   * precondition), `replaceAll` lifts that (see `EditFileOptions`). Resolves a
   * typed outcome (see `TypedMutate`); rejects only on transport failure.
   */
  editFile(
    path: string,
    oldString: string,
    newString: string,
    options: EditFileOptions = {},
  ): Promise<TypedMutate> {
    return this.issueMutate({
      mutate: 'edit_file',
      path,
      old_string: oldString,
      new_string: newString,
      ...(options.replaceAll !== undefined ? { replace_all: options.replaceAll } : {}),
      ...toWireStamps(options.stamps),
      ...toWireEnsureMixins(options.ensureMixins, options.ensureMixinsStrict),
      ...toWireAttribution(options.attribution),
    })
  }

  /**
   * Issue a `mutate: assign_block_id` — assign an engine-generated `^:` id to
   * the addressable entity enclosing byte offset `at` (e.g. from a span the
   * wire served). Idempotent: an already-addressed entity returns its existing
   * id unwritten. The success `result` adds `id` and `ref` (the `[[target^id]]`
   * reference). `stamps` is the optional write rider (see `Stamp`), all folded
   * into this write's commit onto `path`. Resolves a typed outcome (see
   * `TypedMutate`); rejects only on transport failure.
   */
  assignBlockId(path: string, at: number, stamps?: Stamp[]): Promise<TypedMutate> {
    return this.issueMutate({ mutate: 'assign_block_id', path, at, ...toWireStamps(stamps) })
  }

  /**
   * Issue a `mutate: edit_record` — patch a nested typed record's fields in
   * place, keyed by the `instances_of` `fieldPath` locator (an array of field
   * names and list indices, e.g. `["phases", 0, "actions", 1]`; the empty array
   * addresses the file-level instance). A byte-splice: only the touched field
   * bytes change, every other byte and every comment stays identical. `patch` is
   * a shallow field-to-value map (`type` re-types the record, replacing the
   * claim); v1 replaces a scalar field or inserts an absent one — a list/mapping
   * field replace, a `^` block-id key, and an empty `patch` reject. See
   * `RecordMutateOptions` for `expectedHash` (read-before-write guard) and
   * `onInvalid`. The success `result` is the standard envelope (no new fields).
   * Resolves a typed outcome (see `TypedMutate`); rejects only on transport
   * failure.
   */
  editRecord(
    path: string,
    fieldPath: Array<string | number>,
    patch: Record<string, unknown>,
    options: RecordMutateOptions = {},
  ): Promise<TypedMutate> {
    return this.issueMutate({
      mutate: 'edit_record',
      path,
      field_path: fieldPath,
      patch,
      ...(options.expectedHash !== undefined ? { expected_hash: options.expectedHash } : {}),
      ...(options.onInvalid !== undefined ? { on_invalid: options.onInvalid } : {}),
      ...toWireStamps(options.stamps),
    })
  }

  /**
   * Issue a `mutate: append_record` — append one element to the sequence the
   * `fieldPath` locator addresses, a byte-splice after the last element so every
   * existing element and its comments stay identical. An empty `[]` sequence is
   * seeded (rewritten to a block list); a bare `key:` (null, no `[]`) is not a
   * seed target and rejects. `value` is the element (a record or a scalar),
   * rendered to YAML by the engine. See `RecordMutateOptions` for `expectedHash`
   * and `onInvalid`. The success `result` is the standard envelope (no new
   * fields). Resolves a typed outcome (see `TypedMutate`); rejects only on
   * transport failure.
   */
  appendRecord(
    path: string,
    fieldPath: Array<string | number>,
    value: unknown,
    options: RecordMutateOptions = {},
  ): Promise<TypedMutate> {
    return this.issueMutate({
      mutate: 'append_record',
      path,
      field_path: fieldPath,
      value,
      ...(options.expectedHash !== undefined ? { expected_hash: options.expectedHash } : {}),
      ...(options.onInvalid !== undefined ? { on_invalid: options.onInvalid } : {}),
      ...toWireStamps(options.stamps),
    })
  }

  /**
   * Issue a `mutate: delete_file` — remove the file; the rebuild drops its node
   * from the graph. `options.expectedHash` is the read-before-write guard (a
   * mismatch rejects without deleting, with `detail.current_hash`); deleting an
   * absent file rejects, no silent success. The success `result` carries
   * `hash: null` (the target is gone) and `reflected: true` (no content to lag),
   * plus `last_live_commit`, the parent of the deletion commit (the last commit
   * where the file existed) on-git, for a tombstone pin. `options.attribution`
   * (schema 26) folds `{ key, value }` trailers into the deletion commit.
   * Resolves a typed outcome (see `TypedMutate`); rejects only on transport
   * failure.
   */
  deleteFile(path: string, options: DeleteFileOptions = {}): Promise<TypedMutate> {
    return this.issueMutate({
      mutate: 'delete_file',
      path,
      ...(options.expectedHash !== undefined ? { expected_hash: options.expectedHash } : {}),
      ...toWireAttribution(options.attribution),
    })
  }

  /**
   * Issue a `mutate: promote` — extract the inline `^:` record located by
   * `locator` (`{ at }` for a record with no id, `{ blockId }` for one that has
   * it) out of host `path` into its own file at `to`, leaving a `[[to]]`
   * reference where the record sat and rewriting every inbound `[[path^id]]`
   * referrer to `[[to]]`. The record's whole nested `^:` block-id subtree
   * travels to the new file; a referrer to a nested id keeps its id under `to`
   * (`[[path^nested]]` → `[[to^nested]]`). The extraction, the host edit, and
   * every referrer rewrite commit as one saga, one `Mutation-Id` across every
   * repo touched; each rewritten referrer is guarded by a read-before-write
   * hash check, so one that drifted on disk rejects the whole refactor.
   * The success `result` carries the standard envelope (`hash` is the new
   * file's content hash). `stamps` is the optional write rider (see `Stamp`),
   * all folded into this write's commit onto the new file `to`. Resolves a typed
   * outcome (see `TypedMutate`); rejects only on transport failure.
   */
  promote(path: string, to: string, locator: PromoteLocator, stamps?: Stamp[]): Promise<TypedMutate> {
    return this.issueMutate({
      mutate: 'promote',
      path,
      to,
      ...('at' in locator ? { at: locator.at } : { block_id: locator.blockId }),
      ...toWireStamps(stamps),
    })
  }

  /**
   * Issue a `mutate: inline` — the dual of `promote`. Fold file `path` into host
   * `into` as an inline `^:id` record holding `path`'s frontmatter: the chosen
   * `[[path]]` reference in `into` becomes the record, every other whole-file
   * `[[path]]` in `into` becomes the local `[[^id]]`, every cross-file
   * `[[path]]` becomes `[[into^id]]`, and `path` is deleted — all as one saga,
   * one `Mutation-Id`. `at` (a byte offset in `into` landing on the `[[path]]`
   * reference to host) is required only when `into` references `path` more than
   * once. A nested `^:` id in `path`'s subtree that collides with one `into`
   * already declares is renamed during the fold, with every reference following.
   * Cross-file referrer rewrites are read-before-write hash-guarded. The success
   * `result` carries the standard envelope (`hash` is the host's new content
   * hash). `stamps` is the optional write rider (see `Stamp`), all folded into
   * this write's commit onto the host `into`. Resolves a typed outcome (see
   * `TypedMutate`); rejects only on transport failure.
   */
  inline(path: string, into: string, at?: number, stamps?: Stamp[]): Promise<TypedMutate> {
    return this.issueMutate({
      mutate: 'inline',
      path,
      into,
      ...(at !== undefined ? { at } : {}),
      ...toWireStamps(stamps),
    })
  }

  /**
   * Issue a `mutate: rename_block_id` — rename inline `^:` record `blockId` in
   * host `path` to `toBlockId`: the `^:` declaration changes, and every referrer
   * filtered to that id follows (`[[path^blockId]]` → `[[path^toBlockId]]`, a
   * host-local `[[^blockId]]` → `[[^toBlockId]]`), target/anchor/`:field`/`::repo`
   * preserved. The declaration edit and every referrer rewrite commit as one
   * saga, one `Mutation-Id`, each rewritten referrer read-before-write
   * hash-guarded. Scope is inline `^:` records only — a body-marker `^id`
   * rejects. The success `result` carries the standard envelope (`hash` is the
   * host's new content hash). `stamps` is the optional write rider (see `Stamp`),
   * all folded into this write's commit onto the host `path`. Resolves a typed
   * outcome (see `TypedMutate`); rejects only on transport failure.
   */
  renameBlockId(path: string, blockId: string, toBlockId: string, stamps?: Stamp[]): Promise<TypedMutate> {
    return this.issueMutate({
      mutate: 'rename_block_id',
      path,
      block_id: blockId,
      to_block_id: toBlockId,
      ...toWireStamps(stamps),
    })
  }

  /**
   * Issue a `mutate: rename` — move the file from `path` to `to` and rewrite
   * every inbound reference to point at the new name, all as one saga (one
   * `Mutation-Id` shared across every repo a referrer lives in). Each rewrite
   * preserves the referrer's spelling mode (`[[old]]` / `[[notes/old]]` /
   * `[[old.md]]` stay bare / path / extension), every fragment
   * (`#anchor` / `^block` / `:field`), and the `::repo` qualifier; only the name
   * changes. Same-repo only (a cross-repo `to` rejects), and a type-def file
   * rejects — moving one is `renameType`'s job, since its name derives from the
   * filename. The success `result` carries the standard envelope (`hash` is the
   * moved content's hash at `to`). `options` carries the two write riders (see
   * `RenameOptions`): `stamps` and the schema-25 `ensureMixins`, both folded into
   * this write's commit onto the destination `to`. Resolves a typed outcome (see
   * `TypedMutate`); rejects only on transport failure.
   */
  rename(path: string, to: string, options: RenameOptions = {}): Promise<TypedMutate> {
    return this.issueMutate({
      mutate: 'rename',
      path,
      to,
      ...toWireStamps(options.stamps),
      ...toWireEnsureMixins(options.ensureMixins, options.ensureMixinsStrict),
    })
  }

  /**
   * Issue a `mutate: rename_type` — rename a type-def from `oldName` to
   * `newName`. The name derives from the filename, so the def file moves
   * (suffix and directory kept) and every reference follows, all as one saga
   * (one `Mutation-Id`). Two reference surfaces are rewritten together: the
   * type-name references in the owning repo (`type:` claims, `sealed:` branches,
   * slot shapes, colon-prefix keys, body `use:`, meta `- type:`, nested record
   * `type:` claims — none a wikilink, repo-local) and the wikilinks to the def
   * file across the mounted set (`[[name]]` def-ref / navigational links and
   * `file*`/path references, each re-pointed in its spelling mode). The def-file
   * move also writes a `Moved: <old> -> <new>` commit trailer, so a
   * commit-pinned `type<T>*@` reference traces forward. The type-vocabulary
   * sibling of `rename` (which refuses a type-def file). The success `result`
   * carries the standard envelope. Resolves a typed outcome (see `TypedMutate`);
   * rejects only on transport failure.
   *
   * `oldName` is bare (`foo`) or `::repo`-qualified (`foo::repo`): a `::repo`
   * selects which owner's identity to rename when two mounted repos own the
   * name, a bare name picks the first owner across the mounted set. `newName` is
   * always the owner's own new name, so it stays bare. Forwarded verbatim.
   */
  renameType(oldName: string, newName: string): Promise<TypedMutate> {
    return this.issueMutate({ mutate: 'rename_type', old_name: oldName, new_name: newName })
  }

  /**
   * Issue a `mutate: set_ignores` — replace member `root`'s `.auignore` scope
   * rules with `patterns` (the FULL replacement list; an empty list removes the
   * file, reverting to the default excludes), then re-scope. `root` names a
   * declared member root exactly, as the `ignores` read surfaces it.
   *
   * A CONFIG-sort mutation, a distinct sort from the graph mutations: it edits
   * which content enters the graph, not graph content. Its integrity contract is
   * deliberately relaxed — it MAY orphan references (newly excluding a referenced
   * file is a valid scope choice), which surface as advisory
   * `reference-target-missing` / `navigational-target-not-found` diagnostics on
   * the result, never a rejection. The one sanctioned write under `.arsumbris/`,
   * and only to `<root>/.arsumbris/.auignore` (a raw `write_file` there still
   * rejects).
   *
   * The success `result` is the standard envelope, but `.auignore` is out-of-band
   * config (never a catalog entry), so `hash` is null and `reflected` is the
   * delete-style "nothing to lag"; the re-scope runs before the response, so
   * `version` already reflects the new scope. Rejects (as `{ ok: false }`, nothing
   * written) a `root` that is not a declared member root, or a malformed pattern.
   * Resolves a typed outcome (see `TypedMutate`); rejects only on transport failure.
   */
  setIgnores(root: string, patterns: string[]): Promise<TypedMutate> {
    return this.issueMutate({ mutate: 'set_ignores', root, patterns })
  }

  /**
   * Issue a `mutate: set_config` — the write dual of the `config` read (see
   * `readConfig`), governing ONE consumer config file under
   * `<scope>/<consumer>/config/<file>`. `args` is the same `(scope, consumer,
   * file, type, root?)` addressing the read takes (`type` is the DECLARED floor);
   * `body` is EXACTLY ONE of `{ content }` (whole file) or `{ edit }` (keyed-record
   * byte-splice), see `SetConfigBody`. The write INJECTS `type: <declared>` when the
   * content declares no own top-level `type:`, so a governed write self-describes.
   *
   * A CONFIG-sort mutation, a second sanctioned bypass of the `.arsumbris/`
   * write-guard (like `setIgnores`): a raw `writeFile` under `.arsumbris/` still
   * rejects. Integrity is relaxed — a field-shape verdict is ADVISORY, never a
   * refusal (an unresolved `type` stores with `config-type-unresolved`, an absent
   * `type:` key with `config-type-unwritten`).
   *
   * The success `result` is the standard mutate envelope, but the file rides the
   * `.arsumbris` floor (out-of-band, no catalog entry, no re-scope, no rebuild), so
   * `hash` is the WRITTEN file's content hash (for the next `expectedHash`
   * compare-and-set), NOT a catalog hash, and `reflected` is the delete-style
   * "nothing to lag". REPO scope commits per mutation (`commit` / `commits` set);
   * MACHINE scope is device-global with no git commit (`commit` null, `commits`
   * `{}`), serialized by a cross-daemon file lock and written atomically.
   *
   * Rejects (as `{ ok: false }`, nothing written) a path-unsafe / reserved
   * `consumer` / `file`, an unknown repo-scope `root`, an `edit` of an absent file,
   * or an `expectedHash` mismatch. Resolves a typed outcome (see `TypedMutate`);
   * rejects only on transport failure. Additive — no `schema_version` bump.
   */
  setConfig(args: WireConfigArgs, body: SetConfigBody, options: SetConfigOptions = {}): Promise<TypedMutate> {
    const write =
      'content' in body
        ? { content: body.content }
        : { edit: { field_path: body.edit.fieldPath, patch: body.edit.patch } }
    return this.issueMutate({
      mutate: 'set_config',
      scope: args.scope,
      consumer: args.consumer,
      file: args.file,
      type: args.type,
      ...(args.root !== undefined ? { root: args.root } : {}),
      ...write,
      ...(options.expectedHash !== undefined ? { expected_hash: options.expectedHash } : {}),
    })
  }

  /**
   * Send a mutation frame and settle its typed outcome. Both success and
   * not-ready arrive as an id-stamped `response`; a reject is an id-stamped
   * `error` frame (the connection survives), surfaced as `{ ok: false }` with
   * the reject's `detail`. Shared by every primitive helper.
   */
  private issueMutate(mutation: object): Promise<TypedMutate> {
    if (this.closed) return Promise.reject(new Error('client closed'))
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      try {
        this.send({ ...mutation, id })
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      this.pendingMutates.set(id, {
        // A ready `response` carries the post-mutation `version` and the result
        // object; a not-ready one means the engine is still Deriving.
        resolve: (frame) =>
          resolve(
            frame.ready
              ? { ready: true, version: frame.version, result: frame.result as WireMutateResult }
              : { ready: false },
          ),
        // A wire error frame is an in-band reject (the connection survives),
        // carrying the reject's machine-usable `detail`; any other rejection is
        // a transport failure and propagates.
        reject: (err) =>
          err instanceof WireError
            ? resolve({ ok: false, error: err.message, detail: err.detail })
            : reject(err),
      })
    })
  }

  /**
   * Open a subscription. Returns a detach function.
   *
   * The wire has no unsubscribe verb — a subscription lives until the
   * connection closes. Detaching stops local delivery only.
   */
  subscribe(request: SubscribeRequest, handlers: SubscribeHandlers): () => void {
    if (this.closed) {
      queueMicrotask(() => handlers.onClose?.('client closed', 'transient'))
      return () => {}
    }
    const id = this.nextId++
    try {
      this.send({ ...request, id })
    } catch (err) {
      // A synchronous write failure ends the subscription before it began,
      // surfaced through the same `onClose` path as any other end (transient).
      const message = err instanceof Error ? err.message : String(err)
      queueMicrotask(() => handlers.onClose?.(message, 'transient'))
      return () => {}
    }
    const entry: SubscriptionEntry = { requestId: id, handlers, subscriptionId: null, detached: false }
    this.pendingSubscribes.set(id, entry)
    return () => {
      entry.detached = true
      this.pendingSubscribes.delete(entry.requestId)
      if (entry.subscriptionId !== null) this.subscriptions.delete(entry.subscriptionId)
    }
  }

  private send(request: object): void {
    this.socket.write(encodeFrame(request))
  }

  /** True once the connection has failed or been closed. A closed client never recovers; reconnect. */
  get isClosed(): boolean {
    return this.closed
  }

  /** Listen to non-response frames (ack, initial_value, change_event). */
  onFrame(listener: (frame: Frame) => void): () => void {
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  /**
   * Notified once when the connection ends, however it ends. The argument
   * tells the two apart: an `Error` for an unbidden end (daemon death,
   * transport failure, an oversized frame), `undefined` for a deliberate
   * local `close()` — a consumer that closed it knows why and need not treat
   * it as a fault.
   */
  onClose(listener: (err?: Error) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  close(): void {
    this.userClosed = true
    this.closed = true
    this.socket.destroy()
  }

  private onData(chunk: Buffer): void {
    // Unparseable bodies are dropped by the decoder: surfaced to listeners
    // as nothing, settling nothing. The connection stays usable.
    let values: unknown[]
    try {
      values = this.decoder.push(chunk)
    } catch (err) {
      // A frame too large to be real desyncs the stream past recovery.
      // Fail everything with the real reason, then drop the socket.
      const error = err instanceof Error ? err : new Error(String(err))
      this.failAll(error)
      this.close()
      return
    }
    for (const value of values) {
      this.dispatchFrame(value as Frame)
    }
  }

  private dispatchFrame(frame: Frame): void {
    // The decoder yields any JSON value a body parses to, not just frame
    // objects. A bare `null` would throw on the `.type` access below, escaping
    // the `'data'` handler uncaught; primitives and arrays have no `type` and
    // would settle nothing. Treat every non-object as an unknown frame: drop it
    // to the raw listeners, keep the stream usable (parity with the decoder).
    if (frame === null || typeof frame !== 'object') {
      for (const listener of this.frameListeners) listener(frame)
      return
    }
    // A wire schema mismatch is fatal to the connection: a stale or ahead
    // daemon speaks a protocol this client cannot settle safely. Detect it
    // here, before the settle paths below — in particular ahead of the id-less
    // `take` fallback, which would otherwise misroute a reply from the wrong
    // protocol into an arbitrary pending reader. `failAll` + `close` is the
    // right severity: the connection cannot recover, and a half-spoken
    // protocol must not keep settling reads. Only an explicit mismatch fails;
    // a frame with no `schema_version` has nothing to compare, so it falls
    // through to the normal dispatch (parity with the non-object guard above).
    if (typeof frame.schema_version === 'number' && frame.schema_version !== WIRE_SCHEMA_VERSION) {
      const error = new WireSchemaMismatchError(frame.schema_version)
      this.failAll(error)
      this.close()
      return
    }
    if (frame.type === 'response') {
      const read = this.take(this.pendingReads, frame.id)
      if (read) read.resolve(frame)
      // A resolve answered not-ready arrives as an id-stamped `response`, not a
      // `resolved` frame; route it to the one that asked. A mutate rides the
      // `response` envelope for BOTH outcomes — a successful write and a
      // not-ready (Deriving) — so route it the same way.
      else {
        const res = this.take(this.pendingResolves, frame.id)
        if (res) res.resolve(frame)
        else this.take(this.pendingMutates, frame.id)?.resolve(frame)
      }
    } else if (frame.type === 'resolved') {
      this.take(this.pendingResolves, frame.id)?.resolve(frame)
    } else if (frame.type === 'registered') {
      this.take(this.pendingRegisters, frame.id)?.resolve(frame)
    } else if (frame.type === 'error') {
      this.routeError(frame)
    } else if (frame.type === 'ack') {
      this.onAck(frame)
    } else if (frame.type === 'initial_value') {
      const entry = this.subscriptions.get(frame.subscription_id)
      entry?.handlers.onInitialValue?.(frame)
    } else if (frame.type === 'change_event') {
      const entry = this.subscriptions.get(frame.subscription_id)
      entry?.handlers.onChangeEvent?.(frame)
    } else {
      // Unknown frame types are ignored per additive wire evolution,
      // surfaced to raw listeners for the curious.
      for (const listener of this.frameListeners) listener(frame)
    }
  }

  /**
   * Take the pending entry a reply settles. By correlation id when present,
   * which is the normal path (the SDK always sends one). An id-less reply is
   * pathological; replies stay in request order, so fall back to the oldest.
   * An id that matches nothing returns nothing — never settle a stray.
   */
  private take<T>(map: Map<number, T>, id: number | undefined): T | undefined {
    if (id !== undefined) {
      const entry = map.get(id)
      if (entry) map.delete(id)
      return entry
    }
    const first = map.keys().next()
    if (first.done) return undefined
    const entry = map.get(first.value)
    map.delete(first.value)
    return entry
  }

  /**
   * Route an error frame to the request it answers. By id first; for an
   * id-less one, by `for` (the wire's self-routing discriminator). A subscribe
   * refusal is permanent (`rejected: true`); a read error is a `WireError` the
   * connection survives. Unattributable errors surface to raw listeners.
   */
  private routeError(frame: ErrorFrame): void {
    if (frame.id !== undefined) {
      const read = this.pendingReads.get(frame.id)
      if (read) {
        this.pendingReads.delete(frame.id)
        read.reject(new WireError(frame.error, frame.detail))
        return
      }
      const sub = this.pendingSubscribes.get(frame.id)
      if (sub) {
        this.pendingSubscribes.delete(frame.id)
        sub.handlers.onClose?.(frame.error, 'rejected')
        return
      }
      const res = this.pendingResolves.get(frame.id)
      if (res) {
        this.pendingResolves.delete(frame.id)
        res.reject(new WireError(frame.error, frame.detail))
        return
      }
      const reg = this.pendingRegisters.get(frame.id)
      if (reg) {
        this.pendingRegisters.delete(frame.id)
        reg.reject(new WireError(frame.error, frame.detail))
        return
      }
      const mut = this.pendingMutates.get(frame.id)
      if (mut) {
        this.pendingMutates.delete(frame.id)
        mut.reject(new WireError(frame.error, frame.detail))
        return
      }
    } else if (frame.for === 'read') {
      const read = this.take(this.pendingReads, undefined)
      if (read) {
        read.reject(new WireError(frame.error, frame.detail))
        return
      }
    } else if (frame.for === 'subscribe') {
      const sub = this.take(this.pendingSubscribes, undefined)
      if (sub) {
        sub.handlers.onClose?.(frame.error, 'rejected')
        return
      }
    } else if (frame.for === 'resolve') {
      const res = this.take(this.pendingResolves, undefined)
      if (res) {
        res.reject(new WireError(frame.error, frame.detail))
        return
      }
    } else if (frame.for === 'mutate') {
      // A malformed-mutate error carries `for: 'mutate'`. In practice it also
      // carries the id (settled above); this is the id-less fallback, symmetric
      // with the other verbs.
      const mut = this.take(this.pendingMutates, undefined)
      if (mut) {
        mut.reject(new WireError(frame.error, frame.detail))
        return
      }
    }
    // Unmatched id, or a `for` we cannot attribute (unknown): the curious can
    // see it, but nothing is settled.
    for (const listener of this.frameListeners) listener(frame)
  }

  private onAck(frame: AckFrame): void {
    const entry = this.take(this.pendingSubscribes, frame.id)
    if (!entry) return
    entry.handlers.onAck?.(frame)
    // `accepted` is always true; a refusal is an error frame, routed above.
    // Assign the id and start delivering frames.
    entry.subscriptionId = frame.subscription_id
    if (!entry.detached) this.subscriptions.set(frame.subscription_id, entry)
  }

  private failAll(err?: Error): void {
    if (!this.closeNotified) {
      this.closeNotified = true
      for (const listener of this.closeListeners) listener(err)
    }
    if (
      this.closed &&
      this.pendingReads.size === 0 &&
      this.pendingResolves.size === 0 &&
      this.pendingMutates.size === 0 &&
      this.pendingRegisters.size === 0 &&
      this.subscriptions.size === 0 &&
      this.pendingSubscribes.size === 0
    ) {
      return
    }
    this.closed = true
    // Pending work still settles with a concrete reason even on a deliberate
    // close (where onClose itself reported no error).
    const cause = err ?? new Error('client closed')
    // A schema mismatch poisons the protocol — reconnecting hits the same
    // stale daemon, so it is `fatal`. Any other death is `transient`: a
    // reconnect may help.
    const reason: SubscriptionCloseReason = cause instanceof WireSchemaMismatchError ? 'fatal' : 'transient'
    for (const p of this.pendingReads.values()) p.reject(cause)
    this.pendingReads.clear()
    for (const p of this.pendingResolves.values()) p.reject(cause)
    this.pendingResolves.clear()
    for (const p of this.pendingMutates.values()) p.reject(cause)
    this.pendingMutates.clear()
    for (const p of this.pendingRegisters.values()) p.reject(cause)
    this.pendingRegisters.clear()
    for (const entry of this.pendingSubscribes.values()) entry.handlers.onClose?.(cause.message, reason)
    this.pendingSubscribes.clear()
    for (const entry of this.subscriptions.values()) entry.handlers.onClose?.(cause.message, reason)
    this.subscriptions.clear()
  }
}

/**
 * Connect, issue the `lifecycle` probe, disconnect.
 * Returns null when the socket is absent, stale, or unreachable.
 */
export async function probeReady(entry: string): Promise<ReadyProbe | null> {
  let client: DaemonClient
  try {
    client = await DaemonClient.connect(entry)
  } catch {
    return null
  }
  try {
    const response = await client.read({ read: 'lifecycle' })
    // schema 17: the payload is enveloped under the read's own name.
    const result = ((response.result as Record<string, unknown> | undefined)?.lifecycle ?? {}) as LifecycleResult
    return {
      ready: response.ready,
      version: response.version,
      engine: result.engine,
      refState: result.ref,
    }
  } catch {
    return null
  } finally {
    client.close()
  }
}

/**
 * Ask the daemon serving `entry` to shut down.
 * Returns false when no daemon was reachable.
 */
export async function requestShutdown(entry: string): Promise<boolean> {
  let client: DaemonClient
  try {
    client = await DaemonClient.connect(entry)
  } catch {
    return false
  }
  try {
    await client.read({ read: 'shutdown' })
    return true
  } catch (err) {
    // The daemon may close the connection while replying to shutdown, so a
    // transport failure still counts as a shutdown that landed. A WireError is
    // different: the daemon is reachable and answered with an error frame — it
    // did not accept the read, so the shutdown did not happen.
    return !(err instanceof WireError)
  } finally {
    client.close()
  }
}
