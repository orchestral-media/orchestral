// Pins the alternatives-degradation claim for the enablement gate:
// when checkSatisfiable reports {ok:false, reason:'not-enabled'} for the
// parent capability, the 'capability-unavailable' alternative is taken —
// i.e. 'not-enabled' counts as unavailable, same as any other reason, and
// dispatch redirects through the registered fallback instead of throwing.
//
// Redirects themselves are opt-in (`alternatives: 'auto'`); the claim here is
// about which *reasons* count as unavailable, so the switch is on throughout.
// The default-off behaviour lives in alternatives-default-off.test.ts.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type {
  AtomicPattern,
  CapabilityRouter,
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

describe("alternatives — 'not-enabled' counts as capability-unavailable", () => {
  it("checkSatisfiable {ok:false, reason:'not-enabled'} → the alternative path is taken", async () => {
    const resolved: string[] = []
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
    // Parent capability declared-but-not-enabled; the fallback resolves fine.
    const router: CapabilityRouter = {
      checkSatisfiable: (cap) =>
        cap === 'parent_cap'
          ? { ok: false, reason: 'not-enabled', candidates: [] }
          : { ok: true, candidates: [model] },
      resolve: (cap) => {
        resolved.push(cap)
        return model
      },
    }

    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    registry.add({
      ...atomic('parent_cap'),
      alternatives: [
        {
          id: 'fallback',
          description: 'degrade to the fallback capability',
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
      input: { prompt: 'go' },
    })

    expect(job.status).toBe('done')
    expect(job.output).toEqual({ modality: 'text', text: 'via-fallback' })
    // The redirect resolved the fallback capability only — the parent never
    // reached Phase-2 resolve.
    expect(resolved).toEqual(['fallback_cap'])
  })
})
