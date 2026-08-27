// The output gate on the middleware short-circuit path.
//
// `beforeDispatch` returning `{ kind: 'short-circuit', output }` skips the
// adapter entirely — a cache-hit middleware standing in for a dispatch that
// already happened. What it hands back becomes `job.output`, and for a child
// job the next step's input, so it makes exactly the claim an adapter's return
// makes: this is the Pattern's declared output shape. Unchecked, a stale cache
// entry — a schema that moved, a `data:` blob a bounded field no longer admits
// — was indistinguishable from a conforming one, and `output-fields.ts`'s
// "the bound is enforced on what an adapter returns, not only declared" had a
// path around it.
//
// Harness mirrors output-validation.test.ts: a real InlineRuntime over an
// in-memory store, schemas built from the first-party envelope shapes, so the
// gate is exercised against what a real catalog row declares.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type {
  AtomicPattern,
  CapabilityRouter,
  DispatchMiddleware,
  JobError,
  JobEvent,
  Modality,
  ModelCapability,
} from '@orchestral/core'
import {
  silentDiagnosticsLogger,
  boundedText,
  dispatchEnvelopeShape,
  PatternRegistry,
  producedAssetShape,
} from '@orchestral/core'
import { InMemoryJobStore } from '@orchestral/core/memory'

import { InlineRuntime, type InlineRuntimeInit } from '../inline'

const IMAGE_OUTPUT = z.object({
  ...dispatchEnvelopeShape,
  assets: z.array(z.object({ label: boundedText(64), ...producedAssetShape('image') })),
})

const PROMPT_INPUT = z.object({ prompt: z.string() })

const CONFORMING_OUTPUT = {
  cost: 0.01,
  latencyMs: 12,
  model: 'prov:A',
  provider: 'prov',
  assets: [{ label: 'final', assetId: 'asset_1', modality: 'image' as const }],
}

interface MismatchDetails {
  patternId: string
  kind: string
  issues: readonly { path: readonly (string | number)[]; message: string }[]
  rawOutput: unknown
}

function atomic(id: string): AtomicPattern {
  return {
    id,
    kind: 'atomic',
    description: `atomic ${id}`,
    outputs: IMAGE_OUTPUT,
    primary: { tool: { description: id, inputs: PROMPT_INPUT }, modelTags: [] },
  } as unknown as AtomicPattern
}

// A router whose model would fail the test if it were ever reached: the
// short-circuit path must not touch it.
function makeRouter(onCall: () => void): CapabilityRouter {
  const model = {
    modelId: 'A',
    provider: 'prov',
    tags: [],
    capabilities: [],
    inputs: ['text'] as Modality[],
    outputs: ['image'] as Modality[],
    source: 'user' as const,
    async call() {
      onCall()
      return { output: CONFORMING_OUTPUT }
    },
  } as unknown as ModelCapability
  return {
    checkSatisfiable: () => ({ ok: true, candidates: [model] }),
    resolve: () => model,
  }
}

function harness(opts: {
  middleware: readonly DispatchMiddleware[]
  init?: Partial<InlineRuntimeInit>
}) {
  let calls = 0
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  registry.register(atomic('cap'))
  const events: JobEvent[] = []
  const rt = new InlineRuntime({
    store: new InMemoryJobStore(),
    registry,
    router: makeRouter(() => {
      calls++
    }),
    middleware: opts.middleware,
    onJobCreated: (jobId) => {
      rt.subscribe(jobId, (ev) => events.push(ev))
    },
    ...opts.init,
  })
  return { rt, events, modelCalls: () => calls }
}

const shortCircuiting = (output: unknown): DispatchMiddleware => ({
  beforeDispatch: () => ({ kind: 'short-circuit', output }),
})

describe('the output gate on a middleware short-circuit', () => {
  it('a short-circuit output the schema rejects fails the job with OUTPUT_SCHEMA_MISMATCH', async () => {
    const stale = { text: 'a cached answer from an older schema' }
    const { rt, events, modelCalls } = harness({ middleware: [shortCircuiting(stale)] })

    const job = await rt.submitJob({ patternId: 'cap', input: { prompt: 'go' } })

    expect(job.status).toBe('error')
    expect(job.output).toBeNull()
    expect(job.error?.code).toBe('OUTPUT_SCHEMA_MISMATCH')
    // The same message and details an adapter's mismatch produces — the point
    // is that this path is not a second gate with its own vocabulary.
    expect(job.error?.message).toMatch(/^OUTPUT_SCHEMA_MISMATCH: cap \(atomic\)/)
    const details = job.error?.details as MismatchDetails
    expect(details.patternId).toBe('cap')
    expect(details.kind).toBe('atomic')
    expect(details.issues.map((i) => i.path.join('.'))).toEqual(
      expect.arrayContaining(['cost', 'latencyMs', 'model', 'provider', 'assets']),
    )
    // The rejected value rides on the error so the host can see WHICH entry
    // went stale.
    expect(details.rawOutput).toEqual(stale)
    // No dispatch happened: the short-circuit still skipped the adapter.
    expect(modelCalls()).toBe(0)
    // The row never claimed success on the stream.
    expect(events.some((e) => e.type === 'job:completed')).toBe(false)
    expect(events.filter((e) => e.type === 'job:failed')).toHaveLength(1)
  })

  it('the middleware that supplied the value observes the refusal through onError', async () => {
    // A cache middleware has to learn its entry was refused, or it serves the
    // same stale value on every subsequent call.
    const seen: JobError[] = []
    const cache: DispatchMiddleware = {
      beforeDispatch: () => ({ kind: 'short-circuit', output: { text: 'stale' } }),
      onError: (_job, error) => {
        seen.push(error)
      },
    }
    const { rt } = harness({ middleware: [cache] })

    const job = await rt.submitJob({ patternId: 'cap', input: { prompt: 'go' } })

    expect(job.status).toBe('error')
    expect(seen).toHaveLength(1)
    expect(seen[0].code).toBe('OUTPUT_SCHEMA_MISMATCH')
  })

  it('a conforming short-circuit output is handed back as the middleware produced it', async () => {
    // The gate asserts and returns nothing, here as everywhere: an extra key a
    // host put on its cached row must not vanish between the cache and
    // `job.output`.
    const cached = { ...CONFORMING_OUTPUT, cacheKey: 'ck-42' }
    const { rt, events, modelCalls } = harness({ middleware: [shortCircuiting(cached)] })

    const job = await rt.submitJob({ patternId: 'cap', input: { prompt: 'go' } })

    expect(job.status).toBe('done')
    expect(job.output).toEqual(cached)
    expect((job.output as { cacheKey?: string }).cacheKey).toBe('ck-42')
    expect(modelCalls()).toBe(0)
    expect(events.filter((e) => e.type === 'job:completed')).toHaveLength(1)
  })

  it("outputValidation: 'off' lets a short-circuit through unchecked, like every other exit", async () => {
    const stale = { text: 'a cached answer from an older schema' }
    const { rt } = harness({
      middleware: [shortCircuiting(stale)],
      init: { outputValidation: 'off' },
    })

    const job = await rt.submitJob({ patternId: 'cap', input: { prompt: 'go' } })

    expect(job.status).toBe('done')
    expect(job.output).toEqual(stale)
  })
})
