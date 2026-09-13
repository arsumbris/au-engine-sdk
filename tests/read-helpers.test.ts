import { describe, expect, it } from 'vitest'

import {
  readAnchors,
  readBlockIds,
  readFiles,
  readDirEntries,
  readDeviceConfig,
  readDiagnosticCounts,
  readDiagnostics,
  readIgnores,
  readImports,
  readMembers,
  readLifecycle,
  readPins,
  readRecentCommits,
  readResolveAnchor,
  readResolveBlockId,
  readResolveMember,
  readResolveTarget,
  readSubtypes,
  readCandidateCounts,
  readCandidates,
  readInstanceCounts,
  readType,
  readTypeBatch,
  readTypeCounts,
  readTypes,
  readTypeTree,
  readValidateValue,
  type WireReader,
} from '../src/read-helpers.ts'
import type { DaemonClient } from '../src/client.ts'
import { WireError, type EngineReadResult, type ReadRequest, type ResponseFrame } from '../src/wire.ts'

// Compile-time: DaemonClient satisfies WireReader structurally.
// The MountHost.engine compatibility cross-check lives in au-host-sdk now.
type _DaemonClientIsReader = DaemonClient extends WireReader ? true : never
const _daemonOk: _DaemonClientIsReader = true
void _daemonOk

/** Distributes Omit across the ResponseFrame arms, keeping ready/version correlated. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/**
 * Reads whose `result` carries envelope-level metadata BESIDE the payload key,
 * so `frameReader`'s mock passes the whole struct (matching the daemon) instead
 * of the raw payload.
 */
const ENVELOPE_SIBLING_READS = new Set(['instances', 'candidates', 'subtypes'])

/**
 * A reader answering like a DaemonClient: raw response frames. Simulates the
 * schema-17 result envelope — the mock's `result` is the RAW payload, and this
 * wraps it under the request's verb key (`{ [verb]: payload }`), exactly as the
 * daemon does. The sibling-bearing reads (`ENVELOPE_SIBLING_READS`) instead pass
 * their whole struct through, since their metadata rides beside the payload key.
 */
function frameReader(
  frame: DistributiveOmit<ResponseFrame, 'type' | 'schema_version'>,
): WireReader & { last?: ReadRequest } {
  const reader: WireReader & { last?: ReadRequest } = {
    read(request) {
      reader.last = request
      const enveloped =
        'result' in frame && !ENVELOPE_SIBLING_READS.has(request.read)
          ? { ...frame, result: { [request.read]: frame.result } }
          : frame
      return Promise.resolve({ type: 'response', schema_version: 29, ...enveloped } as ResponseFrame)
    },
  }
  return reader
}

/** A reader answering like MountHost.engine: in-band ok/error results. */
function engineReader(result: EngineReadResult): WireReader {
  return { read: () => Promise.resolve(result) }
}

const entries = [{ path: '/v/content', name: 'content', kind: 'directory' as const }]

