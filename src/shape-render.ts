// Pure renderers over the parsed slot shape (`WireShape`, `./reads`). The SDK
// owns `WireShape`, so it is the canonical home for its human-facing renderers,
// reusable by every consumer (an editor hover, a future LSP, an agent's
// author-an-instance surface). No daemon, no host vocabulary — `(WireShape) =>
// string`, renderer-safe.
//
// Two members of one family, at two verbosities:
// - `shapeLabel` — a compact type annotation for display (a chip / hover line
//   like `severity: enum[low, moderate]`). NOT a source round-trip: it is a
//   readable label, so `enum` self-labels and a list carries its cardinality.
// - `describeShape` — a plain-English gloss for a hover explanation or an agent.
//
// The 5-value coloring bucket (`shapeKind`) is deliberately NOT here: its output
// vocabulary is editor presentation, so it stays with the consumer.

import type { WirePrimitiveName, WireRefinement, WireShape } from './reads.ts'

// ---------------------------------------------------------------------------
// shapeLabel — compact display notation

/**
 * A compact, source-like type annotation for `shape`, for a chip or a hover line
 * (`decision*`, `Number{>=0 & integer}`, `enum[low, moderate]`, `file*[]`). Total
 * over `WireShape`, recursing the wrapper (`list` / `pinned`) and multi-branch
 * kinds. A readable label for display, not a parser round-trip.
 */
export function shapeLabel(shape: WireShape): string {
  switch (shape.kind) {
    case 'primitive':
      return shape.name
    case 'any':
      return 'any'
    case 'opaque':
      return 'opaque'
    case 'enum':
      return `enum[${shape.members.join(', ')}]`
    case 'reference':
      return `${shape.name}*`
    case 'record':
      return shape.name
    case 'inline-or-reference':
      return `${shape.name}&`
    case 'list':
      return `${shapeLabel(shape.inner)}${cardinalityLabel(shape.min, shape.max)}`
    case 'union':
      return shape.branches.map(shapeLabel).join(' | ')
    case 'intersection':
      return shape.branches.map(shapeLabel).join(' & ')
    case 'compound-reference':
      return `<${shape.branches.join(shape.op === 'union' ? ' | ' : ' & ')}>${shape.mode === 'ref' ? '*' : '&'}`
    case 'def-reference':
      return `type${defBoundLabel(shape.bound)}*`
    case 'pinned':
      return `${shapeLabel(shape.inner)}@`
    case 'refined':
      return `${shape.base}{${refinementParts(shape.refinement).join(' & ')}}`
    case 'tuple':
      return `(${shape.elements.map(shapeLabel).join(', ')})`
    default:
      // Additive evolution: tolerate a kind newer than this SDK by naming it.
      return (shape as { kind: string }).kind
  }
}

/** The list cardinality suffix from `{min, max}`: `[]` `[+]` `[n]` `[..m]` `[x..y]` `[x..]`. */
function cardinalityLabel(min: number, max?: number): string {
  if (max === undefined) {
    if (min === 0) return '[]'
    if (min === 1) return '[+]'
    return `[${min}..]`
  }
  if (min === max) return `[${min}]`
  if (min === 0) return `[..${max}]`
  return `[${min}..${max}]`
}

/** The `def-reference` bound suffix: `` (any), `<T>`, `<a | b>`. */
function defBoundLabel(bound: (WireShape & { kind: 'def-reference' })['bound']): string {
  if (bound === undefined) return ''
  if (bound.kind === 'single') return `<${bound.name}>`
  return `<${bound.branches.join(bound.op === 'union' ? ' | ' : ' & ')}>`
}

/** The refinement predicate atoms in a stable order: bounds, `integer`, `/pattern/`. */
function refinementParts(r: WireRefinement): string[] {
  const parts: string[] = []
  if (r.lower) parts.push(`>${r.lower.inclusive ? '=' : ''}${r.lower.value}`)
  if (r.upper) parts.push(`<${r.upper.inclusive ? '=' : ''}${r.upper.value}`)
  if (r.integer) parts.push('integer')
  if (r.pattern !== undefined) parts.push(`/${r.pattern}/`)
  return parts
}

// ---------------------------------------------------------------------------
// describeShape — plain-English gloss

/**
 * A plain-English gloss of `shape`, for a hover explanation or an agent surface
 * (`decision*` → "a reference to a file whose type is decision, or a subtype").
 * Total over `WireShape`, recursing wrappers and branches. The wording is the
 * SDK's; the semantics follow the type-system model.
 */
