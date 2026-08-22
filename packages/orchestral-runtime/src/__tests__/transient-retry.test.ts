// Same-model transient retry (`InlineRuntimeInit.transientRetry`) — the loop
// that sits INSIDE one hop of the atomic model fallback walk.
//
// The two budgets are separately bounded and these tests are what keeps them
// that way:
//
//   • Default OFF. Without `transientRetry` wired, a failing model is called
//     exactly once and excluded — the pre-0.1 behaviour, verbatim. Wiring a
//     default classifier in the library would flip this test RED, which is the
//     point: guessing at transience spends the host's money.
//   • Opt-in retry. With it wired and `isTransient` saying yes, the SAME model
//     is called `policy.maxAttempts` times before it is excluded.
//   • Retries do not buy fallback hops and hops do not buy retries — the last
//     test pins the exact call matrix.
//   • `isTransient` false is instant: no backoff, no second call.
//   • Abort during backoff settles the job cancelled immediately rather than
//     sleeping the delay out first.
//   • Every model the walk gives up on is announced once, as
//     `job:model-fallback` carrying that hop's attempt count and the provider's
//     own error — and nothing in a dispatch writes to the console. The loop
//     used to console.error every failure and this file had to spy on stderr
//     to see it; the event is the contract now, and the console spy exists to
//     prove it stays empty.
//
// Harness mirrors atomic-model-call-failure.test.ts: a real InlineRuntime over
// an in-memory store plus a hand-rolled fake router whose resolve/call we
// script. No alternatives are registered, so a terminal failure falls straight
// through to `throw lastErr`, lands on the row as its JobError, and submitJob
// resolves with the failed Job.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type {
  AtomicPattern,
  CapabilityRouter,
  DiagnosticsLogger,
  JobEvent,
  Modality,
  ModelCapability,
  ResolveContext,
} from '@orchestral/core'
import { InMemoryJobStore as MemoryJobStore, PatternRegistry } from '@orchestral/core'

import { InlineRuntime, type TransientFailureInfo } from '../inline'

const TEXT_OUTPUT = z.object({ modality: z.literal('text'), text: z.string() })

function atomic(id: string): AtomicPattern {
  return {
    id,
    kind: 'atomic',
    description: `atomic ${id}`,
    exposure: 'agent-tool',
    outputs: TEXT_OUTPUT,
    primary: {
      tool: { description: id, inputs: z.object({ prompt: z.string() }) },
      modelTags: [],
    },
  } as unknown as AtomicPattern
}

function model(
  provider: string,
  modelId: string,
  call: ModelCapability['call'],
): ModelCapability {
  return {
    modelId,
    provider,
    tags: [],
    capabilities: [],
    inputs: ['text'] as Modality[],
    outputs: ['text'] as Modality[],
    source: 'user' as const,
    call,
  } as unknown as ModelCapability
}

/** A model whose call always throws, counting how many times it was called. */
function failing(provider: string, modelId: string, err: () => Error) {
  const calls = { n: 0 }
  return {
    calls,
    cap: model(provider, modelId, async () => {
      calls.n++
      throw err()
    }),
  }
}

function succeeding(provider: string, modelId: string, text: string) {
  const calls = { n: 0 }
  return {
    calls,
    cap: model(provider, modelId, async () => {
      calls.n++
      return { output: { modality: 'text', text } } as never
    }),
  }
}

/**
 * Router that hands back `order[hop]` and records the excludeModel it was
 * given, so a test can assert both which candidates were walked and when a
 * model was given up on.
 */
function scriptedRouter(order: readonly ModelCapability[]) {
  const excludeSeen: string[][] = []
  let hop = 0
  const router: CapabilityRouter = {
    checkSatisfiable: () => ({ ok: true, candidates: [order[0] as never] }),
    resolve: (_cap, _tags, ctx: ResolveContext) => {
      excludeSeen.push([...(ctx.excludeModel ?? [])])
      const next = order[hop++]
      if (!next) throw new Error('ROUTER_EXHAUSTED')
      return next
    },
  }
  return { router, excludeSeen, resolves: () => hop }
}

type ModelFallbackEvent = Extract<JobEvent, { type: 'job:model-fallback' }>

/**
 * Every event the job under test fanned out, in order, and every line the
 * runtime sent to its DiagnosticsLogger. Both reset per test. The logger is
 * injected rather than left on the console default so the console spies
 * below prove a dispatch writes nothing there — not merely that it writes
 * little.
 */
let events: JobEvent[] = []
let diagnostics: { level: 'warn' | 'error'; message: string }[] = []
const logger: DiagnosticsLogger = {
  warn: (message) => void diagnostics.push({ level: 'warn', message }),
  error: (message) => void diagnostics.push({ level: 'error', message }),
}
const fallbacks = (): ModelFallbackEvent[] =>
  events.filter((e): e is ModelFallbackEvent => e.type === 'job:model-fallback')

