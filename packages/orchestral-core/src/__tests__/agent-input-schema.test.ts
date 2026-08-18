import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AGENT_BASE_INPUT_SCHEMA, agentInputSchema } from '../agent-input-schema'

describe('agentInputSchema', () => {
  it('base schema accepts description + prompt + optional references', () => {
    const ok = AGENT_BASE_INPUT_SCHEMA.safeParse({
      description: 'make trailer',
      prompt: 'Cut a 30s trailer.',
      references: { source: 'video_1', extras: ['image_1', 'image_2'] },
    })
    expect(ok.success).toBe(true)
  })

  it('references is optional', () => {
    const ok = AGENT_BASE_INPUT_SCHEMA.safeParse({ description: 'x', prompt: 'y' })
    expect(ok.success).toBe(true)
  })

  it('rejects redeclaring reserved fields (description / prompt / references)', () => {
    for (const key of ['description', 'prompt', 'references'] as const) {
      expect(() => agentInputSchema({ [key]: z.string() } as never)).toThrow(
        /AGENT_INPUT_RESERVED_FIELD/,
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
