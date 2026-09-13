// The generic `~/.arsumbris/<owner>/<category>/` path builders, the SDK's single
// derivation of the engine-owned layout convention (spec: arsumbris layout, in
// au-engine). Device + in-repo roots, typed blessed categories + free-form
// custom, raw-$HOME (not canonicalized) matching what the daemon binds.

import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AU_CATEGORIES,
  auDeviceDir,
  auDeviceDirCustom,
  auRepoDir,
  auRepoDirCustom,
  engineSocketDir,
} from '../src/client.ts'

describe('AU_CATEGORIES (the blessed set, single source)', () => {
  it('is exactly the spec set, in spec order', () => {
    expect(AU_CATEGORIES).toEqual(['config', 'cache', 'logs', 'run', 'data'])
  })
})

describe('auDeviceDir (device root, blessed category)', () => {
  let origHome: string | undefined

  beforeEach(() => {
    origHome = process.env.HOME
    process.env.HOME = '/home/tester'
  })

  afterEach(() => {
    process.env.HOME = origHome
  })

  it('composes $HOME/.arsumbris/<owner>/<category> off raw $HOME', () => {
    expect(auDeviceDir('au-host', 'config')).toBe(
      path.join('/home/tester', '.arsumbris', 'au-host', 'config'),
    )
    expect(auDeviceDir('au-engine', 'run')).toBe(
      path.join('/home/tester', '.arsumbris', 'au-engine', 'run'),
    )
  })

  it('an explicit home overrides $HOME without reading process.env.HOME', () => {
    expect(auDeviceDir('au-host', 'run', '/tmp/au-x')).toBe(
      path.join('/tmp/au-x', '.arsumbris', 'au-host', 'run'),
    )
  })

  it('falls back to os.tmpdir() when $HOME is unset', () => {
    delete process.env.HOME
    expect(auDeviceDir('au-host', 'data')).toBe(
      path.join(os.tmpdir(), '.arsumbris', 'au-host', 'data'),
    )
  })

  it('rejects an owner that is not a single segment', () => {
    expect(() => auDeviceDir('../evil', 'config')).toThrow(/single path segment/)
    expect(() => auDeviceDir('a/b', 'config')).toThrow(/single path segment/)
    expect(() => auDeviceDir('..', 'config')).toThrow(/single path segment/)
    expect(() => auDeviceDir('', 'config')).toThrow(/non-empty/)
  })
})

describe('auDeviceDirCustom (device root, free-form category)', () => {
  let origHome: string | undefined

  beforeEach(() => {
    origHome = process.env.HOME
    process.env.HOME = '/home/tester'
  })

  afterEach(() => {
    process.env.HOME = origHome
  })

  it('builds an <other>/ category outside the blessed set', () => {
    expect(auDeviceDirCustom('au-host', 'sessions')).toBe(
      path.join('/home/tester', '.arsumbris', 'au-host', 'sessions'),
    )
  })

  it('throws on every blessed name, steering to the typed door', () => {
    for (const blessed of AU_CATEGORIES) {
      expect(() => auDeviceDirCustom('au-host', blessed)).toThrow(/blessed category/)
    }
  })

  it('rejects a category that is not a single segment', () => {
    expect(() => auDeviceDirCustom('au-host', 'a/b')).toThrow(/single path segment/)
    expect(() => auDeviceDirCustom('au-host', '..')).toThrow(/single path segment/)
  })
})

describe('auRepoDir / auRepoDirCustom (in-repo root)', () => {
  it('bases on the repo root, not $HOME, joined as-given', () => {
    expect(auRepoDir('/repos/kb', 'au-engine', 'logs')).toBe(
      path.join('/repos/kb', '.arsumbris', 'au-engine', 'logs'),
    )
    expect(auRepoDir('/repos/kb', 'au-engine', 'run')).toBe(
      path.join('/repos/kb', '.arsumbris', 'au-engine', 'run'),
    )
  })

  it('the custom in-repo builder mirrors the device split', () => {
    expect(auRepoDirCustom('/repos/kb', 'au-host', 'scratch')).toBe(
      path.join('/repos/kb', '.arsumbris', 'au-host', 'scratch'),
    )
    expect(() => auRepoDirCustom('/repos/kb', 'au-host', 'cache')).toThrow(/blessed category/)
  })

  it('rejects an owner that is not a single segment', () => {
    expect(() => auRepoDir('/repos/kb', 'a/b', 'data')).toThrow(/single path segment/)
  })
})

describe('engineSocketDir subsumes auDeviceDir (one source for .arsumbris)', () => {
  let origHome: string | undefined

  beforeEach(() => {
    origHome = process.env.HOME
    process.env.HOME = '/home/tester'
  })

  afterEach(() => {
    process.env.HOME = origHome
  })

  it('is exactly auDeviceDir(au-engine, run)', () => {
    expect(engineSocketDir()).toBe(auDeviceDir('au-engine', 'run'))
    expect(engineSocketDir('/tmp/h')).toBe(auDeviceDir('au-engine', 'run', '/tmp/h'))
  })
})
