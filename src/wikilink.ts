// Client-side parsers for the engine's wikilink / type-name string grammar.
//
// The engine (au-engine `crates/au-references/src/lib.rs`) owns this grammar and
// already surfaces its breakdown over the wire as `body_events.wikilink.parsed`
// (`WireWikilinkParts`). But a consumer that holds a served string NOT produced
// by a body scan — a `type:` claim, a type-def parent, a `use:` target, a folded
// `foo::repo*` field shape — has no wire breakdown to lean on. WIRE.md (schema 7)
// requires such consumers to "accept the `name::repo` form", yet the SDK shipped
// no helper, so every TS consumer reimplemented the split with subtly
// different edge cases. This module is the canonical helper.
//
// It mirrors `parse_wikilink` / `parse_wikilink_inner` / `looks_like_wikilink`,
// so a locally-parsed link and an engine-emitted `parsed` are the same shape:
// `parseWikilink` returns a `WireWikilinkParts`. Keep it in lockstep with the
// engine — the ported test corpus in `tests/wikilink.test.ts` is the drift guard.
//
// `wikilinkCaretContext` has no engine counterpart: the engine only ever sees
// finished links, while an editor completing one asks a positional question of
// the same grammar. It stays here rather than in each consumer for the reason
// the module exists, and settles validity by delegating to the parser, so the
// two can never disagree about what resolves.
//
// Renderer-safe (`./wikilink`): pure functions, no node imports, DOM-free.

import type { WireWikilinkParts } from './reads.ts'

/**
 * Why a wikilink string failed to parse, mirroring au-references
 * `WikilinkParseError`. Each maps to a `wikilink-*` diagnostic code the engine
 * raises at the use site, so a consumer surfacing its own feedback can switch on
 * it. Kebab-case, like the wire's diagnostic codes.
 */
export type WikilinkParseError =
  | 'not-a-wikilink' // missing `[[` prefix or `]]` suffix
  | 'empty-inner' // `[[]]` / `[[   ]]` — no content between the brackets
  | 'empty-target' // target empty without a locating fragment (`[[:field]]`, `[[::repo]]`)
  | 'empty-anchor' // `[[note#]]`
  | 'empty-block-id' // `[[note^]]`
  | 'empty-field' // `[[note:]]`
  | 'reversed-delimiters' // `^` before `#`; canonical order is `#anchor` then `^block`
  | 'field-out-of-order' // `:field` before `#anchor` / `^block_id`
  | 'invalid-field-name' // `:field` value breaks the identifier grammar
  | 'empty-repo' // `[[note::]]` — `::repo` qualifier with no repo value
  | 'empty-commit' // `[[note::@]]` / `[[note::base@]]` — `@commit` pin with no value
  | 'repo-out-of-order' // `::repo` after a fragment, or more than one `::repo`
  | 'invalid-repo-name' // `::repo` value breaks the identifier grammar

/**
 * The outcome of `parseWikilink` / `parseWikilinkInner`: the parsed breakdown on
 * success (the same `WireWikilinkParts` the engine emits for a body wikilink),
 * or a typed parse error. A discriminated union on `ok` rather than a throw, so
 * a consumer highlighting many links handles the malformed ones inline.
 */
export type ParsedWikilink = { ok: true; parts: WireWikilinkParts } | { ok: false; error: WikilinkParseError }

// The fragment delimiters in canonical order: `#` anchor, `^` block-id, `:` field.
const FRAGMENT_DELIMS = ['#', '^', ':'] as const

/**
 * The identifier grammar shared by `::repo` and `:field` values — the type-name
 * regex (au-references `is_valid_field_name`): dot-separated segments, each a
 * letter followed by letters / digits / `_` / `-`.
 */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*$/

function isValidIdentifier(s: string): boolean {
  return IDENTIFIER.test(s)
}

/** Earliest index of any char in `chars` within `s` at/after `from`, or -1. */
function indexOfAny(s: string, chars: readonly string[], from = 0): number {
  let best = -1
  for (const c of chars) {
    const i = s.indexOf(c, from)
    if (i !== -1 && (best === -1 || i < best)) best = i
  }
  return best
}

