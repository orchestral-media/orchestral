// meta-dispatch e2e.
//
// Builds a real InlineRuntime over an in-memory JobStore + a fake
// CapabilityRouter whose text-generation ModelCapability scripts
// schema-shaped JSON returns, then dispatches `meta_script-planning`
// end-to-end. Validates:
//   • dispatchMeta → compose() pipeline actually invokes the meta's body
//   • ctx.step({patternId: 'text-generation', input: {system, prompt,
//     responseFormat: 'json', jsonSchema}}) reaches the atomic dispatcher
//   • The meta carries its own inlined prompts (the system slot equals the
//     prompt constant re-exported from @orchestral/patterns) — nothing is
//     loaded from disk at dispatch time
//   • Meta returns the documented output shape ({intent, plannedScript})
//   • Errors in a step propagate up with the stepId in the chain
//
// Mocks the model layer; no real ai-sdk / no real provider.

import { beforeEach, describe, expect, it } from 'vitest'

import type {
  CapabilityRouter,
  ModelCapability,
  Modality,
} from '@orchestral/core'
import { InMemoryJobStore as MemoryJobStore, PatternRegistry } from '@orchestral/core'
import {
  createTextGenerationPattern,
  createScriptPlanningMeta,
} from '@orchestral/patterns'
import {
  SCRIPT_INTENT_ROUTING_PROMPT,
  NARRATIVE_SCRIPT_PLANNING_PROMPT,
  MOTION_SCRIPT_PLANNING_PROMPT,
  MONTAGE_SCRIPT_PLANNING_PROMPT,
} from '@orchestral/patterns/testing'

import { InlineRuntime } from '../inline'

// ── Scripted ModelCapability for text-generation ──────────────────────────
//
// meta_script-planning issues two text-generation calls:
//   1. router  → expects `{intent: 'narrative'|'motion'|'montage'}`
//   2. branch  → expects `{planned_script: string}`
//
// The fake call() matches `req.input.system` against the real inlined prompt
// constants (the meta now ships its own prompts) to decide which JSON to
// return.
interface CapturedCall {
  patternId: string
  system: string | undefined
  prompt: string
  responseFormat: string | undefined
}

function makeTextGenRouter(
  captured: CapturedCall[],
  options: { failOnBranch?: boolean } = {},
): CapabilityRouter {
  const cap: ModelCapability = {
    modelId: 'fake:gpt',
    provider: 'fake',
    tags: [],
    capabilities: ['text-generation'],
    inputs: ['text'] as Modality[],
    outputs: ['text'] as Modality[],
    source: 'user',
    async call(input: unknown, ctx: unknown) {
      void ctx
      const inp = input as {
        system?: string
        prompt?: string
        responseFormat?: string
      }
      captured.push({
        patternId: 'text-generation',
        system: inp.system,
        prompt: inp.prompt ?? '',
        responseFormat: inp.responseFormat,
      })

      // Route by which inlined prompt is in the system slot.
      let json: object
      if (inp.system === SCRIPT_INTENT_ROUTING_PROMPT) {
        json = { intent: 'narrative', rationale: 'mocked routing' }
      } else if (
        inp.system === NARRATIVE_SCRIPT_PLANNING_PROMPT ||
        inp.system === MOTION_SCRIPT_PLANNING_PROMPT ||
        inp.system === MONTAGE_SCRIPT_PLANNING_PROMPT
      ) {
        if (options.failOnBranch) {
          throw new Error('FAKE_PROVIDER_OOPS: planning branch failed')
        }
        json = { planned_script: 'mocked planned script body' }
      } else {
        throw new Error(
          `unexpected text-generation call — system=${inp.system?.slice(0, 60)}`,
        )
      }

      return {
        output: {
          modality: 'text',
          text: JSON.stringify(json),
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

// ── Test setup ─────────────────────────────────────────────────────────────
let runtime: InlineRuntime
let captured: CapturedCall[]
let registry: PatternRegistry

beforeEach(() => {
  captured = []
  registry = new PatternRegistry()
  registry.add(
    createTextGenerationPattern() as unknown as Parameters<
      typeof registry.add
    >[0],
  )
  registry.add(
    createScriptPlanningMeta() as unknown as Parameters<
      typeof registry.add
    >[0],
  )

  runtime = new InlineRuntime({
    router: makeTextGenRouter(captured),
    registry,
    store: new MemoryJobStore() as never,
  })
})

describe('meta_script-planning — e2e dispatch (F1.c G1 acceptance)', () => {
  it('completes the 2-stage compose() and returns {intent, plannedScript}', async () => {
    const job = await runtime.submitJob({
      patternId: 'meta_script-planning',
      input: { idea: 'a hero saves the city' },
    } as never)

    // submitJob awaits to completion; job.status is the terminal state.
    expect(job.status).toBe('done')
    expect(job.error).toBeNull()
    const result = job.output as unknown as {
      intent: string
      plannedScript: string
    }

    expect(result.intent).toBe('narrative')
    expect(result.plannedScript).toBe('mocked planned script body')

    // Two text-generation calls — first for router, second for branch.
    expect(captured).toHaveLength(2)
    expect(captured[0].system).toBe(SCRIPT_INTENT_ROUTING_PROMPT)
    expect(captured[1].system).toBe(NARRATIVE_SCRIPT_PLANNING_PROMPT)

    // Both calls explicitly opt into structured JSON output.
    expect(captured[0].responseFormat).toBe('json')
    expect(captured[1].responseFormat).toBe('json')
  })

  it('propagates errors from a sub-step out of the meta dispatcher', async () => {
    runtime = new InlineRuntime({
      router: makeTextGenRouter(captured, { failOnBranch: true }),
      registry,
      store: new MemoryJobStore() as never,
    })

    // Branch step throws → meta dispatch rejects → submitJob's Promise
    // rejects with the original error message preserved (no swallowing).
    await expect(
      runtime.submitJob({
        patternId: 'meta_script-planning',
        input: { idea: 'a hero saves the city' },
      } as never),
    ).rejects.toThrow(/FAKE_PROVIDER_OOPS/)

    // Router stage succeeded (first capture). Branch stage was attempted at
    // least once — the fallback walk hops up to `fallbackDepth` times and our
    // fake router hands back the same model on every hop (it doesn't honour
    // excludeModel), so multiple branch captures are expected. The contract
    // under test is "router stage runs, then branch stage runs and propagates
    // its error", not the exact hop count.
    expect(captured.length).toBeGreaterThanOrEqual(2)
    expect(captured[0].system).toBe(SCRIPT_INTENT_ROUTING_PROMPT)
    const branchCaptures = captured.filter(
      (c) => c.system === NARRATIVE_SCRIPT_PLANNING_PROMPT,
    )
    expect(branchCaptures.length).toBeGreaterThanOrEqual(1)
  })
})
