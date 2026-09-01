// The three things a plan gained beyond "walk a DAG": media from its caller,
// a durable identity its caller decides, and a bound on how wide a level runs.
//
// Same harness as meta-plan.test.ts — the real runtime, the real store, the
// real router, four mocked model envelopes — because every claim below is a
// claim about the interpreter PLUS the engine underneath it. Whether an asset
// reached a step is a question about `ctx.assets` on the model call; whether a
// row was reused is a question about how often a model was reached at all.

import type {
  AssetNeed,
  Pattern,
  PatternId,
  ResolvedAssetRef,
} from '@orchestral/core'
import { createPlanMeta, planToMeta, type PlanOutput } from '@orchestral/plan'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { makePlanHost, type PlanHost } from './helpers/plan-host'

// ── caller-supplied media ───────────────────────────────────────────────

const STILL_NEEDS = [
  { slot: 'still', modality: 'image', cardinality: 'single', required: true },
  { slot: 'tail', modality: 'image', cardinality: 'single', required: false },
] as const satisfies readonly AssetNeed[]

/** Animate an image the CALLER supplied — no step produces it. */
const ANIMATE_CALLER_STILL = {
  description: 'Animate the image the caller passed in.',
  steps: [
    {
      id: 'animate',
      pattern: 'image-to-video',
      input: { prompt: '$input.motion' },
      assets: { startFrame: '$input.assets[slot=still]' },
    },
  ],
  output: { assets: [{ from: '$animate.assets[0]', label: 'clip' }] },
} as const

const FRAMES_NEEDS = [
  { slot: 'frames', modality: 'image', cardinality: 'array', required: true },
] as const satisfies readonly AssetNeed[]

/** Read several caller images through ONE ref — the array slot fans in. */
const READ_CALLER_FRAMES = {
  description: 'Describe every image the caller passed in.',
  steps: [
    {
      id: 'read',
      pattern: 'image-to-text',
      input: { prompt: 'compare these' },
      assets: { source: '$input.assets[slot=frames]' },
    },
  ],
  output: { values: { text: '$read.text' } },
} as const

function asset(
  slot: string,
  assetId: string,
  handle?: string,
): ResolvedAssetRef {
  return {
    slot,
    assetId,
    modality: 'image',
    ...(handle !== undefined ? { handle } : {}),
  }
}

function mediaHost(): PlanHost {
  const h = makePlanHost()
  h.registry.register(
    planToMeta(ANIMATE_CALLER_STILL as never, {
      id: 'meta_animate-still' as PatternId,
      lookup: h.registry,
      inputs: z.object({ motion: z.string().min(1).max(500) }),
      assetNeeds: STILL_NEEDS,
      exposure: 'tool',
    }),
  )
  h.registry.register(
    planToMeta(READ_CALLER_FRAMES as never, {
      id: 'meta_read-frames' as PatternId,
      lookup: h.registry,
      assetNeeds: FRAMES_NEEDS,
      exposure: 'tool',
    }),
  )
  return h
}

