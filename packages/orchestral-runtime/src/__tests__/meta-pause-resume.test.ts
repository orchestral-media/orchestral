// Park round-trip (human-in-the-loop ctx.askUser, in-stream park model).
//
// Builds a real InlineRuntime over an in-memory JobStore + a fake router that
// counts how many times the cheap pre-park atomic actually runs, and a fake
// `askUser` handler injected at construction. Validates:
//   • ctx.askUser bridges to the handler and parks (awaits) inline — compose's
//     local state is preserved; the cheap pre-park step runs exactly ONCE (no
//     replay), and the handler is called exactly once per ctx.askUser.
//   • Two sequential ctx.askUser calls park in order with no answer accumulation.
//   • A parallel() branch that calls ctx.askUser resolves naturally.
//   • Aborting the job mid-park makes ctx.askUser reject CANCELLED (the meta
//     unwinds to 'cancelled', not 'done').

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type {
  AskUserHandler,
  AskUserRequest,
  CapabilityRouter,
  ModelCapability,
  Modality,
  MetaPattern,
  ExecutionContext,
} from '@orchestral/core'
import {
  silentDiagnosticsLogger,
  parallel,
  PatternRegistry,
} from '@orchestral/core'
import { InMemoryJobStore as MemoryJobStore } from '@orchestral/core/memory'
import { createTextGenerationPattern } from '@orchestral/patterns'

import { InlineRuntime } from '../inline'

function makeRouter(onCall: () => void): CapabilityRouter {
  const cap = {
    modelId: 'fake:gpt',
    provider: 'fake',
    tags: [],
    capabilities: ['text-generation'],
    inputs: ['text'] as Modality[],
    outputs: ['text'] as Modality[],
    source: 'user',
    async call() {
      onCall()
      return {
        output: {
          modality: 'text',
          text: 'cheap-ran',
          cost: 0,
          latencyMs: 1,
          model: 'fake:gpt',
          provider: 'fake',
          finishReason: 'stop',
        },
      } as unknown
    },
  } as unknown as ModelCapability
  return {
    checkSatisfiable: () => ({ ok: true, candidates: [cap] }),
    resolve: () => cap,
  } as unknown as CapabilityRouter
}

// A meta that runs one cheap atomic (counted), then asks the user for approval,
// then returns the user's answer + the cheap step's output.
function makePauseMeta(): MetaPattern {
  return {
    id: 'meta_pause_demo',
    kind: 'meta',
    description: 'demo ask meta',
    tool: { description: 'demo', inputs: z.object({}) },
    outputs: z.object({ approved: z.string(), ranText: z.string() }),
    async compose(_params: { input: unknown }, ctx: ExecutionContext) {
      const a = await ctx.step<{ text: string }>({
        patternId: 'text-generation',
        input: { system: 'CHEAP', prompt: 'x', responseFormat: 'json', jsonSchema: {} },
      })
      const choice = await ctx.askUser.custom<{ options: string[] }, string>({
        kind: 'choice',
        payload: { options: ['ship', 'redo'] },
        answerSchema: z.string(),
      })
      return { approved: choice, ranText: a.text }
    },
  } as unknown as MetaPattern
}

let registry: PatternRegistry
let onCall: ReturnType<typeof vi.fn>

beforeEach(() => {
  onCall = vi.fn()
  registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  registry.add(
    createTextGenerationPattern() as unknown as Parameters<typeof registry.add>[0],
  )
  registry.add(makePauseMeta() as unknown as Parameters<typeof registry.add>[0])
})

function makeRuntime(askUser: AskUserHandler): InlineRuntime {
  return new InlineRuntime({
    router: makeRouter(onCall),
    registry,
    store: new MemoryJobStore() as never,
    askUser,
  })
}

