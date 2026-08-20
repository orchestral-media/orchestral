// The runtime's in-memory sidecar tables are bounded by the runtime itself,
// not by host discipline. Both claims here are about what a host that never
// cleans up leaves behind: subscriber sets are released when a job can emit
// nothing further, and the agent envelope table evicts rather than grows.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type {
  AtomicPattern,
  CapabilityRouter,
  JobEvent,
  Modality,
  ModelCapability,
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

function okRouter(): CapabilityRouter {
  const model = {
    modelId: 'm',
    provider: 'fake',
    tags: [] as never[],
    capabilities: [] as never[],
    inputs: ['text'] as Modality[],
    outputs: ['text'] as Modality[],
    source: 'user' as const,
    async call() {
      return { output: { modality: 'text', text: 'ok' } }
    },
  } as unknown as ModelCapability
  return {
    checkSatisfiable: () => ({ ok: true, candidates: [model] }),
    resolve: () => model,
  }
}

/** Reach into the private table the host cannot see, to assert it is bounded. */
function sizeOf(rt: InlineRuntime, field: string): number {
  return (rt as unknown as Record<string, Map<string, unknown>>)[field].size
}

describe('bounded runtime state', () => {
  it('releases a job’s subscribers once it reaches a terminal event', async () => {
    const registry = new PatternRegistry()
    registry.register(atomic('cap'))
    const seen: JobEvent[] = []
    const rt = new InlineRuntime({
      store: new MemoryJobStore() as never,
      registry,
      router: okRouter(),
      // Subscribe and deliberately never call the returned Unsubscribe.
      onJobCreated: (jobId) => {
        rt.subscribe(jobId, (ev) => seen.push(ev))
      },
    })

    for (let i = 0; i < 5; i++) {
      const job = await rt.submitJob({ patternId: 'cap', input: { prompt: `p${i}` } })
      expect(job.status).toBe('done')
    }

    // The subscriber still received its events...
    expect(seen.some((e) => e.type === 'job:completed')).toBe(true)
    // ...and nothing is retained for jobs that can no longer emit.
    expect(sizeOf(rt, 'subscribers')).toBe(0)
  })

  it('keeps an Unsubscribe returned before the terminal event safe to call', async () => {
    const registry = new PatternRegistry()
    registry.register(atomic('cap'))
    let unsubscribe: (() => void) | undefined
    const rt = new InlineRuntime({
      store: new MemoryJobStore() as never,
      registry,
      router: okRouter(),
      onJobCreated: (jobId) => {
        unsubscribe = rt.subscribe(jobId, () => {})
      },
    })

    await rt.submitJob({ patternId: 'cap', input: { prompt: 'p' } })
    // The entry is already gone; calling it must not throw.
    expect(() => unsubscribe?.()).not.toThrow()
    expect(sizeOf(rt, 'subscribers')).toBe(0)
  })

  it('evicts the oldest agent envelope instead of growing without bound', () => {
    const rt = new InlineRuntime({
      store: new MemoryJobStore() as never,
      registry: new PatternRegistry(),
      router: okRouter(),
    })
    // Drive the recorder the agent dispatch uses, without running 200 agents.
    const record = (
      rt as unknown as { agentDispatchDeps(): { recordEnvelope: (id: string, e: unknown) => void } }
    ).agentDispatchDeps().recordEnvelope

    for (let i = 0; i < 200; i++) {
      record(`job-${i}`, { totalToolUseCount: i } as never)
    }

    const size = sizeOf(rt, 'agentEnvelopes')
    expect(size).toBeLessThanOrEqual(64)
    // The most recent dispatch is the one a host actually reads back.
    expect(rt.getAgentEnvelope('job-199')).toBeDefined()
    expect(rt.getAgentEnvelope('job-0')).toBeUndefined()
  })

  it('refreshes an envelope re-recorded for the same job rather than ageing it', () => {
    const rt = new InlineRuntime({
      store: new MemoryJobStore() as never,
      registry: new PatternRegistry(),
      router: okRouter(),
    })
    const record = (
      rt as unknown as { agentDispatchDeps(): { recordEnvelope: (id: string, e: unknown) => void } }
    ).agentDispatchDeps().recordEnvelope

    record('kept', { totalToolUseCount: 1 } as never)
    for (let i = 0; i < 60; i++) record(`filler-${i}`, {} as never)
    // A settling agent records its envelope more than once (start, then final).
    record('kept', { totalToolUseCount: 9 } as never)
    for (let i = 60; i < 120; i++) record(`filler-${i}`, {} as never)

    expect(rt.getAgentEnvelope('kept')).toEqual({ totalToolUseCount: 9 })
  })
})
