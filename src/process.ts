// Daemon process management: spawn `au daemon start` as an owned child,
// stop via the socket's shutdown read, probe status via the ready read.
// The DaemonSupervisor core is a consumer-proven shape, built and validated
// in consumers before it moved here.
//
// Lifecycle is consumer-driven: nothing here runs without an explicit call.
// Node-only (child processes) — root export, never in renderer-safe subpaths.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import { probeReady, requestShutdown, readDaemonPid, pidAlive } from './client.ts'
import type { ReadyProbe } from './wire.ts'

/** Where the daemon binary lives and which entry repo it serves. */
export interface DaemonSpawnConfig {
  binaryPath: string
  entryPath: string
  /**
   * Extra environment for the daemon child, MERGED OVER the inherited
   * `process.env` rather than replacing it — the daemon still needs PATH,
   * HOME and the XDG vars to find its config and cache, so a caller sets one
   * variable without reconstructing a whole environment.
   *
   * Merging means a variable can be set or overridden here, never UNSET: a
   * name the parent process carries always reaches the child. To keep a
   * variable off the daemon, keep it off the parent.
   *
   * The SDK does not interpret these. Whatever the engine reads at spawn
   * (e.g. its tracing gate) stays the engine's concept, set by the consumer.
   */
  env?: Record<string, string>
}

/**
 * The graceful window before an owned child is force-killed. A consumer-proven value.
 *
 * COUPLED with the engine CLI's `FORCE_STOP_WINDOW` (also 1500ms), which the
 * `au daemon stop --force` path we shell out to for the non-owned case uses for
 * its own graceful→SIGTERM→SIGKILL windows. The two live either side of the
 * Rust/TS boundary with no shared constant, so a change to one MUST be mirrored
 * to the other (see au-engine `crates/au-cli/src/daemon.rs`); the CHANGELOG
 * records the coupling.
 */
const DEFAULT_FORCE_AFTER_MS = 1500

export interface StopOptions {
  /**
   * Window after the socket shutdown before an OWNED child is SIGKILLed,
   * in milliseconds. Default 1500. Ignored for a daemon this supervisor does
   * not own — the engine CLI owns the window for that path (see `auBinaryPath`).
   */
  forceAfterMs?: number
  /**
   * The `au` binary path, enabling NON-OWNED force reclaim. When the daemon on
   * this entry is not owned by this supervisor and its socket does not answer
   * (booting or wedged), `stop()` shells out to `au daemon stop --force <entry>`
   * to reclaim it by the recorded pid. The engine owns the whole
   * graceful→SIGTERM→SIGKILL sequence, so the SDK never re-implements it and the
   * two cannot drift.
   *
   * Absent → a non-owned daemon keeps the socket as its only stop path (prior
   * behavior): a wedged one that will not answer the socket is left alone.
   * Callers already hold this path as `DaemonSpawnConfig.binaryPath`.
   */
  auBinaryPath?: string
}

export interface SupervisedDaemonStatus {
  /** A daemon answered the ready probe on the entry repo's socket. */
  running: boolean
  /**
   * A daemon recorded a live pid for this entry but its socket is NOT yet
   * answering: it is mid cold-build (booting) or wedged. Mirrors the engine's
   * `au daemon status` "present but not yet serving" state, distinguished from
   * absent. Never true at the same time as `running` (a serving daemon answers
   * its socket); a consumer shows this as "starting", not "not running".
   */
  booting: boolean
  /** This supervisor currently owns a spawned daemon child process. */
  owned: boolean
  probe: ReadyProbe | null
}

export type SupervisorResult = { ok: true } | { ok: false; error: string }

/** Split a stdout/stderr stream into lines for a log surface. */
export function lineSplitter(onLine: (line: string) => void): (chunk: Buffer) => void {
  let rest = ''
  return (chunk) => {
    rest += chunk.toString('utf8')
    const lines = rest.split('\n')
    rest = lines.pop() ?? ''
    for (const line of lines) if (line.length > 0) onLine(line)
  }
}

export class DaemonSupervisor {
  private child: ChildProcessWithoutNullStreams | null = null
  private childEntry: string | null = null

  /** Plain callbacks: assign to receive the child's log lines and exit. */
  onLog: (line: string) => void = () => {}
  onExit: (code: number | null) => void = () => {}

