import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  checkSchemaVersion,
  manageConnection,
  persistentSubscription,
  withReadCache,
  withReadyRetry,
  type CloseObservable,
  type ConnectionState,
  type FrameReader,
  type WireSubscriber,
} from '../src/hardening.ts'
import type { SubscribeHandlers } from '../src/wire.ts'
import { readDirEntries, type WireReader } from '../src/read-helpers.ts'
import { WireSchemaMismatchError, WIRE_SCHEMA_VERSION, type ResponseFrame } from '../src/wire.ts'

/** A reader not ready for the first `notReadyCount` reads, counting calls. */
function flakyReader(notReadyCount: number): WireReader & { calls: number } {
  const reader = {
    calls: 0,
    read(): Promise<ResponseFrame> {
      reader.calls++
      return Promise.resolve(
        reader.calls > notReadyCount
          ? // The ready result is the schema-17 envelope for a `dir_entries` read
            // (the one test that unwraps this payload issues `readDirEntries`).
            { type: 'response', schema_version: 29, ready: true, version: 9, result: { dir_entries: [] } }
          : { type: 'response', schema_version: 29, ready: false },
      )
    },
  }
  return reader
}

/** Narrow the transport union to a response frame. */
function frame(response: ResponseFrame | { ok: boolean }): ResponseFrame {
  if (!('type' in response)) throw new Error('expected a response frame')
  return response
}

describe('withReadyRetry', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('passes a ready response through without delay', async () => {
    const reader = flakyReader(0)
    const response = await withReadyRetry(reader).read({ read: 'children', dir: '/v' })
    expect(frame(response).ready).toBe(true)
    expect(reader.calls).toBe(1)
  })

  it('polls not-ready responses at the configured cadence', async () => {
    const reader = flakyReader(3)
    const pending = withReadyRetry(reader, { delayMs: 50 }).read({ read: 'ready' })
    await vi.advanceTimersByTimeAsync(150)
    const response = await pending
    expect(frame(response).ready).toBe(true)
    expect(reader.calls).toBe(4)
  })

  it('returns the last not-ready response when attempts run out', async () => {
    const reader = flakyReader(Infinity)
    const pending = withReadyRetry(reader, { attempts: 5, delayMs: 10 }).read({ read: 'ready' })
    await vi.advanceTimersByTimeAsync(40)
    const response = await pending
    expect(frame(response).ready).toBe(false)
    expect(reader.calls).toBe(5)
  })

  it('does not retry in-band errors', async () => {
    let calls = 0
    const failing: WireReader = {
      read() {
        calls++
        return Promise.resolve({ ok: false as const, error: 'unknown read' })
      },
    }
    const response = await withReadyRetry(failing).read({ read: 'nope' })
    expect(response).toEqual({ ok: false, error: 'unknown read' })
    expect(calls).toBe(1)
  })

  it('does not retry rejections', async () => {
    let calls = 0
    const rejecting: WireReader = {
      read() {
        calls++
        return Promise.reject(new Error('connection lost'))
      },
    }
    await expect(withReadyRetry(rejecting).read({ read: 'ready' })).rejects.toThrow('connection lost')
    expect(calls).toBe(1)
  })

  it('composes with the typed helpers', async () => {
    const reader = flakyReader(2)
    const pending = readDirEntries(withReadyRetry(reader, { delayMs: 10 }), '/v')
    await vi.advanceTimersByTimeAsync(20)
    expect(await pending).toEqual({ ready: true, version: 9, result: [] })
  })
})

/** A reader serving `version`, counting calls, optionally deferred. */
function versionedReader(version: () => number): WireReader & { calls: number } {
  const reader = {
    calls: 0,
    read(request: object): Promise<ResponseFrame> {
      reader.calls++
      return Promise.resolve({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: version(),
        result: { echo: request },
      })
    },
  }
  return reader
}

