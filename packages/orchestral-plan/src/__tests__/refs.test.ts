// The one $ref walk, and the four rules that used to differ between its three
// copies.
//
// Before this module there were three: `parseValueRef` / `collectRefHeads`
// beside `validatePlan` in @orchestral/core, `parseValueRef` / `dependenciesOf`
// / `walkStrings` in the interpreter in @orchestral/patterns, and
// `dependenciesOf` / `refHead` in `preflightPlan` in @orchestral/runtime. Two of
// them carried a comment asking a human to keep them in step. What those
// comments guarded is the plan's central promise — the string layer 1 reads as a
// reference is the string the interpreter substitutes and the string preflight
// bills for — and the tests below are that promise, stated once.

import { describe, expect, it } from 'vitest'

import type { PlanDag, PlanStep } from '../plan'
import {
  PLAN_REF_MAX_DEPTH,
  collectRefHeads,
  dependenciesOf,
  parseAssetRef,
  parseValueRef,
  planLevels,
  refHead,
} from '../refs'

/** A step, with only the two fields any walk reads. */
function step(
  id: string,
  input: Record<string, unknown>,
  assets?: PlanStep['assets'],
): PlanStep {
  return {
    id,
    pattern: 'text-generation',
    input,
    ...(assets !== undefined ? { assets } : {}),
  } as PlanStep
}

/** `wrap` `depth` times around `leaf`. `nest(0, x)` is `x` itself. */
function nest(depth: number, leaf: unknown): unknown {
  let node = leaf
  for (let i = 0; i < depth; i += 1) node = { wrap: node }
  return node
}

describe('parseValueRef', () => {
  it('reads the head greedily, so $inputs is a step and $input is the parameters', () => {
    expect(parseValueRef('$input.prompt')).toEqual({
      head: 'input',
      isInput: true,
      segments: ['prompt'],
    })
    expect(parseValueRef('$inputs.prompt')).toEqual({
      head: 'inputs',
      isInput: false,
      segments: ['prompt'],
    })
  })

  it('splits field and index segments in written order', () => {
    expect(parseValueRef('$judge.choices[2].text')).toEqual({
      head: 'judge',
      isInput: false,
      segments: ['choices', 2, 'text'],
    })
  })

  it('is null for anything that is not a whole-string value reference', () => {
    expect(parseValueRef('$describe')).toBeNull()
    expect(parseValueRef('a red bicycle')).toBeNull()
    expect(parseValueRef('Costs $5.99 per render')).toBeNull()
  })
})

describe('parseAssetRef', () => {
  it('reads both selectors', () => {
    expect(parseAssetRef('$render.assets[0]')).toEqual({ head: 'render', index: 0 })
    expect(parseAssetRef('$hero.assets[label=winner]')).toEqual({
      head: 'hero',
      label: 'winner',
    })
  })

  it('leaves the documented overlap alone: $x.assets[0] parses as both productions', () => {
    // The value production has no way to exclude a field literally called
    // `assets`; rule 7 in validate.ts checks the first segment, not the regex.
    expect(parseValueRef('$render.assets[0]')?.head).toBe('render')
    expect(refHead('$render.assets[0]')).toBe('render')
  })
})

describe('dependenciesOf', () => {
  it('reads heads through both channels — input values and bound asset slots', () => {
    const deps = dependenciesOf(
      step('animate', { prompt: '$describe.text' }, {
        startFrame: '$render.assets[0]',
        reference: ['$take-0.assets[0]', '$hero.assets[label=winner]'],
      } as PlanStep['assets']),
    )
    expect([...deps].sort()).toEqual(['describe', 'hero', 'render', 'take-0'])
  })

  it('never counts $input: the plan’s own parameters are not a step', () => {
    expect([...dependenciesOf(step('render', { prompt: '$input.prompt' }))]).toEqual([])
  })

  it('counts only WHOLE-string references, because that is all the interpreter substitutes', () => {
    const deps = dependenciesOf(
      step('render', {
        prompt: 'Costs $5.99, and looks like $describe.text',
        system: '$describe.text',
      }),
    )
    expect([...deps]).toEqual(['describe'])
  })

  it('does not filter by the declared step ids — an unknown head comes back as read', () => {
    // The interpreter's copy took a `declared` set and dropped anything outside
    // it. Redundant: rule 5/6 in validate.ts refuse an unknown or forward head
    // before any of this runs, and `planLevels` ignores a head it has no level
    // for. One fewer parameter is one fewer convention a caller can get wrong.
    expect([...dependenciesOf(step('render', { prompt: '$ghost.text' }))]).toEqual(['ghost'])
  })

  it('stops descending at PLAN_REF_MAX_DEPTH, the cap rule 24 already enforces', () => {
    // The step's `input` record is depth 0 and each wrapper adds one, so a ref
    // wrapped d times is visited at depth 1 + d and is found while 1 + d <= 64.
    // The interpreter's copy had no cap at all; core's and preflight's had this
    // one. Uniform now, which is what makes "a plan that validates has every
    // ref found by every walk" a property rather than an argument — rule 24
    // refuses an input nested deeper than this before the walk ever runs.
    expect(PLAN_REF_MAX_DEPTH).toBe(64)
    const at = (d: number): string[] => [
      ...dependenciesOf(step('render', { field: nest(d, '$a.text') })),
    ]
    expect(at(PLAN_REF_MAX_DEPTH - 1)).toEqual(['a'])
    expect(at(PLAN_REF_MAX_DEPTH)).toEqual([])
  })
})

describe('collectRefHeads', () => {
  it('accumulates into a caller’s set, skipping $input, over any shape', () => {
    const into = new Set<string>()
    collectRefHeads(
      { a: ['$one.text', { b: '$two.assets[0]' }], c: '$input.prompt', d: 7 },
      into,
    )
    expect([...into].sort()).toEqual(['one', 'two'])
  })
})

describe('planLevels', () => {
  const dag: PlanDag = {
    steps: [
      step('take-0', { prompt: '$input.prompt' }),
      step('take-1', { prompt: '$input.prompt' }),
      step('judge', { prompt: 'pick one' }, {
        source: ['$take-0.assets[0]', '$take-1.assets[0]'],
      } as PlanStep['assets']),
      step('animate', { prompt: '$judge.text' }),
    ],
    output: { values: { verdict: '$judge.text' } },
  } as PlanDag

  it('groups by level(step) = 1 + max(level(dep)), preserving listed order', () => {
    const { levels } = planLevels(dag)
    expect(levels.map((bucket) => bucket.map((s) => s.id))).toEqual([
      ['take-0', 'take-1'],
      ['judge'],
      ['animate'],
    ])
  })

  it('reports each step’s level, which is what preflight renders as a stage', () => {
    const { levelOf } = planLevels(dag)
    expect([...levelOf]).toEqual([
      ['take-0', 0],
      ['take-1', 0],
      ['judge', 1],
      ['animate', 2],
    ])
  })

  it('puts a step whose head names nothing at level 0 rather than throwing', () => {
    const { levels } = planLevels({
      steps: [step('render', { prompt: '$ghost.text' })],
      output: { values: {} },
    } as PlanDag)
    expect(levels.map((bucket) => bucket.map((s) => s.id))).toEqual([['render']])
  })
})