  async status(entryPath: string): Promise<SupervisedDaemonStatus> {
    const probe = await probeReady(entryPath)
    const running = probe !== null
    // Only probe the pid file when the socket is silent: a serving daemon is
    // running, not booting. A recorded, live pid with no socket answer is the
    // booting/wedged state. Pure observation — no kill sequence to duplicate,
    // so this stays in-node and needs no `au` binary.
    let booting = false
    if (!running) {
      const pid = readDaemonPid(entryPath)
      booting = pid !== null && pidAlive(pid)
    }
    return {
      running,
      booting,
      owned: this.child !== null,
      probe,
    }
  }

  /**
   * Spawn a daemon over the entry repo as an owned child. Refuses when this
   * supervisor already owns one, or when any daemon already serves that entry
   * (one daemon per entry is the engine's contract).
   *
   * Resolves only once the spawn is confirmed: a bad binary path or a
   * permission error comes back as `{ ok: false, error }` (node's `'error'`
   * event, no process), so a consumer's Start command can show the specific
   * cause synchronously instead of discovering it later through `onExit`.
   * A daemon that spawns and then dies is a lifecycle event, surfaced via
   * `onExit` (probe readiness to confirm it actually came up).
   */
  async start(config: DaemonSpawnConfig): Promise<SupervisorResult> {
    if (this.child) {
      return { ok: false, error: 'this supervisor already owns a running daemon child' }
    }
    const probe = await probeReady(config.entryPath)
    if (probe) {
      return { ok: false, error: 'a daemon is already serving this entry' }
    }

    // No `env` given → no options object at all, so node's own inheritance
    // applies. With one, the merge keeps the inherited environment and layers
    // the caller's names on top.
    const child = config.env
      ? spawn(config.binaryPath, ['daemon', 'start', config.entryPath], {
          env: { ...process.env, ...config.env },
        })
      : spawn(config.binaryPath, ['daemon', 'start', config.entryPath])

    // 'spawn' fires once the OS has the process; 'error' fires instead when
    // it cannot start it at all. Whichever comes first decides the outcome.
    const outcome = await new Promise<SupervisorResult>((resolve) => {
      const settle = (result: SupervisorResult): void => {
        child.removeListener('spawn', onSpawn)
        child.removeListener('error', onError)
        child.removeListener('exit', onEarlyExit)
        resolve(result)
      }
      const onSpawn = (): void => settle({ ok: true })
      const onError = (err: Error): void => settle({ ok: false, error: `failed to spawn daemon: ${err.message}` })
      const onEarlyExit = (code: number | null): void =>
        settle({ ok: false, error: `daemon exited before it started (code ${code})` })
      child.once('spawn', onSpawn)
      child.once('error', onError)
      child.once('exit', onEarlyExit)
    })
    if (!outcome.ok) return outcome

    // Spawn confirmed — adopt the child and wire the long-running handlers.
    // No event-loop turn passed between settle() and here, so no exit can
    // slip through the gap.
    this.child = child
    this.childEntry = config.entryPath

    // A late 'error' and the final 'exit' can both fire; collapse them to a
    // single onExit. Detaching here is idempotent under the same guard.
    let exited = false
    const notifyExit = (code: number | null): void => {
      if (exited) return
      exited = true
      this.detachStdio(child) // stop reading the pipes so a late read cannot race the close (see detachStdio).
      this.child = null
      this.childEntry = null
      this.onExit(code)
    }

    child.stdout.on('data', lineSplitter((line) => this.onLog(line)))
    child.stderr.on('data', lineSplitter((line) => this.onLog(line)))
    child.on('error', (err) => {
      this.onLog(`daemon error: ${err.message}`)
      notifyExit(null)
    })
    child.on('exit', (code) => notifyExit(code))

    return { ok: true }
  }

