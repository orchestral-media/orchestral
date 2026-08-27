// Wiring smoke test — pins the claim main.ts narrates, with NO API key and no
// artificial latency.
//
// The first test is deliberately the SAME assertion examples/incremental-rerun
// makes about its hand-written `meta_short-clip`: re-submitting with `motion`
// changed, in the same session, returns `describe` and `render` under their
// ORIGINAL child job ids and calls their models zero more times, while
// `animate` re-runs. A plan is a meta; it gets the meta engine's dedup
// unchanged. The difference is underneath — the keys are now `stepKey:
// describe` / `render` / `animate` rather than `stepIndex: 0 / 1 / 2` — and the
// second test is what that buys: insert a step and the untouched ones still hit.
//
// The evidence is the runtime's, not the mocks': `job:step.childJobId` equality
// across runs, the rows `onJobCreated` reports as inserted, and `vi.spyOn` on
// each mock's `call` counting how often the runtime actually reached a model.

import {
  createDefaultCapabilityRouter,
  InMemoryJobStore,
  PatternRegistry,
  silentDiagnosticsLogger,
  type PatternId,
} from '@orchestral/core'
import {
  createImageToVideoPattern,
  createTextGenerationPattern,
  createTextToImagePattern,
} from '@orchestral/patterns'
import { PlanOutputSchema, validatePlan } from '@orchestral/plan'
import { deriveIdempotencyKey, InlineRuntime } from '@orchestral/runtime'
import { describe, expect, it, vi } from 'vitest'

import { createMockModels } from '../mock-models'
import { createRunObserver } from '../observe'
import { CAPTIONED_PATTERN_ID, createCaptionedShortClip } from '../plan-captioned'
import {
  createShortClip,
  lookupFrom,
  ShortClipInputSchema,
  SHORT_CLIP_PATTERN_ID,
  SHORT_CLIP_PLAN,
  type ShortClipInput,
} from '../pattern'

const RED_BIKE: ShortClipInput = { prompt: 'a red bicycle', motion: 'slow pan' }
const ALL_ROWS = [
  SHORT_CLIP_PATTERN_ID,
  'text-generation',
  'text-to-image',
  'image-to-video',
]

/** Identical wiring to src/main.ts, minus the latency. */
function makeHost(store = new InMemoryJobStore()) {
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  registry.add(createTextGenerationPattern())
  registry.add(createTextToImagePattern())
  registry.add(createImageToVideoPattern())
  const ops = { getPattern: (id: PatternId) => registry.get(id) }
  registry.add(createShortClip(ops))
  registry.add(createCaptionedShortClip(ops))

  const { getModels, models } = createMockModels()
  const router = createDefaultCapabilityRouter({ getModels })
  const observer = createRunObserver()
  const runtime = new InlineRuntime({
    store,
    registry,
    router,
    onJobCreated: observer.onJobCreated,
  })
  // Spy the adapters so "the model was not called" is a count, not an inference.
  const calls = {
    textGeneration: vi.spyOn(models.textGeneration, 'call'),
    textToImage: vi.spyOn(models.textToImage, 'call'),
    imageToVideo: vi.spyOn(models.imageToVideo, 'call'),
  }
  return {
    registry,
    runtime,
    calls,
    run: (
      input: ShortClipInput,
      sessionId: string,
      patternId: PatternId = SHORT_CLIP_PATTERN_ID,
    ) => observer.run(runtime, patternId, input, sessionId),
  }
}

describe('the persisted plan', () => {
  it('validates clean against the registry it will run on', () => {
    const host = makeHost()
    const ops = { getPattern: (id: PatternId) => host.registry.get(id) }
    // Every rule zod cannot express — slot names, slot modality, path existence
    // in the producer's outputs, `$input` fields — checked against the real
    // atomics, before a single dispatch.
    expect(
      validatePlan(SHORT_CLIP_PLAN, lookupFrom(ops), {
        selfId: SHORT_CLIP_PATTERN_ID,
        inputs: ShortClipInputSchema,
      }),
    ).toEqual([])
  })

  it('is an ordinary meta pattern that records where it came from', () => {
    const pattern = createShortClip({ getPattern: () => undefined })
    expect(pattern.kind).toBe('meta')
    expect(pattern.origin).toBe('plan')
    expect(pattern.plan).toBe(SHORT_CLIP_PLAN)
    // The static step list an agent loop holds to its own allowlist before it
    // submits anything.
    expect(pattern.plannedDispatches?.(RED_BIKE)).toEqual([
      'text-generation',
      'text-to-image',
      'image-to-video',
    ])
  })
})

