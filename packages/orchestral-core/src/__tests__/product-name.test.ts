// The reserved `name` field and its two readers. Pins what a caller may write
// under `name` (anything outside every kind's mint grammar, within 64
// characters), how the field renders into a tool schema, what productNameOf
// reads out of an input, and that both derivations mark the instances they
// build — which is how registration tells a derived field from a hand-written
// one.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { defaultAgentFinishOutputs } from '../agent-finish'
import type { AssetNeed } from '../asset-index.types'
import { defineAtomicPattern } from '../atomic-pattern'
import { deriveReferencesSchema } from '../derive-references-schema'
import { isDerived } from '../derived-fields'
import type { ZodSchema } from '../foundational'
import { producedAssetShape } from '../output-envelope'
import { ASSET_KINDS, boundedText } from '../output-fields'
import type { AgentPattern } from '../pattern'
import { PRODUCT_NAME_FIELD, producesAssets } from '../product-name'
import { productNameOf } from '../product-name-of'
import { toJsonSchema } from '../schema'

// Wrapped so issue paths read ['name'], as they do in a Pattern's input.
const schema = z.object({ name: PRODUCT_NAME_FIELD })

function issuesOf(name: unknown) {
  const r = schema.safeParse({ name })
  return r.success ? [] : r.error.issues.map(({ path, code, message }) => ({ path, code, message }))
}

// The field's model-visible copy, frozen the same way the references copy is:
// it enters every asset-producing Pattern's tool schema.
const NAME_DESCRIBE =
  'Optional handle for what this call produces, bound now rather than assigned on completion — one asset is named exactly this, several are named <name>-1, <name>-2, … in output order — so later references can use it instead of a handle guessed from call order. It must not already be in use in this context and must not look like a generated handle (image_3, video_1).'

const MINT_GRAMMAR_MESSAGE =
  'name must not have the shape of a generated handle (<kind>_<n>, e.g. image_3): those are assigned by the ledger. Pick another name, or omit name.'

const assetsOutput = () => z.object({ assets: z.array(z.object(producedAssetShape('image'))) })

function atomic(outputs: z.ZodType) {
  return defineAtomicPattern({
    id: 'atomic_t',
    description: 't',
    primary: {
      tool: { description: 't', inputs: z.object({ prompt: z.string() }) as unknown as ZodSchema },
      modelTags: [],
    },
    outputs: outputs as unknown as ZodSchema,
  })
}

function agent(over: Partial<AgentPattern>): AgentPattern {
  return {
    id: 'agent_t',
    kind: 'agent',
    description: 't',
    loop: { system: 's', toolPatternIds: [], modelTags: [] },
    ...over,
  } as AgentPattern
}

describe('PRODUCT_NAME_FIELD', () => {
  it.each([
    '',
    '   ',
    'hero-shot',
    'tiptoe-1',
    '封面',
    'asset://hero',
    'x'.repeat(64),
    'image_0',
    'image_007',
    'Image_3',
    'image-3',
    'image_3.png',
  ])('accepts %j', (name) => {
    expect(issuesOf(name)).toEqual([])
  })

  it('refuses a name in the mint grammar of every asset kind', () => {
    for (const kind of ASSET_KINDS) {
      for (const name of [`${kind}_1`, `${kind}_12`, `asset://${kind}_1`, ` ${kind}_1 `]) {
        expect(issuesOf(name), name).toEqual([
          { path: ['name'], code: 'custom', message: MINT_GRAMMAR_MESSAGE },
        ])
      }
    }
  })

  it.each<[unknown, string]>([
    ['x'.repeat(65), 'too_big'],
    [null, 'invalid_type'],
  ])('refuses %j with exactly one issue', (name, expected) => {
    expect(issuesOf(name).map(({ path, code }) => ({ path, code }))).toEqual([
      { path: ['name'], code: expected },
    ])
  })

  it('renders as an optional bounded string', () => {
    const json = toJsonSchema(schema) as {
      properties: Record<string, unknown>
      required?: string[]
    }
    expect(json.properties.name).toEqual({
      type: 'string',
      maxLength: 64,
      description: NAME_DESCRIBE,
    })
    expect(json.required ?? []).not.toContain('name')
  })

  it('is the one derived name instance', () => {
    expect(isDerived(PRODUCT_NAME_FIELD)).toBe(true)
    expect(isDerived(z.string().optional())).toBe(false)
  })
})

describe('productNameOf', () => {
  it('productNameOf reads, trims, normalises and treats blank as absent', () => {
    const table: ReadonlyArray<[unknown, string | undefined]> = [
      [{ name: 'hero' }, 'hero'],
      [{ name: '  hero ' }, 'hero'],
      [{ name: 'asset://hero' }, 'hero'],
      [{ name: 'asset://%E5%B0%81%E9%9D%A2' }, '封面'],
      [{ name: '' }, undefined],
      [{ name: '  ' }, undefined],
      [{ name: 'asset://' }, undefined],
      [{ name: 3 }, undefined],
      [{}, undefined],
      [null, undefined],
      [undefined, undefined],
      ['hero', undefined],
    ]
    for (const [input, expected] of table) {
      expect(productNameOf(input), String(JSON.stringify(input))).toBe(expected)
    }
  })
})

describe('producesAssets', () => {
  it('producesAssets reads the outputs shape', () => {
    expect(producesAssets(atomic(assetsOutput()))).toBe(true)
    expect(producesAssets(agent({ outputs: defaultAgentFinishOutputs }))).toBe(true)

    expect(producesAssets(atomic(z.object({ text: boundedText(4_096) })))).toBe(false)
    expect(producesAssets(agent({}))).toBe(false)
    // A union root has no shape to read, even when a member declares assets.
    expect(
      producesAssets(atomic(z.union([assetsOutput(), z.object({ text: boundedText(4_096) })]))),
    ).toBe(false)
  })
})

describe('deriveReferencesSchema', () => {
  it('deriveReferencesSchema returns a derived instance', () => {
    const needs: AssetNeed[] = [
      { slot: 'source', modality: 'image', cardinality: 'single', required: true },
    ]
    expect(isDerived(deriveReferencesSchema(needs))).toBe(true)
    expect(deriveReferencesSchema(undefined)).toBeUndefined()
    expect(deriveReferencesSchema([])).toBeUndefined()
  })
})
