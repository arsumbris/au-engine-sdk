// Every typed read helper against a live daemon over the test entry repo:
// the result parses into the declared type's structure. Harness in
// `live-daemon.ts`; fixtures: typed instances (alice.md is
// [person, quality]), broken/ files carrying diagnostics, a sealed
// decision family, a `^scaling-headroom` marker in sqlite-migration.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  readReferencesIn,
  readAnchors,
  readBlockIds,
  readFiles,
  readNeighborhood,
  readCandidates,
  readDirEntries,
  readHubs,
  readGraphShape,
  readLinkGraph,
  readTypeGraph,
  readTypeClosure,
  readValidateValue,
  readPreviewMutation,
  readContent,
  readDiagnosticCounts,
  readDiagnostics,
  readFrontmatter,
  readInstances,
  readInstancesOf,
  readImports,
  readMembers,
  readLifecycle,
  readResolveMember,
  readReferencesOut,
  readResolveAnchor,
  readResolveBlockId,
  readInstance,
  readResolveTarget,
  readSemanticTokens,
  readTopLevelDirs,
  readType,
  readTypes,
  type TypedRead,
} from '../src/read-helpers.ts'
import { binaryPresent, type LiveDaemon, startLiveDaemon } from './live-daemon.ts'

/** Narrow a TypedRead to its ready arm; the daemon is ready throughout the suite. */
function ready<T>(outcome: TypedRead<T>): T {
  if ('ok' in outcome) throw new Error(`unexpected wire error: ${outcome.error}`)
  expect(outcome.ready).toBe(true)
  if (!outcome.ready) throw new Error('unreachable')
  expect(typeof outcome.version).toBe('number')
  return outcome.result
}

