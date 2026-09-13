// DaemonClient.resolve against a bare Unix socket. A stand-in server reads the
// id the client assigns and replies with each of the three reply shapes a
// resolve can answer — `resolved` (success), a not-ready `response`, and an
// `error` (a manifest-less tree-mode workspace) — proving the client routes each
// by id into the typed outcome. The package-manager verb.

import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DaemonClient, socketPath } from '../src/client.ts'
import { encodeFrame, FrameDecoder } from '../src/frame.ts'

describe('DaemonClient.resolve', () => {
  let entryRoot: string
  let origHome: string | undefined
  let homeDir: string
  let server: net.Server

  beforeEach(async () => {
    entryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'au-sdk-resolve-'))
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

  it('sends the variant-less resolve verb with a correlation id', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.resolve()
    const req = await request
    expect(req['resolve']).toEqual({})
    expect(typeof req['id']).toBe('number')
    sock.write(
      encodeFrame({
        type: 'resolved',
        schema_version: 29,
        resolved: [],
        failed: [],
        conflicts: [],
        commits: {},
        commit_errors: {},
        version: 4,
        id: req['id'],
      }),
    )
    await p
    client.close()
  })

  it('resolves { ready: true, result } on a resolved frame', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.resolve()
    const req = await request
    sock.write(
      encodeFrame({
        type: 'resolved',
        schema_version: 29,
        resolved: [
          { name: 'base', sha: 'abc123', remote: 'git@example:base.git', path: null },
          { name: 'sub', sha: 'def456', remote: 'git@example:mono.git', path: 'packages/sub' },
        ],
        failed: [{ name: 'gone', reason: 'ref not found', code: 'dependency-resolution-failed' }],
        conflicts: ['pkg required at two versions'],
        commits: { base: 'lock789', sub: 'lock789' },
        commit_errors: {},
        version: 11,
        id: req['id'],
      }),
    )
    const out = await p
    expect(out).toMatchObject({ ready: true })
    if ('result' in out) {
      expect(out.result.resolved).toHaveLength(2)
      expect(out.result.resolved[0]).toEqual({
        name: 'base',
        sha: 'abc123',
        remote: 'git@example:base.git',
        path: null,
      })
      expect(out.result.resolved[1].path).toBe('packages/sub')
      expect(out.result.failed[0].code).toBe('dependency-resolution-failed')
      expect(out.result.conflicts).toEqual(['pkg required at two versions'])
      expect(out.result.commits).toEqual({ base: 'lock789', sub: 'lock789' })
      expect(out.result.commit_errors).toEqual({})
      expect(out.result.version).toBe(11)
    }
    client.close()
  })

  it('resolves { ready: false } on a not-ready response frame (ref still Deriving)', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.resolve()
    const req = await request
    // A resolve while Deriving answers a not-ready `response`, id-stamped, not a
    // `resolved` frame.
    sock.write(encodeFrame({ type: 'response', schema_version: 29, ready: false, id: req['id'] }))
    expect(await p).toEqual({ ready: false })
    client.close()
  })

  it('resolves { ok: false } on a resolve error frame (tree mode), connection surviving', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.resolve()
    const req = await request
    // A manifest-less tree-mode workspace has no declared closure to resolve.
    sock.write(
      encodeFrame({
        type: 'error',
        schema_version: 29,
        error: 'no manifest to resolve',
        for: 'resolve',
        id: req['id'],
      }),
    )
    expect(await p).toEqual({ ok: false, error: 'no manifest to resolve' })

    // The connection survives the in-band error: a follow-up read still settles.
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

  it('rejects a pending resolve when the connection dies (transport failure)', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.resolve()
    await request
    sock.destroy()
    await expect(p).rejects.toThrow()
    client.close()
  })
})
