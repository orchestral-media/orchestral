// A `ctx.step`'s durable key is its path in the dispatch tree: the ids of the
// steps that launched its compose, then its own — a name the author gave, or,
// unnamed, `${patternId}#${n}` with n counted among this compose's unnamed
// calls to that pattern. Nothing that happens around the step moves it: not a
// sibling subtree that dedupes and skips its compose, not a park, not a cap on
// a level, not a retry, not a step inserted elsewhere.
//
// Two harnesses. The end-to-end one is a real InlineRuntime + InMemoryJobStore,
// because the property only exists there (`ctx.step` → `submitChild` →
// `_submitJobInternal` → `insertIfAbsent`), and the evidence is the runtime's:
// which prompts reached the model on the run after the change of
// circumstance. The unit one drives `buildMetaExecutionContext` with a
// `submitChild` that records each child spec, for what the spec carries.
//
// The fake model fails by flag for a whole run, never "once": the fallback
// walk re-calls a router that ignores `excludeModel` up to three more times,
// so a fake that failed once would succeed inside the run it was meant to
// fail. Where one subtree has to finish before another fails, the failing
// prompt waits on a deferred the host resolves from the subtree's
// `job:completed` — ordering by events, never by timers.

import { describe, expect, it } from 'vitest'

import type {
  AskUserHandler,
  AskUserRequest,
  AtomicPattern,
  CapabilityRouter,
  Job,
  JobSpec,
  MetaPattern,
  ModelCapability,
  PatternId,
} from '@orchestral/core'
import { parallel, PatternRegistry, silentDiagnosticsLogger } from '@orchestral/core'
import { InMemoryJobStore } from '@orchestral/core/memory'
import { z } from 'zod'

import { InlineRuntime } from '../inline'
import {
  buildMetaExecutionContext,
  makeFreshState,
  type MetaCtxDeps,
  type MetaSharedState,
} from '../meta-execution-context'

// ── Deferreds ──────────────────────────────────────────────────────────────

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ── Patterns ───────────────────────────────────────────────────────────────

function atomic(id: string): AtomicPattern<{ prompt: string }, unknown> {
  return {
    id,
    kind: 'atomic',
    description: `fake generator ${id}`,
    outputs: z.any() as never,
    primary: {
      tool: { description: id, inputs: z.object({ prompt: z.string() }) },
      modelTags: [],
    },
  }
}

function meta<I>(
  id: string,
  compose: NonNullable<MetaPattern<I, unknown>['compose']>,
): MetaPattern<I, unknown> {
  return {
    id,
    kind: 'meta',
    description: id,
    outputs: z.any() as never,
    tool: { description: id, inputs: z.any() as never },
    compose,
  }
}

const gen = (prompt: string) => ({ patternId: 'fake-gen' as PatternId, input: { prompt } })
const genB = (prompt: string) => ({ patternId: 'fake-gen-b' as PatternId, input: { prompt } })

// Two unnamed steps, `${tag}-1` then `${tag}-2`.
const metaChild = meta<{ tag: string }>('meta_child', async ({ input }, ctx) => {
  const first = await ctx.step<{ assetId: string }>(gen(`${input.tag}-1`))
  const second = await ctx.step<{ assetId: string }>(gen(`${input.tag}-2`))
  return { first: first.assetId, second: second.assetId }
})

// Two nested metas side by side, both steps unnamed.
const metaRootParallel = meta<Record<string, never>>('meta_root_parallel', async (_p, ctx) => {
  const [a, b] = await parallel([
    ctx.step({ patternId: 'meta_child' as PatternId, input: { tag: 'a' } }),
    ctx.step({ patternId: 'meta_child' as PatternId, input: { tag: 'b' } }),
  ])
  return { a, b }
})

// The same pair under a cap of one, named as a plan names its steps.
const metaCapped = meta<Record<string, never>>('meta_capped', async (_p, ctx) => {
  const [a, b] = await parallel.limit(
    [
      () => ctx.step({ patternId: 'meta_child' as PatternId, input: { tag: 'a' } }, { stepId: 'a' }),
      () => ctx.step({ patternId: 'meta_child' as PatternId, input: { tag: 'b' } }, { stepId: 'b' }),
    ],
    1,
  )
  return { a, b }
})

