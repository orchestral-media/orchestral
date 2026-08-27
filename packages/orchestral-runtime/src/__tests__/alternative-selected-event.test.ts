// The Alternative fallback is the runtime's signature degradation feature —
// opt-in via `alternatives: 'auto'`, which every runtime below passes. This
// pins that taking it is OBSERVABLE: a `job:alternative-selected` event
// fires before the redirect dispatches, carrying the declared degradation
// metadata (preserves / losses), so a subscriber can tell a
// degraded completion from a primary-path one.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type {
  AtomicPattern,
  CapabilityRouter,
  JobEvent,
  Modality,
  ModelCapability,
} from '@orchestral/core'
import { silentDiagnosticsLogger, PatternRegistry } from '@orchestral/core'
import { InMemoryJobStore as MemoryJobStore } from '@orchestral/core/memory'

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

describe('job:alternative-selected event', () => {
  it('fires once with the declared degradation metadata before the redirect completes', async () => {
    const model = {
      modelId: 'm',
      provider: 'fake',
      tags: [] as never[],
      capabilities: [] as never[],
      inputs: ['text'] as Modality[],
      outputs: ['text'] as Modality[],
      source: 'user' as const,
      async call() {
        return { output: { modality: 'text', text: 'via-fallback' } }
      },
    } as unknown as ModelCapability
    const router: CapabilityRouter = {
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

    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    registry.register({
      ...atomic('parent_cap'),
      alternatives: [
        {
          id: 'caption-cascade',
          description: 'degrade to the fallback capability',
          appliesWhen: { kind: 'capability-unavailable' },
          preserves: ['layout'],
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

    const events: JobEvent[] = []
    const rt = new InlineRuntime({
      store: new MemoryJobStore() as never,
      registry,
      router,
      alternatives: 'auto',
      onJobCreated: (jobId) => {
        rt.subscribe(jobId, (ev) => events.push(ev))
      },
    })

    const job = await rt.submitJob({
      patternId: 'parent_cap',
      input: { prompt: 'hi' },
    })
    expect(job.status).toBe('done')

    const selected = events.filter((e) => e.type === 'job:alternative-selected')
    expect(selected).toHaveLength(1)
    const ev = selected[0]!
    if (ev.type !== 'job:alternative-selected') throw new Error('unreachable')
    expect(ev.alternativeId).toBe('caption-cascade')
    expect(ev.description).toBe('degrade to the fallback capability')
    expect(ev.targetPatternId).toBe('fallback_cap')
    expect(ev.preserves).toEqual(['layout'])
    expect(ev.losses).toEqual(['subject-identity'])
    expect(ev.job.id).toBe(job.id)

    // Ordering: the degradation notice precedes completion.
    const types = events.map((e) => e.type)
    expect(types.indexOf('job:alternative-selected')).toBeLessThan(
      types.indexOf('job:completed'),
    )
  })

  it('forwards ambient host context (providerOptions) into the alternative dispatch', async () => {
    let seenCtxProviderOptions: unknown = 'unset'
    const model = {
      modelId: 'm',
      provider: 'fake',
      tags: [] as never[],
      capabilities: [] as never[],
      inputs: ['text'] as Modality[],
      outputs: ['text'] as Modality[],
      source: 'user' as const,
      async call(_input: unknown, ctx: { providerOptions?: unknown }) {
        seenCtxProviderOptions = ctx.providerOptions
        return { output: { modality: 'text', text: 'via-fallback' } }
      },
    } as unknown as ModelCapability
    const router: CapabilityRouter = {
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
    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    registry.register({
      ...atomic('parent_cap'),
      alternatives: [
        {
          id: 'fallback',
          description: 'fallback',
          appliesWhen: { kind: 'capability-unavailable' },
          via: {
            patternId: 'fallback_cap',
            mapInput: (input: unknown) => input,
            mapOutput: (output: unknown) => output,
          },
        },
      ],
    } as never)
    registry.register(atomic('fallback_cap'))

    const rt = new InlineRuntime({
      store: new MemoryJobStore() as never,
      registry,
      router,
      alternatives: 'auto',
    })
    const job = await rt.submitJob({
      patternId: 'parent_cap',
      input: { prompt: 'hi' },
      providerOptions: { quality: 'hd' },
    })
    expect(job.status).toBe('done')
    // The degraded path must run with the same UI-default providerOptions the
    // primary would have received.
    expect(seenCtxProviderOptions).toEqual({ quality: 'hd' })
  })

  it('does not fire on a clean primary-path dispatch', async () => {
    const model = {
      modelId: 'm',
      provider: 'fake',
      tags: [] as never[],
      capabilities: [] as never[],
      inputs: ['text'] as Modality[],
      outputs: ['text'] as Modality[],
      source: 'user' as const,
      async call() {
        return { output: { modality: 'text', text: 'primary' } }
      },
    } as unknown as ModelCapability
    const router: CapabilityRouter = {
      checkSatisfiable: () => ({ ok: true, candidates: [model] }),
      resolve: () => model,
    }
    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    registry.register(atomic('some_cap'))

    const events: JobEvent[] = []
    const rt = new InlineRuntime({
      // Enabled, so "no event" is about the primary path succeeding rather
      // than about redirects being switched off.
      alternatives: 'auto',
      store: new MemoryJobStore() as never,
      registry,
      router,
      onJobCreated: (jobId) => {
        rt.subscribe(jobId, (ev) => events.push(ev))
      },
    })

    const job = await rt.submitJob({ patternId: 'some_cap', input: { prompt: 'hi' } })
    expect(job.status).toBe('done')
    expect(events.some((e) => e.type === 'job:alternative-selected')).toBe(false)
  })
})