describe('withReadCache', () => {
  it('serves a repeat read from the cache', async () => {
    const reader = versionedReader(() => 5)
    const cached = withReadCache(reader)
    const first = await cached.read({ read: 'types' })
    const second = await cached.read({ read: 'types' })
    expect(reader.calls).toBe(1)
    expect(second).toBe(first)
  })

  it('keys by op and args, key order irrelevant', async () => {
    const reader = versionedReader(() => 5)
    const cached = withReadCache(reader)
    await cached.read({ read: 'diagnostics', path: 'a.md', severity: 'error' })
    await cached.read({ severity: 'error', path: 'a.md', read: 'diagnostics' })
    expect(reader.calls).toBe(1)
    await cached.read({ read: 'diagnostics', path: 'b.md' })
    expect(reader.calls).toBe(2)
  })

  it('coalesces identical in-flight reads into one round trip', async () => {
    let resolveRead!: (f: ResponseFrame) => void
    let calls = 0
    const slow: WireReader = {
      read() {
        calls++
        return new Promise((r) => (resolveRead = r))
      },
    }
    const cached = withReadCache(slow)
    const a = cached.read({ read: 'types' })
    const b = cached.read({ read: 'types' })
    resolveRead({ type: 'response', schema_version: 29, ready: true, version: 1, result: [] })
    expect(await a).toBe(await b)
    expect(calls).toBe(1)
  })

  it('drops stale entries when a response carries a newer version', async () => {
    let version = 5
    const reader = versionedReader(() => version)
    const cached = withReadCache(reader)
    await cached.read({ read: 'types' })
    version = 6
    await cached.read({ read: 'children', dir: '/v' }) // observes v6 → v5 entry drops
    await cached.read({ read: 'types' })
    expect(reader.calls).toBe(3)
  })

  it('drops stale entries on advanceTo, e.g. from a change event', async () => {
    const reader = versionedReader(() => 5)
    const cached = withReadCache(reader)
    await cached.read({ read: 'types' })
    cached.advanceTo(6)
    await cached.read({ read: 'types' })
    expect(reader.calls).toBe(2)
  })

  it('clear drops everything', async () => {
    const reader = versionedReader(() => 5)
    const cached = withReadCache(reader)
    await cached.read({ read: 'types' })
    cached.clear()
    await cached.read({ read: 'types' })
    expect(reader.calls).toBe(2)
  })

  it('clear resets the version baseline so a lower-versioned reconnect still caches', async () => {
    let version = 100
    const reader = versionedReader(() => version)
    const cached = withReadCache(reader)
    await cached.read({ read: 'types' }) // baseline → 100
    cached.clear() // reconnect: versions restart lower
    version = 2
    await cached.read({ read: 'types' }) // observes v2, must cache despite 2 < 100
    await cached.read({ read: 'types' }) // served from cache
    expect(reader.calls).toBe(2)
  })

  it('clear abandons an in-flight read: no coalesce, no stale cache', async () => {
    let resolveRead!: (f: ResponseFrame) => void
    let calls = 0
    const slow: WireReader = {
      read() {
        calls++
        return calls === 1
          ? new Promise((r) => (resolveRead = r))
          : Promise.resolve({ type: 'response', schema_version: 29, ready: true, version: 9, result: 'fresh' } as ResponseFrame)
      },
    }
    const cached = withReadCache(slow)
    const pre = cached.read({ read: 'types' }) // in flight at clear time
    cached.clear()
    const post = cached.read({ read: 'types' }) // must not coalesce onto `pre`
    // Settle the pre-clear read last, with old-connection data.
    resolveRead({ type: 'response', schema_version: 29, ready: true, version: 5, result: 'stale' })

    expect((await pre as ResponseFrame).result).toBe('stale') // still resolves, just not cached
    expect((await post as ResponseFrame).result).toBe('fresh')
    expect(calls).toBe(2)
    // The abandoned pre-clear result must not have populated the cache.
    const again = await cached.read({ read: 'types' })
    expect((again as ResponseFrame).result).toBe('fresh')
    expect(calls).toBe(2)
  })

  it('never caches not-ready responses or in-band errors', async () => {
    let calls = 0
    const notReady: WireReader = {
      read() {
        calls++
        return Promise.resolve({ type: 'response', schema_version: 29, ready: false } as ResponseFrame)
      },
    }
    const cached = withReadCache(notReady)
    await cached.read({ read: 'types' })
    await cached.read({ read: 'types' })
    expect(calls).toBe(2)

    let errorCalls = 0
    const erroring: WireReader = {
      read() {
        errorCalls++
        return Promise.resolve({ ok: false as const, error: 'nope' })
      },
    }
    const cachedErr = withReadCache(erroring)
    await cachedErr.read({ read: 'types' })
    await cachedErr.read({ read: 'types' })
    expect(errorCalls).toBe(2)
  })

  it('a rejection clears the in-flight slot for the next attempt', async () => {
    let calls = 0
    const failing: WireReader = {
      read() {
        calls++
        return calls === 1
          ? Promise.reject(new Error('socket died'))
          : Promise.resolve({ type: 'response', schema_version: 29, ready: true, version: 1, result: [] } as ResponseFrame)
      },
    }
    const cached = withReadCache(failing)
    await expect(cached.read({ read: 'types' })).rejects.toThrow('socket died')
    const retry = await cached.read({ read: 'types' })
    expect('ready' in retry && retry.ready).toBe(true)
    expect(calls).toBe(2)
  })

  it('stacks with withReadyRetry and the typed helpers', async () => {
    const reader = versionedReader(() => 3)
    const hardened = withReadCache(withReadyRetry(reader, { delayMs: 1 }))
    const outcome = await readDirEntries(hardened, '/v')
    expect('ready' in outcome && outcome.ready).toBe(true)
    await readDirEntries(hardened, '/v')
    expect(reader.calls).toBe(1)
  })
})

