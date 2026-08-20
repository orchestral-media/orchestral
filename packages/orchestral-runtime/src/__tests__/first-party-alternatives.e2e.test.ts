// End-to-end proof that the alternatives shipped by @orchestral/patterns are
// real dispatch paths, not documentation: a catalog with no image-to-image
// model still completes an image-to-image job, by way of the caption →
// text-to-image meta, and reports the degradation it took.
//
// Redirects are opt-in, so every runtime here is constructed with
// `alternatives: 'auto'` — this file is about what the declared paths DO once
// a host has asked for them, not about the default (alternatives-default-off
// .test.ts covers that).
//
// The asset channel is part of that proof. Every model call records the
// DispatchContext it was handed, because "the chain ran" and "the chain ran on
// the right image" are different claims: the caption step is what carries the
// source image into a text-only render, and if it dispatches with an empty
// `ctx.assets` the VLM describes nothing while every other assertion here still
// passes.
import { describe, expect, it } from 'vitest'

import type {
  AssetEvent,
  AssetReferences,
  CapabilityRouter,
  DispatchContext,
  JobEvent,
  ModelCapability,
  Pattern,
  ResolvedAssetRef,
} from '@orchestral/core'
import {
  InMemoryJobStore,
  PatternRegistry,
  buildAssetIndex,
  resolveAssetReferences,
} from '@orchestral/core'
import {
  createAutomaticSpeechRecognitionPattern,
  createImageToImagePattern,
  createImageToImageViaCaptionPattern,
  createImageToTextPattern,
  createImageToVideoPattern,
  createTextGenerationPattern,
  createTextToAudioPattern,
  createTextToImagePattern,
  createTextToSpeechPattern,
  createTextToVideoPattern,
  createVideoToVideoPattern,
} from '@orchestral/patterns'

import { InlineRuntime } from '../inline'
import type { AgentAssetBridge } from '../inline'

type Call = {
  capability: string
  input: Record<string, unknown>
  /** What the adapter would read via `assetsForSlot` — the whole point. */
  assets: readonly ResolvedAssetRef[]
}

/** Catalog with everything except image-to-image. */
function makeRouter(calls: Call[]) {
  const model = (capability: string, output: unknown): ModelCapability =>
    ({
      modelId: `${capability}-model`,
      provider: 'test',
      tags: [],
      capabilities: [capability],
      source: 'user' as const,
      async call(input: Record<string, unknown>, ctx: DispatchContext) {
        calls.push({ capability, input, assets: ctx.assets ?? [] })
        return { output }
      },
    }) as unknown as ModelCapability

  const models: Record<string, ModelCapability> = {
    'image-to-text': model('image-to-text', {
      modality: 'text',
      text: 'a red kite over a beach at noon, flat illustration',
      cost: 0.01,
      latencyMs: 10,
      model: 'test:vlm',
      provider: 'test',
    }),
    'text-to-image': model('text-to-image', {
      modality: 'image',
      assets: [{ assetId: 'asset-rendered', modality: 'image' }],
      cost: 0.2,
      latencyMs: 20,
      model: 'test:t2i',
      provider: 'test',
    }),
  }

  const router: CapabilityRouter = {
    checkSatisfiable: (cap) => {
      const m = models[cap]
      return m
        ? { ok: true, candidates: [m] }
        : { ok: false, reason: 'no-model-in-catalog', candidates: [] }
    },
    resolve: (cap) => {
      const m = models[cap]
      if (!m) {
        throw Object.assign(new Error(`NO_MODEL_FOR_CAPABILITY: ${cap}`), {
          code: 'NO_MODEL_FOR_CAPABILITY',
        })
      }
      return m
    },
  }
  return router
}

function makeRegistry() {
  const registry = new PatternRegistry()
  registry.register(createImageToImagePattern() as unknown as Pattern)
  registry.register(createImageToImageViaCaptionPattern() as unknown as Pattern)
  registry.register(createImageToTextPattern() as unknown as Pattern)
  registry.register(createTextToImagePattern() as unknown as Pattern)
  return registry
}

/**
 * Host bridge over a fixed ledger, backed by the production resolver so the
 * required-slot default rule (§5.7 "latest of modality") is the real one. Only
 * `resolveForDispatch` is exercised; the rest of the surface is inert here.
 */
function makeBridge(events: readonly AssetEvent[]): AgentAssetBridge {
  const index = buildAssetIndex(events)
  return {
    buildSeedAnnouncement: () => null,
    resolveForDispatch: ({ input, assetNeeds }) => {
      const res = resolveAssetReferences(
        input as { references?: AssetReferences },
        assetNeeds,
        index,
      )
      if (!res.ok) throw new Error(`ASSET_RESOLUTION_FAILED: ${res.error.code}`)
      return res.assets
    },
    recordOutput: ({ output }) => output,
    resolveHandles: () => [],
    recordedAssetIds: () => [],
  }
}

