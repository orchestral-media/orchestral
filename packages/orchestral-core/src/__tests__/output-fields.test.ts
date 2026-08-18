import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { assetIdField, auditOutputsSchema, boundedText, opaqueToken, urlField } from '../output-fields'
import { defaultAgentFinishOutputs } from '../agent-finish'

describe('output-fields vocabulary', () => {
  it('boundedText enforces max', () => {
    expect(boundedText(10).safeParse('x'.repeat(11)).success).toBe(false)
    expect(boundedText(10).safeParse('short').success).toBe(true)
  })

  it('opaqueToken defaults to 16384 and accepts a saturated cursor', () => {
    expect(opaqueToken().safeParse('c'.repeat(6000)).success).toBe(true)
    expect(opaqueToken().safeParse('c'.repeat(20000)).success).toBe(false)
  })

  it('assetIdField / urlField are bounded', () => {
    expect(assetIdField().safeParse('a'.repeat(200)).success).toBe(false)
    expect(urlField().safeParse('https://e.com/' + 'p'.repeat(3000)).success).toBe(false)
  })

  it('auditOutputsSchema lists unbounded string paths', () => {
    const schema = z.object({
      ok: boundedText(100),
      bad: z.string(),
      nested: z.object({ alsoBad: z.string() }),
      arr: z.array(z.string()),
    })
    expect(auditOutputsSchema(schema)).toEqual({
      unbounded: ['bad', 'nested.alsoBad', 'arr[]'],
      notTraversed: [],
    })
  })

  it('does not flag enums / literals (finite value sets)', () => {
    const schema = z.object({
      kind: z.enum(['image', 'video']),
      tag: z.literal('produced'),
      bad: z.string(),
    })
    expect(auditOutputsSchema(schema)).toEqual({
      unbounded: ['bad'],
      notTraversed: [],
    })
  })

  it('auditOutputsSchema passes a fully bounded schema', () => {
    const schema = z.object({ a: boundedText(10), b: z.array(opaqueToken()) })
    expect(auditOutputsSchema(schema)).toEqual({ unbounded: [], notTraversed: [] })
  })

  it('walks record values and tuple positions', () => {
    const schema = z.object({
      byKey: z.record(z.string(), z.string()),
      pair: z.tuple([boundedText(10), z.string()]),
    })
    expect(auditOutputsSchema(schema)).toEqual({
      unbounded: ['byKey{*}', 'pair[1]'],
      notTraversed: [],
    })
  })

  it('reports an unconstrained additionalProperties instead of passing it', () => {
    const audit = auditOutputsSchema(z.looseObject({ a: boundedText(10) }))
    expect(audit.unbounded).toEqual([])
    expect(audit.notTraversed).toEqual(['{*}'])
  })

  it('defaultAgentFinishOutputs is fully bounded (no unbounded string fields)', () => {
    expect(auditOutputsSchema(defaultAgentFinishOutputs).unbounded).toEqual([])
  })
})
