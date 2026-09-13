// DaemonClient close notification against a real Unix socket — no daemon
// needed, a bare net server stands in for the connection lifecycle.

import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DaemonClient, socketPath } from '../src/client.ts'

describe('DaemonClient.onClose', () => {
  let entryRoot: string
  let origHome: string | undefined
  let homeDir: string
  let server: net.Server
  let connections: net.Socket[]

  beforeEach(async () => {
    entryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'au-sdk-client-'))
    origHome = process.env.HOME
    // A SHORT HOME: the derived socket lives at HOME/.arsumbris/au-engine/run/<hash>.sock,
    // and a deep mkdtemp HOME would overrun the Unix sun_path limit.
    homeDir = fs.mkdtempSync('/tmp/au-sdk-home-')
    process.env.HOME = homeDir
    fs.mkdirSync(path.join(homeDir, '.arsumbris', 'au-engine', 'run'), { recursive: true })
    server = net.createServer()
    // Track and drain server-side sockets: with no reader, inbound request
    // bytes sit unread and the socket lingers, stranding server.close().
    connections = []
    server.on('connection', (sock) => {
      connections.push(sock)
      sock.on('data', () => {})
      sock.on('error', () => {})
    })
    await new Promise<void>((resolve) => server.listen(socketPath(entryRoot), resolve))
  })

  afterEach(async () => {
    for (const sock of connections) sock.destroy()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(entryRoot, { recursive: true, force: true })
    process.env.HOME = origHome
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  it('notifies once with an Error when the server drops the connection', async () => {
    const serverSide = new Promise<net.Socket>((resolve) => server.once('connection', resolve))
    const client = await DaemonClient.connect(entryRoot)
    const closes: Array<Error | undefined> = []
    client.onClose((err) => closes.push(err))

    ;(await serverSide).destroy()
    await new Promise((r) => setTimeout(r, 50))

    expect(closes).toHaveLength(1)
    expect(closes[0]).toBeInstanceOf(Error)
    expect(closes[0]?.message).toBe('daemon connection closed')
    expect(client.isClosed).toBe(true)
  })

  it('notifies on a local close() with no error (deliberate end)', async () => {
    const client = await DaemonClient.connect(entryRoot)
    const closes: Array<Error | undefined> = []
    client.onClose((err) => closes.push(err))

    client.close()
    await new Promise((r) => setTimeout(r, 50))

    expect(closes).toHaveLength(1)
    expect(closes[0]).toBeUndefined() // a deliberate close carries no fault
    expect(client.isClosed).toBe(true)
  })

  it('still rejects a pending read on a deliberate close(), with a concrete reason', async () => {
    // The bare server accepts but never replies, so the read stays pending.
    const client = await DaemonClient.connect(entryRoot)
    const readP = client.read({ read: 'ready' })
    client.close()

    await expect(readP).rejects.toThrow('client closed')
    expect(client.isClosed).toBe(true)
  })

  // A circular request makes encodeFrame's JSON.stringify throw inside send(),
  // a deterministic stand-in for any synchronous write failure.
  it('rejects the read promise on a synchronous send failure', async () => {
    const client = await DaemonClient.connect(entryRoot)
    const circular = { read: 'ready' } as Record<string, unknown>
    circular['self'] = circular

    await expect(client.read(circular as never)).rejects.toThrow()
    expect(client.isClosed).toBe(false)
    client.close()
  })

  it('routes a synchronous send failure to the subscription onClose', async () => {
    const client = await DaemonClient.connect(entryRoot)
    const circular = { subscribe: 'ready' } as Record<string, unknown>
    circular['self'] = circular
    const closes: string[] = []

    client.subscribe(circular as never, { onClose: (err) => closes.push(err) })
    await new Promise((r) => setTimeout(r, 10))

    expect(closes).toHaveLength(1)
    expect(client.isClosed).toBe(false)
    client.close()
  })
})
