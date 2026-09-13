// The hashed out-of-tree socket derivation, mirroring `au_engine::socket_path`.
// A mismatch means clients cannot find the daemon, so the hash is pinned against
// the canonical FNV-1a-64 test vectors (independent of the engine), and the path
// composition against an isolated HOME.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  engineSocketDir,
  pidAlive,
  pidPath,
  pidPathForHash,
  readDaemonPid,
  socketFileName,
  socketPath,
  socketPathForHash,
} from '../src/client.ts'

describe('socketFileName (FNV-1a-64 of the entry bytes)', () => {
  // Canonical FNV-1a-64 test vectors — the same algorithm the engine's
  // ContentHash::of implements. `socketFileName` hashes the bytes verbatim (the
  // caller supplies a canonical path), so these pin the hash cross-language.
  it('matches the published FNV-1a-64 vectors, 16 lowercase hex + .sock', () => {
    expect(socketFileName('')).toBe('cbf29ce484222325.sock') // the offset basis
    expect(socketFileName('a')).toBe('af63dc4c8601ec8c.sock')
    expect(socketFileName('foobar')).toBe('85944171f73967e8.sock')
  })

  it('is fixed-width regardless of entry depth (the SUN_LEN fix)', () => {
    const shallow = socketFileName('/a')
    const deep = socketFileName('/very/deeply/nested/entry/tree/that/would/overrun/sun_path/workspace')
    expect(shallow).toHaveLength(21) // 16 hex + '.sock'
    expect(deep).toHaveLength(21)
    expect(deep).toMatch(/^[0-9a-f]{16}\.sock$/)
  })

  it('is deterministic and distinguishes distinct entries', () => {
    expect(socketFileName('/repos/kb')).toBe(socketFileName('/repos/kb'))
    expect(socketFileName('/repos/kb')).not.toBe(socketFileName('/repos/other'))
  })
})

describe('socketPath', () => {
  let entry: string
  let origHome: string | undefined

  beforeEach(() => {
    entry = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'au-sock-')))
    origHome = process.env.HOME
    process.env.HOME = '/home/tester'
  })

  afterEach(() => {
    fs.rmSync(entry, { recursive: true, force: true })
    process.env.HOME = origHome
  })

  it('composes $HOME/.arsumbris/au-engine/run/<hash>.sock from the realpath of the entry', () => {
    const derived = socketPath(entry)
    expect(derived).toBe(path.join('/home/tester', '.arsumbris', 'au-engine', 'run', socketFileName(entry)))
  })

  it('canonicalizes the entry before hashing (both sides hash an identical string)', () => {
    // A symlink to the entry must derive the same socket as the entry itself.
    const link = path.join(os.tmpdir(), `au-sock-link-${socketFileName(entry).slice(0, 8)}`)
    fs.rmSync(link, { force: true })
    fs.symlinkSync(entry, link)
    try {
      expect(socketPath(link)).toBe(socketPath(entry))
    } finally {
      fs.rmSync(link, { force: true })
    }
  })

  it('is composed from engineSocketDir + socketFileName (one source for the dir literal)', () => {
    expect(socketPath(entry)).toBe(path.join(engineSocketDir(), socketFileName(entry)))
  })
})

