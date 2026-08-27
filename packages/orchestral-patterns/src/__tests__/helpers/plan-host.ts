// A real host for the plan interpreter's tests: PatternRegistry → mock
// ModelCapability envelopes → default router → InlineRuntime over an
// InMemoryJobStore, plus the `job:step` observer that is how a caller SEES a
// dedup hit (the runtime never says "cached"; it hands the meta an existing row
// and the child job id repeats).
//
// Mocks, not stubs of the runtime: every claim the plan tests make — levels run
// concurrently, an untouched step keeps its child job id, a failing step's own
// code reaches the plan's job row — is a claim about the engine, so the engine
// has to be the real one. The only fakes are the four model envelopes at the
// very bottom, which is the same seam examples/incremental-rerun uses.
//
// Not a test file (no `.test.ts` suffix) — vitest's include pattern skips it.

import {
  PatternRegistry,
  silentDiagnosticsLogger,
  type Capability,
  type DispatchContext,
  type DispatchResult,
  type Job,
  type Modality,
  type ModelCapability,
  type Pattern,
  type PatternId,
} from '@orchestral/core'
import { InMemoryJobStore } from '@orchestral/core/memory'
import { createDefaultCapabilityRouter } from '@orchestral/core/routing'
import { InlineRuntime, type InlineRuntimeInit } from '@orchestral/runtime'
import { MODEL_SPEC_VERSION } from '@orchestral/core'
import { vi, type MockInstance } from 'vitest'

import { createImageBestOfNMeta } from '../../meta/image-best-of-n'
import { createImageToTextPattern } from '../../atomic/image-to-text'
import { createImageToVideoPattern } from '../../atomic/image-to-video'
import { createTextGenerationPattern } from '../../atomic/text-generation'
import { createTextToImagePattern } from '../../atomic/text-to-image'
import type {
  ImageToTextOutput,
  ImageToVideoOutput,
  TextGenerationOutput,
  TextToImageOutput,
} from '../../index'

const PNG = 'data:image/png;base64,aVZCT1J3MEtHZ29BQUFBTlNVaEVVZ0E='
const MP4 = 'data:video/mp4;base64,AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQ=='

export type MockCapability =
  | 'text-generation'
  | 'text-to-image'
  | 'image-to-video'
  | 'image-to-text'

/** One model call, seen from the outside: when it started and what it was asked. */
export interface CallEvent {
  phase: 'enter' | 'exit'
  capability: MockCapability
  prompt: string
  /** How many calls of this capability were in flight when this one started. */
  inFlight: number
}

/** The four envelopes, by the name a test spies on. */
export type MockName =
  | 'textGeneration'
  | 'textToImage'
  | 'imageToVideo'
  | 'imageToText'