describe('incremental re-run — the same trace the hand-written twin pins', () => {
  it('run 2 (motion changed) reuses describe/render child ids and re-runs animate', async () => {
    const host = makeHost()
    const session = 'session-a'

    // Run 1 — cold: three steps, four rows, one call per model.
    const run1 = await host.run(RED_BIKE, session)
    expect(run1.job.status).toBe('done')
    expect(run1.job.error).toBeNull()
    expect(run1.steps.map((s) => s.stepId)).toEqual(['describe', 'render', 'animate'])
    expect(run1.steps.map((s) => s.patternId)).toEqual([
      'text-generation',
      'text-to-image',
      'image-to-video',
    ])
    expect(new Set(run1.steps.map((s) => s.childJobId)).size).toBe(3)
    expect(run1.inserted).toEqual(ALL_ROWS)
    expect(host.calls.textGeneration).toHaveBeenCalledTimes(1)
    expect(host.calls.textToImage).toHaveBeenCalledTimes(1)
    expect(host.calls.imageToVideo).toHaveBeenCalledTimes(1)

    // The plan returns the fixed envelope every plan returns.
    const out1 = PlanOutputSchema.parse(run1.job.output)
    expect(out1.values.description).toContain('a red bicycle')
    expect(out1.assets).toHaveLength(1)
    expect(out1.assets[0]).toMatchObject({ label: 'clip', modality: 'video' })
    expect(out1.steps.map((s) => s.id)).toEqual(['describe', 'render', 'animate'])
    expect(out1.cost).toBeCloseTo(0.071, 10)

    // Run 2 — same session, motion changed.
    const run2 = await host.run({ ...RED_BIKE, motion: 'orbit' }, session)
    expect(run2.job.status).toBe('done')
    expect(run2.job.id).not.toBe(run1.job.id)
    expect(run2.steps[0]!.childJobId).toBe(run1.steps[0]!.childJobId)
    expect(run2.steps[1]!.childJobId).toBe(run1.steps[1]!.childJobId)
    expect(run2.steps[2]!.childJobId).not.toBe(run1.steps[2]!.childJobId)
    expect(run2.inserted).toEqual([SHORT_CLIP_PATTERN_ID, 'image-to-video'])
    expect(host.calls.textGeneration).toHaveBeenCalledTimes(1)
    expect(host.calls.textToImage).toHaveBeenCalledTimes(1)
    expect(host.calls.imageToVideo).toHaveBeenCalledTimes(2)

    // `animate` consumed the still run 1 rendered — the stored row's output,
    // not a re-render — and produced a new clip.
    const out2 = PlanOutputSchema.parse(run2.job.output)
    expect(out2.values.description).toBe(out1.values.description)
    expect(out2.assets[0]!.assetId).not.toBe(out1.assets[0]!.assetId)
  })

  it('a step inserted second re-runs nothing else — the key names the step', async () => {
    const host = makeHost()
    const session = 'session-insert'
    const run1 = await host.run(RED_BIKE, session)

    // The revised plan: `caption` listed SECOND, an independent branch. Under
    // positional identity this would move `render` to index 2 and `animate` to
    // index 3 and re-run both; under identity:'id' all three still hit.
    const run3 = await host.run(RED_BIKE, session, CAPTIONED_PATTERN_ID)
    expect(run3.job.status).toBe('done')
    const idOf = (trace: typeof run1, stepId: string) =>
      trace.steps.find((s) => s.stepId === stepId)?.childJobId
    expect(idOf(run3, 'describe')).toBe(idOf(run1, 'describe'))
    expect(idOf(run3, 'render')).toBe(idOf(run1, 'render'))
    expect(idOf(run3, 'animate')).toBe(idOf(run1, 'animate'))
    expect(idOf(run3, 'caption')).toBeDefined()

    // Two rows: the new plan job, and the one new step. One model call.
    expect(run3.inserted).toEqual([CAPTIONED_PATTERN_ID, 'text-generation'])
    expect(host.calls.textGeneration).toHaveBeenCalledTimes(2)
    expect(host.calls.textToImage).toHaveBeenCalledTimes(1)
    expect(host.calls.imageToVideo).toHaveBeenCalledTimes(1)

    const out = PlanOutputSchema.parse(run3.job.output)
    expect(Object.keys(out.values).sort()).toEqual(['caption', 'description'])
  })

  it('each child row is keyed on the step id, not on its position', async () => {
    const host = makeHost()
    const session = 'session-key'
    const run = await host.run(RED_BIKE, session)
    const out = PlanOutputSchema.parse(run.job.output)
    const [describeRow, renderRow, animateRow] = await Promise.all(
      run.steps.map((s) => host.runtime.pollJob(s.childJobId)),
    )

    // `stepKey` replaces `stepIndex` in the derivation, and the input is what
    // the DAG says after substitution — no zod defaults, so a plan's
    // text-generation step keys identically to a hand-written meta's.
    expect(describeRow!.idempotencyKey).toBe(
      deriveIdempotencyKey({
        patternId: 'text-generation',
        // The DAG's own `input`, with `$input.prompt` replaced by the value the
        // caller passed — and nothing else. `maxOutputTokens` / `temperature` /
        // `responseFormat` all have schema defaults and none of them is here:
        // the layer-2 gate parses a copy for the verdict and throws it away.
        input: {
          system: SHORT_CLIP_PLAN.steps[0]!.input.system as string,
          prompt: RED_BIKE.prompt,
        },
        sessionId: session,
        stepKey: 'describe',
      }),
    )
    expect(renderRow!.idempotencyKey).toBe(
      deriveIdempotencyKey({
        patternId: 'text-to-image',
        input: { prompt: out.values.description },
        sessionId: session,
        stepKey: 'render',
      }),
    )
    // The still rides in `assets`, so the same motion over a different still
    // would be a different key.
    expect(animateRow!.idempotencyKey).toBe(
      deriveIdempotencyKey({
        patternId: 'image-to-video',
        input: { prompt: RED_BIKE.motion },
        assets: [
          {
            slot: 'startFrame',
            assetId: run.steps[1]!.assetIds[0]!,
            modality: 'image',
          },
        ],
        sessionId: session,
        stepKey: 'animate',
      }),
    )
  })

  it('a different sessionId re-runs everything — the key never crosses a session', async () => {
    const host = makeHost()
    const run1 = await host.run(RED_BIKE, 'session-a')
    const run2 = await host.run(RED_BIKE, 'session-b')
    expect(run2.job.id).not.toBe(run1.job.id)
    for (const [i, s] of run2.steps.entries()) {
      expect(s.childJobId).not.toBe(run1.steps[i]!.childJobId)
    }
    expect(run2.inserted).toEqual(ALL_ROWS)
    expect(host.calls.textGeneration).toHaveBeenCalledTimes(2)
    expect(host.calls.textToImage).toHaveBeenCalledTimes(2)
    expect(host.calls.imageToVideo).toHaveBeenCalledTimes(2)
  })

  it('a failing step fails the plan and names itself; the retry keeps the upstream hits', async () => {
    const host = makeHost()
    const session = 'session-fail'
    const run1 = await host.run(RED_BIKE, session)

    host.calls.imageToVideo.mockRejectedValueOnce(new Error('mock provider blip'))
    const failed = await host.run({ ...RED_BIKE, motion: 'tilt up' }, session)
    expect(failed.job.status).toBe('error')
    expect(failed.job.error?.message).toContain('mock provider blip')
    // Which step, without parsing a message.
    expect(failed.job.error?.details).toMatchObject({
      planStepId: 'animate',
      planPatternId: SHORT_CLIP_PATTERN_ID,
    })

    // Same input again: describe/render still hit run 1's rows; the error row
    // is not canonical, so `animate` is dispatched afresh.
    const retry = await host.run({ ...RED_BIKE, motion: 'tilt up' }, session)
    expect(retry.job.status).toBe('done')
    expect(retry.steps[0]!.childJobId).toBe(run1.steps[0]!.childJobId)
    expect(retry.steps[1]!.childJobId).toBe(run1.steps[1]!.childJobId)
    expect(host.calls.textGeneration).toHaveBeenCalledTimes(1)
    expect(host.calls.textToImage).toHaveBeenCalledTimes(1)
    expect(host.calls.imageToVideo).toHaveBeenCalledTimes(3)
  })
})
