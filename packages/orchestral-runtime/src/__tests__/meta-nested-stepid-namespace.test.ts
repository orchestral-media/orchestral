// False stepId collision between nested metas of the same type — runtime regression.
//
// Repro of the meta_storyboard × bestOfN crash: a parent meta dispatches the
// SAME child meta type twice (panel-0, panel-1). The child meta inherits the
// parent's shared MetaSharedState and internally uses FIXED explicit stepIds
// (`candidate-0`, `candidate-1`, like image-best-of-n). Before the stepId
// namespace fix:
//   • panel-0's child registered `candidate-0` into the shared `stepIds` set;
//   • panel-1's child tried to register `candidate-0` again → DUPLICATE_STEP_ID.
// And even if dedup were skipped, the shared `stepCache` (keyed by stepId)
// would let panel-1's `candidate-0` hit panel-0's cached result — silent
// cross-contamination, worse than the crash.
//
// The fix stamps each child meta with the parent step's EFFECTIVE stepId as a
// stepId namespace, so `candidate-0` becomes `panel-0/candidate-0` vs
// `panel-1/candidate-0` — distinct dedup keys + distinct cache slots.
//
// Built over a real InlineRuntime (mirrors meta-dispatch-e2e.test.ts) so the
// `submitChild → _submitJobInternal → dispatch → dispatchMeta` namespace
// threading is exercised end-to-end, not faked at the ctx layer.

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

// ── Fake atomic "image" capability — each call returns a UNIQUE id so a cache
//    hit (cross-contamination) is observable: if panel-1's candidate-0 reuses
//    panel-0's cached result, its serial won't advance.
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
          // Unique per call — distinct outputs prove no cache sharing.
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

// ── Fake atomic pattern the inner meta dispatches. ─────────────────────────
function createFakeImagePattern(): AtomicPattern<{ prompt: string }, unknown> {
  return {
    id: 'fake-image',
    kind: 'atomic',
    description: 'fake image gen for namespace test',
    outputs: z.any() as never,
    primary: {
      tool: { description: 'fake', inputs: z.object({ prompt: z.string() }) },
      modelTags: [],
    },
  }
}

// ── Child meta — mirrors image-best-of-n: two inner steps with FIXED explicit
//    stepIds, plus a ctx.compute with a FIXED id (mirrors script2video's
//    `concat-final-video`). Returns the produced assetIds + the compute result
//    so the parent can assert both channels stay independent across panels.
//
// `computeRuns` is a shared probe: every panel's compute fn pushes its own
// prompt. Before the compute-namespace fix, panel-1's `concat` short-circuits
// on panel-0's cached value → the fn never runs for panel-1 → only ONE entry
// and panel-1 reports panel-0's concat (silent cross-contamination).
function createChildMeta(
  computeRuns: string[],
): MetaPattern<{ prompt: string }, { candidates: string[]; concat: string }> {
  return {
    id: 'meta_child',
    kind: 'meta',
    description: 'fake best-of-n — two candidates + a fixed-id compute',
    outputs: z.any() as never,
    tool: {
      description: 'child',
      inputs: z.object({ prompt: z.string() }),
    },
    async compose({ input }, ctx) {
      const a = await ctx.step<{ assetId: string }>(
        { patternId: 'fake-image', input: { prompt: `${input.prompt} #0` } },
        { stepId: 'candidate-0' },
      )
      const b = await ctx.step<{ assetId: string }>(
        { patternId: 'fake-image', input: { prompt: `${input.prompt} #1` } },
        { stepId: 'candidate-1' },
      )
      // Fixed compute id across panels — the script2video `concat-final-video`
      // shape. The closure result is derived from THIS panel's prompt so a
      // stale cache hit is observable.
      const concat = await ctx.compute('concat', async () => {
        computeRuns.push(input.prompt)
        return `concat(${input.prompt})`
      })
      return { candidates: [a.assetId, b.assetId], concat }
    },
  }
}

// ── Parent meta — mirrors storyboard: dispatches the SAME child meta twice
//    with panel-0 / panel-1 stepIds.
function createParentMeta(): MetaPattern<
  Record<string, never>,
  { panels: string[][]; concats: string[] }
