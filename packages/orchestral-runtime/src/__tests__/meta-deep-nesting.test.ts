// step-cache namespace isolation across three levels of nested meta — runtime
// regression.
//
// meta-nested-stepid-namespace.test.ts pins the parent → child pair: when the
// same child meta runs twice, its fixed explicit stepIds must not collide and
// its stepCache entries must not cross-contaminate. This file pushes that to a
// third level (grandchild), because the namespace prefix is assembled
// RECURSIVELY — a child meta hands its own step's effectiveStepId down as the
// grandchild's stepIdNamespace (dispatchMeta passes spec.stepIdNamespace into
// buildMetaExecutionContext, and ctx.step then stamps effectiveStepId onto the
// child spec). If the prefix only takes effect one level deep, grandchild steps
// under sibling children hit each other in the grandparent's shared stepCache —
// silent cross-contamination.
//
// Shape: meta_parent --[child-0, child-1]--> meta_child --[gc-0, gc-1]-->
//        meta_grandchild --[gc-step]--> fake-image
// 2×2×1 = 4 image calls in total, each with a unique prompt and a unique
// assetId. A namespace break at any level short-circuits a later grandchild
// step onto the previous one's cache entry → fewer than 4 calls.

import { describe, expect, it } from 'vitest'

import type {
  AtomicPattern,
  CapabilityRouter,
  MetaPattern,
  ModelCapability,
} from '@orchestral/core'
import { InMemoryJobStore as MemoryJobStore, PatternRegistry } from '@orchestral/core'
import { z } from 'zod'

import { InlineRuntime } from '../inline'

// Fake atomic "image" capability — each call returns a UNIQUE id so a cache hit
// (cross-contamination) is observable: a reused cached result keeps the serial
// from advancing.
function makeImageRouter(calls: Array<{ prompt: string }>): CapabilityRouter {
  let serial = 0
  const cap: ModelCapability = {
    modelId: 'fake:img',
    provider: 'fake',
    tags: [],
    capabilities: ['fake-image'],
    inputs: ['text'],
    outputs: ['image'],
    source: 'user',
    async call(input: unknown) {
      const inp = input as { prompt?: string }
      calls.push({ prompt: inp.prompt ?? '' })
      const id = serial++
      return {
        output: {
          modality: 'image',
          assetId: `img-${id}`,
          prompt: inp.prompt ?? '',
        },
      } as unknown
    },
  } as unknown as ModelCapability

  return {
    checkSatisfiable: () => ({ ok: true, candidates: [cap] }),
    resolve: () => cap,
  } as unknown as CapabilityRouter
}

function createFakeImagePattern(): AtomicPattern<{ prompt: string }, unknown> {
  return {
    id: 'fake-image',
    kind: 'atomic',
    description: 'fake image gen for deep-nesting test',
    outputs: z.any() as never,
    primary: {
      tool: { description: 'fake', inputs: z.object({ prompt: z.string() }) },
      modelTags: [],
    },
  }
}

// ── Level 3: grandchild meta — one fixed-id step into the atomic image gen.
//    The 'gc-step' id is identical across every grandchild instance; only the
//    recursive namespace prefix keeps the four of them apart.
function createGrandchildMeta(): MetaPattern<{ prompt: string }, { assetId: string }> {
  return {
    id: 'meta_grandchild',
    kind: 'meta',
    description: 'grandchild — one fixed-id image step',
    outputs: z.any() as never,
    tool: { description: 'gc', inputs: z.object({ prompt: z.string() }) },
    async compose({ input }, ctx) {
      const img = await ctx.step<{ assetId: string }>(
        { patternId: 'fake-image', input: { prompt: `gc:${input.prompt}` } },
        { stepId: 'gc-step' },
      )
      return { assetId: img.assetId }
    },
  }
}

