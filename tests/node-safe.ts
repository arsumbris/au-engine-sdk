// Node-safe boundary guard. This file imports only the node-reachable
// surface and is typechecked under a DOM-less `lib` (tsconfig.node-safe.json).
// A DOM type (e.g. HTMLElement) leaking into any of these modules fails the
// build right here — the dual of the renderer-safe rule.

import { DaemonClient, DaemonSupervisor, FrameDecoder } from '../src/index.ts'
import { withReadCache, manageConnection } from '../src/hardening.ts'
import { subscribeLifecycle, toTypedSubscriber } from '../src/subscribe-helpers.ts'
import { parseTypeName, parseWikilink, wikilinkCaretContext } from '../src/wikilink.ts'
import { contentHash } from '../src/content-hash.ts'
import type { TypedRead } from '../src/reads.ts'
import type { EngineReadResult, SubscriptionEvent } from '../src/wire.ts'
import type { ParsedWikilink, WikilinkCaretContext } from '../src/wikilink.ts'

// Reference each import so noUnusedLocals stays satisfied without a DOM lib.
export const _nodeSafeSurface = [
  DaemonClient,
  DaemonSupervisor,
  FrameDecoder,
  withReadCache,
  manageConnection,
  subscribeLifecycle,
  toTypedSubscriber,
  parseTypeName,
  parseWikilink,
  wikilinkCaretContext,
  contentHash,
] as const

export type _NodeSafeTypes =
  | TypedRead<unknown>
  | EngineReadResult
  | SubscriptionEvent
  | ParsedWikilink
  | WikilinkCaretContext