describe('meta park round-trip (ctx.askUser → handler → continue)', () => {
  it('parks at askUser, the handler answers, compose continues — cheap step runs once (no replay)', async () => {
    const seen: AskUserRequest[] = []
    const askUser = vi.fn<AskUserHandler>(async (req) => {
      seen.push(req)
      return 'ship'
    })
    const runtime = makeRuntime(askUser)

    const done = await runtime.submitJob({
      patternId: 'meta_pause_demo',
      input: {},
      sessionId: 's1',
    } as never)

    expect(done.status).toBe('done')
    expect(done.error).toBeNull()
    expect(done.output).toEqual({ approved: 'ship', ranText: 'cheap-ran' })
    // The handler was called exactly once for the single ctx.askUser.
    expect(askUser).toHaveBeenCalledTimes(1)
    // The cheap pre-park step ran exactly once — it is the SAME compose
    // invocation throughout (no replay across the park).
    expect(onCall).toHaveBeenCalledTimes(1)
    // The request carries the runtime-minted id, the session, and the jobId so
    // the host can route the answer back + surface it on the right tool chip.
    expect(seen).toHaveLength(1)
    expect(seen[0]!.kind).toBe('choice')
    expect(seen[0]!.payload).toEqual({ options: ['ship', 'redo'] })
    expect(seen[0]!.sessionId).toBe('s1')
    expect(seen[0]!.jobId).toBe(done.id)
    expect(typeof seen[0]!.id).toBe('string')
  })

  it('validates the answer against answerSchema (the runtime is authoritative)', async () => {
    // The handler returns a non-string; z.string() must reject → the meta errors.
    const askUser = vi.fn<AskUserHandler>(async () => 123)
    const runtime = makeRuntime(askUser)
    const job = await runtime.submitJob({
      patternId: 'meta_pause_demo',
      input: {},
      sessionId: 's2',
    } as never)
    expect(job.status).toBe('error')
    expect(job.error).not.toBeNull()
  })

  it('fails with ASK_USER_NOT_SUPPORTED when the runtime has no askUser handler', async () => {
    const runtime = new InlineRuntime({
      router: makeRouter(onCall),
      registry,
      store: new MemoryJobStore() as never,
    })
    const job = await runtime.submitJob({
      patternId: 'meta_pause_demo', input: {}, sessionId: 's',
    } as never)
    expect(job.status).toBe('error')
    expect(job.error?.message).toMatch(/ASK_USER_NOT_SUPPORTED/)
  })
})

// A meta with TWO sequential checkpoints — exercises sequential parks with no
// answer accumulation (the park keeps compose's local state on the stack).
function makeTwoPauseMeta(): MetaPattern {
  return {
    id: 'meta_two_pause',
    kind: 'meta',
    description: 'two sequential checkpoints',
    tool: { description: 'demo', inputs: z.object({}) },
    outputs: z.object({ a: z.string(), b: z.string(), ran: z.number() }),
    async compose(_params: { input: unknown }, ctx: ExecutionContext) {
      const r = await ctx.step<{ text: string }>({
        patternId: 'text-generation',
        input: { system: 'CHEAP', prompt: 'x', responseFormat: 'json', jsonSchema: {} },
      })
      const a = await ctx.askUser.custom<{ which: string }, string>({
        kind: 'choice', payload: { which: 'A' }, answerSchema: z.string(),
      })
      const b = await ctx.askUser.custom<{ which: string }, string>({
        kind: 'choice', payload: { which: 'B' }, answerSchema: z.string(),
      })
      return { a, b, ran: r.text === 'cheap-ran' ? 1 : 0 }
    },
  } as unknown as MetaPattern
}

