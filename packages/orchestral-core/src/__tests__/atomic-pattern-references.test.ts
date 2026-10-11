// Ctor-time injection: the derived references field lands in the BASE input
// schema, so dispatch validation (resolveDispatchTarget parses the base) and
// find_pattern rendering share one source. `references` is a reserved key: a
// hand-written one is refused (INPUT_RESERVED_KEY), and only a derived one is
// replaced — the same rule registration applies (reserved-input-keys.test.ts).
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { defineAtomicPattern } from '../atomic-pattern'
import type { AssetNeed } from '../asset-index.types'
import { deriveReferencesSchema } from '../derive-references-schema'
import type { ZodSchema } from '../foundational'

const NEEDS: AssetNeed[] = [
  { slot: 'source', modality: 'image', cardinality: 'array', required: true },
  { slot: 'mask', modality: 'image', cardinality: 'single', required: false },
]

function makePattern(inputs: z.ZodObject<z.ZodRawShape>, assetNeeds?: AssetNeed[]) {
  return defineAtomicPattern({
    id: 'test-pattern',
    description: 'test',
    primary: { tool: { description: 'test tool', inputs: inputs as unknown as ZodSchema }, modelTags: [] },
    outputs: z.object({}) as unknown as ZodSchema,
    ...(assetNeeds ? { assetNeeds } : {}),
  })
}

describe('AtomicPattern references injection', () => {
  it('injects a strict references object derived from assetNeeds', () => {
    const p = makePattern(z.object({ prompt: z.string() }), NEEDS)
    const schema = p.primary.tool.inputs as unknown as z.ZodObject<z.ZodRawShape>
    expect(schema.safeParse({ prompt: 'x', references: { mask: 'image_2' } }).success).toBe(true)
    expect(schema.safeParse({ prompt: 'x', references: { maskk: 'image_2' } }).success).toBe(false)
    expect(schema.safeParse({ prompt: 'x', references: { mask: ['image_2'] } }).success).toBe(false)
  })

  it('refuses a hand-written references field', () => {
    const handwritten = z.object({
      prompt: z.string(),
      references: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
    })
    // The loose record would have accepted any slot key; it is refused rather
    // than silently replaced, so the author learns the key is not theirs.
    expect(() => makePattern(handwritten, NEEDS)).toThrow(
      expect.objectContaining({
        code: 'INPUT_RESERVED_KEY',
        details: { patternId: 'test-pattern', key: 'references', reason: 'hand-written' },
      }),
    )
  })

  it('replaces a derived references on a refined base, keeping its checks', () => {
    // zod's .extend() throws on refined-object key overwrite — the helper
    // must take the safeExtend path to replace a derived field there.
    const refined = z
      .object({
        prompt: z.string(),
        // Derived from a stale list: only `mask`, while the Pattern declares both.
        references: deriveReferencesSchema([NEEDS[1]!])!,
      })
      .refine((v) => v.prompt.length > 0, 'prompt must be non-empty')
    const p = makePattern(refined, NEEDS)
    const schema = p.primary.tool.inputs as unknown as z.ZodObject<z.ZodRawShape>
    // the derivation from the Pattern's own list replaced the stale one, in place
    expect(Object.keys(schema.shape)).toEqual(['prompt', 'references'])
    expect(schema.safeParse({ prompt: 'x', references: { source: ['image_1'] } }).success).toBe(true)
    expect(schema.safeParse({ prompt: 'x', references: { bogus: 'h' } }).success).toBe(false)
    // the object-level refinement survives the replacement
    expect(schema.safeParse({ prompt: '', references: { mask: 'image_2' } }).success).toBe(false)
  })

  it('re-attaches object-level describe/meta after injection (renders into JSON Schema)', () => {
    const described = z
      .object({ prompt: z.string() })
      .describe('All fields must be English.')
    const p = makePattern(described, NEEDS)
    const schema = p.primary.tool.inputs as unknown as z.ZodObject<z.ZodRawShape>
    // safeExtend drops registry-backed object-level metadata; the helper
    // must re-attach it so find_pattern's rendered schema keeps the copy.
    expect(schema.description).toBe('All fields must be English.')
    const json = z.toJSONSchema(schema) as { description?: string }
    expect(json.description).toBe('All fields must be English.')
  })

  it('no assetNeeds → inputs untouched (referential identity preserved)', () => {
    const inputs = z.object({ prompt: z.string() })
    const p = makePattern(inputs)
    expect(p.primary.tool.inputs).toBe(inputs)
  })

  it('assetNeeds declared + non-ZodObject inputs → constructor throws (fail-fast, #146 convention)', () => {
    const nonObjectInputs = z.union([
      z.object({ a: z.string() }),
      z.object({ b: z.string() }),
    ]) as unknown as ZodSchema

    expect(
      () =>
        defineAtomicPattern({
          id: 'fallback-throw-test',
          description: 'test',
          primary: { tool: { description: 'test tool', inputs: nonObjectInputs }, modelTags: [] },
          outputs: z.object({}) as unknown as ZodSchema,
          assetNeeds: NEEDS,
        }),
    ).toThrow(/EXTEND_REFERENCES_UNSUPPORTED_INPUTS: fallback-throw-test — assetNeeds declared but tool inputs is not a ZodObject/)
  })
})