// Two unnamed steps with an optional park between them.
const metaPark = meta<{ park: boolean }>('meta_park', async ({ input }, ctx) => {
  await ctx.step(gen('first'))
  if (input.park) await ctx.askUser.confirm({ title: 'go?' })
  await ctx.step(gen('second'))
  return { parked: input.park }
})

// An unnamed `target`, with something optionally inserted ahead of it.
type Ahead = 'none' | 'named' | 'other' | 'same'
const metaInsert = meta<{ ahead: Ahead }>('meta_insert', async ({ input }, ctx) => {
  if (input.ahead === 'named') await ctx.step(gen('named-extra'), { stepId: 'extra' })
  if (input.ahead === 'other') await ctx.step(genB('other-extra'))
  if (input.ahead === 'same') await ctx.step(gen('same-extra'))
  return await ctx.step(gen('target'))
})

// A step list given as data, every step named. `from` feeds an earlier step's
// produced assetId into this step's `source` slot.
interface SeqStep {
  id: string
  prompt: string
  from?: string
}
const metaSeq = meta<{ steps: SeqStep[] }>('meta_seq', async ({ input }, ctx) => {
  const produced = new Map<string, string>()
  for (const s of input.steps) {
    const upstream = s.from ? produced.get(s.from) : undefined
    const out = await ctx.step<{ assetId: string }>(
      {
        ...gen(s.prompt),
        ...(upstream
          ? { assets: [{ slot: 'source', assetId: upstream, modality: 'image' as const }] }
          : {}),
      },
      { stepId: s.id },
    )
    produced.set(s.id, out.assetId)
  }
  return Object.fromEntries(produced)
})

// The same inner meta, one named step `x` on the same input, under two parent
// steps.
const metaInner = meta<{ prompt: string }>('meta_inner', async ({ input }, ctx) =>
  ctx.step(gen(input.prompt), { stepId: 'x' }),
)
const metaOuter = meta<Record<string, never>>('meta_outer', async (_p, ctx) => {
  const inner = { patternId: 'meta_inner' as PatternId, input: { prompt: 'identical' } }
  const a = await ctx.step(inner, { stepId: 'a' })
  const b = await ctx.step(inner, { stepId: 'b' })
  return { a, b }
})

const RETRY = { kind: 'fixed', maxAttempts: 2, delayMs: 0 } as const

// ── Host ───────────────────────────────────────────────────────────────────

interface StepRecord {
  stepId: string
  patternId: string
  childJobId: string
}

interface Row {
  jobId: string
  spec: JobSpec
}

interface Run {
  job: Job
  /** `job:step` on the root's stream, in settle order. */
  steps: StepRecord[]
  /** Every row this run INSERTed (a dedup hit inserts nothing). */
  rows: Row[]
  /** Prompts that reached the model this run, in call order. */
  dispatched: string[]
}

function promptOf(input: unknown): string {
  const p = (input as { prompt?: unknown } | null)?.prompt
  return typeof p === 'string' ? p : ''
}

// The asset id is a function of what was asked — the prompt and the sources —
// so a dedup hit and a fresh call that happened to be identical cannot be told
// apart by output, only by the dispatch list. That is deliberate: the dispatch
// list is the evidence.
const assetIdFor = (prompt: string, sources: readonly string[]): string =>
  sources.length > 0 ? `img(${prompt}<-${sources.join('+')})` : `img(${prompt})`

