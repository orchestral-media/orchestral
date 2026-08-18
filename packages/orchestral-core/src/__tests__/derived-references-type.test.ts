// Compile-time contract for DerivedReferences (the static twin of
// deriveReferencesSchema). The assertions live in the type system — tsc
// failing IS the test; the runtime body is a formality.
import { describe, expect, it } from 'vitest'

import type { AssetNeed, DerivedReferences } from '../asset-index.types'

const NEEDS = [
  { slot: 'source', modality: 'image', cardinality: 'single', required: true },
  { slot: 'reference', modality: 'image', cardinality: 'array', required: false },
] as const satisfies readonly AssetNeed[]

type Refs = DerivedReferences<typeof NEEDS>

describe('DerivedReferences mapped type', () => {
  it('derives per-slot optional types from as-const assetNeeds', () => {
    const ok1: Refs = { source: 'image_1' }
    const ok2: Refs = { reference: ['image_1', 'image_2'] }
    const ok3: Refs = {}
    // NOTE: @ts-expect-error only covers the NEXT line — keep these single-line.
    // @ts-expect-error single-cardinality slot rejects arrays
    const bad1: Refs = { source: ['image_1'] }
    // @ts-expect-error undeclared slot key rejected
    const bad2: Refs = { bogus: 'image_1' }
    expect([ok1, ok2, ok3, bad1, bad2]).toBeDefined()
  })
})