/**
 * Cheap `[[ … ]]` shape sniff, mirroring au-references `looks_like_wikilink`:
 * true for any trimmed string that starts `[[`, ends `]]`, and has content
 * between them. Routes wikilink-shaped input to `parseWikilink` even when it is
 * malformed, so a consumer gets a precise parse error over a generic mismatch.
 */
export function looksLikeWikilink(s: string): boolean {
  const t = s.trim()
  return t.length > 4 && t.startsWith('[[') && t.endsWith(']]')
}

/**
 * Parse a full `[[ … ]]` wikilink string in canonical order
 * `target[::repo][@commit][#anchor][^block_id][:field]`. Trims, strips the
 * brackets, then delegates to `parseWikilinkInner`. A string that is not
 * bracket-wrapped is `not-a-wikilink`.
 */
export function parseWikilink(s: string): ParsedWikilink {
  const t = s.trim()
  if (t.length < 4 || !t.startsWith('[[') || !t.endsWith(']]')) {
    return { ok: false, error: 'not-a-wikilink' }
  }
  return parseWikilinkInner(t.slice(2, -2))
}

/**
 * Parse a wikilink's inner form — the bytes BETWEEN `[[` and `]]`. The body
 * scanner's `body_events.wikilink.raw` already carries the inner form, so this
 * is the entry point to re-parse it without re-wrapping. Same grammar as
 * `parseWikilink`.
 */
