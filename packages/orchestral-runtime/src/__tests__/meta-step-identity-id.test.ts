// StepOptions.identity:'id' — keying a meta step's durable row by its NAME
// instead of its position in the step list.
//
// The default is positional: `ctx.step` stamps the tree-shared counter onto
// the child spec as `stepIndex` and `deriveIdempotencyKey` hashes it. That is
// right for a write-once meta whose author owns the order, and wrong for a
// step list a model rewrites between runs — inserting one step there moves
// every index after it, so unchanged work re-keys and is paid for again.
//
// These tests pin the difference over a real InlineRuntime + InMemoryJobStore
// (the harness of meta-nested-stepid-namespace.test.ts), because the property
// only exists end to end: `ctx.step` → `submitChild` → `_submitJobInternal` →
// `insertIfAbsent`. The evidence is the runtime's, not the fakes': the
// `childJobId` on each `job:step` event (identical across runs = the same row
// was handed back) and a count of how often a model was actually reached.

import { describe, expect, it } from 'vitest'

import type {
  AtomicPattern,
  CapabilityRouter,
  JobSpec,
  MetaPattern,
  ModelCapability,
} from '@orchestral/core'
import { silentDiagnosticsLogger, InMemoryJobStore, PatternRegistry } from '@orchestral/core'
import { z } from 'zod'

import { InlineRuntime } from '../inline'

// ── The step list, as data, so one registered meta can run any trace. ───────

interface SeqStep {
  id: string
  prompt: string
  /** Feed an earlier step's produced assetId into this step's `source` slot. */
  from?: string
}
interface SeqInput {
  steps: SeqStep[]
  /** Omitted = the positional default. */
  identity?: 'index' | 'id'
}

// The doc's insert-a-step trace: three steps, then the same three with one
// INDEPENDENT step spliced in at position 2. `caption` reads nothing and is
// read by nothing, so under name-keyed identity there is exactly one new unit
// of work; under positional identity it displaces everything after it.
const RUN_1: SeqStep[] = [
  { id: 'describe', prompt: 'describe the subject' },
  { id: 'render', prompt: 'render a still' },
  { id: 'animate', prompt: 'animate it', from: 'render' },
]
const RUN_2_WITH_INSERT: SeqStep[] = [
  { id: 'describe', prompt: 'describe the subject' },
  { id: 'caption', prompt: 'caption the subject' },
  { id: 'render', prompt: 'render a still' },
  { id: 'animate', prompt: 'animate it', from: 'render' },
]

// ── Fakes ──────────────────────────────────────────────────────────────────

// Every call returns a fresh assetId, so "this row was re-dispatched" is
// observable in the output as well as in the call count.
function makeRouter(prompts: string[]): CapabilityRouter {
  let serial = 0
  const cap: ModelCapability = {
    modelId: 'fake:gen',
    provider: 'fake',
    tags: [],
    capabilities: ['fake-gen'],
    inputs: ['text'],
    outputs: ['image'],
    source: 'user',
    async call(input: unknown) {
      const inp = input as { prompt?: string }
      prompts.push(inp.prompt ?? '')
      return { output: { assetId: `img-${serial++}` } } as unknown
    },
  } as unknown as ModelCapability

  return {
    checkSatisfiable: () => ({ ok: true, candidates: [cap] }),
    resolve: () => cap,
  } as unknown as CapabilityRouter
}

function createFakeGenPattern(): AtomicPattern<{ prompt: string }, unknown> {
  return {
    id: 'fake-gen',
    kind: 'atomic',
    description: 'fake generator for the step-identity test',
    outputs: z.any() as never,
    primary: {
      tool: { description: 'fake', inputs: z.object({ prompt: z.string() }) },
      modelTags: [],
    },
  }
}

function createSeqMeta(): MetaPattern<SeqInput, unknown> {
  return {
    id: 'meta_seq',
    kind: 'meta',
    description: 'runs a step list given as data, under either identity mode',
    outputs: z.any() as never,
    tool: { description: 'seq', inputs: z.any() as never },
    async compose({ input }, ctx) {
      const produced = new Map<string, string>()
      const steps: { id: string; assetId: string }[] = []
      for (const s of input.steps) {
        const upstream = s.from ? produced.get(s.from) : undefined
        const out = await ctx.step<{ assetId: string }>(
          {
            patternId: 'fake-gen',
            input: { prompt: s.prompt },
            ...(upstream
              ? { assets: [{ slot: 'source', assetId: upstream, modality: 'image' as const }] }
              : {}),
          },
          {
            stepId: s.id,
            ...(input.identity ? { identity: input.identity } : {}),
          },
        )
        produced.set(s.id, out.assetId)
        steps.push({ id: s.id, assetId: out.assetId })
      }
      return { steps }
    },
  }
}

