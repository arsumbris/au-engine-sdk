import { describe, expect, it } from 'vitest'

import {
  looksLikeWikilink,
  parseTypeName,
  parseWikilink,
  parseWikilinkInner,
  wikilinkCaretContext,
  type ParsedWikilink,
  type WikilinkParseError,
} from '../src/wikilink.ts'

// This corpus is a 1:1 port of au-references `parse_wikilink` unit tests
// (au-engine `crates/au-references/src/lib.rs`). It is the drift guard: the SDK
// parser mirrors the engine grammar, so every engine case must hold here too.

/** The parsed parts on success; fails the test if the input did not parse. */
function parts(s: string): ParsedWikilink & { ok: true } {
  const r = parseWikilink(s)
  if (!r.ok) throw new Error(`expected ${s} to parse, got error ${r.error}`)
  return r
}

/** The error on failure; fails the test if the input parsed. */
function err(s: string): WikilinkParseError {
  const r = parseWikilink(s)
  if (r.ok) throw new Error(`expected ${s} to fail, got ${JSON.stringify(r.parts)}`)
  return r.error
}

describe('parseWikilink — target and fragments', () => {
  it('parses a bare target', () => {
    const r = parts('[[note]]')
    expect(r.parts.target).toBe('note')
    expect(r.parts.anchor).toBeNull()
    expect(r.parts.block_id).toBeNull()
  })

  it('parses a target with a path', () => {
    expect(parts('[[notes/sub/foo.md]]').parts.target).toBe('notes/sub/foo.md')
  })

  it('parses a target with an anchor', () => {
    const r = parts('[[note#section-2]]')
    expect(r.parts.target).toBe('note')
    expect(r.parts.anchor).toBe('section-2')
  })

  it('parses a target with a block id', () => {
    const r = parts('[[note^abc-123]]')
    expect(r.parts.target).toBe('note')
    // A bare `^id` is navigational, not a block-referent.
    expect(r.parts.block_id).toEqual({ id: 'abc-123', referent: false })
  })

  it('parses canonical order anchor then block id', () => {
    const r = parts('[[note#section^abc-123]]')
    expect(r.parts.target).toBe('note')
    expect(r.parts.anchor).toBe('section')
    expect(r.parts.block_id).toEqual({ id: 'abc-123', referent: false })
  })

  it('rejects reversed delimiters (^ before #)', () => {
    expect(err('[[note^block#anchor]]')).toBe('reversed-delimiters')
  })

  it('rejects an empty anchor', () => {
    expect(err('[[note#]]')).toBe('empty-anchor')
  })

  it('rejects an empty block id', () => {
    expect(err('[[note^]]')).toBe('empty-block-id')
  })

  it('trims whitespace inside the brackets', () => {
    expect(parts('[[  note  ]]').parts.target).toBe('note')
  })

  it('rejects non-wikilink strings', () => {
    expect(err('note')).toBe('not-a-wikilink')
    expect(err('[note]')).toBe('not-a-wikilink')
    expect(err('[[note]')).toBe('not-a-wikilink')
    expect(err('')).toBe('not-a-wikilink')
  })
})