> {
  return {
    id: 'meta_parent',
    kind: 'meta',
    description: 'fake storyboard — two panels, each a child meta',
    outputs: z.any() as never,
    tool: { description: 'parent', inputs: z.object({}) },
    async compose(_params, ctx) {
      const panel0 = await ctx.step<{ candidates: string[]; concat: string }>(
        { patternId: 'meta_child', input: { prompt: 'panel 0 scene' } },
        { stepId: 'panel-0' },
      )
      const panel1 = await ctx.step<{ candidates: string[]; concat: string }>(
        { patternId: 'meta_child', input: { prompt: 'panel 1 scene' } },
        { stepId: 'panel-1' },
      )
      return {
        panels: [panel0.candidates, panel1.candidates],
        concats: [panel0.concat, panel1.concat],
      }
    },
  }
}

function makeRuntime(
  calls: Array<{ prompt: string }>,
  computeRuns: string[] = [],
): InlineRuntime {
  const registry = new PatternRegistry()
  registry.add(createFakeImagePattern() as never)
  registry.add(createChildMeta(computeRuns) as never)
  registry.add(createParentMeta() as never)
  return new InlineRuntime({
    router: makeImageRouter(calls),
    registry,
    store: new MemoryJobStore() as never,
  })
}

describe('nested same-type meta — explicit stepId namespace', () => {
  it('does not crash DUPLICATE_STEP_ID when the same child meta runs twice with fixed explicit stepIds', async () => {
    const calls: Array<{ prompt: string }> = []
    const runtime = makeRuntime(calls)

    const job = await runtime.submitJob({
      patternId: 'meta_parent',
      input: {},
    } as never)

    // Before the fix this rejected with DUPLICATE_STEP_ID (panel-1's
    // candidate-0 collided with panel-0's in the shared stepIds set).
    expect(job.status).toBe('done')
    expect(job.error).toBeNull()
  })

  it('does not cross-contaminate the stepCache — each panel gets independent candidate outputs', async () => {
    const calls: Array<{ prompt: string }> = []
    const runtime = makeRuntime(calls)

    const job = await runtime.submitJob({
      patternId: 'meta_parent',
      input: {},
    } as never)

    const out = job.output as unknown as { panels: string[][] }

    // 4 distinct fake-image calls — panel-0/candidate-0, panel-0/candidate-1,
    // panel-1/candidate-0, panel-1/candidate-1. If the cache key weren't
    // namespaced, panel-1's candidate-0 would short-circuit on panel-0's
    // cached result and this would be 2 (or 3) calls.
    expect(calls).toHaveLength(4)

    // Each panel sees its OWN prompts reach the model (no stale cache).
    expect(calls.map((c) => c.prompt)).toEqual([
      'panel 0 scene #0',
      'panel 0 scene #1',
      'panel 1 scene #0',
      'panel 1 scene #1',
    ])

    // Produced assetIds are all distinct — panel-1's candidate-0 is `img-2`,
    // NOT panel-0's `img-0`. A shared cache slot would alias them.
    const allAssets = out.panels.flat()
    expect(allAssets).toEqual(['img-0', 'img-1', 'img-2', 'img-3'])
    expect(new Set(allAssets).size).toBe(4)
  })

  it('namespaces ctx.compute cache keys too — a fixed compute id does not cross-contaminate across panels', async () => {
    // The nested-meta bug (a storyboard fanning meta_image-best-of-n out per
    // panel): each nested meta calls ctx.compute('…', …) with a FIXED id. Sharing one
    // stepCache across panels, panel-1's `concat` would short-circuit on
    // panel-0's cached value (compute, unlike step, has no dedup-set guard to
    // even surface the collision) → panel-1 silently returns panel-0's concat.
    // The namespace fix prefixes the compute key with the parent step's
    // effective id (panel-0/concat vs panel-1/concat).
    const calls: Array<{ prompt: string }> = []
    const computeRuns: string[] = []
    const runtime = makeRuntime(calls, computeRuns)

    const job = await runtime.submitJob({
      patternId: 'meta_parent',
      input: {},
    } as never)

    const out = job.output as unknown as {
      panels: string[][]
      concats: string[]
    }

    // Both panels' compute fns actually ran (no stale cache hit). Before the
    // fix this was length 1 — panel-1's compute never executed.
    expect(computeRuns).toEqual(['panel 0 scene', 'panel 1 scene'])

    // Each panel reports ITS OWN concat, not panel-0's for both.
    expect(out.concats).toEqual([
      'concat(panel 0 scene)',
      'concat(panel 1 scene)',
    ])
  })
})