describe('a plan that takes media from its caller', () => {
  it('declares assetNeeds on the pattern, so a host resolves for it like any other', () => {
    const h = mediaHost()
    const pattern = h.registry.get('meta_animate-still' as PatternId)
    expect(pattern?.assetNeeds).toEqual(STILL_NEEDS)
  })

  it('derives the references field onto tool.inputs, keeping the plan’s own params', () => {
    const h = mediaHost()
    const pattern = h.registry.get('meta_animate-still' as PatternId)
    const shape = (pattern as unknown as { tool: { inputs: z.ZodObject } }).tool.inputs
      .shape
    expect(Object.keys(shape).sort()).toEqual(['motion', 'references'])
  })

  it('a parameterless plan still gets references when it declares slots', () => {
    const h = mediaHost()
    const pattern = h.registry.get('meta_read-frames' as PatternId)
    const shape = (pattern as unknown as { tool: { inputs: z.ZodObject } }).tool.inputs
      .shape
    expect(Object.keys(shape)).toEqual(['references'])
  })

  it('threads the caller’s asset into the step’s slot, source handle and all', async () => {
    const h = mediaHost()
    const run = await h.run<PlanOutput>(
      'meta_animate-still' as PatternId,
      { motion: 'slow pan' },
      'session-media',
      [asset('still', 'caller-asset-1', 'image_1')],
    )

    expect(run.job.error).toBeNull()
    expect(run.job.status).toBe('done')

    // What the MODEL saw: re-slotted from the plan's `still` onto the child's
    // `startFrame`, with the handle it arrived under carried across so the
    // child's context can translate it back.
    const ctx = h.calls.imageToVideo.mock.calls[0]?.[1]
    expect(ctx?.assets).toEqual([
      { slot: 'startFrame', assetId: 'caller-asset-1', modality: 'image', handle: 'image_1' },
    ])
  })

  it('fans an array slot in through one ref', async () => {
    const h = mediaHost()
    const run = await h.run<PlanOutput>(
      'meta_read-frames' as PatternId,
      {},
      'session-frames',
      [asset('frames', 'a1'), asset('frames', 'a2'), asset('frames', 'a3')],
    )

    expect(run.job.status).toBe('done')
    const ctx = h.calls.imageToText.mock.calls[0]?.[1]
    expect(ctx?.assets?.map((a) => a.assetId)).toEqual(['a1', 'a2', 'a3'])
    expect(ctx?.assets?.every((a) => a.slot === 'source')).toBe(true)
  })

  it('an unfilled OPTIONAL slot contributes nothing and the step still runs', async () => {
    const h = mediaHost()
    const dag = {
      ...ANIMATE_CALLER_STILL,
      steps: [
        {
          ...ANIMATE_CALLER_STILL.steps[0],
          assets: {
            startFrame: '$input.assets[slot=still]',
            endFrame: '$input.assets[slot=tail]',
          },
        },
      ],
    }
    h.registry.register(
      planToMeta(dag as never, {
        id: 'meta_animate-optional' as PatternId,
        lookup: h.registry,
        inputs: z.object({ motion: z.string().min(1).max(500) }),
        assetNeeds: STILL_NEEDS,
        exposure: 'tool',
      }),
    )

    const run = await h.run<PlanOutput>(
      'meta_animate-optional' as PatternId,
      { motion: 'slow pan' },
      'session-optional',
      [asset('still', 'only-the-still')],
    )

    expect(run.job.status).toBe('done')
    const ctx = h.calls.imageToVideo.mock.calls[0]?.[1]
    expect(ctx?.assets?.map((a) => a.slot)).toEqual(['startFrame'])
  })

  it('an unfilled REQUIRED slot fails the plan by name rather than dispatching blind', async () => {
    const h = mediaHost()
    const run = await h.run<PlanOutput>(
      'meta_animate-still' as PatternId,
      { motion: 'slow pan' },
      'session-missing',
      [],
    )

    expect(run.job.status).toBe('error')
    expect(run.job.error?.code).toBe('PLAN_INPUT_ASSET_MISSING')
    expect(run.job.error?.details).toMatchObject({ slot: 'still', planStepId: 'animate' })
    expect(h.calls.imageToVideo).not.toHaveBeenCalled()
  })
})

// ── a failure invalidates its dependents, and nothing else ──────────────

/** Two independent renders; only the first feeds an animate. */
const TWO_BRANCHES = {
  description: 'Two independent branches, one of which will fall over.',
  steps: [
    { id: 'renderB', pattern: 'text-to-image', input: { prompt: 'branch B' } },
    { id: 'renderA', pattern: 'text-to-image', input: { prompt: 'branch A' } },
    {
      id: 'animateA',
      pattern: 'image-to-video',
      input: { prompt: 'pan' },
      assets: { startFrame: '$renderA.assets[0]' },
    },
  ],
  output: {
    assets: [
      { from: '$animateA.assets[0]', label: 'a' },
      { from: '$renderB.assets[0]', label: 'b' },
    ],
  },
} as const

function branchHost(): PlanHost {
  const h = makePlanHost()
  h.registry.register(
    planToMeta(TWO_BRANCHES as never, {
      id: 'meta_branches' as PatternId,
      lookup: h.registry,
      exposure: 'tool',
    }),
  )
  return h
}

