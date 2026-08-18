// dispatchAtomic's in-Router retry loop (inline.ts ~891–937) — error-path
// coverage. The happy path is exercised everywhere; these lock the failure
// branches that have NO other coverage:
//
//   • excludeModel accumulation — a failed model.call pushes its
//     `provider:modelId` into excludeModel and the loop retries with it
//     excluded (catch ~924).
//   • lastErr preservation guard ~905 — when router.resolve throws on a
//     retry (all candidates excluded → MODEL_EXCLUDED), it must NOT overwrite
//     the FIRST real provider error. The UI must surface the real cause, not
//     the "excluded" symptom. Deleting `if (!lastErr)` flips test 2 RED.
//   • router exhaustion on attempt 0 (lastErr still null) — the resolve error
//     propagates unchanged.
//   • abort between attempts — signal aborted during retry throws CANCELLED.
//   • excludeModel base seeding ~851 — baseCtx.excludeModel is honoured on
//     attempt 0 (passed straight to the first resolve).
//
// Harness mirrors alternative-not-enabled.test.ts / abort-cascade.test.ts:
// a real InlineRuntime over an in-memory store + a hand-rolled fake router
// whose resolve/call we script per attempt. No alternatives are registered,
// so a terminal failure falls straight through to `throw lastErr` and the
// submitJob promise rejects with it.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type {
  AtomicPattern,
  CapabilityRouter,
  Modality,
  ModelCapability,
  ResolveContext,
} from '@orchestral/core'
import {
  InMemoryJobStore as MemoryJobStore,
  ModelExcludedError,
  PatternRegistry,
} from '@orchestral/core'

import { InlineRuntime } from '../inline'

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

// A model capability whose `call` runs the supplied behaviour. The
// provider:modelId pair is what the retry loop pushes into excludeModel.
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

const okCall =
  (text: string): ModelCapability['call'] =>
  async () =>
    ({ output: { modality: 'text', text } }) as never

const throwCall =
  (err: Error): ModelCapability['call'] =>
  async () => {
    throw err
  }

