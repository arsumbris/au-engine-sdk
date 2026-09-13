// DaemonClient correlation-id dispatch against a bare Unix socket. A stand-in
// server reads the ids the client assigns and replies out of order / to a
// specific id, proving the client settles by id, not by arrival order.

import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DaemonClient, socketPath } from '../src/client.ts'
import { encodeFrame, FrameDecoder } from '../src/frame.ts'
import { WIRE_SCHEMA_VERSION, WireSchemaMismatchError } from '../src/wire.ts'

describe('DaemonClient correlation-id dispatch', () => {
  let entryRoot: string
  let origHome: string | undefined
  let homeDir: string
  let server: net.Server

  beforeEach(async () => {
    entryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'au-sdk-corr-'))
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

  /** Connect a client and capture the request frames it sends, resolving once `count` arrive. */
  async function connectAndCapture(count: number): Promise<{
    client: DaemonClient
    sock: net.Socket
    requests: Promise<Array<Record<string, unknown>>>
  }> {
    const serverSide = new Promise<net.Socket>((r) => server.once('connection', r))
    const client = await DaemonClient.connect(entryRoot)
    const sock = await serverSide
    const decoder = new FrameDecoder()
    const seen: Array<Record<string, unknown>> = []
    const requests = new Promise<Array<Record<string, unknown>>>((resolve) => {
      sock.on('data', (chunk: Buffer) => {
        for (const req of decoder.push(chunk)) seen.push(req as Record<string, unknown>)
        if (seen.length >= count) resolve(seen)
      })
    })
    return { client, sock, requests }
  }

  it('settles reads by correlation id, regardless of reply order', async () => {
    const { client, sock, requests } = await connectAndCapture(2)
    const a = client.read({ read: 'types' })
    const b = client.read({ read: 'children', dir: '/v' })
    const [reqA, reqB] = await requests
    expect(typeof reqA['id']).toBe('number')
    expect(reqA['id']).not.toBe(reqB['id'])

    // Reply in REVERSE order, each carrying its request's id.
    sock.write(encodeFrame({ type: 'response', schema_version: 29, ready: true, version: 2, result: 'B', id: reqB['id'] }))
    sock.write(encodeFrame({ type: 'response', schema_version: 29, ready: true, version: 1, result: 'A', id: reqA['id'] }))

    expect((await a).result).toBe('A')
    expect((await b).result).toBe('B')
    client.close()
  })

  it('routes a subscribe error to that subscribe, leaving a pending read intact', async () => {
    const { client, sock, requests } = await connectAndCapture(2)
    const readP = client.read({ read: 'types' })
    let closeError: string | undefined
    let closeReason: string | undefined
    client.subscribe(
      { subscribe: 'no-such-channel' },
      { onClose: (error, reason) => ((closeError = error), (closeReason = reason)) },
    )
    const reqs = await requests
    const readReq = reqs.find((r) => 'read' in r)!
    const subReq = reqs.find((r) => 'subscribe' in r)!

    // An error for the SUBSCRIBE id, then the response for the read. Under the
    // old FIFO guess the subscribe error would have rejected the read.
    sock.write(encodeFrame({ type: 'error', schema_version: 29, error: 'unknown channel', for: 'subscribe', id: subReq['id'] }))
    sock.write(encodeFrame({ type: 'response', schema_version: 29, ready: true, version: 1, result: 'ok', id: readReq['id'] }))

    expect((await readP).result).toBe('ok')
    await new Promise((r) => setTimeout(r, 20))
    expect(closeError).toBe('unknown channel')
    expect(closeReason).toBe('rejected') // a refusal is permanent
    client.close()
  })

  it('fails the connection on a schema_version mismatch, before misrouting the reply', async () => {
    const { client, sock, requests } = await connectAndCapture(1)
    const readP = client.read({ read: 'types' })
    await requests

    let closeErr: Error | undefined
    client.onClose((err) => (closeErr = err))

    // A stale (v3) daemon replies with no `id`. Under the old id-less `take`
    // fallback this would settle into the oldest pending read with the wrong
    // payload. The schema guard must fire first: reject the read, close.
    sock.write(encodeFrame({ type: 'response', schema_version: 3, ready: true, version: 1, result: 'stale' } as never))

    const err = await readP.then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(WireSchemaMismatchError)
    expect((err as WireSchemaMismatchError).actual).toBe(3)
    expect((err as WireSchemaMismatchError).expected).toBe(WIRE_SCHEMA_VERSION)
    expect(client.isClosed).toBe(true)
    // The unbidden death surfaces the same mismatch error to onClose.
    expect(closeErr).toBeInstanceOf(WireSchemaMismatchError)
  })

  it('does not fail on a schema-less frame: nothing to compare, settle as usual', async () => {
    const { client, sock, requests } = await connectAndCapture(1)
    const readP = client.read({ read: 'types' })
    const [readReq] = await requests

    // No `schema_version` to compare against — must not trip the guard. The
    // reply still settles its read by id and the connection stays usable.
    sock.write(encodeFrame({ type: 'response', ready: true, version: 1, result: 'ok', id: readReq['id'] } as never))

    expect((await readP).result).toBe('ok')
    expect(client.isClosed).toBe(false)
    client.close()
  })

  it('survives a non-object frame (null, bare primitive) and keeps decoding', async () => {
    const { client, sock, requests } = await connectAndCapture(1)
    const readP = client.read({ read: 'types' })
    const [readReq] = await requests

    // A JSON-valid but non-frame body: `null` would throw on `.type`, a bare
    // number has no `.type`. Both must be dropped, the stream stays usable.
    sock.write(encodeFrame(null as never))
    sock.write(encodeFrame(42 as never))
    // A real reply for the read still settles afterwards.
    sock.write(encodeFrame({ type: 'response', schema_version: 29, ready: true, version: 1, result: 'ok', id: readReq['id'] }))

    expect((await readP).result).toBe('ok')
    expect(client.isClosed).toBe(false)
    client.close()
  })
})