export function parseWikilinkInner(rawInner: string): ParsedWikilink {
  const inner = rawInner.trim()
  if (inner.length === 0) return { ok: false, error: 'empty-inner' }

  let namePart: string
  let repo: string | null
  let commit: string | null
  let frag: string

  // Split off the `::repo@commit` resolution-scope qualifiers first. `::` is
  // unambiguous: repo and field names are letter-first, so a `:` never abuts
  // another in a valid link. `@` binds to `::`, so it is a commit delimiter
  // only in the repo-scope position; a bare `@` with no preceding `::` is a
  // literal filename character (the no-`::` branch below).
  const r = inner.indexOf('::')
  if (r !== -1) {
    // Anything before `::` other than the name means the qualifier is out of
    // order (a fragment, or a stray `:`, precedes it).
    if (indexOfAny(inner.slice(0, r), FRAGMENT_DELIMS) !== -1) {
      return { ok: false, error: 'repo-out-of-order' }
    }
    const after = inner.slice(r + 2)
    // At most one `::repo`.
    if (after.indexOf('::') !== -1) {
      return { ok: false, error: 'repo-out-of-order' }
    }
    // The repo value runs to the first fragment delimiter, the `@commit` pin,
    // or end. The first `@` after the repo scope is the commit delimiter.
    let repoEnd = indexOfAny(after, ['#', '^', ':', '@'])
    if (repoEnd === -1) repoEnd = after.length
    const repoVal = after.slice(0, repoEnd).trim()
    // A commit pin, `::repo@commit` or the this-repo `::@commit`. The commit-ish
    // runs to the next fragment delimiter, verbatim; validity is resolution-time.
    let rest: string
    if (after.charAt(repoEnd) === '@') {
      const afterAt = after.slice(repoEnd + 1)
      let commitEnd = indexOfAny(afterAt, FRAGMENT_DELIMS)
      if (commitEnd === -1) commitEnd = afterAt.length
      const commitVal = afterAt.slice(0, commitEnd).trim()
      if (commitVal.length === 0) return { ok: false, error: 'empty-commit' }
      commit = commitVal
      rest = afterAt.slice(commitEnd)
    } else {
      commit = null
      rest = after.slice(repoEnd)
    }
    // Empty repo is the this-repo pin only when a commit follows (`::@commit`);
    // a bare `::` or `::#frag` is a missing repo.
    if (repoVal.length === 0) {
      if (commit === null) return { ok: false, error: 'empty-repo' }
      repo = null
    } else if (!isValidIdentifier(repoVal)) {
      return { ok: false, error: 'invalid-repo-name' }
    } else {
      repo = repoVal
    }
    namePart = inner.slice(0, r)
    frag = rest
  } else {
    let nameEnd = indexOfAny(inner, FRAGMENT_DELIMS)
    if (nameEnd === -1) nameEnd = inner.length
    namePart = inner.slice(0, nameEnd)
    repo = null
    commit = null
    frag = inner.slice(nameEnd)
  }

  // Locate the fragment delimiters. Canonical order: `#` anchor, `^` block_id,
  // `:` field. Reverse-pair and field-misplacement violations are rejected.
  const hashIdx = frag.indexOf('#')
  const caretIdx = frag.indexOf('^')
  if (hashIdx !== -1 && caretIdx !== -1 && caretIdx < hashIdx) {
    return { ok: false, error: 'reversed-delimiters' }
  }

  // The field `:` is the contribution delimiter, distinct from a literal `:` in
  // heading text. A `:field` never follows a bare `#head` (a heading is
  // navigational, not addressable), so:
  // - with a `^block-id`, the field `:` is the first `:` after the caret.
  // - with a `#head` and no block, there is no field; every `:` is heading text.
  // - with neither, the first `:` is the field.
  let fieldIdx: number
  if (caretIdx !== -1) {
    const rel = frag.slice(caretIdx + 1).indexOf(':')
    fieldIdx = rel === -1 ? -1 : caretIdx + 1 + rel
  } else if (hashIdx !== -1) {
    fieldIdx = -1
  } else {
    fieldIdx = frag.indexOf(':')
  }

  // A `:` that is neither the field delimiter nor heading text is a field
  // placed before its locators, out of order.
  const firstColon = frag.indexOf(':')
  if (firstColon !== -1) {
    const anchorEnd = caretIdx === -1 ? frag.length : caretIdx
    const isHeadingText = hashIdx !== -1 && firstColon > hashIdx && firstColon < anchorEnd
    if (!isHeadingText && firstColon !== fieldIdx) {
      return { ok: false, error: 'field-out-of-order' }
    }
  }

  const target = namePart.trim()
  // A locating fragment (`#head` / `^block-id`) grants the empty name (the local
  // forms `[[#head]]` / `[[^id]]`). `[[:field]]` needs a target; `[[::repo]]`
  // (repo-root) rejects here too. An empty name PLUS a commit is the
  // commit-referent form (`[[::@sha]]` / `[[::repo@sha]]`, **schema 22**): it
  // names a commit, not a file, and is valid — but a commit has no addressable
  // interior, so a locating / field fragment on one is rejected, not dropped.
  // Mirrors au-references `parse_wikilink_inner`.
  if (target.length === 0) {
    const locating = caretIdx !== -1 || hashIdx !== -1
    const anyFragment = locating || fieldIdx !== -1
    if (commit !== null) {
      if (anyFragment) return { ok: false, error: 'empty-target' }
    } else if (repo !== null || !locating) {
      return { ok: false, error: 'empty-target' }
    }
  }

  let anchor: string | null = null
  if (hashIdx !== -1) {
    // The heading runs to the block delimiter or the end, never to a `:`, so a
    // colon in heading text stays part of the anchor.
    const anchorEnd = caretIdx === -1 ? frag.length : caretIdx
    const a = frag.slice(hashIdx + 1, anchorEnd).trim()
    if (a.length === 0) return { ok: false, error: 'empty-anchor' }
    anchor = a
  }

  // A doubled caret `^^id` is the block-referent mode (the block's typed value
  // fills the slot); a bare `^id` is navigational (the file is the referent,
  // `^id` a jump anchor). The mode is the sigil's, decided locally, never the
  // target's typed-ness. Mirrors au-references `parse_wikilink_inner`.
  let blockId: WireWikilinkParts['block_id'] = null
  if (caretIdx !== -1) {
    const referent = frag.charAt(caretIdx + 1) === '^'
    const idStart = caretIdx + (referent ? 2 : 1)
    const blockEnd = fieldIdx === -1 ? frag.length : fieldIdx
    const b = frag.slice(idStart, blockEnd).trim()
    if (b.length === 0) return { ok: false, error: 'empty-block-id' }
    blockId = { id: b, referent }
  }

  let field: string | null = null
  if (fieldIdx !== -1) {
    const value = frag.slice(fieldIdx + 1).trim()
    if (value.length === 0) return { ok: false, error: 'empty-field' }
    if (!isValidIdentifier(value)) return { ok: false, error: 'invalid-field-name' }
    field = value
  }

  return { ok: true, parts: { target, repo, commit, anchor, block_id: blockId, field } }
}

