// The options a plan step is dispatched with, pinned from the outside.
//
// `runPlan` owns the `ctx.step` call, so a plan author never writes these: the
// interpreter does, and what it writes is the whole of how a plan step is
// identified. A step's durable row is keyed by its path in the dispatch tree,
// and a plan step's segment of that path is its DAG id — so `stepId` is the
// one thing the interpreter has to say. There is no mode to choose alongside
// it; anything more in the options would be a second, unasked-for answer to
// "which row is this".
//
// The fake context records `(ref, options)` and answers from a table, as the
// other plan tests' fakes do. No runtime: what is under test is the call the
// interpreter makes, not what the engine does with it.

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  defineAtomicPattern,
  dispatchEnvelopeShape,
  PatternRegistry,
  producedAssetShape,
  silentDiagnosticsLogger,
  type ExecutionContext,
  type Pattern,
  type PatternId,
  type PatternRef,
  type StepOptions,
} from '@orchestral/core'

import { runPlan } from '../interpreter'
import type { PlanDag, PlanRetry } from '../plan'

// @orchestral/patterns depends on this package, so the real atomic would be a
// cycle. The stub carries what the walk reads: the input schema, and outputs
// that carry assets[] for the plan's output to take one from.
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

function lookup(): PatternRegistry {
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  registry.register(textToImageStub as unknown as Pattern)
  return registry
}

function renderPlan(retry?: PlanRetry): PlanDag {
  return {
    steps: [
      {
        id: 'render',
        pattern: 'text-to-image',
        input: { prompt: 'a red bicycle' },
        ...(retry !== undefined ? { retry } : {}),
      },
    ],
    output: { assets: [{ from: '$render.assets[0]', label: 'still' }] },
  }
}

/** A `ctx.step` that records every `(ref, options)` it is handed. */
function fakeCtx() {
  const calls: { ref: PatternRef; options: StepOptions | undefined }[] = []
  const ctx = {
    assets: [],
    step: {
      withMeta: async (ref: PatternRef, options?: StepOptions) => {
        calls.push({ ref, options })
        return {
          value: { modality: 'image', assets: [{ assetId: 'asset-1', modality: 'image' }] },
        }
      },
    },
  } as unknown as ExecutionContext
  return { ctx, calls }
}

const selfId = 'plan-under-test' as PatternId

describe('the options runPlan hands ctx.step', () => {
  it('a plan step is dispatched under its id and nothing else picks its identity', async () => {
    const plain = fakeCtx()
    await runPlan(renderPlan(), lookup(), { selfId }, {}, plain.ctx)
    expect(plain.calls.map((c) => c.ref.patternId)).toEqual(['text-to-image'])
    expect(plain.calls[0]!.options).toEqual({ stepId: 'render' })

    // The step's retry rides along, and still nothing beside the id says which
    // row the dispatch lands on.
    const retry: PlanRetry = { kind: 'fixed', maxAttempts: 2, delayMs: 0 }
    const retried = fakeCtx()
    await runPlan(renderPlan(retry), lookup(), { selfId }, {}, retried.ctx)
    expect(retried.calls).toHaveLength(1)
    expect(retried.calls[0]!.options).toEqual({ stepId: 'render', retry })
  })
})
