// The one-shot under the derived `name`, pinned from the outside.
//
// Registration appends `name` to every Pattern whose outputs carry assets[],
// and `meta_plan`'s outputs are PlanOutputSchema, which does. Its input IS the
// DAG, though, and the DAG schema is strict at both places it is read: the
// refine on `tool.inputs` and `runPlan` inside compose. So `createPlanMeta`
// reads its DAG as the input minus both reserved keys, and these cases hold it
// to that through the registry and the dispatch path a model actually takes.
//
// `planToMeta` is the contrast: its input is the plan's parameters, not the
// DAG, so a name there is one more parameter nothing reads, and an author's
// DAG handed straight to `validatePlan` still may not carry one.

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  boundedText,
  defineAtomicPattern,
  dispatchEnvelopeShape,
  isDispatchError,
  PatternRegistry,
  producedAssetShape,
  RESERVED_INPUT_KEYS,
  resolveDispatchTarget,
  silentDiagnosticsLogger,
  type ExecutionContext,
  type MetaPattern,
  type Pattern,
  type PatternId,
  type PatternRef,
} from '@orchestral/core'

import { createPlanMeta, planToMeta } from '../interpreter'
import type { PlanDag, PlanOutput } from '../plan'
import { validatePlan } from '../validate'

// @orchestral/patterns depends on this package, so the real atomics would be a
// cycle. These stubs carry what the walk and the registry read: the input
// schema, and whether the outputs carry assets[].
const textGenerationStub = defineAtomicPattern({
  id: 'text-generation',
  description: 'Generate text.',
  primary: {
    tool: {
      description: 'One-shot completion.',
      inputs: z.object({ prompt: z.string().min(1, 'prompt required') }),
    },
    modelTags: [],
  },
  outputs: z.object({
    modality: z.literal('text'),
    text: boundedText(65_536),
    ...dispatchEnvelopeShape,
  }),
})

const textToImageStub = defineAtomicPattern({
  id: 'text-to-image',
  description: 'Render an image from a prompt.',
  primary: {
    tool: {
      description: 'Render an image.',
      inputs: z.object({ prompt: z.string().min(1, 'prompt required') }),
    },
    modelTags: [],
  },
  outputs: z.object({
    modality: z.literal('image'),
    assets: z.array(z.object(producedAssetShape('image'))),
    ...dispatchEnvelopeShape,
  }),
})

/** The atomics a two-step DAG names, then `meta_plan` over the same registry. */
function registryWithMetaPlan(): PatternRegistry {
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  registry.register(textGenerationStub as unknown as Pattern)
  registry.register(textToImageStub as unknown as Pattern)
  registry.register(
    createPlanMeta({ getPattern: (id) => registry.get(id) }) as unknown as Pattern,
  )
  return registry
}

function validDag(): PlanDag {
  return {
    steps: [
      { id: 'describe', pattern: 'text-generation', input: { prompt: 'a red bicycle' } },
      { id: 'render', pattern: 'text-to-image', input: { prompt: '$describe.text' } },
    ],
    output: { assets: [{ from: '$render.assets[0]', label: 'still' }] },
  }
}