// ── Level 2: child meta — dispatches the grandchild twice with fixed stepIds.
function createChildMeta(): MetaPattern<{ prompt: string }, { a: string; b: string }> {
  return {
    id: 'meta_child',
    kind: 'meta',
    description: 'child — two grandchild dispatches',
    outputs: z.any() as never,
    tool: { description: 'child', inputs: z.object({ prompt: z.string() }) },
    async compose({ input }, ctx) {
      const r0 = await ctx.step<{ assetId: string }>(
        { patternId: 'meta_grandchild', input: { prompt: `${input.prompt}-0` } },
        { stepId: 'gc-0' },
      )
      const r1 = await ctx.step<{ assetId: string }>(
        { patternId: 'meta_grandchild', input: { prompt: `${input.prompt}-1` } },
        { stepId: 'gc-1' },
      )
      return { a: r0.assetId, b: r1.assetId }
    },
  }
}

// ── Level 1: parent meta — dispatches the child twice with fixed stepIds.
//    Mirrors the storyboard → image-best-of-n × N_panels shape.
function createParentMeta(): MetaPattern<
  Record<string, never>,
  { p0: { a: string; b: string }; p1: { a: string; b: string } }
> {
  return {
    id: 'meta_parent',
    kind: 'meta',
    description: 'parent — two child dispatches',
    outputs: z.any() as never,
    tool: { description: 'parent', inputs: z.object({}) },
    async compose(_params, ctx) {
      const p0 = await ctx.step<{ a: string; b: string }>(
        { patternId: 'meta_child', input: { prompt: 'scene-0' } },
        { stepId: 'child-0' },
      )
      const p1 = await ctx.step<{ a: string; b: string }>(
        { patternId: 'meta_child', input: { prompt: 'scene-1' } },
        { stepId: 'child-1' },
      )
      return { p0, p1 }
    },
  }
}

function makeRuntime(calls: Array<{ prompt: string }>): InlineRuntime {
  const registry = new PatternRegistry()
  registry.add(createFakeImagePattern() as never)
  registry.add(createGrandchildMeta() as never)
  registry.add(createChildMeta() as never)
  registry.add(createParentMeta() as never)
  return new InlineRuntime({
    router: makeImageRouter(calls),
    registry,
    store: new MemoryJobStore() as never,
  })
}

describe('meta step-cache — three-level nesting', () => {
  it('does not crash DUPLICATE_STEP_ID with three levels of fixed-id steps', async () => {
    const calls: Array<{ prompt: string }> = []
    const runtime = makeRuntime(calls)

    const job = await runtime.submitJob({
      patternId: 'meta_parent',
      input: {},
    } as never)

    // A broken recursive prefix would collide 'gc-step' (or 'gc-0'/'gc-1')
    // across sibling subtrees and reject with DUPLICATE_STEP_ID.
    expect(job.status).toBe('done')
    expect(job.error).toBeNull()
  })

  it('each grandchild gets its own model call — no cross-level cache sharing', async () => {
    const calls: Array<{ prompt: string }> = []
    const runtime = makeRuntime(calls)

    await runtime.submitJob({ patternId: 'meta_parent', input: {} } as never)

    // 2 children × 2 grandchildren × 1 image = 4. If the namespace prefix only
    // applied one level, the second child's grandchildren would hit the first
    // child's cached 'gc-step' result → fewer than 4 calls.
    expect(calls).toHaveLength(4)

    const prompts = calls.map((c) => c.prompt)
    expect(prompts).toEqual([
      'gc:scene-0-0',
      'gc:scene-0-1',
      'gc:scene-1-0',
      'gc:scene-1-1',
    ])
    expect(new Set(prompts).size).toBe(4)
  })

  it('output assetIds are all distinct — no aliasing from a shared cache slot', async () => {
    const calls: Array<{ prompt: string }> = []
    const runtime = makeRuntime(calls)

    const job = await runtime.submitJob({
      patternId: 'meta_parent',
      input: {},
    } as never)

    const out = job.output as unknown as {
      p0: { a: string; b: string }
      p1: { a: string; b: string }
    }

    const all = [out.p0.a, out.p0.b, out.p1.a, out.p1.b]
    expect(all).toEqual(['img-0', 'img-1', 'img-2', 'img-3'])
    expect(new Set(all).size).toBe(4)
  })
})