describe('a failing step invalidates exactly its dependents', () => {
  it('lets an independent branch finish, then fails with the failing step’s own error', async () => {
    const h = branchHost()
    // `renderB` is listed first, and a level's steps are called synchronously
    // in list order — so the one-shot rejection lands on it.
    h.calls.textToImage.mockRejectedValueOnce(
      Object.assign(new Error('the renderer fell over'), { code: 'MOCK_PROVIDER_BLIP' }),
    )

    const run = await h.run<PlanOutput>('meta_branches' as PatternId, {}, 'session-branch')

    expect(run.job.status).toBe('error')
    expect(run.job.error?.code).toBe('MOCK_PROVIDER_BLIP')
    expect(run.job.error?.details).toMatchObject({ planStepId: 'renderB' })

    // The point: `animateA` sits a level BELOW the failure and depends on
    // nothing that failed, so it ran. Under a level-wide abort it never would
    // have, and its provider call would have to be paid for again on resubmit.
    expect(h.calls.imageToVideo).toHaveBeenCalledTimes(1)
  })

  it('banks the surviving branch — a resubmit re-runs only what failed', async () => {
    const h = branchHost()
    h.calls.textToImage.mockRejectedValueOnce(
      Object.assign(new Error('the renderer fell over'), { code: 'MOCK_PROVIDER_BLIP' }),
    )
    await h.run<PlanOutput>('meta_branches' as PatternId, {}, 'session-resubmit')

    const before = {
      image: h.calls.textToImage.mock.calls.length,
      video: h.calls.imageToVideo.mock.calls.length,
    }
    const retry = await h.run<PlanOutput>(
      'meta_branches' as PatternId,
      {},
      'session-resubmit',
    )

    expect(retry.job.status).toBe('done')
    // Exactly one new call: renderB. renderA and animateA both hit their rows.
    expect(h.calls.textToImage.mock.calls.length - before.image).toBe(1)
    expect(h.calls.imageToVideo.mock.calls.length - before.video).toBe(0)
  })

  it('a step whose dependency failed is not attempted at all', async () => {
    // Same two branches, but the step `animateA` reads is listed FIRST, so the
    // one-shot rejection lands on the one with a dependent.
    const h = makePlanHost()
    h.registry.register(
      planToMeta(
        {
          steps: [
            { id: 'renderA', pattern: 'text-to-image', input: { prompt: 'branch A' } },
            { id: 'renderB', pattern: 'text-to-image', input: { prompt: 'branch B' } },
            {
              id: 'animateA',
              pattern: 'image-to-video',
              input: { prompt: 'pan' },
              assets: { startFrame: '$renderA.assets[0]' },
            },
          ],
          output: {
            assets: [
              { from: '$animateA.assets[0]', label: 'a' },
              { from: '$renderB.assets[0]', label: 'b' },
            ],
          },
        } as never,
        { id: 'meta_upstream-fails' as PatternId, lookup: h.registry, exposure: 'tool' },
      ),
    )
    h.calls.textToImage.mockRejectedValueOnce(
      Object.assign(new Error('A fell over'), { code: 'MOCK_A_FAILED' }),
    )

    const run = await h.run<PlanOutput>(
      'meta_upstream-fails' as PatternId,
      {},
      'session-dependent',
    )

    expect(run.job.status).toBe('error')
    expect(run.job.error?.code).toBe('MOCK_A_FAILED')
    expect(run.job.error?.details).toMatchObject({ planStepId: 'renderA' })
    // Never entered — so no PLAN_REF_UNRESOLVED from reading a step that did
    // not produce, which would have buried the real cause under a symptom.
    expect(h.calls.imageToVideo).not.toHaveBeenCalled()
    // …while the independent branch still ran.
    expect(h.calls.textToImage).toHaveBeenCalledTimes(2)
  })

  it('with two failures, raises the first in LIST order, not the first to settle', async () => {
    // The determinism claim in the changeset, made falsifiable: the two steps
    // are arranged so settle order is the exact reverse of list order. Under
    // "whichever provider gave up first" this test would name `late`, and the
    // same plan would blame a different step on a different day.
    const h = makePlanHost()
    h.registry.register(
      planToMeta(
        {
          steps: [
            { id: 'early', pattern: 'text-to-image', input: { prompt: 'first listed' } },
            { id: 'late', pattern: 'text-to-image', input: { prompt: 'second listed' } },
          ],
          output: {
            assets: [
              { from: '$early.assets[0]', label: 'e' },
              { from: '$late.assets[0]', label: 'l' },
            ],
          },
        } as never,
        { id: 'meta_two-failures' as PatternId, lookup: h.registry, exposure: 'tool' },
      ),
    )

    const settled: string[] = []
    let nth = 0
    h.calls.textToImage.mockImplementation(async () => {
      // A level's steps are called synchronously in list order, so call 0 is
      // `early` and call 1 is `late`.
      const first = nth++ === 0
      if (first) await new Promise((resolve) => setTimeout(resolve, 20))
      settled.push(first ? 'early' : 'late')
      throw Object.assign(new Error(first ? 'early blew up' : 'late blew up'), {
        code: first ? 'MOCK_EARLY' : 'MOCK_LATE',
      })
    })

    const run = await h.run<PlanOutput>(
      'meta_two-failures' as PatternId,
      {},
      'session-two-failures',
    )

    // The arrangement actually held: `late` gave up first.
    expect(settled).toEqual(['late', 'early'])
    expect(run.job.status).toBe('error')
    expect(run.job.error?.code).toBe('MOCK_EARLY')
    expect(run.job.error?.details).toMatchObject({ planStepId: 'early' })
  })
})

