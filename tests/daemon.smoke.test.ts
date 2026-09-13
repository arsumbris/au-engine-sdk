// Smoke suite against a real daemon, per CLAUDE.md: the wire is the
// contract, test against it, not assumptions.
//
// Covers the transport surface: ready probe, response envelope, error
// frames, and the subscribe lifecycle. The read catalog rides
// `read-helpers.smoke.test.ts`. Harness in `live-daemon.ts`.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { probeReady } from '../src/client.ts'
import { checkSchemaVersion } from '../src/hardening.ts'
import { WIRE_SCHEMA_VERSION } from '../src/wire.ts'
import {
  subscribeDiagnostics,
  subscribeLinkGraph,
  subscribeTypeGraph,
  type DiagnosticsHint,
  type LinkGraphHint,
  type TypeGraphHint,
  toTypedSubscriber,
} from '../src/subscribe-helpers.ts'
import type { WireDiagnostic, WireLinkGraph, WireTypeGraph } from '../src/reads.ts'
import type { AckFrame, ChangeEventFrame, InitialValueFrame } from '../src/wire.ts'
import { binaryPresent, type LiveDaemon, startLiveDaemon, within } from './live-daemon.ts'

describe.skipIf(!binaryPresent)('live daemon smoke', () => {
  let live: LiveDaemon

  beforeAll(async () => {
    live = await startLiveDaemon()
  }, 30_000)

  afterAll(async () => {
    await live?.stop()
  }, 15_000)

  it('answers the ready probe with version and engine state', async () => {
    const probe = await probeReady(live.entry)
    expect(probe).not.toBeNull()
    expect(probe?.ready).toBe(true)
    expect(typeof probe?.version).toBe('number')
    expect(typeof probe?.engine).toBe('string')
  })

  it('speaks the schema version this SDK mirrors', async () => {
    // A mismatch here means the engine bumped the wire and the SDK must
    // catch up: update WIRE_SCHEMA_VERSION after re-verifying the shapes.
    const check = await checkSchemaVersion(live.client)
    // Assert against the SDK's own constant so this never goes stale on a bump.
    expect(check).toEqual({ ok: true, schemaVersion: WIRE_SCHEMA_VERSION })
  })

  it('serves a read in the response envelope, echoing the correlation id', async () => {
    const response = await live.client.read({ read: 'dir_entries', dir: live.entry })
    expect(response.type).toBe('response')
    expect(response.ready).toBe(true)
    expect(typeof response.version).toBe('number')
    expect(typeof response.id).toBe('number') // the daemon echoes the id we sent (v4)
    // schema 17: the payload rides under the read's own verb key (result[verb]).
    const envelope = response.result as { dir_entries: Array<{ path: string; name: string; kind: string }> }
    expect(envelope.dir_entries.some((e) => e.name === 'content' && e.kind === 'directory')).toBe(true)
  })

  it('rejects an unknown read with an error frame', async () => {
    await expect(live.client.read({ read: 'no-such-read' })).rejects.toThrow()
  })

  it('refuses an unknown channel as an error frame, not an ack', async () => {
    // v4: a bad channel is an error frame (for: 'subscribe'), so the client
    // routes it to onClose(reason: 'rejected') with no ack — never ack{accepted:false}.
    let acked = false
    const closed = new Promise<string>((resolve) => {
      live.client.subscribe(
        { subscribe: 'no-such-channel' },
        { onAck: () => (acked = true), onClose: (_error, reason) => resolve(reason) },
      )
    })
    expect(await within(5_000, 'subscribe refusal', closed)).toBe('rejected')
    expect(acked).toBe(false)
  })

  it('runs the subscribe lifecycle: ack, initial value, change event', async () => {
    let resolveAck!: (f: AckFrame) => void
    let resolveInitial!: (f: InitialValueFrame) => void
    let resolveChange!: (f: ChangeEventFrame) => void
    const ack = new Promise<AckFrame>((r) => (resolveAck = r))
    const initial = new Promise<InitialValueFrame>((r) => (resolveInitial = r))
    const change = new Promise<ChangeEventFrame>((r) => (resolveChange = r))

    const detach = live.client.subscribe(
      { subscribe: 'files' },
      { onAck: resolveAck, onInitialValue: resolveInitial, onChangeEvent: resolveChange },
    )

    try {
      const ackFrame = await within(5_000, 'ack', ack)
      expect(ackFrame.accepted).toBe(true)
      expect(ackFrame.channel).toBe('files')
      expect(typeof ackFrame.id).toBe('number') // the ack echoes the subscribe's id (v4)

      const initialFrame = await within(5_000, 'initial value', initial)
      expect(typeof initialFrame.at_version).toBe('number')
      const files = initialFrame.result as Array<{ path: string }>
      expect(files.length).toBeGreaterThan(0)
      expect(files.every((f) => path.isAbsolute(f.path))).toBe(true)

      // An external edit: the watcher rebuilds and the channel fires.
      const newFile = path.join(live.entry, 'content', 'smoke-probe.md')
      fs.writeFileSync(newFile, '# smoke probe\n')
      const changeFrame = await within(10_000, 'change event', change)
      expect(changeFrame.kind).toBe('files-changed')
      expect(changeFrame.at_version).toBeGreaterThan(initialFrame.at_version)
      const hint = changeFrame.scope_hint as { added?: string[] }
      expect(hint.added).toContain(newFile)
    } finally {
      detach()
    }
  }, 20_000)

  it('subscribeDiagnostics delivers a typed initial value and changed-files hint', async () => {
    const typed = toTypedSubscriber(live.client)
    let resolveInitial!: (d: WireDiagnostic[]) => void
    let resolveHint!: (h: DiagnosticsHint) => void
    const initial = new Promise<WireDiagnostic[]>((r) => (resolveInitial = r))
    const changed = new Promise<DiagnosticsHint>((r) => (resolveHint = r))

    const detach = subscribeDiagnostics(typed, (event) => {
      if (event.kind === 'initial-value') resolveInitial(event.result)
      else if (event.kind === 'change') resolveHint(event.scopeHint)
    })

    try {
      // The entry repo's broken/ files guarantee a non-empty initial set, typed.
      const diagnostics = await within(5_000, 'initial diagnostics', initial)
      expect(diagnostics.length).toBeGreaterThan(0)
      for (const d of diagnostics) {
        expect(typeof d.code).toBe('string')
        expect(['error', 'drift', 'warning', 'hint']).toContain(d.severity)
        expect(typeof d.span.file).toBe('string')
      }

      // Introduce a fresh error: a new broken file changes the in-scope set.
      const brokenFile = path.join(live.entry, 'content', 'broken', 'smoke-typed.md')
      fs.writeFileSync(brokenFile, '---\ntype: no-such-type\n---\n')
      const hint = await within(10_000, 'diagnostics-changed hint', changed)
      expect(hint.scope).toBe('files')
      expect(hint.files).toContain(brokenFile)
    } finally {
      detach()
    }
  }, 20_000)

  it('subscribeLinkGraph delivers the full payload then a node/edge delta hint', async () => {
    const typed = toTypedSubscriber(live.client)
    let resolveInitial!: (g: WireLinkGraph) => void
    let resolveHint!: (h: LinkGraphHint) => void
    const initial = new Promise<WireLinkGraph>((r) => (resolveInitial = r))
    const changed = new Promise<LinkGraphHint>((r) => (resolveHint = r))

    const detach = subscribeLinkGraph(typed, (event) => {
      if (event.kind === 'initial-value') resolveInitial(event.result)
      else if (event.kind === 'change') resolveHint(event.scopeHint)
    })

    try {
      // The initial value is the full link_graph payload, typed.
      const graph = await within(5_000, 'initial link graph', initial)
      expect(graph.scope).toBe('own')
      expect(graph.nodes.length).toBeGreaterThan(0)
      for (const n of graph.nodes) {
        expect(['instance', 'type-def', 'note', 'asset']).toContain(n.kind)
      }

      // A new content file adds a node; the channel streams the delta directly.
      const newFile = path.join(live.entry, 'content', 'link-graph-probe.md')
      fs.writeFileSync(newFile, '# link graph probe\n')
      const delta = await within(10_000, 'link-graph-changed hint', changed)
      expect(delta.scope).toBe('link_graph')
      expect(delta.nodes_added.some((n) => n.path === newFile)).toBe(true)
    } finally {
      detach()
    }
  }, 20_000)

  it('subscribeTypeGraph delivers the full schema-graph payload, typed', async () => {
    const typed = toTypedSubscriber(live.client)
    let resolveInitial!: (g: WireTypeGraph) => void
    const initial = new Promise<WireTypeGraph>((r) => (resolveInitial = r))
    // TypeGraphHint referenced for its live shape at the callback edge.
    const detach = subscribeTypeGraph(
      typed,
      (event) => {
        if (event.kind === 'initial-value') resolveInitial(event.result)
      },
      { edges: ['subtype', 'field-type', 'instance-of'] },
    )

    try {
      const graph = await within(5_000, 'initial type graph', initial)
      expect(graph.scope).toBe('own')
      expect(Array.isArray(graph.nodes)).toBe(true)
      for (const n of graph.nodes) {
        expect(['type-def', 'instance']).toContain(n.kind)
      }
      // every edge endpoint is an in-scope node (induced-subgraph rule).
      const paths = new Set(graph.nodes.map((n) => n.path))
      const hint: TypeGraphHint['scope'] = 'type_graph'
      expect(hint).toBe('type_graph')
      for (const e of graph.edges) {
        expect(paths.has(e.from)).toBe(true)
        expect(paths.has(e.to)).toBe(true)
        expect(['subtype', 'field-type', 'instance-of']).toContain(e.relation)
        expect(e.count).toBeGreaterThanOrEqual(1)
      }
    } finally {
      detach()
    }
  }, 20_000)
})