/**
 * The fake context the plan tests use: a `ctx.step` that records what it was
 * asked to dispatch and answers from a table. No runtime.
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
  'text-generation': { modality: 'text', text: 'a red bicycle at dawn' },
  'text-to-image': { modality: 'image', assets: [{ assetId: 'asset-1', modality: 'image' }] },
}

type IssueView = { path: PropertyKey[]; code: string; params?: { code?: string } }

describe('meta_plan under the derived name', () => {
  it('a registered meta_plan exposes name and accepts a named DAG', () => {
    const registry = registryWithMetaPlan()
    const inputs = (registry.get('meta_plan' as PatternId) as MetaPattern).tool
      .inputs as unknown as z.ZodObject
    expect(Object.keys(inputs.shape)).toContain('name')

    const result = resolveDispatchTarget(
      registry,
      {
        pattern_id: 'meta_plan',
        input: { ...validDag(), name: 'storyboard' } as unknown as Record<string, unknown>,
      },
      'agent-loop',
    )
    if (isDispatchError(result)) {
      expect.unreachable(`refused: ${JSON.stringify(result)}`)
    }
    expect(result.parsedInput.name).toBe('storyboard')
  })

  it('a mint-grammar name on meta_plan is an input issue at path name, not a PLAN_SCHEMA problem', () => {
    const registry = registryWithMetaPlan()
    const result = resolveDispatchTarget(
      registry,
      {
        pattern_id: 'meta_plan',
        input: { ...validDag(), name: 'image_3' } as unknown as Record<string, unknown>,
      },
      'agent-loop',
    )
    expect(result).toMatchObject({ code: 'INPUT_VALIDATION_FAILED' })
    const issues = (result as { issues: readonly IssueView[] }).issues
    expect(
      issues.map((i) => ({ path: [...i.path], code: i.code, plan: i.params?.code })),
    ).toEqual([{ path: ['name'], code: 'custom', plan: undefined }])
  })

  it('compose runs the DAG without the reserved keys', async () => {
    const registry = registryWithMetaPlan()
    const metaPlan = registry.get('meta_plan' as PatternId) as MetaPattern<
      Record<string, unknown>,
      PlanOutput
    >
    const extras: Record<string, unknown>[] = [
      { name: 'storyboard' },
      { references: { hero: 'image_1' } },
      { name: 'storyboard', references: { hero: 'image_1' } },
    ]
    // Every reserved key is covered, so the cases move with the list.
    expect(new Set(extras.flatMap((e) => Object.keys(e)))).toEqual(
      new Set(RESERVED_INPUT_KEYS),
    )
    for (const extra of extras) {
      const input = { ...validDag(), ...extra }
      const { ctx, dispatched } = fakeCtx(PRODUCED)
      // runPlan validates its DAG against the strict PlanDagSchema first: had
      // either key reached it, this would reject with PLAN_INVALID
      // (PLAN_SCHEMA, unrecognized_keys) before dispatching anything.
      const out = await metaPlan.compose({ input }, ctx)
      expect(dispatched.map((ref) => ref.patternId), JSON.stringify(extra)).toEqual([
        'text-generation',
        'text-to-image',
      ])
      expect(out.assets.map((a) => a.assetId)).toEqual(['asset-1'])
      // Read without, never rewritten: the caller's input keeps its keys.
      expect(input).toMatchObject(extra)
    }
  })

  it('validatePlan still refuses a top-level name in an author DAG', () => {
    const registry = registryWithMetaPlan()
    const dag = { ...validDag(), name: 'storyboard' } as unknown as PlanDag
    const problems = validatePlan(dag, registry, {})
    expect(problems.map((p) => p.code)).toEqual(['PLAN_SCHEMA'])
    expect(problems[0]!.details?.issue).toMatchObject({
      code: 'unrecognized_keys',
      keys: ['name'],
    })
  })

  it('a registered planToMeta plan accepts a name in its parameters', async () => {
    const registry = registryWithMetaPlan()
    const dag: PlanDag = {
      steps: [
        { id: 'describe', pattern: 'text-generation', input: { prompt: '$input.prompt' } },
        { id: 'render', pattern: 'text-to-image', input: { prompt: '$describe.text' } },
      ],
      output: { assets: [{ from: '$render.assets[0]', label: 'still' }] },
    }
    registry.register(
      planToMeta(dag, {
        id: 'meta_still' as PatternId,
        lookup: registry,
        inputs: z.object({ prompt: z.string().min(1) }),
        exposure: 'tool',
      }) as unknown as Pattern,
    )

    const result = resolveDispatchTarget(
      registry,
      { pattern_id: 'meta_still', input: { prompt: 'a red bicycle', name: 'storyboard' } },
      'agent-loop',
    )
    if (isDispatchError(result)) {
      expect.unreachable(`refused: ${JSON.stringify(result)}`)
    }
    expect(result.parsedInput).toEqual({ prompt: 'a red bicycle', name: 'storyboard' })

    // The name rides into runPlan as one more parameter, and nothing reads it.
    const plan = result.pattern as MetaPattern<Record<string, unknown>, PlanOutput>
    const { ctx, dispatched } = fakeCtx(PRODUCED)
    const out = await plan.compose({ input: result.parsedInput }, ctx)
    expect(dispatched.map((ref) => ref.input)).toEqual([
      { prompt: 'a red bicycle' },
      { prompt: 'a red bicycle at dawn' },
    ])
    expect(out.assets.map((a) => a.assetId)).toEqual(['asset-1'])
  })
})