describe('parseWikilink — :field fragment', () => {
  it('parses a target with a field fragment', () => {
    const r = parts('[[paper-a:sources]]')
    expect(r.parts.target).toBe('paper-a')
    expect(r.parts.field).toBe('sources')
    expect(r.parts.anchor).toBeNull()
    expect(r.parts.block_id).toBeNull()
  })

  it('parses full canonical order with a field', () => {
    const r = parts('[[note#section^block-id:field-name]]')
    expect(r.parts.target).toBe('note')
    expect(r.parts.repo).toBeNull()
    expect(r.parts.anchor).toBe('section')
    expect(r.parts.block_id).toEqual({ id: 'block-id', referent: false })
    expect(r.parts.field).toBe('field-name')
  })

  it('parses target + block-id + field with no anchor', () => {
    const r = parts('[[note^id:field]]')
    expect(r.parts.target).toBe('note')
    expect(r.parts.anchor).toBeNull()
    expect(r.parts.block_id).toEqual({ id: 'id', referent: false })
    expect(r.parts.field).toBe('field')
  })

  it('rejects a field before an anchor', () => {
    expect(err('[[note:field#anchor]]')).toBe('field-out-of-order')
  })

  it('rejects a field before a block id', () => {
    expect(err('[[note:field^id]]')).toBe('field-out-of-order')
  })

  it('rejects an empty field value', () => {
    expect(err('[[note:]]')).toBe('empty-field')
  })

  it('rejects a target-only field as empty target', () => {
    expect(err('[[:field]]')).toBe('empty-target')
  })

  it('rejects an invalid field name', () => {
    expect(err('[[note:1bad]]')).toBe('invalid-field-name')
    expect(err('[[note:bad*name]]')).toBe('invalid-field-name')
    expect(err('[[note:bad name]]')).toBe('invalid-field-name')
  })

  it('accepts a field name with a dot and an underscore', () => {
    expect(parts('[[note:decision.decided]]').parts.field).toBe('decision.decided')
    expect(parts('[[note:field_underscored]]').parts.field).toBe('field_underscored')
  })

  it('keeps field null with no field fragment', () => {
    expect(parts('[[bare-target]]').parts.field).toBeNull()
  })
})

describe('parseWikilink — ::repo qualifier', () => {
  it('parses a repo qualifier', () => {
    const r = parts('[[recovery::base]]')
    expect(r.parts.target).toBe('recovery')
    expect(r.parts.repo).toBe('base')
    expect(r.parts.anchor).toBeNull()
    expect(r.parts.block_id).toBeNull()
    expect(r.parts.field).toBeNull()
  })

  it('parses repo then all fragments in canonical order', () => {
    const r = parts('[[note::base#section^block-id:field-name]]')
    expect(r.parts.target).toBe('note')
    expect(r.parts.repo).toBe('base')
    expect(r.parts.anchor).toBe('section')
    expect(r.parts.block_id).toEqual({ id: 'block-id', referent: false })
    expect(r.parts.field).toBe('field-name')
  })

  it('rejects an empty repo value', () => {
    expect(err('[[note::]]')).toBe('empty-repo')
  })

  it('rejects an invalid repo name, accepts a dashed identifier', () => {
    for (const bad of ['[[note::b/c]]', '[[note::ba d]]', '[[note::1bad]]']) {
      expect(err(bad)).toBe('invalid-repo-name')
    }
    expect(parts('[[note::d100-free-skill]]').parts.repo).toBe('d100-free-skill')
  })

  it('rejects a repo after a fragment as out of order', () => {
    expect(err('[[note#sec::base]]')).toBe('repo-out-of-order')
  })

  it('rejects two repo qualifiers as out of order', () => {
    expect(err('[[note::base::other]]')).toBe('repo-out-of-order')
  })

  it('rejects a repo-root reference (empty target) as empty target', () => {
    expect(err('[[::base]]')).toBe('empty-target')
  })
})

describe('parseWikilink — @commit pin', () => {
  it('parses a repo with a commit pin', () => {
    const r = parts('[[notes/draft::base@a1b2c3d]]')
    expect(r.parts.target).toBe('notes/draft')
    expect(r.parts.repo).toBe('base')
    expect(r.parts.commit).toBe('a1b2c3d')
    expect(r.parts.anchor).toBeNull()
  })

  it('parses a this-repo commit pin (::@commit)', () => {
    const r = parts('[[notes/draft::@a1b2c3d]]')
    expect(r.parts.target).toBe('notes/draft')
    expect(r.parts.repo).toBeNull()
    expect(r.parts.commit).toBe('a1b2c3d')
  })

  it('parses a commit then all fragments in canonical order', () => {
    const r = parts('[[note::base@sha#section^block-id:field-name]]')
    expect(r.parts.target).toBe('note')
    expect(r.parts.repo).toBe('base')
    expect(r.parts.commit).toBe('sha')
    expect(r.parts.anchor).toBe('section')
    expect(r.parts.block_id).toEqual({ id: 'block-id', referent: false })
    expect(r.parts.field).toBe('field-name')
  })

  it('rejects an empty commit value', () => {
    expect(err('[[note::@]]')).toBe('empty-commit')
    expect(err('[[note::base@]]')).toBe('empty-commit')
  })

  it('treats a bare @ without a repo as a literal filename char', () => {
    const r = parts('[[file@sha]]')
    expect(r.parts.target).toBe('file@sha')
    expect(r.parts.commit).toBeNull()
    expect(r.parts.repo).toBeNull()
  })

  it('keeps an @ in the name before the repo literal', () => {
    const r = parts('[[my@file::base]]')
    expect(r.parts.target).toBe('my@file')
    expect(r.parts.repo).toBe('base')
    expect(r.parts.commit).toBeNull()
  })

  it('keeps an empty repo without a commit as empty repo', () => {
    expect(err('[[note::]]')).toBe('empty-repo')
    expect(err('[[note::#sec]]')).toBe('empty-repo')
  })

  it('keeps commit null on unpinned links', () => {
    expect(parts('[[note]]').parts.commit).toBeNull()
    expect(parts('[[note::base]]').parts.commit).toBeNull()
    expect(parts('[[note#sec]]').parts.commit).toBeNull()
  })
})