describe('sequential + parallel parks', () => {
  it('parks twice in sequence — answers route by request order, no accumulation', async () => {
    registry.add(makeTwoPauseMeta() as unknown as Parameters<typeof registry.add>[0])
    const order: string[] = []
    const askUser = vi.fn<AskUserHandler>(async (req) => {
      const which = (req.payload as { which: string }).which
      order.push(which)
      return which === 'A' ? 'ansA' : 'ansB'
    })
    const runtime = makeRuntime(askUser)

    const done = await runtime.submitJob({
      patternId: 'meta_two_pause', input: {}, sessionId: 's',
    } as never)

    expect(done.status).toBe('done')
    expect(done.output).toEqual({ a: 'ansA', b: 'ansB', ran: 1 })
    expect(askUser).toHaveBeenCalledTimes(2)
    expect(order).toEqual(['A', 'B']) // strictly sequential
    expect(onCall).toHaveBeenCalledTimes(1) // cheap step ran once
    // Distinct correlation ids per park.
    const ids = askUser.mock.calls.map((c) => c[0].id)
    expect(new Set(ids).size).toBe(2)
  })

  it('a parallel() branch that asks the user resolves naturally (no special-casing)', async () => {
    const parallelMeta = {
      id: 'meta_parallel_ask',
      kind: 'meta',
      description: 'parallel ask',
      tool: { description: 'demo', inputs: z.object({}) },
      outputs: z.object({ left: z.string(), right: z.string() }),
      async compose(_params: { input: unknown }, ctx: ExecutionContext) {
        const [left, right] = await parallel([
          ctx.askUser.custom<{ side: string }, string>({
            kind: 'confirm', payload: { side: 'left' }, answerSchema: z.string(),
          }),
          Promise.resolve('right-static'),
        ])
        return { left, right }
      },
    } as unknown as MetaPattern
    registry.add(parallelMeta as unknown as Parameters<typeof registry.add>[0])

    const askUser = vi.fn<AskUserHandler>(async () => 'left-answer')
    const runtime = makeRuntime(askUser)

    const done = await runtime.submitJob({
      patternId: 'meta_parallel_ask', input: {}, sessionId: 's',
    } as never)
    expect(done.status).toBe('done')
    expect(done.output).toEqual({ left: 'left-answer', right: 'right-static' })
    expect(askUser).toHaveBeenCalledTimes(1)
  })

  // RUNTIME-LAYER contract: the runtime mints a distinct id per ctx.askUser and
  // routes each answer back to its own parked branch under concurrency. NB — this
  // is the runtime guarantee, NOT a desktop e2e claim: the desktop host surfaces
  // ONE answer card per meta tool chip, so two SIMULTANEOUS parks on one job are a
  // runtime capability it does not yet render 1:1 (known limitation; shipped metas
  // park sequentially). See the park-model spec's "concurrent parks" note.
  it('two simultaneous parks in one parallel() route answers by request id, not crossed (runtime layer)', async () => {
    const twoParkMeta = {
      id: 'meta_two_park',
      kind: 'meta',
      description: 'two concurrent parks',
      tool: { description: 'demo', inputs: z.object({}) },
      outputs: z.object({ a: z.string(), b: z.string() }),
      async compose(_params: { input: unknown }, ctx: ExecutionContext) {
        const [a, b] = await parallel([
          ctx.askUser.custom<{ side: string }, string>({
            kind: 'confirm', payload: { side: 'A' }, answerSchema: z.string(),
          }),
          ctx.askUser.custom<{ side: string }, string>({
            kind: 'confirm', payload: { side: 'B' }, answerSchema: z.string(),
          }),
        ])
        return { a, b }
      },
    } as unknown as MetaPattern
    registry.add(twoParkMeta as unknown as Parameters<typeof registry.add>[0])

    // Hold each request until BOTH have parked, then answer by the request's own
    // payload — so this only passes if the two parks are genuinely concurrent AND
    // each branch gets its own answer (no cross-talk through the shared handler).
    const seen: AskUserRequest[] = []
    let bothParked: () => void = () => {}
    const gate = new Promise<void>((r) => {
      bothParked = r
    })
    const askUser = vi.fn<AskUserHandler>(async (req) => {
      seen.push(req)
      if (seen.length === 2) bothParked()
      await gate
      return `answer-${(req.payload as { side: string }).side}`
    })
    const runtime = makeRuntime(askUser)

    const done = await runtime.submitJob({
      patternId: 'meta_two_park', input: {}, sessionId: 's',
    } as never)
    expect(done.status).toBe('done')
    expect(done.output).toEqual({ a: 'answer-A', b: 'answer-B' })
    expect(askUser).toHaveBeenCalledTimes(2)
    // The two concurrent requests carry distinct correlation ids.
    expect(new Set(seen.map((r) => r.id)).size).toBe(2)
  })

  it('returns the answerSchema OUTPUT, not the raw answer (parse is authoritative)', async () => {
    // A transforming schema proves compose receives the PARSED value, not the raw
    // handler answer — pins the parse contract against a "return raw answer" mutation.
    const xform = {
      id: 'meta_xform',
      kind: 'meta',
      description: 'transform',
      tool: { description: 'demo', inputs: z.object({}) },
      outputs: z.object({ shout: z.string() }),
      async compose(_p: { input: unknown }, ctx: ExecutionContext) {
        const shout = await ctx.askUser.custom<{ q: string }, string>({
          kind: 'confirm',
          payload: { q: 'name?' },
          answerSchema: z.string().transform((s) => s.toUpperCase()),
        })
        return { shout }
      },
    } as unknown as MetaPattern
    registry.add(xform as unknown as Parameters<typeof registry.add>[0])

    const askUser = vi.fn<AskUserHandler>(async () => 'quiet')
    const done = await makeRuntime(askUser).submitJob({
      patternId: 'meta_xform', input: {}, sessionId: 's',
    } as never)
    expect(done.status).toBe('done')
    expect(done.output).toEqual({ shout: 'QUIET' })
  })
})