// ── the caller's own durable identity ───────────────────────────────────

const ONE_RENDER = {
  description: 'One render.',
  steps: [{ id: 'render', pattern: 'text-to-image', input: { prompt: '$input.prompt' } }],
  output: { assets: [{ from: '$render.assets[0]', label: 'out' }] },
} as const

describe('RunPlanOptions.idempotencyKeyFor', () => {
  function keyedHost(keyed: boolean): PlanHost {
    const h = makePlanHost()
    h.registry.register(
      planToMeta(ONE_RENDER as never, {
        id: 'meta_keyed' as PatternId,
        lookup: h.registry,
        inputs: z.object({ prompt: z.string().min(1).max(2000) }),
        exposure: 'tool',
        ...(keyed
          ? {
              idempotencyKeyFor: (step, input) =>
                `content:${step.pattern}:${JSON.stringify(input)}`,
            }
          : {}),
      }),
    )
    return h
  }

  it('reuses a row across sessions, which the engine’s own derivation cannot', async () => {
    const h = keyedHost(true)
    const first = await h.run<PlanOutput>(
      'meta_keyed' as PatternId,
      { prompt: 'a hare' },
      'session-one',
    )
    const second = await h.run<PlanOutput>(
      'meta_keyed' as PatternId,
      { prompt: 'a hare' },
      'session-two',
    )

    expect(first.job.status).toBe('done')
    expect(second.job.status).toBe('done')
    expect(h.calls.textToImage).toHaveBeenCalledTimes(1)
  })

  it('without it, the same two runs each pay', async () => {
    const h = keyedHost(false)
    await h.run<PlanOutput>('meta_keyed' as PatternId, { prompt: 'a hare' }, 'session-one')
    await h.run<PlanOutput>('meta_keyed' as PatternId, { prompt: 'a hare' }, 'session-two')
    expect(h.calls.textToImage).toHaveBeenCalledTimes(2)
  })

  it('sees the SUBSTITUTED input, not the $ref that stood in for it', async () => {
    const seen: Record<string, unknown>[] = []
    const h = makePlanHost()
    h.registry.register(
      planToMeta(ONE_RENDER as never, {
        id: 'meta_seen' as PatternId,
        lookup: h.registry,
        inputs: z.object({ prompt: z.string().min(1).max(2000) }),
        exposure: 'tool',
        idempotencyKeyFor: (_step, input) => {
          seen.push(input)
          return undefined
        },
      }),
    )
    await h.run<PlanOutput>('meta_seen' as PatternId, { prompt: 'a hare' }, 'session-sub')
    expect(seen).toEqual([{ prompt: 'a hare' }])
  })

  it('returning undefined leaves the engine’s derivation in place', async () => {
    const h = makePlanHost()
    h.registry.register(
      planToMeta(ONE_RENDER as never, {
        id: 'meta_undef' as PatternId,
        lookup: h.registry,
        inputs: z.object({ prompt: z.string().min(1).max(2000) }),
        exposure: 'tool',
        idempotencyKeyFor: () => undefined,
      }),
    )
    await h.run<PlanOutput>('meta_undef' as PatternId, { prompt: 'x' }, 'session-a')
    await h.run<PlanOutput>('meta_undef' as PatternId, { prompt: 'x' }, 'session-b')
    // Session-scoped again, exactly as with no hook at all.
    expect(h.calls.textToImage).toHaveBeenCalledTimes(2)
  })
})

