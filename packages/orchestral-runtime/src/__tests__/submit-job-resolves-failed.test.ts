// `submitJob` resolves with the failed Job instead of rejecting.
//
// The contract: once a job row exists, whatever happens to it is data — the
// row goes `error` (or `cancelled`), `job:failed` / `job:cancelled` fans out,
// and the promise resolves with that row. The promise rejects only when no row
// was ever created (an unregistered patternId, an input the idempotency key
// cannot be derived from), because there is no Job to describe the failure
// with. These tests pin both halves of that rule, that the terminal event has
// already fired when the caller gets the row, and that the Job handed back is
// the persisted row rather than a reconstruction of it.
//
// Harness mirrors atomic-model-call-failure.test.ts: a real InlineRuntime over
// an in-memory store plus a one-model router whose call always fails, with
// `fallbackDepth: 0` so the provider failure is the terminal one.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type {
  AtomicPattern,
  CapabilityRouter,
  DispatchMiddleware,
  JobEvent,
  Modality,
  ModelCapability,
} from '@orchestral/core'
import { InMemoryJobStore, PatternRegistry } from '@orchestral/core'

import { InlineRuntime } from '../inline'

const TEXT_OUTPUT = z.object({ modality: z.literal('text'), text: z.string() })

function atomic(id: string): AtomicPattern {
  return {
    id,
    kind: 'atomic',
    description: `atomic ${id}`,
    outputs: TEXT_OUTPUT,
    primary: {
      tool: { description: id, inputs: z.object({ prompt: z.string() }) },
      modelTags: [],
    },
  } as unknown as AtomicPattern
}

function failingModel(): ModelCapability {
  return {
    modelId: 'A',
    provider: 'prov',
    tags: [],
    capabilities: [],
    inputs: ['text'] as Modality[],
    outputs: ['text'] as Modality[],
    source: 'user' as const,
    async call() {
      throw Object.assign(new Error('PROVIDER_DOWN: boom'), { code: 'PROVIDER_DOWN' })
    },
  } as unknown as ModelCapability
}

function harness(init: { middleware?: readonly DispatchMiddleware[] } = {}) {
  const model = failingModel()
  const router: CapabilityRouter = {
    checkSatisfiable: () => ({ ok: true, candidates: [model] }),
    resolve: () => model,
  }
  const registry = new PatternRegistry()
  registry.register(atomic('cap'))
  const store = new InMemoryJobStore()
  const events: JobEvent[] = []
  const jobIds: string[] = []
  const rt = new InlineRuntime({
    store,
    registry,
    router,
    // One candidate and no walk: the provider failure is the terminal one.
    resolveCtxProvider: () => ({ fallbackDepth: 0 }),
    ...(init.middleware ? { middleware: init.middleware } : {}),
    onJobCreated: (jobId) => {
      jobIds.push(jobId)
      rt.subscribe(jobId, (ev) => events.push(ev))
    },
  })
  return { rt, store, events, jobIds }
}

const SPEC = { patternId: 'cap', input: { prompt: 'go' } }

describe('submitJob resolves with the failed Job', () => {
  it('a dispatch failure resolves with status error and a populated JobError', async () => {
    const { rt } = harness()

    const job = await rt.submitJob(SPEC)

    expect(job.status).toBe('error')
    expect(job.output).toBeNull()
    expect(job.error).toMatchObject({ code: 'PROVIDER_DOWN', message: 'PROVIDER_DOWN: boom' })
  })

  it('job:failed has already fanned out when the promise resolves', async () => {
    const { rt, events } = harness()

    const job = await rt.submitJob(SPEC)

    // Read synchronously after the await — nothing else has had a turn — so
    // the event can only be here if it fired before the promise resolved.
    const failed = events.find((e) => e.type === 'job:failed')
    expect(failed).toBeDefined()
    expect(failed!.job.id).toBe(job.id)
    expect(failed!.job.status).toBe('error')
    // And it was the terminal event: nothing fans out after it.
    expect(events[events.length - 1]?.type).toBe('job:failed')
  })

  it('the returned Job is the persisted row', async () => {
    const { rt, store, jobIds } = harness()

    const job = await rt.submitJob(SPEC)

    expect(jobIds).toEqual([job.id])
    expect(await store.get(job.id)).toEqual(job)
  })

  it('a middleware reject is data too: the row errors with the decision code', async () => {
    // The other post-row failure site — beforeDispatch refused the job before
    // any model ran. Same rule: the row exists, so the failure is returned.
    const { rt, events } = harness({
      middleware: [
        { beforeDispatch: () => ({ kind: 'reject', code: 'QUOTA', message: 'over budget' }) },
      ],
    })

    const job = await rt.submitJob(SPEC)

    expect(job.status).toBe('error')
    expect(job.error).toEqual({ code: 'QUOTA', message: 'over budget' })
    expect(events[events.length - 1]?.type).toBe('job:failed')
  })

  it('an unregistered patternId still rejects — there is no Job to return', async () => {
    const { rt, store, jobIds } = harness()

    await expect(
      rt.submitJob({ patternId: 'not-registered', input: { prompt: 'go' } }),
    ).rejects.toThrow(/PATTERN_NOT_REGISTERED/)

    // Nothing was minted: no id reached the host hook, no row reached the store.
    expect(jobIds).toEqual([])
    expect(await store.query()).toEqual([])
  })

  it('an input no idempotency key can be derived from still rejects', async () => {
    // The other pre-row failure: the key is derived before the INSERT, so a
    // value the canonical hash refuses never becomes a job either.
    const { rt, store, jobIds } = harness()

    await expect(
      rt.submitJob({ patternId: 'cap', input: { prompt: 'go', count: 1n } }),
    ).rejects.toThrow(/bigint cannot be canonicalised/)

    expect(jobIds).toEqual([])
    expect(await store.query()).toEqual([])
  })
})
