// Optional hardening utilities, per the design stance in CLAUDE.md:
// retry, caching, and friends ship as opt-in wrappers, never baked into
// the core client — consumer policies differ.
//
// Each utility decorates a `WireReader` (or another narrow surface) and
// returns the same shape, so they compose with the typed read helpers
// and stack in any order.
//
// Pure functions and timers only — renderer-safe (`./hardening` subpath).

import { schemaMismatchMessage, WireSchemaMismatchError, WIRE_SCHEMA_VERSION } from './wire.ts'
import type { EngineReadResult, ReadRequest, ResponseFrame, SubscribeHandlers, SubscribeRequest } from './wire.ts'
import type { WireReader } from './read-helpers.ts'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Options for `withReadyRetry`. The defaults are a production consumer's
 * proven values: 30 attempts at 200ms, a six-second ceiling on daemon startup.
 */
export interface ReadyRetryOptions {
  /** Total attempts before the not-ready response is returned as is. */
  attempts?: number
  /** Delay between attempts, in milliseconds. */
  delayMs?: number
}

/**
 * Wrap a reader so reads answering `ready: false` are re-issued until the
 * ref is ready or the attempts run out. The last not-ready response passes
 * through when exhausted, so `TypedRead`'s `{ ready: false }` arm still
 * surfaces. Errors are not retried — only readiness is polled.
 */
export function withReadyRetry(reader: WireReader, options?: ReadyRetryOptions): WireReader {
  const attempts = options?.attempts ?? 30
  const delayMs = options?.delayMs ?? 200
  return {
    async read(request) {
      let response = await reader.read(request)
      for (let attempt = 1; attempt < attempts; attempt++) {
        if ('ok' in response && !response.ok) return response
        if (response.ready) return response
        await sleep(delayMs)
        response = await reader.read(request)
      }
      return response
    },
  }
}

type ReadResponse = ResponseFrame | EngineReadResult

/** The version a response is cacheable at: ready, versioned, not an error. */
function cacheableVersion(response: ReadResponse): number | null {
  if ('ok' in response && !response.ok) return null
  return response.ready && typeof response.version === 'number' ? response.version : null
}

/** A canonical key for a request: JSON with object keys sorted at every depth. */
function requestKey(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    )
  }
  return value
}

/** A caching reader. Wire `advanceTo` to change events; `clear` is the blunt instrument. */
export interface CachingReader extends WireReader {
  /**
   * Tell the cache the knowledge base advanced to `version` — pass a change event's
   * `at_version`. Entries observed at older versions drop; responses flowing
   * through the cache advance it the same way on their own.
   */
  advanceTo(version: number): void
  /**
   * Drop every entry and reset the version baseline, e.g. on reconnect
   * (versions are per-connection, so the new connection may start lower).
   * In-flight reads issued before the clear are abandoned: they neither
   * cache nor advance the baseline, and a fresh read of the same key does
   * not coalesce onto them.
   */
  clear(): void
}

/**
 * Cache ready read responses keyed by `(op, args)`, invalidated on version
 * advance. Identical reads in flight coalesce into one wire round trip
 * (the client pipelines the reads FIFO, the cache dedups). Not-ready
 * responses and errors are never cached. Cached
 * responses are returned by reference; treat results as immutable.
 */
export function withReadCache(reader: WireReader): CachingReader {
  const entries = new Map<string, { version: number; response: ReadResponse }>()
  const inFlight = new Map<string, Promise<ReadResponse>>()
  let current = 0
  // Bumped by clear(); a read tags its issue-time generation so results
  // settling after a clear() don't repopulate the freshly emptied cache.
  let generation = 0

  const advanceTo = (version: number): void => {
    if (version <= current) return
    current = version
    for (const [key, entry] of entries) {
      if (entry.version < current) entries.delete(key)
    }
  }

  return {
    read(request) {
      const key = requestKey(request)
      const hit = entries.get(key)
      if (hit) return Promise.resolve(hit.response)
      const pending = inFlight.get(key)
      if (pending) return pending
      const gen = generation
      const promise = reader.read(request).then(
        (response) => {
          // Only clear the slot if it still holds this read — a clear()
          // plus a re-issue may have replaced it with a newer promise.
          if (inFlight.get(key) === promise) inFlight.delete(key)
          // Abandon a result from before a clear(): its version belongs to
          // the old connection's numbering, so neither cache nor advance.
          if (gen !== generation) return response
          const version = cacheableVersion(response)
          if (version !== null) {
            advanceTo(version)
            // A response raced by a newer version stays uncached.
            if (version === current) entries.set(key, { version, response })
          }
          return response
        },
        (err: unknown) => {
          if (inFlight.get(key) === promise) inFlight.delete(key)
          throw err
        },
      )
      inFlight.set(key, promise)
      return promise
    },
    advanceTo,
    clear() {
      entries.clear()
      inFlight.clear()
      current = 0
      generation++
    },
  }
}

/**
 * A reader whose responses are raw frames. The schema check needs the
 * frame envelope — `MountHost.engine` strips it, so this is client-side
 * only; `DaemonClient` satisfies it.
 */