// identity:'id' with the stepId left to the framework — the refused call.
function createUnnamedMeta(): MetaPattern<Record<string, never>, unknown> {
  return {
    id: 'meta_unnamed',
    kind: 'meta',
    description: 'asks for name-keyed identity without supplying a name',
    outputs: z.any() as never,
    tool: { description: 'unnamed', inputs: z.any() as never },
    async compose(_params, ctx) {
      return await ctx.step({ patternId: 'fake-gen', input: { prompt: 'p' } }, { identity: 'id' })
    },
  }
}

// Nested: an inner meta that name-keys its single step, dispatched twice by an
// outer meta under two different step ids. The inner step is called `x` both
// times and gets the SAME input both times — the namespace is the only thing
// telling the two rows apart.
function createInnerMeta(): MetaPattern<{ prompt: string }, unknown> {
  return {
    id: 'meta_inner',
    kind: 'meta',
    description: 'one name-keyed step',
    outputs: z.any() as never,
    tool: { description: 'inner', inputs: z.any() as never },
    async compose({ input }, ctx) {
      return await ctx.step<{ assetId: string }>(
        { patternId: 'fake-gen', input: { prompt: input.prompt } },
        { stepId: 'x', identity: 'id' },
      )
    },
  }
}

function createOuterMeta(): MetaPattern<Record<string, never>, unknown> {
  return {
    id: 'meta_outer',
    kind: 'meta',
    description: 'dispatches the same inner meta twice',
    outputs: z.any() as never,
    tool: { description: 'outer', inputs: z.any() as never },
    async compose(_params, ctx) {
      const a = await ctx.step<{ assetId: string }>(
        { patternId: 'meta_inner', input: { prompt: 'identical' } },
        { stepId: 'a' },
      )
      const b = await ctx.step<{ assetId: string }>(
        { patternId: 'meta_inner', input: { prompt: 'identical' } },
        { stepId: 'b' },
      )
      return { a: a.assetId, b: b.assetId }
    },
  }
}

// ── Host ───────────────────────────────────────────────────────────────────

interface StepRecord {
  stepId: string
  patternId: string
  childJobId: string
}

// `submitJob` resolves only once the job is terminal, so the subscription has
// to be made from inside the runtime's own onJobCreated hook — the first row
// inserted during a run is the root meta.
function makeHost() {
  const prompts: string[] = []
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  registry.add(createFakeGenPattern() as never)
  registry.add(createSeqMeta() as never)
  registry.add(createUnnamedMeta() as never)
  registry.add(createInnerMeta() as never)
  registry.add(createOuterMeta() as never)

  let collecting: StepRecord[] | undefined
  let sawRoot = false

  const runtime = new InlineRuntime({
    router: makeRouter(prompts),
    registry,
    store: new InMemoryJobStore() as never,
    onJobCreated: (jobId: string, _spec: JobSpec) => {
      if (!collecting || sawRoot) return
      sawRoot = true
      const sink = collecting
      runtime.subscribe(jobId, (ev) => {
        if (ev.type !== 'job:step') return
        sink.push({
          stepId: ev.stepId,
          patternId: ev.patternId,
          childJobId: ev.childJobId,
        })
      })
    },
  })

  return {
    runtime,
    prompts,
    /** Submit one root dispatch; returns the job plus its `job:step` records. */
    async run(patternId: string, input: unknown, sessionId: string) {
      const sink: StepRecord[] = []
      collecting = sink
      sawRoot = false
      const before = prompts.length
      try {
        const job = await runtime.submitJob({ patternId, input, sessionId } as never)
        return { job, steps: sink, dispatched: prompts.slice(before) }
      } finally {
        collecting = undefined
      }
    },
  }
}

const byId = (steps: readonly StepRecord[], stepId: string) =>
  steps.find((s) => s.stepId === stepId)?.childJobId