describe('engineSocketDir + socketPathForHash (hash-keyed door, no entry held)', () => {
  let origHome: string | undefined

  beforeEach(() => {
    origHome = process.env.HOME
    process.env.HOME = '/home/tester'
  })

  afterEach(() => {
    process.env.HOME = origHome
  })

  it('engineSocketDir is $HOME/.arsumbris/au-engine/run off RAW $HOME', () => {
    expect(engineSocketDir()).toBe(path.join('/home/tester', '.arsumbris', 'au-engine', 'run'))
  })

  it('falls back to os.tmpdir() when $HOME is unset', () => {
    delete process.env.HOME
    expect(engineSocketDir()).toBe(path.join(os.tmpdir(), '.arsumbris', 'au-engine', 'run'))
  })

  it('socketPathForHash joins <hash>.sock onto engineSocketDir', () => {
    expect(socketPathForHash('85944171f73967e8')).toBe(
      path.join('/home/tester', '.arsumbris', 'au-engine', 'run', '85944171f73967e8.sock'),
    )
  })

  it('a hash-keyed lookup reaches the same path as the entry-keyed socketPath', () => {
    // A consumer holding only the hash (e.g. sweeping sibling gen-trees) must
    // land on exactly what socketPath builds for the corresponding entry.
    const entry = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'au-sock-hash-')))
    try {
      const hash = socketFileName(entry).replace(/\.sock$/, '')
      expect(socketPathForHash(hash)).toBe(socketPath(entry))
    } finally {
      fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  it('an explicit home overrides $HOME WITHOUT reading process.env.HOME', () => {
    // A consumer threading its own per-call home (e.g. a test planting sockets
    // under a temp home) must land under that home, not process.env.HOME.
    expect(engineSocketDir('/tmp/au-sk-xyz')).toBe(
      path.join('/tmp/au-sk-xyz', '.arsumbris', 'au-engine', 'run'),
    )
    expect(socketPathForHash('85944171f73967e8', '/tmp/au-sk-xyz')).toBe(
      path.join('/tmp/au-sk-xyz', '.arsumbris', 'au-engine', 'run', '85944171f73967e8.sock'),
    )
  })

  it('an explicit home wins even when process.env.HOME is set elsewhere', () => {
    process.env.HOME = '/home/tester'
    expect(engineSocketDir('/tmp/other')).toBe(
      path.join('/tmp/other', '.arsumbris', 'au-engine', 'run'),
    )
  })
})

describe('pidPath + pidPathForHash (the <hash>.pid beside the socket)', () => {
  let entry: string
  let origHome: string | undefined

  beforeEach(() => {
    entry = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'au-pid-')))
    origHome = process.env.HOME
    process.env.HOME = '/home/tester'
  })

  afterEach(() => {
    fs.rmSync(entry, { recursive: true, force: true })
    process.env.HOME = origHome
  })

  it('is the socket path with .sock swapped for .pid, same hash', () => {
    expect(pidPath(entry)).toBe(socketPath(entry).replace(/\.sock$/, '.pid'))
  })

  it('canonicalizes the entry before hashing, as socketPath does', () => {
    const link = path.join(os.tmpdir(), `au-pid-link-${socketFileName(entry).slice(0, 8)}`)
    fs.rmSync(link, { force: true })
    fs.symlinkSync(entry, link)
    try {
      expect(pidPath(link)).toBe(pidPath(entry))
    } finally {
      fs.rmSync(link, { force: true })
    }
  })

  it('pidPathForHash joins <hash>.pid onto engineSocketDir, matching pidPath', () => {
    const hash = socketFileName(entry).replace(/\.sock$/, '')
    expect(pidPathForHash(hash)).toBe(
      path.join('/home/tester', '.arsumbris', 'au-engine', 'run', `${hash}.pid`),
    )
    expect(pidPathForHash(hash)).toBe(pidPath(entry))
  })
})

describe('readDaemonPid (mirrors the engine write side)', () => {
  let entry: string
  let origHome: string | undefined

  beforeEach(() => {
    // A real temp HOME so pidPath resolves to a directory the test can write.
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'au-pid-home-')))
    origHome = process.env.HOME
    process.env.HOME = home
    fs.mkdirSync(engineSocketDir(), { recursive: true })
    entry = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'au-pid-entry-')))
  })

  afterEach(() => {
    fs.rmSync(process.env.HOME!, { recursive: true, force: true })
    fs.rmSync(entry, { recursive: true, force: true })
    process.env.HOME = origHome
  })

  it('returns null when no pid file is present', () => {
    expect(readDaemonPid(entry)).toBeNull()
  })

  it('reads a bare decimal pid, trimming whitespace', () => {
    fs.writeFileSync(pidPath(entry), '4242\n')
    expect(readDaemonPid(entry)).toBe(4242)
  })

  it('treats an unparseable file as absent (a corrupt pid never signals)', () => {
    fs.writeFileSync(pidPath(entry), 'not-a-pid')
    expect(readDaemonPid(entry)).toBeNull()
  })
})

describe('pidAlive (mirrors kill(pid, 0) liveness)', () => {
  it('is true for a live process', () => {
    expect(pidAlive(process.pid)).toBe(true)
  })

  it('is false for a pid that names no process', () => {
    // A pid well above any live one; ESRCH → not alive.
    expect(pidAlive(0x7fffffff)).toBe(false)
  })
})
