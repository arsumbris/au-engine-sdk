// DaemonClient mutate helpers (write_file / edit_file / assign_block_id /
// edit_record / append_record / delete_file / promote / inline /
// rename_block_id / rename / rename_type) against a bare Unix socket.
// A stand-in server reads the id the client assigns and replies with each shape
// a mutate can answer — a successful `response` (the read-response envelope), a
// not-ready `response`, and an `error` (carrying `detail`) — proving the client
// maps each onto the typed `TypedMutate` outcome, and that the helpers build the
// snake_case wire args from their camelCase edge.

import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DaemonClient, socketPath } from '../src/client.ts'
import { encodeFrame, FrameDecoder } from '../src/frame.ts'

describe('DaemonClient mutate helpers', () => {
  let entryRoot: string
  let origHome: string | undefined
  let homeDir: string
  let server: net.Server

  beforeEach(async () => {
    entryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'au-sdk-mutate-'))
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

  it('writeFile sends the write_file verb with snake_case args and a correlation id', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.writeFile('content/a.md', 'hello', { expectedHash: 'abc123' })
    const req = await request
    expect(req['mutate']).toBe('write_file')
    expect(req['path']).toBe('content/a.md')
    expect(req['content']).toBe('hello')
    // camelCase edge -> snake_case wire key.
    expect(req['expected_hash']).toBe('abc123')
    expect(typeof req['id']).toBe('number')
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 5,
        result: { path: 'content/a.md', hash: 'def456', diagnostics: [], reflected: true },
        id: req['id'],
      }),
    )
    await p
    client.close()
  })

  it('writeFile omits expected_hash when no guard is given (overwrite-regardless)', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.writeFile('content/new.md', 'fresh')
    const req = await request
    expect('expected_hash' in req).toBe(false)
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 1,
        result: { path: 'content/new.md', hash: 'h', diagnostics: [], reflected: true },
        id: req['id'],
      }),
    )
    await p
    client.close()
  })

  it('resolves { ready: true, version, result } on a successful response', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.writeFile('content/a.md', 'hello')
    const req = await request
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 12,
        result: { path: 'content/a.md', hash: 'h99', diagnostics: [], reflected: false },
        id: req['id'],
      }),
    )
    const out = await p
    expect(out).toMatchObject({ ready: true, version: 12 })
    if ('result' in out) {
      expect(out.result.path).toBe('content/a.md')
      expect(out.result.hash).toBe('h99')
      expect(out.result.reflected).toBe(false)
    }
    client.close()
  })

  it('resolves { ready: false } on a not-ready response (engine still Deriving)', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.writeFile('content/a.md', 'hello')
    const req = await request
    sock.write(encodeFrame({ type: 'response', schema_version: 29, ready: false, id: req['id'] }))
    expect(await p).toEqual({ ready: false })
    client.close()
  })

  it('resolves { ok: false, detail } on a reject error frame, surfacing current_hash', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.writeFile('content/a.md', 'hello', { expectedHash: 'stale' })
    const req = await request
    // A staleness conflict: an id-stamped error frame with machine-usable detail.
    sock.write(
      encodeFrame({
        type: 'error',
        schema_version: 29,
        error: 'expected_hash mismatch',
        detail: { current_hash: 'live999' },
        id: req['id'],
      }),
    )
    expect(await p).toEqual({
      ok: false,
      error: 'expected_hash mismatch',
      detail: { current_hash: 'live999' },
    })

    // The connection survives the in-band reject: a follow-up read still settles.
    const readP = client.read({ read: 'ready' })
    const next = await new Promise<Record<string, unknown>>((resolve) => {
      const decoder = new FrameDecoder()
      sock.on('data', (chunk: Buffer) => {
        for (const f of decoder.push(chunk)) resolve(f as Record<string, unknown>)
      })
    })
    sock.write(
      encodeFrame({ type: 'response', schema_version: 29, ready: true, version: 1, result: {}, id: next['id'] }),
    )
    expect((await readP).ready).toBe(true)
    client.close()
  })

  it('editFile maps oldString/newString/replaceAll onto the snake_case wire args', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.editFile('content/a.md', 'foo', 'bar', { replaceAll: true })
    const req = await request
    expect(req['mutate']).toBe('edit_file')
    expect(req['old_string']).toBe('foo')
    expect(req['new_string']).toBe('bar')
    expect(req['replace_all']).toBe(true)
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 2,
        result: { path: 'content/a.md', hash: 'h', diagnostics: [], reflected: true },
        id: req['id'],
      }),
    )
    await p
    client.close()
  })

  it('assignBlockId sends path/at and surfaces id + ref from the result', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.assignBlockId('content/a.md', 1234)
    const req = await request
    expect(req['mutate']).toBe('assign_block_id')
    expect(req['path']).toBe('content/a.md')
    expect(req['at']).toBe(1234)
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 3,
        result: {
          path: 'content/a.md',
          hash: 'h',
          diagnostics: [],
          reflected: true,
          id: 'b-abc',
          ref: '[[a^b-abc]]',
        },
        id: req['id'],
      }),
    )
    const out = await p
    if ('result' in out) {
      expect(out.result.id).toBe('b-abc')
      expect(out.result.ref).toBe('[[a^b-abc]]')
    }
    client.close()
  })

  it('editRecord maps fieldPath/patch and both options onto the snake_case wire args', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.editRecord(
      'content/plan.md',
      ['phases', 0, 'actions', 1],
      { type: 'done', output: 'x' },
      { expectedHash: 'abc123', onInvalid: 'reject' },
    )
    const req = await request
    expect(req['mutate']).toBe('edit_record')
    expect(req['path']).toBe('content/plan.md')
    // The instances_of locator: a mixed array of field names and list indices.
    expect(req['field_path']).toEqual(['phases', 0, 'actions', 1])
    expect(req['patch']).toEqual({ type: 'done', output: 'x' })
    // camelCase edge -> snake_case wire keys.
    expect(req['expected_hash']).toBe('abc123')
    expect(req['on_invalid']).toBe('reject')
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 20,
        result: { path: 'content/plan.md', hash: 'h', diagnostics: [], reflected: true },
        id: req['id'],
      }),
    )
    await p
    client.close()
  })

  it('editRecord sends the empty field_path for the file-level instance and omits both options', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.editRecord('content/plan.md', [], { status: 'active' })
    const req = await request
    expect(req['mutate']).toBe('edit_record')
    // The empty array addresses the file-level instance.
    expect(req['field_path']).toEqual([])
    // No guard, no on_invalid: the engine applies its own default.
    expect('expected_hash' in req).toBe(false)
    expect('on_invalid' in req).toBe(false)
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 21,
        result: { path: 'content/plan.md', hash: 'h', diagnostics: [], reflected: true },
        id: req['id'],
      }),
    )
    await p
    client.close()
  })

  it('appendRecord maps fieldPath/value and options onto the snake_case wire args', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.appendRecord(
      'content/plan.md',
      ['phases', 0, 'actions'],
      { type: 'log', text: 'hi' },
      { onInvalid: 'advise' },
    )
    const req = await request
    expect(req['mutate']).toBe('append_record')
    expect(req['path']).toBe('content/plan.md')
    expect(req['field_path']).toEqual(['phases', 0, 'actions'])
    expect(req['value']).toEqual({ type: 'log', text: 'hi' })
    expect(req['on_invalid']).toBe('advise')
    // No guard supplied.
    expect('expected_hash' in req).toBe(false)
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 22,
        result: { path: 'content/plan.md', hash: 'h', diagnostics: [], reflected: true },
        id: req['id'],
      }),
    )
    await p
    client.close()
  })

  it('appendRecord forwards a scalar value verbatim and omits both options', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.appendRecord('content/plan.md', ['tags'], 'urgent')
    const req = await request
    expect(req['mutate']).toBe('append_record')
    expect(req['field_path']).toEqual(['tags'])
    // A scalar element, forwarded verbatim.
    expect(req['value']).toBe('urgent')
    expect('expected_hash' in req).toBe(false)
    expect('on_invalid' in req).toBe(false)
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 23,
        result: { path: 'content/plan.md', hash: 'h', diagnostics: [], reflected: true },
        id: req['id'],
      }),
    )
    await p
    client.close()
  })

  it('promote sends path/to and the block_id locator (camelCase blockId -> snake_case)', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.promote('content/host.md', 'content/rec.md', { blockId: 'b-x' })
    const req = await request
    expect(req['mutate']).toBe('promote')
    expect(req['path']).toBe('content/host.md')
    expect(req['to']).toBe('content/rec.md')
    expect(req['block_id']).toBe('b-x')
    // The `at` arm of the locator union is not sent.
    expect('at' in req).toBe(false)
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 7,
        result: { path: 'content/rec.md', hash: 'h', diagnostics: [], reflected: true },
        id: req['id'],
      }),
    )
    await p
    client.close()
  })

  it('promote sends the at locator when given { at } (no block_id)', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.promote('content/host.md', 'content/rec.md', { at: 99 })
    const req = await request
    expect(req['mutate']).toBe('promote')
    expect(req['at']).toBe(99)
    expect('block_id' in req).toBe(false)
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 8,
        result: { path: 'content/rec.md', hash: 'h', diagnostics: [], reflected: true },
        id: req['id'],
      }),
    )
    await p
    client.close()
  })

  it('inline sends path/into, with at only when supplied', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.inline('content/rec.md', 'content/host.md', 1500)
    const req = await request
    expect(req['mutate']).toBe('inline')
    expect(req['path']).toBe('content/rec.md')
    expect(req['into']).toBe('content/host.md')
    expect(req['at']).toBe(1500)
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 9,
        result: { path: 'content/host.md', hash: 'h', diagnostics: [], reflected: true },
        id: req['id'],
      }),
    )
    await p
    client.close()
  })

  it('inline omits at when not given (single-reference host)', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.inline('content/rec.md', 'content/host.md')
    const req = await request
    expect(req['mutate']).toBe('inline')
    expect('at' in req).toBe(false)
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 10,
        result: { path: 'content/host.md', hash: 'h', diagnostics: [], reflected: true },
        id: req['id'],
      }),
    )
    await p
    client.close()
  })

  it('renameBlockId maps blockId/toBlockId onto the snake_case wire args', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.renameBlockId('content/host.md', 'b-old', 'b-new')
    const req = await request
    expect(req['mutate']).toBe('rename_block_id')
    expect(req['path']).toBe('content/host.md')
    expect(req['block_id']).toBe('b-old')
    expect(req['to_block_id']).toBe('b-new')
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 11,
        result: { path: 'content/host.md', hash: 'h', diagnostics: [], reflected: true },
        id: req['id'],
      }),
    )
    await p
    client.close()
  })

  it('rename sends the rename verb with path/to', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.rename('content/old.md', 'content/new.md')
    const req = await request
    expect(req['mutate']).toBe('rename')
    expect(req['path']).toBe('content/old.md')
    expect(req['to']).toBe('content/new.md')
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 12,
        result: { path: 'content/new.md', hash: 'h', diagnostics: [], reflected: true },
        id: req['id'],
      }),
    )
    await p
    client.close()
  })

  it('writeFile carries the stamps rider, matchOn -> snake_case match_on', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.writeFile('content/a.md', 'hello', {
      stamps: [
        {
          field: 'provenance',
          record: { type: 'file-change.edit', session: 's1' },
          matchOn: { type: 'file-change.edit', session: 's1' },
        },
      ],
    })
    const req = await request
    expect(req['mutate']).toBe('write_file')
    // The rider mirrors the wire's stamps LIST, each element's matchOn
    // normalized to match_on; field / record pass through opaque.
    expect(req['stamps']).toEqual([
      {
        field: 'provenance',
        record: { type: 'file-change.edit', session: 's1' },
        match_on: { type: 'file-change.edit', session: 's1' },
      },
    ])
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 5,
        result: { path: 'content/a.md', hash: 'h', diagnostics: [], reflected: true },
        id: req['id'],
      }),
    )
    await p
    client.close()
  })

  it('writeFile carries a MULTI-stamp list, preserving order', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.writeFile('content/a.md', 'hello', {
      stamps: [
        { field: 'provenance', record: { type: 'file-change.edit', session: 's1' } },
        { field: 'reviewers', record: { name: 'ada' }, matchOn: { name: 'ada' } },
      ],
    })
    const req = await request
    // Different fields are independent ensures; the list order is preserved
    // verbatim, each element's matchOn normalized to match_on.
    expect(req['stamps']).toEqual([
      { field: 'provenance', record: { type: 'file-change.edit', session: 's1' } },
      { field: 'reviewers', record: { name: 'ada' }, match_on: { name: 'ada' } },
    ])
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 5,
        result: { path: 'content/a.md', hash: 'h', diagnostics: [], reflected: true },
        id: req['id'],
      }),
    )
    await p
    client.close()
  })

  it('writeFile omits match_on when a stamp has no matchOn (always-append)', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.writeFile('content/a.md', 'hello', {
      stamps: [{ field: 'provenance', record: { type: 'file-change.rename', from: 'old.md' } }],
    })
    const req = await request
    const stamp = (req['stamps'] as Array<Record<string, unknown>>)[0]
    expect('match_on' in stamp).toBe(false)
    expect(stamp['field']).toBe('provenance')
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 5,
        result: { path: 'content/a.md', hash: 'h', diagnostics: [], reflected: true },
        id: req['id'],
      }),
    )
    await p
    client.close()
  })

  it('writeFile omits stamps entirely when the list is absent or empty', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.writeFile('content/a.md', 'hello', { stamps: [] })
    const req = await request
    // An absent OR empty list is exactly no stamp — the key is omitted.
    expect('stamps' in req).toBe(false)
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 5,
        result: { path: 'content/a.md', hash: 'h', diagnostics: [], reflected: true },
        id: req['id'],
      }),
    )
    await p
    client.close()
  })

  it('writeFile carries the ensure_mixins rider + strict flag (schema 25)', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.writeFile('content/a.md', 'hello', {
      ensureMixins: ['provenance::au-provenance', 'reviewed::au-host'],
      ensureMixinsStrict: false,
    })
    const req = await request
    expect(req['mutate']).toBe('write_file')
    // The mixin list passes through verbatim (already `::repo`-qualified wire
    // strings); strict is forwarded as the snake_case ensure_mixins_strict.
    expect(req['ensure_mixins']).toEqual(['provenance::au-provenance', 'reviewed::au-host'])
    expect(req['ensure_mixins_strict']).toBe(false)
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 5,
        result: {
          path: 'content/a.md',
          hash: 'h',
          diagnostics: [],
          reflected: true,
          ensure_mixins: [
            { mixin: 'provenance::au-provenance', outcome: 'applied' },
            { mixin: 'reviewed::au-host', outcome: 'skipped', reason: 'non-dependency repo' },
          ],
        },
        id: req['id'],
      }),
    )
    const out = await p
    // The per-mixin outcome report surfaces on the typed result verbatim.
    if ('result' in out) {
      expect(out.result.ensure_mixins).toEqual([
        { mixin: 'provenance::au-provenance', outcome: 'applied' },
        { mixin: 'reviewed::au-host', outcome: 'skipped', reason: 'non-dependency repo' },
      ])
    }
    client.close()
  })

  it('writeFile omits ensure_mixins_strict when the caller leaves it default', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.writeFile('content/a.md', 'hello', {
      ensureMixins: ['provenance::au-provenance'],
    })
    const req = await request
    // Strict defaults engine-side (true); the SDK omits the key so the engine
    // applies its own default rather than the SDK pinning it.
    expect(req['ensure_mixins']).toEqual(['provenance::au-provenance'])
    expect('ensure_mixins_strict' in req).toBe(false)
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 5,
        result: { path: 'content/a.md', hash: 'h', diagnostics: [], reflected: true },
        id: req['id'],
      }),
    )
    await p
    client.close()
  })

  it('writeFile omits ensure_mixins entirely when the list is absent or empty', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.writeFile('content/a.md', 'hello', { ensureMixins: [], ensureMixinsStrict: true })
    const req = await request
    // An absent OR empty list is no mixin — both keys are omitted, strict too
    // (it is meaningless without mixins).
    expect('ensure_mixins' in req).toBe(false)
    expect('ensure_mixins_strict' in req).toBe(false)
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 5,
        result: { path: 'content/a.md', hash: 'h', diagnostics: [], reflected: true },
        id: req['id'],
      }),
    )
    await p
    client.close()
  })

  it('editFile carries the ensure_mixins rider (schema 25)', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.editFile('content/a.md', 'foo', 'bar', {
      ensureMixins: ['provenance::au-provenance'],
    })
    const req = await request
    expect(req['mutate']).toBe('edit_file')
    expect(req['ensure_mixins']).toEqual(['provenance::au-provenance'])
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 5,
        result: { path: 'content/a.md', hash: 'h', diagnostics: [], reflected: true },
        id: req['id'],
      }),
    )
    await p
    client.close()
  })

  it('rename carries the ensure_mixins rider on the destination to (schema 25)', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.rename('content/old.md', 'content/new.md', {
      ensureMixins: ['provenance::au-provenance'],
      ensureMixinsStrict: true,
    })
    const req = await request
    expect(req['mutate']).toBe('rename')
    expect(req['ensure_mixins']).toEqual(['provenance::au-provenance'])
    expect(req['ensure_mixins_strict']).toBe(true)
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 12,
        result: { path: 'content/new.md', hash: 'h', diagnostics: [], reflected: true },
        id: req['id'],
      }),
    )
    await p
    client.close()
  })

  it('rename carries the stamps rider via its options object (folded onto to)', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.rename('content/old.md', 'content/new.md', {
      stamps: [
        {
          field: 'provenance',
          record: { type: 'file-change.rename', from: 'content/old.md' },
        },
      ],
    })
    const req = await request
    expect(req['mutate']).toBe('rename')
    expect(req['stamps']).toEqual([
      {
        field: 'provenance',
        record: { type: 'file-change.rename', from: 'content/old.md' },
      },
    ])
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 12,
        result: { path: 'content/new.md', hash: 'h', diagnostics: [], reflected: true },
        id: req['id'],
      }),
    )
    await p
    client.close()
  })

  it('renameType maps oldName/newName onto the snake_case wire args', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.renameType('decision', 'choice')
    const req = await request
    expect(req['mutate']).toBe('rename_type')
    expect(req['old_name']).toBe('decision')
    expect(req['new_name']).toBe('choice')
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 13,
        result: { path: 'type/choice.type.yaml', hash: 'h', diagnostics: [], reflected: true },
        id: req['id'],
      }),
    )
    await p
    client.close()
  })

  it('setIgnores sends set_ignores with root/patterns and surfaces the hash-null envelope', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.setIgnores('/v/app', ['# vendored', 'build/'])
    const req = await request
    expect(req['mutate']).toBe('set_ignores')
    expect(req['root']).toBe('/v/app')
    expect(req['patterns']).toEqual(['# vendored', 'build/'])
    // .auignore is out-of-band config: the re-scope already ran, so `version`
    // reflects the new scope, `hash` is null, `reflected` is the delete-style
    // "nothing to lag".
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 14,
        result: { path: '/v/app/.arsumbris/.auignore', hash: null, diagnostics: [], reflected: false, commit: 'c1', commits: {} },
        id: req['id'],
      }),
    )
    const out = await p
    expect(out).toMatchObject({ ready: true, version: 14 })
    if ('result' in out) {
      expect(out.result.hash).toBeNull()
      expect(out.result.reflected).toBe(false)
    }
    client.close()
  })

  it('setIgnores empty patterns removes the file (empty list forwarded verbatim)', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.setIgnores('/v/app', [])
    const req = await request
    expect(req['mutate']).toBe('set_ignores')
    expect(req['patterns']).toEqual([])
    sock.write(
      encodeFrame({
        type: 'response',
        schema_version: 29,
        ready: true,
        version: 15,
        result: { path: '/v/app/.arsumbris/.auignore', hash: null, diagnostics: [], reflected: false, commit: 'c2', commits: {} },
        id: req['id'],
      }),
    )
    await p
    client.close()
  })

  it('setIgnores resolves { ok: false } on a non-member-root reject, connection surviving', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.setIgnores('/v/not-a-member', ['x'])
    const req = await request
    sock.write(
      encodeFrame({
        type: 'error',
        schema_version: 29,
        error: "'/v/not-a-member' is not a declared member root",
        id: req['id'],
      }),
    )
    expect(await p).toEqual({ ok: false, error: "'/v/not-a-member' is not a declared member root" })

    // The connection survives the in-band reject: a follow-up read still settles.
    const readP = client.read({ read: 'ready' })
    const next = await new Promise<Record<string, unknown>>((resolve) => {
      const decoder = new FrameDecoder()
      sock.on('data', (chunk: Buffer) => {
        for (const f of decoder.push(chunk)) resolve(f as Record<string, unknown>)
      })
    })
    sock.write(
      encodeFrame({ type: 'response', schema_version: 29, ready: true, version: 1, result: {}, id: next['id'] }),
    )
    expect((await readP).ready).toBe(true)
    client.close()
  })

  it('rejects a pending mutate when the connection dies (transport failure)', async () => {
    const { client, sock, request } = await connectAndCapture()
    const p = client.writeFile('content/a.md', 'hello')
    await request
    sock.destroy()
    await expect(p).rejects.toThrow()
    client.close()
  })
})