describe('parseWikilink — commit-referent (empty name + commit)', () => {
  it('parses a this-repo commit-referent (::@sha)', () => {
    const r = parts('[[::@a1b2c3d]]')
    expect(r.parts.target).toBe('')
    expect(r.parts.repo).toBeNull()
    expect(r.parts.commit).toBe('a1b2c3d')
  })

  it('parses a cross-repo commit-referent (::repo@sha)', () => {
    const r = parts('[[::au-provenance@a1b2c3d]]')
    expect(r.parts.target).toBe('')
    expect(r.parts.repo).toBe('au-provenance')
    expect(r.parts.commit).toBe('a1b2c3d')
  })

  it('rejects a commit-referent carrying a locating or field fragment', () => {
    expect(err('[[::@a1b2c3d^id]]')).toBe('empty-target')
    expect(err('[[::au-provenance@a1b2c3d#head]]')).toBe('empty-target')
    expect(err('[[::@a1b2c3d:field]]')).toBe('empty-target')
  })
})

describe('parseWikilink — colon-in-heading disambiguation', () => {
  it('treats a colon after a bare heading as literal anchor text', () => {
    const r = parts('[[note#section:field-name]]')
    expect(r.parts.target).toBe('note')
    expect(r.parts.anchor).toBe('section:field-name')
    expect(r.parts.block_id).toBeNull()
    expect(r.parts.field).toBeNull()
  })

  it('does not mis-split a heading that contains a colon', () => {
    const r = parts('[[note#My: Heading]]')
    expect(r.parts.target).toBe('note')
    expect(r.parts.anchor).toBe('My: Heading')
    expect(r.parts.field).toBeNull()
  })

  it('lets a field follow a block id even after a colon-bearing heading', () => {
    const r = parts('[[note#My: Sec^rec-1:contributesTo]]')
    expect(r.parts.anchor).toBe('My: Sec')
    expect(r.parts.block_id).toEqual({ id: 'rec-1', referent: false })
    expect(r.parts.field).toBe('contributesTo')
  })
})

describe('parseWikilink — empty inner and local forms', () => {
  it('distinguishes empty inner from not-a-wikilink', () => {
    expect(err('[[]]')).toBe('empty-inner')
    expect(err('[[ ]]')).toBe('empty-inner')
  })

  it('parses a target-only anchor as a local form', () => {
    const r = parts('[[#section]]')
    expect(r.parts.target).toBe('')
    expect(r.parts.anchor).toBe('section')
    expect(r.parts.block_id).toBeNull()
  })

  it('keeps an empty anchor local form as empty anchor', () => {
    expect(err('[[#]]')).toBe('empty-anchor')
  })

  it('parses a target-only block id as a local form', () => {
    const r = parts('[[^block]]')
    expect(r.parts.target).toBe('')
    expect(r.parts.block_id).toEqual({ id: 'block', referent: false })
    expect(r.parts.anchor).toBeNull()
    expect(r.parts.field).toBeNull()
  })

  it('parses a local form with a field fragment', () => {
    const r = parts('[[^id:field]]')
    expect(r.parts.target).toBe('')
    expect(r.parts.block_id).toEqual({ id: 'id', referent: false })
    expect(r.parts.field).toBe('field')
  })

  it('keeps an empty block-id local form as empty block id', () => {
    expect(err('[[^]]')).toBe('empty-block-id')
  })

  it('parses a named target with a block id (not a local form)', () => {
    expect(parts('[[note^block]]').parts.target).toBe('note')
  })
})