describe('checkSchemaVersion', () => {
  const speaking = (schema_version: number): FrameReader => ({
    read: () =>
      Promise.resolve({ type: 'response', schema_version, ready: false, result: { engine: 'running' } } as ResponseFrame),
  })

  it('accepts a matching daemon, even while deriving', async () => {
    const check = await checkSchemaVersion(speaking(WIRE_SCHEMA_VERSION))
    expect(check).toEqual({ ok: true, schemaVersion: WIRE_SCHEMA_VERSION })
  })

  it('rejects a newer daemon, pointing at the consumer', async () => {
    const check = await checkSchemaVersion(speaking(99))
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.schemaVersion).toBe(99)
    expect(check.error).toContain('daemon speaks schema_version 99')
    expect(check.error).toContain(`expects ${WIRE_SCHEMA_VERSION}`)
    expect(check.error).toContain('update the consumer')
  })

  it('rejects an older daemon, pointing at the daemon', async () => {
    const check = await checkSchemaVersion(speaking(1), 4)
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.error).toContain('update the daemon')
  })
})

/** A scriptable subscriber: each connect() hands out a session to drive manually. */
function subscriberRig() {
  const sessions: Array<{
    handlers: SubscribeHandlers
    detached: boolean
    accept(subscription_id?: number): void
    reject(error: string): void
    initial(result: unknown, at_version: number): void
    die(): void
    dieFatal(): void
  }> = []
  let connectFailures = 0

  const subscriber: WireSubscriber = {
    subscribe(_request, handlers) {
      const session = {
        handlers,
        detached: false,
        accept(subscription_id = 1) {
          handlers.onAck?.({ type: 'ack', schema_version: 29, subscription_id, channel: 'ready', accepted: true })
        },
        reject(error: string) {
          // v4: a refused subscribe is an error frame the client routes to
          // onClose with reason 'rejected' (no ack), not an ack{accepted:false}.
          handlers.onClose?.(error, 'rejected')
        },
        initial(result: unknown, at_version: number) {
          handlers.onInitialValue?.({ type: 'initial_value', schema_version: 29, subscription_id: 1, at_version, result })
        },
        die() {
          handlers.onClose?.('daemon connection closed', 'transient')
        },
        dieFatal() {
          // A wire schema mismatch tore down the connection: a `fatal` close.
          handlers.onClose?.('wire schema mismatch', 'fatal')
        },
      }
      sessions.push(session)
      return () => {
        session.detached = true
      }
    },
  }

  return {
    sessions,
    failConnects(n: number) {
      connectFailures = n
    },
    connect(): Promise<WireSubscriber> {
      if (connectFailures > 0) {
        connectFailures--
        return Promise.reject(new Error('socket absent'))
      }
      return Promise.resolve(subscriber)
    },
  }
}

