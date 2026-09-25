// runAuMembers: exit-code mapping against stub binaries, then the real `au`
// over the test vault. Harness in `live-daemon.ts`.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { AuMembersError, runAuMembers } from '../src/members-cli.ts'
import { WireSchemaMismatchError, WIRE_SCHEMA_VERSION } from '../src/wire.ts'
import { AU_BIN, AU_TEST_ENTRY, binaryPresent } from './live-daemon.ts'

/** A shell stub standing in for `au`: prints stdout / stderr, exits with `code`. */
function stub(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'au-sdk-members-'))
  const file = path.join(dir, 'au.sh')
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`)
  fs.chmodSync(file, 0o755)
  return file
}

async function failure(bin: string): Promise<AuMembersError> {
  const err = await runAuMembers(bin, '/entry').catch((e: unknown) => e)
  expect(err).toBeInstanceOf(AuMembersError)
  return err as AuMembersError
}

describe('runAuMembers exit mapping', () => {
  it('passes `members <entry> --json` and parses exit 0', async () => {
    const out = { schema_version: WIRE_SCHEMA_VERSION, entry: '/entry', complete: true, incomplete: [], members: [], diagnostics: [] }
    const bin = stub(`[ "$1 $2 $3" = "members /entry --json" ] || exit 9\necho '${JSON.stringify(out)}'`)
    expect(await runAuMembers(bin, '/entry')).toEqual(out)
  })

  it('maps exit 2 to environment, carrying stderr', async () => {
    const err = await failure(stub('echo "au: HOME is unset" >&2; exit 2'))
    expect(err).toMatchObject({ kind: 'environment', exitCode: 2, stderr: 'au: HOME is unset' })
  })

  it('maps exit 5 to not-a-repo', async () => {
    const err = await failure(stub('echo "not a folder-repo" >&2; exit 5'))
    expect(err).toMatchObject({ kind: 'not-a-repo', exitCode: 5 })
  })

  it('maps any other exit, a missing binary, and bad stdout to unexpected', async () => {
    expect(await failure(stub('exit 64'))).toMatchObject({ kind: 'unexpected', exitCode: 64 })
    expect(await failure('/nonexistent/au')).toMatchObject({ kind: 'unexpected', exitCode: null })
    expect(await failure(stub('echo not-json'))).toMatchObject({ kind: 'unexpected', exitCode: 0 })
  })

  it('rejects another schema_version as WireSchemaMismatchError', async () => {
    const bin = stub(`echo '{"schema_version":${WIRE_SCHEMA_VERSION + 1}}'`)
    await expect(runAuMembers(bin, '/entry')).rejects.toBeInstanceOf(WireSchemaMismatchError)
  })
})

describe('runAuMembers bounds', () => {
  // `sleep` without `exec` runs as a grandchild holding the stdout pipe, the
  // case that must not wait for 'close'.
  const hang = () => stub('sleep 5')

  it('kills on timeoutMs and rejects timeout', async () => {
    const started = Date.now()
    const err = await runAuMembers(hang(), '/entry', { timeoutMs: 100 }).catch((e: unknown) => e)
    expect(err).toMatchObject({ kind: 'timeout', exitCode: null })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('kills on abort and rejects aborted', async () => {
    const ctrl = new AbortController()
    const pending = runAuMembers(hang(), '/entry', { signal: ctrl.signal }).catch((e: unknown) => e)
    setTimeout(() => ctrl.abort(), 50)
    expect(await pending).toMatchObject({ kind: 'aborted', exitCode: null })
  })

  it('rejects an already-aborted signal without running', async () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'au-sdk-marker-')), 'ran')
    const err = await runAuMembers(stub(`touch ${marker}`), '/entry', { signal: AbortSignal.abort() }).catch(
      (e: unknown) => e,
    )
    expect(err).toMatchObject({ kind: 'aborted' })
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('an unfired bound leaves a normal answer untouched', async () => {
    const out = { schema_version: WIRE_SCHEMA_VERSION, entry: '/entry', complete: true, incomplete: [], members: [], diagnostics: [] }
    const ctrl = new AbortController()
    const bin = stub(`echo '${JSON.stringify(out)}'`)
    expect(await runAuMembers(bin, '/entry', { timeoutMs: 5000, signal: ctrl.signal })).toEqual(out)
    ctrl.abort()
  })
})

describe.skipIf(!binaryPresent)('runAuMembers against the real binary', () => {
  it('answers the test vault with tiered, name-sorted members', async () => {
    const out = await runAuMembers(AU_BIN, AU_TEST_ENTRY)
    expect(out.schema_version).toBe(WIRE_SCHEMA_VERSION)
    expect(out.entry).toBe(fs.realpathSync(AU_TEST_ENTRY))
    expect(out.members.length).toBeGreaterThan(0)
    const names = out.members.map((m) => m.name)
    expect(names).toEqual([...names].sort())
    for (const m of out.members) {
      expect(['entry', 'sibling', 'registry', 'cache', 'unmounted', 'disabled']).toContain(m.tier)
      if (m.tier === 'unmounted') expect(m.path).toBeUndefined()
      else if (m.tier !== 'disabled') expect(typeof m.path).toBe('string')
    }
    expect(out.members.some((m) => m.tier === 'entry' && m.role === 'entry')).toBe(true)
  })

  it('rejects a non-repo entry as not-a-repo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'au-sdk-norepo-'))
    const err = await runAuMembers(AU_BIN, dir).catch((e: unknown) => e)
    expect(err).toMatchObject({ kind: 'not-a-repo', exitCode: 5 })
    expect((err as AuMembersError).stderr).toMatch(/not a folder-repo/)
  })
})