function makeHost() {
  const calls: string[] = []
  const failing = new Set<string>()
  const holds = new Map<string, Promise<void>>()
  const flaky = { attempts: 0, prepCalls: 0 }

  const call: ModelCapability['call'] = async (input, ctx) => {
    const prompt = promptOf(input)
    calls.push(prompt)
    const hold = holds.get(prompt)
    if (hold) await hold
    if (failing.has(prompt)) {
      throw Object.assign(new Error(`MOCK_FAIL: ${prompt}`), { code: 'MOCK_FAIL' })
    }
    const sources = (ctx?.assets ?? []).map((a) => a.assetId)
    return { output: { assetId: assetIdFor(prompt, sources) } } as never
  }
  const capability = (cap: string): ModelCapability =>
    ({
      modelId: `fake:${cap}`,
      provider: 'fake',
      tags: [],
      capabilities: [cap],
      inputs: ['text'],
      outputs: ['image'],
      source: 'user',
      call,
    }) as unknown as ModelCapability
  const caps = { 'fake-gen': capability('fake-gen'), 'fake-gen-b': capability('fake-gen-b') }
  const pick = (cap: string) => caps[cap as keyof typeof caps]
  // Ignores excludeModel, so a failing prompt is walked through the whole
  // fallback depth — see the header.
  const router = {
    checkSatisfiable: (cap: string) => ({ ok: true, candidates: [pick(cap)] }),
    resolve: (cap: string) => pick(cap),
  } as unknown as CapabilityRouter

  // Runs `prep` through the compute cache, one unnamed (or named) step, then
  // fails on its first attempt only — the attempt count lives here, not in
  // the meta, so a retry sees it advance.
  const metaFlaky = meta<{ named: boolean }>('meta_flaky', async ({ input }, ctx) => {
    await ctx.compute('prep', async () => {
      flaky.prepCalls++
      return 'prepped'
    })
    const out = await ctx.step(gen('one'), input.named ? { stepId: 'one' } : undefined)
    if (flaky.attempts++ === 0) throw new Error('meta_flaky: the first attempt fails after its step')
    return out
  })
  // Retries meta_flaky; named, it then reuses the retried step's own id, which
  // must still be taken.
  const metaRetry = meta<{ named: boolean }>('meta_retry', async ({ input }, ctx) => {
    const flakyRef = { patternId: 'meta_flaky' as PatternId, input: { named: input.named } }
    if (!input.named) return { out: await ctx.step(flakyRef, { retry: RETRY }) }
    const out = await ctx.step(flakyRef, { stepId: 'flaky', retry: RETRY })
    try {
      await ctx.step(gen('flaky-again'), { stepId: 'flaky' })
      return { out, again: 'dispatched' }
    } catch (err) {
      return { out, again: (err as { code?: string }).code ?? 'no code' }
    }
  })

  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  for (const p of [
    atomic('fake-gen'),
    atomic('fake-gen-b'),
    metaChild,
    metaRootParallel,
    metaCapped,
    metaPark,
    metaInsert,
    metaSeq,
    metaInner,
    metaOuter,
    metaFlaky,
    metaRetry,
  ]) {
    registry.register(p as never)
  }

  const watchers: Array<{ match: (spec: JobSpec) => boolean; done: Deferred<void> }> = []
  let current: Run | undefined

  // `submitJob` resolves only once the root is terminal, so every subscription
  // is made from inside onJobCreated; the first row a run inserts is its root.
  const runtime: InlineRuntime = new InlineRuntime({
    router,
    registry,
    store: new InMemoryJobStore() as never,
    askUser: (async () => ({ confirmed: true })) as AskUserHandler,
    onJobCreated: (jobId: string, spec: JobSpec) => {
      if (!current) return
      const run = current
      if (run.rows.length === 0) {
        runtime.subscribe(jobId, (ev) => {
          if (ev.type !== 'job:step') return
          run.steps.push({ stepId: ev.stepId, patternId: ev.patternId, childJobId: ev.childJobId })
        })
      }
      run.rows.push({ jobId, spec })
      for (const w of watchers) {
        if (!w.match(spec)) continue
        runtime.subscribe(jobId, (ev) => {
          if (ev.type === 'job:completed') w.done.resolve()
        })
      }
    },
  })

  return {
    flaky,
    /** Prompts that throw MOCK_FAIL, on every call, until cleared. */
    failing,
    /** Hold a prompt's call until `until` settles. */
    hold(prompt: string, until: Promise<void>) {
      holds.set(prompt, until)
    },
    /** Every circumstance back to normal: nothing fails, nothing is held. */
    clear() {
      failing.clear()
      holds.clear()
    },
    /** Resolves when a row matching `match`, inserted from now on, completes. */
    completionOf(match: (spec: JobSpec) => boolean): Promise<void> {
      const done = deferred()
      watchers.push({ match, done })
      return done.promise
    },
    async run(patternId: string, input: unknown, sessionId: string): Promise<Run> {
      const before = calls.length
      const run: Run = { job: undefined as never, steps: [], rows: [], dispatched: [] }
      current = run
      try {
        run.job = await runtime.submitJob({ patternId, input, sessionId } as never)
      } finally {
        current = undefined
      }
      run.dispatched = calls.slice(before)
      return run
    },
  }
}

