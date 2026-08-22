import { describe, expect, it } from 'vitest'
import { createScriptPlanningMeta } from '../patterns/script-planning'
import {
  SCRIPT_INTENT_ROUTING_PROMPT,
  NARRATIVE_SCRIPT_PLANNING_PROMPT,
} from '../patterns/script-planning/prompts'

describe('script-planning wiring', () => {
  it('wires router prompt into step 1 and branch prompt into step 2', async () => {
    const captured: Array<{ system?: string }> = []
    const meta = createScriptPlanningMeta()
    const fakeCtx = {
      stepIndex: 0,
      signal: new AbortController().signal,
      async compute<T>(_id: string, fn: () => Promise<T>): Promise<T> {
        return fn()
      },
      async step<T>(ref: { input: { system?: string } }): Promise<T> {
        captured.push({ system: ref.input.system })
        return (captured.length === 1
          ? { text: JSON.stringify({ intent: 'narrative' }), cost: 0.3, latencyMs: 0 }
          : { text: JSON.stringify({ planned_script: 'X' }), cost: 0.7, latencyMs: 0 }) as unknown as T
      },
    }
    const out = await meta.compose(
      { input: { idea: 'a lighthouse keeper' } },
      fakeCtx as never,
    )
    expect(captured[0]?.system).toBe(SCRIPT_INTENT_ROUTING_PROMPT)
    expect(captured[1]?.system).toBe(NARRATIVE_SCRIPT_PLANNING_PROMPT)
    expect(out.intent).toBe('narrative')
    expect(out.plannedScript).toBe('X')
    // cost = router (0.3) + branch (0.7); latencyMs is measured, non-negative.
    expect(out.cost).toBeCloseTo(1)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
  })
})
