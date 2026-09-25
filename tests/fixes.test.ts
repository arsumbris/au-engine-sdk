// The consumer-facing `appliableFix` helper: it turns a diagnostic's
// engine-authored `fix.actions[]` into runnable actions, dispatching by verb with
// NO per-code switch and completing the `root` topology arg (via `resolve_member`)
// for composition verbs. A fake client records the calls, so this tests the pure
// dispatch + topology-completion logic without a socket.

import { describe, expect, it } from 'vitest'

import { appliableFix } from '../src/fixes.ts'
import type { DaemonClient, TypedMutate } from '../src/client.ts'
import type { WireDiagnostic, WireMemberOf } from '../src/reads.ts'

/** A fake DaemonClient recording `mutateByVerb`, answering `resolve_member`. */
function fakeClient(member: WireMemberOf | null | 'error' | 'not-ready') {
  const mutations: { verb: string; args: Record<string, unknown> }[] = []
  const client = {
    mutateByVerb(verb: string, args: Record<string, unknown> = {}): Promise<TypedMutate> {
      mutations.push({ verb, args })
      return Promise.resolve({ ready: true, version: 1, result: {} as never })
    },
    read(request: { read: string }): Promise<unknown> {
      if (request.read !== 'resolve_member') throw new Error(`unexpected read ${request.read}`)
      if (member === 'error') return Promise.reject(Object.assign(new Error('boom'), {}))
      if (member === 'not-ready') return Promise.resolve({ ready: false })
      // The schema-17 envelope wraps the payload under the read's own name.
      return Promise.resolve({ ready: true, version: 1, result: { resolve_member: member } })
    },
  }
  return { client: client as unknown as DaemonClient, mutations }
}

/** A diagnostic carrying the given fix actions, at the given file. */
function diag(
  file: string,
  actions?: { verb: string; title: string; args?: Record<string, string> }[],
): WireDiagnostic {
  return {
    code: 'type-repo-not-a-dependency',
    severity: 'error',
    span: { file, range: { start: 0, end: 10 } },
    message: 'x',
    ...(actions !== undefined ? { fix: { description: 'x', actions } } : {}),
  }
}

const EDITABLE: WireMemberOf = { repo: 'au-host', root: '/ws/au-host', editable: true, local: true, role: 'entry' }

describe('appliableFix', () => {
  it('returns [] for a diagnostic with no fix', () => {
    const { client } = fakeClient(EDITABLE)
    expect(appliableFix(client, diag('a.md'))).toEqual([])
  })

  it('returns [] for an advisory-only fix (no actions)', () => {
    const { client } = fakeClient(EDITABLE)
    expect(appliableFix(client, diag('a.md', []))).toEqual([])
  })

  it('maps each action to a titled runnable, preserving order (tier-3 multi-option)', () => {
    const { client } = fakeClient(EDITABLE)
    const fixes = appliableFix(
      client,
      diag('a.md', [
        { verb: 'edit_file', title: 'Use target A', args: { path: 'a.md', old_string: 'x', new_string: 'y' } },
        { verb: 'edit_file', title: 'Use target B', args: { path: 'a.md', old_string: 'x', new_string: 'z' } },
      ]),
    )
    expect(fixes.map((f) => f.title)).toEqual(['Use target A', 'Use target B'])
  })

  it('runs a self-contained verb (edit_file) with args as-is, no resolve_member read', async () => {
    const { client, mutations } = fakeClient('error') // read would throw if reached
    const [fix] = appliableFix(client, diag('a.md', [
      { verb: 'edit_file', title: 'Strip', args: { path: 'a.md', old_string: 'Base::app', new_string: 'Base' } },
    ]))
    const out = await fix.apply()
    expect(out).toEqual({ ready: true, version: 1, result: {} })
    expect(mutations).toEqual([
      { verb: 'edit_file', args: { path: 'a.md', old_string: 'Base::app', new_string: 'Base' } },
    ])
  })

  it('completes root via resolve_member for a composition verb (add_dep)', async () => {
    const { client, mutations } = fakeClient(EDITABLE)
    const [fix] = appliableFix(client, diag('content/x.md', [
      { verb: 'add_dep', title: "Add 'au-base' to deps", args: { name: 'au-base' } },
    ]))
    await fix.apply()
    expect(mutations).toEqual([
      { verb: 'add_dep', args: { name: 'au-base', root: '/ws/au-host' } },
    ])
  })

  it('resolves { ok: false } when the owning member is not editable, without mutating', async () => {
    const { client, mutations } = fakeClient({ ...EDITABLE, editable: false, role: 'dep' })
    const [fix] = appliableFix(client, diag('content/x.md', [
      { verb: 'add_dep', title: 'Add', args: { name: 'au-base' } },
    ]))
    const out = await fix.apply()
    expect(out).toMatchObject({ ok: false })
    expect(mutations).toEqual([])
  })

  it('resolves { ok: false } when no member owns the file', async () => {
    const { client, mutations } = fakeClient(null)
    const [fix] = appliableFix(client, diag('content/x.md', [
      { verb: 'add_dep', title: 'Add', args: { name: 'au-base' } },
    ]))
    const out = await fix.apply()
    expect(out).toMatchObject({ ok: false })
    expect(mutations).toEqual([])
  })
})