describe('parseWikilink — ^^ block-referent (schema 7)', () => {
  it('parses a doubled caret as a block-referent', () => {
    // `^^id` is the block-referent mode, the block's value fills the slot.
    const r = parts('[[note^^abc-123]]')
    expect(r.parts.target).toBe('note')
    expect(r.parts.block_id).toEqual({ id: 'abc-123', referent: true })
  })

  it('does not let the doubled caret swallow a :field', () => {
    const r = parts('[[note^^id:field]]')
    expect(r.parts.target).toBe('note')
    expect(r.parts.block_id).toEqual({ id: 'id', referent: true })
    expect(r.parts.field).toBe('field')
  })

  it('parses a local block-referent [[^^id]]', () => {
    const r = parts('[[^^id]]')
    expect(r.parts.target).toBe('')
    expect(r.parts.block_id).toEqual({ id: 'id', referent: true })
  })

  it('parses canonical order anchor then block-referent', () => {
    const r = parts('[[note#section^^abc-123]]')
    expect(r.parts.anchor).toBe('section')
    expect(r.parts.block_id).toEqual({ id: 'abc-123', referent: true })
  })

  it('rejects a doubled caret with no id as empty block id', () => {
    expect(err('[[note^^]]')).toBe('empty-block-id')
    expect(err('[[^^]]')).toBe('empty-block-id')
  })
})

describe('looksLikeWikilink', () => {
  it('accepts bracketed content, even malformed', () => {
    expect(looksLikeWikilink('[[note]]')).toBe(true)
    expect(looksLikeWikilink('[[note^]]')).toBe(true)
    expect(looksLikeWikilink('[[#section]]')).toBe(true)
    expect(looksLikeWikilink('  [[note]]  ')).toBe(true)
  })

  it('rejects unshaped strings', () => {
    expect(looksLikeWikilink('')).toBe(false)
    expect(looksLikeWikilink('note')).toBe(false)
    expect(looksLikeWikilink('[note]')).toBe(false)
    expect(looksLikeWikilink('[[note]')).toBe(false)
    expect(looksLikeWikilink('[[]]')).toBe(false)
  })
})

describe('parseTypeName — the reduced ::repo split for served type names', () => {
  it('returns a bare name with repo absent', () => {
    expect(parseTypeName('decision')).toEqual({ name: 'decision' })
  })

  it('splits a qualified name on the first ::', () => {
    expect(parseTypeName('decision::au-host')).toEqual({ name: 'decision', repo: 'au-host' })
  })

  it('treats a trailing :: with no repo as bare', () => {
    expect(parseTypeName('decision::')).toEqual({ name: 'decision' })
  })

  it('keeps a dotted type name intact', () => {
    expect(parseTypeName('mcp.tool::base')).toEqual({ name: 'mcp.tool', repo: 'base' })
  })

  it('agrees with parseWikilink on the qualifier for a fragment-free name', () => {
    const viaName = parseTypeName('decision::au-host')
    const viaLink = parseWikilink('[[decision::au-host]]')
    expect(viaLink.ok).toBe(true)
    if (viaLink.ok) {
      expect(viaLink.parts.target).toBe(viaName.name)
      expect(viaLink.parts.repo).toBe(viaName.repo ?? null)
    }
  })
})