describe('abort while parked', () => {
  it('cancelling the job mid-park makes ctx.askUser reject CANCELLED', async () => {
    let capturedJobId: string | undefined
    // A handler that never resolves — the park holds until abort wins the race.
    const askUser = vi.fn<AskUserHandler>(() => new Promise<unknown>(() => {}))
    const runtime = new InlineRuntime({
      router: makeRouter(onCall),
      registry,
      store: new MemoryJobStore() as never,
      askUser,
      // onJobCreated fires for the meta AND its cheap child step — capture only
      // the meta (the one that parks), not the child (which completes → done).
      onJobCreated: (jobId, spec) => {
        if (spec.patternId === 'meta_pause_demo') capturedJobId = jobId
      },
    })

    const pending = runtime.submitJob({
      patternId: 'meta_pause_demo', input: {}, sessionId: 's',
    } as never)

    // Let the meta reach its park (cheap step + the askUser call).
    await vi.waitFor(() => {
      expect(askUser).toHaveBeenCalledTimes(1)
      expect(capturedJobId).toBeDefined()
    })

    await runtime.cancelJob(capturedJobId!)
    // The park's abort race rejects CANCELLED → compose unwinds → the job
    // settles cancelled (NOT done, NOT a generic error).
    expect((await pending).status).toBe('cancelled')
    const settled = await runtime.pollJob(capturedJobId!)
    expect(settled.status).toBe('cancelled')
  })

  it('a park entered with an already-aborted signal settles cancelled without calling the handler', async () => {
    let capturedJobId: string | undefined
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const askUser = vi.fn<AskUserHandler>(async () => 'never')
    const gatedMeta = {
      id: 'meta_pre_abort',
      kind: 'meta',
      description: 'gate then park',
      tool: { description: 'demo', inputs: z.object({}) },
      outputs: z.object({ v: z.string() }),
      async compose(_p: { input: unknown }, ctx: ExecutionContext) {
        await gate // hold here until the test cancels, THEN proceed to the park
        const v = await ctx.askUser.custom<{ q: string }, string>({
          kind: 'confirm', payload: { q: '?' }, answerSchema: z.string(),
        })
        return { v }
      },
    } as unknown as MetaPattern
    registry.add(gatedMeta as unknown as Parameters<typeof registry.add>[0])
    const runtime = new InlineRuntime({
      router: makeRouter(onCall),
      registry,
      store: new MemoryJobStore() as never,
      askUser,
      onJobCreated: (jobId, spec) => {
        if (spec.patternId === 'meta_pre_abort') capturedJobId = jobId
      },
    })

    const pending = runtime.submitJob({
      patternId: 'meta_pre_abort', input: {}, sessionId: 's',
    } as never)
    await vi.waitFor(() => expect(capturedJobId).toBeDefined())

    await runtime.cancelJob(capturedJobId!) // signal aborts while compose waits at the gate
    release() // compose resumes → reaches askUser with the signal ALREADY aborted

    expect((await pending).status).toBe('cancelled')
    // The top-of-askUser guard fired before bridging to the host — handler untouched.
    expect(askUser).not.toHaveBeenCalled()
  })
})

describe('nested park routes to the dispatch-tree root (rootJobId)', () => {
  it('a park from a nested ctx.step meta carries the ROOT jobId, not the child jobId', async () => {
    const childPark = {
      id: 'meta_child_park',
      kind: 'meta',
      description: 'child that parks',
      tool: { description: 'c', inputs: z.object({}) },
      outputs: z.object({ v: z.string() }),
      async compose(_p: { input: unknown }, ctx: ExecutionContext) {
        const v = await ctx.askUser.custom<{ q: string }, string>({
          kind: 'confirm', payload: { q: '?' }, answerSchema: z.string(),
        })
        return { v }
      },
    } as unknown as MetaPattern
    const parent = {
      id: 'meta_parent',
      kind: 'meta',
      description: 'steps a parking child',
      tool: { description: 'p', inputs: z.object({}) },
      outputs: z.object({ v: z.string() }),
      async compose(_p: { input: unknown }, ctx: ExecutionContext) {
        return await ctx.step<{ v: string }>({ patternId: 'meta_child_park', input: {} })
      },
    } as unknown as MetaPattern
    registry.add(childPark as unknown as Parameters<typeof registry.add>[0])
    registry.add(parent as unknown as Parameters<typeof registry.add>[0])

    const seen: AskUserRequest[] = []
    const askUser = vi.fn<AskUserHandler>(async (req) => {
      seen.push(req)
      return 'ok'
    })
    const done = await makeRuntime(askUser).submitJob({
      patternId: 'meta_parent', input: {}, sessionId: 's',
    } as never)

    expect(done.status).toBe('done')
    expect(done.output).toEqual({ v: 'ok' })
    // The park happened in the NESTED child meta, but its request carries the
    // ROOT (parent) jobId + a `${rootJobId}:ask:` id — so the host routes it to
    // the parent's tool chip and sweeps it under the parent prefix. Pre-fix this
    // was the child's own (unbound) jobId → the nested-park-unsurfaceable bug.
    expect(seen).toHaveLength(1)
    expect(seen[0]!.jobId).toBe(done.id)
    expect(seen[0]!.id.startsWith(`${done.id}:ask:`)).toBe(true)
  })
})
