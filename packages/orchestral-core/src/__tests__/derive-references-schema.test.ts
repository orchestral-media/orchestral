// SSOT derivation: LLM-facing `references` schema is derived from assetNeeds.
// Pins: key shape per cardinality, strictness (unknown slot rejected), all-
// optional keys (omission semantics live in the describe copy, not in zod
// required-ness), and the FINAL describe copy (byte-stable prefix — ADR-008).
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { deriveReferencesSchema } from '../derive-references-schema'
import type { AssetNeed } from '../asset-index.types'

const I2I_NEEDS: AssetNeed[] = [
  { slot: 'source', modality: 'image', cardinality: 'array', required: true, description: 'The image(s) to edit.' },
  { slot: 'mask', modality: 'image', cardinality: 'single', required: false, description: 'Mask image — white = region to edit, black = preserve.' },
]

describe('deriveReferencesSchema', () => {
  it('returns undefined for empty/absent needs', () => {
    expect(deriveReferencesSchema(undefined)).toBeUndefined()
    expect(deriveReferencesSchema([])).toBeUndefined()
  })

  it('single slot accepts a string and rejects an array (D1: tightened)', () => {
    const schema = z.object({ references: deriveReferencesSchema(I2I_NEEDS)! })
    expect(schema.safeParse({ references: { mask: 'image_3' } }).success).toBe(true)
    const r = schema.safeParse({ references: { mask: ['image_3'] } })
    expect(r.success).toBe(false)
  })

  it('array slot accepts string or string[]', () => {
    const schema = z.object({ references: deriveReferencesSchema(I2I_NEEDS)! })
    expect(schema.safeParse({ references: { source: 'image_1' } }).success).toBe(true)
    expect(schema.safeParse({ references: { source: ['image_1', 'image_2'] } }).success).toBe(true)
  })

  it('is strict: unknown slot key fails parse (fail-closed at schema layer)', () => {
    const schema = z.object({ references: deriveReferencesSchema(I2I_NEEDS)! })
    const r = schema.safeParse({ references: { styleref: 'image_1' } })
    expect(r.success).toBe(false)
  })

  it('every slot key is optional — omission and {} both parse', () => {
    const schema = z.object({ references: deriveReferencesSchema(I2I_NEEDS)! })
    expect(schema.safeParse({}).success).toBe(true)
    expect(schema.safeParse({ references: {} }).success).toBe(true)
  })

  it('describe copy is the frozen template text', () => {
    const refs = deriveReferencesSchema(I2I_NEEDS)!
    // .optional() wraps the object; describe lives on the inner object.
    const inner = refs.unwrap() as z.ZodObject<z.ZodRawShape>
    expect(inner.description).toBe(
      'Reference assets by their handle (e.g. "image_2"), keyed by slot. Pick handles from the asset list provided in context. Never pass raw asset ids or URLs.',
    )
    // shape values are $ZodType (core); cast to classic ZodType which exposes description.
    type WithDesc = { description?: string }
    expect((inner.shape.source! as unknown as WithDesc).description).toBe(
      'The image(s) to edit. Omit to auto-use the most recent image batch in this context.',
    )
    expect((inner.shape.mask! as unknown as WithDesc).description).toBe(
      'Mask image — white = region to edit, black = preserve. Optional — provide only when needed; omitting means none (never auto-filled).',
    )
  })

  it('throws fail-fast on duplicate slot names (no silent last-wins)', () => {
    const dupNeeds: AssetNeed[] = [
      { slot: 'source', modality: 'image', cardinality: 'array', required: true },
      { slot: 'source', modality: 'image', cardinality: 'single', required: false },
    ]
    expect(() => deriveReferencesSchema(dupNeeds)).toThrow(
      'DERIVE_REFERENCES_DUPLICATE_SLOT: "source" appears more than once in assetNeeds',
    )
  })

  it('required+single template names the modality (not batch)', () => {
    const refs = deriveReferencesSchema([
      { slot: 'startFrame', modality: 'image', cardinality: 'single', required: true },
    ])!
    const inner = refs.unwrap() as z.ZodObject<z.ZodRawShape>
    type WithDesc = { description?: string }
    expect((inner.shape.startFrame! as unknown as WithDesc).description).toBe(
      'Omit to auto-use the most recent image in this context.',
    )
  })
})
