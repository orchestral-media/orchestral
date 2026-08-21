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
//   • Abort during backoff rejects immediately rather than sleeping the delay
//     out first.
//
// Harness mirrors atomic-model-call-failure.test.ts: a real InlineRuntime over
// an in-memory store plus a hand-rolled fake router whose resolve/call we
// script. No alternatives are registered, so a terminal failure falls straight
// through to `throw lastErr` and the submitJob promise rejects with it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type {
  AtomicPattern,
  CapabilityRouter,
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

function runtimeFor(
  router: CapabilityRouter,
  init: Partial<ConstructorParameters<typeof InlineRuntime>[0]> = {},
) {
  const registry = new PatternRegistry()
  registry.register(atomic('cap'))
  return new InlineRuntime({
    store: new MemoryJobStore() as never,
    registry,
    router,
    ...init,
  })
}

const transientErr = () => new Error('RATE_LIMITED_429')

let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  // The dispatch loop prints every provider failure by design; these tests
  // provoke a lot of them on purpose.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleError.mockRestore()
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
    // The log line names the hop and the attempt so a support ticket can tell
    // "tried three providers" from "tried one provider three times".
    expect(consoleError).toHaveBeenCalledTimes(3)
    expect(String(consoleError.mock.calls[2]?.[0])).toContain(
      'hop=0, attempt=3',
    )
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

    await expect(
      rt.submitJob({ patternId: 'cap', input: { prompt: 'go' } }),
    ).rejects.toThrow('REAL_PROVIDER_FAILURE')
    // No retry was granted, and the bug was reported rather than swallowed.
    expect(a.calls.n).toBe(1)
    expect(
      consoleError.mock.calls.some((c) =>
        String(c[0]).includes('isTransient threw'),
      ),
    ).toBe(true)
  })

  it('rejects immediately when the job is cancelled during backoff', async () => {
    // The backoff is 30s. Cancelling 20ms in must reject then, not half a
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
    await expect(
      rt.submitJob({ patternId: 'cap', input: { prompt: 'go' } }),
    ).rejects.toThrow(/CANCELLED/)
    expect(Date.now() - started).toBeLessThan(5_000)
    // The abort landed inside the backoff: one call made, no second attempt,
    // and the walk never advanced to B.
    expect(calls.n).toBe(1)
    expect(resolves()).toBe(1)
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

    await expect(
      rt.submitJob({ patternId: 'cap', input: { prompt: 'go' } }),
    ).rejects.toThrow('RATE_LIMITED_429')

    expect(a.calls.n).toBe(2)
    expect(b.calls.n).toBe(2)
    expect(c.calls.n).toBe(0)
    expect(resolves()).toBe(2)
    expect(excludeSeen).toEqual([[], ['prov:A']])
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

    await expect(
      rt.submitJob({ patternId: 'cap', input: { prompt: 'go' } }),
    ).rejects.toThrow('RATE_LIMITED_429')

    // Default fallbackDepth 3 → hops 0..3 → four candidates, E untouched.
    expect(resolves()).toBe(4)
    expect(models.map((m) => m.calls.n)).toEqual([2, 2, 2, 2, 0])
  })
})
