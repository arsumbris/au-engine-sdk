// DaemonSupervisor against the real binary: spawn over a temp entry-repo copy,
// probe, stop via the socket, assert the child exits. Plus the pure
// line-splitter. Harness in `live-daemon.ts`.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { DaemonSupervisor, lineSplitter } from '../src/process.ts'
import { AU_BIN, binaryPresent, copyTestEntry, within } from './live-daemon.ts'

describe('lineSplitter', () => {
  it('splits chunks into lines, buffering partials, dropping empties', () => {
    const lines: string[] = []
    const push = lineSplitter((l) => lines.push(l))
    push(Buffer.from('first\nsec'))
    push(Buffer.from('ond\n\nthird\n'))
    expect(lines).toEqual(['first', 'second', 'third'])
  })
})

// The escalation path needs no real daemon: a stub binary that ignores the
// shutdown read and hangs forces the SIGKILL fallback.
describe('DaemonSupervisor kill escalation', () => {
  it('SIGKILLs an owned child that outlives the graceful window', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'au-sdk-hang-'))
    // A binary that ignores its args and never exits — no socket, so the
    // shutdown read cannot reach it; an owned child that will not stop.
    const stub = path.join(dir, 'hang.sh')
    fs.writeFileSync(stub, '#!/bin/sh\nexec sleep 600\n')
    fs.chmodSync(stub, 0o755)

    const supervisor = new DaemonSupervisor()
    const logs: string[] = []
    supervisor.onLog = (line) => logs.push(line)
    const exited = new Promise<number | null>((resolve) => {
      supervisor.onExit = resolve
    })

    try {
      const started = await supervisor.start({ binaryPath: stub, entryPath: dir })
      expect(started).toEqual({ ok: true })

      // No socket → shutdown read fails → escalation fires after the window.
      const stopped = await supervisor.stop(dir, { forceAfterMs: 200 })
      expect(stopped).toEqual({ ok: true })

      const code = await within(5_000, 'forced child exit', exited)
      expect(code).toBeNull() // killed by signal, no exit code
      expect(logs.some((l) => l.includes('SIGKILL'))).toBe(true)

      const after = await supervisor.status(dir)
      expect(after.owned).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 10_000)
})

describe.skipIf(!binaryPresent)('DaemonSupervisor against the real binary', () => {
  let entry: string

  afterAll(() => {
    if (entry) fs.rmSync(entry, { recursive: true, force: true })
  })

  it('runs the full lifecycle: status, start, probe, stop, exit', async () => {
    entry = copyTestEntry()
    const supervisor = new DaemonSupervisor()
    const logs: string[] = []
    supervisor.onLog = (line) => logs.push(line)
    const exited = new Promise<number | null>((resolve) => {
      supervisor.onExit = resolve
    })

    // Idle entry: nothing running, nothing owned.
    const idle = await supervisor.status(entry)
    expect(idle).toEqual({ running: false, booting: false, owned: false, probe: null })

    // Stop without a daemon: a clear refusal.
    const stopIdle = await supervisor.stop(entry)
    expect(stopIdle).toEqual({ ok: false, error: 'no daemon reachable for this entry' })

    // Start, then wait until the daemon serves.
    const started = await supervisor.start({ binaryPath: AU_BIN, entryPath: entry })
    expect(started).toEqual({ ok: true })
    await within(
      15_000,
      'daemon ready',
      (async () => {
        for (;;) {
          const s = await supervisor.status(entry)
          if (s.running && s.probe?.ready) return s
          await new Promise((r) => setTimeout(r, 100))
        }
      })(),
    )
    const running = await supervisor.status(entry)
    expect(running.running).toBe(true)
    expect(running.owned).toBe(true)
    expect(typeof running.probe?.version).toBe('number')

    // A second start refuses: the supervisor owns one already.
    const again = await supervisor.start({ binaryPath: AU_BIN, entryPath: entry })
    expect(again.ok).toBe(false)

    // Stop over the socket; the owned child exits and the callback fires.
    const stopped = await supervisor.stop(entry)
    expect(stopped).toEqual({ ok: true })
    const code = await within(10_000, 'child exit', exited)
    expect(code).toBe(0)

    const after = await supervisor.status(entry)
    expect(after.running).toBe(false)
    expect(after.owned).toBe(false)
  }, 40_000)

  it('reclaims a NON-owned daemon via `au daemon stop --force`', async () => {
    const reclaimEntry = copyTestEntry()
    // Owner spawns the daemon; a SEPARATE supervisor never owns it.
    const owner = new DaemonSupervisor()
    const nonOwner = new DaemonSupervisor()
    const ownerExited = new Promise<number | null>((resolve) => {
      owner.onExit = resolve
    })
    try {
      expect(await owner.start({ binaryPath: AU_BIN, entryPath: reclaimEntry })).toEqual({ ok: true })
      await within(
        15_000,
        'daemon ready',
        (async () => {
          for (;;) {
            if ((await owner.status(reclaimEntry)).probe?.ready) return
            await new Promise((r) => setTimeout(r, 100))
          }
        })(),
      )

      // The non-owner sees a running daemon it does not own.
      const seen = await nonOwner.status(reclaimEntry)
      expect(seen.running).toBe(true)
      expect(seen.owned).toBe(false)

      // Without the binary it could only refuse; WITH it, shell out and reclaim.
      const reclaimed = await nonOwner.stop(reclaimEntry, { auBinaryPath: AU_BIN })
      expect(reclaimed).toEqual({ ok: true })

      // The owner's child goes down, and the entry is no longer served.
      expect(await within(10_000, 'reclaimed child exit', ownerExited)).toBe(0)
      expect((await nonOwner.status(reclaimEntry)).running).toBe(false)
    } finally {
      owner.dispose()
      fs.rmSync(reclaimEntry, { recursive: true, force: true })
    }
  }, 40_000)
})