// The caret-context corpus. A ported corpus that this helper replaces.
// Adapted to the inner form: the helper never sees `[[`, so the consumer's own
// bracket scan is not under test here.
describe('wikilinkCaretContext — the slot being typed', () => {
  it('completes an empty target right after the brackets', () => {
    expect(wikilinkCaretContext('')).toMatchObject({ slot: 'target', query: '' })
  })

  it('completes a bare target', () => {
    const c = wikilinkCaretContext('note')
    expect(c).toMatchObject({ slot: 'target', query: 'note' })
    // The name is unfinished, so it is the query, not yet a part.
    expect(c?.parts.target).toBe('')
  })

  it('completes a path-bearing target', () => {
    expect(wikilinkCaretContext('content/refs/run')).toMatchObject({ slot: 'target', query: 'content/refs/run' })
  })

  it('treats a bare @ as literal filename text, not a commit pin', () => {
    expect(wikilinkCaretContext('my@file')).toMatchObject({ slot: 'target', query: 'my@file' })
  })

  it('treats a pipe as literal target text, since there is no alias form', () => {
    expect(wikilinkCaretContext('a|b')).toMatchObject({ slot: 'target', query: 'a|b' })
  })

  it('completes the ::repo qualifier', () => {
    const c = wikilinkCaretContext('note::xr-ba')
    expect(c).toMatchObject({ slot: 'repo', query: 'xr-ba' })
    expect(c?.parts).toMatchObject({ target: 'note', repo: null })
  })

  it('completes an empty ::repo qualifier', () => {
    expect(wikilinkCaretContext('note::')).toMatchObject({ slot: 'repo', query: '' })
  })

  // Mid-typing, a repo that breaks the identifier grammar is just unfinished.
  it('still completes a repo whose typed text is not yet valid', () => {
    expect(wikilinkCaretContext('note::b/c')).toMatchObject({ slot: 'repo', query: 'b/c' })
  })

  it('keeps the repo once a later fragment opens', () => {
    const c = wikilinkCaretContext('note::xr-base#Head')
    expect(c).toMatchObject({ slot: 'anchor', query: 'Head' })
    expect(c?.parts).toMatchObject({ target: 'note', repo: 'xr-base', anchor: null })
  })

  it('completes the @commit pin, which binds to ::', () => {
    const c = wikilinkCaretContext('note::xr-base@ab12')
    expect(c).toMatchObject({ slot: 'commit', query: 'ab12' })
    expect(c?.parts).toMatchObject({ repo: 'xr-base', commit: null })
  })

  // The prefix `note::` is `empty-repo` on its own, yet `[[note::@abc]]` is a
  // valid this-repo pin. Validating the bare prefix would refuse to complete it.
  it('completes the this-repo commit pin, whose prefix does not parse alone', () => {
    const c = wikilinkCaretContext('note::@ab')
    expect(c).toMatchObject({ slot: 'commit', query: 'ab' })
    expect(c?.parts).toMatchObject({ target: 'note', repo: null, commit: null })
  })

  it('keeps the commit once a later fragment opens', () => {
    const c = wikilinkCaretContext('note::xr-base@ab12#Head')
    expect(c).toMatchObject({ slot: 'anchor', query: 'Head' })
    expect(c?.parts).toMatchObject({ repo: 'xr-base', commit: 'ab12' })
  })

  it('completes an anchor', () => {
    const c = wikilinkCaretContext('note#Some Head')
    expect(c).toMatchObject({ slot: 'anchor', query: 'Some Head' })
    expect(c?.parts).toMatchObject({ target: 'note', anchor: null })
  })

  it('completes an empty anchor, which the parser rejects as empty-anchor', () => {
    expect(wikilinkCaretContext('note#')).toMatchObject({ slot: 'anchor', query: '' })
    expect(parseWikilink('[[note#]]')).toEqual({ ok: false, error: 'empty-anchor' })
  })

  it('keeps a colon inside heading text in the anchor', () => {
    expect(wikilinkCaretContext('note#Head: subtitle')).toMatchObject({ slot: 'anchor', query: 'Head: subtitle' })
  })

  it('completes a navigational block-id', () => {
    expect(wikilinkCaretContext('note^blk')).toMatchObject({ slot: 'block', referent: false, query: 'blk' })
  })

  // One caret changes what the link contributes, so the mode must survive.
  it('completes a block-referent block-id and reports the doubled sigil', () => {
    expect(wikilinkCaretContext('note^^blk')).toMatchObject({ slot: 'block', referent: true, query: 'blk' })
  })

  it('completes a block-id after an anchor, the canonical order', () => {
    const c = wikilinkCaretContext('note#head^blk')
    expect(c).toMatchObject({ slot: 'block', query: 'blk' })
    expect(c?.parts).toMatchObject({ anchor: 'head', block_id: null })
  })

  it('completes a :field contribution', () => {
    const c = wikilinkCaretContext('note:conf')
    expect(c).toMatchObject({ slot: 'field', query: 'conf' })
    expect(c?.parts).toMatchObject({ target: 'note', field: null })
  })

  it('completes :field after a block-id, keeping the block referent mode', () => {
    const c = wikilinkCaretContext('note^^blk:conf')
    expect(c).toMatchObject({ slot: 'field', referent: false, query: 'conf' })
    expect(c?.parts.block_id).toEqual({ id: 'blk', referent: true })
  })

  it('completes an empty field, which the parser rejects as empty-field', () => {
    expect(wikilinkCaretContext('note:')).toMatchObject({ slot: 'field', query: '' })
    expect(parseWikilink('[[note:]]')).toEqual({ ok: false, error: 'empty-field' })
  })

  it('leaves the query verbatim, so trailing space is text the user typed', () => {
    expect(wikilinkCaretContext('note#Head ')).toMatchObject({ slot: 'anchor', query: 'Head ' })
  })
})

