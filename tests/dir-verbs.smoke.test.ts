// The rename preview and the folder verbs (move_dir / delete_dir, and their
// previews) against a live daemon over a GIT-backed copy of the test vault: a
// rename or folder saga compensates through git, so off-git it rejects, and the
// preview rejects exactly where the verb would.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { TypedMutate } from '../src/client.ts'
import { readFiles, readPreviewMutation } from '../src/read-helpers.ts'
import type { TypedRead } from '../src/reads.ts'
import type { WireMutateResult } from '../src/reads.ts'
import { binaryPresent, type LiveDaemon, startLiveDaemon } from './live-daemon.ts'

function ready<T>(outcome: TypedRead<T>): T {
  if ('ok' in outcome) throw new Error(`unexpected wire error: ${outcome.error}`)
  if (!outcome.ready) throw new Error('engine not ready')
  return outcome.result
}

function landed(outcome: TypedMutate): WireMutateResult {
  if ('ok' in outcome) throw new Error(`unexpected mutate reject: ${outcome.error}`)
  if (!outcome.ready) throw new Error('engine not ready')
  return outcome.result
}

describe.skipIf(!binaryPresent)('rename preview and folder verbs against the live daemon', () => {
  let live: LiveDaemon

  beforeAll(async () => {
    live = await startLiveDaemon({ git: true })
  })

  afterAll(async () => {
    await live?.stop()
  })

  it('preview rename: target is the destination, rewrites lists only changed referrers', async () => {
    const result = ready(
      await readPreviewMutation(live.client, { op: 'rename', path: 'content/alice.md', to: 'content/people/alice.md' }),
    )
    if ('reject' in result) throw new Error(`unexpected reject: ${result.reject.message}`)
    expect(result.target.path).toContain('content/people/alice.md')
    expect(typeof result.target.hash).toBe('string')
    expect(Array.isArray(result.rewrites)).toBe(true)
    // a name-keeping move leaves a bare [[alice]] identical: no link re-spells to itself.
    for (const r of result.rewrites ?? []) for (const l of r.links) expect(l.from).not.toBe(l.to)
    expect(result.untracked_files).toEqual([])
    expect(result.stranded).toBeUndefined()
    expect(result.untracked_dirs).toBeUndefined()
  })

  it('preview move_dir: the folder target, path-addressed referrers re-pointed', async () => {
    const result = ready(
      await readPreviewMutation(live.client, { op: 'move_dir', path: 'content/refs', to: 'content/references' }),
    )
    if ('reject' in result) throw new Error(`unexpected reject: ${result.reject.message}`)
    expect(result.target.path).toContain('content/references')
    expect(result.target.hash).toBeNull()
    expect(result.target.identities).toEqual([])
    // [[content/refs/runbook]] is path-addressed, so the move re-spells it.
    const links = (result.rewrites ?? []).flatMap((r) => r.links)
    expect(links).toContainEqual({ from: '[[content/refs/runbook]]', to: '[[content/references/runbook]]' })
    expect(result.untracked_dirs).toEqual([])
    expect(result.untracked_files).toEqual([])
    // dry run: the folder did not move.
    const listed = ready(await readFiles(live.client))
    expect(listed.some((f) => f.path.includes('content/refs/runbook.md'))).toBe(true)
  })

  it('preview delete_dir: stranded names every surviving referrer into the folder', async () => {
    const result = ready(await readPreviewMutation(live.client, { op: 'delete_dir', path: 'content/refs' }))
    if ('reject' in result) throw new Error(`unexpected reject: ${result.reject.message}`)
    expect(result.target.hash).toBeNull()
    expect(result.target.diagnostics).toEqual([])
    const links = (result.stranded ?? []).flatMap((s) => s.links)
    expect(links.length).toBeGreaterThan(0)
    for (const l of links) expect(l.to_file).toContain('content/refs/runbook.md')
    expect(result.rewrites).toBeUndefined()
  })

  it('preview move_dir: a taken destination rejects as data', async () => {
    const result = ready(
      await readPreviewMutation(live.client, { op: 'move_dir', path: 'content/refs', to: 'content/badges' }),
    )
    if (!('reject' in result)) throw new Error('expected the reject arm')
    expect(typeof result.reject.message).toBe('string')
  })

  it('moveDir lands what the preview promised, then deleteDir strands the referrers', async () => {
    const preview = ready(
      await readPreviewMutation(live.client, { op: 'move_dir', path: 'content/refs', to: 'content/references' }),
    )
    if ('reject' in preview) throw new Error(`unexpected reject: ${preview.reject.message}`)

    const moved = landed(await live.client.moveDir('content/refs', 'content/references'))
    expect(moved.path).toContain('content/references')
    expect(moved.hash).toBeNull()
    expect(Object.keys(moved.commits).length).toBeGreaterThan(0)
    expect(moved.rewrites).toEqual(preview.rewrites)
    expect(moved.untracked_files).toEqual([])
    expect(moved.untracked_dirs).toEqual([])

    const deleted = landed(await live.client.deleteDir('content/references'))
    expect(deleted.hash).toBeNull()
    expect(typeof deleted.last_live_commit).toBe('string')
    const stranded = (deleted.stranded ?? []).flatMap((s) => s.links)
    expect(stranded.length).toBeGreaterThan(0)
    for (const l of stranded) expect(l.to_file).toContain('content/references/runbook.md')
    expect(deleted.untracked_files).toEqual([])
  })
})
