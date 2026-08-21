import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { Pattern, PatternExposure } from '../pattern'
import { resolveDispatchTarget } from '../dispatch-pattern'
import { PatternRegistry } from '../registry'

// Canvas-node dispatch resolution. Gate is
// resolveExposure(pattern.exposure).canvas; default first-party exposure
// ('tool' / undefined / any shorthand) has canvas:false, so a Pattern must
// opt in explicitly before a canvas node can dispatch it.

function makePattern(exposure?: PatternExposure): Pattern {
  return {
    id: 'test-canvas-pattern',
    kind: 'atomic',
    description: 'test pattern for canvas audience gating',
    ...(exposure !== undefined ? { exposure } : {}),
    primary: {
      tool: { description: 'test', inputs: z.object({ prompt: z.string() }) },
    },
    outputs: z.object({ modality: z.literal('image') }),
  } as unknown as Pattern
}

describe('canvas dispatch audience', () => {
  it('allows dispatch when exposure.canvas is true', () => {
    const registry = new PatternRegistry()
    registry.register(makePattern({ chatTurn: true, agentLoop: true, canvas: true }))
    const target = resolveDispatchTarget(
      registry,
      { pattern_id: 'test-canvas-pattern', input: { prompt: 'x' } },
      'canvas',
    )
    expect('parsedInput' in target).toBe(true)
  })

  it('rejects with PATTERN_NOT_DISPATCHABLE when canvas surface is closed (default & shorthand)', () => {
    for (const exposure of [undefined, 'tool' as const, { chatTurn: true }]) {
      const registry = new PatternRegistry()
      registry.register(makePattern(exposure))
      const target = resolveDispatchTarget(
        registry,
        { pattern_id: 'test-canvas-pattern', input: { prompt: 'x' } },
        'canvas',
      )
      expect('code' in target && target.code).toBe('PATTERN_NOT_DISPATCHABLE')
    }
  })

  it('still validates input for canvas audience', () => {
    const registry = new PatternRegistry()
    registry.register(makePattern({ canvas: true }))
    const target = resolveDispatchTarget(
      registry,
      { pattern_id: 'test-canvas-pattern', input: {} },
      'canvas',
    )
    expect('code' in target && target.code).toBe('INPUT_VALIDATION_FAILED')
  })
})