describe.skipIf(!binaryPresent)('typed read helpers against the live daemon', () => {
  let live: LiveDaemon

  beforeAll(async () => {
    live = await startLiveDaemon()
  }, 30_000)

  afterAll(async () => {
    await live?.stop()
  }, 15_000)

  it('readLifecycle', async () => {
    const probe = await readLifecycle(live.client)
    if ('ok' in probe) throw new Error(`unexpected wire error: ${probe.error}`)
    expect(probe.ready).toBe(true)
    expect(typeof probe.version).toBe('number')
    expect(typeof probe.states.engine).toBe('string')
    expect(typeof probe.states.ref).toBe('string')
  })

  it('readDiagnostics: an unknown severity filter surfaces as the error arm, not a throw', async () => {
    // The engine rejects a typo'd filter rather than returning the
    // unfiltered set; the helper converts that wire error into an arm.
    const outcome = await readDiagnostics(live.client, { severity: 'bogus' as 'error' })
    expect('ok' in outcome && outcome.ok).toBe(false)
    if (!('ok' in outcome)) throw new Error('expected the error arm')
    expect(typeof outcome.error).toBe('string')
  })

  it('readDiagnostics: whole knowledge base and filtered', async () => {
    const all = ready(await readDiagnostics(live.client))
    expect(all.length).toBeGreaterThan(0) // broken/ files guarantee some
    for (const d of all) {
      expect(typeof d.code).toBe('string')
      expect(['error', 'drift', 'warning', 'hint']).toContain(d.severity)
      expect(typeof d.message).toBe('string')
      expect(typeof d.span.file).toBe('string')
      expect(typeof d.span.range.start).toBe('number')
      expect(typeof d.span.range.end).toBe('number')
    }
    const errors = ready(await readDiagnostics(live.client, { severity: 'error' }))
    expect(errors.length).toBeLessThanOrEqual(all.length)
    expect(errors.every((d) => d.severity === 'error')).toBe(true)
  })

  it('readDiagnostics: limit / offset page the stable stream', async () => {
    const all = ready(await readDiagnostics(live.client))
    expect(all.length).toBeGreaterThan(1) // need at least two to page

    // A limit shorter than the set returns exactly that many, the page head.
    const firstTwo = ready(await readDiagnostics(live.client, undefined, { limit: 2 }))
    expect(firstTwo.length).toBe(Math.min(2, all.length))
    expect(firstTwo).toEqual(all.slice(0, firstTwo.length))

    // offset advances over the same stable order; a contiguous walk reassembles the set.
    const afterFirst = ready(await readDiagnostics(live.client, undefined, { limit: 2, offset: 1 }))
    expect(afterFirst).toEqual(all.slice(1, 1 + afterFirst.length))

    // An offset past the end is a short (empty) page, not an error.
    const past = ready(await readDiagnostics(live.client, undefined, { offset: all.length + 10 }))
    expect(past).toEqual([])
  })

  it('readDiagnosticCounts: total and the name-sorted by_severity / by_code maps', async () => {
    const all = ready(await readDiagnostics(live.client))
    const counts = ready(await readDiagnosticCounts(live.client))

    // total matches the materialized set; limit/offset don't apply to counts.
    expect(counts.total).toBe(all.length)

    // by_severity sums to the total, only present severities, name-sorted.
    const sevKeys = Object.keys(counts.by_severity)
    expect(sevKeys).toEqual([...sevKeys].sort())
    expect(Object.values(counts.by_severity).reduce((a, b) => a + b, 0)).toBe(counts.total)
    expect(sevKeys.every((k) => Object.values(counts.by_severity)[sevKeys.indexOf(k)]! > 0)).toBe(true)

    // by_code sums to the total too, name-sorted.
    const codeKeys = Object.keys(counts.by_code)
    expect(codeKeys).toEqual([...codeKeys].sort())
    expect(Object.values(counts.by_code).reduce((a, b) => a + b, 0)).toBe(counts.total)

    // The same filter narrows both reads identically.
    const errs = ready(await readDiagnostics(live.client, { severity: 'error' }))
    const errCounts = ready(await readDiagnosticCounts(live.client, { severity: 'error' }))
    expect(errCounts.total).toBe(errs.length)
  })

  it('readTypes: the whole graph, sealed families included', async () => {
    const types = ready(await readTypes(live.client))
    const names = types.map((t) => t.name)
    expect(names).toContain('person')
    expect(names).toContain('decision')
    for (const t of types) {
      expect(Array.isArray(t.parents)).toBe(true)
      expect(Array.isArray(t.fields)).toBe(true)
      expect(typeof t.source.file).toBe('string')
      expect(typeof t.source.span.start).toBe('number')
    }
    const decision = types.find((t) => t.name === 'decision')
    expect(decision?.sealed).toContain('decision.pending')
  })

  it('readType: by name, null for unknown', async () => {
    const person = ready(await readType(live.client, 'person'))
    expect(person?.name).toBe('person')
    expect(person?.fields.some((f) => typeof f.shape === 'string' && typeof f.required === 'boolean')).toBe(true)
    expect(ready(await readType(live.client, 'no-such-type'))).toBeNull()
  })

  it('readType: shape_ast mirrors the parsed slot shape beside the source string', async () => {
    // `assumption` exercises three WireShape kinds; `citation` adds the
    // compound/union forms. shape_ast rides each field beside `shape`.
    const assumption = ready(await readType(live.client, 'assumption'))
    const byName = (f: string) => assumption?.fields.find((x) => x.name === f)

    expect(byName('description')?.shape).toBe('String')
    expect(byName('description')?.shape_ast).toEqual({ kind: 'primitive', name: 'String' })

    expect(byName('confidence')?.shape_ast).toEqual({ kind: 'enum', members: ['low', 'medium', 'high'] })

    // `file*[+]` — a list wrapping a bare `file` reference, `[+]`=`{min:1}`, unbounded above (no `max`).
    expect(byName('supporting_evidence')?.shape_ast).toEqual({
      kind: 'list',
      min: 1,
      inner: { kind: 'reference', name: 'file' },
    })

    // `<entity* & quality*>*` — references collapse to a compound-reference, not nested shapes.
    const citation = ready(await readType(live.client, 'citation'))
    expect(citation?.fields.find((f) => f.name === 'vetting')?.shape_ast).toEqual({
      kind: 'compound-reference',
      mode: 'ref',
      op: 'intersection',
      branches: ['entity', 'quality'],
    })
  })

  it('readType: a body-declaring type carries the template', async () => {
    const decided = ready(await readType(live.client, 'decision.decided'))
    expect(decided?.body?.some((i) => i.kind === 'use' && i.target === 'decision')).toBe(true)
    const section = decided?.body?.find((i) => i.kind === 'section')
    expect(section && section.kind === 'section' && section.name).toBe('Outcome')
    // effective_body has the use: spliced away
    expect(decided?.effective_body?.every((i) => i.kind !== 'use')).toBe(true)
  })

  it('readType: the schema-18 type-view fields (abstract, required_meta, unmet_required_meta)', async () => {
    // The `widget` family exercises all three: an abstract base obligating
    // `display-meta`, a concrete subtype missing it, one carrying it.
    const base = ready(await readType(live.client, 'widget'))
    expect(base?.abstract).toBe(true)
    expect(base?.required_meta).toContain('display-meta')
    // An abstract def is exempt from its own obligation.
    expect(base?.unmet_required_meta).toEqual([])

    const bare = ready(await readType(live.client, 'widget.bare'))
    expect(bare?.abstract).toBe(false)
    // The obligation is inherited, not the subtype's own, so `required_meta` is empty…
    expect(bare?.required_meta).toEqual([])
    // …but the inherited obligation is unmet.
    expect(bare?.unmet_required_meta).toContain('display-meta')

    const full = ready(await readType(live.client, 'widget.full'))
    expect(full?.abstract).toBe(false)
    expect(full?.unmet_required_meta).toEqual([])

    // An ordinary type carries the defaults, never undefined.
    const person = ready(await readType(live.client, 'person'))
    expect(person?.abstract).toBe(false)
    expect(person?.required_meta).toEqual([])
    expect(person?.unmet_required_meta).toEqual([])

    // The summary projection omits the whole batch.
    const summary = ready(await readTypes(live.client, { summary: true, scope: 'own' }))
    const w = summary.find((t) => t.name === 'widget')
    expect(w).toBeDefined()
    expect('abstract' in (w as object)).toBe(false)
    expect('required_meta' in (w as object)).toBe(false)
    expect('unmet_required_meta' in (w as object)).toBe(false)
  })

  it('readInstancesOf: match records with frontmatter fields', async () => {
    const people = ready(await readInstancesOf(live.client, 'person'))
    const alice = people.find((p) => p.path.endsWith('alice.md'))
    expect(alice).toBeDefined()
    expect(alice?.claim).toContain('person')
    // The match record's identity fields (schema 6 reshape, `closure` gone).
    expect(alice?.name).toBe('person')
    expect(typeof alice?.hash).toBe('string')
    expect(Array.isArray(alice?.type_owners)).toBe(true)
    expect(alice?.claimed).toBe(true)
    expect(typeof alice?.inherited).toBe('boolean')
    expect(alice?.fields['name']).toBe('Alice')
  })

  it('readImports: the fold-axis ::repo use set', async () => {
    const imports = ready(await readImports(live.client))
    expect(Array.isArray(imports)).toBe(true)
    for (const imp of imports) {
      expect(typeof imp.importer).toBe('string')
      expect(typeof imp.name).toBe('string')
      expect(typeof imp.owner).toBe('string')
      expect(typeof imp.hash).toBe('string')
    }
  })

  it('readInstances: knowledge-base-wide introspection', async () => {
    const all = ready(await readInstances(live.client))
    expect(all.aborted_at_load).toBe(false)
    expect(all.count).toBeGreaterThan(0)
    // count is every PARSED instance; instances carry the RESOLVED ones, so
    // the knowledge base's unresolvable claims leave a gap.
    expect(all.instances.length).toBeLessThanOrEqual(all.count)
    expect(all.instances.length).toBeGreaterThan(0)
    for (const e of all.instances) {
      expect(typeof e.file).toBe('string')
      expect(Array.isArray(e.claim)).toBe(true)
      expect(Array.isArray(e.effective_shape)).toBe(true)
      // schema 28: divergence reads off effective_shape (the `divergent` flag +
      // per-origin shapes), the separate `collisions` channel is gone.
      for (const s of e.effective_shape) {
        expect(typeof s.divergent).toBe('boolean')
      }
      expect(Array.isArray(e.effective_values)).toBe(true)
    }
  })

  it('readCandidates: scanned files present even when empty', async () => {
    const scan = ready(await readCandidates(live.client))
    expect(scan.aborted_at_load).toBe(false)
    expect(scan.candidates.length).toBeGreaterThan(0)
    for (const f of scan.candidates) {
      expect(typeof f.file).toBe('string')
      expect(Array.isArray(f.candidates)).toBe(true)
    }
  })

  it('readInstance: full value layer for a typed instance, null otherwise', async () => {
    const alice = ready(await readInstance(live.client, 'content/alice.md'))
    expect(alice?.resolved).toBe(true)
    expect(alice?.claim).toEqual(['person', 'quality'])
    expect(alice?.closure).toContain('person')
    const name = alice?.effective_values.find((v) => v.field === 'name')
    expect(name?.containers[0]?.value).toEqual({ kind: 'scalar', value: 'Alice' })
    expect(name?.containers[0]?.contributions[0]?.surface).toBe('frontmatter')
    expect(Array.isArray(alice?.diagnostics)).toBe(true)
    expect(ready(await readInstance(live.client, 'content/no-such-file.md'))).toBeNull()
  })

  it('readInstance: a body_fence contribution takes its value kind from the slot (schema 19)', async () => {
    // Fixture `content/decisions/fence-verbatim.md` carries two marked fences.
    // Pre-19 both were yaml-parsed into `inline_record`; now the declared slot
    // decides, and the fence is just the multi-line carrier.
    const memo = ready(await readInstance(live.client, 'content/decisions/fence-verbatim.md'))
    expect(memo?.resolved).toBe(true)

    // A `String` slot reads VERBATIM: blank lines and indentation survive.
    const rationale = memo?.effective_values.find((v) => v.field === 'rationale')
    const rationaleBox = rationale?.containers[0]
    expect(rationaleBox?.contributions[0]?.surface).toBe('body_fence')
    expect(rationaleBox?.value.kind).toBe('scalar')
    const text = (rationaleBox?.value as { kind: 'scalar'; value: unknown }).value
    expect(typeof text).toBe('string')
    expect(text).toContain('\n\n    indented block survives verbatim\n\n')

    // An `opaque` slot is UNINTERPRETED: this content is a well-formed typed
    // mapping, yet it stays raw text (no record-parse, no candidate scan). Post
    // any/opaque split, an inline `any` here would interpret into `inline_record`;
    // `opaque` is the stored-but-never-read slot that keeps the fence verbatim.
    const freeform = memo?.effective_values.find((v) => v.field === 'freeform')
    const freeformBox = freeform?.containers[0]
    expect(freeformBox?.contributions[0]?.surface).toBe('body_fence')
    expect(freeformBox?.value.kind).toBe('scalar')
    // ...and the ` ```yaml ` language tag carried no engine meaning either way.
    expect((freeformBox?.value as { kind: 'scalar'; value: unknown }).value).toContain('type: assumption')
  })

  it('readReferencesOut: every edge classified by surface and kind (schema 17)', async () => {
    const refs = ready(await readReferencesOut(live.client, 'content/alice.md'))
    const out = refs.find((r) => r.target === 'engine project')
    expect(out).toBeDefined()
    expect(out?.resolved?.endsWith('engine project.md')).toBe(true)
    expect(typeof out?.span.start).toBe('number')
    expect(out?.span.line_col?.start.line).toBeGreaterThan(0)
    // schema 17: every edge carries a surface and a load-bearing kind.
    expect(refs.every((r) => r.surface === 'frontmatter' || r.surface === 'body')).toBe(true)
    const kinds = ['field-reference', 'field-string-wikilink', 'contributing', 'navigational', 'unknown']
    expect(refs.every((r) => kinds.includes(r.kind))).toBe(true)
    // frontmatter edges sort before body edges (declaration order, then source order).
    const firstBody = refs.findIndex((r) => r.surface === 'body')
    if (firstBody >= 0) {
      expect(refs.slice(firstBody).every((r) => r.surface === 'body')).toBe(true)
    }
  })

  it('readReferencesIn: inbound edges with surface, slot, and kind (schema 20)', async () => {
    const inbound = ready(await readReferencesIn(live.client, 'content/engine project.md'))
    const fromAlice = inbound.find((b) => b.source.endsWith('alice.md'))
    expect(fromAlice).toBeDefined()
    expect(['frontmatter', 'body']).toContain(fromAlice?.surface)
    expect(typeof fromAlice?.span_start).toBe('number')
    expect(typeof fromAlice?.span_end).toBe('number')
    // schema 20: every inbound edge carries the coarse kind, derived from
    // surface + slot — a frontmatter edge is `field`, a body edge is
    // `navigational` / `contributing`.
    const kinds = ['navigational', 'contributing', 'field']
    expect(inbound.every((b) => kinds.includes(b.kind))).toBe(true)
    expect(inbound.every((b) => (b.surface === 'frontmatter' ? b.kind === 'field' : b.kind !== 'field'))).toBe(true)
  })

  it('readNeighborhood: a bounded walk returns the reachable subgraph (schema 20)', async () => {
    // alice authors outbound edges; a depth-1 out-walk returns the seed plus
    // its direct targets, and the traversed edges between them.
    const nb = ready(await readNeighborhood(live.client, { path: 'content/alice.md', direction: 'out', depth: 1 }))
    expect(nb.truncated).toBe(false)
    expect(nb.dropped).toEqual([])

    // The seed is a depth-0 file node, costed by its byte lengths.
    const seed = nb.nodes.find((n) => n.path.endsWith('alice.md'))
    expect(seed?.depth).toBe(0)
    expect(seed?.file_kind).toBe('instance')
    expect(typeof seed?.bytes).toBe('number')
    expect(typeof seed?.body_bytes).toBe('number')
    // No enrichment requested → the payload keys are absent, not null.
    expect('content' in (seed as object)).toBe(false)
    expect('body' in (seed as object)).toBe(false)
    expect('instance' in (seed as object)).toBe(false)

    // Every node's depth is within the requested bound; the walk reached past the seed.
    expect(nb.nodes.every((n) => n.depth >= 0 && n.depth <= 1)).toBe(true)
    expect(nb.nodes.some((n) => n.depth === 1)).toBe(true)

    // Edges carry the coarse walk vocabulary and a natural-direction from/to.
    const kinds = ['navigational', 'contributing', 'field']
    expect(nb.edges.length).toBeGreaterThan(0)
    for (const e of nb.edges) {
      expect(kinds).toContain(e.kind)
      expect(['frontmatter', 'body']).toContain(e.surface)
      expect(typeof e.span_start).toBe('number')
      expect(typeof e.span_end).toBe('number')
      expect(e.from.path.length).toBeGreaterThan(0)
      // `to` is null only for a dangling / excluded target; these all resolve.
      expect(e.to === null || typeof e.to.path === 'string').toBe(true)
    }
    // Every outbound edge from the seed originates at it.
    expect(nb.edges.every((e) => e.from.path.endsWith('alice.md'))).toBe(true)
  })

  it('readNeighborhood: content enrichment splices the payload onto file nodes (schema 20)', async () => {
    const nb = ready(
      await readNeighborhood(live.client, { path: 'content/alice.md', direction: 'out', depth: 1, content: true }),
    )
    const seed = nb.nodes.find((n) => n.path.endsWith('alice.md'))
    // Present-when-requested: the key exists and carries the content payload.
    expect('content' in (seed as object)).toBe(true)
    expect(seed?.content?.text).toContain('# Alice')
    expect(typeof seed?.content?.hash).toBe('string')
    // bytes was the cost estimate; it matches the spliced payload length.
    expect(seed?.bytes).toBe(seed?.content?.text.length)
  })

  it('readNeighborhood: an absent `kinds` past depth 1 is a read-level error arm (schema 20)', async () => {
    // An unfiltered deep walk explodes through navigational fan-out, so the
    // engine rejects it — surfaced as the error arm, not a throw.
    const outcome = await readNeighborhood(live.client, { path: 'content/alice.md', depth: 2 })
    expect('ok' in outcome && outcome.ok).toBe(false)
    if (!('ok' in outcome)) throw new Error('expected the error arm')
    expect(outcome.error).toContain('kinds')
  })

  // The navigation reads take an `origin` — the file the link appears in — which
  // scopes a bare target to the origin's repo (go-to-definition). The test entry repo
  // is a multi-member workspace, so a bare target with NO origin resolves
  // scopelessly across every member index and is ambiguous → null (WIRE.md
  // `resolve_target`). Pass an origin, as a real navigation consumer does.
  const ORIGIN = 'content/engine project.md'

  it('readResolveTarget: path, kind, hash; null for unresolved', async () => {
    const hit = ready(await readResolveTarget(live.client, 'alice', ORIGIN))
    expect(hit?.path.endsWith('alice.md')).toBe(true)
    expect(hit?.kind).toBe('instance')
    expect(typeof hit?.hash).toBe('string')
    expect(ready(await readResolveTarget(live.client, 'no-such-target', ORIGIN))).toBeNull()
  })

  it('readResolveBlockId: a typed fence id carries its claim', async () => {
    // `^scaling-headroom` trails a `[:assumptions]`-typed yaml fence.
    const block = ready(await readResolveBlockId(live.client, 'sqlite-migration', 'scaling-headroom', ORIGIN))
    expect(block?.file_path.endsWith('sqlite-migration.md')).toBe(true)
    expect(block?.kind).toBe('typed_block')
    expect(block?.type_claim).toEqual(['assumption'])
    expect(ready(await readResolveBlockId(live.client, 'sqlite-migration', 'no-such-id', ORIGIN))).toBeNull()
  })

  it('readResolveAnchor: case-insensitive heading match', async () => {
    const anchor = ready(await readResolveAnchor(live.client, 'alice', 'alice', ORIGIN))
    expect(anchor?.file_path.endsWith('alice.md')).toBe(true)
    expect(anchor?.span.end).toBeGreaterThan(anchor?.span.start ?? 0)
    expect(ready(await readResolveAnchor(live.client, 'alice', 'no such heading', ORIGIN))).toBeNull()
  })

  it('readAnchors: the headings a #anchor can address, its resolve verb pluralized', async () => {
    const anchors = ready(await readAnchors(live.client, 'alice', ORIGIN))
    expect(anchors).not.toBeNull()
    // alice.md carries one heading, `# Alice` — the exact text `#anchor` matches.
    expect(anchors?.map((a) => a.text)).toEqual(['Alice'])
    expect(anchors?.[0]?.level).toBe(1)
    expect(anchors?.[0]?.span.end).toBeGreaterThan(anchors?.[0]?.span.start ?? 0)
    // The entry IS `resolve_anchor`'s payload plus its key: same span, no file_path.
    const resolved = ready(await readResolveAnchor(live.client, 'alice', 'Alice', ORIGIN))
    expect(anchors?.[0]?.span.start).toBe(resolved?.span.start)
    expect(anchors?.[0]).not.toHaveProperty('file_path')
  })

  it('readBlockIds: every addressable id, with typedness on kind', async () => {
    // The session log's frontmatter records — the `^:` surface a body regex misses.
    const ids = ready(await readBlockIds(live.client, 'test-session-log.yaml', ORIGIN))
    expect(ids?.length).toBeGreaterThan(0)
    expect(ids?.every((b) => b.kind === 'record')).toBe(true)
    expect(ids?.[0]?.type_claim).toEqual(['sessionEvent'])
    expect(ids?.[0]?.id.startsWith('^')).toBe(false)
    // Span-sorted, so frontmatter precedes the body the way the file does.
    const starts = ids?.map((b) => b.span.start) ?? []
    expect(starts).toEqual([...starts].sort((a, b) => a - b))

    // A typed fence id: the same entity `resolve_block_id` returns, listed.
    const typed = ready(await readBlockIds(live.client, 'sqlite-migration', ORIGIN))
    const headroom = typed?.find((b) => b.id === 'scaling-headroom')
    expect(headroom?.kind).toBe('typed_block')
    expect(headroom?.type_claim).toEqual(['assumption'])
  })

  it('readAnchors / readBlockIds: null is NOT empty, on the live wire', async () => {
    // The distinction the SDK types preserve — verified against the daemon, not assumed.
    // An UNRESOLVED target answers null.
    expect(ready(await readAnchors(live.client, 'definitely-no-such-target', ORIGIN))).toBeNull()
    expect(ready(await readBlockIds(live.client, 'definitely-no-such-target', ORIGIN))).toBeNull()
    // A target that RESOLVES but carries nothing answers an EMPTY array.
    // The pure-YAML session log has no markdown body, so no headings.
    expect(ready(await readAnchors(live.client, 'test-session-log.yaml', ORIGIN))).toEqual([])
    // alice.md resolves and carries no addressable ids of its own.
    expect(ready(await readBlockIds(live.client, 'alice', ORIGIN))).toEqual([])
  })

  it('readFiles: the resolvable target set, an unread ASSET included', async () => {
    const files = ready(await readFiles(live.client))
    expect(files.length).toBeGreaterThan(0)
    expect(files.some((f) => f.path.endsWith('content/alice.md') && f.kind === 'instance')).toBe(true)
    // The gap this read closes: `candidates` reaches only PARSED files, so an
    // asset — catalogued by path, never read — is absent there and present here.
    expect(files.some((f) => f.kind === 'asset')).toBe(true)
    // `stem` is the basename minus ONE extension, what a bare `[[name]]` resolves by.
    expect(files.find((f) => f.path.endsWith('content/alice.md'))?.stem).toBe('alice')
    // A `*.type.yaml` keeps its `.type` tail, which is why a wikilink by type-name
    // resolves through its own alias rather than the stem.
    const typeDef = files.find((f) => f.path.endsWith('project.type.yaml'))
    expect(typeDef?.stem).toBe('project.type')
    expect(typeDef?.kind).toBe('type-def')
  })

  it('readFiles: scope defaults to ALL, inverting the actionability reads', async () => {
    // A wikilink into a dependency is legal, so the target set spans every member.
    const all = ready(await readFiles(live.client))
    const own = ready(await readFiles(live.client, { scope: 'own' }))
    expect(all.length).toBeGreaterThan(own.length)
    expect(new Set(own.map((f) => f.repo)).size).toBe(1)
    expect(new Set(all.map((f) => f.repo)).size).toBeGreaterThan(1)
    // A `repo` pin does NOT flip the default the way it does on `hubs` / `overview`.
    const pinned = ready(await readFiles(live.client, { repo: own[0]?.repo ?? '' }))
    expect(pinned.length).toBe(own.length)
  })

  it('readFiles: paging slices the filtered order, applied after the filters', async () => {
    const all = ready(await readFiles(live.client))
    const page = ready(await readFiles(live.client, { limit: 3, offset: 2 }))
    expect(page.map((f) => f.path)).toEqual(all.slice(2, 5).map((f) => f.path))
    // Filter first, then page: an own-scoped page is a slice of the OWN set.
    const own = ready(await readFiles(live.client, { scope: 'own' }))
    const ownPage = ready(await readFiles(live.client, { scope: 'own', limit: 3 }))
    expect(ownPage.map((f) => f.path)).toEqual(own.slice(0, 3).map((f) => f.path))
  })

  it('readFiles: path-sorted is COMPONENT-wise, not a JS string compare', async () => {
    // The engine's catalogue is keyed by a Rust `PathBuf`, which compares path
    // segments one at a time. So a directory sorts before a sibling file whose
    // name extends it, where a String compare puts them the other way
    // (`' '` 0x20 < `'/'` 0x2f). A consumer re-sorting client-side must know.
    const paths = ready(await readFiles(live.client, { scope: 'own' })).map((f) => f.path)
    const inDir = paths.findIndex((p) => p.endsWith('content/broken/malformed-qualifier-key.md'))
    const sibling = paths.findIndex((p) => p.endsWith('content/broken example.md'))
    expect(inDir).toBeGreaterThanOrEqual(0)
    expect(sibling).toBeGreaterThanOrEqual(0)
    expect(inDir).toBeLessThan(sibling)
    // Which is exactly where a lexical re-sort would disagree.
    expect([...paths].sort().indexOf(paths[sibling]!)).toBeLessThan([...paths].sort().indexOf(paths[inDir]!))
  })

  it('readDirEntries: direct entries, hidden excluded', async () => {
    const entries = ready(await readDirEntries(live.client, live.entry))
    expect(entries.some((e) => e.name === 'content' && e.kind === 'directory')).toBe(true)
    expect(entries.some((e) => e.name === 'type' && e.kind === 'directory')).toBe(true)
    expect(entries.every((e) => !e.name.startsWith('.'))).toBe(true)
  })

  it('readFrontmatter: the type claim beside the fields', async () => {
    const fm = ready(await readFrontmatter(live.client, 'content/alice.md'))
    expect(fm?.['type']).toEqual(['person', 'quality'])
    expect(fm?.['name']).toBe('Alice')
    expect(ready(await readFrontmatter(live.client, 'content/no-such-file.md'))).toBeNull()
  })

  it('readContent: content + hash, null when unreadable', async () => {
    const read = ready(await readContent(live.client, 'content/alice.md'))
    expect(read?.text).toContain('# Alice')
    expect(typeof read?.hash).toBe('string')
    expect(read?.hash.length).toBeGreaterThan(0)
    expect(ready(await readContent(live.client, 'content/no-such-file.md'))).toBeNull()
  })

  it('readTopLevelDirs: root subdirectories with catalogued files', async () => {
    const graphs = ready(await readTopLevelDirs(live.client))
    const names = graphs.map((g) => g.name)
    expect(names).toContain('content')
    expect(names).toContain('type')
    expect(graphs.every((g) => g.path.startsWith(live.entry))).toBe(true)
  })

  it('readMembers: the workspace member topology, name-sorted', async () => {
    // The smoke entry repo is the copied root alone (the .arsumbris registry is a
    // hidden entry the harness drops), so it surfaces as a single member: the
    // root repo, rooted at the entry, never scattered.
    // schema 17: the `members` read unwraps to the array directly (no wrapper).
    const members = ready(await readMembers(live.client))
    expect(members.length).toBeGreaterThanOrEqual(1)
    const root = members.find((m) => m.root === live.entry)
    expect(root).toBeDefined()
    expect(root?.scattered).toBe(false)
    expect(typeof root?.repo).toBe('string')
    // The entry folder-repo: an editable authoring surface, a live local tree,
    // role `entry` (schema 16, the editable/local/role axes replacing primary).
    expect(root?.editable).toBe(true)
    expect(root?.local).toBe(true)
    expect(root?.role).toBe('entry')
    // every member carries the three axes with the right types.
    for (const m of members) {
      expect(typeof m.editable).toBe('boolean')
      expect(typeof m.local).toBe('boolean')
      expect(['entry', 'edit', 'discover', 'dep']).toContain(m.role)
    }
    // name-sorted, stable across reads.
    const names = members.map((m) => m.repo)
    expect([...names].sort()).toEqual(names)
  })

  it('readResolveMember: routes a path to its owning member, null when under none', async () => {
    const owner = ready(await readResolveMember(live.client, 'content/alice.md'))
    expect(owner?.root).toBe(live.entry)
    expect(typeof owner?.repo).toBe('string')
    // An absolute path outside every member root owns to no member.
    expect(ready(await readResolveMember(live.client, '/nonexistent/elsewhere/x.md'))).toBeNull()
  })

  it('readSemanticTokens: the typed highlight stream, sorted; null for an unheld path', async () => {
    const tokens = ready(await readSemanticTokens(live.client, 'content/alice.md'))
    expect(tokens).not.toBeNull()
    if (!tokens) throw new Error('unreachable')

    // sorted ascending by range.start, per the wire contract.
    for (let i = 1; i < tokens.length; i++) {
      expect(tokens[i]!.range.start).toBeGreaterThanOrEqual(tokens[i - 1]!.range.start)
    }
    // a held file yields the derived line/column on every range.
    expect(tokens.every((t) => t.range.line_col !== undefined)).toBe(true)

    // alice claims `person` — a type-claim token, never a field-value.
    const claim = tokens.find((t) => t.kind === 'type-claim')
    expect(claim && claim.kind === 'type-claim' && claim.name).toBe('person')

    // `name: Alice` — a field-value whose value_type is the shared WireShape.
    const nameTok = tokens.find((t) => t.kind === 'field-value' && t.field === 'name')
    expect(nameTok && nameTok.kind === 'field-value' && nameTok.value_type).toEqual({
      kind: 'primitive',
      name: 'String',
    })

    // alice's body links out — a resolved wikilink carries its target and file path.
    const link = tokens.find((t) => t.kind === 'wikilink-resolved')
    expect(link && link.kind === 'wikilink-resolved' && typeof link.target).toBe('string')
    expect(link && link.kind === 'wikilink-resolved' && typeof link.resolved).toBe('string')

    // not a held file → null, distinct from an empty token stream.
    expect(ready(await readSemanticTokens(live.client, 'content/no-such-file.md'))).toBeNull()
  })

  it('readTypeClosure: multi-fit array with identity, ancestors, and field origins (schema 17)', async () => {
    // `person` is a knowledge-base type (alice claims [person, quality]).
    const closures = ready(await readTypeClosure(live.client, 'person'))
    expect(Array.isArray(closures)).toBe(true)
    expect(closures.length).toBeGreaterThanOrEqual(1)
    const c = closures[0]!
    expect(typeof c.identity.name).toBe('string')
    expect(typeof c.identity.repo).toBe('string')
    expect(typeof c.identity.hash).toBe('string')
    // ancestors: self first, each owner-resolved to a concrete identity.
    expect(c.ancestors[0]?.name).toBe(c.identity.name)
    expect(c.ancestors.every((a) => typeof a.repo === 'string' && typeof a.hash === 'string')).toBe(true)
    // every effective field carries its declaring origin.
    expect(c.fields.every((f) => typeof f.name === 'string' && typeof f.origin.name === 'string')).toBe(true)
    // an unknown name is the empty array (never null, never an error).
    expect(ready(await readTypeClosure(live.client, 'no-such-type-xyz'))).toEqual([])
  })

  it('readValidateValue: multi-fit and FAILS CLOSED on an unknown name (schema 17)', async () => {
    // A known type yields at least one verdict, each with an identity + diagnostics.
    const verdicts = ready(await readValidateValue(live.client, 'person', { name: 'Ada' }))
    expect(Array.isArray(verdicts)).toBe(true)
    expect(verdicts.length).toBeGreaterThanOrEqual(1)
    expect(verdicts.every((v) => Array.isArray(v.diagnostics))).toBe(true)
    expect(verdicts.some((v) => v.identity && typeof v.identity.hash === 'string')).toBe(true)
    // FAILS CLOSED: an unknown name is ONE null-identity verdict carrying
    // unknown-type-claim, never an empty array (which would read as "valid").
    const closed = ready(await readValidateValue(live.client, 'no-such-type-xyz', { name: 'Ada' }))
    expect(closed.length).toBe(1)
    expect(closed[0]!.identity).toBeNull()
    expect(closed[0]!.diagnostics.some((d) => d.code === 'unknown-type-claim')).toBe(true)
  })

  it('readHubs: the ranked reference-graph hubs (schema 17)', async () => {
    // Own-scoped by default; the entry repo's own content carries inbound edges.
    const hubs = ready(await readHubs(live.client))
    expect(Array.isArray(hubs)).toBe(true)
    for (const h of hubs) {
      expect(typeof h.path).toBe('string')
      expect(['instance', 'type-def', 'note']).toContain(h.kind)
      expect(h.refs_total).toBe(h.refs_structural + h.refs_navigational)
    }
    // ranked refs_structural desc, then refs_total desc.
    for (let i = 1; i < hubs.length; i++) {
      const prev = hubs[i - 1]!
      const cur = hubs[i]!
      const ordered =
        prev.refs_structural > cur.refs_structural ||
        (prev.refs_structural === cur.refs_structural && prev.refs_total >= cur.refs_total)
      expect(ordered).toBe(true)
    }
  })

  it('readGraphShape: the scalar whole-graph summary, raw facts', async () => {
    const shape = ready(await readGraphShape(live.client))
    // resolved args echoed back; own-scoped by default.
    expect(shape.scope).toBe('own')
    // counts and the structural/navigational split cohere.
    expect(shape.edge_count).toBe(shape.edges_structural + shape.edges_navigational)
    expect(shape.node_count).toBeGreaterThan(0)
    // isolated is the strict subset of no_inbound.
    expect(shape.orphans.isolated).toBeLessThanOrEqual(shape.orphans.no_inbound)
    // largest component never exceeds the node count.
    expect(shape.largest_component).toBeLessThanOrEqual(shape.node_count)
    // density is the raw quotient.
    expect(shape.density).toBeCloseTo(shape.edge_count / shape.node_count, 6)
    // degree histograms are sorted-by-degree buckets.
    for (const bucket of [...shape.degree.in, ...shape.degree.out]) {
      expect(typeof bucket.degree).toBe('number')
      expect(bucket.count).toBeGreaterThan(0)
    }
    // no orphan paths without the flag; with it, each is tagged.
    expect(shape.orphans.paths).toBeUndefined()
    const withPaths = ready(await readGraphShape(live.client, { orphan_paths: true }))
    for (const o of withPaths.orphans.paths ?? []) {
      expect(typeof o.path).toBe('string')
      expect(['no_inbound', 'isolated']).toContain(o.kind)
    }
  })

  it('readLinkGraph: the full node+edge payload, deterministic and coherent', async () => {
    const graph = ready(await readLinkGraph(live.client))
    expect(graph.scope).toBe('own')
    expect(Array.isArray(graph.nodes)).toBe(true)
    expect(Array.isArray(graph.edges)).toBe(true)
    // nodes sorted by path.
    for (let i = 1; i < graph.nodes.length; i++) {
      expect(graph.nodes[i - 1]!.path <= graph.nodes[i]!.path).toBe(true)
    }
    for (const n of graph.nodes) {
      expect(['instance', 'type-def', 'note', 'asset']).toContain(n.kind)
      expect(n.refs_structural).toBeLessThanOrEqual(n.refs_total)
    }
    // every edge endpoint is an in-scope node, and edges are resolved.
    const paths = new Set(graph.nodes.map((n) => n.path))
    for (const e of graph.edges) {
      expect(paths.has(e.from)).toBe(true)
      expect(paths.has(e.to)).toBe(true)
      expect(['field', 'contributing', 'navigational']).toContain(e.kind)
      expect(['frontmatter', 'body']).toContain(e.surface)
    }
    // refs_total equals the node's inbound-edge count in the same payload.
    const inbound = new Map<string, number>()
    for (const e of graph.edges) inbound.set(e.to, (inbound.get(e.to) ?? 0) + 1)
    for (const n of graph.nodes) {
      expect(n.refs_total).toBe(inbound.get(n.path) ?? 0)
    }
  })

  it('readTypeGraph: the schema graph as a node+edge payload, deterministic and coherent', async () => {
    const graph = ready(await readTypeGraph(live.client, { edges: ['subtype', 'field-type', 'instance-of'] }))
    expect(graph.scope).toBe('own')
    expect(Array.isArray(graph.nodes)).toBe(true)
    expect(Array.isArray(graph.edges)).toBe(true)
    // nodes sorted by path.
    for (let i = 1; i < graph.nodes.length; i++) {
      expect(graph.nodes[i - 1]!.path <= graph.nodes[i]!.path).toBe(true)
    }
    for (const n of graph.nodes) {
      expect(['type-def', 'instance']).toContain(n.kind)
    }
    // edges sorted by (from, to, relation); every endpoint is an in-scope node; induced-subgraph rule.
    const paths = new Set(graph.nodes.map((n) => n.path))
    const requested = new Set(['subtype', 'field-type', 'instance-of'])
    for (const e of graph.edges) {
      expect(paths.has(e.from)).toBe(true)
      expect(paths.has(e.to)).toBe(true)
      expect(requested.has(e.relation)).toBe(true)
      // count weights field-type by the number of field refs; 1 for the others.
      expect(e.count).toBeGreaterThanOrEqual(1)
      if (e.relation !== 'field-type') expect(e.count).toBe(1)
    }
    // absent `edges` defaults to the backbone: no instance-of / meta relations.
    const backbone = ready(await readTypeGraph(live.client))
    for (const e of backbone.edges) {
      expect(['subtype', 'field-type']).toContain(e.relation)
    }
  })

  it('readPreviewMutation write_file: a would-be typed file resolves its identity, git-free', async () => {
    const result = ready(
      await readPreviewMutation(live.client, {
        op: 'write_file',
        path: 'content/preview-new-person.md',
        content: '---\ntype: person\nname: "Preview"\n---\n',
      }),
    )
    if ('reject' in result) throw new Error(`unexpected reject: ${result.reject.message}`)
    expect(result.target.path).toContain('content/preview-new-person.md')
    expect(typeof result.target.hash).toBe('string')
    // the would-be file CLAIMS person; the engine resolves it in the owning repo.
    const names = result.target.identities.map((i) => i.name)
    expect(names).toContain('person')
    for (const id of result.target.identities) {
      expect(typeof id.repo).toBe('string')
      expect(typeof id.hash).toBe('string')
    }
    expect(Array.isArray(result.target.diagnostics)).toBe(true)
    expect(Array.isArray(result.blast_radius)).toBe(true)
    // dry run: no file was written.
    const listed = ready(await readFiles(live.client))
    expect(listed.some((f) => f.path.includes('preview-new-person.md'))).toBe(false)
  })

  it('readPreviewMutation write_file: a plain note claims no identity', async () => {
    const result = ready(
      await readPreviewMutation(live.client, {
        op: 'write_file',
        path: 'content/preview-plain-note.md',
        content: 'just a note, no type claim\n',
      }),
    )
    if ('reject' in result) throw new Error(`unexpected reject: ${result.reject.message}`)
    expect(result.target.identities).toEqual([])
    expect(typeof result.target.hash).toBe('string')
  })

  it('readPreviewMutation edit_file: an existing file previews with a would-be hash', async () => {
    const result = ready(
      await readPreviewMutation(live.client, {
        op: 'edit_file',
        path: 'content/alice.md',
        oldString: 'role: "Founder"',
        newString: 'role: "Co-Founder"',
      }),
    )
    if ('reject' in result) throw new Error(`unexpected reject: ${result.reject.message}`)
    expect(result.target.path).toContain('content/alice.md')
    expect(typeof result.target.hash).toBe('string')
    // alice.md is [person, quality]; the identities survive the edit.
    expect(result.target.identities.map((i) => i.name)).toEqual(expect.arrayContaining(['person', 'quality']))
  })

  it('readPreviewMutation delete_file: hash is null and identities empty', async () => {
    const result = ready(
      await readPreviewMutation(live.client, { op: 'delete_file', path: 'content/alice.md' }),
    )
    if ('reject' in result) throw new Error(`unexpected reject: ${result.reject.message}`)
    expect(result.target.hash).toBeNull()
    expect(result.target.identities).toEqual([])
    // the delete still stands (dry run): alice.md is present.
    const listed = ready(await readFiles(live.client))
    expect(listed.some((f) => f.path.includes('content/alice.md'))).toBe(true)
  })

  it('readPreviewMutation: a structural refusal is a { reject }, DATA on a successful read', async () => {
    const result = ready(
      await readPreviewMutation(live.client, {
        op: 'edit_file',
        path: 'content/does-not-exist.md',
        oldString: 'x',
        newString: 'y',
      }),
    )
    expect('reject' in result).toBe(true)
    if (!('reject' in result)) throw new Error('expected the reject arm')
    expect(typeof result.reject.message).toBe('string')
  })
})
