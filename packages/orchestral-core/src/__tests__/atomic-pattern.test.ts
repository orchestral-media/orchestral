import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineAtomicPattern } from '../atomic-pattern'

describe('AtomicPattern class', () => {
  it('threads exposureMode from Init → field', () => {
    const p = defineAtomicPattern({
      id: 'fixture',
      description: 'd',
      primary: { tool: { description: 't', inputs: z.object({}) as never } },
      outputs: z.object({}) as never,
      exposureMode: 'always-load',
    })
    expect(p.exposureMode).toBe('always-load')
  })
  it('defaults exposureMode to undefined', () => {
    const p = defineAtomicPattern({
      id: 'fixture',
      description: 'd',
      primary: { tool: { description: 't', inputs: z.object({}) as never } },
      outputs: z.object({}) as never,
    })
    expect(p.exposureMode).toBeUndefined()
  })
  it('throws without a primary path', () => {
    expect(
      () =>
        defineAtomicPattern({
          id: 'fixture',
          description: 'd',
          outputs: z.object({}) as never,
        } as never),
    ).toThrow(/ATOMIC_PATTERN_NO_PRIMARY/)
  })
})
