// The WireShape renderers: `shapeLabel` (compact display notation) and
// `describeShape` (plain-English gloss). Total over the WireShape union — one
// assertion per kind, plus the cardinality / refinement / nesting variants.

import { describe, expect, it } from 'vitest'

import { shapeLabel, describeShape } from '../src/shape-render.ts'
import type { WireShape } from '../src/reads.ts'

const ref = (name: string): WireShape => ({ kind: 'reference', name })

describe('shapeLabel', () => {
  it('renders every primitive by name', () => {
    for (const name of ['String', 'Number', 'Boolean', 'Date', 'DateTime', 'Url'] as const) {
      expect(shapeLabel({ kind: 'primitive', name })).toBe(name)
    }
  })

  it('renders the no-payload kinds', () => {
    expect(shapeLabel({ kind: 'any' })).toBe('any')
    expect(shapeLabel({ kind: 'opaque' })).toBe('opaque')
  })

  it('renders enum, reference, record, inline-or-reference', () => {
    expect(shapeLabel({ kind: 'enum', members: ['low', 'moderate'] })).toBe('enum[low, moderate]')
    expect(shapeLabel(ref('decision'))).toBe('decision*')
    expect(shapeLabel({ kind: 'record', name: 'phase' })).toBe('phase')
    expect(shapeLabel({ kind: 'inline-or-reference', name: 'phase' })).toBe('phase&')
  })

  it('renders list cardinality, recursing the inner shape', () => {
    const inner = ref('decision')
    expect(shapeLabel({ kind: 'list', min: 0, inner })).toBe('decision*[]')
    expect(shapeLabel({ kind: 'list', min: 1, inner })).toBe('decision*[+]')
    expect(shapeLabel({ kind: 'list', min: 2, max: 2, inner })).toBe('decision*[2]')
    expect(shapeLabel({ kind: 'list', min: 0, max: 3, inner })).toBe('decision*[..3]')
    expect(shapeLabel({ kind: 'list', min: 2, max: 5, inner })).toBe('decision*[2..5]')
    expect(shapeLabel({ kind: 'list', min: 2, inner })).toBe('decision*[2..]')
  })

  it('renders union and intersection', () => {
    expect(shapeLabel({ kind: 'union', branches: [{ kind: 'primitive', name: 'String' }, ref('a')] })).toBe(
      'String | a*',
    )
    expect(shapeLabel({ kind: 'intersection', branches: [ref('a'), ref('b')] })).toBe('a* & b*')
  })

  it('renders compound-reference by mode and op', () => {
    expect(shapeLabel({ kind: 'compound-reference', mode: 'ref', op: 'union', branches: ['a', 'b'] })).toBe('<a | b>*')
    expect(
      shapeLabel({ kind: 'compound-reference', mode: 'inline-or-ref', op: 'intersection', branches: ['a', 'b'] }),
    ).toBe('<a & b>&')
  })

  it('renders def-reference with and without a bound', () => {
    expect(shapeLabel({ kind: 'def-reference' })).toBe('type*')
    expect(shapeLabel({ kind: 'def-reference', bound: { kind: 'single', name: 'T' } })).toBe('type<T>*')
    expect(
      shapeLabel({ kind: 'def-reference', bound: { kind: 'compound', op: 'union', branches: ['a', 'b'] } }),
    ).toBe('type<a | b>*')
  })

  it('renders pinned by wrapping the inner label with @', () => {
    expect(shapeLabel({ kind: 'pinned', inner: ref('file') })).toBe('file*@')
  })

  it('renders refined as Base{predicate}', () => {
    expect(shapeLabel({ kind: 'refined', base: 'Number', refinement: { integer: true } })).toBe('Number{integer}')
    expect(
      shapeLabel({ kind: 'refined', base: 'Number', refinement: { lower: { value: '0', inclusive: true }, integer: true } }),
    ).toBe('Number{>=0 & integer}')
    expect(
      shapeLabel({
        kind: 'refined',
        base: 'Number',
        refinement: { lower: { value: '0', inclusive: false }, upper: { value: '10', inclusive: false } },
      }),
    ).toBe('Number{>0 & <10}')
    expect(shapeLabel({ kind: 'refined', base: 'String', refinement: { pattern: '^[a-z]+$' } })).toBe(
      'String{/^[a-z]+$/}',
    )
    expect(
      shapeLabel({ kind: 'refined', base: 'Date', refinement: { lower: { value: '2020-01-01', inclusive: true } } }),
    ).toBe('Date{>=2020-01-01}')
  })

  it('renders tuple', () => {
    expect(
      shapeLabel({ kind: 'tuple', elements: [{ kind: 'primitive', name: 'Number' }, { kind: 'primitive', name: 'Number' }] }),
    ).toBe('(Number, Number)')
  })
})