// ── what a caller-written key can collide with ──────────────────────────
//
// The seam hands the caller the whole burden, and the two ways a hand-written
// key goes wrong are both reachable from one DAG. A key that ignores the
// pattern collides ACROSS patterns, which the engine now refuses; a key that
// ignores the step collides WITHIN one level, which it cannot refuse — the row
// is legitimately the same pattern, it is simply not finished yet.

/** Two steps, two different patterns: the cross-pattern collision. */
const RENDER_THEN_ANIMATE = {
  description: 'Render a still, then animate it.',
  steps: [
    { id: 'render', pattern: 'text-to-image', input: { prompt: '$input.prompt' } },
    {
      id: 'animate',
      pattern: 'image-to-video',
      input: { prompt: 'slow drift' },
      assets: { startFrame: '$render.assets[0]' },
    },
  ],
  output: { assets: [{ from: '$animate.assets[0]', label: 'clip' }] },
} as const

/** Two steps, ONE pattern, no dependency between them: the fan-out collision. */
const TWO_RENDERS = {
  description: 'Two independent renders.',
  steps: [
    { id: 'left', pattern: 'text-to-image', input: { prompt: 'a hare' } },
    { id: 'right', pattern: 'text-to-image', input: { prompt: 'a hare' } },
  ],
  output: {
    assets: [
      { from: '$left.assets[0]', label: 'l' },
      { from: '$right.assets[0]', label: 'r' },
    ],
  },
} as const

describe('a caller-supplied key that collides', () => {
  function host(dag: unknown, id: string, key: string): PlanHost {
    const h = makePlanHost()
    h.registry.register(
      planToMeta(dag as never, {
        id: id as PatternId,
        lookup: h.registry,
        inputs: z.object({ prompt: z.string().min(1).max(2000) }).partial(),
        exposure: 'tool',
        idempotencyKeyFor: () => key,
      }),
    )
    return h
  }

  it('across patterns is refused, not silently answered with the other pattern’s output', async () => {
    // Without the guard this plan reports `done`: `animate` dedupes onto
    // `render`'s row, image-to-video is never called, and `output.assets.clip`
    // is the IMAGE — a video slot filled by a still, with both steps priced.
    const h = host(RENDER_THEN_ANIMATE, 'meta_cross', 'same-key')
    const run = await h.run<PlanOutput>(
      'meta_cross' as PatternId,
      { prompt: 'a hare' },
      'session-cross',
    )

    expect(run.job.status).toBe('error')
    expect(run.job.error?.code).toBe('IDEMPOTENCY_KEY_CROSS_PATTERN')
    expect(run.job.error?.details).toMatchObject({
      planStepId: 'animate',
      patternId: 'image-to-video',
      heldBy: 'text-to-image',
    })
    // Both pattern ids are named, and the key is not spelled out in full.
    expect(run.job.error?.message).toContain('text-to-image')
    expect(run.job.error?.message).toContain('image-to-video')
    expect(h.calls.imageToVideo).not.toHaveBeenCalled()
  })

  it('within one pattern still dedupes — the guard tightens nothing else', async () => {
    const h = host(ONE_RENDER, 'meta_same', 'one-key')
    const first = await h.run<PlanOutput>(
      'meta_same' as PatternId,
      { prompt: 'a hare' },
      'session-one',
    )
    const second = await h.run<PlanOutput>(
      'meta_same' as PatternId,
      { prompt: 'a hare' },
      'session-two',
    )

    expect(first.job.status).toBe('done')
    expect(second.job.status).toBe('done')
    expect(h.calls.textToImage).toHaveBeenCalledTimes(1)
  })

  it('within one level names the in-flight row rather than the key', async () => {
    // Both steps are the same pattern, so the cross-pattern guard says nothing
    // — and it should not: the row IS the right pattern. What it is not is
    // finished, because the second step deduped onto the first while that one
    // was still queued. This is the fan-out failure mode of a key derived
    // only from the input.
    const h = host(TWO_RENDERS, 'meta_fanout', 'one-key-for-both')
    const run = await h.run<PlanOutput>(
      'meta_fanout' as PatternId,
      { prompt: 'unused' },
      'session-fanout',
    )

    expect(run.job.status).toBe('error')
    expect(run.job.error?.code).toBe('PLAN_STEP_IN_FLIGHT')
  })
})

