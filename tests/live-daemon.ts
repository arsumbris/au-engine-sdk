// Shared live-daemon harness for the smoke suites.
//
// The engine binary and source entry repo come from the environment:
//   AU_BIN        — daemon binary,     default ../au-engine/target/debug/au
//   AU_TEST_ENTRY — entry repo to copy, default ../au-test-vault
//
// The entry repo is copied to a temp directory per suite, so suites never
// collide with a daemon already serving the shared one (or with each other),
// and file mutations stay harmless.

import { type ChildProcess, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { DaemonClient, probeReady, requestShutdown } from '../src/client.ts'

export const AU_BIN = path.resolve(process.env['AU_BIN'] ?? '../au-engine/target/debug/au')
export const AU_TEST_ENTRY = path.resolve(process.env['AU_TEST_ENTRY'] ?? '../au-test-vault')

export const binaryPresent = fs.existsSync(AU_BIN)
if (!binaryPresent) {
  // Raw stderr: vitest swallows console.* from test modules.
  process.stderr.write(`\n[smoke] SKIPPED: daemon binary not found at ${AU_BIN} (set AU_BIN to point at it)\n`)
}

/** A promise that rejects after `ms`, labelled for the failure message. */
export function within<T>(ms: number, label: string, promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms)),
  ])
}

/** Poll the ready probe until the daemon reports ready, or time out. */
async function waitForReady(entry: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const probe = await probeReady(entry)
    if (probe?.ready) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`daemon over ${entry} not ready within ${timeoutMs}ms`)
}

export interface LiveDaemon {
  /** The temp entry-repo root the daemon serves. */
  entry: string
  client: DaemonClient
  /** Shut the daemon down, close the client, remove the temp copy. */
  stop(): Promise<void>
}

/** Copy the test entry repo to a fresh temp directory; returns its real path. */
export function copyTestEntry(): string {
  // realpath: macOS tmpdir is a symlink (/var → /private/var); the daemon
  // canonicalizes paths, so assertions must compare against the real one.
  const entry = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'au-sdk-smoke-')))
  fs.cpSync(AU_TEST_ENTRY, entry, {
    recursive: true,
    // `.arsumbris` carries the workspace mount state — the resolved dependency
    // members the daemon serves — so it IS part of the wire; keep it. `.git`,
    // `.vscode`, `.DS_Store` play no part, so drop them.
    filter: (src) => {
      const base = path.basename(src)
      return src === AU_TEST_ENTRY || !(base === '.git' || base === '.vscode' || base === '.DS_Store')
    },
  })
  return entry
}

/** Copy the test entry repo, spawn a daemon over it, connect, wait for ready. */
export async function startLiveDaemon(): Promise<LiveDaemon> {
  const entry = copyTestEntry()
  const daemon: ChildProcess = spawn(AU_BIN, ['daemon', 'start', entry], { stdio: 'ignore' })
  await waitForReady(entry, 15_000)
  const client = await DaemonClient.connect(entry)

  return {
    entry,
    client,
    async stop() {
      client.close()
      if (daemon.exitCode === null) {
        const exited = new Promise<void>((resolve) => daemon.once('exit', () => resolve()))
        const accepted = await requestShutdown(entry)
        if (!accepted) daemon.kill('SIGTERM')
        await within(5_000, 'daemon exit', exited).catch(() => daemon.kill('SIGKILL'))
      }
      fs.rmSync(entry, { recursive: true, force: true })
    },
  }
}