describe('describeShape', () => {
  it('glosses every primitive', () => {
    expect(describeShape({ kind: 'primitive', name: 'String' })).toBe('text')
    expect(describeShape({ kind: 'primitive', name: 'Number' })).toBe('a number')
    expect(describeShape({ kind: 'primitive', name: 'Boolean' })).toBe('true or false')
    expect(describeShape({ kind: 'primitive', name: 'Date' })).toBe('a date')
    expect(describeShape({ kind: 'primitive', name: 'DateTime' })).toBe('a UTC timestamp')
    expect(describeShape({ kind: 'primitive', name: 'Url' })).toBe('an HTTP(S) URL')
  })

  it('glosses the no-payload kinds', () => {
    expect(describeShape({ kind: 'any' })).toBe('any value')
    expect(describeShape({ kind: 'opaque' })).toBe('an uninterpreted value, stored but never read')
  })

  it('glosses enum', () => {
    expect(describeShape({ kind: 'enum', members: ['a', 'b', 'c'] })).toBe('one of: a, b, c')
  })

  it('glosses reference, special-casing the built-in names', () => {
    expect(describeShape(ref('decision'))).toBe(
      'a reference to a file (or typed block) whose type is decision, or a subtype',
    )
    expect(describeShape(ref('file'))).toBe('a reference to any file')
    expect(describeShape(ref('any'))).toBe('a reference to a file of any type')
  })

  it('glosses record and inline-or-reference', () => {
    expect(describeShape({ kind: 'record', name: 'phase' })).toBe('an inline phase record')
    expect(describeShape({ kind: 'inline-or-reference', name: 'phase' })).toBe(
      'an inline phase record, or a reference to one',
    )
    expect(describeShape({ kind: 'inline-or-reference', name: 'any' })).toBe(
      'an inline value of any type, or a reference to one',
    )
  })

  it('glosses list cardinality, recursing the inner shape', () => {
    const inner = ref('decision')
    const g = 'a reference to a file (or typed block) whose type is decision, or a subtype'
    expect(describeShape({ kind: 'list', min: 0, inner })).toBe(`a list of ${g}`)
    expect(describeShape({ kind: 'list', min: 1, inner })).toBe(`a non-empty list of ${g}`)
    expect(describeShape({ kind: 'list', min: 2, max: 2, inner })).toBe(`a list of exactly 2 ${g}`)
    expect(describeShape({ kind: 'list', min: 0, max: 3, inner })).toBe(`a list of up to 3 ${g}`)
    expect(describeShape({ kind: 'list', min: 2, max: 5, inner })).toBe(`a list of 2 to 5 ${g}`)
    expect(describeShape({ kind: 'list', min: 2, inner })).toBe(`a list of at least 2 ${g}`)
  })

  it('glosses union and intersection with readable joins', () => {
    expect(describeShape({ kind: 'union', branches: [{ kind: 'primitive', name: 'String' }, ref('a')] })).toBe(
      'either text or a reference to a file (or typed block) whose type is a, or a subtype',
    )
    expect(
      describeShape({
        kind: 'union',
        branches: [{ kind: 'primitive', name: 'String' }, { kind: 'primitive', name: 'Number' }, { kind: 'primitive', name: 'Boolean' }],
      }),
    ).toBe('either text, a number, or true or false')
    expect(
      describeShape({ kind: 'intersection', branches: [{ kind: 'primitive', name: 'String' }, { kind: 'primitive', name: 'Number' }] }),
    ).toBe('both text and a number')
  })

  it('glosses compound-reference by mode and op', () => {
    expect(describeShape({ kind: 'compound-reference', mode: 'ref', op: 'union', branches: ['a', 'b'] })).toBe(
      'a reference to a file whose type is a or b, or a subtype',
    )
    expect(
      describeShape({ kind: 'compound-reference', mode: 'inline-or-ref', op: 'intersection', branches: ['a', 'b'] }),
    ).toBe('an inline record of type a and b, or a reference to one')
  })

  it('glosses def-reference with and without a bound', () => {
    expect(describeShape({ kind: 'def-reference' })).toBe('a reference to a type-def')
    expect(describeShape({ kind: 'def-reference', bound: { kind: 'single', name: 'T' } })).toBe(
      'a reference to a type-def whose parent closure includes T',
    )
    expect(
      describeShape({ kind: 'def-reference', bound: { kind: 'compound', op: 'union', branches: ['a', 'b'] } }),
    ).toBe('a reference to a type-def whose parent closure includes a or b')
  })

  it('glosses pinned by wrapping the inner gloss', () => {
    expect(describeShape({ kind: 'pinned', inner: ref('file') })).toBe('a commit-pinned a reference to any file')
  })

  it('glosses refined per base', () => {
    expect(describeShape({ kind: 'refined', base: 'Number', refinement: { integer: true } })).toBe('a whole number')
    expect(
      describeShape({ kind: 'refined', base: 'Number', refinement: { lower: { value: '0', inclusive: true } } }),
    ).toBe('a number ≥ 0')
    expect(
      describeShape({ kind: 'refined', base: 'Number', refinement: { lower: { value: '0', inclusive: true }, integer: true } }),
    ).toBe('a whole number ≥ 0')
    expect(
      describeShape({
        kind: 'refined',
        base: 'Number',
        refinement: { lower: { value: '0', inclusive: false }, upper: { value: '10', inclusive: false } },
      }),
    ).toBe('a number > 0 and < 10')
    expect(describeShape({ kind: 'refined', base: 'String', refinement: { pattern: '^[a-z]+$' } })).toBe(
      'text matching /^[a-z]+$/',
    )
    expect(
      describeShape({ kind: 'refined', base: 'Date', refinement: { lower: { value: '2020-01-01', inclusive: true } } }),
    ).toBe('a date on or after 2020-01-01')
    expect(
      describeShape({ kind: 'refined', base: 'DateTime', refinement: { upper: { value: '2025-01-01T00:00:00Z', inclusive: false } } }),
    ).toBe('a UTC timestamp before 2025-01-01T00:00:00Z')
  })

  it('glosses tuple, recursing each element', () => {
    expect(
      describeShape({ kind: 'tuple', elements: [{ kind: 'primitive', name: 'Number' }, ref('unit')] }),
    ).toBe('a tuple of (a number, a reference to a file (or typed block) whose type is unit, or a subtype)')
  })
})