function assetEvent(
  assetId: string,
  handle: string,
  orderHint: number,
): AssetEvent {
  return {
    kind: 'asset',
    annotation: { assetId, handle, modality: 'image' },
    orderHint,
  }
}

describe('first-party alternatives', () => {
  it('completes an image-to-image job through the caption fallback when no i2i model exists', async () => {
    const calls: Call[] = []
    const events: JobEvent[] = []
    const rt = new InlineRuntime({
      alternatives: 'auto',
      store: new InMemoryJobStore() as never,
      registry: makeRegistry(),
      router: makeRouter(calls),
      onJobCreated: (jobId) => {
        rt.subscribe(jobId, (ev) => events.push(ev))
      },
    })

    const job = await rt.submitJob({
      patternId: 'image-to-image',
      input: { prompt: 'make it night' },
      assets: [{ slot: 'source', assetId: 'asset-source', modality: 'image' }],
    } as never)

    expect(job.status).toBe('done')

    // The chain actually ran: caption first, then render.
    expect(calls.map((c) => c.capability)).toEqual([
      'image-to-text',
      'text-to-image',
    ])
    // …and it captioned the image the caller asked to edit. No bridge here, so
    // the source has no ledger handle and rides the internal assetId channel.
    expect(calls[0]!.assets).toEqual([
      { slot: 'source', assetId: 'asset-source', modality: 'image' },
    ])
    // The parent's edit instruction reached the render step, glued to the caption.
    expect(String(calls[1]!.input.prompt)).toContain('make it night')
    expect(String(calls[1]!.input.prompt)).toContain('a red kite over a beach')

    // Output is the parent Pattern's shape — the meta's `degraded` flag is not
    // part of it, the degradation is reported by the event below.
    const output = job.output as Record<string, unknown>
    expect(output.modality).toBe('image')
    expect(output.assets).toEqual([
      { assetId: 'asset-rendered', modality: 'image' },
    ])
    expect(output.cost).toBeCloseTo(0.21)
    expect(output).not.toHaveProperty('degraded')

    // Fallback metadata: which path, where to, and what it costs semantically.
    const selected = events.filter((e) => e.type === 'job:alternative-selected')
    expect(selected).toHaveLength(1)
    const ev = selected[0]!
    if (ev.type !== 'job:alternative-selected') throw new Error('unreachable')
    expect(ev.alternativeId).toBe('via-caption')
    expect(ev.targetPatternId).toBe('meta_image-to-image-via-caption')
    expect(ev.losses).toEqual([
      'subject-identity',
      'composition',
      'mask-guidance',
    ])
    expect(ev.preserves).toEqual(['style'])
  })

  it('captions the source the caller pointed at, not the newest image in the ledger', async () => {
    // A host with a ledger (chat / agent): the meta's sub-step references are
    // resolved against it. image-to-text declares `source` REQUIRED, so leaving
    // the slot out does not mean "no image" — it means "latest image", which
    // here is a decoy generated after the source. The caption step has to name
    // its source explicitly through the handle channel to avoid that.
    const calls: Call[] = []
    const rt = new InlineRuntime({
      alternatives: 'auto',
      store: new InMemoryJobStore() as never,
      registry: makeRegistry(),
      router: makeRouter(calls),
      assetBridge: makeBridge([
        assetEvent('asset-source', 'image_1', 1),
        assetEvent('asset-decoy', 'image_2', 2),
      ]),
    })

    const job = await rt.submitJob({
      patternId: 'image-to-image',
      input: { prompt: 'make it night' },
      sessionId: 'session-1',
      assets: [
        {
          slot: 'source',
          assetId: 'asset-source',
          modality: 'image',
          handle: 'image_1',
        },
      ],
    } as never)

    expect(job.status).toBe('done')
    const caption = calls.find((c) => c.capability === 'image-to-text')!
    expect(caption.assets.map((a) => a.assetId)).toEqual(['asset-source'])
    // One image, once: the handle channel and the internal channel must not
    // both claim the same ref, or the VLM reads it twice.
    expect(caption.assets).toHaveLength(1)
  })

  it('carries every source image of a multi-source edit into the caption step', async () => {
    const calls: Call[] = []
    const rt = new InlineRuntime({
      alternatives: 'auto',
      store: new InMemoryJobStore() as never,
      registry: makeRegistry(),
      router: makeRouter(calls),
    })

    // image-to-image's `source` is array-cardinality (multi-source fusion), and
    // its optional `mask` has no meaning once the frame is regenerated from a
    // caption — the redirect drops it, which is the declared `mask-guidance` loss.
    await rt.submitJob({
      patternId: 'image-to-image',
      input: { prompt: 'merge them at night' },
      assets: [
        { slot: 'source', assetId: 'asset-a', modality: 'image' },
        { slot: 'source', assetId: 'asset-b', modality: 'image' },
        { slot: 'mask', assetId: 'asset-mask', modality: 'image' },
      ],
    } as never)

    const caption = calls.find((c) => c.capability === 'image-to-text')!
    expect(caption.assets.map((a) => a.assetId)).toEqual([
      'asset-a',
      'asset-b',
    ])
  })

  it('requests the draft render size through the declared text-to-image params', async () => {
    const calls: Call[] = []
    const rt = new InlineRuntime({
      alternatives: 'auto',
      store: new InMemoryJobStore() as never,
      registry: makeRegistry(),
      router: makeRouter(calls),
    })

    await rt.submitJob({
      patternId: 'image-to-image',
      input: { prompt: 'make it night' },
      assets: [{ slot: 'source', assetId: 'asset-source', modality: 'image' }],
    } as never)

    const render = calls.find((c) => c.capability === 'text-to-image')!
    expect(render.input.size).toBe('1024x1024')
    expect(render.input.n).toBe(1)
  })

  it('takes the primary path — and fires no degradation event — once an i2i model exists', async () => {
    const calls: Call[] = []
    const events: JobEvent[] = []
    const i2i = {
      modelId: 'i2i-model',
      provider: 'test',
      tags: [],
      capabilities: ['image-to-image'],
      source: 'user' as const,
      async call(input: Record<string, unknown>, ctx: DispatchContext) {
        calls.push({
          capability: 'image-to-image',
          input,
          assets: ctx.assets ?? [],
        })
        return {
          output: {
            modality: 'image',
            assets: [{ assetId: 'asset-edited', modality: 'image' }],
            cost: 0.1,
            latencyMs: 5,
            model: 'test:i2i',
            provider: 'test',
          },
        }
      },
    } as unknown as ModelCapability
    const router: CapabilityRouter = {
      checkSatisfiable: () => ({ ok: true, candidates: [i2i] }),
      resolve: () => i2i,
    }

    const rt = new InlineRuntime({
      alternatives: 'auto',
      store: new InMemoryJobStore() as never,
      registry: makeRegistry(),
      router,
      onJobCreated: (jobId) => {
        rt.subscribe(jobId, (ev) => events.push(ev))
      },
    })

    const job = await rt.submitJob({
      patternId: 'image-to-image',
      input: { prompt: 'make it night' },
      assets: [{ slot: 'source', assetId: 'asset-source', modality: 'image' }],
    } as never)

    expect(job.status).toBe('done')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.capability).toBe('image-to-image')
    expect(events.some((e) => e.type === 'job:alternative-selected')).toBe(false)
  })
})

