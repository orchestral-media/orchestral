import { describe, expect, it } from 'vitest'

import type { ExecutionContext, PatternRef } from '@orchestral/core'
import { createScriptPlanningMeta } from '../meta/script-planning'
import {
  SCRIPT_INTENT_ROUTING_PROMPT,
  NARRATIVE_SCRIPT_PLANNING_PROMPT,
} from '../meta/script-planning/prompts'

// NOTE: the happy-path routing case (router → step 1, branch → step 2,
// cost/latency math) is already covered by `script-planning-wiring.test.ts`
// plus the runtime e2e. This file migrates only the cases NOT covered there:
// the narrative-fallback path on unparseable router output, and the
// id/kind/tool-shape declarative assertions.

// Fake ExecutionContext: records each ctx.step input and returns canned
// text-generation outputs in call order. compose() only uses step + compute.
function makeCtx(stepTexts: readonly string[], stepCosts?: readonly number[]) {
  const stepInputs: Array<Record<string, unknown>> = []
  let i = 0
  const ctx = {
    compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
    step: async <T>(ref: PatternRef): Promise<T> => {
      stepInputs.push(ref.input as Record<string, unknown>)
      const idx = i++
      return {
        modality: 'text',
        text: stepTexts[idx] ?? '',
        cost: stepCosts?.[idx] ?? 1,
        latencyMs: 10,
        model: 'test:model',
        provider: 'test',
      } as unknown as T
    },
  } as unknown as ExecutionContext
  return { ctx, stepInputs }
}

describe('meta_script-planning', () => {
  it('falls back to narrative on unparseable router output', async () => {
    const meta = createScriptPlanningMeta()
    const { ctx, stepInputs } = makeCtx([
      'not json at all',
      JSON.stringify({ planned_script: 'once upon a time' }),
    ])

    const out = await meta.compose({ input: { idea: 'a quiet drama' } }, ctx)

    expect(out.intent).toBe('narrative')
    expect(out.plannedScript).toBe('once upon a time')
    // Step 1 carries the router prompt; step 2 carries the narrative branch
    // prompt (the fallback), asserted against the real inlined constants.
    expect(stepInputs[0].system).toBe(SCRIPT_INTENT_ROUTING_PROMPT)
    expect(stepInputs[1].system).toBe(NARRATIVE_SCRIPT_PLANNING_PROMPT)
    // Cost sums the router + branch calls (1 each); latency is measured.
    expect(out.cost).toBeCloseTo(2)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('keeps cost finite when the router step reports NaN (sumCosts guard)', async () => {
    const meta = createScriptPlanningMeta()
    const { ctx } = makeCtx(
      [
        'not json at all', // router falls back to narrative
        JSON.stringify({ planned_script: 'once upon a time' }),
      ],
      [Number.NaN, 1],
    )

    const out = await meta.compose({ input: { idea: 'a quiet drama' } }, ctx)

    // The NaN router cost is guarded to 0 — only the branch call (1) counts.
    expect(Number.isFinite(out.cost)).toBe(true)
    expect(out.cost).toBeCloseTo(1)
  })

  it('declares a meta Pattern with a stable id + tool surface', () => {
    const meta = createScriptPlanningMeta()
    expect(meta.id).toBe('meta_script-planning')
    expect(meta.kind).toBe('meta')
    expect(meta.tool.description).toBeTruthy()
  })
})
