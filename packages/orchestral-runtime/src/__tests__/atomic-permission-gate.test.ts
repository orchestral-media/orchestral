// Atomic checkPermissions is a SYNCHRONOUS permission gate, NOT a HITL seam:
// a deny throws PERMISSION_DENIED before the model call; ok lets the call run.
// Mid-run "ask the user" lives only on MetaPattern.compose via ctx.askUser;
// atomic confirms (e.g. cost) are a host dispatch-policy concern (the host
// knows the routed model + cost, which checkPermissions does not).

import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'

import type {
  CapabilityRouter,
  ModelCapability,
  Modality,
  AtomicPattern,
} from '@orchestral/core'
import { InMemoryJobStore as MemoryJobStore, PatternRegistry } from '@orchestral/core'

import { InlineRuntime } from '../inline'

function makeRouter(onCall: () => void): CapabilityRouter {
  const cap = {
    modelId: 'fake:gpt',
    provider: 'fake',
    tags: [],
    capabilities: ['cap_paid'],
    inputs: ['text'] as Modality[],
    outputs: ['text'] as Modality[],
    source: 'user',
    async call() {
      onCall()
      return { output: { ok: true } } as unknown
    },
  } as unknown as ModelCapability
  return {
    checkSatisfiable: () => ({ ok: true, candidates: [cap] }),
    resolve: () => cap,
  } as unknown as CapabilityRouter
}

function makeAtomic(
  checkPermissions?: () => { ok: true } | { ok: false; reason: string },
): AtomicPattern {
  return {
    id: 'cap_paid',
    kind: 'atomic',
    description: 'gen',
    primary: { tool: { description: 'g', inputs: z.object({ prompt: z.string() }) } },
    outputs: z.object({ ok: z.boolean() }),
    ...(checkPermissions ? { checkPermissions } : {}),
  } as unknown as AtomicPattern
}

function makeRuntime(onCall: () => void, atomic: AtomicPattern): InlineRuntime {
  const registry = new PatternRegistry()
  registry.add(atomic as unknown as Parameters<typeof registry.add>[0])
  return new InlineRuntime({
    router: makeRouter(onCall),
    registry,
    store: new MemoryJobStore() as never,
  })
}

describe('atomic checkPermissions (synchronous gate)', () => {
  it('a deny fails the job with PERMISSION_DENIED before the model call', async () => {
    const onCall = vi.fn()
    const runtime = makeRuntime(onCall, makeAtomic(() => ({ ok: false, reason: 'over quota' })))
    const job = await runtime.submitJob({ patternId: 'cap_paid', input: { prompt: 'x' } } as never)
    expect(job.status).toBe('error')
    expect(job.error?.message).toMatch(/PERMISSION_DENIED: over quota/)
    expect(onCall).not.toHaveBeenCalled()
  })

  it('an ok gate lets the model call run', async () => {
    const onCall = vi.fn()
    const runtime = makeRuntime(onCall, makeAtomic(() => ({ ok: true })))
    const done = await runtime.submitJob({
      patternId: 'cap_paid', input: { prompt: 'x' },
    } as never)
    expect(done.status).toBe('done')
    expect(done.output).toEqual({ ok: true })
    expect(onCall).toHaveBeenCalledTimes(1)
  })

  it('no checkPermissions hook dispatches normally', async () => {
    const onCall = vi.fn()
    const runtime = makeRuntime(onCall, makeAtomic())
    const done = await runtime.submitJob({
      patternId: 'cap_paid', input: { prompt: 'x' },
    } as never)
    expect(done.status).toBe('done')
    expect(onCall).toHaveBeenCalledTimes(1)
  })
})
