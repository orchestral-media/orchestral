// The input gate both plan layers share, pinned from the outside.
//
// Layer 1 (`validatePlan`'s rule 21, on the step's literal input) and layer 2
// (the interpreter's parse of the SUBSTITUTED input, just before `ctx.step`)
// read the same schema — meta → `tool.inputs`, atomic → `primary.tool.inputs`
// — and parse it with the same top-level `.passthrough()` the dispatch path
// applies. Two verdicts that are one verdict: if either layer drifted, a plan
// could pass layer 1 and be refused at layer 2 for a key it was always going
// to carry, after upstream steps had been paid for.
//
// Driven through the public gates rather than through the helper, so the test
// states what a caller sees and holds across the refactor that made the two
// copies one (input-schema.ts). It is green before that refactor by
// construction — a characterization, not a red.
//
// The sink's schema is `strictObject` on purpose: under zod 4's default strip
// an extra key parses either way, so only a strict schema can tell a gate that
// applies the passthrough from one that does not.
//
// The last case is the one input-schema.ts's header leans on. Both layers
// promise the verdict core's dispatch path would give, and core keeps its own
// copy of that parse rather than exporting it, so the promise is only as good
// as a test that puts the two side by side: the same sink and the same two
// inputs, through `resolveDispatchTarget` and through both plan gates, compared
// verdict for verdict rather than each against a constant.

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  boundedText,
  defineAtomicPattern,
  dispatchEnvelopeShape,
  isDispatchError,
  PatternRegistry,
  resolveDispatchTarget,
  silentDiagnosticsLogger,
  type ExecutionContext,
  type Pattern,
  type PatternId,
  type PatternRef,
} from '@orchestral/core'

import { runPlan } from '../interpreter'
import type { PlanDag } from '../plan'
import { validatePlan, type PlanPatternLookup } from '../validate'

const producer = defineAtomicPattern({
  id: 'producer',
  description: 'Emits text and a settings object for the sink to read.',
  primary: {
    tool: { description: 'Produce.', inputs: z.object({ prompt: z.string().min(1) }) },
    modelTags: [],
  },
  outputs: z.object({
    modality: z.literal('text'),
    text: boundedText(1_024),
    settings: z.object({ label: z.string().optional() }),
    ...dispatchEnvelopeShape,
  }),
})

const sink = defineAtomicPattern({
  id: 'sink',
  description: 'A strict input schema with one required field and one nested one.',
  // Visible to the audience the parity case dispatches as, so the dispatch
  // path's exposure gate passes and its input parse is what gets compared.
  exposure: { agentLoop: true },
  primary: {
    tool: {
      description: 'Consume.',
      inputs: z.strictObject({
        prompt: z.string().min(1),
        settings: z.object({ label: z.string() }).optional(),
      }),
    },
    modelTags: [],
  },
  outputs: z.object({
    modality: z.literal('text'),
    text: boundedText(1_024),
    ...dispatchEnvelopeShape,
  }),
})

const byId = new Map<string, Pattern>([
  [producer.id, producer as unknown as Pattern],
  [sink.id, sink as unknown as Pattern],
])
const lookup: PlanPatternLookup = {
  get: (id) => byId.get(id),
  getEntry: (id) => {
    const pattern = byId.get(id)
    return pattern === undefined ? undefined : { pattern, alternatives: [] }
  },
}

function sinkPlan(input: Record<string, unknown>): PlanDag {
  return {
    steps: [
      { id: 'make', pattern: 'producer', input: { prompt: 'seed text' } },
      { id: 'use', pattern: 'sink', input },
    ],
    output: { values: { out: '$use.text' } },
  }
}

/**
 * Just enough of a meta's context for `runPlan`: a `ctx.step` that records what
 * it was asked to dispatch and answers from a table. No runtime — the gate
 * under test runs before the dispatch, so there is nothing downstream to prove.
 */
function fakeCtx(outputs: Record<string, unknown>) {
  const dispatched: PatternRef[] = []
  const ctx = {
    assets: [],
    step: {
      withMeta: async (ref: PatternRef) => {
        dispatched.push(ref)
        return { value: outputs[ref.patternId] }
      },
    },
  } as unknown as ExecutionContext
  return { ctx, dispatched }
}

const PRODUCED = {
  producer: { modality: 'text', text: 'made', settings: {} },
  sink: { modality: 'text', text: 'used' },
}

const selfId = 'plan-under-test' as PatternId

