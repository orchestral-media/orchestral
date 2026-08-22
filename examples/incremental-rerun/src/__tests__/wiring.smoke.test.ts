// Wiring smoke test — pins the claim main.ts narrates, with NO API key and no
// artificial latency: re-submitting the meta with one input changed, in the
// same session, returns the unchanged steps' ORIGINAL child job ids and calls
// their models zero more times, while the changed step and everything
// downstream re-run. Same registry → mocks → router → runtime → observer path
// as src/main.ts; the only difference is the mocks' latency (0 here).
//
// The evidence is the runtime's, not the mocks': `job:step.childJobId` equality
// across runs, the rows `onJobCreated` reports as inserted, and `vi.spyOn` on
// each mock's `call` counting how often the runtime actually reached a model.
// The last three tests pin the boundaries: a different sessionId, a second
// runtime over the same store, and a failed step.

import { describe, expect, it, vi } from 'vitest'
import {
  createDefaultCapabilityRouter,
  InMemoryJobStore,
  PatternRegistry,
} from '@orchestral/core'
import {
  createImageToVideoPattern,
  createTextGenerationPattern,
  createTextToImagePattern,
} from '@orchestral/patterns'
import { deriveIdempotencyKey, InlineRuntime } from '@orchestral/runtime'
import { createMockModels } from '../mock-models'
import { createRunObserver } from '../observe'
import {
  createShortClipMeta,
  DESCRIBE_SYSTEM,
  SHORT_CLIP_PATTERN_ID,
  ShortClipOutputSchema,
  type ShortClipInput,
} from '../pattern'

const ALL_ROWS = [SHORT_CLIP_PATTERN_ID, 'text-generation', 'text-to-image', 'image-to-video']
const RED_BIKE: ShortClipInput = { prompt: 'a red bicycle', motion: 'slow pan' }

// Identical wiring to src/main.ts, minus the latency. `store` is injectable so
// two hosts can share one (the restart case).
function makeHost(store = new InMemoryJobStore()) {
  const registry = new PatternRegistry()
  registry.add(createTextGenerationPattern())
  registry.add(createTextToImagePattern())
  registry.add(createImageToVideoPattern())
  registry.add(createShortClipMeta())

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
    store,
    runtime,
    calls,
    run: (input: ShortClipInput, sessionId: string) => observer.run(runtime, input, sessionId),
  }
}

