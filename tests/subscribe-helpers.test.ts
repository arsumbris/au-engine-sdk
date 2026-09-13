import { describe, expect, it } from 'vitest'

import type { SubscribeHandlers, SubscriptionEvent } from '../src/wire.ts'
import {
  subscribeChanges,
  subscribeDiagnostics,
  subscribeLifecycle,
  subscribeFiles,
  subscribeLinkGraph,
  subscribeRecentCommits,
  subscribeTypeGraph,
  toTypedSubscriber,
  type LinkGraphHint,
  type RawFrameSubscriber,
  type RecentCommitsHint,
  type TypeGraphHint,
  type TypedSubscriber,
  type TypedSubscriptionEvent,
} from '../src/subscribe-helpers.ts'
import type { WireLinkGraph, WireRecentCommit, WireTypeGraph } from '../src/reads.ts'

// The MountHost.engine-is-a-TypedSubscriber cross-check lives in au-host-sdk now.

/** A subscriber that hands back a driver to push normalized events. */
function typedRig() {
  let sink: ((event: SubscriptionEvent) => void) | null = null
  let detached = false
  const subscriber: TypedSubscriber & { last?: object } = {
    subscribe(request, onEvent) {
      subscriber.last = request
      sink = onEvent
      return () => {
        detached = true
      }
    },
  }
  return {
    subscriber,
    get detached() {
      return detached
    },
    emit(event: SubscriptionEvent) {
      sink?.(event)
    },
  }
}