function runtimeFor(
  router: CapabilityRouter,
  init: Partial<ConstructorParameters<typeof InlineRuntime>[0]> = {},
) {
  const registry = new PatternRegistry({ logger })
  registry.register(atomic('cap'))
  const rt = new InlineRuntime({
    store: new MemoryJobStore() as never,
    registry,
    router,
    logger,
    ...init,
    // submitJob resolves at terminal, so onJobCreated is the only window in
    // which a subscription still sees progress events. A caller's own hook
    // runs after the subscription is attached.
    onJobCreated: (jobId, spec) => {
      rt.subscribe(jobId, (ev) => void events.push(ev))
      init.onJobCreated?.(jobId, spec)
    },
  })
  return rt
}

/** A 429 the way a provider SDK would throw it — a message plus a code. */
const transientErr = () =>
  Object.assign(new Error('RATE_LIMITED_429'), { code: 'RATE_LIMITED' })

let consoleError: ReturnType<typeof vi.spyOn>
let consoleWarn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  events = []
  diagnostics = []
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  // The contract every test in this file runs under: a dispatch — retries,
  // fallback hops, a host predicate that throws — never reaches the console.
  // It goes to the job stream or to the injected logger, nowhere else.
  expect(consoleError).not.toHaveBeenCalled()
  expect(consoleWarn).not.toHaveBeenCalled()
  consoleError.mockRestore()
  consoleWarn.mockRestore()
})

