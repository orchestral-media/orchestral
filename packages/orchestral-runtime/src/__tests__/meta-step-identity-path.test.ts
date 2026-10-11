// A `ctx.step`'s durable key is its path in the dispatch tree: the ids of the
// steps that launched its compose, then its own — a name the author gave, or,
// unnamed, `${patternId}#${n}` with n counted among this compose's unnamed
// calls to that pattern. Nothing that happens around the step moves it: not a
// sibling subtree that dedupes and skips its compose, not a park, not a cap on
// a level, not a retry, not a named step, or a call to another pattern,
// inserted elsewhere.
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
/** A pattern id with a vendor prefix, as the registry's short names allow. */
const SLASHED = 'image-gen/fancy-edit' as PatternId
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

interface StrandInput {
  named: boolean
  shape: 'read' | 'late'
}

/** `done` if the call went through, else the code it was refused with. */
const outcomeOf = (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => 'done',
    (err: unknown) => (err as { code?: string } | null)?.code ?? 'no code',
  )

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
  const caps = {
    'fake-gen': capability('fake-gen'),
    'fake-gen-b': capability('fake-gen-b'),
    [SLASHED]: capability(SLASHED),
  }
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

  // A compose that fails while one of its branches is still running: `slow`
  // waits on `strand.slow`, and `boom` fails on the first attempt only. Shape
  // `read` hands slow's output to the branch's next step; shape `late` starts
  // that step only once slow has settled, which is when a failed attempt's
  // branch would register its id. A later attempt releases `slow` itself, at
  // the moment its shape is about — so a runtime that failed the row at once
  // meets the first attempt's branch still running.
  //
  // A runtime that waits never starts the retry while `slow` is held, so
  // something else has to release it: a step the first compose asks for once
  // the runtime has seen it reject. The ask is attached from a microtask queued
  // inside compose, which runs after the runtime has started awaiting the
  // promise compose returned, so its reaction to the rejection runs after the
  // runtime's, which closes the fence before it awaits anything. Refused, the
  // probe shows the ctx is fenced, and the hold can go; dispatched, it leaves
  // `slow` held, and a runtime that waits would time the test out rather than
  // pass it.
  const strand = {
    composeRuns: 0,
    slow: deferred(),
    lateCalled: deferred(),
    /** What the first attempt's branch met when it asked for its next step. */
    straggler: deferred<string>(),
    /** What a step asked for after the runtime saw the first compose reject met. */
    probe: deferred<string>(),
  }
  const metaStrand = meta<StrandInput>('meta_strand', ({ input }, ctx) => {
    const attempt = ++strand.composeRuns
    const as = (stepId: string) => (input.named ? { stepId } : undefined)
    const body = (async () => {
      if (attempt > 1) {
        failing.delete('boom')
        if (input.shape === 'late') {
          strand.slow.resolve()
          await strand.lateCalled.promise
        }
      }
      const branch = (async () => {
        const s = await ctx.step<{ assetId: string }>(gen('slow'), as('slow'))
        const next = ctx.step(gen(input.shape === 'read' ? `late-${s.assetId}` : 'late'), as('late'))
        if (attempt > 1) return next
        strand.lateCalled.resolve()
        strand.straggler.resolve(await outcomeOf(next))
      })()
      const boom = ctx.step(gen('boom'), as('boom'))
      // `slow` has been asked for: the row the `read` shape dedupes onto is
      // still running until now.
      if (attempt > 1) strand.slow.resolve()
      await parallel([branch, boom])
      return 'ok'
    })()
    if (attempt === 1) {
      queueMicrotask(() => {
        body.catch(async () => {
          // Another pattern, so an unnamed probe takes no `fake-gen` ordinal.
          const code = await outcomeOf(ctx.step(genB('probe'), as('probe')))
          strand.probe.resolve(code)
          if (code !== 'done') strand.slow.resolve()
        })
      })
    }
    return body
  })
  const metaStrandRoot = meta<StrandInput>('meta_strand_root', async ({ input }, ctx) =>
    ctx.step({ patternId: 'meta_strand' as PatternId, input }, { retry: RETRY }),
  )

  // Fails on `boom` while a branch waits — on `afterFailure.gate`, or parked on
  // `ctx.askUser` — then, once let go, asks for a step and a park.
  const afterFailure = {
    gate: deferred(),
    outcome: deferred<{ step: string; ask: string }>(),
  }
  const metaAfterFailure = meta<{ park: boolean }>('meta_after_failure', async ({ input }, ctx) => {
    const waiting = (async () => {
      if (input.park) await ctx.askUser.confirm({ title: 'parked' })
      else await afterFailure.gate.promise
      const step = await outcomeOf(ctx.step(gen('after')))
      const ask = await outcomeOf(ctx.askUser.confirm({ title: 'after' }))
      afterFailure.outcome.resolve({ step, ask })
    })()
    await parallel([waiting, ctx.step(gen('boom'))])
    return 'unreachable'
  })

  // A root whose unnamed call to `image-gen/fancy-edit` sits beside a step
  // named `image-gen`, whose child meta names its own step `fancy-edit#0` and
  // fails its first attempt after that step. Last, the root names a step the
  // way the sibling's default id is spelled, to see whether that id is still
  // taken.
  const slash = { attempts: 0 }
  const metaSlashChild = meta<Record<string, never>>('meta_slash_child', async (_p, ctx) => {
    const out = await ctx.step(gen('edit'), { stepId: 'fancy-edit#0' })
    if (slash.attempts++ === 0) throw new Error('meta_slash_child: the first attempt fails after its step')
    return out
  })
  const metaSlashRoot = meta<Record<string, never>>('meta_slash_root', async (_p, ctx) => {
    await ctx.step({ patternId: SLASHED, input: { prompt: 'sibling' } })
    await ctx.step(
      { patternId: 'meta_slash_child' as PatternId, input: {} },
      { stepId: 'image-gen', retry: RETRY },
    )
    const again = await outcomeOf(ctx.step(gen('again'), { stepId: 'image-gen%2Ffancy-edit#0' }))
    return { again }
  })

  // Resolves with a step still in flight, then returns an output its gate
  // refuses. The gate is where `slow` is let go: the refinement runs inside
  // the runtime's output check, so whatever the runtime does on refusing the
  // output it does before `slow`'s branch can move.
  const gateFails = {
    slow: deferred(),
    /** What `slow`'s branch met when it asked for its next step. */
    after: deferred<string>(),
  }
  const metaGate: MetaPattern<Record<string, never>, unknown> = {
    ...meta<Record<string, never>>('meta_gate', async (_p, ctx) => {
      await Promise.race([
        ctx.step(gen('fast')),
        (async () => {
          await ctx.step(gen('slow'))
          gateFails.after.resolve(await outcomeOf(ctx.step(gen('after-gate'))))
        })(),
      ])
      return { ok: false }
    }),
    outputs: z.unknown().refine(() => {
      gateFails.slow.resolve()
      return false
    }, 'the gate refuses every output') as never,
  }

  // Fails on `boom` while a `ctx.submitJob` child is in flight, then — once
  // the runtime has seen compose reject (see `strand`) — asks for another.
  const hatch = {
    slow: deferred(),
    /** What the escape hatch met when asked after the failure. */
    probe: deferred<string>(),
  }
  const metaEscape = meta<Record<string, never>>('meta_escape', (_p, ctx) => {
    const body = (async () => {
      await parallel([
        ctx.submitJob({ patternId: 'fake-gen' as PatternId, input: { prompt: 'escape-slow' } }),
        ctx.step(gen('boom')),
      ])
      return 'unreachable'
    })()
    queueMicrotask(() => {
      body.catch(async () => {
        const code = await outcomeOf(
          ctx.submitJob({ patternId: 'fake-gen' as PatternId, input: { prompt: 'escape-after' } }),
        )
        hatch.probe.resolve(code)
        if (code !== 'done') hatch.slow.resolve()
      })
    })
    return body
  })

  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  for (const p of [
    atomic('fake-gen'),
    atomic('fake-gen-b'),
    atomic(SLASHED),
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
    metaStrand,
    metaStrandRoot,
    metaAfterFailure,
    metaSlashChild,
    metaSlashRoot,
    metaGate,
    metaEscape,
  ]) {
    registry.register(p as never)
  }

  const asked: AskUserRequest[] = []
  let askHold: Promise<void> | undefined

  const watchers: Array<{ match: (spec: JobSpec) => boolean; done: Deferred<void> }> = []
  let current: Run | undefined

  // `submitJob` resolves only once the root is terminal, so every subscription
  // is made from inside onJobCreated; the first row a run inserts is its root.
  const runtime: InlineRuntime = new InlineRuntime({
    router,
    registry,
    store: new InMemoryJobStore() as never,
    askUser: (async (request: AskUserRequest) => {
      asked.push(request)
      if (askHold) await askHold
      return { confirmed: true }
    }) as AskUserHandler,
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
    strand,
    afterFailure,
    gateFails,
    hatch,
    poll: (jobId: string) => runtime.pollJob(jobId),
    /** Every prompt that reached the model, across runs, in call order. */
    calls: calls as readonly string[],
    /** Every park the host was asked to answer. */
    asked: asked as readonly AskUserRequest[],
    /** Prompts that throw MOCK_FAIL, on every call, until cleared. */
    failing,
    /** Hold a prompt's call until `until` settles. */
    hold(prompt: string, until: Promise<void>) {
      holds.set(prompt, until)
    },
    /** Answer every park only once `until` settles. */
    holdAsks(until: Promise<void>) {
      askHold = until
    },
    /** Every circumstance back to normal: nothing fails, nothing is held. */
    clear() {
      failing.clear()
      holds.clear()
      askHold = undefined
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

function buildCtx(
  opts: { stepIdNamespace?: string; askUser?: AskUserHandler; state?: MetaSharedState } = {},
) {
  const specs: JobSpec[] = []
  const deps: MetaCtxDeps = {
    submitChild: async (spec) => {
      specs.push(spec as JobSpec)
      return doneJob(spec as JobSpec) as never
    },
    ...(opts.askUser ? { askUser: opts.askUser } : {}),
  }
  const state: MetaSharedState = opts.state ?? { ...makeFreshState(), rootJobId: ROOT }
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
  return { ctx, specs, state }
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

  it('an explicit step id carrying the path separator is refused before anything is registered', async () => {
    // `panel-1/x` would read as step `x` under `panel-1`: a retry of a sibling
    // named `panel-1` would release it, and the same compose could then use it
    // again unchallenged.
    const { ctx, specs, state } = buildCtx()
    await expect(ctx.step(gen('p0'), { stepId: 'panel-1/x' })).rejects.toMatchObject({
      code: 'STEP_ID_RESERVED_CHARACTER',
    })
    expect(specs).toEqual([])
    expect([...state.stepIds]).toEqual([])
  })

  it('a default segment escapes a slash in its pattern id, so it never lands under a sibling step path', async () => {
    const host = makeHost()
    const run = await host.run('meta_slash_root', {}, 'sess-slash')

    expect({ status: run.job.status, code: run.job.error?.code ?? null }).toEqual({
      status: 'done',
      code: null,
    })
    // Unescaped, the unnamed call's id would be `image-gen/fancy-edit#0`: the
    // path of the step the child of `image-gen` names `fancy-edit#0`.
    const keyOf = (prompt: string) => run.rows.find((r) => promptOf(r.spec.input) === prompt)?.spec.stepKey
    expect(keyOf('sibling')).toBe('image-gen%2Ffancy-edit#0')
    expect(keyOf('edit')).toBe('image-gen/fancy-edit#0')
    expect(run.steps.find((s) => s.patternId === SLASHED)?.stepId).toBe('image-gen%2Ffancy-edit#0')
    // `image-gen` retried and found its child's row; the release under
    // `image-gen/` left the sibling's id registered.
    expect(run.dispatched).toEqual(['sibling', 'edit'])
    expect((run.job.output as { again?: string }).again).toBe('DUPLICATE_STEP_ID')
  })

  it('a compute id carrying the path separator is refused before the cache is read', async () => {
    // Unrefused, a root `compute('a/b')` and a `compute('b')` under a step
    // named `a` share one cache slot, and the second gets the first's value.
    const state: MetaSharedState = { ...makeFreshState(), rootJobId: ROOT }
    const root = buildCtx({ state })
    const nested = buildCtx({ state, stepIdNamespace: 'a' })
    let rootRan = false
    await expect(
      root.ctx.compute('a/b', async () => {
        rootRan = true
        return 'root'
      }),
    ).rejects.toMatchObject({ code: 'STEP_ID_RESERVED_CHARACTER' })
    expect(rootRan).toBe(false)
    expect([...state.stepCache.keys()]).toEqual([])
    expect(await nested.ctx.compute('b', async () => 'nested')).toBe('nested')
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

// A retry releases the ids under its step and finds the rows they keyed. Both
// halves need the failed attempt's subtree to be quiet first: a branch still
// running after its compose rejected holds a row the retry would dedupe onto
// before it is done, or registers an id after the release.
describe('a failed compose settles the steps it started before its row fails', () => {
  async function strandRun(input: StrandInput, sessionId: string) {
    const host = makeHost()
    host.failing.add('boom')
    host.hold('slow', host.strand.slow.promise)
    const run = await host.run('meta_strand_root', input, sessionId)
    return { host, run }
  }

  // The first attempt's branch asked for its next step once `slow` settled,
  // and a probe asked for one once the runtime had seen compose reject: both
  // were refused, and neither reached the model.
  async function expectFirstAttemptStartedNothingMore(
    host: ReturnType<typeof makeHost>,
    run: Run,
  ) {
    expect(await host.strand.straggler.promise).toBe('STEP_AFTER_COMPOSE_FAILED')
    expect(await host.strand.probe.promise).toBe('STEP_AFTER_COMPOSE_FAILED')
    expect(run.dispatched).not.toContain('probe')
    expect(run.dispatched.filter((p) => p === 'slow')).toEqual(['slow'])
  }

  it('a retried meta step reads the real output of a step its failed attempt left running when the steps are unnamed', async () => {
    const { host, run } = await strandRun({ named: false, shape: 'read' }, 'sess-strand-read-unnamed')

    expect({ status: run.job.status, code: run.job.error?.code ?? null }).toEqual({
      status: 'done',
      code: null,
    })
    expect(host.strand.composeRuns).toBe(2)
    // The retry found `slow` finished, not running: its next step carries the
    // asset `slow` produced, and was asked for once.
    expect(run.dispatched.filter((p) => p.startsWith('late'))).toEqual(['late-img(slow)'])
    await expectFirstAttemptStartedNothingMore(host, run)
  })

  it('a retried meta step reads the real output of a step its failed attempt left running when the steps are named', async () => {
    const { host, run } = await strandRun({ named: true, shape: 'read' }, 'sess-strand-read-named')

    expect({ status: run.job.status, code: run.job.error?.code ?? null }).toEqual({
      status: 'done',
      code: null,
    })
    expect(host.strand.composeRuns).toBe(2)
    expect(run.dispatched.filter((p) => p.startsWith('late'))).toEqual(['late-img(slow)'])
    await expectFirstAttemptStartedNothingMore(host, run)
  })

  it('a retried meta step meets no DUPLICATE_STEP_ID from a step its failed attempt started late when the steps are unnamed', async () => {
    const { host, run } = await strandRun({ named: false, shape: 'late' }, 'sess-strand-late-unnamed')

    expect({ status: run.job.status, code: run.job.error?.code ?? null }).toEqual({
      status: 'done',
      code: null,
    })
    expect(host.strand.composeRuns).toBe(2)
    // Only the retry dispatched `late`: the failed attempt's branch was
    // refused before it took an id.
    expect(run.dispatched.filter((p) => p === 'late')).toEqual(['late'])
    await expectFirstAttemptStartedNothingMore(host, run)
  })

  it('a retried meta step meets no DUPLICATE_STEP_ID from a step its failed attempt started late when the steps are named', async () => {
    const { host, run } = await strandRun({ named: true, shape: 'late' }, 'sess-strand-late-named')

    expect({ status: run.job.status, code: run.job.error?.code ?? null }).toEqual({
      status: 'done',
      code: null,
    })
    expect(host.strand.composeRuns).toBe(2)
    expect(run.dispatched.filter((p) => p === 'late')).toEqual(['late'])
    await expectFirstAttemptStartedNothingMore(host, run)
  })

  it('a step or a park a failed compose asks for afterwards is refused and dispatches nothing', async () => {
    const host = makeHost()
    host.failing.add('boom')
    const run = await host.run('meta_after_failure', { park: false }, 'sess-after-failure')
    expect({ status: run.job.status, code: run.job.error?.code ?? null }).toEqual({
      status: 'error',
      code: 'MOCK_FAIL',
    })

    // The row has failed; the branch it left waiting is let go only now.
    host.afterFailure.gate.resolve()
    expect(await host.afterFailure.outcome.promise).toEqual({
      step: 'STEP_AFTER_COMPOSE_FAILED',
      ask: 'STEP_AFTER_COMPOSE_FAILED',
    })
    expect(host.calls).not.toContain('after')
    expect(host.asked).toEqual([])
  })

  it('a branch of the failing compose parked on askUser does not hold it open', async () => {
    const host = makeHost()
    host.failing.add('boom')
    const answer = deferred()
    host.holdAsks(answer.promise)
    const run = await host.run('meta_after_failure', { park: true }, 'sess-parked-sibling')

    // The park is still open, and the row failed anyway: only steps are
    // waited for.
    expect({ status: run.job.status, code: run.job.error?.code ?? null }).toEqual({
      status: 'error',
      code: 'MOCK_FAIL',
    })
    expect(host.asked).toHaveLength(1)

    // Answered late, the branch can start nothing more.
    answer.resolve()
    expect(await host.afterFailure.outcome.promise).toEqual({
      step: 'STEP_AFTER_COMPOSE_FAILED',
      ask: 'STEP_AFTER_COMPOSE_FAILED',
    })
    expect(host.calls).not.toContain('after')
    expect(host.asked).toHaveLength(1)
  })

  it('a meta whose output the gate refuses settles the steps it started before its row fails', async () => {
    const host = makeHost()
    host.hold('slow', host.gateFails.slow.promise)
    const run = await host.run('meta_gate', {}, 'sess-gate')
    expect({ status: run.job.status, code: run.job.error?.code ?? null }).toEqual({
      status: 'error',
      code: 'OUTPUT_SCHEMA_MISMATCH',
    })

    // `slow` was still running when compose resolved; the row failed only
    // after it settled, and its branch could start nothing more.
    expect((await host.poll(rowOf(run, 'slow') ?? '')).status).toBe('done')
    expect(await host.gateFails.after.promise).toBe('STEP_AFTER_COMPOSE_FAILED')
    expect(host.calls.slice(run.dispatched.length)).toEqual([])
    expect(host.calls).not.toContain('after-gate')
  })

  it('ctx.submitJob is fenced like ctx.step: one in flight is waited for, and one asked for after is refused', async () => {
    const host = makeHost()
    host.failing.add('boom')
    host.hold('escape-slow', host.hatch.slow.promise)
    const run = await host.run('meta_escape', {}, 'sess-escape')
    expect({ status: run.job.status, code: run.job.error?.code ?? null }).toEqual({
      status: 'error',
      code: 'MOCK_FAIL',
    })

    expect((await host.poll(rowOf(run, 'escape-slow') ?? '')).status).toBe('done')
    expect(await host.hatch.probe.promise).toBe('STEP_AFTER_COMPOSE_FAILED')
    expect(host.calls).not.toContain('escape-after')
    host.hatch.slow.resolve()
  })
})