export interface FrameReader {
  read(request: ReadRequest): Promise<ResponseFrame>
}

export type SchemaCheck =
  | { ok: true; schemaVersion: number }
  | { ok: false; schemaVersion: number; error: string }

/**
 * Validate the daemon's wire schema version on connect, a production
 * consumer's check generalized. Issues the `lifecycle` read (it answers even while Deriving)
 * and compares the frame's `schema_version` against `expected` — exact
 * match: a bump in either direction means a breaking contract change.
 * The rejection message is written for the consumer's UI, not just logs.
 */
export async function checkSchemaVersion(
  reader: FrameReader,
  expected: number = WIRE_SCHEMA_VERSION,
): Promise<SchemaCheck> {
  const response = await reader.read({ read: 'lifecycle' })
  const schemaVersion = response.schema_version
  if (schemaVersion === expected) return { ok: true, schemaVersion }
  return { ok: false, schemaVersion, error: schemaMismatchMessage(schemaVersion, expected) }
}

/** The minimal surface a persistent subscription runs over; `DaemonClient` satisfies it. */
export interface WireSubscriber {
  subscribe(request: SubscribeRequest, handlers: SubscribeHandlers): () => void
}

/**
 * Options for `persistentSubscription`. The defaults are a production
 * consumer's proven values: exponential backoff from 1s, capped at 15s.
 */
export interface ResubscribeOptions {
  /** First retry delay; doubles per consecutive failure. */
  initialDelayMs?: number
  /** Backoff ceiling. */
  maxDelayMs?: number
  /** Observe retry scheduling: the attempt count and the delay chosen. */
  onRetry?: (attempt: number, delayMs: number) => void
}

/**
 * Keep a subscription alive across connection deaths.
 *
 * The wire ties a subscription to its connection, so on death the wrapper
 * calls `connect` again and re-subscribes with exponential backoff. The
 * channel re-delivers its initial value on each resubscribe — consumers
 * treat `onInitialValue` as a state reset. The ack resets the backoff.
 *
 * `onClose` fires only for permanent ends: a refused subscribe (`rejected` —
 * unknown channel, malformed args) or a fatal connection death (`fatal` — a
 * wire schema mismatch; reconnecting would only fail the same way). Transient
 * connection deaths are absorbed into retries, observable via `onRetry`.
 *
 * Connection ownership stays with the `connect` factory; this wrapper never
 * closes a connection, because it cannot know whether the factory shares one
 * or mints a dedicated one. A factory sharing a client must not have it closed
 * here. A factory minting dedicated clients owns closing them — and must track
 * EVERY client it mints, not just the latest: if `stop()` lands while a
 * `connect()` is in flight, that connection resolves into a wrapper that has
 * already stopped, so it is never subscribed and never handed back. A factory
 * that only remembers "the latest" leaks it. The shared-client pattern
 * (`manageConnection.acquire` as the factory) sidesteps this entirely — the
 * manager owns the lifecycle and `close()`s on teardown, so prefer it.
 *
 * Returns a stop function: detaches and stops retrying.
 */
export function persistentSubscription(
  connect: () => Promise<WireSubscriber>,
  request: SubscribeRequest,
  handlers: SubscribeHandlers,
  options?: ResubscribeOptions,
): () => void {
  const initialDelayMs = options?.initialDelayMs ?? 1_000
  const maxDelayMs = options?.maxDelayMs ?? 15_000
  let stopped = false
  let detach: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let failures = 0

  const scheduleRetry = (): void => {
    if (stopped) return
    const delay = Math.min(initialDelayMs * 2 ** failures, maxDelayMs)
    failures++
    options?.onRetry?.(failures, delay)
    timer = setTimeout(() => {
      timer = null
      void open()
    }, delay)
  }

  const open = async (): Promise<void> => {
    if (stopped) return
    let subscriber: WireSubscriber
    try {
      subscriber = await connect()
    } catch (err) {
      // A shared connection that went fatal — a schema mismatch surfaced
      // through `manageConnection.acquire` — cannot be retried; end the
      // subscription permanently. Any other connect failure is transient.
      if (err instanceof WireSchemaMismatchError) {
        stopped = true
        handlers.onClose?.(err.message, 'fatal')
        return
      }
      scheduleRetry()
      return
    }
    // Stopped while connect() was in flight: never subscribe. A dedicated
    // client the factory minted for this attempt is now stranded — the wrapper
    // cannot close it (it may be shared), so the factory must (see the doc).
    if (stopped) return
    detach = subscriber.subscribe(request, {
      onAck(frame) {
        // An ack means accepted (v4): the channel is live, reset the backoff.
        failures = 0
        handlers.onAck?.(frame)
      },
      onInitialValue(frame) {
        handlers.onInitialValue?.(frame)
      },
      onChangeEvent(frame) {
        handlers.onChangeEvent?.(frame)
      },
      onClose(error, reason) {
        detach = null
        if (reason !== 'transient') {
          // Permanent: the channel refused it (`rejected`) or the connection
          // died unrecoverably (`fatal`). Retrying cannot fix either.
          stopped = true
          handlers.onClose?.(error, reason)
          return
        }
        scheduleRetry()
      },
    })
  }

  void open()

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    detach?.()
  }
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected'

