// DaemonClient.register against a bare Unix socket. A stand-in server reads the
// id the client assigns and replies with each shape a register can answer — a
// `registered` frame (success) and an `error` (a reject the connection
// survives) — proving the client sends the `mutate: register` request and routes
// each reply by id into the two-arm `TypedRegister`. Register is a CONFIG-sort
// mutation with no Deriving arm; its success is a distinct `registered` frame.

import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DaemonClient, socketPath } from '../src/client.ts'
import { encodeFrame, FrameDecoder } from '../src/frame.ts'

describe('DaemonClient.register', () => {
  let entryRoot: string
  let origHome: string | undefined
  let homeDir: string
  let server: net.Server

  beforeEach(async () => {
    entryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'au-sdk-register-'))
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

  /** Connect, capture the first request frame the client sends. */
  async function connectAndCapture(): Promise<{
    client: DaemonClient
    sock: net.Socket
    request: Promise<Record<string, unknown>>
  }> {
    const serverSide = new Promise<net.Socket>((r) => server.once('connection', r))
    const client = await DaemonClient.connect(entryRoot)
    const sock = await serverSide
    const decoder = new FrameDecoder()
    const request = new Promise<Record<string, unknown>>((resolve) => {
      sock.on('data', (chunk: Buffer) => {
        for (const req of decoder.push(chunk)) resolve(req as Record<string, unknown>)
      })
    })
    return { client, sock, request }
  }

  it('sends a `mutate: register` request carrying name/path/remote and an id', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.register('base', '/abs/path/base', 'git@example:base.git')
    const req = await request
    expect(req['mutate']).toBe('register')
    expect(req['name']).toBe('base')
    expect(req['path']).toBe('/abs/path/base')
    expect(req['remote']).toBe('git@example:base.git')
    expect(typeof req['id']).toBe('number')
    sock.write(
      encodeFrame({ type: 'registered', schema_version: 29, name: 'base', path: '/abs/path/base', version: 3, id: req['id'] }),
    )
    await p
    client.close()
  })

  it('omits `remote` from the request when not supplied (bare re-register preserves it)', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.register('base', '/abs/path/base')
    const req = await request
    expect(req['mutate']).toBe('register')
    expect('remote' in req).toBe(false)
    sock.write(
      encodeFrame({ type: 'registered', schema_version: 29, name: 'base', path: '/abs/path/base', version: 1, id: req['id'] }),
    )
    await p
    client.close()
  })

  it('resolves { ok: true, result } on a registered frame', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.register('base', '/abs/path/base')
    const req = await request
    sock.write(
      encodeFrame({ type: 'registered', schema_version: 29, name: 'base', path: '/abs/path/base', version: 7, id: req['id'] }),
    )
    const out = await p
    expect(out).toEqual({ ok: true, result: { type: 'registered', schema_version: 29, name: 'base', path: '/abs/path/base', version: 7, id: req['id'] } })
    client.close()
  })

  it('resolves { ok: false } on a register reject frame, connection surviving', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.register('base', '/abs/path/other')
    const req = await request
    // The name's identity disagrees with the path's repo.yaml.
    sock.write(
      encodeFrame({ type: 'error', schema_version: 29, error: 'dependency-identity-conflict', id: req['id'] }),
    )
    expect(await p).toEqual({ ok: false, error: 'dependency-identity-conflict' })

    // The connection survives the in-band reject: a follow-up read still settles.
    const readP = client.read({ read: 'ready' })
    const next = await new Promise<Record<string, unknown>>((resolve) => {
      const decoder = new FrameDecoder()
      sock.on('data', (chunk: Buffer) => {
        for (const f of decoder.push(chunk)) resolve(f as Record<string, unknown>)
      })
    })
    sock.write(encodeFrame({ type: 'response', schema_version: 29, ready: true, version: 1, result: {}, id: next['id'] }))
    expect((await readP).ready).toBe(true)
    client.close()
  })

  it('rejects a pending register when the connection dies (transport failure)', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.register('base', '/abs/path/base')
    await request
    sock.destroy()
    await expect(p).rejects.toThrow()
    client.close()
  })
})
