// Daemon-less member resolution: run `au members <entry> --json` and parse it.
// A launcher's pre-start check, answering which declared members would mount
// before any daemon runs. WIRE.md §Daemon-less member resolution.
//
// Node-only (child processes) — root export, never in renderer-safe subpaths.

import { spawn } from 'node:child_process'

import type { WireAuMembersOutput } from './reads.ts'
import { WireSchemaMismatchError, WIRE_SCHEMA_VERSION } from './wire.ts'

/**
 * Why `au members` gave no answer.
 * - `environment` — exit `2`: `$HOME` unset (as `au daemon start` refuses), or a non-UTF-8 path.
 * - `not-a-repo` — exit `5`: the entry is not a folder-repo.
 * - `timeout` — the caller's `timeoutMs` elapsed first; the child was killed.
 * - `aborted` — the caller's `signal` aborted first; the child was killed, or
 *   never spawned when the signal was already aborted.
 * - `unexpected` — anything else: the binary failed to spawn, died by signal,
 *   exited with another code (e.g. an older binary without the subcommand),
 *   or printed stdout that is not the JSON answer.
 */
export type AuMembersFailureKind = 'environment' | 'not-a-repo' | 'timeout' | 'aborted' | 'unexpected'

/** A typed failure of `runAuMembers`, carrying the engine's stderr reason. */
export class AuMembersError extends Error {
  readonly name = 'AuMembersError'
  // Explicit fields, not parameter properties: strip-only type stripping rejects those.
  readonly kind: AuMembersFailureKind
  /** The exit code, or null when the process never ran or died by signal. */
  readonly exitCode: number | null
  /** The engine's stderr, trimmed. Carries the reason on `2` / `5`. */
  readonly stderr: string
  constructor(kind: AuMembersFailureKind, exitCode: number | null, stderr: string, message?: string) {
    super(message ?? (stderr || `au members failed (${kind}, exit ${exitCode})`))
    this.kind = kind
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

export interface RunAuMembersOptions {
  /**
   * Extra environment, MERGED OVER the inherited `process.env`, as
   * `DaemonSpawnConfig.env`. The command reads the same per-user registry and
   * package cache a daemon would, so it needs the same HOME / XDG vars.
   */
  env?: Record<string, string>
  /**
   * Bound on the wait, in milliseconds. When it elapses the child is
   * SIGKILLed and the call rejects `AuMembersError` kind `timeout`. Absent
   * means unbounded.
   */
  timeoutMs?: number
  /**
   * Cancels the call, e.g. a check superseded by a newer one. On abort the
   * child is SIGKILLed and the call rejects `AuMembersError` kind `aborted`.
   */
  signal?: AbortSignal
}

/**
 * Run `<binaryPath> members <entryPath> --json` and parse its answer.
 *
 * Resolves with the output on exit `0`, unmounted members included (only
 * `tier: 'unmounted'` wants a locate). Rejects with:
 * - `AuMembersError` for exit `2` / `5`, a `timeout` / `aborted` bound, or any
 *   `unexpected` outcome.
 * - `WireSchemaMismatchError` when the binary speaks another `schema_version`,
 *   the same check the client applies to the daemon.
 */
export async function runAuMembers(
  binaryPath: string,
  entryPath: string,
  options: RunAuMembersOptions = {},
): Promise<WireAuMembersOutput> {
  if (options.signal?.aborted) {
    throw new AuMembersError('aborted', null, '', 'au members aborted before it ran')
  }
  const args = ['members', entryPath, '--json']
  const child = options.env
    ? spawn(binaryPath, args, { env: { ...process.env, ...options.env } })
    : spawn(binaryPath, args)

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))

  // 'close' fires after the stdio streams end, so the buffers are complete.
  // A spawn failure fires 'error' and then 'close' with a null code; the
  // 'error' reason wins. A timeout / abort settles at once instead of waiting
  // for 'close': a grandchild of the killed process can hold the pipes open.
  const exit = await new Promise<{
    code: number | null
    spawnError: Error | null
    bound: 'timeout' | 'aborted' | null
  }>((resolve) => {
    let spawnError: Error | null = null
    let settled = false
    const settle = (code: number | null, bound: 'timeout' | 'aborted' | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({ code, spawnError, bound })
    }
    const stop = (bound: 'timeout' | 'aborted') => {
      if (settled) return
      child.kill('SIGKILL')
      child.stdout.destroy()
      child.stderr.destroy()
      settle(null, bound)
    }
    const onAbort = () => stop('aborted')
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => stop('timeout'), options.timeoutMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.once('error', (err) => (spawnError = err))
    child.once('close', (code) => settle(code, null))
  })

  const reason = stderr.trim()
  if (exit.bound === 'timeout') {
    throw new AuMembersError('timeout', null, reason, `au members did not answer within ${options.timeoutMs}ms`)
  }
  if (exit.bound === 'aborted') throw new AuMembersError('aborted', null, reason, 'au members aborted')
  if (exit.spawnError) {
    throw new AuMembersError('unexpected', null, reason, `failed to run au members: ${exit.spawnError.message}`)
  }
  if (exit.code === 2) throw new AuMembersError('environment', 2, reason)
  if (exit.code === 5) throw new AuMembersError('not-a-repo', 5, reason)
  if (exit.code !== 0) throw new AuMembersError('unexpected', exit.code, reason)

  let output: WireAuMembersOutput
  try {
    output = JSON.parse(stdout) as WireAuMembersOutput
  } catch (err) {
    throw new AuMembersError('unexpected', 0, reason, `au members printed unparseable stdout: ${(err as Error).message}`)
  }
  if (output.schema_version !== WIRE_SCHEMA_VERSION) {
    throw new WireSchemaMismatchError(output.schema_version)
  }
  return output
}