describe("ctx.step identity:'id'", () => {
  it('insert-a-step: the three original steps keep their rows and only the inserted one dispatches', async () => {
    const host = makeHost()
    const session = 'sess-id-mode'

    const run1 = await host.run('meta_seq', { steps: RUN_1, identity: 'id' }, session)
    expect(run1.job.status).toBe('done')
    expect(run1.steps.map((s) => s.stepId)).toEqual(['describe', 'render', 'animate'])
    expect(run1.dispatched).toEqual([
      'describe the subject',
      'render a still',
      'animate it',
    ])

    // Same session, one independent step spliced in at position 2.
    const run2 = await host.run(
      'meta_seq',
      { steps: RUN_2_WITH_INSERT, identity: 'id' },
      session,
    )
    expect(run2.job.status).toBe('done')
    // A different step list is a different parent job — the plan itself is
    // hashed as input — but its unchanged steps still land on run 1's rows.
    expect(run2.job.id).not.toBe(run1.job.id)

    expect(byId(run2.steps, 'describe')).toBe(byId(run1.steps, 'describe'))
    expect(byId(run2.steps, 'render')).toBe(byId(run1.steps, 'render'))
    expect(byId(run2.steps, 'animate')).toBe(byId(run1.steps, 'animate'))

    // Exactly one model call for exactly one new step. `render` hit despite
    // moving from position 1 to 2, and `animate` hit because `render`'s HIT
    // handed back the stored assetId — so the asset in its key never moved.
    expect(run2.dispatched).toEqual(['caption the subject'])
    expect(host.prompts).toHaveLength(4)
  })

  it('the same insert under the positional default re-dispatches everything downstream', async () => {
    const host = makeHost()
    const session = 'sess-index-mode'

    const run1 = await host.run('meta_seq', { steps: RUN_1 }, session)
    expect(run1.job.status).toBe('done')
    expect(run1.dispatched).toHaveLength(3)

    const run2 = await host.run('meta_seq', { steps: RUN_2_WITH_INSERT }, session)
    expect(run2.job.status).toBe('done')

    // Only `describe` is still at index 0, so only `describe` hits.
    expect(byId(run2.steps, 'describe')).toBe(byId(run1.steps, 'describe'))
    expect(byId(run2.steps, 'render')).not.toBe(byId(run1.steps, 'render'))
    expect(byId(run2.steps, 'animate')).not.toBe(byId(run1.steps, 'animate'))

    // Three paid calls for one new step — the cost identity:'id' exists to
    // avoid, and the contrast the test above is measured against.
    expect(run2.dispatched).toEqual([
      'caption the subject',
      'render a still',
      'animate it',
    ])
    expect(host.prompts).toHaveLength(6)
  })

  it("identity:'id' without an explicit stepId is refused before anything dispatches", async () => {
    const host = makeHost()
    const job = await host.run('meta_unnamed', {}, 'sess-unnamed')

    expect(job.job.status).toBe('error')
    expect(job.job.error?.code).toBe('STEP_IDENTITY_REQUIRES_STEP_ID')
    expect(job.job.error?.message).toContain('identity:')
    // The refusal is a malformed call, not a failed step: no model was reached.
    expect(host.prompts).toEqual([])
  })

  it('nested: the same inner step id under two parent steps keys two rows, not one', async () => {
    const host = makeHost()
    const run = await host.run('meta_outer', {}, 'sess-nested')
    expect(run.job.status).toBe('done')

    // The inner metas emit their own step ids unnamespaced on the root stream.
    const inner = run.steps.filter((s) => s.patternId === 'fake-gen')
    expect(inner.map((s) => s.stepId)).toEqual(['x', 'x'])

    // Both inner steps are called `x`, both dispatch `fake-gen` with the same
    // input, in the same session. Only the namespace (`a/x` vs `b/x`) tells
    // their keys apart — had the bare stepId been hashed, the second would
    // have deduped onto the first.
    expect(inner[0]!.childJobId).not.toBe(inner[1]!.childJobId)
    expect(host.prompts).toEqual(['identical', 'identical'])

    const out = run.job.output as { a: string; b: string }
    expect(out.a).not.toBe(out.b)
  })

  it('a changed upstream asset still re-keys the downstream step under identity:\'id\'', async () => {
    const host = makeHost()
    const session = 'sess-assets'
    const downstream: SeqStep = { id: 'b', prompt: 'unchanged', from: 'a' }

    const run1 = await host.run(
      'meta_seq',
      { steps: [{ id: 'a', prompt: 'first' }, downstream], identity: 'id' },
      session,
    )
    expect(run1.job.status).toBe('done')

    // Only `a`'s input changes. `b`'s stepKey and its own input are identical
    // to run 1's — but `a` re-runs and produces a new assetId, and assets are
    // in the key, so `b` is different work and re-runs too.
    const run2 = await host.run(
      'meta_seq',
      { steps: [{ id: 'a', prompt: 'second' }, downstream], identity: 'id' },
      session,
    )
    expect(run2.job.status).toBe('done')

    expect(byId(run2.steps, 'a')).not.toBe(byId(run1.steps, 'a'))
    expect(byId(run2.steps, 'b')).not.toBe(byId(run1.steps, 'b'))
    expect(run2.dispatched).toEqual(['second', 'unchanged'])

    // Same list again: now everything hits, which pins that the re-run above
    // was caused by the changed asset and not by name-keying being inert.
    const run3 = await host.run(
      'meta_seq',
      { steps: [{ id: 'a', prompt: 'second' }, downstream], identity: 'id' },
      session,
    )
    expect(run3.job.id).toBe(run2.job.id)
    expect(run3.dispatched).toEqual([])
  })
})