// ── The other side of the same claim ──────────────────────────────────────
//
// image-to-image is the ONLY first-party pattern that ships a fallback, and
// that is a design position (each factory carries the reasoning next to its
// `alternatives:` field), not an unfinished list. A position is only worth
// anything if it is the actual behaviour, so these tests pin both halves: the
// registry really carries one entry, and every other capability really fails
// with the router's error instead of quietly producing something adjacent —
// speech read as a song, an unrelated clip in place of the frame you handed in.

/** Every first-party atomic, one factory call each. */
function allAtomics(): readonly Pattern[] {
  return [
    createTextToImagePattern(),
    createImageToImagePattern(),
    createImageToTextPattern(),
    createTextToVideoPattern(),
    createImageToVideoPattern(),
    createVideoToVideoPattern(),
    createTextToSpeechPattern(),
    createTextToAudioPattern(),
    createAutomaticSpeechRecognitionPattern(),
    createTextGenerationPattern(),
  ] as unknown as readonly Pattern[]
}

function makeFullRegistry() {
  const registry = new PatternRegistry()
  for (const p of allAtomics()) registry.register(p)
  registry.register(createImageToImageViaCaptionPattern() as unknown as Pattern)
  return registry
}

// Registration logs a schema advisory per pattern; build the registry once so
// the table below doesn't repeat it for every row.
const FULL_REGISTRY = makeFullRegistry()

/**
 * Router serving every capability EXCEPT `missing`, each through a model that
 * records the call. That is what makes "no model ran" an assertion rather than
 * a tautology: every neighbour a fallback could reach for is right there in the
 * catalog, and the run still has to fail.
 */