describe('typed read helpers', () => {
  it('issues the wire request shape', async () => {
    const reader = frameReader({ ready: true, version: 1, result: entries })
    await readDirEntries(reader, '/v')
    expect(reader.last).toEqual({ read: 'dir_entries', dir: '/v' })
  })

  it('omits the optional origin on the navigation reads when absent', async () => {
    const reader = frameReader({ ready: true, version: 1, result: null })
    await readResolveTarget(reader, 'alice')
    expect(reader.last).toEqual({ read: 'resolve_target', target: 'alice' })
    await readResolveBlockId(reader, 'alice', 'b1')
    expect(reader.last).toEqual({ read: 'resolve_block_id', target: 'alice', block_id: 'b1' })
    await readResolveAnchor(reader, 'alice', 'h')
    expect(reader.last).toEqual({ read: 'resolve_anchor', target: 'alice', anchor: 'h' })
  })

  it('readRecentCommits issues the recent_commits read, args spread, default argless', async () => {
    const bare = frameReader({ ready: true, version: 1, result: [] })
    await readRecentCommits(bare)
    expect(bare.last).toEqual({ read: 'recent_commits' })

    const scoped = frameReader({ ready: true, version: 1, result: [] })
    await readRecentCommits(scoped, { members: ['app'], limit: 20, since: '3.days' })
    expect(scoped.last).toEqual({ read: 'recent_commits', members: ['app'], limit: 20, since: '3.days' })
  })

  it('readRecentCommits unwraps the { recent_commits } envelope to the row array', async () => {
    const row = {
      commit: 'aaa1111',
      tree: '/w/app',
      members: ['app'],
      author: { name: 'Ada', email: 'ada@example.com' },
      timestamp: 1_700_000_000,
      subject: 'do a thing',
      changed_files: [{ path: 'src/a.ts', status: 'added' as const }],
      trailers: [{ key: 'Mutation-Id', value: 'm-1' }],
    }
    const reader = frameReader({ ready: true, version: 2, result: [row] })
    const outcome = await readRecentCommits(reader)
    if ('ok' in outcome) throw new Error(`unexpected wire error: ${outcome.error}`)
    if (!outcome.ready) throw new Error('unreachable')
    expect(outcome.result).toEqual([row])
    expect(outcome.result[0].author.email).toBe('ada@example.com')
  })

  it('readPins issues the pins read, mapping sourceType to the snake_case source_type', async () => {
    const reader = frameReader({ ready: true, version: 1, result: [] })
    await readPins(reader, 'foo', 'ledger')
    expect(reader.last).toEqual({ read: 'pins', target: 'foo', source_type: 'ledger' })
  })

  it('readPins narrows to the flat WireSpan record shape (not a nested range)', async () => {
    const record = {
      source: '/v/content/ledger-1.md',
      span: { start: 26, end: 43, line_col: { start: { line: 3, col: 8 }, end: { line: 3, col: 25 } } },
      slot: 'note',
      surface: 'frontmatter' as const,
      target: 'foo',
      commit: 'aaa1111',
    }
    const reader = frameReader({ ready: true, version: 2, result: [record] })
    const outcome = await readPins(reader, 'foo', 'ledger')
    if ('ok' in outcome) throw new Error(`unexpected wire error: ${outcome.error}`)
    if (!outcome.ready) throw new Error('unreachable')
    expect(outcome.result).toEqual([record])
    expect(outcome.result[0].span.start).toBe(26)
  })

  it('threads origin onto the navigation reads when present', async () => {
    const reader = frameReader({ ready: true, version: 1, result: null })
    await readResolveTarget(reader, 'alice', '/v/src.md')
    expect(reader.last).toEqual({ read: 'resolve_target', target: 'alice', origin: '/v/src.md' })
    await readResolveBlockId(reader, 'alice', 'b1', '/v/src.md')
    expect(reader.last).toEqual({ read: 'resolve_block_id', target: 'alice', block_id: 'b1', origin: '/v/src.md' })
    await readResolveAnchor(reader, 'alice', 'h', '/v/src.md')
    expect(reader.last).toEqual({ read: 'resolve_anchor', target: 'alice', anchor: 'h', origin: '/v/src.md' })
  })

  it('narrows a ready DaemonClient response frame', async () => {
    const outcome = await readDirEntries(frameReader({ ready: true, version: 7, result: entries }), '/v')
    expect(outcome).toEqual({ ready: true, version: 7, result: entries })
  })

  it('narrows a ready MountHost.engine result', async () => {
    // The host serves the same schema-17 envelope, so `result` wraps the payload.
    const outcome = await readDirEntries(
      engineReader({ ok: true, ready: true, version: 7, result: { dir_entries: entries } }),
      '/v',
    )
    expect(outcome).toEqual({ ready: true, version: 7, result: entries })
  })

  it('normalizes not-ready from both transports', async () => {
    expect(await readDirEntries(frameReader({ ready: false }), '/v')).toEqual({ ready: false })
    expect(await readDirEntries(engineReader({ ok: true, ready: false }), '/v')).toEqual({ ready: false })
  })

  it('returns the error arm for an in-band MountHost.engine error', async () => {
    const outcome = await readDirEntries(engineReader({ ok: false, error: 'daemon gone' }), '/v')
    expect(outcome).toEqual({ ok: false, error: 'daemon gone' })
  })

  it('returns the error arm for a DaemonClient WireError frame', async () => {
    const wireErroring: WireReader = { read: () => Promise.reject(new WireError('no-such-read')) }
    const outcome = await readDirEntries(wireErroring, '/v')
    expect(outcome).toEqual({ ok: false, error: 'no-such-read' })
  })

  it('still throws on transport failure (not a WireError)', async () => {
    const dead: WireReader = { read: () => Promise.reject(new Error('daemon connection closed')) }
    await expect(readDirEntries(dead, '/v')).rejects.toThrow('daemon connection closed')
  })

  it('passes null results through unchanged', async () => {
    const outcome = await readResolveTarget(frameReader({ ready: true, version: 2, result: null }), 'ghost')
    expect(outcome).toEqual({ ready: true, version: 2, result: null })
  })

  it('readLifecycle carries the lifecycle states even when not ready', async () => {
    const probe = await readLifecycle(frameReader({ ready: false, result: { engine: 'running', ref: 'deriving' } }))
    if ('ok' in probe) throw new Error('unexpected error arm')
    expect(probe.ready).toBe(false)
    expect(probe.version).toBeUndefined()
    expect(probe.states).toEqual({ engine: 'running', ref: 'deriving' })
  })

  it('readLifecycle returns the error arm for a WireError', async () => {
    const wireErroring: WireReader = { read: () => Promise.reject(new WireError('ready unavailable')) }
    expect(await readLifecycle(wireErroring)).toEqual({ ok: false, error: 'ready unavailable' })
  })
})