  /**
   * Ask the daemon serving the entry repo to shut down via the socket. For an
   * owned child that outlives the graceful window, escalate to SIGKILL so
   * a hung daemon cannot strand the consumer. An unowned daemon has no PID
   * here, so the socket stays its only stop path.
   */
  async stop(entryPath: string, options?: StopOptions): Promise<SupervisorResult> {
    const ownedChild = this.childEntry === entryPath ? this.child : null
    // Stop consuming the owned child's stdio BEFORE it goes down (graceful exit or the SIGKILL below), so no
    // pending pipe read races the close. The macOS/libuv fault (`Pipe.onStreamRead` handed a positive nread,
    // `ERR_OUT_OF_RANGE` in `getSystemErrorName`) throws from a libuv callback — uncatchable via a stream
    // 'error' handler — so the fix is to not be reading when the pipe closes abruptly.
    if (ownedChild) this.detachStdio(ownedChild)
    const sent = await requestShutdown(entryPath)
    if (!ownedChild) {
      // Socket answered → graceful shutdown is underway; no PID to wait on here.
      if (sent) return { ok: true }
      // Socket silent: a booting/wedged non-owned daemon holds its entry without
      // answering. With the `au` binary, reclaim it by its recorded pid via the
      // engine's OWN force-stop (graceful→SIGTERM→SIGKILL), so the kill sequence
      // has one source of truth and the SDK cannot drift from it. Without the
      // binary, the socket was the only path and it is gone → not reachable.
      if (options?.auBinaryPath) return forceStopNonOwned(options.auBinaryPath, entryPath)
      return { ok: false, error: 'no daemon reachable for this entry' }
    }
    // Owned: a clean shutdown read makes the child exit on its own; if it
    // hangs (or the socket never answered), force-kill after the window.
    const exited = await waitForExit(ownedChild, options?.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS)
    if (!exited) {
      this.onLog('graceful shutdown timed out, sending SIGKILL')
      ownedChild.kill('SIGKILL')
    }
    return { ok: true }
  }

  /**
   * Best-effort teardown of an owned child, for consumer shutdown. Fires the
   * socket shutdown and, fire-and-forget, the same SIGKILL escalation.
   * Synchronous: the escalation timer is not awaited.
   */
  dispose(options?: StopOptions): void {
    if (this.child && this.childEntry) {
      void this.stop(this.childEntry, options)
    }
  }

  /**
   * Stop consuming the child's stdout/stderr pipes before it dies. PAUSING removes the flowing-mode read
   * (libuv `read_stop`) WITHOUT closing the read end — closing it would EPIPE the daemon's next write. This
   * avoids the macOS/libuv fault where an abrupt pipe close (a SIGKILL'd child) delivers a positive `nread`
   * to `Pipe.onStreamRead`, which builds an `ErrnoException` from it and throws `ERR_OUT_OF_RANGE` out of a
   * libuv callback — an UNCATCHABLE uncaught exception (a stream 'error' handler cannot see it, the throw is
   * in constructing the error). The only prevention is to not be reading when the pipe closes. Idempotent and
   * best-effort: a stream already ended is fine.
   */
  private detachStdio(child: ChildProcessWithoutNullStreams): void {
    for (const stream of [child.stdout, child.stderr]) {
      try {
        stream.removeAllListeners('data')
        stream.pause()
      } catch {
        // teardown best-effort — an already-destroyed stream needs nothing.
      }
    }
  }
}

/**
 * Reclaim a NON-owned wedged daemon by shelling out to
 * `au daemon stop --force <entry>`. The engine connects the socket first
 * (graceful), then signals the recorded pid (SIGTERM→SIGKILL over its
 * FORCE_STOP_WINDOW) only if the socket stayed silent, and exits 0 on every
 * reclaim/absence path — so a non-zero exit is a real failure, surfaced with
 * the CLI's stderr. stdout is ignored; only stderr is piped, for the message.
 */
function forceStopNonOwned(binaryPath: string, entryPath: string): Promise<SupervisorResult> {
  return new Promise((resolve) => {
    const child = spawn(binaryPath, ['daemon', 'stop', entryPath, '--force'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', (err) =>
      resolve({ ok: false, error: `failed to run 'au daemon stop --force': ${err.message}` }),
    )
    child.once('exit', (code) =>
      resolve(
        code === 0
          ? { ok: true }
          : { ok: false, error: `'au daemon stop --force' exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}` },
      ),
    )
  })
}

/**
 * Resolve true if the child has exited within `ms`, false on timeout.
 * Resolves immediately for an already-dead child.
 */
function waitForExit(child: ChildProcessWithoutNullStreams, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, ms)
    child.once('exit', onExit)
  })
}