// ── a modality the producer's own schema does not pin ───────────────────
//
// `PlanOutputSchema.assets[].modality` is core's `AssetKind` enum, and the
// interpreter narrows a producing step's `modality` string to it rather than
// asserting. The narrowing only ever fires for a pattern whose outputs declare
// `modality: z.string()` — the dispatch exit already held everything else to a
// literal — which is exactly why it had no coverage: none of the shipped
// patterns is loose enough to reach it. So the fixture below is.

/** A meta that returns a modality its own schema permits and core does not. */
function looseModalityMeta(modality: string): Pattern {
  return {
    id: 'meta_loose' as PatternId,
    kind: 'meta',
    description: 'returns an asset whose modality its own outputs do not pin',
    outputs: z.object({
      assets: z
        .array(
          z.object({
            assetId: z.string().max(128),
            // The whole point of the fixture: a bare bounded string where
            // every shipped pattern writes a literal or an enum.
            modality: z.string().max(32),
            url: z.string().max(2048).optional(),
          }),
        )
        .max(8),
      cost: z.number().min(0).nullable(),
      latencyMs: z.number().int().min(0),
    }) as never,
    tool: { description: 'loose', inputs: z.object({}) as never },
    async compose() {
      return {
        assets: [{ assetId: 'loose-1', modality, url: PNG_URL }],
        cost: 0,
        latencyMs: 0,
      }
    },
  } as unknown as Pattern
}

const PNG_URL = 'data:image/png;base64,aVZCT1J3MEtHZ29BQUFBTlNVaEVVZ0E='

/** The loose asset is bound into a LATER step's slot. */
const LOOSE_INTO_STEP = {
  description: 'Animate an asset whose modality is not a kind.',
  steps: [
    { id: 'produce', pattern: 'meta_loose', input: {} },
    {
      id: 'animate',
      pattern: 'image-to-video',
      input: { prompt: 'drift' },
      assets: { startFrame: '$produce.assets[0]' },
    },
  ],
  output: { assets: [{ from: '$animate.assets[0]', label: 'clip' }] },
} as const

/** The loose asset is returned directly, with no consuming step at all. */
const LOOSE_INTO_OUTPUT = {
  description: 'Return an asset whose modality is not a kind.',
  steps: [{ id: 'produce', pattern: 'meta_loose', input: {} }],
  output: { assets: [{ from: '$produce.assets[0]', label: 'out' }] },
} as const

