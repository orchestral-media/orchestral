import { describe, expect, it } from 'vitest'

import { auditOutputsSchema, toJsonSchema } from '@orchestral/core'

import {
  PLAN_ASSET_REF_RE,
  PLAN_INPUT_ASSET_REF_RE,
  PLAN_STEP_ID_RE,
  PLAN_VALUE_REF_RE,
  PlanDagSchema,
  PlanOutputSchema,
  PlanRetrySchema,
  planDagSchema,
} from '../plan'
import { planRefine } from '../validate'

type JsonNode = Record<string, unknown>

/** Every node in a rendered JSON Schema, depth-first. */
function nodes(root: unknown): JsonNode[] {
  const out: JsonNode[] = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry)
      return
    }
    if (typeof node !== 'object' || node === null) return
    out.push(node as JsonNode)
    for (const value of Object.values(node as JsonNode)) visit(value)
  }
  visit(root)
  return out
}

/** Walk to a node by JSON-Schema property path. */
function at(root: unknown, ...path: string[]): JsonNode {
  let node = root as JsonNode
  for (const key of path) {
    node = node[key] as JsonNode
    expect(node, `missing node at ${path.join('/')}`).toBeDefined()
  }
  return node
}

const emptyLookup = { get: () => undefined, getEntry: () => undefined }

describe('PlanDagSchema renders for find_pattern', () => {
  const rendered = toJsonSchema(PlanDagSchema) as unknown as JsonNode

  it('survives toJsonSchema at all', () => {
    expect(rendered.type).toBe('object')
    expect(rendered.additionalProperties).toBe(false)
    expect(rendered.required).toEqual(['steps', 'output'])
  })

  it('emits each regex as an exact `pattern`', () => {
    const patterns = new Set(
      nodes(rendered)
        .map((n) => n.pattern)
        .filter((p): p is string => typeof p === 'string'),
    )
    expect(patterns).toContain(PLAN_STEP_ID_RE.source)
    expect(patterns).toContain(PLAN_VALUE_REF_RE.source)
    expect(patterns).toContain(PLAN_ASSET_REF_RE.source)
  })

  it('marks required exactly what the design says is required', () => {
    const step = at(rendered, 'properties', 'steps', 'items')
    expect(step.required).toEqual(['id', 'pattern', 'input'])
    expect(step.additionalProperties).toBe(false)

    const output = at(rendered, 'properties', 'output')
    // Both members of `output` are optional; `output` itself is not.
    expect(output.required).toBeUndefined()
    expect(rendered.required).toContain('output')
    expect(rendered.required).not.toContain('description')
  })

  it('emits no `default` anywhere — a defaulted field would render as required', () => {
    expect(nodes(rendered).filter((n) => 'default' in n)).toEqual([])
  })

  it('keeps every model-fillable bound', () => {
    const steps = at(rendered, 'properties', 'steps')
    expect(steps).toMatchObject({ minItems: 1, maxItems: 64 })
    expect(at(rendered, 'properties', 'description')).toMatchObject({
      minLength: 1,
      maxLength: 512,
    })
    expect(at(rendered, 'properties', 'steps', 'items', 'properties', 'pattern')).toMatchObject(
      { minLength: 1, maxLength: 128 },
    )
    const retry = toJsonSchema(PlanRetrySchema) as unknown as JsonNode
    const attempts = nodes(retry).filter((n) => n.maximum === 5)
    expect(attempts.length).toBe(2) // exponential + fixed
  })

  it('a superRefine is invisible to the renderer', () => {
    const refined = toJsonSchema(
      PlanDagSchema.superRefine(planRefine(emptyLookup, { selfId: 'meta_plan' })),
    )
    expect(refined).toEqual(rendered)
  })
})

