// The output gate: an atomic or meta output meets its Pattern's `outputs`
// schema at the dispatch exit.
//
// Before it, the bound on every output field was an authoring lint — the
// registry audits the schema at registration — and nothing at run time held an
// adapter to it: a `{ text }` for a pattern whose schema promises `assets[]`,
// a meta that forgot `cost`, flowed into the next step and into `job.output` as
// if valid. These tests pin the gate on both kinds, the shape of the failure
// it produces (code, issues, the raw output kept for salvage), that a
// conforming output is handed back untouched rather than as zod's reshaped
// copy, the `'off'` opt-out, that a mismatch is not mistaken for a provider
// failure, and how a sub-step's mismatch surfaces on the meta that ran it.
//
// Harness mirrors submit-job-resolves-failed.test.ts: a real InlineRuntime
// over an in-memory store and a one-model router whose call returns whatever
// the test scripted. The schemas are built from the first-party envelope
// shapes so the gate is exercised against what a real catalog row declares.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type {
  AtomicPattern,
  CapabilityRouter,
  ExecutionContext,
  JobEvent,
  MetaPattern,
  Modality,
  ModelCapability,
  Pattern,
} from '@orchestral/core'
import {
  silentDiagnosticsLogger,
  boundedText,
  dispatchEnvelopeShape,
  metaEnvelopeShape,
  PatternRegistry,
  producedAssetShape,
} from '@orchestral/core'
import { InMemoryJobStore } from '@orchestral/core/memory'

import { InlineRuntime, type InlineRuntimeInit } from '../inline'

const IMAGE_OUTPUT = z.object({
  ...dispatchEnvelopeShape,
  assets: z.array(z.object({ label: boundedText(64), ...producedAssetShape('image') })),
})

const META_OUTPUT = z.object({
  ...metaEnvelopeShape,
  caption: boundedText(256),
})

const PROMPT_INPUT = z.object({ prompt: z.string() })