describe('persistentSubscription', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('forwards ack, initial value, and change events', async () => {
    const rig = subscriberRig()
    const seen: string[] = []
    persistentSubscription(rig.connect, { subscribe: 'ready' }, {
      onAck: (f) => seen.push(`ack:${f.accepted}`),
      onInitialValue: (f) => seen.push(`initial:${f.at_version}`),
      onChangeEvent: (f) => seen.push(`change:${f.kind}`),
    })
    await vi.advanceTimersByTimeAsync(0)
    const session = rig.sessions[0]!
    session.accept()
    session.initial({ engine: 'running' }, 4)
    session.handlers.onChangeEvent?.({ type: 'change_event', schema_version: 29, subscription_id: 1, kind: 'ready-changed', at_version: 5 })
    expect(seen).toEqual(['ack:true', 'initial:4', 'change:ready-changed'])
  })

  it('re-subscribes after connection death and re-delivers the initial value', async () => {
    const rig = subscriberRig()
    const initials: number[] = []
    persistentSubscription(rig.connect, { subscribe: 'ready' }, {
      onInitialValue: (f) => initials.push(f.at_version),
    })
    await vi.advanceTimersByTimeAsync(0)
    rig.sessions[0]!.accept()
    rig.sessions[0]!.initial({}, 4)
    rig.sessions[0]!.die()
    await vi.advanceTimersByTimeAsync(1_000) // first retry after 1s
    expect(rig.sessions).toHaveLength(2)
    rig.sessions[1]!.accept()
    rig.sessions[1]!.initial({}, 9)
    expect(initials).toEqual([4, 9])
  })

  it('backs off exponentially to the cap while connects fail, resets on ack', async () => {
    const rig = subscriberRig()
    rig.failConnects(6)
    const delays: number[] = []
    persistentSubscription(rig.connect, { subscribe: 'ready' }, {}, {
      onRetry: (_attempt, delayMs) => delays.push(delayMs),
    })
    // initial connect fails → 1s, then 2s, 4s, 8s, 15s (capped), 15s
    for (const wait of [0, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000]) {
      await vi.advanceTimersByTimeAsync(wait)
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000])
    expect(rig.sessions).toHaveLength(1)
    rig.sessions[0]!.accept()
    rig.sessions[0]!.die()
    await vi.advanceTimersByTimeAsync(1_000) // backoff reset by the accepted ack
    expect(rig.sessions).toHaveLength(2)
  })

  it('a refused subscribe is permanent: onClose fires rejected, no retry', async () => {
    const rig = subscriberRig()
    const closes: Array<{ error: string; reason: string }> = []
    persistentSubscription(rig.connect, { subscribe: 'nope' }, {
      onClose: (error, reason) => closes.push({ error, reason }),
    })
    await vi.advanceTimersByTimeAsync(0)
    rig.sessions[0]!.reject('unknown channel')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(closes).toEqual([{ error: 'unknown channel', reason: 'rejected' }])
    expect(rig.sessions).toHaveLength(1)
  })

  it('a fatal connection death is permanent: onClose fires fatal, no resubscribe', async () => {
    const rig = subscriberRig()
    const closes: Array<{ error: string; reason: string }> = []
    persistentSubscription(rig.connect, { subscribe: 'ready' }, {
      onClose: (error, reason) => closes.push({ error, reason }),
    })
    await vi.advanceTimersByTimeAsync(0)
    rig.sessions[0]!.accept()
    // The connection dies of a schema mismatch — fatal, not transient.
    rig.sessions[0]!.dieFatal()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(closes).toEqual([{ error: 'wire schema mismatch', reason: 'fatal' }])
    // No resubscribe attempt followed.
    expect(rig.sessions).toHaveLength(1)
  })

  it('stops resubscribing when the connect factory rejects fatal (shared manager went terminal)', async () => {
    // The shared-client case: a transient session death triggers a retry, but
    // the next connect() rejects with the fatal error (a manageConnection that
    // went terminal). persistentSubscription must end, not loop.
    const rig = subscriberRig()
    let calls = 0
    const closes: Array<{ error: string; reason: string }> = []
    persistentSubscription(
      () => {
        calls++
        if (calls === 1) return rig.connect()
        return Promise.reject(new WireSchemaMismatchError(3))
      },
      { subscribe: 'ready' },
      { onClose: (error, reason) => closes.push({ error, reason }) },
    )
    await vi.advanceTimersByTimeAsync(0)
    rig.sessions[0]!.accept()
    // A transient death triggers a reconnect; the next connect() rejects fatal.
    rig.sessions[0]!.die()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(closes).toEqual([{ error: new WireSchemaMismatchError(3).message, reason: 'fatal' }])
    expect(rig.sessions).toHaveLength(1) // no second subscribe
  })

  it('stop detaches and cancels pending retries', async () => {
    const rig = subscriberRig()
    const stop = persistentSubscription(rig.connect, { subscribe: 'ready' }, {})
    await vi.advanceTimersByTimeAsync(0)
    rig.sessions[0]!.accept()
    rig.sessions[0]!.die()
    stop() // a retry is pending; stop must cancel it
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rig.sessions).toHaveLength(1)

    const rig2 = subscriberRig()
    const stop2 = persistentSubscription(rig2.connect, { subscribe: 'ready' }, {})
    await vi.advanceTimersByTimeAsync(0)
    stop2() // live subscription: stop detaches
    expect(rig2.sessions[0]!.detached).toBe(true)
  })
})

