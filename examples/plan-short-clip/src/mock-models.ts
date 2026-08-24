// Host-local mock models — the part the @orchestral packages deliberately
// don't ship, hand-written here the way scripts/smoke-dist.mjs does it. This
// demo is about a plan's dedup, not a provider, so there is no API key and no
// provider SDK: each `call` sleeps for an artificial latency and returns an
// output shaped exactly like the pattern's own outputs schema. The latency is
// the point — it is what makes a dedup hit (~0 ms) visible next to a real
// dispatch (hundreds of ms).
//
// Two rules the mocks follow so the demo cannot fool itself:
//   • Every produced asset gets a FRESH id per call (a counter), like a real
//     provider would. A dedup hit therefore hands back the asset id the
//     ORIGINAL call minted — that is how a reader can tell a hit from a re-run
//     that happened to produce the same bytes.
//   • Nothing here looks at the session or the job. The mocks cannot tell a
//     first call from a repeat, so any "cached" behaviour in the transcript is
//     the runtime's doing, not theirs.

import {
  MODEL_SPEC_VERSION,
  type Capability,
  type DispatchContext,
  type DispatchResult,
  type Modality,
  type ModelCapability,
} from '@orchestral/core'
import type {
  ImageToVideoOutput,
  TextGenerationOutput,
  TextToImageOutput,
} from '@orchestral/patterns'

export type MockCapability = 'text-generation' | 'text-to-image' | 'image-to-video'

export interface MockModelsOptions {
  /**
   * Artificial latency per call, in ms, keyed by capability. Default 0 for
   * every capability (what the smoke test uses); main.ts passes 300–500 so a
   * hit is visible next to a run.
   */
  latencyMs?: Partial<Record<MockCapability, number>>
}

export interface MockModels {
  /** Hand straight to `createDefaultCapabilityRouter({ getModels })`. */
  getModels: (cap: Capability) => readonly ModelCapability[]
  /**
   * The three envelopes, exposed so a test can `vi.spyOn(models.textToImage,
   * 'call')` and count how many times the runtime actually reached a model.
   */
  models: {
    textGeneration: ModelCapability
    textToImage: ModelCapability
    imageToVideo: ModelCapability
  }
}

// Minimal payloads — the standalone host has no asset store, so `url` is a
// data URI. Both pass the patterns' `z.string().url()`.
const PNG_DATA_URI = 'data:image/png;base64,aVZCT1J3MEtHZ29BQUFBTlNVaEVVZ0E='
const MP4_DATA_URI = 'data:video/mp4;base64,AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQ=='

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

function readPrompt(input: unknown, cap: MockCapability): string {
  if (input && typeof input === 'object' && 'prompt' in input) {
    const prompt = (input as { prompt?: unknown }).prompt
    if (typeof prompt === 'string' && prompt.length > 0) return prompt
  }
  throw new Error(`${cap} call: input.prompt (non-empty string) is required`)
}

function envelope(
  cap: MockCapability,
  inputs: readonly Modality[],
  outputs: readonly Modality[],
  call: ModelCapability['call'],
): ModelCapability {
  return {
    specificationVersion: MODEL_SPEC_VERSION,
    capabilities: [cap],
    provider: 'mock',
    modelId: `mock-${cap}`,
    inputs,
    outputs,
    tags: [],
    source: 'user',
    call,
  }
}

/**
 * Build the three mock envelopes plus the `getModels(cap)` the default router
 * consumes. One model per capability, so routing is a formality and every
 * dispatch lands on the mock for its capability.
 *
 * Each reports a small `cost`, because a plan's output totals them: `steps[]`
 * carries one per step and `cost` is `sumCosts` of the lot — null if ANY step
 * is unpriced, never a partial sum.
 */
export function createMockModels(options: MockModelsOptions = {}): MockModels {
  const latency = (cap: MockCapability): number => options.latencyMs?.[cap] ?? 0
  // Per-call counters — see the header: a fresh id per call is what lets the
  // transcript distinguish "served from the stored row" from "re-rendered".
  let imageN = 0
  let clipN = 0

  const textGeneration = envelope(
    'text-generation',
    ['text'],
    ['text'],
    async function mockTextGeneration<I, O>(input: I): Promise<DispatchResult<O>> {
      const prompt = readPrompt(input, 'text-generation')
      const system = (input as { system?: unknown })?.system
      const startedAt = Date.now()
      await sleep(latency('text-generation'))
      // Deterministic on the WHOLE input, not just the prompt: the same pair
      // yields the same line (so a reader can see step 2's input is step 1's
      // output verbatim), and two steps that share a subject but differ in
      // their direction do not come back identical.
      const output: TextGenerationOutput = {
        modality: 'text',
        text:
          typeof system === 'string'
            ? `${prompt} — as directed: "${system.slice(0, 38)}…"`
            : `Still of ${prompt}: centred in frame, soft morning light.`,
        cost: 0.001,
        latencyMs: Date.now() - startedAt,
        model: 'mock:mock-text-generation',
        provider: 'mock',
        finishReason: 'stop',
      }
      return { output: output as O }
    },
  )

  const textToImage = envelope(
    'text-to-image',
    ['text'],
    ['image'],
    async function mockTextToImage<I, O>(input: I): Promise<DispatchResult<O>> {
      readPrompt(input, 'text-to-image')
      const startedAt = Date.now()
      await sleep(latency('text-to-image'))
      imageN += 1
      const output: TextToImageOutput = {
        modality: 'image',
        assets: [{ assetId: `img-${imageN}`, modality: 'image', url: PNG_DATA_URI }],
        cost: 0.02,
        latencyMs: Date.now() - startedAt,
        model: 'mock:mock-text-to-image',
        provider: 'mock',
      }
      return { output: output as O }
    },
  )

  const imageToVideo = envelope(
    'image-to-video',
    ['image', 'text'],
    ['video'],
    async function mockImageToVideo<I, O>(
      _input: I,
      ctx: DispatchContext,
    ): Promise<DispatchResult<O>> {
      // The still arrives in ctx.assets under the pattern's `startFrame` slot.
      // The plan put it there: `"assets": { "startFrame": "$render.assets[0]" }`
      // materialises as `PatternRef.assets`, the machine-to-machine channel.
      // Fail closed: an image-to-video call with no start frame is a wiring
      // bug, not a text-to-video call.
      const startFrame = (ctx.assets ?? []).find((a) => a.slot === 'startFrame')
      if (!startFrame) {
        throw new Error(
          'image-to-video call: ctx.assets carries no startFrame — the plan must ' +
            'bind the still through `assets`, not through `input`',
        )
      }
      const startedAt = Date.now()
      await sleep(latency('image-to-video'))
      clipN += 1
      const output: ImageToVideoOutput = {
        modality: 'video',
        assets: [{ assetId: `clip-${clipN}`, modality: 'video', url: MP4_DATA_URI }],
        cost: 0.05,
        latencyMs: Date.now() - startedAt,
        model: 'mock:mock-image-to-video',
        provider: 'mock',
        videoDurationMs: 4000,
      }
      return { output: output as O }
    },
  )

  const all = [textGeneration, textToImage, imageToVideo]
  return {
    getModels: (cap) => all.filter((env) => env.capabilities.includes(cap)),
    models: { textGeneration, textToImage, imageToVideo },
  }
}