const VALID_IMAGE_OUTPUT = {
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

function meta(id: string, compose: (ctx: ExecutionContext) => Promise<unknown>): MetaPattern {
  return {
    id,
    kind: 'meta',
    description: `meta ${id}`,
    tool: { description: id, inputs: PROMPT_INPUT },
    outputs: META_OUTPUT,
    compose: (_args: { input: unknown }, ctx: ExecutionContext) => compose(ctx),
  } as unknown as MetaPattern
}

function harness(opts: {
  modelOutput: () => unknown
  patterns?: readonly Pattern[]
  init?: Partial<InlineRuntimeInit>
  fallbackDepth?: number
}) {
  const model = {
    modelId: 'A',
    provider: 'prov',
    tags: [],
    capabilities: [],
    inputs: ['text'] as Modality[],
    outputs: ['image'] as Modality[],
    source: 'user' as const,
    async call() {
      return { output: opts.modelOutput() }
    },
  } as unknown as ModelCapability
  const router: CapabilityRouter = {
    checkSatisfiable: () => ({ ok: true, candidates: [model] }),
    resolve: () => model,
  }
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  registry.register(atomic('cap'))
  for (const p of opts.patterns ?? []) registry.register(p)
  const store = new InMemoryJobStore()
  const events: JobEvent[] = []
  const rt = new InlineRuntime({
    store,
    registry,
    router,
    resolveCtxProvider: () => ({ fallbackDepth: opts.fallbackDepth ?? 0 }),
    onJobCreated: (jobId) => {
      rt.subscribe(jobId, (ev) => events.push(ev))
    },
    ...opts.init,
  })
  return { rt, store, events }
}

const failedFor = (events: readonly JobEvent[], jobId: string) =>
  events.filter((e) => e.type === 'job:failed' && e.job.id === jobId)

describe('output validation at the dispatch exit', () => {
  it('an atomic output the schema rejects fails the job with OUTPUT_SCHEMA_MISMATCH', async () => {
    const raw = { text: 'ran' }
    const { rt, events } = harness({ modelOutput: () => raw })

    const job = await rt.submitJob({ patternId: 'cap', input: { prompt: 'go' } })

    expect(job.status).toBe('error')
    expect(job.output).toBeNull()
    expect(job.error?.code).toBe('OUTPUT_SCHEMA_MISMATCH')
    // The message names the pattern and where the schema objected.
    expect(job.error?.message).toMatch(/^OUTPUT_SCHEMA_MISMATCH: cap \(atomic\)/)
    expect(job.error?.message).toContain('cost')
    const details = job.error?.details as MismatchDetails
    expect(details.patternId).toBe('cap')
    expect(details.kind).toBe('atomic')
    expect(details.issues.length).toBeGreaterThan(0)
    expect(details.issues.map((i) => i.path.join('.'))).toEqual(
      expect.arrayContaining(['cost', 'latencyMs', 'model', 'provider', 'assets']),
    )
    for (const issue of details.issues) expect(issue.message).toEqual(expect.any(String))
    // The call was paid for: what came back rides on the error for salvage.
    expect(details.rawOutput).toEqual(raw)
    // A dispatch failure like any other: job:failed fanned out, once, last.
    expect(failedFor(events, job.id)).toHaveLength(1)
    expect(events[events.length - 1]?.type).toBe('job:failed')
  })

  it('a meta output the schema rejects fails the same way', async () => {
    // `cost` forgotten — the envelope field a generic cost meter reads.
    const raw = { caption: 'a caption', latencyMs: 5 }
    const { rt, events } = harness({
      modelOutput: () => VALID_IMAGE_OUTPUT,
      patterns: [meta('meta_cap', async () => raw)],
    })

    const job = await rt.submitJob({ patternId: 'meta_cap', input: { prompt: 'go' } })

    expect(job.status).toBe('error')
    expect(job.error?.code).toBe('OUTPUT_SCHEMA_MISMATCH')
    expect(job.error?.message).toMatch(/^OUTPUT_SCHEMA_MISMATCH: meta_cap \(meta\)/)
    const details = job.error?.details as MismatchDetails
    expect(details.patternId).toBe('meta_cap')
    expect(details.kind).toBe('meta')
    expect(details.issues.map((i) => i.path.join('.'))).toEqual(['cost'])
    expect(details.rawOutput).toEqual(raw)
    expect(failedFor(events, job.id)).toHaveLength(1)
  })

  it('a conforming atomic output is returned as the adapter produced it, unknown keys and all', async () => {
    const raw = { ...VALID_IMAGE_OUTPUT, requestId: 'req-42' }
    let seen: unknown
    const { rt } = harness({
      modelOutput: () => raw,
      init: {
        middleware: [
          {
            afterDispatch: (_job, output) => {
              seen = output
            },
          },
        ],
      },
    })

    const job = await rt.submitJob({ patternId: 'cap', input: { prompt: 'go' } })

    expect(job.status).toBe('done')
    // `z.object` would have stripped `requestId`; the gate asks whether the
    // output conforms and hands back the object it was given, not the copy.
    expect(seen).toBe(raw)
    expect(job.output).toEqual(raw)
    expect((job.output as { requestId?: string }).requestId).toBe('req-42')
  })

  it('a conforming meta output is the same object compose resolved', async () => {
    const raw = { cost: null, latencyMs: 3, caption: 'ok', trace: ['planned'] }
    let seen: unknown
    const { rt } = harness({
      modelOutput: () => VALID_IMAGE_OUTPUT,
      patterns: [meta('meta_cap', async () => raw)],
      init: {
        middleware: [
          {
            afterDispatch: (_job, output) => {
              seen = output
            },
          },
        ],
      },
    })

    const job = await rt.submitJob({ patternId: 'meta_cap', input: { prompt: 'go' } })

    expect(job.status).toBe('done')
    expect(seen).toBe(raw)
    expect(job.output).toEqual(raw)
  })

  it("outputValidation: 'off' lets the invalid output through unchanged", async () => {
    const raw = { text: 'ran' }
    const { rt, events } = harness({
      modelOutput: () => raw,
      init: { outputValidation: 'off' },
    })

    const job = await rt.submitJob({ patternId: 'cap', input: { prompt: 'go' } })

    expect(job.status).toBe('done')
    expect(job.output).toEqual(raw)
    expect(events.some((e) => e.type === 'job:failed')).toBe(false)
  })

  it('a mismatch is not a provider failure: no transient retry, no fallback hop', async () => {
    // The gate sits outside the retry and fallback loops. Were it inside, the
    // mismatch would be put to `isTransient` and the model excluded and walked
    // past — paying a second provider for a second output when the first one
    // is already here. Retry says yes to everything and the walk has room, so
    // either would show up as a second call.
    let calls = 0
    const asked: unknown[] = []
    const { rt, events } = harness({
      modelOutput: () => {
        calls++
        return { text: 'ran' }
      },
      fallbackDepth: 2,
      init: {
        transientRetry: {
          isTransient: (e) => {
            asked.push(e)
            return true
          },
          policy: { kind: 'fixed', maxAttempts: 3, delayMs: 0 },
        },
      },
    })

    const job = await rt.submitJob({ patternId: 'cap', input: { prompt: 'go' } })

    expect(job.status).toBe('error')
    expect(job.error?.code).toBe('OUTPUT_SCHEMA_MISMATCH')
    expect(calls).toBe(1)
    expect(asked).toEqual([])
    expect(events.some((e) => e.type === 'job:model-fallback')).toBe(false)
  })

  it('a sub-step that fails the gate fails the meta with the mismatch itself, naming the sub-step', async () => {
    // A child dispatch that fails THROWS out of `ctx.step` — that throw is
    // what unwinds compose (see `submitJob`'s note on `_submitJobInternal`) —
    // so the meta's job fails with the child's own error, code and `details`
    // intact, rather than a `META_STEP_FAILED` wrapper that would flatten the
    // salvage value into a message string. (That wrapper is the path for a
    // child that RESOLVES already errored, i.e. an idempotency dedup hit.)
    const raw = { text: 'ran' }
    const { rt, store, events } = harness({
      modelOutput: () => raw,
      patterns: [
        meta('meta_cap', async (ctx) => {
          const step = await ctx.step({ patternId: 'cap', input: { prompt: 'inner' } })
          return { cost: null, latencyMs: 1, caption: JSON.stringify(step) }
        }),
      ],
    })

    const job = await rt.submitJob({ patternId: 'meta_cap', input: { prompt: 'go' } })

    expect(job.status).toBe('error')
    expect(job.error?.code).toBe('OUTPUT_SCHEMA_MISMATCH')
    expect(job.error?.message).toMatch(/^OUTPUT_SCHEMA_MISMATCH: cap \(atomic\)/)
    // `details` names the sub-step's pattern, not the meta, and keeps the raw
    // output — a host reading the meta's row can still salvage the call.
    const details = job.error?.details as MismatchDetails
    expect(details.patternId).toBe('cap')
    expect(details.kind).toBe('atomic')
    expect(details.rawOutput).toEqual(raw)
    // The child row carries the same failure on its own terms.
    const rows = await store.query()
    const child = rows.find((j) => j.id !== job.id)
    expect(rows).toHaveLength(2)
    expect(child?.status).toBe('error')
    expect(child?.error?.code).toBe('OUTPUT_SCHEMA_MISMATCH')
    expect((child?.error?.details as MismatchDetails).rawOutput).toEqual(raw)
    // One job:failed per job, each on its own stream.
    expect(failedFor(events, job.id)).toHaveLength(1)
    expect(failedFor(events, child!.id)).toHaveLength(1)
  })
})