const rowOf = (run: Run, prompt: string) =>
  run.rows.find((r) => promptOf(r.spec.input) === prompt)?.jobId

const byStepId = (steps: readonly StepRecord[], stepId: string) =>
  steps.find((s) => s.stepId === stepId)?.childJobId

// ── Unit harness ───────────────────────────────────────────────────────────

const ROOT = 'job_root'

function doneJob(spec: JobSpec): Job {
  return {
    id: `child-${promptOf(spec.input)}`,
    patternId: spec.patternId,
    idempotencyKey: 'k',
    status: 'done',
    input: spec.input,
    output: { ok: true },
    error: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

function buildCtx(opts: { stepIdNamespace?: string; askUser?: AskUserHandler } = {}) {
  const specs: JobSpec[] = []
  const deps: MetaCtxDeps = {
    submitChild: async (spec) => {
      specs.push(spec as JobSpec)
      return doneJob(spec as JobSpec) as never
    },
    ...(opts.askUser ? { askUser: opts.askUser } : {}),
  }
  const state: MetaSharedState = { ...makeFreshState(), rootJobId: ROOT }
  const ctx = buildMetaExecutionContext(
    deps,
    'meta_test' as PatternId,
    ROOT,
    { patternId: 'meta_test' as PatternId, input: {} },
    new AbortController().signal,
    new Set<PatternId>(['meta_test' as PatternId]),
    state,
    opts.stepIdNamespace,
  )
  return { ctx, specs }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('a step is keyed by its path', () => {
  it('a completed step under a resubmitted sibling is not paid again when the other sibling dedupes', async () => {
    const host = makeHost()
    const session = 'sess-sibling-dedupes'

    // Run 1: B's second step fails, but only once A's subtree is done — so A's
    // meta row is `done` and dedupes on run 2, skipping its compose.
    const aDone = host.completionOf(
      (spec) =>
        spec.patternId === 'meta_child' && (spec.input as { tag?: string }).tag === 'a',
    )
    host.failing.add('b-2')
    host.hold('b-2', aDone)
    const run1 = await host.run('meta_root_parallel', {}, session)
    expect(run1.job.status).toBe('error')
    expect(run1.job.error?.code).toBe('MOCK_FAIL')

    host.clear()
    const run2 = await host.run('meta_root_parallel', {}, session)
    expect(run2.job.status).toBe('done')
    // B's first step succeeded and was paid for on run 1. Only the step that
    // failed runs again.
    expect(run2.dispatched).toEqual(['b-2'])
    // And the row run 2 handed back for it is run 1's.
    expect(run2.steps.map((s) => s.childJobId)).toContain(rowOf(run1, 'b-1'))
  })

  it('every ctx.step child spec carries its effective step id as stepKey and no stepIndex', async () => {
    const nested = buildCtx({ stepIdNamespace: 'outer-0' })
    await nested.ctx.step(gen('p0'))
    await nested.ctx.step(gen('p1'))
    await nested.ctx.step(gen('p2'), { stepId: 'x' })
    await nested.ctx.step(genB('p3'))

    expect(nested.specs.map((s) => s.stepKey)).toEqual([
      'outer-0/fake-gen#0',
      'outer-0/fake-gen#1',
      'outer-0/x',
      'outer-0/fake-gen-b#0',
    ])
    // One path, sent twice: as the identity the key hashes, and as the routing
    // prefix a child meta puts on its own steps.
    expect(nested.specs.map((s) => s.stepIdNamespace)).toEqual(
      nested.specs.map((s) => s.stepKey),
    )
    expect(nested.specs.map((s) => 'stepIndex' in s)).toEqual([false, false, false, false])

    // A top-level compose has no prefix: the key is the bare id.
    const top = buildCtx()
    await top.ctx.step(gen('p0'))
    await top.ctx.step(gen('p1'))
    await top.ctx.step(gen('p2'), { stepId: 'x' })
    await top.ctx.step(genB('p3'))
    expect(top.specs.map((s) => s.stepKey)).toEqual([
      'fake-gen#0',
      'fake-gen#1',
      'x',
      'fake-gen-b#0',
    ])
  })

  it('a default step id counts only unnamed calls to the same pattern within one compose', async () => {
    const reported = async (stepIdNamespace?: string) => {
      const { ctx } = buildCtx(stepIdNamespace === undefined ? {} : { stepIdNamespace })
      return [
        (await ctx.step.withMeta(gen('p0'))).meta.stepId,
        (await ctx.step.withMeta(gen('p1'), { stepId: 'x' })).meta.stepId,
        (await ctx.step.withMeta(genB('p2'))).meta.stepId,
        (await ctx.step.withMeta(gen('p3'))).meta.stepId,
      ]
    }
    const expected = ['fake-gen#0', 'x', 'fake-gen-b#0', 'fake-gen#1']
    expect(await reported()).toEqual(expected)
    // The reported id is the author-facing one: a namespace prefixes the key,
    // never what the step reports.
    expect(await reported('n')).toEqual(expected)
  })

  it('a park between two steps moves neither step key', async () => {
    const host = makeHost()
    const session = 'sess-park'

    const run1 = await host.run('meta_park', { park: false }, session)
    expect(run1.job.status).toBe('done')
    expect(run1.dispatched).toEqual(['first', 'second'])

    const run2 = await host.run('meta_park', { park: true }, session)
    expect(run2.job.status).toBe('done')
    expect(run2.dispatched).toEqual([])
  })

  it('ask ids are counted apart from step ids', async () => {
    const asked: AskUserRequest[] = []
    const { ctx } = buildCtx({
      askUser: async (request) => {
        asked.push(request)
        return { confirmed: true }
      },
    })
    await ctx.step(gen('p0'))
    await ctx.step(gen('p1'))
    await ctx.askUser.confirm({ title: 'first?' })
    await ctx.askUser.confirm({ title: 'second?' })

    expect(asked.map((r) => r.id)).toEqual([`${ROOT}:ask:0`, `${ROOT}:ask:1`])
  })

  it('under parallel.limit with a cap of one a nested meta finds its rows on resubmit', async () => {
    const host = makeHost()
    const session = 'sess-capped'

    // The cap runs `a` to completion before `b` starts, so no hold is needed.
    host.failing.add('b-2')
    const run1 = await host.run('meta_capped', {}, session)
    expect(run1.job.status).toBe('error')

    host.clear()
    const run2 = await host.run('meta_capped', {}, session)
    expect(run2.job.status).toBe('done')
    expect(run2.dispatched).toEqual(['b-2'])
  })

  it('inserting a named step or another pattern ahead of an unnamed step leaves its key alone', async () => {
    const host = makeHost()
    const session = 'sess-insert'

    const run1 = await host.run('meta_insert', { ahead: 'none' }, session)
    expect(run1.job.status).toBe('done')
    expect(run1.dispatched).toEqual(['target'])

    const run2 = await host.run('meta_insert', { ahead: 'named' }, session)
    expect(run2.job.status).toBe('done')
    expect(run2.dispatched).toEqual(['named-extra'])

    const run3 = await host.run('meta_insert', { ahead: 'other' }, session)
    expect(run3.job.status).toBe('done')
    expect(run3.dispatched).toEqual(['other-extra'])
  })

  it('inserting an unnamed call to the same pattern ahead of it renumbers it', async () => {
    const host = makeHost()
    const session = 'sess-renumber'

    const run1 = await host.run('meta_insert', { ahead: 'none' }, session)
    expect(run1.dispatched).toEqual(['target'])

    // `same-extra` takes `fake-gen#0`, so `target` is `fake-gen#1` — another
    // key, and a resubmit pays for it again. The guard's other direction.
    const run2 = await host.run('meta_insert', { ahead: 'same' }, session)
    expect(run2.job.status).toBe('done')
    expect(run2.dispatched).toEqual(['same-extra', 'target'])
  })

  it('an explicit step id spelled like a default one collides with it', async () => {
    const { ctx } = buildCtx()
    await ctx.step(gen('p0'), { stepId: 'fake-gen#0' })
    await expect(ctx.step(gen('p1'))).rejects.toMatchObject({ code: 'DUPLICATE_STEP_ID' })
  })

  it('a named step keeps its row when another step is inserted ahead of it', async () => {
    const host = makeHost()
    const session = 'sess-named-insert'
    const describeStep = { id: 'describe', prompt: 'describe the subject' }
    const renderStep = { id: 'render', prompt: 'render a still' }
    const animateStep = { id: 'animate', prompt: 'animate it', from: 'render' }

    const run1 = await host.run(
      'meta_seq',
      { steps: [describeStep, renderStep, animateStep] },
      session,
    )
    expect(run1.job.status).toBe('done')
    expect(run1.dispatched).toEqual(['describe the subject', 'render a still', 'animate it'])

    // Same session, one independent step spliced in second.
    const run2 = await host.run(
      'meta_seq',
      {
        steps: [describeStep, { id: 'caption', prompt: 'caption the subject' }, renderStep, animateStep],
      },
      session,
    )
    expect(run2.job.status).toBe('done')
    // One new step, one model call. `render` hit though it moved, and
    // `animate` hit because `render`'s hit handed back the stored asset — so
    // the asset in its key never moved either.
    expect(run2.dispatched).toEqual(['caption the subject'])
    for (const id of ['describe', 'render', 'animate']) {
      expect(byStepId(run2.steps, id)).toBe(byStepId(run1.steps, id))
    }
  })

  it('the same inner step name under two parent steps keys two rows', async () => {
    const host = makeHost()
    const run = await host.run('meta_outer', {}, 'sess-nested')
    expect(run.job.status).toBe('done')

    // Both inner steps are `x`, both dispatch `fake-gen` on the same input in
    // the same session. Only the path (`a/x`, `b/x`) tells their keys apart.
    const inner = run.steps.filter((s) => s.patternId === 'fake-gen')
    expect(inner.map((s) => s.stepId)).toEqual(['x', 'x'])
    expect(inner[0]!.childJobId).not.toBe(inner[1]!.childJobId)
    expect(run.dispatched).toEqual(['identical', 'identical'])
  })

  it('a changed upstream asset still re-keys the downstream step', async () => {
    const host = makeHost()
    const session = 'sess-assets'
    const downstream: SeqStep = { id: 'b', prompt: 'unchanged', from: 'a' }

    const run1 = await host.run('meta_seq', { steps: [{ id: 'a', prompt: 'first' }, downstream] }, session)
    expect(run1.job.status).toBe('done')

    // Only `a`'s input changes. `b`'s path and its own input are as before, but
    // `a` produces another asset, and assets are in the key.
    const run2 = await host.run('meta_seq', { steps: [{ id: 'a', prompt: 'second' }, downstream] }, session)
    expect(run2.job.status).toBe('done')
    expect(byStepId(run2.steps, 'b')).not.toBe(byStepId(run1.steps, 'b'))
    expect(run2.dispatched).toEqual(['second', 'unchanged'])

    // The same list again hits everywhere: the re-run above was the asset.
    const run3 = await host.run('meta_seq', { steps: [{ id: 'a', prompt: 'second' }, downstream] }, session)
    expect(run3.job.id).toBe(run2.job.id)
    expect(run3.dispatched).toEqual([])
  })

  it('a retried meta step finds the rows its failed attempt banked when the inner step is unnamed', async () => {
    const host = makeHost()
    const run = await host.run('meta_retry', { named: false }, 'sess-retry-unnamed')

    expect({ status: run.job.status, code: run.job.error?.code ?? null }).toEqual({
      status: 'done',
      code: null,
    })
    // The inner step succeeded on the failed attempt; the retry finds its row.
    expect(run.dispatched).toEqual(['one'])
    // What that attempt computed is reused too: the compute cache is left alone.
    expect(host.flaky.prepCalls).toBe(1)
    expect(host.flaky.attempts).toBe(2)
  })

  it('a retried meta step finds the rows its failed attempt banked when the inner step is named', async () => {
    const host = makeHost()
    const run = await host.run('meta_retry', { named: true }, 'sess-retry-named')

    expect({ status: run.job.status, code: run.job.error?.code ?? null }).toEqual({
      status: 'done',
      code: null,
    })
    expect(run.dispatched).toEqual(['one'])
    expect(host.flaky.prepCalls).toBe(1)
    // The retry released only what the failed attempt registered under the
    // step: the step's own id is still taken, once.
    expect((run.job.output as { again?: string }).again).toBe('DUPLICATE_STEP_ID')
  })
})
