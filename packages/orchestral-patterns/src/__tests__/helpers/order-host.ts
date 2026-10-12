// A real host whose model calls settle in an order the test chooses — the
// harness for meta-order-independence.test.ts, shared so each shipped meta's
// test is an input and a text script rather than a runtime of its own.
//
// The engine is the real one: PatternRegistry with the real atomics and the
// meta under test, the default capability router over mock ModelCapability
// envelopes, InlineRuntime over an InMemoryJobStore — the construction
// plan-host.ts uses. What a step's key is made of is decided in there, so the
// engine is what the test has to run.
//
// Every mock call parks on a deferred. The driver lets a macrotask turn pass
// (`setImmediate`, which drains every microtask the last release set off),
// then releases one parked call — the oldest under 'fifo', the newest under
// 'lifo' — until the root job settles. Nothing waits on a clock, and a run
// that stops making progress fails on a turn cap instead of hanging.
//
// A mock's output is a pure function of what it was asked: the asset id is a
// digest of the capability, the input and the resolved assets, never a
// counter, and text answers come from a script keyed by the `system` prompt.
// Two runs in different orders therefore differ in nothing but the order —
// so any difference in the keys the runtime derives is the order's doing.
//
// Not a test file (no `.test.ts` suffix) — vitest's include pattern skips it.

import { createHash } from 'node:crypto'

import {
  AskUserChoicePayloadSchema,
  AskUserFormPayloadSchema,
  MODEL_SPEC_VERSION,
  PatternRegistry,
  silentDiagnosticsLogger,
  type AskUserChoiceAnswer,
  type AskUserConfirmAnswer,
  type AskUserFormAnswer,
  type AskUserHandler,
  type Capability,
  type DispatchContext,
  type DispatchResult,
  type Job,
  type JobSpec,
  type MetaPattern,
  type Modality,
  type ModelCapability,
} from '@orchestral/core'
import { InMemoryJobStore } from '@orchestral/core/memory'
import { createDefaultCapabilityRouter } from '@orchestral/core/routing'
import { InlineRuntime } from '@orchestral/runtime'

import {
  createAutomaticSpeechRecognitionPattern,
  type AutomaticSpeechRecognitionOutput,
} from '../../atomic/automatic-speech-recognition'
import { createImageToImagePattern, type ImageToImageOutput } from '../../atomic/image-to-image'
import { createImageToTextPattern, type ImageToTextOutput } from '../../atomic/image-to-text'
import { createImageToVideoPattern, type ImageToVideoOutput } from '../../atomic/image-to-video'
import { createTextGenerationPattern, type TextGenerationOutput } from '../../atomic/text-generation'
import { createTextToAudioPattern, type TextToAudioOutput } from '../../atomic/text-to-audio'
import { createTextToImagePattern, type TextToImageOutput } from '../../atomic/text-to-image'
import { createTextToSpeechPattern, type TextToSpeechOutput } from '../../atomic/text-to-speech'
import type { MetaCommonDeps } from '../../meta/_shared/meta-utils'

export type ReleaseOrder = 'fifo' | 'lifo'

/**
 * What text-generation answers, keyed by the `system` prompt it is called
 * with: a JSON value, or a function of the user prompt returning one. A call
 * whose system prompt has no entry fails, so a script that misses a stage is
 * a loud error rather than an answer nobody wrote.
 */
export type TextScript = Readonly<Record<string, unknown>>

export interface OrderHostInit<I = unknown, O = unknown> {
  /** The meta under test, built by its factory over the stub host deps. */
  meta: (deps: MetaCommonDeps) => MetaPattern<I, O>
  /** Registers the metas the one under test dispatches (meta_storyboard's best-of-n). */
  nested?: (registry: PatternRegistry) => void
  text: TextScript
  input: I
  sessionId: string
}

/** One row the run INSERTed below the root. */
export interface ChildRow {
  jobId: string
  spec: JobSpec
  idempotencyKey: string
}

export interface OrderRun {
  order: ReleaseOrder
  root: Job
  /**
   * Each released call, in release order: `${capability}:${digest}#${n}`, n
   * counting the identical calls that parked before it.
   */
  released: readonly string[]
  /** Every row below the root, in the order the runtime inserted them. */
  children: readonly ChildRow[]
}

/** Macrotask turns per run before the driver gives up. Far above any meta here. */
const MAX_TURNS = 500

/** Twelve hex characters of a sha256 over the JSON of `parts`. */
function digest(...parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 12)
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

interface Parked {
  label: string
  release: () => void
}

const envelopeOf = {
  cost: 0.01,
  latencyMs: 0,
  provider: 'mock',
} as const