describe('same-model transient retry', () => {
  it('is off by default — a failing model is called once and excluded', async () => {
    // No `transientRetry` on the init. Even an error that any classifier would
    // call transient (a 429) gets exactly one call, because the library ships
    // no classifier. This is the behaviour lock: the default must stay
    // byte-identical to a runtime that has never heard of retry.
    const a = failing('prov', 'A', transientErr)
    const b = succeeding('prov', 'B', 'from-B')
    const { router, excludeSeen } = scriptedRouter([a.cap, b.cap])

    const job = await runtimeFor(router).submitJob({
      patternId: 'cap',
      input: { prompt: 'go' },
    })

    expect(job.output).toEqual({ modality: 'text', text: 'from-B' })
    expect(a.calls.n).toBe(1)
    expect(b.calls.n).toBe(1)
    // A was given up on after that single call, so hop 1 resolved with it out.
    expect(excludeSeen).toEqual([[], ['prov:A']])
    // ...and the give-up is on the job stream, once, with the provider's own
    // error: one attempt, because nothing granted a second.
    expect(fallbacks()).toMatchObject([
      {
        capability: 'cap',
        failedModel: 'prov:A',
        hop: 0,
        attempts: 1,
        error: { code: 'RATE_LIMITED', message: 'RATE_LIMITED_429' },
      },
    ])
  })

  it('retries the SAME model maxAttempts times before excluding it', async () => {
    // isTransient says yes every time; maxAttempts 3 = the original call plus
    // two retries, all against A, and only THEN is A excluded.
    const a = failing('prov', 'A', transientErr)
    const b = succeeding('prov', 'B', 'from-B')
    const { router, excludeSeen } = scriptedRouter([a.cap, b.cap])
    const seen: TransientFailureInfo[] = []

    const job = await runtimeFor(router, {
      transientRetry: {
        isTransient: (_e, info) => {
          seen.push(info)
          return true
        },
        policy: { kind: 'fixed', maxAttempts: 3, delayMs: 0 },
      },
    }).submitJob({ patternId: 'cap', input: { prompt: 'go' } })

    expect(job.output).toEqual({ modality: 'text', text: 'from-B' })
    expect(a.calls.n).toBe(3)
    // One hop per model — the three A calls cost a single fallback step.
    expect(excludeSeen).toEqual([[], ['prov:A']])
    // The predicate sees the capability, the model, and a 1-based attempt
    // counter that restarts per model.
    expect(seen).toEqual([
      { capability: 'cap', model: 'prov:A', attempt: 1 },
      { capability: 'cap', model: 'prov:A', attempt: 2 },
      { capability: 'cap', model: 'prov:A', attempt: 3 },
    ])
    // One event for the hop — not one per attempt — and it carries the attempt
    // count, so a support ticket can tell "tried three providers" from "tried
    // one provider three times".
    expect(fallbacks()).toMatchObject([
      { failedModel: 'prov:A', hop: 0, attempts: 3, error: { code: 'RATE_LIMITED' } },
    ])
  })

  it('falls back to the next model once the retries are spent', async () => {
    // Exhausting A's attempts must not end the dispatch — the walk still gets
    // its hop, and the surviving error is the provider's, not a retry code.
    const a = failing('prov', 'A', transientErr)
    const b = succeeding('prov', 'B', 'from-B')
    const { router, resolves } = scriptedRouter([a.cap, b.cap])

    const job = await runtimeFor(router, {
      transientRetry: {
        isTransient: () => true,
        policy: { kind: 'exponential', maxAttempts: 2, baseMs: 1, maxMs: 2 },
      },
    }).submitJob({ patternId: 'cap', input: { prompt: 'go' } })

    expect(a.calls.n).toBe(2)
    expect(b.calls.n).toBe(1)
    expect(resolves()).toBe(2)
    expect(job.output).toEqual({ modality: 'text', text: 'from-B' })
    // B succeeded, so only A was given up on: one event, two attempts.
    expect(fallbacks().map((e) => [e.failedModel, e.attempts])).toEqual([['prov:A', 2]])
  })

  it('excludes immediately — no retry, no backoff — when isTransient says false', async () => {
    // A content rejection is not a blip. The host says so and the model is
    // given up on after one call, exactly as if retry were not wired at all.
    const a = failing('prov', 'A', () => new Error('CONTENT_POLICY_REJECTED'))
    const b = succeeding('prov', 'B', 'from-B')
    const { router, excludeSeen } = scriptedRouter([a.cap, b.cap])
    const started = Date.now()

    const job = await runtimeFor(router, {
      transientRetry: {
        isTransient: () => false,
        // A delay long enough that sleeping even once would blow the budget
        // below — a `false` verdict must cost nothing.
        policy: { kind: 'fixed', maxAttempts: 5, delayMs: 30_000 },
      },
    }).submitJob({ patternId: 'cap', input: { prompt: 'go' } })

    expect(a.calls.n).toBe(1)
    expect(job.output).toEqual({ modality: 'text', text: 'from-B' })
    expect(excludeSeen).toEqual([[], ['prov:A']])
    expect(Date.now() - started).toBeLessThan(2_000)
    // A provider error with no code normalises to the dispatch default; the
    // event reports what the provider said, never a retry verdict.
    expect(fallbacks()).toMatchObject([
      {
        failedModel: 'prov:A',
        attempts: 1,
        error: { code: 'DISPATCH_EXECUTE_FAILED', message: 'CONTENT_POLICY_REJECTED' },
      },
    ])
  })

  it("treats a wired policy of { kind: 'none' } as inert", async () => {
    // Documented as "wired but inert": the predicate can say yes as loudly as
    // it likes, a policy with no attempts left grants none.
    const a = failing('prov', 'A', transientErr)
    const b = succeeding('prov', 'B', 'from-B')
    const { router } = scriptedRouter([a.cap, b.cap])

    await runtimeFor(router, {
      transientRetry: { isTransient: () => true, policy: { kind: 'none' } },
    }).submitJob({ patternId: 'cap', input: { prompt: 'go' } })

    expect(a.calls.n).toBe(1)
    expect(b.calls.n).toBe(1)
    expect(fallbacks().map((e) => e.attempts)).toEqual([1])
  })

  it('reads a throwing isTransient as false without displacing the provider error', async () => {
    // A predicate that reaches into an error shape it did not get is a host
    // bug. It must not become the error the caller sees — the provider failure
    // is the actionable one, and the loop's whole lastErr discipline exists to
    // keep it that way.
    const a = failing('prov', 'A', () => new Error('REAL_PROVIDER_FAILURE'))
    const { router } = scriptedRouter([a.cap])

    const rt = runtimeFor(router, {
      resolveCtxProvider: () => ({ fallbackDepth: 0 }),
      transientRetry: {
        isTransient: () => {
          throw new TypeError('PREDICATE_BUG')
        },
        policy: { kind: 'fixed', maxAttempts: 5, delayMs: 0 },
      },
    })

    const job = await rt.submitJob({ patternId: 'cap', input: { prompt: 'go' } })
    expect(job.status).toBe('error')
    expect(job.error?.message).toBe('REAL_PROVIDER_FAILURE')
    // No retry was granted, and the bug was reported — to the injected logger,
    // which is the one channel a host-callback failure has — not swallowed.
    expect(a.calls.n).toBe(1)
    expect(
      diagnostics.some(
        (d) => d.level === 'error' && d.message.includes('isTransient threw'),
      ),
    ).toBe(true)
    // The event carries the provider's failure, not the predicate's.
    expect(fallbacks()).toMatchObject([
      { attempts: 1, error: { message: 'REAL_PROVIDER_FAILURE' } },
    ])
  })

  it('settles cancelled immediately when the job is cancelled during backoff', async () => {
    // The backoff is 30s. Cancelling 20ms in must settle then, not half a
    // minute later — abortableSleep rejects on the signal instead of running
    // the timer down.
    let jobId: string | undefined
    let rt: InlineRuntime
    const calls = { n: 0 }
    const modelA = model('prov', 'A', async () => {
      calls.n++
      setTimeout(() => {
        void rt.cancelJob(jobId!)
      }, 20)
      throw transientErr()
    })
    const modelB = model('prov', 'B', async () => {
      throw new Error('SHOULD_NEVER_RUN')
    })
    const { router, resolves } = scriptedRouter([modelA, modelB])

    rt = runtimeFor(router, {
      transientRetry: {
        isTransient: () => true,
        policy: { kind: 'fixed', maxAttempts: 5, delayMs: 30_000 },
      },
      onJobCreated: (id) => {
        jobId = id
      },
    })

    const started = Date.now()
    const job = await rt.submitJob({ patternId: 'cap', input: { prompt: 'go' } })
    expect(job.status).toBe('cancelled')
    expect(Date.now() - started).toBeLessThan(5_000)
    // The abort landed inside the backoff: one call made, no second attempt,
    // and the walk never advanced to B.
    expect(calls.n).toBe(1)
    expect(resolves()).toBe(1)
    // A cancelled hop is not a hop the dispatch gave up on: no event.
    expect(fallbacks()).toEqual([])
  })

  it('keeps the retry budget and the fallback budget out of each other', async () => {
    // fallbackDepth 1 → two candidates (hop 0 and hop 1). maxAttempts 2 → two
    // calls per candidate. The exact matrix is 2×2: retries did not consume a
    // hop (B is still reached) and hops did not top up the attempts (neither
    // model gets a third call). C exists only to prove the walk stopped where
    // fallbackDepth said, not where the retries ran out.
    const a = failing('prov', 'A', transientErr)
    const b = failing('prov', 'B', transientErr)
    const c = failing('prov', 'C', transientErr)
    const { router, excludeSeen, resolves } = scriptedRouter([
      a.cap,
      b.cap,
      c.cap,
    ])

    const rt = runtimeFor(router, {
      resolveCtxProvider: () => ({ fallbackDepth: 1 }),
      transientRetry: {
        isTransient: () => true,
        policy: { kind: 'fixed', maxAttempts: 2, delayMs: 0 },
      },
    })

    const job = await rt.submitJob({ patternId: 'cap', input: { prompt: 'go' } })
    expect(job.status).toBe('error')
    expect(job.error?.message).toBe('RATE_LIMITED_429')

    expect(a.calls.n).toBe(2)
    expect(b.calls.n).toBe(2)
    expect(c.calls.n).toBe(0)
    expect(resolves()).toBe(2)
    expect(excludeSeen).toEqual([[], ['prov:A']])
    // The same 2×2 matrix as the subscriber saw it: one event per hop, each
    // naming its own model and its own two attempts. Both landed before the
    // terminal event, which can only carry the last of the two errors.
    expect(fallbacks().map((e) => [e.failedModel, e.hop, e.attempts])).toEqual([
      ['prov:A', 0, 2],
      ['prov:B', 1, 2],
    ])
    const types = events.map((e) => e.type)
    expect(types.lastIndexOf('job:model-fallback')).toBeLessThan(types.indexOf('job:failed'))
  })

  it('leaves the fallback walk at full width when retries are wired', async () => {
    // Same fallbackDepth as the default, retries on, every failure transient:
    // the walk must still visit the same number of candidates it would have
    // without retry. A budget that leaked would show up as a shorter walk.
    const models = ['A', 'B', 'C', 'D', 'E'].map((id) =>
      failing('prov', id, transientErr),
    )
    const { router, resolves } = scriptedRouter(models.map((m) => m.cap))

    const rt = runtimeFor(router, {
      transientRetry: {
        isTransient: () => true,
        policy: { kind: 'fixed', maxAttempts: 2, delayMs: 0 },
      },
    })

    const job = await rt.submitJob({ patternId: 'cap', input: { prompt: 'go' } })
    expect(job.status).toBe('error')
    expect(job.error?.message).toBe('RATE_LIMITED_429')

    // Default fallbackDepth 3 → hops 0..3 → four candidates, E untouched.
    expect(resolves()).toBe(4)
    expect(models.map((m) => m.calls.n)).toEqual([2, 2, 2, 2, 0])
    expect(fallbacks().map((e) => [e.failedModel, e.hop])).toEqual([
      ['prov:A', 0],
      ['prov:B', 1],
      ['prov:C', 2],
      ['prov:D', 3],
    ])
  })
})