describe('a produced modality core does not recognise', () => {
  function looseHost(dag: unknown, id: string, modality = 'img'): PlanHost {
    const h = makePlanHost({ extra: [looseModalityMeta(modality)] })
    h.registry.register(
      planToMeta(dag as never, {
        id: id as PatternId,
        lookup: h.registry,
        exposure: 'tool',
      }),
    )
    return h
  }

  it('fails at the binding site, naming the CONSUMING step and the ref', async () => {
    const h = looseHost(LOOSE_INTO_STEP, 'meta_loose-step')
    const run = await h.run<PlanOutput>(
      'meta_loose-step' as PatternId,
      {},
      'session-loose-step',
    )

    expect(run.job.status).toBe('error')
    expect(run.job.error?.code).toBe('PLAN_ASSET_MODALITY_UNKNOWN')
    expect(run.job.error?.details).toMatchObject({
      // The step that was about to be dispatched, not the one that produced
      // the value — the producer is readable off `ref`.
      planStepId: 'animate',
      ref: '$produce.assets[0]',
      modality: 'img',
    })
    // Refused before the dispatch, not after paying for it.
    expect(h.calls.imageToVideo).not.toHaveBeenCalled()
  })

  it('fails at the output site too, where there is no consuming step to name', async () => {
    const h = looseHost(LOOSE_INTO_OUTPUT, 'meta_loose-out')
    const run = await h.run<PlanOutput>(
      'meta_loose-out' as PatternId,
      {},
      'session-loose-out',
    )

    expect(run.job.status).toBe('error')
    expect(run.job.error?.code).toBe('PLAN_ASSET_MODALITY_UNKNOWN')
    // No `planStepId`: assembly happens after the level loop, and the entry
    // this failed on is addressed by its path in the output block.
    expect(run.job.error?.details).toMatchObject({
      ref: '$produce.assets[0]',
      path: ['output', 'assets', 'out'],
      modality: 'img',
    })
    expect(
      (run.job.error?.details as { planStepId?: string } | undefined)?.planStepId,
    ).toBeUndefined()
  })

  it('a kind core DOES recognise passes through untouched', async () => {
    const h = looseHost(LOOSE_INTO_OUTPUT, 'meta_loose-ok', 'document')
    const run = await h.run<PlanOutput>(
      'meta_loose-ok' as PatternId,
      {},
      'session-loose-ok',
    )

    expect(run.job.status).toBe('done')
    expect(run.job.output?.assets[0]?.modality).toBe('document')
  })
})

// ── the width of a level ────────────────────────────────────────────────

/** Six independent renders, all on level 0. */
const SIX_WIDE = {
  description: 'Six independent renders.',
  steps: Array.from({ length: 6 }, (_, i) => ({
    id: `render${i}`,
    pattern: 'text-to-image',
    input: { prompt: `subject ${i}` },
  })),
  output: {
    assets: Array.from({ length: 6 }, (_, i) => ({
      from: `$render${i}.assets[0]`,
      label: `out${i}`,
    })),
  },
} as const

describe('RunPlanOptions.concurrency', () => {
  function wideHost(concurrency?: number): PlanHost {
    const h = makePlanHost({ latencyMs: 5 })
    h.registry.register(
      planToMeta(SIX_WIDE as never, {
        id: 'meta_wide' as PatternId,
        lookup: h.registry,
        exposure: 'tool',
        ...(concurrency !== undefined ? { concurrency } : {}),
      }),
    )
    return h
  }

  it('runs the whole level at once by default', async () => {
    const h = wideHost()
    const run = await h.run<PlanOutput>('meta_wide' as PatternId, {}, 'session-wide')
    expect(run.job.status).toBe('done')
    expect(h.models.peak['text-to-image']).toBe(6)
  })

  it('holds a capped level to the cap, and still finishes every step', async () => {
    const h = wideHost(2)
    const run = await h.run<PlanOutput>('meta_wide' as PatternId, {}, 'session-capped')
    expect(run.job.status).toBe('done')
    expect(h.models.peak['text-to-image']).toBe(2)
    expect(h.calls.textToImage).toHaveBeenCalledTimes(6)
    expect(run.job.output?.assets).toHaveLength(6)
  })

  it('a cap wider than the level changes nothing', async () => {
    const h = wideHost(50)
    await h.run<PlanOutput>('meta_wide' as PatternId, {}, 'session-loose')
    expect(h.models.peak['text-to-image']).toBe(6)
  })

  it('the one-shot forwards the cap its host set at construction', async () => {
    // `createPlanMeta`'s second argument is the only place a host can bound a
    // model-authored DAG: the model writes the steps, so the width is not
    // something the plan's author chose. Untested, the option could have been
    // read and dropped — the fan-out looks identical either way from outside.
    const h = makePlanHost({ latencyMs: 5 })
    h.registry.register(
      createPlanMeta(
        { getPattern: (id) => h.registry.get(id) },
        { concurrency: 2 },
      ) as never,
    )

    const run = await h.run<PlanOutput>(
      'meta_plan' as PatternId,
      SIX_WIDE,
      'session-oneshot-cap',
    )

    expect(run.job.status).toBe('done')
    expect(h.models.peak['text-to-image']).toBe(2)
    expect(h.calls.textToImage).toHaveBeenCalledTimes(6)
  })
})
