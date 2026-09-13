// requestShutdown's success contract against a bare Unix socket stand-in.
// A transport failure (the daemon dropping the connection mid-reply) still
// counts as a shutdown that landed; a WireError (the daemon answering with an
// error frame) does not — it is reachable and refused the read.

import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { requestShutdown, socketPath } from '../src/client.ts'
import { encodeFrame, FrameDecoder } from '../src/frame.ts'

describe('requestShutdown success contract', () => {
  let entryRoot: string
  let origHome: string | undefined
  let homeDir: string
  let server: net.Server

  beforeEach(async () => {
    entryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'au-sdk-shutdown-'))
    origHome = process.env.HOME
    // A SHORT HOME: the derived socket lives at HOME/.arsumbris/au-engine/run/<hash>.sock,
    // and a deep mkdtemp HOME would overrun the Unix sun_path limit.
    homeDir = fs.mkdtempSync('/tmp/au-sdk-home-')
    process.env.HOME = homeDir
    fs.mkdirSync(path.join(homeDir, '.arsumbris', 'au-engine', 'run'), { recursive: true })
    server = net.createServer()
    await new Promise<void>((resolve) => server.listen(socketPath(entryRoot), resolve))
  })

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(entryRoot, { recursive: true, force: true })
    process.env.HOME = origHome
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  /** Reply to the first request the client sends, echoing its id, via `reply`. */
  function onRequest(reply: (sock: net.Socket, id: unknown) => void): void {
    server.on('connection', (sock) => {
      const decoder = new FrameDecoder()
      sock.on('data', (chunk: Buffer) => {
        for (const req of decoder.push(chunk)) {
          reply(sock, (req as Record<string, unknown>)['id'])
        }
      })
    })
  }

  it('returns false when the daemon answers with an error frame (WireError)', async () => {
    onRequest((sock, id) =>
      sock.write(encodeFrame({ type: 'error', schema_version: 29, error: 'unknown read', for: 'read', id })),
    )
    expect(await requestShutdown(entryRoot)).toBe(false)
  })

  it('returns true when the connection drops mid-reply (transport failure)', async () => {
    onRequest((sock) => sock.destroy())
    expect(await requestShutdown(entryRoot)).toBe(true)
  })

  it('returns true on a clean response', async () => {
    onRequest((sock, id) =>
      sock.write(encodeFrame({ type: 'response', schema_version: 29, ready: true, version: 1, id })),
    )
    expect(await requestShutdown(entryRoot)).toBe(true)
  })

  it('returns false when no daemon is reachable', async () => {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(socketPath(entryRoot), { force: true })
    expect(await requestShutdown(entryRoot)).toBe(false)
    // re-open so afterEach's close() has a server to close
    server = net.createServer()
    await new Promise<void>((resolve) => server.listen(socketPath(entryRoot), resolve))
  })
})