export function describeShape(shape: WireShape): string {
  switch (shape.kind) {
    case 'primitive':
      return primitiveGloss(shape.name)
    case 'any':
      return 'any value'
    case 'opaque':
      return 'an uninterpreted value, stored but never read'
    case 'enum':
      return `one of: ${shape.members.join(', ')}`
    case 'reference':
      return referenceGloss(shape.name)
    case 'record':
      return `an inline ${shape.name} record`
    case 'inline-or-reference':
      return shape.name === 'any'
        ? 'an inline value of any type, or a reference to one'
        : `an inline ${shape.name} record, or a reference to one`
    case 'list':
      return listGloss(shape.min, shape.max, describeShape(shape.inner))
    case 'union':
      return `either ${joinAlternatives(shape.branches.map(describeShape))}`
    case 'intersection':
      return joinConjunction(shape.branches.map(describeShape))
    case 'compound-reference': {
      const types = shape.branches.join(shape.op === 'union' ? ' or ' : ' and ')
      return shape.mode === 'ref'
        ? `a reference to a file whose type is ${types}, or a subtype`
        : `an inline record of type ${types}, or a reference to one`
    }
    case 'def-reference':
      return defReferenceGloss(shape.bound)
    case 'pinned':
      return `a commit-pinned ${describeShape(shape.inner)}`
    case 'refined':
      return refinedGloss(shape.base, shape.refinement)
    case 'tuple':
      return `a tuple of (${shape.elements.map(describeShape).join(', ')})`
    default:
      // Additive evolution: a kind newer than this SDK still gets a gloss.
      return 'a value'
  }
}

function primitiveGloss(name: WirePrimitiveName): string {
  switch (name) {
    case 'String':
      return 'text'
    case 'Number':
      return 'a number'
    case 'Boolean':
      return 'true or false'
    case 'Date':
      return 'a date'
    case 'DateTime':
      return 'a UTC timestamp'
    case 'Url':
      return 'an HTTP(S) URL'
    default:
      return name
  }
}

/** The two built-in reference names read specially; every other name is a type. */
function referenceGloss(name: string): string {
  if (name === 'file') return 'a reference to any file'
  if (name === 'any') return 'a reference to a file of any type'
  return `a reference to a file (or typed block) whose type is ${name}, or a subtype`
}

function listGloss(min: number, max: number | undefined, inner: string): string {
  if (max === undefined) {
    if (min === 0) return `a list of ${inner}`
    if (min === 1) return `a non-empty list of ${inner}`
    return `a list of at least ${min} ${inner}`
  }
  if (min === max) return `a list of exactly ${min} ${inner}`
  if (min === 0) return `a list of up to ${max} ${inner}`
  return `a list of ${min} to ${max} ${inner}`
}

function defReferenceGloss(bound: (WireShape & { kind: 'def-reference' })['bound']): string {
  if (bound === undefined) return 'a reference to a type-def'
  if (bound.kind === 'single') {
    return `a reference to a type-def whose parent closure includes ${bound.name}`
  }
  const names = bound.branches.join(bound.op === 'union' ? ' or ' : ' and ')
  return `a reference to a type-def whose parent closure includes ${names}`
}

/** `Base{predicate}` in words: base gloss narrowed by the refinement's atoms. */
function refinedGloss(base: WirePrimitiveName, r: WireRefinement): string {
  if (base === 'Number') {
    const head = r.integer ? 'a whole number' : 'a number'
    const bounds: string[] = []
    if (r.lower) bounds.push(`${r.lower.inclusive ? '≥' : '>'} ${r.lower.value}`)
    if (r.upper) bounds.push(`${r.upper.inclusive ? '≤' : '<'} ${r.upper.value}`)
    return bounds.length > 0 ? `${head} ${bounds.join(' and ')}` : head
  }
  if (base === 'Date' || base === 'DateTime') {
    const head = base === 'Date' ? 'a date' : 'a UTC timestamp'
    const phrases: string[] = []
    if (r.lower) phrases.push(r.lower.inclusive ? `on or after ${r.lower.value}` : `after ${r.lower.value}`)
    if (r.upper) phrases.push(r.upper.inclusive ? `on or before ${r.upper.value}` : `before ${r.upper.value}`)
    return phrases.length > 0 ? `${head} ${phrases.join(' and ')}` : head
  }
  if (base === 'String' && r.pattern !== undefined) {
    return `text matching /${r.pattern}/`
  }
  // No other base is refined (Boolean / Url never; String only by pattern).
  return primitiveGloss(base)
}

/** "a", "a or b", "a, b, or c" — the union's alternatives with an Oxford comma. */
function joinAlternatives(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  if (parts.length === 2) return `${parts[0]} or ${parts[1]}`
  return `${parts.slice(0, -1).join(', ')}, or ${parts[parts.length - 1]}`
}

/** "both a and b" for two, "all of a, b, and c" for more. */
function joinConjunction(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  if (parts.length === 2) return `both ${parts[0]} and ${parts[1]}`
  return `all of ${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
}