describe('the step-input gate, layer 1 (validatePlan)', () => {
  it('lets keys the schema does not declare through a strict schema', () => {
    const problems = validatePlan(
      sinkPlan({ prompt: '$make.text', seed: 7, providerOptions: { quality: 'hd' } }),
      lookup,
      {},
    )
    expect(problems).toEqual([])
  })

  it('still refuses a missing required key', () => {
    const problems = validatePlan(sinkPlan({ seed: 7 }), lookup, {})
    const invalid = problems.filter((p) => p.code === 'PLAN_STEP_INPUT_INVALID')
    expect(invalid).toHaveLength(1)
    expect(invalid[0]!.stepId).toBe('use')
    expect(invalid[0]!.message).toMatch(/prompt/)
  })
})

describe('the step-input gate, layer 2 (runPlan, after substitution)', () => {
  it('lets undeclared keys through to the dispatch, untouched', async () => {
    const { ctx, dispatched } = fakeCtx(PRODUCED)
    const result = await runPlan(
      sinkPlan({ prompt: '$make.text', seed: 7, providerOptions: { quality: 'hd' } }),
      lookup,
      { selfId },
      {},
      ctx,
    )

    expect(result.values).toEqual({ out: 'used' })
    const use = dispatched.find((ref) => ref.patternId === 'sink')
    expect(use?.input).toEqual({
      prompt: 'made',
      seed: 7,
      providerOptions: { quality: 'hd' },
    })
  })

  it('refuses a required key the substituted value is missing, before dispatch', async () => {
    // Layer 1 cannot see this one: `settings` is a `$ref`, so its type only
    // exists after substitution and rule 21 suppresses issues landing on it.
    // The producer's `settings` arrives without `label`, which the sink requires.
    const dag = sinkPlan({ prompt: 'p', settings: '$make.settings' })
    expect(validatePlan(dag, lookup, {})).toEqual([])

    const { ctx, dispatched } = fakeCtx(PRODUCED)
    await expect(runPlan(dag, lookup, { selfId }, {}, ctx)).rejects.toMatchObject({
      code: 'PLAN_STEP_INPUT_INVALID',
      details: { planStepId: 'use' },
    })
    expect(dispatched.map((ref) => ref.patternId)).toEqual(['producer'])
  })
})

describe('the dispatch path both layers mirror (core’s resolveDispatchTarget)', () => {
  it('reaches the verdict both plan gates reach, on the same sink and the same two inputs', async () => {
    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    registry.register(sink as unknown as Pattern)

    const inputs: Record<string, Record<string, unknown>> = {
      'undeclared keys': { prompt: 'made', seed: 7, providerOptions: { quality: 'hd' } },
      'a missing required key': { seed: 7 },
    }
    const shapeOf = (issues: readonly { code: string; path: readonly PropertyKey[] }[]) =>
      issues.map(({ code, path }) => ({ code, path: [...path] }))
    // The sink alone, fed a literal: the input a gate sees is exactly the one
    // the dispatch is sent, with no upstream step for the walk to object to.
    const sinkOnly = (input: Record<string, unknown>): PlanDag => ({
      steps: [{ id: 'use', pattern: 'sink', input }],
      output: { values: { out: '$use.text' } },
    })

    for (const [name, input] of Object.entries(inputs)) {
      const dispatch = resolveDispatchTarget(
        registry,
        { pattern_id: 'sink', input },
        'agent-loop',
      )
      const layer1 = validatePlan(sinkOnly(input), lookup, {})
      // runPlan is layer 1 again and then layer 2. A missing key can only come
      // from the literal — substitution never deletes one — so on that input
      // its refusal is its own layer-1 pass; layer 2 refusing a substituted
      // value is the case further up.
      const { ctx, dispatched } = fakeCtx(PRODUCED)
      const ran = await runPlan(sinkOnly(input), lookup, { selfId }, {}, ctx).then(
        () => true,
        () => false,
      )
      const sent = dispatched.find((ref) => ref.patternId === 'sink')?.input

      if (isDispatchError(dispatch)) {
        expect(dispatch.code, name).toBe('INPUT_VALIDATION_FAILED')
        const issues = (dispatch as { issues: readonly z.core.$ZodIssue[] }).issues
        expect(layer1.map((p) => p.code), name).toEqual(['PLAN_STEP_INPUT_INVALID'])
        const planIssues = layer1[0]!.details?.issues as readonly z.core.$ZodIssue[]
        expect(shapeOf(planIssues), name).toEqual(shapeOf(issues))
        expect(ran, name).toBe(false)
        expect(sent, name).toBeUndefined()
      } else {
        expect(layer1, name).toEqual([])
        expect(ran, name).toBe(true)
        // What the plan hands `ctx.step` is what the dispatch would have
        // parsed out of it: the passthrough kept the same keys on both sides.
        expect(sent, name).toEqual(dispatch.parsedInput)
      }
    }
  })
})