/** A scriptable close-observable client rig. */
function clientRig() {
  const clients: Array<CloseObservable & { die(err?: Error): void; closedByManager: boolean }> = []
  let connectFailures = 0
  return {
    clients,
    failConnects(n: number) {
      connectFailures = n
    },
    connect(): Promise<CloseObservable> {
      if (connectFailures > 0) {
        connectFailures--
        return Promise.reject(new Error('socket absent'))
      }
      const listeners = new Set<(err?: Error) => void>()
      const fake = {
        closedByManager: false,
        onClose(listener: (err?: Error) => void) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        close() {
          fake.closedByManager = true
        },
        die(err = new Error('daemon connection closed')) {
          for (const l of listeners) l(err)
        },
      }
      clients.push(fake)
      return Promise.resolve(fake)
    },
  }
}

describe('manageConnection', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('walks disconnected → connecting → connected and exposes the client', async () => {
    const rig = clientRig()
    const states: ConnectionState[] = []
    const manager = manageConnection(rig.connect)
    manager.onStateChange((s) => states.push(s))
    expect(manager.state).toBe('connecting')
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.state).toBe('connected')
    expect(manager.client).toBe(rig.clients[0])
    expect(states).toEqual(['connected'])
  })

  it('reconnects after death with backoff, reset on success', async () => {
    const rig = clientRig()
    const states: Array<ConnectionState | string> = []
    const manager = manageConnection(rig.connect)
    manager.onStateChange((s, err) => states.push(err ? `${s}:${err.message}` : s))
    await vi.advanceTimersByTimeAsync(0)
    rig.clients[0]!.die()
    expect(manager.state).toBe('disconnected')
    expect(manager.client).toBeNull()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(manager.state).toBe('connected')
    expect(manager.client).toBe(rig.clients[1])
    expect(states).toEqual(['connected', 'disconnected:daemon connection closed', 'connecting', 'connected'])
  })

  it('backs off exponentially while connects fail', async () => {
    const rig = clientRig()
    rig.failConnects(4)
    const manager = manageConnection(rig.connect)
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.state).toBe('disconnected')
    for (const wait of [1_000, 2_000, 4_000, 8_000]) {
      await vi.advanceTimersByTimeAsync(wait)
    }
    expect(manager.state).toBe('connected')
    expect(rig.clients).toHaveLength(1)
  })

  it('acquire resolves now when connected, later across a reconnect', async () => {
    const rig = clientRig()
    const manager = manageConnection(rig.connect)
    await vi.advanceTimersByTimeAsync(0)
    expect(await manager.acquire()).toBe(rig.clients[0])
    rig.clients[0]!.die()
    const waiting = manager.acquire()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await waiting).toBe(rig.clients[1])
  })

  it('close is terminal: live client closed, waiters rejected, no retries', async () => {
    const rig = clientRig()
    const manager = manageConnection(rig.connect)
    await vi.advanceTimersByTimeAsync(0)
    manager.close()
    expect(rig.clients[0]!.closedByManager).toBe(true)
    expect(manager.state).toBe('disconnected')
    await expect(manager.acquire()).rejects.toThrow('connection manager closed')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rig.clients).toHaveLength(1)
  })

  it('a schema-mismatch death is fatal: stops retrying, acquire rejects with it', async () => {
    const rig = clientRig()
    const states: Array<ConnectionState | string> = []
    const manager = manageConnection(rig.connect)
    manager.onStateChange((s, err) => states.push(err ? `${s}:${err.name}` : s))
    await vi.advanceTimersByTimeAsync(0)

    const fatal = new WireSchemaMismatchError(3)
    rig.clients[0]!.die(fatal)
    expect(manager.state).toBe('disconnected')
    expect(manager.client).toBeNull()

    // No reconnect attempt, ever — the stale daemon would only mismatch again.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rig.clients).toHaveLength(1)
    // The terminal transition carries the fatal error...
    expect(states).toEqual(['connected', 'disconnected:WireSchemaMismatchError'])
    // ...and acquire rejects with the cause itself, not the generic closed reason.
    await expect(manager.acquire()).rejects.toBe(fatal)
  })

  it('feeds persistentSubscription as its connect factory', async () => {
    const clientRigInstance = clientRig()
    const subRig = subscriberRig()
    // A client that is both close-observable and subscribable.
    const connect = async (): Promise<CloseObservable & WireSubscriber> => {
      const base = (await clientRigInstance.connect()) as CloseObservable & { die(): void }
      const sub = await subRig.connect()
      return { ...base, subscribe: sub.subscribe.bind(sub) }
    }
    const manager = manageConnection(connect)
    const initials: number[] = []
    persistentSubscription(() => manager.acquire(), { subscribe: 'ready' }, {
      onInitialValue: (f) => initials.push(f.at_version),
    })
    await vi.advanceTimersByTimeAsync(0)
    subRig.sessions[0]!.accept()
    subRig.sessions[0]!.initial({}, 1)
    // The connection dies: manager reconnects, subscription re-acquires.
    clientRigInstance.clients[0]!.die()
    subRig.sessions[0]!.die()
    await vi.advanceTimersByTimeAsync(1_000)
    subRig.sessions[1]!.accept()
    subRig.sessions[1]!.initial({}, 2)
    expect(initials).toEqual([1, 2])
  })
})
