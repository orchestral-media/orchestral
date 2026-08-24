import { describe, expect, it } from 'vitest'

import { auditOutputsSchema } from '../output-fields'
import {
  PLAN_ASSET_REF_RE,
  PLAN_STEP_ID_RE,
  PLAN_VALUE_REF_RE,
  PlanDagSchema,
  PlanOutputSchema,
  PlanRetrySchema,
} from '../plan'
import { planRefine } from '../plan-validate'
import { toJsonSchema } from '../schema'

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