// The local forms carry no name at all, and the empty prefix is exactly what
// `parseWikilinkInner` rejects as `empty-inner`. A locating fragment grants the
// empty name, so the completion answer must grant it too.
describe('wikilinkCaretContext — the local forms', () => {
  it('completes a local anchor', () => {
    const c = wikilinkCaretContext('#Head')
    expect(c).toMatchObject({ slot: 'anchor', query: 'Head' })
    expect(c?.parts.target).toBe('')
    expect(parseWikilinkInner('')).toEqual({ ok: false, error: 'empty-inner' })
  })

  it('completes a local block-id', () => {
    expect(wikilinkCaretContext('^scaling')).toMatchObject({ slot: 'block', query: 'scaling' })
  })

  it('completes a local block-referent', () => {
    const c = wikilinkCaretContext('^^scaling')
    expect(c).toMatchObject({ slot: 'block', referent: true, query: 'scaling' })
    expect(c?.parts.target).toBe('')
  })

  it('completes a block-id after a local anchor', () => {
    const c = wikilinkCaretContext('#head^blk')
    expect(c).toMatchObject({ slot: 'block', query: 'blk' })
    expect(c?.parts).toMatchObject({ target: '', anchor: 'head' })
  })

  // A field is a contribution, which needs a target to contribute from. The
  // grammar grants the empty name to `#anchor` / `^block` only.
  it('refuses a local field, which the grammar never grants', () => {
    expect(wikilinkCaretContext(':field')).toBeNull()
    expect(parseWikilink('[[:field]]')).toEqual({ ok: false, error: 'empty-target' })
  })
})

// A malformed link is refused rather than guessed at: completing one would
// offer candidates for a link the engine then rejects.
describe('wikilinkCaretContext — malformed links', () => {
  it('refuses reversed ^ / # order, whose prefix parses fine on its own', () => {
    expect(wikilinkCaretContext('note^blk#head')).toBeNull()
    expect(parseWikilinkInner('note^blk').ok).toBe(true)
    expect(parseWikilink('[[note^blk#head]]')).toEqual({ ok: false, error: 'reversed-delimiters' })
  })

  it('refuses a :field before its locators, whose prefix also parses fine', () => {
    expect(wikilinkCaretContext('note:f#head')).toBeNull()
    expect(parseWikilinkInner('note:f').ok).toBe(true)
    expect(parseWikilink('[[note:f#head]]')).toEqual({ ok: false, error: 'field-out-of-order' })
  })

  it('refuses a ::repo qualifier after a fragment', () => {
    expect(wikilinkCaretContext('note#head::repo')).toBeNull()
  })

  it('refuses a second ::repo', () => {
    expect(wikilinkCaretContext('a::b::c')).toBeNull()
  })

  it('refuses a repo-root link, which has no target to complete against', () => {
    expect(wikilinkCaretContext('::xr-ba')).toBeNull()
    expect(parseWikilink('[[::xr-base]]')).toEqual({ ok: false, error: 'empty-target' })
  })

  it('refuses a completed repo the parser refuses', () => {
    expect(wikilinkCaretContext('note::b/c#head')).toBeNull()
    expect(wikilinkCaretContext('note::1bad#head')).toBeNull()
  })
})
