# @arsumbris/au-engine-sdk

The TypeScript SDK for the au-engine daemon.

What it holds:
- the daemon client over the Unix socket
  - framed JSON per the engine's `WIRE.md`, reads and subscriptions
- the wire frame types

The host/projection mount contract lives in [`@arsumbris/au-host-sdk`](https://github.com/arsumbris/au-host-sdk), extracted from this SDK's old `./mount` subpath.

Consumed as TypeScript source.
- bundlers resolve the `exports` map directly.
- plain node ≥ 23 runs it via type stripping.
- `./wire`, `./reads`, `./subscriptions`, `./hardening` are renderer-safe (no node imports) and node-safe (no DOM).
- the whole SDK is now uniformly DOM-free.

Consumers: au-host (origin).
The engine repo is the source of truth for the wire shape:
`au-engine/crates/au-engine/WIRE.md`.

Changes are tracked in [`CHANGELOG.md`](./CHANGELOG.md).