describe('typed subscribe helpers', () => {
  it('issues the channel request shape and includes filters', () => {
    const rig = typedRig()
    subscribeDiagnostics(rig.subscriber, () => {}, { severity: 'error' })
    expect(rig.subscriber.last).toEqual({ subscribe: 'diagnostics', severity: 'error' })

    const plain = typedRig()
    subscribeLifecycle(plain.subscriber, () => {})
    expect(plain.subscriber.last).toEqual({ subscribe: 'lifecycle' })
  })

  it('routes a typed initial value and change event', () => {
    const rig = typedRig()
    const events: Array<TypedSubscriptionEvent<unknown, unknown>> = []
    subscribeFiles(rig.subscriber, (e) => events.push(e))

    rig.emit({ kind: 'initial-value', atVersion: 4, result: [{ path: '/v/a.md' }] })
    rig.emit({
      kind: 'change',
      changeKind: 'files-changed',
      atVersion: 5,
      scopeHint: { scope: 'files', added: ['/v/b.md'], removed: [] },
    })
    rig.emit({ kind: 'closed', error: 'gone', reason: 'transient' })

    expect(events).toEqual([
      { kind: 'initial-value', atVersion: 4, result: [{ path: '/v/a.md' }] },
      {
        kind: 'change',
        changeKind: 'files-changed',
        atVersion: 5,
        scopeHint: { scope: 'files', added: ['/v/b.md'], removed: [] },
      },
      { kind: 'closed', error: 'gone', reason: 'transient' },
    ])
  })

  it('types the changes channel hint (no initial value)', () => {
    const rig = typedRig()
    let modified: string[] = []
    subscribeChanges(rig.subscriber, (e) => {
      if (e.kind === 'change') modified = e.scopeHint.modified
    })
    rig.emit({
      kind: 'change',
      changeKind: 'knowledge-base-changed',
      atVersion: 9,
      scopeHint: { scope: 'files', added: [], removed: [], modified: ['/v/c.md'] },
    })
    expect(modified).toEqual(['/v/c.md'])
  })

  it('issues the link_graph channel shape, args spread when given', () => {
    const bare = typedRig()
    subscribeLinkGraph(bare.subscriber, () => {})
    expect(bare.subscriber.last).toEqual({ subscribe: 'link_graph' })

    const scoped = typedRig()
    subscribeLinkGraph(scoped.subscriber, () => {}, { repo: 'notes', scope: 'all' })
    expect(scoped.subscriber.last).toEqual({ subscribe: 'link_graph', repo: 'notes', scope: 'all' })
  })

  it('issues the type_graph channel shape, edges arg spread when given', () => {
    const bare = typedRig()
    subscribeTypeGraph(bare.subscriber, () => {})
    expect(bare.subscriber.last).toEqual({ subscribe: 'type_graph' })

    const scoped = typedRig()
    subscribeTypeGraph(scoped.subscriber, () => {}, { repo: 'notes', edges: ['subtype', 'instance-of'] })
    expect(scoped.subscriber.last).toEqual({
      subscribe: 'type_graph',
      repo: 'notes',
      edges: ['subtype', 'instance-of'],
    })
  })

  it('routes the type_graph initial payload and the schema-graph delta hint', () => {
    const rig = typedRig()
    let initial: WireTypeGraph | null = null
    let hint: TypeGraphHint | null = null
    subscribeTypeGraph(rig.subscriber, (e) => {
      if (e.kind === 'initial-value') initial = e.result
      else if (e.kind === 'change') hint = e.scopeHint
    })

    rig.emit({
      kind: 'initial-value',
      atVersion: 2,
      result: {
        repo: null,
        scope: 'own',
        nodes: [{ path: '/v/T.md', repo: 'v', kind: 'type-def' }],
        edges: [{ from: '/v/S.md', to: '/v/T.md', relation: 'subtype', count: 1 }],
      },
    })
    rig.emit({
      kind: 'change',
      changeKind: 'type-graph-changed',
      atVersion: 3,
      scopeHint: {
        scope: 'type_graph',
        nodes_added: [{ path: '/v/U.md', repo: 'v', kind: 'instance' }],
        nodes_removed: ['/v/T.md'],
        // a count change re-emits the SAME edge key in edges_added only (UPSERT)
        edges_added: [{ from: '/v/S.md', to: '/v/T.md', relation: 'field-type', count: 3 }],
        edges_removed: [],
      },
    })

    expect(initial!.nodes[0]!.kind).toBe('type-def')
    expect(hint!.scope).toBe('type_graph')
    expect(hint!.nodes_added[0]!.kind).toBe('instance')
    expect(hint!.edges_added[0]!.count).toBe(3)
    expect(hint!.edges_removed).toEqual([])
  })

  it('routes the link_graph initial payload and the node/edge delta hint', () => {
    const rig = typedRig()
    let initial: WireLinkGraph | null = null
    let hint: LinkGraphHint | null = null
    subscribeLinkGraph(rig.subscriber, (e) => {
      if (e.kind === 'initial-value') initial = e.result
      else if (e.kind === 'change') hint = e.scopeHint
    })

    rig.emit({
      kind: 'initial-value',
      atVersion: 2,
      result: {
        repo: null,
        scope: 'own',
        nodes: [{ path: '/v/a.md', repo: 'v', kind: 'note', refs_structural: 0, refs_total: 1 }],
        edges: [{ from: '/v/b.md', to: '/v/a.md', kind: 'navigational', surface: 'body' }],
      },
    })
    rig.emit({
      kind: 'change',
      changeKind: 'link-graph-changed',
      atVersion: 3,
      scopeHint: {
        scope: 'link_graph',
        nodes_added: [{ path: '/v/c.md', repo: 'v', kind: 'instance', refs_structural: 1, refs_total: 1 }],
        nodes_removed: ['/v/a.md'],
        edges_added: [{ from: '/v/c.md', to: '/v/b.md', kind: 'field', surface: 'frontmatter' }],
        edges_removed: [],
      },
    })

    expect(initial!.nodes[0]!.path).toBe('/v/a.md')
    expect(hint!.nodes_added[0]!.kind).toBe('instance')
    expect(hint!.nodes_removed).toEqual(['/v/a.md'])
    expect(hint!.edges_added[0]!.surface).toBe('frontmatter')
  })

  it('issues the recent_commits channel shape, args spread when given', () => {
    const bare = typedRig()
    subscribeRecentCommits(bare.subscriber, () => {})
    expect(bare.subscriber.last).toEqual({ subscribe: 'recent_commits' })

    const scoped = typedRig()
    subscribeRecentCommits(scoped.subscriber, () => {}, { members: ['app'], limit: 50, since: '2.weeks' })
    expect(scoped.subscriber.last).toEqual({
      subscribe: 'recent_commits',
      members: ['app'],
      limit: 50,
      since: '2.weeks',
    })
  })

  it('routes the recent_commits seed page and the commits-appeared hint (no scope key)', () => {
    const rig = typedRig()
    let initial: WireRecentCommit[] | null = null
    let hint: RecentCommitsHint | null = null
    subscribeRecentCommits(rig.subscriber, (e) => {
      if (e.kind === 'initial-value') initial = e.result
      else if (e.kind === 'change') hint = e.scopeHint
    })

    const seedRow: WireRecentCommit = {
      commit: 'aaa1111',
      tree: '/w/app',
      members: ['app'],
      author: { name: 'Ada', email: 'ada@example.com' },
      timestamp: 1_700_000_000,
      subject: 'seed the feed',
      changed_files: [{ path: 'src/a.ts', status: 'modified' }],
      trailers: [{ key: 'Mutation-Id', value: 'm-1' }],
    }
    rig.emit({ kind: 'initial-value', atVersion: 2, result: [seedRow] })
    rig.emit({
      kind: 'change',
      changeKind: 'commits-appeared',
      atVersion: 3,
      scopeHint: {
        commits: [
          {
            commit: 'bbb2222',
            tree: '/w/app',
            members: ['app'],
            author: { name: 'au-engine', email: 'au-engine@arsumbris.ai' },
            timestamp: 1_700_000_100,
            subject: 'rename it',
            changed_files: [{ path: 'src/b.ts', status: 'renamed', from: 'src/old.ts' }],
            trailers: [],
          },
        ],
      },
    })

    expect(initial![0]!.author.email).toBe('ada@example.com')
    expect(hint!.commits[0]!.commit).toBe('bbb2222')
    expect(hint!.commits[0]!.changed_files[0]!.from).toBe('src/old.ts')
    // the append-only hint carries no `scope` discriminant, unlike every other channel
    expect('scope' in hint!).toBe(false)
  })

  it('detach passes through', () => {
    const rig = typedRig()
    const detach = subscribeLifecycle(rig.subscriber, () => {})
    detach()
    expect(rig.detached).toBe(true)
  })
})

