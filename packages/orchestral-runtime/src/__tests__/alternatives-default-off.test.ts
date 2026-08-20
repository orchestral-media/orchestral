// Automatic Alternative redirects are opt-in, and this file pins the default:
// OFF. A capability the router cannot serve fails the job even when a declared
// fallback would have matched — the runtime does not decide on the caller's
// behalf that a semantically different path is an acceptable answer.
//
// What replaces the redirect is the other half of the claim: the failure is
// structured (stable `code`, the applicable paths enumerated on
// `JobError.details.diagnostic`, one sentence saying how to switch redirects
// on) so a host or an LLM reading the failed job can pick a path deliberately
// instead of re-deriving one from the registry.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type {
  AtomicPattern,
  CapabilityRouter,
  JobEvent,
  Modality,
  ModelCapability,
  PatternRegistry as PatternRegistryType,
} from '@orchestral/core'
import { InMemoryJobStore as MemoryJobStore, PatternRegistry } from '@orchestral/core'

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
    },
  } as unknown as AtomicPattern
}

function fallbackModel(calls: string[]): ModelCapability {
  return {
    modelId: 'm',
    provider: 'fake',
    tags: [] as never[],
    capabilities: [] as never[],
    inputs: ['text'] as Modality[],
    outputs: ['text'] as Modality[],
    source: 'user' as const,
    async call() {
      calls.push('fallback_cap')
      return { output: { modality: 'text', text: 'via-fallback' } }
    },
  } as unknown as ModelCapability
}

/** Serves everything except `parent_cap`, which no model in the catalog can do. */
function makeRouter(model: ModelCapability): CapabilityRouter {
  return {
    checkSatisfiable: (cap) =>
      cap === 'parent_cap'
        ? { ok: false, reason: 'no-model-in-catalog', candidates: [] }
        : { ok: true, candidates: [model] },
    resolve: (cap) => {
      if (cap === 'parent_cap') {
        throw Object.assign(new Error('NO_MODEL_FOR_CAPABILITY: parent_cap'), {
          code: 'NO_MODEL_FOR_CAPABILITY',
        })
      }
      return model
    },
  }
}

/** parent_cap with one matching alternative → fallback_cap. */
function makeRegistry(): PatternRegistryType {
  const registry = new PatternRegistry()
  registry.add({
    ...atomic('parent_cap'),
    alternatives: [
      {
        id: 'via-fallback',
        description: 'degrade to the fallback capability',
        appliesWhen: { kind: 'capability-unavailable' },
        preserves: ['style'],
        losses: ['subject-identity'],
        via: {
          patternId: 'fallback_cap',
          mapInput: (input: unknown) => input,
          mapOutput: (output: unknown) => output,
        },
      },
    ],
  } as never)
  registry.register(atomic('fallback_cap'))
  return registry
}

type Harness = {
  rt: InlineRuntime
  events: JobEvent[]
  calls: string[]
  jobIds: string[]
}

function harness(
  init: { alternatives?: 'auto' | 'off'; registry?: PatternRegistryType } = {},
): Harness {
  const calls: string[] = []
  const events: JobEvent[] = []
  const jobIds: string[] = []
  const rt = new InlineRuntime({
    store: new MemoryJobStore() as never,
    registry: init.registry ?? makeRegistry(),
    router: makeRouter(fallbackModel(calls)),
    ...(init.alternatives ? { alternatives: init.alternatives } : {}),
    onJobCreated: (jobId) => {
      jobIds.push(jobId)
      rt.subscribe(jobId, (ev) => events.push(ev))
    },
  })
  return { rt, events, calls, jobIds }
}