// The env passthrough needs no real daemon either: a stub that prints the
// variables it was handed proves the merge through the child's own view.
describe('DaemonSupervisor.start env passthrough', () => {
  it('merges config.env over the inherited environment', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'au-sdk-env-'))
    const stub = path.join(dir, 'printenv.sh')
    fs.writeFileSync(stub, '#!/bin/sh\necho "SET=$AU_SDK_SET"\necho "INHERITED=$AU_SDK_INHERITED"\necho "OVERRIDDEN=$AU_SDK_OVERRIDDEN"\necho "PATH_PRESENT=${PATH:+yes}"\nexec sleep 600\n')
    fs.chmodSync(stub, 0o755)

    // Two parent-only names: one the caller leaves alone, one it overrides.
    process.env.AU_SDK_INHERITED = 'from-parent'
    process.env.AU_SDK_OVERRIDDEN = 'from-parent'

    const supervisor = new DaemonSupervisor()
    const logs: string[] = []
    supervisor.onLog = (line) => logs.push(line)

    try {
      const started = await supervisor.start({
        binaryPath: stub,
        entryPath: dir,
        env: { AU_SDK_SET: 'from-caller', AU_SDK_OVERRIDDEN: 'from-caller' },
      })
      expect(started).toEqual({ ok: true })

      await within(
        5_000,
        'stub env output',
        (async () => {
          while (!logs.some((l) => l.startsWith('PATH_PRESENT='))) {
            await new Promise((r) => setTimeout(r, 25))
          }
        })(),
      )

      expect(logs).toContain('SET=from-caller') // the caller's own name reaches the child
      expect(logs).toContain('INHERITED=from-parent') // merged, not replaced
      expect(logs).toContain('OVERRIDDEN=from-caller') // the caller wins on a collision
      expect(logs).toContain('PATH_PRESENT=yes') // PATH survives, so the daemon can still resolve
    } finally {
      await supervisor.stop(dir, { forceAfterMs: 200 })
      delete process.env.AU_SDK_INHERITED
      delete process.env.AU_SDK_OVERRIDDEN
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 10_000)
})

// Spawn confirmation needs no real daemon: a missing binary forces node's
// 'error' event; a live stub forces the 'spawn' event.
describe('DaemonSupervisor.start spawn confirmation', () => {
  it('reports a bad binary path as a failure, never adopting a child', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'au-sdk-badbin-'))
    const supervisor = new DaemonSupervisor()
    let exitFired = false
    supervisor.onExit = () => {
      exitFired = true
    }
    try {
      const started = await supervisor.start({ binaryPath: '/no/such/binary', entryPath: dir })
      expect(started.ok).toBe(false)
      expect(started.ok === false && started.error).toMatch(/failed to spawn daemon/)

      // Never adopted, so a retry is possible and onExit never fired.
      const status = await supervisor.status(dir)
      expect(status.owned).toBe(false)
      expect(exitFired).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves ok once a real child spawns, and fires onExit exactly once on stop', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'au-sdk-spawn-'))
    const stub = path.join(dir, 'hang.sh')
    fs.writeFileSync(stub, '#!/bin/sh\nexec sleep 600\n')
    fs.chmodSync(stub, 0o755)

    const supervisor = new DaemonSupervisor()
    let exitCount = 0
    const exited = new Promise<void>((resolve) => {
      supervisor.onExit = () => {
        exitCount++
        resolve()
      }
    })
    try {
      const started = await supervisor.start({ binaryPath: stub, entryPath: dir })
      expect(started).toEqual({ ok: true })
      expect((await supervisor.status(dir)).owned).toBe(true)

      // No socket → shutdown read fails → SIGKILL fires; onExit fires once.
      await supervisor.stop(dir, { forceAfterMs: 200 })
      await within(5_000, 'forced exit', exited)
      // Give any erroneous second onExit (error+exit double-fire) a chance.
      await new Promise((r) => setTimeout(r, 150))
      expect(exitCount).toBe(1)
      expect((await supervisor.status(dir)).owned).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 10_000)
})