function field(input: unknown, key: string): unknown {
  return input !== null && typeof input === 'object'
    ? (input as Record<string, unknown>)[key]
    : undefined
}

/**
 * One envelope per capability the shipped metas reach. `answer` builds the
 * output from the input and the digest of (capability, input, assets); the
 * call then parks until the driver releases it.
 */
function mockModels(text: TextScript, park: (label: string) => Promise<void>) {
  const envelope = (
    cap: Capability,
    inputs: readonly Modality[],
    outputs: readonly Modality[],
    answer: (input: unknown, id: string) => unknown,
  ): ModelCapability => ({
    specificationVersion: MODEL_SPEC_VERSION,
    capabilities: [cap],
    provider: 'mock',
    modelId: `mock-${cap}`,
    inputs,
    outputs,
    tags: [],
    source: 'user',
    call: async <I, O>(input: I, ctx: DispatchContext): Promise<DispatchResult<O>> => {
      const assets = (ctx.assets ?? []).map((a) => ({ slot: a.slot, assetId: a.assetId }))
      const id = digest(cap, input, assets)
      // Computed before parking, so a script error fails the call it belongs
      // to rather than whichever call happens to be released next.
      const output = answer(input, id)
      await park(`${cap}:${id}`)
      return { output: output as O }
    },
  })

  const model = (cap: Capability) => `mock:mock-${cap}`

  return [
    envelope('text-generation', ['text'], ['text'], (input): TextGenerationOutput => {
      const system = String(field(input, 'system') ?? '')
      if (!Object.hasOwn(text, system)) {
        throw new Error(
          `order-host: no scripted text-generation answer for the system prompt "${system.slice(0, 60)}…"`,
        )
      }
      const entry = text[system]
      const value =
        typeof entry === 'function'
          ? (entry as (prompt: string) => unknown)(String(field(input, 'prompt') ?? ''))
          : entry
      return {
        modality: 'text',
        text: JSON.stringify(value),
        ...envelopeOf,
        model: model('text-generation'),
        finishReason: 'stop',
      }
    }),
    envelope('text-to-image', ['text', 'image'], ['image'], (_input, id): TextToImageOutput => ({
      modality: 'image',
      assets: [{ assetId: `img-${id}`, modality: 'image' }],
      ...envelopeOf,
      model: model('text-to-image'),
    })),
    envelope('image-to-image', ['image', 'text'], ['image'], (_input, id): ImageToImageOutput => ({
      modality: 'image',
      assets: [{ assetId: `i2i-${id}`, modality: 'image' }],
      ...envelopeOf,
      model: model('image-to-image'),
    })),
    envelope('image-to-video', ['image', 'text'], ['video'], (_input, id): ImageToVideoOutput => ({
      modality: 'video',
      assets: [{ assetId: `clip-${id}`, modality: 'video' }],
      ...envelopeOf,
      model: model('image-to-video'),
      videoDurationMs: 4000,
    })),
    // The best-of-n judge asks for JSON and gets candidate 0; anything else
    // gets prose.
    envelope('image-to-text', ['image', 'text'], ['text'], (input): ImageToTextOutput => ({
      modality: 'text',
      text:
        field(input, 'responseFormat') === 'json'
          ? JSON.stringify({ best_image_index: 0, reason: 'mock judge: the first candidate' })
          : 'mock caption',
      ...envelopeOf,
      model: model('image-to-text'),
    })),
    envelope('text-to-speech', ['text'], ['audio'], (_input, id): TextToSpeechOutput => ({
      modality: 'audio',
      assets: [{ assetId: `vo-${id}`, modality: 'audio' }],
      ...envelopeOf,
      model: model('text-to-speech'),
      audioDurationMs: 3000,
    })),
    envelope('text-to-audio', ['text'], ['audio'], (_input, id): TextToAudioOutput => ({
      modality: 'audio',
      assets: [{ assetId: `music-${id}`, modality: 'audio' }],
      ...envelopeOf,
      model: model('text-to-audio'),
      audioDurationMs: 10000,
    })),
    envelope(
      'automatic-speech-recognition',
      ['audio'],
      ['text'],
      (): AutomaticSpeechRecognitionOutput => ({
        modality: 'text',
        text: 'mock transcript',
        segments: [{ startSecond: 0, endSecond: 2.5, text: 'mock transcript' }],
        ...envelopeOf,
        model: model('automatic-speech-recognition'),
      }),
    ),
  ]
}