/**
 * The fragment of the wikilink grammar the caret sits in, in canonical order:
 * `target ::repo @commit #anchor ^block_id :field`.
 */
export type WikilinkSlot = 'target' | 'repo' | 'commit' | 'anchor' | 'block' | 'field'

/**
 * Where a caret sits inside an UNTERMINATED wikilink: which fragment is being
 * typed, what has been typed into it, and the parts already completed before it.
 */
export interface WikilinkCaretContext {
  /** The fragment being typed. */
  slot: WikilinkSlot
  /**
   * The parts of the COMPLETED prefix — everything before the active slot's
   * delimiter. The active slot itself is null (`''` for `target`), because an
   * unfinished value is not a part yet: with `slot: 'target'` the name lives in
   * `query`, and `parts.target` is `''`. An empty `target` on any other slot is
   * the local form (`[[#head`, `[[^id`), which the grammar grants.
   */
  parts: WireWikilinkParts
  /**
   * The doubled `^^` block-referent sigil, for the block-id BEING typed. Only
   * ever true with `slot: 'block'` — a block-id already completed carries its
   * own mode in `parts.block_id.referent`.
   */
  referent: boolean
  /**
   * The active slot's text so far, delimiter and sigil excluded. Verbatim, never
   * trimmed: trailing space is text the user typed, not padding.
   */
  query: string
}

/** The active slot's typed value while probing, valid in every slot. */
const CARET_PROBE = 'x'

/** The active slot and where its typed text starts, or null when malformed. */
interface ActiveSlot {
  slot: WikilinkSlot
  /** Index into the inner text where the slot's text starts, past delimiter and sigil. */
  queryStart: number
  referent: boolean
}

/**
 * Which delimiter the caret trails, mirroring `parseWikilinkInner`'s own split:
 * the `::repo@commit` scope qualifiers first, then the fragments. The caret is
 * at the end, so the LAST delimiter to open is the one being typed.
 */
function activeSlot(inner: string): ActiveSlot | null {
  const r = inner.indexOf('::')
  if (r !== -1) {
    // At most one `::repo`. The only rule the probe below cannot catch: a second
    // `::` reads as a valid `:field` once the caret's own text is replaced.
    const after = inner.slice(r + 2)
    if (after.indexOf('::') !== -1) return null
    // The repo value runs to the first fragment delimiter, the `@commit` pin, or
    // the caret. `@` binds to `::`, so it is a delimiter only here.
    const repoEnd = indexOfAny(after, ['#', '^', ':', '@'])
    if (repoEnd === -1) return { slot: 'repo', queryStart: r + 2, referent: false }
    if (after.charAt(repoEnd) === '@') {
      const atIdx = r + 2 + repoEnd
      const commitEnd = indexOfAny(after.slice(repoEnd + 1), FRAGMENT_DELIMS)
      if (commitEnd === -1) return { slot: 'commit', queryStart: atIdx + 1, referent: false }
      return fragmentSlot(inner, atIdx + 1 + commitEnd)
    }
    return fragmentSlot(inner, r + 2 + repoEnd)
  }
  const nameEnd = indexOfAny(inner, FRAGMENT_DELIMS)
  if (nameEnd === -1) return { slot: 'target', queryStart: 0, referent: false }
  return fragmentSlot(inner, nameEnd)
}

/** Which of `#anchor` / `^block_id` / `:field` is open, from the first fragment delimiter on. */
function fragmentSlot(inner: string, fragStart: number): ActiveSlot | null {
  const frag = inner.slice(fragStart)
  const hashIdx = frag.indexOf('#')
  const caretIdx = frag.indexOf('^')

  // The field `:`, by the same precedence `parseWikilinkInner` applies: after a
  // `^block-id` it is the first `:` past the caret, after a bare `#head` there
  // is no field at all (every `:` is heading text), otherwise the first `:`.
  let fieldIdx: number
  if (caretIdx !== -1) {
    const rel = frag.slice(caretIdx + 1).indexOf(':')
    fieldIdx = rel === -1 ? -1 : caretIdx + 1 + rel
  } else if (hashIdx !== -1) {
    fieldIdx = -1
  } else {
    fieldIdx = frag.indexOf(':')
  }

  // The last delimiter to open is the one the caret trails. Out-of-order ones
  // are not disambiguated here — the probe in `wikilinkCaretContext` rejects
  // them, since the reassembled link is what the engine would reject.
  const start = Math.max(hashIdx, caretIdx, fieldIdx)
  if (start === -1) return null
  if (start === fieldIdx) return { slot: 'field', queryStart: fragStart + start + 1, referent: false }
  if (start === caretIdx) {
    const referent = frag.charAt(caretIdx + 1) === '^'
    return { slot: 'block', queryStart: fragStart + start + (referent ? 2 : 1), referent }
  }
  return { slot: 'anchor', queryStart: fragStart + start + 1, referent: false }
}