/** What the connection manager needs from a client; `DaemonClient` satisfies it. */
export interface CloseObservable {
  /** `err` is absent for a deliberate `close()`, present for an unbidden death. */
  onClose(listener: (err?: Error) => void): () => void
  close(): void
}

export interface ManagedConnectionOptions {
  /** First reconnect delay; doubles per consecutive failure. */
  initialDelayMs?: number
  /** Backoff ceiling. */
  maxDelayMs?: number
}

export interface ManagedConnection<C extends CloseObservable> {
  readonly state: ConnectionState
  /** The live client while connected, null otherwise. */
  readonly client: C | null
  /** Notified on every transition. `error` carries the cause when entering `disconnected`. */
  onStateChange(listener: (state: ConnectionState, error?: Error) => void): () => void
  /**
   * Resolve with a connected client: immediately when connected, after the
   * next successful attempt otherwise. Rejects once the manager is closed.
   * This is the natural `connect` factory for `persistentSubscription`.
   */
  acquire(): Promise<C>
  /** Stop reconnecting and close the live client. Terminal. */
  close(): void
}

/**
 * Own a connection's lifecycle: connect, observe death, reconnect with
 * exponential backoff, and surface the state machine consumers render
 * (e.g. a status item or a connection banner). Backoff resets on a
 * successful connect.
 *
 * The first connect starts synchronously, so the manager is already in
 * `connecting` when this returns — read it from the `state` getter to seed
 * a UI. `onStateChange` then reports every transition from there on; a
 * listener attached after the call does not receive that initial
 * `connecting` as an event.
 *
 * Most deaths are transient and trigger a reconnect. A `WireSchemaMismatchError`
 * death is the exception: it is fatal (reconnecting would hit the same stale
 * daemon), so the manager stops retrying, surfaces the error on the final
 * `disconnected` transition, and rejects `acquire()` with it from then on. The
 * fix is restarting the daemon; a consumer should render that, not a spinner.
 */
export function manageConnection<C extends CloseObservable>(
  connect: () => Promise<C>,
  options?: ManagedConnectionOptions,
): ManagedConnection<C> {
  const initialDelayMs = options?.initialDelayMs ?? 1_000
  const maxDelayMs = options?.maxDelayMs ?? 15_000
  let state: ConnectionState = 'disconnected'
  let client: C | null = null
  let closed = false
  // Set when a connection dies of a fatal, unrecoverable cause (a wire schema
  // mismatch): reconnecting would hit the same stale daemon and fail the same
  // way, so the manager stops retrying and `acquire()` rejects with it.
  // Distinct from `closed` (a deliberate user teardown).
  let fatalError: Error | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let failures = 0
  const listeners = new Set<(state: ConnectionState, error?: Error) => void>()
  const waiters: Array<{ resolve: (client: C) => void; reject: (err: Error) => void }> = []

  const transition = (next: ConnectionState, error?: Error): void => {
    state = next
    for (const listener of listeners) listener(next, error)
  }

  const scheduleRetry = (): void => {
    if (closed) return
    const delay = Math.min(initialDelayMs * 2 ** failures, maxDelayMs)
    failures++
    timer = setTimeout(() => {
      timer = null
      void open()
    }, delay)
  }

  const open = async (): Promise<void> => {
    if (closed) return
    transition('connecting')
    let next: C
    try {
      next = await connect()
    } catch (err) {
      transition('disconnected', err instanceof Error ? err : new Error(String(err)))
      scheduleRetry()
      return
    }
    if (closed) {
      next.close()
      return
    }
    failures = 0
    client = next
    next.onClose((err) => {
      if (client !== next) return
      client = null
      if (closed) return
      if (err instanceof WireSchemaMismatchError) {
        // Fatal: a wire schema mismatch poisons the protocol, not just this
        // connection. Reconnecting hits the same stale daemon and mismatches
        // again — the fix is restarting the daemon, not retrying. Stop here,
        // surface the error as terminal, and fail anyone awaiting a client.
        fatalError = err
        transition('disconnected', err)
        for (const waiter of waiters.splice(0)) waiter.reject(err)
        return
      }
      transition('disconnected', err)
      scheduleRetry()
    })
    transition('connected')
    for (const waiter of waiters.splice(0)) waiter.resolve(next)
  }

  void open()

  return {
    get state() {
      return state
    },
    get client() {
      return client
    },
    onStateChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    acquire() {
      // A fatal death is terminal like close(), but rejects with the real
      // cause so a caller can tell "stale daemon" from "manager torn down".
      if (fatalError) return Promise.reject(fatalError)
      if (closed) return Promise.reject(new Error('connection manager closed'))
      if (client) return Promise.resolve(client)
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject })
      })
    },
    close() {
      if (closed) return
      closed = true
      if (timer) clearTimeout(timer)
      const live = client
      client = null
      live?.close()
      transition('disconnected')
      for (const waiter of waiters.splice(0)) waiter.reject(new Error('connection manager closed'))
    },
  }
}