describe('cross-repo read request shapes', () => {
  it('omits repo from types/type when unscoped (root repo)', async () => {
    const r1 = frameReader({ ready: true, version: 1, result: [] })
    await readTypes(r1)
    expect(r1.last).toEqual({ read: 'types' })

    const r2 = frameReader({ ready: true, version: 1, result: null })
    await readType(r2, 'decision')
    expect(r2.last).toEqual({ read: 'type', name: 'decision' })
  })

  it('includes repo on the types enumeration when scoped to a declared repo', async () => {
    const r1 = frameReader({ ready: true, version: 1, result: [] })
    await readTypes(r1, { repo: 'base' })
    expect(r1.last).toEqual({ read: 'types', repo: 'base' })
  })

  it('carries summary/limit/offset on the types read for the summarized page form', async () => {
    const r1 = frameReader({ ready: true, version: 1, result: [] })
    await readTypes(r1, { repo: 'base', summary: true, limit: 50, offset: 100 })
    expect(r1.last).toEqual({ read: 'types', repo: 'base', summary: true, limit: 50, offset: 100 })
  })

  it('readTypeCounts issues type_counts, with an optional repo scope', async () => {
    const r1 = frameReader({ ready: true, version: 1, result: { total: 0, by_repo: {} } })
    await readTypeCounts(r1)
    expect(r1.last).toEqual({ read: 'type_counts' })

    const r2 = frameReader({ ready: true, version: 1, result: { total: 3, by_repo: { base: 3 } } })
    await readTypeCounts(r2, 'base')
    expect(r2.last).toEqual({ read: 'type_counts', repo: 'base' })
  })

  it('readInstanceCounts issues instance_counts, with optional repo and scope', async () => {
    const view = { aborted_at_load: false, total: 0, by_type: [] }

    const r1 = frameReader({ ready: true, version: 1, result: view })
    await readInstanceCounts(r1)
    expect(r1.last).toEqual({ read: 'instance_counts' })

    const r2 = frameReader({ ready: true, version: 1, result: view })
    await readInstanceCounts(r2, 'base')
    expect(r2.last).toEqual({ read: 'instance_counts', repo: 'base' })

    const r3 = frameReader({ ready: true, version: 1, result: view })
    await readInstanceCounts(r3, undefined, 'own')
    expect(r3.last).toEqual({ read: 'instance_counts', scope: 'own' })

    const r4 = frameReader({ ready: true, version: 1, result: view })
    await readInstanceCounts(r4, 'base', 'all')
    expect(r4.last).toEqual({ read: 'instance_counts', repo: 'base', scope: 'all' })
  })

  it('readTypeBatch issues the type read with the names selector, not name', async () => {
    const reader = frameReader({ ready: true, version: 1, result: [null, null] })
    await readTypeBatch(reader, ['decision', 'risk::base'])
    expect(reader.last).toEqual({ read: 'type_batch', names: ['decision', 'risk::base'] })
  })

  it('carries summary/limit/offset on the candidates read', async () => {
    const full = frameReader({ ready: true, version: 1, result: { aborted_at_load: false, candidates: [] } })
    await readCandidates(full)
    expect(full.last).toEqual({ read: 'candidates' })

    const paged = frameReader({ ready: true, version: 1, result: { aborted_at_load: false, candidates: [] } })
    await readCandidates(paged, { summary: true, limit: 25, offset: 50 })
    expect(paged.last).toEqual({ read: 'candidates', summary: true, limit: 25, offset: 50 })
  })

  it('readCandidateCounts issues the argless candidate_counts read', async () => {
    const reader = frameReader({
      ready: true,
      version: 1,
      result: { aborted_at_load: false, total_files: 0, files_with_candidates: 0, by_type: {} },
    })
    await readCandidateCounts(reader)
    expect(reader.last).toEqual({ read: 'candidate_counts' })
  })

  it('scopes the type read by a ::repo-qualified name, not a separate repo arg', async () => {
    // schema 8: the `type` read dropped the `repo` key; scoping folds into the
    // authored name (the `instances_of` arg convention).
    const r2 = frameReader({ ready: true, version: 1, result: null })
    await readType(r2, 'decision::base')
    expect(r2.last).toEqual({ read: 'type', name: 'decision::base' })
  })

  it('readSubtypes carries the base arg', async () => {
    const reader = frameReader({ ready: true, version: 1, result: { base: 'projection', subtypes: [] } })
    await readSubtypes(reader, 'projection')
    expect(reader.last).toEqual({ read: 'subtypes', base: 'projection' })
  })

  it('threads the optional scope=own|all filter across the workspace-wide type reads', async () => {
    // Absent scope stays off the wire (default `all`); present it rides through.
    const types = frameReader({ ready: true, version: 1, result: [] })
    await readTypes(types, { scope: 'own' })
    expect(types.last).toEqual({ read: 'types', scope: 'own' })

    const typesRepo = frameReader({ ready: true, version: 1, result: [] })
    await readTypes(typesRepo, { repo: 'base', scope: 'own' })
    expect(typesRepo.last).toEqual({ read: 'types', repo: 'base', scope: 'own' })

    const counts = frameReader({ ready: true, version: 1, result: { total: 0, by_repo: {} } })
    await readTypeCounts(counts, undefined, 'own')
    expect(counts.last).toEqual({ read: 'type_counts', scope: 'own' })

    const countsRepo = frameReader({ ready: true, version: 1, result: { total: 0, by_repo: {} } })
    await readTypeCounts(countsRepo, 'base', 'all')
    expect(countsRepo.last).toEqual({ read: 'type_counts', repo: 'base', scope: 'all' })

    const tree = frameReader({ ready: true, version: 1, result: { roots: [], nodes: {} } })
    await readTypeTree(tree, 'own')
    expect(tree.last).toEqual({ read: 'type_tree', scope: 'own' })

    const imports = frameReader({ ready: true, version: 1, result: [] })
    await readImports(imports, 'own')
    expect(imports.last).toEqual({ read: 'imports', scope: 'own' })

    const subtypes = frameReader({ ready: true, version: 1, result: { base: 'projection', subtypes: [] } })
    await readSubtypes(subtypes, 'projection', 'own')
    expect(subtypes.last).toEqual({ read: 'subtypes', base: 'projection', scope: 'own' })

    // Absent scope: no scope key on any of them.
    const bare = frameReader({ ready: true, version: 1, result: { roots: [], nodes: {} } })
    await readTypeTree(bare)
    expect(bare.last).toEqual({ read: 'type_tree' })
  })

  it('readMembers issues the members read, with an optional repo scope', async () => {
    const reader = frameReader({ ready: true, version: 1, result: [] })
    await readMembers(reader)
    expect(reader.last).toEqual({ read: 'members' })

    const scoped = frameReader({ ready: true, version: 1, result: [] })
    await readMembers(scoped, 'base')
    expect(scoped.last).toEqual({ read: 'members', repo: 'base' })
  })

  it('readMembers parses editable/local/role axes (schema 16, replacing primary)', async () => {
    // schema 17: the `members` read envelopes the array under its verb key, so
    // the helper unwraps to the array directly (no `{ members }` wrapper).
    const result = [
      // the entry: an editable authoring surface, a live local working tree
      { repo: 'app', root: '/w/app', scattered: false, editable: true, local: true, role: 'entry' },
      // a read-only cache-mounted dependency: consumed, not local
      { repo: 'base', root: '/cache/base@sha', scattered: true, editable: false, local: false, role: 'dep' },
    ]
    const reader = frameReader({ ready: true, version: 16, result })
    const out = await readMembers(reader)
    expect(out).toMatchObject({ ready: true })
    if ('result' in out) {
      const [app, base] = out.result
      expect(app).toEqual({ repo: 'app', root: '/w/app', scattered: false, editable: true, local: true, role: 'entry' })
      expect(base.editable).toBe(false)
      expect(base.local).toBe(false)
      expect(base.role).toBe('dep')
      // the former `primary` boolean is gone
      expect('primary' in app).toBe(false)
    }
  })

  it('readResolveMember carries the path arg', async () => {
    const reader = frameReader({ ready: true, version: 1, result: null })
    await readResolveMember(reader, 'notes/x.md')
    expect(reader.last).toEqual({ read: 'resolve_member', path: 'notes/x.md' })
  })

  it('readResolveMember parses the owning member with editable/local/role', async () => {
    const reader = frameReader({
      ready: true,
      version: 16,
      result: { repo: 'app', root: '/w/app', editable: true, local: true, role: 'entry' },
    })
    const out = await readResolveMember(reader, '/w/app/notes/x.md')
    if ('result' in out && out.result) {
      expect(out.result).toEqual({ repo: 'app', root: '/w/app', editable: true, local: true, role: 'entry' })
    }
  })

  it('readDeviceConfig issues the argless device_config read', async () => {
    const reader = frameReader({ ready: true, version: 1, result: { repos: null, workspaces: null } })
    await readDeviceConfig(reader)
    expect(reader.last).toEqual({ read: 'device_config' })
  })

  it('readDeviceConfig parses present / absent / no-config-dir entries', async () => {
    const result = {
      // present + clean
      repos: {
        path: '/home/u/.arsumbris/au-engine/config/repos.yaml',
        exists: true,
        content: 'repos:\n  - name: base\n    path: /r/base\n',
        diagnostics: [],
      },
      // resolves but not-yet-authored: null content, empty diagnostics
      workspaces: {
        path: '/home/u/.arsumbris/au-engine/config/workspaces.yaml',
        exists: false,
        content: null,
        diagnostics: [],
      },
    }
    const reader = frameReader({ ready: true, version: 2, result })
    const out = await readDeviceConfig(reader)
    expect(out).toMatchObject({ ready: true })
    if ('result' in out) {
      expect(out.result.repos?.exists).toBe(true)
      expect(out.result.repos?.content).toContain('name: base')
      expect(out.result.workspaces?.exists).toBe(false)
      expect(out.result.workspaces?.content).toBeNull()
      expect(out.result.workspaces?.diagnostics).toEqual([])
    }

    // No per-user config dir: both entries null.
    const nullReader = frameReader({ ready: true, version: 1, result: { repos: null, workspaces: null } })
    const nullOut = await readDeviceConfig(nullReader)
    if ('result' in nullOut) {
      expect(nullOut.result.repos).toBeNull()
      expect(nullOut.result.workspaces).toBeNull()
    }
  })

  it('readIgnores issues the argless ignores read', async () => {
    const reader = frameReader({ ready: true, version: 1, result: [] })
    await readIgnores(reader)
    expect(reader.last).toEqual({ read: 'ignores' })
  })

  it('readIgnores carries the optional repo and resolve args', async () => {
    const r1 = frameReader({ ready: true, version: 1, result: [] })
    await readIgnores(r1, { repo: 'app' })
    expect(r1.last).toEqual({ read: 'ignores', repo: 'app' })

    const r2 = frameReader({ ready: true, version: 1, result: [] })
    await readIgnores(r2, { repo: 'app', resolve: true })
    expect(r2.last).toEqual({ read: 'ignores', repo: 'app', resolve: true })
  })

  it('readIgnores parses a member, with resolved present only under resolve', async () => {
    const member = {
      root: '/v/app',
      repo: 'app',
      patterns: ['# vendored', 'build/', ''],
      default_excludes: ['node_modules', 'target'],
      floor: ['.git', '.arsumbris'],
      resolved: { ignored_dirs: ['/v/app/build'], ignored_files: ['/v/app/secret.md'] },
    }
    // frameReader envelopes the raw payload under the verb key, so the mock is
    // the raw member array (the helper unwraps `result.ignores` back to it).
    const reader = frameReader({ ready: true, version: 3, result: [member] })
    const out = await readIgnores(reader, { resolve: true })
    expect(out).toMatchObject({ ready: true })
    if ('result' in out) {
      expect(out.result).toHaveLength(1)
      const m = out.result[0]
      expect(m.patterns).toEqual(['# vendored', 'build/', ''])
      expect(m.default_excludes).toEqual(['node_modules', 'target'])
      expect(m.floor).toEqual(['.git', '.arsumbris'])
      expect(m.resolved).toEqual({ ignored_dirs: ['/v/app/build'], ignored_files: ['/v/app/secret.md'] })
    }
  })

  it('readValidateValue carries type_name/value and an optional repo', async () => {
    const r1 = frameReader({ ready: true, version: 1, result: [] })
    await readValidateValue(r1, 'person', { name: 'Ada' })
    expect(r1.last).toEqual({ read: 'validate_value', type_name: 'person', value: { name: 'Ada' } })

    const r2 = frameReader({ ready: true, version: 1, result: [] })
    await readValidateValue(r2, 'person', { name: 'Ada' }, 'base')
    expect(r2.last).toEqual({ read: 'validate_value', type_name: 'person', value: { name: 'Ada' }, repo: 'base' })
  })
})