/** Host ops every deliverable meta may take, each returning an id derived from its arguments. */
const hostDeps: MetaCommonDeps = {
  addBackgroundAudio: async (video, audio, opts) => ({
    assetId: `mux-${digest(video, audio, opts?.mode ?? 'mix')}`,
  }),
  concatVideos: async (clips) => ({ assetId: `concat-${digest(clips)}` }),
  addSubtitles: async (video, subtitle, opts) => ({
    assetId: `sub-${digest(video, subtitle, opts?.mode ?? 'soft')}`,
  }),
  createSubtitleAsset: async (srt) => ({ assetId: `srt-${digest(srt)}` }),
  stillToVideo: async (image, audio) => ({ assetId: `seg-${digest(image, audio)}` }),
  recordSessionAsset: async (sessionId, assetId, modality) => ({
    handle: `handle-${digest(sessionId, assetId, modality)}`,
  }),
}

/**
 * Answers every ask at once, by kind, with the answer core's schemas define:
 * confirm → confirmed; choice → the first option (`mode` echoed for a meta
 * whose own answer schema reads it); form → the payload's own values.
 */
const askUser: AskUserHandler = async (request) => {
  switch (request.kind) {
    case 'confirm':
      return { confirmed: true } satisfies AskUserConfirmAnswer
    case 'choice': {
      const payload = AskUserChoicePayloadSchema.parse(request.payload)
      const first = payload.options[0]
      if (first === undefined) throw new Error('order-host: a choice with no options')
      return { mode: payload.mode, chosen: first.value } satisfies AskUserChoiceAnswer & {
        mode: 'single'
      }
    }
    case 'form': {
      const payload = AskUserFormPayloadSchema.parse(request.payload)
      const values: AskUserFormAnswer['values'] = {}
      for (const f of payload.fields) if (f.value !== undefined) values[f.key] = f.value
      return { values } satisfies AskUserFormAnswer
    }
    default:
      throw new Error(
        `order-host: no answer for an ask of kind "${String((request as { kind: unknown }).kind)}"`,
      )
  }
}

/**
 * Run `init.meta` once on a fresh host, releasing parked model calls in
 * `order`, and report what the runtime derived for every row below the root.
 */
export async function runInOrder<I, O>(
  init: OrderHostInit<I, O>,
  order: ReleaseOrder,
): Promise<OrderRun> {
  const pending: Parked[] = []
  // Identical calls (best-of-n's candidates share pattern and input) digest
  // alike, so each label carries how many identical calls parked before it —
  // otherwise releasing them in another order would look like the same order.
  const parkedBefore = new Map<string, number>()
  const park = (call: string): Promise<void> =>
    new Promise((resolve) => {
      const n = parkedBefore.get(call) ?? 0
      parkedBefore.set(call, n + 1)
      pending.push({ label: `${call}#${n}`, release: resolve })
    })

  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  registry.register(createTextGenerationPattern())
  registry.register(createTextToImagePattern())
  registry.register(createImageToImagePattern())
  registry.register(createImageToVideoPattern())
  registry.register(createImageToTextPattern())
  registry.register(createTextToSpeechPattern())
  registry.register(createTextToAudioPattern())
  registry.register(createAutomaticSpeechRecognitionPattern())
  init.nested?.(registry)
  const meta = init.meta(hostDeps)
  registry.register(meta)

  const models = mockModels(init.text, park)
  const router = createDefaultCapabilityRouter({
    getModels: (cap) => models.filter((m) => m.capabilities.includes(cap)),
  })

  const rows: Array<{ jobId: string; spec: JobSpec }> = []
  const runtime = new InlineRuntime({
    store: new InMemoryJobStore(),
    registry,
    router,
    askUser,
    onJobCreated: (jobId, spec) => {
      rows.push({ jobId, spec })
    },
  })

  let settled = false
  const outcome = runtime.submitJob({
    patternId: meta.id,
    input: init.input,
    sessionId: init.sessionId,
  })
  const markSettled = (): void => {
    settled = true
  }
  outcome.then(markSettled, markSettled)

  const released: string[] = []
  for (let turn = 0; !settled; turn++) {
    if (turn >= MAX_TURNS) {
      throw new Error(
        `order-host: ${meta.id} (${order}) had not settled after ${MAX_TURNS} turns; ` +
          `${pending.length} call(s) parked: ${pending.map((p) => p.label).join(', ')}`,
      )
    }
    await nextTurn()
    if (settled) break
    const next = order === 'fifo' ? pending.shift() : pending.pop()
    if (next === undefined) continue
    released.push(next.label)
    next.release()
  }
  const root = await outcome

  const [first, ...below] = rows
  if (first === undefined || first.jobId !== root.id) {
    throw new Error(`order-host: the first row inserted is not ${meta.id}'s root job`)
  }
  const children: ChildRow[] = []
  for (const row of below) {
    const job = await runtime.pollJob(row.jobId)
    children.push({ ...row, idempotencyKey: job.idempotencyKey })
  }
  return { order, root, released, children }
}