export interface MockModels {
  getModels: (cap: Capability) => readonly ModelCapability[]
  models: Record<MockName, ModelCapability>
  /** Every enter/exit, in order. The concurrency evidence. */
  trace: CallEvent[]
  /** Peak simultaneous calls per capability — > 1 means a level really overlapped. */
  peak: Record<MockCapability, number>
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

function promptOf(input: unknown): string {
  if (input !== null && typeof input === 'object' && 'prompt' in input) {
    const p = (input as { prompt?: unknown }).prompt
    if (typeof p === 'string') return p
  }
  return ''
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
 * Four envelopes, one per capability the plan fixtures reach. Each mints a
 * FRESH asset id per call (a counter), like a real provider: a dedup hit
 * therefore hands back the id the ORIGINAL call minted, which is how a test
 * tells a cached step from one that ran again and happened to look the same.
 */
export function createMockModels(
  options: { latencyMs?: number } = {},
): MockModels {
  const latency = options.latencyMs ?? 0
  const trace: CallEvent[] = []
  const peak: Record<MockCapability, number> = {
    'text-generation': 0,
    'text-to-image': 0,
    'image-to-video': 0,
    'image-to-text': 0,
  }
  const live: Record<MockCapability, number> = { ...peak }
  let imageN = 0
  let clipN = 0

  /** Bracket one call so the trace records the overlap, not just the order. */
  const around = async <T,>(
    cap: MockCapability,
    prompt: string,
    body: () => Promise<T>,
  ): Promise<T> => {
    live[cap] += 1
    peak[cap] = Math.max(peak[cap], live[cap])
    trace.push({ phase: 'enter', capability: cap, prompt, inFlight: live[cap] })
    try {
      const result = await body()
      trace.push({ phase: 'exit', capability: cap, prompt, inFlight: live[cap] })
      return result
    } finally {
      live[cap] -= 1
    }
  }

  const textGeneration = envelope(
    'text-generation',
    ['text'],
    ['text'],
    async <I, O>(input: I): Promise<DispatchResult<O>> => {
      const prompt = promptOf(input)
      return around('text-generation', prompt, async () => {
        const startedAt = Date.now()
        await sleep(latency)
        const output: TextGenerationOutput = {
          modality: 'text',
          // Deterministic: the same prompt yields the same line, so a reader
          // can see the next step's input is this one's output verbatim.
          text: `Still of ${prompt}: centred in frame, soft morning light.`,
          cost: 0.01,
          latencyMs: Date.now() - startedAt,
          model: 'mock:mock-text-generation',
          provider: 'mock',
          finishReason: 'stop',
        }
        return { output: output as O }
      })
    },
  )

  const textToImage = envelope(
    'text-to-image',
    ['text'],
    ['image'],
    async <I, O>(input: I): Promise<DispatchResult<O>> =>
      around('text-to-image', promptOf(input), async () => {
        const startedAt = Date.now()
        await sleep(latency)
        imageN += 1
        const output: TextToImageOutput = {
          modality: 'image',
          assets: [{ assetId: `img-${imageN}`, modality: 'image', url: PNG }],
          cost: 0.02,
          latencyMs: Date.now() - startedAt,
          model: 'mock:mock-text-to-image',
          provider: 'mock',
        }
        return { output: output as O }
      }),
  )

  const imageToVideo = envelope(
    'image-to-video',
    ['image', 'text'],
    ['video'],
    async <I, O>(input: I, ctx: DispatchContext): Promise<DispatchResult<O>> =>
      around('image-to-video', promptOf(input), async () => {
        // Fail closed: an image-to-video call with no start frame is a wiring
        // bug in the interpreter's asset channel, not a text-to-video call.
        const startFrame = (ctx.assets ?? []).find((a) => a.slot === 'startFrame')
        if (startFrame === undefined) {
          throw new Error(
            'image-to-video call: ctx.assets carries no startFrame — the plan must ' +
              'thread the still through PatternRef.assets',
          )
        }
        const startedAt = Date.now()
        await sleep(latency)
        clipN += 1
        const output: ImageToVideoOutput = {
          modality: 'video',
          assets: [{ assetId: `clip-${clipN}`, modality: 'video', url: MP4 }],
          cost: 0.03,
          latencyMs: Date.now() - startedAt,
          model: 'mock:mock-image-to-video',
          provider: 'mock',
          videoDurationMs: 4000,
        }
        return { output: output as O }
      }),
  )

  const imageToText = envelope(
    'image-to-text',
    ['image', 'text'],
    ['text'],
    async <I, O>(input: I): Promise<DispatchResult<O>> => {
      const prompt = promptOf(input)
      const json =
        (input as { responseFormat?: unknown } | null)?.responseFormat === 'json'
      return around('image-to-text', prompt, async () => {
        const startedAt = Date.now()
        await sleep(latency)
        const output: ImageToTextOutput = {
          modality: 'text',
          // meta_image-best-of-n asks for JSON and parses it; the plan's own
          // judge step asks for prose. One mock serves both.
          text: json
            ? JSON.stringify({ best_image_index: 0, reason: 'sharpest subject' })
            : 'Take 0 is the strongest: the subject reads cleanly against the light.',
          cost: 0.01,
          latencyMs: Date.now() - startedAt,
          model: 'mock:mock-image-to-text',
          provider: 'mock',
        }
        return { output: output as O }
      })
    },
  )

  const all = [textGeneration, textToImage, imageToVideo, imageToText]
  return {
    getModels: (cap) => all.filter((env) => env.capabilities.includes(cap)),
    models: { textGeneration, textToImage, imageToVideo, imageToText },
    trace,
    peak,
  }
}

// ── The host ────────────────────────────────────────────────────────────

/** One `job:step` on a plan's own stream. */
export interface StepRecord {
  stepId: string
  patternId: string
  childJobId: string
  assetIds: readonly string[]
}

export interface RunTrace<O = unknown> {
  job: Job<unknown, O>
  /** One record per `job:step` on the plan job's stream, in settle order. */
  steps: readonly StepRecord[]
  /** patternId of every row the runtime INSERTed this run, in order. */
  inserted: readonly string[]
}

export interface PlanHost {
  registry: PatternRegistry
  runtime: InlineRuntime
  store: InMemoryJobStore
  models: MockModels
  /** Each mock's `call`, spied — "the model was not called" as a count. */
  calls: Record<MockName, MockInstance<ModelCapability['call']>>
  /** Submit one pattern and collect what the runtime reported about it. */
  run<O = unknown>(
    patternId: PatternId,
    input: unknown,
    sessionId: string,
  ): Promise<RunTrace<O>>
}

export interface PlanHostInit {
  /** Plan patterns (or anything else) to register on top of the four atomics. */
  extra?: readonly Pattern[]
  /** Share a store across two hosts (the restart case). */
  store?: InMemoryJobStore
  latencyMs?: number
  /** Register `meta_image-best-of-n` too. Off by default: it is a real meta and
   *  its inner steps show up on the same event stream. */
  bestOfN?: boolean
}

export function makePlanHost(init: PlanHostInit = {}): PlanHost {
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  registry.register(createTextGenerationPattern())
  registry.register(createTextToImagePattern())
  registry.register(createImageToVideoPattern())
  registry.register(createImageToTextPattern())
  if (init.bestOfN === true) registry.register(createImageBestOfNMeta())
  for (const pattern of init.extra ?? []) registry.register(pattern)

  const models = createMockModels(
    init.latencyMs === undefined ? {} : { latencyMs: init.latencyMs },
  )
  const router = createDefaultCapabilityRouter({ getModels: models.getModels })
  const store = init.store ?? new InMemoryJobStore()

  // The subscription has to be made inside `onJobCreated`: `submitJob` resolves
  // only once the job is terminal, so subscribing afterwards observes nothing.
  let pending: { steps: StepRecord[]; inserted: string[]; rootId?: string } | undefined
  let runtimeRef: InlineRuntime | undefined
  const onJobCreated: NonNullable<InlineRuntimeInit['onJobCreated']> = (
    jobId,
    spec,
  ) => {
    if (pending === undefined || runtimeRef === undefined) return
    pending.inserted.push(spec.patternId)
    if (pending.rootId !== undefined) return
    pending.rootId = jobId
    const { steps } = pending
    runtimeRef.subscribe(jobId, (ev) => {
      if (ev.type !== 'job:step') return
      steps.push({
        stepId: ev.stepId,
        patternId: ev.patternId,
        childJobId: ev.childJobId,
        assetIds: (ev.assets ?? []).map((a) => a.assetId),
      })
    })
  }

  const runtime = new InlineRuntime({ store, registry, router, onJobCreated })
  runtimeRef = runtime

  const calls = {
    textGeneration: vi.spyOn(models.models.textGeneration, 'call'),
    textToImage: vi.spyOn(models.models.textToImage, 'call'),
    imageToVideo: vi.spyOn(models.models.imageToVideo, 'call'),
    imageToText: vi.spyOn(models.models.imageToText, 'call'),
  }

  return {
    registry,
    runtime,
    store,
    models,
    calls,
    async run<O>(patternId: PatternId, input: unknown, sessionId: string) {
      const current = { steps: [] as StepRecord[], inserted: [] as string[] }
      pending = current
      try {
        const job = await runtime.submitJob<unknown, O>({
          patternId,
          input,
          sessionId,
        })
        return { job, steps: current.steps, inserted: current.inserted }
      } finally {
        pending = undefined
      }
    },
  }
}