describe('dispatchAtomic retry loop — error paths', () => {
  it('retries the next model after a model.call failure and excludes the failed one', async () => {
    // Router scripts resolve() per attempt: attempt 0 → model A (whose call
    // throws), attempt 1 → model B (succeeds). We record the excludeModel ctx
    // seen on each resolve to prove A was excluded on the retry.
    const excludeSeen: string[][] = []
    const modelA = model('prov', 'A', throwCall(new Error('A_TRANSIENT_DOWN')))
    const modelB = model('prov', 'B', okCall('from-B'))
    let attempt = 0

    const router: CapabilityRouter = {
      checkSatisfiable: () => ({ ok: true, candidates: [modelA as never] }),
      resolve: (_cap, _tags, ctx: ResolveContext) => {
        excludeSeen.push([...(ctx.excludeModel ?? [])])
        return attempt++ === 0 ? modelA : modelB
      },
    }

    const registry = new PatternRegistry()
    registry.register(atomic('cap'))
    const rt = new InlineRuntime({
      store: new MemoryJobStore() as never,
      registry,
      router,
    })

    const job = await rt.submitJob({ patternId: 'cap', input: { prompt: 'go' } })

    expect(job.status).toBe('done')
    expect(job.output).toEqual({ modality: 'text', text: 'from-B' })
    // Attempt 0 saw no exclusions; attempt 1 saw A excluded by provider:modelId.
    expect(excludeSeen[0]).toEqual([])
    expect(excludeSeen[1]).toEqual(['prov:A'])
  })

  it('preserves the FIRST provider error when a retry resolve throws MODEL_EXCLUDED', async () => {
    // attempt 0: model A resolves, its call throws a DISTINCTIVE provider error.
    // attempt 1: A is now in excludeModel and is the only candidate, so resolve
    // throws MODEL_EXCLUDED. The lastErr guard (~905, `if (!lastErr)`) must keep
    // the original provider error — NOT the symptom. Deleting the guard makes
    // this assertion fail (it would surface MODEL_EXCLUDED instead).
    const providerErr = new Error('IMAGE_GEN_NOT_SUPPORTED_FOR_MODEL')
    const modelA = model('prov', 'A', throwCall(providerErr))

    const router: CapabilityRouter = {
      checkSatisfiable: () => ({ ok: true, candidates: [modelA as never] }),
      resolve: (_cap, _tags, ctx: ResolveContext) => {
        if ((ctx.excludeModel ?? []).includes('prov:A')) {
          throw new Error('MODEL_EXCLUDED: prov:A')
        }
        return modelA
      },
    }

    const registry = new PatternRegistry()
    registry.register(atomic('cap'))
    const rt = new InlineRuntime({
      store: new MemoryJobStore() as never,
      registry,
      router,
    })

    await expect(
      rt.submitJob({ patternId: 'cap', input: { prompt: 'go' } }),
    ).rejects.toThrow('IMAGE_GEN_NOT_SUPPORTED_FOR_MODEL')
    // And explicitly NOT the masking symptom.
    await expect(
      rt.submitJob({ patternId: 'cap', input: { prompt: 'go' } }),
    ).rejects.not.toThrow(/MODEL_EXCLUDED/)
  })

  it('propagates the resolve error when the router is exhausted on attempt 0 (lastErr null)', async () => {
    // resolve throws on the very first attempt — no model.call ever ran, so
    // lastErr is null and the guard records THIS error, which then propagates.
    const router: CapabilityRouter = {
      checkSatisfiable: () => ({ ok: true, candidates: [] }),
      resolve: () => {
        throw new Error('NO_CANDIDATE_AT_RESOLVE')
      },
    }

    const registry = new PatternRegistry()
    registry.register(atomic('cap'))
    const rt = new InlineRuntime({
      store: new MemoryJobStore() as never,
      registry,
      router,
    })

    await expect(
      rt.submitJob({ patternId: 'cap', input: { prompt: 'go' } }),
    ).rejects.toThrow('NO_CANDIDATE_AT_RESOLVE')
  })

  it('throws CANCELLED when the signal is aborted between retry attempts', async () => {
    // attempt 0: model A's call cancels its own job (aborts the runtime
    // controller) then throws — pushing A into excludeModel. attempt 1's
    // top-of-loop `if (signal.aborted) throw CANCELLED` (~892) fires before any
    // further resolve. The outer catch sees the aborted controller and rejects
    // with CANCELLED.
    let jobId: string | undefined
    let rt: InlineRuntime
    const modelA = model('prov', 'A', async () => {
      // cancelJob aborts the controller; await so the abort has landed before
      // we throw and the loop advances to the next attempt.
      await rt.cancelJob(jobId!)
      throw new Error('A_FAILED_AFTER_CANCEL')
    })
    const modelB = model('prov', 'B', okCall('should-never-run'))
    let attempt = 0

    const router: CapabilityRouter = {
      checkSatisfiable: () => ({ ok: true, candidates: [modelA as never] }),
      resolve: () => (attempt++ === 0 ? modelA : modelB),
    }

    const registry = new PatternRegistry()
    registry.register(atomic('cap'))
    rt = new InlineRuntime({
      store: new MemoryJobStore() as never,
      registry,
      router,
      onJobCreated: (id) => {
        jobId = id
      },
    })

    await expect(
      rt.submitJob({ patternId: 'cap', input: { prompt: 'go' } }),
    ).rejects.toThrow(/CANCELLED/)
    // B never resolved — the abort short-circuited the retry before attempt 1.
    expect(attempt).toBe(1)
    expect(jobId).toBeDefined()
  })

  it('fail-fast (maxRetries 0) rejects on first failure with failedModel + httpStatus in JobError.details', async () => {
    // The host's resolveCtxProvider now returns maxRetries: 0 — one model.call
    // per dispatch, no silent cross-provider walk (the LLM filled input against
    // THIS model's schema). The rejection must carry structured details so the
    // host can classify invalid-input (4xx) and derive the retry exclusion set.
    const providerErr = new Error(
      'APICallError 400: camera not supported',
    ) as Error & { httpStatus?: number }
    providerErr.httpStatus = 400
    const modelA = model('prov', 'A', throwCall(providerErr))
    const modelB = model('prov', 'B', okCall('should-never-run'))
    let resolves = 0

    const router: CapabilityRouter = {
      checkSatisfiable: () => ({ ok: true, candidates: [modelA as never] }),
      resolve: () => (resolves++ === 0 ? modelA : modelB),
    }

    const registry = new PatternRegistry()
    registry.register(atomic('cap'))
    const store = new MemoryJobStore()
    let jobId: string | undefined
    const rt = new InlineRuntime({
      store: store as never,
      registry,
      router,
      resolveCtxProvider: () => ({ maxRetries: 0 }),
      onJobCreated: (id) => {
        jobId = id
      },
    })

    await expect(
      rt.submitJob({ patternId: 'cap', input: { prompt: 'go' } }),
    ).rejects.toThrow('camera not supported')
    // Model B was never consulted — the walk is gone.
    expect(resolves).toBe(1)
    // The persisted JobError carries the structured provider-failure facts.
    const job = await store.get(jobId!)
    expect(job?.status).toBe('error')
    expect(job?.error?.details).toEqual({ httpStatus: 400, failedModel: 'prov:A' })
  })

  it('carries ModelExcludedError.diagnostic through to JobError.details', async () => {
    // A pinned model that is not among the candidates makes the router throw
    // ModelExcludedError with the diagnostic explaining WHY (requiredTags, what
    // survived). That diagnostic is the only way the host can tell the user
    // "your pin is not tagged for this capability" instead of a bare
    // MODEL_EXCLUDED, so normaliseError must lift it into JobError.details.
    const excluded = new ModelExcludedError('prov:pinned', {
      capability: 'text:generate' as never,
      requiredTags: ['text-generation'] as never,
      excludedByRetry: false,
      excludeModel: [],
      candidates: ['prov:A', 'prov:B'],
    })

    const router: CapabilityRouter = {
      checkSatisfiable: () => ({ ok: true, candidates: [] }),
      resolve: () => {
        throw excluded
      },
    }

    const registry = new PatternRegistry()
    registry.register(atomic('cap'))
    const store = new MemoryJobStore()
    let jobId: string | undefined
    const rt = new InlineRuntime({
      store: store as never,
      registry,
      router,
      onJobCreated: (id) => {
        jobId = id
      },
    })

    await expect(
      rt.submitJob({ patternId: 'cap', input: { prompt: 'go' } }),
    ).rejects.toThrow('prov:pinned')

    const job = await store.get(jobId!)
    expect(job?.status).toBe('error')
    expect(job?.error?.code).toBe('MODEL_EXCLUDED')
    expect((job?.error?.details as { diagnostic?: unknown }).diagnostic).toEqual({
      capability: 'text:generate',
      requiredTags: ['text-generation'],
      excludedByRetry: false,
      excludeModel: [],
      candidates: ['prov:A', 'prov:B'],
    })
  })

  it('honours baseCtx.excludeModel seeding on attempt 0', async () => {
    // resolveCtxProvider pre-populates excludeModel; the loop must seed its
    // mutable copy from it (~851) so the FIRST resolve already sees the
    // pre-excluded model.
    const excludeSeen: string[][] = []
    const modelB = model('prov', 'B', okCall('from-B'))

    const router: CapabilityRouter = {
      checkSatisfiable: () => ({ ok: true, candidates: [modelB as never] }),
      resolve: (_cap, _tags, ctx: ResolveContext) => {
        excludeSeen.push([...(ctx.excludeModel ?? [])])
        return modelB
      },
    }

    const registry = new PatternRegistry()
    registry.register(atomic('cap'))
    const rt = new InlineRuntime({
      store: new MemoryJobStore() as never,
      registry,
      router,
      resolveCtxProvider: () => ({ excludeModel: ['prov:pre-excluded'] }),
    })

    const job = await rt.submitJob({ patternId: 'cap', input: { prompt: 'go' } })

    expect(job.status).toBe('done')
    expect(job.output).toEqual({ modality: 'text', text: 'from-B' })
    // The pre-seeded exclusion was present on the very first resolve.
    expect(excludeSeen[0]).toEqual(['prov:pre-excluded'])
  })
})