describe('diagnostics paging and counts request shapes', () => {
  it('readDiagnostics issues the bare read with no filter or page', async () => {
    const reader = frameReader({ ready: true, version: 1, result: [] })
    await readDiagnostics(reader)
    expect(reader.last).toEqual({ read: 'diagnostics' })
  })

  it('readDiagnostics composes the filter and the page (limit / offset)', async () => {
    const reader = frameReader({ ready: true, version: 1, result: [] })
    await readDiagnostics(reader, { severity: 'error', path_prefix: 'content' }, { limit: 50, offset: 100 })
    expect(reader.last).toEqual({
      read: 'diagnostics',
      severity: 'error',
      path_prefix: 'content',
      limit: 50,
      offset: 100,
    })
  })

  it('readDiagnostics carries a page without a filter', async () => {
    const reader = frameReader({ ready: true, version: 1, result: [] })
    await readDiagnostics(reader, undefined, { limit: 25 })
    expect(reader.last).toEqual({ read: 'diagnostics', limit: 25 })
  })

  it('readDiagnosticCounts issues diagnostic_counts with the same filter, no page', async () => {
    const counts = { total: 3, by_severity: { error: 2, warning: 1 }, by_code: { 'broken-link': 3 } }
    const reader = frameReader({ ready: true, version: 1, result: counts })
    const outcome = await readDiagnosticCounts(reader, { code: 'broken-link' })
    expect(reader.last).toEqual({ read: 'diagnostic_counts', code: 'broken-link' })
    expect(outcome).toEqual({ ready: true, version: 1, result: counts })
  })

  it('readDiagnosticCounts issues the bare read with no filter', async () => {
    const reader = frameReader({ ready: true, version: 1, result: { total: 0, by_severity: {}, by_code: {} } })
    await readDiagnosticCounts(reader)
    expect(reader.last).toEqual({ read: 'diagnostic_counts' })
  })
})