describe('planDagSchema — one grammar, two reaches', () => {
  const full = toJsonSchema(planDagSchema({ inputAssets: true }))
  const narrow = toJsonSchema(planDagSchema({ inputAssets: false })) as unknown as JsonNode

  /** Every `pattern` the render carries, at any depth. */
  const patternsOf = (root: unknown): Set<string> =>
    new Set(
      nodes(root)
        .map((n) => n.pattern)
        .filter((p): p is string => typeof p === 'string'),
    )

  it('the declaring variant IS PlanDagSchema, byte for byte', () => {
    // The exported constant is not a second definition to keep in step; it is
    // one of the two calls. Stringified rather than `toEqual` because what
    // ships to a model is bytes, and key order is part of them.
    expect(JSON.stringify(full)).toBe(JSON.stringify(toJsonSchema(PlanDagSchema)))
  })

  it('the declaring variant still advertises both asset productions', () => {
    expect(patternsOf(full)).toContain(PLAN_ASSET_REF_RE.source)
    expect(patternsOf(full)).toContain(PLAN_INPUT_ASSET_REF_RE.source)
    expect(JSON.stringify(full)).toContain('$input.assets[slot=<name>]')
  })

  it('the producer-only variant advertises no slot form at all', () => {
    // Not just the pattern: the describe copy is what a model actually reads,
    // and a form it can never satisfy is worse there than in a regex.
    expect(patternsOf(narrow)).toContain(PLAN_ASSET_REF_RE.source)
    expect(patternsOf(narrow)).not.toContain(PLAN_INPUT_ASSET_REF_RE.source)
    const bytes = JSON.stringify(narrow)
    expect(bytes).not.toContain('slot=')
    expect(bytes).not.toContain('$input.assets')
  })

  it('differs from the full variant in the asset ref alone', () => {
    // Everything else — bounds, required lists, the value-ref production, the
    // output block — is the same schema. If this ever fails, the two variants
    // have started to diverge into two grammars.
    expect(patternsOf(narrow)).toEqual(
      new Set([...patternsOf(full)].filter((p) => p !== PLAN_INPUT_ASSET_REF_RE.source)),
    )
    expect(at(narrow, 'properties', 'steps', 'items').required).toEqual(
      at(full as unknown as JsonNode, 'properties', 'steps', 'items').required,
    )
  })
})

describe('PlanOutputSchema', () => {
  it('reports nothing unbounded', () => {
    expect(auditOutputsSchema(PlanOutputSchema)).toEqual({
      unbounded: [],
      notTraversed: [],
    })
  })

  it('renders, and carries no default', () => {
    const rendered = toJsonSchema(PlanOutputSchema) as unknown as JsonNode
    expect(rendered.required).toEqual([
      'assets',
      'values',
      'steps',
      'cost',
      'latencyMs',
    ])
    expect(nodes(rendered).filter((n) => 'default' in n)).toEqual([])
  })

  it('carries an assetId in `assets[]` and nowhere else', () => {
    const rendered = toJsonSchema(PlanOutputSchema) as unknown as JsonNode
    const stepProps = at(rendered, 'properties', 'steps', 'items', 'properties')
    expect(Object.keys(stepProps)).toEqual(['id', 'pattern', 'cost'])
  })
})

describe('the three productions', () => {
  it('accepts the forms the worked examples use', () => {
    expect(PLAN_STEP_ID_RE.test('take-0')).toBe(true)
    expect(PLAN_VALUE_REF_RE.test('$describe.text')).toBe(true)
    expect(PLAN_VALUE_REF_RE.test('$sb.panels[0].visualDesc')).toBe(true)
    expect(PLAN_VALUE_REF_RE.test('$input.motion')).toBe(true)
    expect(PLAN_ASSET_REF_RE.test('$render.assets[0]')).toBe(true)
    expect(PLAN_ASSET_REF_RE.test('$bestof.assets[label=winner]')).toBe(true)
  })

  it('refuses the forms the grammar deliberately lacks', () => {
    expect(PLAN_STEP_ID_RE.test('a/b')).toBe(false)
    expect(PLAN_STEP_ID_RE.test('0start')).toBe(false)
    expect(PLAN_VALUE_REF_RE.test('$5.99')).toBe(false)
    expect(PLAN_VALUE_REF_RE.test('$describe')).toBe(false)
    expect(PLAN_VALUE_REF_RE.test('{{ describe.text }}')).toBe(false)
    expect(PLAN_ASSET_REF_RE.test('$render.assets[label=has space]')).toBe(false)
  })
})

describe('PlanOutputSchema.assets[].modality is core\'s AssetKind', () => {
  const asset = (modality: string) => ({
    assets: [{ assetId: 'a1', modality, label: 'out' }],
    values: {},
    steps: [],
    cost: null,
    latencyMs: 0,
  })

  // The four kinds the old image/audio/video enum rejected. A plan ending in a
  // document or a data file is an ordinary plan; it used to parse only at the
  // dispatch exit, where it failed.
  it.each(['document', 'data', 'archive', 'other'])('accepts %s', (kind) => {
    expect(PlanOutputSchema.safeParse(asset(kind)).success).toBe(true)
  })

  it.each(['image', 'audio', 'video'])('still accepts %s', (kind) => {
    expect(PlanOutputSchema.safeParse(asset(kind)).success).toBe(true)
  })

  it('rejects a modality that is not an AssetKind', () => {
    expect(PlanOutputSchema.safeParse(asset('text')).success).toBe(false)
    expect(PlanOutputSchema.safeParse(asset('embedding')).success).toBe(false)
  })

  it('renders the full kind list to the model', () => {
    const rendered = toJsonSchema(PlanOutputSchema) as unknown as {
      properties: { assets: { items: { properties: { modality: { enum: string[] } } } } }
    }
    expect(rendered.properties.assets.items.properties.modality.enum.sort()).toEqual([
      'archive',
      'audio',
      'data',
      'document',
      'image',
      'other',
      'video',
    ])
  })
})