/**
 * The caret's position in the wikilink grammar, for completion over a link still
 * being typed. `innerBeforeCaret` is the INNER form (no `[[`, unterminated) up to
 * the caret — a consumer finds its own opening bracket and decides where a link
 * ends, so no bracket scanning happens here.
 *
 * `parseWikilink` asks whether a COMPLETE link is valid; this asks a positional
 * question of the same grammar. The interesting mid-typing states are precisely
 * the parser's error cases: `note#` is `empty-anchor`, yet a perfectly good
 * "caret in the anchor slot, empty query".
 *
 * Null when no slot is meaningful — a malformed link (reversed `^`/`#`, a second
 * `::repo`, a `:field` before its locators, an invalid repo name already typed).
 * Completing one would offer candidates for a link the engine then rejects.
 *
 * It carries no validity rules of its own, so it cannot disagree with the parser:
 * only the delimiter scan above is local, and validity is settled by reassembling
 * the link with the unfinished slot filled by a probe value and handing THAT to
 * `parseWikilinkInner`. So `note::@ab` is a valid this-repo commit pin (its bare
 * prefix `note::` is not), and `note:f#head` is out of order (its bare prefix
 * `note:f` parses fine).
 */
export function wikilinkCaretContext(innerBeforeCaret: string): WikilinkCaretContext | null {
  const at = activeSlot(innerBeforeCaret)
  if (at === null) return null

  const probe = parseWikilinkInner(innerBeforeCaret.slice(0, at.queryStart) + CARET_PROBE)
  if (!probe.ok) return null

  // The probe stands in for text the user has not finished typing, so it is
  // dropped from the answer: the completed prefix is what a consumer scopes by.
  const parts = { ...probe.parts }
  if (at.slot === 'target') parts.target = ''
  else if (at.slot === 'repo') parts.repo = null
  else if (at.slot === 'commit') parts.commit = null
  else if (at.slot === 'anchor') parts.anchor = null
  else if (at.slot === 'block') parts.block_id = null
  else parts.field = null

  return { slot: at.slot, parts, referent: at.referent, query: innerBeforeCaret.slice(at.queryStart) }
}

/**
 * Split a served type-name string into its base name and optional `::repo`
 * owner — the reduced form of the wikilink grammar for strings that carry only
 * the `::repo` qualifier, never a `@commit` / `#anchor` / `^block` / `:field`
 * fragment. These are the served type-name strings WIRE.md (schema 7) requires
 * consumers to accept: a `type:` claim, a type-def parent, a `use:` target, a
 * meta `type:`. For a folded field shape (`foo::repo*`, `foo::repo*[]`) strip
 * the shape decorators first — that is the shape parser's job, not this one.
 * These carry only `::repo`, so schema 7's `^^` block-referent grammar is not in
 * play here — that rides `parseWikilink`.
 *
 * Mirrors the engine's `split_once("::")` (au-engine `wire.rs`
 * `introspect_instances_of`): the base is everything before the first `::`, the
 * repo everything after. A name never contains `:`, so `::` is unambiguous. Bare
 * input, or a trailing `::` with no repo, yields `repo` absent. Total: never
 * throws. For the full wikilink-target grammar use `parseWikilink`.
 */
export function parseTypeName(s: string): { name: string; repo?: string } {
  const idx = s.indexOf('::')
  if (idx === -1) return { name: s }
  const repo = s.slice(idx + 2)
  return repo.length === 0 ? { name: s.slice(0, idx) } : { name: s.slice(0, idx), repo }
}
