import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AGENT_BASE_INPUT_SCHEMA, agentInputSchema } from '../agent-input-schema'

describe('agentInputSchema', () => {
  it('base schema is description + prompt, with no references', () => {
    // `references` is derived at registration from the agent's own assetNeeds;
    // the base declaring one would be a hand-written reserved key on every agent.
    expect(Object.keys(AGENT_BASE_INPUT_SCHEMA.shape)).toEqual(['description', 'prompt'])
  })

  it('base schema accepts description + prompt', () => {
    const ok = AGENT_BASE_INPUT_SCHEMA.safeParse({ description: 'x', prompt: 'y' })
    expect(ok.success).toBe(true)
  })

  it('rejects redeclaring the base fields (description / prompt)', () => {
    for (const key of ['description', 'prompt'] as const) {
      expect(() => agentInputSchema({ [key]: z.string() } as never)).toThrow(
        `AGENT_INPUT_RESERVED_FIELD: '${key}' is provided by AGENT_BASE_INPUT_SCHEMA — Pattern authors must not redeclare it.`,
      )
    }
  })

  it('rejects declaring the reserved input keys (references / name)', () => {
    for (const key of ['references', 'name'] as const) {
      expect(() => agentInputSchema({ [key]: z.string() } as never)).toThrow(
        `AGENT_INPUT_RESERVED_FIELD: '${key}' is reserved: registration derives it (RESERVED_INPUT_KEYS) — do not declare it.`,
      )
    }
  })

  it('merges author extras alongside the base fields', () => {
    const schema = agentInputSchema({ targetDurationSec: z.number() })
    expect(
      schema.safeParse({ description: 'a', prompt: 'b', targetDurationSec: 30 }).success,
    ).toBe(true)
  })
})