describe('the addressable-enumeration reads', () => {
  it('readAnchors / readBlockIds take a wikilink target, and omit origin when absent', async () => {
    const reader = frameReader({ ready: true, version: 1, result: [] })
    await readAnchors(reader, 'alice')
    expect(reader.last).toEqual({ read: 'anchors', target: 'alice' })
    await readBlockIds(reader, 'alice')
    expect(reader.last).toEqual({ read: 'block_ids', target: 'alice' })
  })

  it('readAnchors / readBlockIds thread origin when present, scoping like the resolve verbs', async () => {
    const reader = frameReader({ ready: true, version: 1, result: [] })
    await readAnchors(reader, 'alice', '/v/src.md')
    expect(reader.last).toEqual({ read: 'anchors', target: 'alice', origin: '/v/src.md' })
    await readBlockIds(reader, 'alice', '/v/src.md')
    expect(reader.last).toEqual({ read: 'block_ids', target: 'alice', origin: '/v/src.md' })
  })

  it('readFiles issues the argless read, then composes repo / scope / limit / offset', async () => {
    const reader = frameReader({ ready: true, version: 1, result: [] })
    await readFiles(reader)
    expect(reader.last).toEqual({ read: 'files' })
    await readFiles(reader, { repo: 'base', scope: 'own', limit: 50, offset: 100 })
    expect(reader.last).toEqual({ read: 'files', repo: 'base', scope: 'own', limit: 50, offset: 100 })
  })

  it('anchors carries text / level / span, the heading a #anchor matches', async () => {
    const anchors = [
      { text: 'Alice', level: 1, span: { start: 0, end: 7 } },
      { text: 'Her work', level: 2, span: { start: 40, end: 51 } },
    ]
    const outcome = await readAnchors(frameReader({ ready: true, version: 3, result: anchors }), 'alice')
    expect(outcome).toEqual({ ready: true, version: 3, result: anchors })
  })

  it('block_ids lists every occurrence, so the array is NOT id-unique', async () => {
    // `resolve_block_id` answers the FIRST `dup` and ignores the rest; the
    // listing carries both, which is what `block-id-duplicate` reports on.
    const ids = [
      { id: 'r1', kind: 'record' as const, type_claim: ['person'], span: { start: 10, end: 20 } },
      { id: 'dup', kind: 'marker' as const, type_claim: [], span: { start: 30, end: 36 } },
      { id: 'dup', kind: 'marker' as const, type_claim: [], span: { start: 90, end: 96 } },
    ]
    const outcome = await readBlockIds(frameReader({ ready: true, version: 3, result: ids }), 'alice')
    expect(outcome).toEqual({ ready: true, version: 3, result: ids })
  })

  it('null and empty stay DISTINCT on anchors / block_ids, never collapsed', async () => {
    // null = the target does not resolve. [] = it resolves and carries none.
    // A consumer must be able to tell a typo from a file with no headings.
    expect(await readAnchors(frameReader({ ready: true, version: 1, result: null }), 'no-such')).toEqual({
      ready: true,
      version: 1,
      result: null,
    })
    expect(await readAnchors(frameReader({ ready: true, version: 1, result: [] }), 'pure-yaml')).toEqual({
      ready: true,
      version: 1,
      result: [],
    })
    expect(await readBlockIds(frameReader({ ready: true, version: 1, result: null }), 'no-such')).toEqual({
      ready: true,
      version: 1,
      result: null,
    })
    expect(await readBlockIds(frameReader({ ready: true, version: 1, result: [] }), 'plain')).toEqual({
      ready: true,
      version: 1,
      result: [],
    })
  })

  it('files carries path / stem / repo / kind, an unread asset included', async () => {
    const files = [
      { path: 'content/alice.md', stem: 'alice', repo: 'base', kind: 'instance' as const },
      { path: 'content/paper.pdf', stem: 'paper', repo: 'base', kind: 'asset' as const },
      { path: 'workspace.yaml', stem: 'workspace', repo: null, kind: 'note' as const },
    ]
    const outcome = await readFiles(frameReader({ ready: true, version: 3, result: files }))
    expect(outcome).toEqual({ ready: true, version: 3, result: files })
  })
})