describe('incremental re-run wiring', () => {
  it('run 2 (motion changed) reuses describe/render child ids and re-runs animate; run 3 (prompt changed) re-runs everything', async () => {
    const host = makeHost()
    const session = 'session-a'

    // Run 1 — cold: three steps, four rows, one call per model.
    const run1 = await host.run(RED_BIKE, session)
    expect(run1.job.status).toBe('done')
    expect(run1.job.error).toBeNull()
    expect(run1.steps.map((s) => s.stepId)).toEqual(['describe', 'render', 'animate'])
    expect(run1.steps.map((s) => s.patternId)).toEqual(['text-generation', 'text-to-image', 'image-to-video'])
    expect(new Set(run1.steps.map((s) => s.childJobId)).size).toBe(3)
    expect(run1.inserted).toEqual(ALL_ROWS)
    expect(host.calls.textGeneration).toHaveBeenCalledTimes(1)
    expect(host.calls.textToImage).toHaveBeenCalledTimes(1)
    expect(host.calls.imageToVideo).toHaveBeenCalledTimes(1)

    // The outputs honour the real schemas — the meta's own, and the atomics'
    // on the child rows (the runtime does not parse them; the mocks must).
    const out1 = ShortClipOutputSchema.parse(run1.job.output)
    const renderRow = await host.runtime.pollJob(run1.steps[1]!.childJobId)
    const still = createTextToImagePattern().outputs.parse(renderRow.output)
    expect(still.assets[0]!.assetId).toBe(out1.frameAssetId)
    const animateRow = await host.runtime.pollJob(run1.steps[2]!.childJobId)
    createImageToVideoPattern().outputs.parse(animateRow.output)

    // Run 2 — same session, motion changed.
    const run2 = await host.run({ ...RED_BIKE, motion: 'orbit' }, session)
    expect(run2.job.status).toBe('done')
    expect(run2.job.id).not.toBe(run1.job.id)
    // describe + render: the SAME child rows as run 1.
    expect(run2.steps[0]!.childJobId).toBe(run1.steps[0]!.childJobId)
    expect(run2.steps[1]!.childJobId).toBe(run1.steps[1]!.childJobId)
    // animate: a new row.
    expect(run2.steps[2]!.childJobId).not.toBe(run1.steps[2]!.childJobId)
    // The runtime inserted exactly the meta and the animate row.
    expect(run2.inserted).toEqual([SHORT_CLIP_PATTERN_ID, 'image-to-video'])
    // Steps 1–2's models were called exactly once across runs 1–2.
    expect(host.calls.textGeneration).toHaveBeenCalledTimes(1)
    expect(host.calls.textToImage).toHaveBeenCalledTimes(1)
    expect(host.calls.imageToVideo).toHaveBeenCalledTimes(2)
    // animate consumed the still run 1 rendered — the stored row's output,
    // not a re-render — and produced a new clip.
    const out2 = ShortClipOutputSchema.parse(run2.job.output)
    expect(out2.description).toBe(out1.description)
    expect(out2.frameAssetId).toBe(out1.frameAssetId)
    expect(out2.assets[0]!.assetId).not.toBe(out1.assets[0]!.assetId)

    // Run 3 — prompt changed: every step is new.
    const run3 = await host.run({ prompt: 'a blue kettle', motion: 'orbit' }, session)
    expect(run3.job.status).toBe('done')
    const seen = new Set([...run1.steps, ...run2.steps].map((s) => s.childJobId))
    for (const s of run3.steps) expect(seen.has(s.childJobId)).toBe(false)
    expect(run3.inserted).toEqual(ALL_ROWS)
    expect(host.calls.textGeneration).toHaveBeenCalledTimes(2)
    expect(host.calls.textToImage).toHaveBeenCalledTimes(2)
    expect(host.calls.imageToVideo).toHaveBeenCalledTimes(3)
    const out3 = ShortClipOutputSchema.parse(run3.job.output)
    expect(out3.frameAssetId).not.toBe(out1.frameAssetId)
  })

  it('each child row carries exactly the key deriveIdempotencyKey gives for { patternId, input, assets, sessionId, stepIndex }', async () => {
    const host = makeHost()
    const session = 'session-key'
    const run = await host.run(RED_BIKE, session)
    const out = ShortClipOutputSchema.parse(run.job.output)
    const [describeRow, renderRow, animateRow] = await Promise.all(
      run.steps.map((s) => host.runtime.pollJob(s.childJobId)),
    )

    // stepIndex is the step's ordinal in compose — 0, 1, 2 — not the stepId.
    expect(describeRow!.idempotencyKey).toBe(
      deriveIdempotencyKey({
        patternId: 'text-generation',
        input: { system: DESCRIBE_SYSTEM, prompt: RED_BIKE.prompt },
        sessionId: session,
        stepIndex: 0,
      }),
    )
    expect(renderRow!.idempotencyKey).toBe(
      deriveIdempotencyKey({
        patternId: 'text-to-image',
        input: { prompt: out.description },
        sessionId: session,
        stepIndex: 1,
      }),
    )
    // The still rides in `assets`, so the same motion over a different still
    // would be a different key.
    expect(animateRow!.idempotencyKey).toBe(
      deriveIdempotencyKey({
        patternId: 'image-to-video',
        input: { prompt: RED_BIKE.motion },
        assets: [{ slot: 'startFrame', assetId: out.frameAssetId, modality: 'image' }],
        sessionId: session,
        stepIndex: 2,
      }),
    )
  })

  it('an identical re-submit dedupes the whole meta: same job id, compose never runs', async () => {
    const host = makeHost()
    const run1 = await host.run(RED_BIKE, 'session-same')
    const run2 = await host.run(RED_BIKE, 'session-same')
    expect(run2.job.id).toBe(run1.job.id)
    expect(run2.steps).toEqual([])
    expect(run2.inserted).toEqual([])
    expect(host.calls.textGeneration).toHaveBeenCalledTimes(1)
    expect(host.calls.textToImage).toHaveBeenCalledTimes(1)
    expect(host.calls.imageToVideo).toHaveBeenCalledTimes(1)
  })

  it('a different sessionId re-runs everything — the key never crosses a session', async () => {
    const host = makeHost()
    const run1 = await host.run(RED_BIKE, 'session-a')
    // Same input, other session.
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

  it('a second runtime over the same store dedupes onto rows the first one wrote', async () => {
    const store = new InMemoryJobStore()
    const first = makeHost(store)
    const second = makeHost(store)
    const session = 'session-restart'

    const run1 = await first.run(RED_BIKE, session)
    // Nothing was mid-flight, so the crash half has nothing to mark stale.
    expect(await second.runtime.abandonOrphanedJobs()).toEqual([])

    const run2 = await second.run({ ...RED_BIKE, motion: 'dolly zoom' }, session)
    expect(run2.steps[0]!.childJobId).toBe(run1.steps[0]!.childJobId)
    expect(run2.steps[1]!.childJobId).toBe(run1.steps[1]!.childJobId)
    expect(run2.steps[2]!.childJobId).not.toBe(run1.steps[2]!.childJobId)
    expect(run2.inserted).toEqual([SHORT_CLIP_PATTERN_ID, 'image-to-video'])
    // The second runtime's own models: never asked to describe or render.
    expect(second.calls.textGeneration).not.toHaveBeenCalled()
    expect(second.calls.textToImage).not.toHaveBeenCalled()
    expect(second.calls.imageToVideo).toHaveBeenCalledTimes(1)
  })

  it('a failed step never dedupes: the retry re-dispatches it while the upstream hits stay cached', async () => {
    const host = makeHost()
    const session = 'session-fail'
    const run1 = await host.run(RED_BIKE, session)

    // Fail animate once. The runtime logs the provider error; keep the test
    // output clean. submitJob rejects with the provider's own error.
    host.calls.imageToVideo.mockRejectedValueOnce(new Error('mock provider blip'))
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(host.run({ ...RED_BIKE, motion: 'tilt up' }, session)).rejects.toThrow(
        'mock provider blip',
      )
    } finally {
      quiet.mockRestore()
    }
    const errored = await host.store.query({ status: ['error'] })
    expect(errored.map((j) => j.patternId).sort()).toEqual(['image-to-video', SHORT_CLIP_PATTERN_ID])

    // Same input again: describe/render still hit run 1's rows; animate's
    // error row is not canonical, so it is dispatched afresh.
    const retry = await host.run({ ...RED_BIKE, motion: 'tilt up' }, session)
    expect(retry.job.status).toBe('done')
    expect(retry.steps[0]!.childJobId).toBe(run1.steps[0]!.childJobId)
    expect(retry.steps[1]!.childJobId).toBe(run1.steps[1]!.childJobId)
    expect(retry.inserted).toEqual([SHORT_CLIP_PATTERN_ID, 'image-to-video'])
    expect(host.calls.textGeneration).toHaveBeenCalledTimes(1)
    expect(host.calls.textToImage).toHaveBeenCalledTimes(1)
    // run 1, the blip, the retry.
    expect(host.calls.imageToVideo).toHaveBeenCalledTimes(3)
  })
})