describe('toTypedSubscriber', () => {
  /** A raw subscriber that hands back its frame handlers to drive. */
  function rawRig() {
    let handlers: SubscribeHandlers | null = null
    const raw: RawFrameSubscriber & { last?: object } = {
      subscribe(request, h) {
        raw.last = request
        handlers = h
        return () => {}
      },
    }
    return {
      raw,
      get handlers() {
        return handlers!
      },
    }
  }

  it('normalizes snake_case frames into the camelCase event shape', () => {
    const rig = rawRig()
    const typed = toTypedSubscriber(rig.raw)
    const events: SubscriptionEvent[] = []
    typed.subscribe({ subscribe: 'diagnostics' }, (e) => events.push(e))

    rig.handlers.onInitialValue?.({ type: 'initial_value', schema_version: 29, subscription_id: 1, at_version: 2, result: [] })
    rig.handlers.onChangeEvent?.({
      type: 'change_event',
      schema_version: 29,
      subscription_id: 1,
      kind: 'diagnostics-changed',
      at_version: 3,
      scope_hint: { scope: 'files', files: ['/v/x.md'] },
    })
    rig.handlers.onClose?.('connection closed', 'transient')

    expect(events).toEqual([
      { kind: 'initial-value', atVersion: 2, result: [] },
      { kind: 'change', changeKind: 'diagnostics-changed', atVersion: 3, scopeHint: { scope: 'files', files: ['/v/x.md'] } },
      { kind: 'closed', error: 'connection closed', reason: 'transient' },
    ])
  })

  it('feeds the channel helpers from a raw client surface', () => {
    const rig = rawRig()
    const diagnostics: unknown[] = []
    subscribeDiagnostics(toTypedSubscriber(rig.raw), (e) => {
      if (e.kind === 'initial-value') diagnostics.push(...e.result)
    })
    rig.handlers.onInitialValue?.({
      type: 'initial_value',
      schema_version: 29,
      subscription_id: 1,
      at_version: 1,
      result: [{ code: 'x', severity: 'error', message: 'm', span: { file: 'f', range: { start: 0, end: 1 } } }],
    })
    expect(diagnostics).toHaveLength(1)
  })
})