function makeRouterMissing(missing: string, calls: Call[]): CapabilityRouter {
  const modelFor = (capability: string): ModelCapability =>
    ({
      modelId: `${capability}-model`,
      provider: 'test',
      tags: [],
      capabilities: [capability],
      source: 'user' as const,
      async call(input: Record<string, unknown>, ctx: DispatchContext) {
        calls.push({ capability, input, assets: ctx.assets ?? [] })
        return { output: { modality: 'text', text: '', cost: 0, latencyMs: 0 } }
      },
    }) as unknown as ModelCapability

  return {
    checkSatisfiable: (cap) =>
      cap === missing
        ? { ok: false, reason: 'no-model-in-catalog', candidates: [] }
        : { ok: true, candidates: [modelFor(cap)] },
    resolve: (cap) => {
      if (cap === missing) {
        throw Object.assign(new Error(`NO_MODEL_FOR_CAPABILITY: ${cap}`), {
          code: 'NO_MODEL_FOR_CAPABILITY',
        })
      }
      return modelFor(cap)
    },
  }
}

/** A realistic call per capability, so the failure is about the missing model. */
const NO_FALLBACK_JOBS: readonly {
  patternId: string
  input: Record<string, unknown>
  assets?: readonly ResolvedAssetRef[]
}[] = [
  { patternId: 'text-to-image', input: { prompt: 'a red kite over a beach' } },
  {
    patternId: 'image-to-text',
    input: { mode: 'describe' },
    assets: [{ slot: 'source', assetId: 'asset-photo', modality: 'image' }],
  },
  { patternId: 'text-to-video', input: { prompt: 'a kite riding a thermal' } },
  {
    patternId: 'image-to-video',
    input: { prompt: 'gentle drift' },
    assets: [{ slot: 'startFrame', assetId: 'asset-still', modality: 'image' }],
  },
  {
    patternId: 'video-to-video',
    input: { mode: 'restyle', prompt: 'noir' },
    assets: [{ slot: 'source', assetId: 'asset-clip', modality: 'video' }],
  },
  { patternId: 'text-to-speech', input: { text: 'Welcome to the show.' } },
  { patternId: 'text-to-audio', input: { prompt: 'lo-fi beat, 90 bpm, rain' } },
  {
    patternId: 'automatic-speech-recognition',
    input: { language: 'en-US' },
    assets: [{ slot: 'source', assetId: 'asset-rec', modality: 'audio' }],
  },
  { patternId: 'text-generation', input: { prompt: 'summarise this' } },
]

describe('capabilities that deliberately ship no alternative', () => {
  it('ships exactly one first-party alternative, on image-to-image', () => {
    const withAlternatives = allAtomics()
      .map((p) => ({
        id: p.id,
        alternatives: FULL_REGISTRY.getEntry(p.id)?.alternatives ?? [],
      }))
      .filter((e) => e.alternatives.length > 0)

    expect(withAlternatives.map((e) => e.id)).toEqual(['image-to-image'])
    expect(withAlternatives[0]!.alternatives.map((a) => a.id)).toEqual([
      'via-caption',
    ])

    // …and the table below covers every one of the others, so a capability
    // added later cannot slip past the fail-loud check unexamined.
    expect([...NO_FALLBACK_JOBS.map((j) => j.patternId)].sort()).toEqual(
      allAtomics()
        .map((p) => p.id)
        .filter((id) => id !== 'image-to-image')
        .sort(),
    )
  })

  it.each(NO_FALLBACK_JOBS)(
    'fails $patternId with the router error instead of redirecting',
    async ({ patternId, input, assets }) => {
      const calls: Call[] = []
      const events: JobEvent[] = []
      const rt = new InlineRuntime({
        alternatives: 'auto',
        store: new InMemoryJobStore() as never,
        registry: FULL_REGISTRY,
        router: makeRouterMissing(patternId, calls),
        onJobCreated: (jobId) => {
          rt.subscribe(jobId, (ev) => events.push(ev))
        },
      })

      await expect(
        rt.submitJob({
          patternId,
          input,
          ...(assets ? { assets } : {}),
        } as never),
      ).rejects.toThrow(/NO_MODEL_FOR_CAPABILITY/)

      // No model ran: the job did not quietly land on a neighbouring capability.
      expect(calls).toEqual([])
      expect(events.some((e) => e.type === 'job:alternative-selected')).toBe(
        false,
      )
      expect(events.some((e) => e.type === 'job:failed')).toBe(true)
    },
  )
})