describe('alternatives default to off', () => {
  // Omitting the option and passing 'off' are the same runtime; both are
  // pinned so the default can never quietly drift away from the explicit value.
  it.each([
    { label: 'option omitted', alternatives: undefined },
    { label: "alternatives: 'off'", alternatives: 'off' as const },
  ])(
    'fails with ALTERNATIVES_NOT_ENABLED instead of redirecting ($label)',
    async ({ alternatives }) => {
      const { rt, events, calls, jobIds } = harness({ alternatives })

      const thrown = await rt
        .submitJob({ patternId: 'parent_cap', input: { prompt: 'go' } })
        .then(() => null)
        .catch((e: unknown) => e)

      expect((thrown as { code?: string }).code).toBe('ALTERNATIVES_NOT_ENABLED')
      // The declared path did not run behind the caller's back.
      expect(calls).toEqual([])
      expect(events.some((e) => e.type === 'job:alternative-selected')).toBe(false)

      // The row is terminal-error and the JobError is what a subscriber reads.
      const failedEvent = events.find((e) => e.type === 'job:failed')
      expect(failedEvent).toBeDefined()
      const job = await rt.pollJob(jobIds[0]!)
      expect(job.status).toBe('error')
      expect(failedEvent!.job.error).toEqual(job.error)

      const error = job.error!
      expect(error.code).toBe('ALTERNATIVES_NOT_ENABLED')
      const diagnostic = (error.details as { diagnostic: Record<string, unknown> })
        .diagnostic
      expect(diagnostic.capability).toBe('parent_cap')
      expect(diagnostic.reason).toBe('no-model-in-catalog')
      // Every applicable path, named well enough to dispatch by hand.
      expect(diagnostic.alternatives).toEqual([
        {
          id: 'via-fallback',
          description: 'degrade to the fallback capability',
          targetPatternId: 'fallback_cap',
        },
      ])
      // …and how to stop having to.
      expect(String(diagnostic.hint)).toContain("alternatives: 'auto'")
    },
  )

  it('enumerates every applicable alternative, not just the first, and skips non-matching ones', async () => {
    const registry = new PatternRegistry()
    registry.add({
      ...atomic('parent_cap'),
      alternatives: [
        {
          id: 'first',
          description: 'first applicable path',
          appliesWhen: { kind: 'capability-unavailable' },
          via: {
            patternId: 'fallback_cap',
            mapInput: (input: unknown) => input,
            mapOutput: (output: unknown) => output,
          },
        },
        {
          // Nothing asked for these semantics on this dispatch, so this row is
          // declared but not applicable — it must not be advertised as a path.
          id: 'not-applicable',
          description: 'only when identity must be preserved',
          appliesWhen: {
            kind: 'preserves-required',
            semantics: ['subject-identity'],
          },
          via: {
            patternId: 'fallback_cap',
            mapInput: (input: unknown) => input,
            mapOutput: (output: unknown) => output,
          },
        },
        {
          id: 'last-resort',
          description: 'always applicable',
          appliesWhen: { kind: 'always' },
          via: {
            patternId: 'fallback_cap',
            mapInput: (input: unknown) => input,
            mapOutput: (output: unknown) => output,
          },
        },
      ],
    } as never)
    registry.register(atomic('fallback_cap'))

    const { rt, jobIds } = harness({ registry })
    await expect(
      rt.submitJob({ patternId: 'parent_cap', input: { prompt: 'go' } }),
    ).rejects.toThrow(/ALTERNATIVES_NOT_ENABLED/)

    const job = await rt.pollJob(jobIds[0]!)
    const diagnostic = (job.error!.details as {
      diagnostic: { alternatives: readonly { id: string }[] }
    }).diagnostic
    // Declaration order is the ranking, and it survives into the report.
    expect(diagnostic.alternatives.map((a) => a.id)).toEqual([
      'first',
      'last-resort',
    ])
  })

  it('leaves the no-alternative failure exactly as it was', async () => {
    // Nothing declared → nothing to report; the router error is still the
    // whole story, and the new code never appears.
    const registry = new PatternRegistry()
    registry.register(atomic('parent_cap'))
    registry.register(atomic('fallback_cap'))

    const { rt, events, calls, jobIds } = harness({ registry })
    await expect(
      rt.submitJob({ patternId: 'parent_cap', input: { prompt: 'go' } }),
    ).rejects.toThrow(/NO_MODEL_FOR_CAPABILITY/)

    const job = await rt.pollJob(jobIds[0]!)
    expect(job.status).toBe('error')
    expect(job.error!.code).toBe('NO_MODEL_FOR_CAPABILITY')
    expect(calls).toEqual([])
    expect(events.some((e) => e.type === 'job:failed')).toBe(true)
  })

  it("takes the declared path once the host passes alternatives: 'auto'", async () => {
    // Same catalog, same registry, one option flipped — the only thing
    // standing between the failure above and the degraded completion.
    const { rt, events, calls } = harness({ alternatives: 'auto' })

    const job = await rt.submitJob({
      patternId: 'parent_cap',
      input: { prompt: 'go' },
    })

    expect(job.status).toBe('done')
    expect(job.output).toEqual({ modality: 'text', text: 'via-fallback' })
    expect(calls).toEqual(['fallback_cap'])
    expect(events.some((e) => e.type === 'job:alternative-selected')).toBe(true)
  })

  it('rethrows a failed model call verbatim rather than restating it as a routing error', async () => {
    // The other fall-through into alternatives: a model WAS resolved and its
    // call failed. Off means no redirect there either, but the provider error
    // is the actionable one, so it must reach the host unmasked.
    const registry = makeRegistry()
    const boom = Object.assign(new Error('provider 401'), {
      code: 'PROVIDER_AUTH_FAILED',
    })
    const model = {
      modelId: 'm',
      provider: 'fake',
      tags: [] as never[],
      capabilities: [] as never[],
      inputs: ['text'] as Modality[],
      outputs: ['text'] as Modality[],
      source: 'user' as const,
      async call() {
        throw boom
      },
    } as unknown as ModelCapability
    const jobIds: string[] = []
    const events: JobEvent[] = []
    const rt = new InlineRuntime({
      store: new MemoryJobStore() as never,
      registry,
      // parent_cap is satisfiable now; the failure happens in the call.
      router: {
        checkSatisfiable: () => ({ ok: true, candidates: [model] }),
        resolve: () => model,
      },
      onJobCreated: (jobId) => {
        jobIds.push(jobId)
        rt.subscribe(jobId, (ev) => events.push(ev))
      },
    })

    await expect(
      rt.submitJob({ patternId: 'parent_cap', input: { prompt: 'go' } }),
    ).rejects.toThrow('provider 401')

    const job = await rt.pollJob(jobIds[0]!)
    expect(job.error!.code).toBe('PROVIDER_AUTH_FAILED')
    expect(events.some((e) => e.type === 'job:alternative-selected')).toBe(false)
  })
})
