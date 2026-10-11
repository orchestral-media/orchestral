// The two reserved top-level input keys, as registration places them.
//
// `references` is derived from a Pattern's assetNeeds and `name` from its
// outputs carrying assets[], and neither is ever authored. Registration tells
// what a derivation placed from what an author wrote by instance identity, so
// these fixtures are built as literals wherever a factory would otherwise judge
// the inputs first: registration has to be the judge under test. The one
// factory-side case, extendInputsWithReferences, is pinned last, because it
// applies the same rule through the same helper.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { agentInputSchema } from '../agent-input-schema'
import type { AssetNeed } from '../asset-index.types'
import { defineAtomicPattern } from '../atomic-pattern'
import { deriveReferencesSchema } from '../derive-references-schema'
import { extendInputsWithReferences } from '../extend-inputs-with-references'
import type { ZodSchema } from '../foundational'
import { silentDiagnosticsLogger } from '../logger'
import { producedAssetShape } from '../output-envelope'
import { boundedText } from '../output-fields'
import type { AgentPattern, AtomicPattern, MetaPattern, Pattern } from '../pattern'
import { PRODUCT_NAME_FIELD } from '../product-name'
import { PatternRegistry } from '../registry'
import { toJsonSchema } from '../schema'

const SOURCE: AssetNeed = { slot: 'source', modality: 'image', cardinality: 'array', required: true }
const MASK: AssetNeed = { slot: 'mask', modality: 'image', cardinality: 'single', required: false }
const DECLARED: readonly AssetNeed[] = [SOURCE, MASK]

const assetsOutputs = () => z.object({ assets: z.array(z.object(producedAssetShape('image'))) })
const textOutputs = () => z.object({ text: boundedText(4096) })

/** An atomic built as a literal, so no factory looks at its inputs before registration does. */
function atomic(init: {
  id: string
  inputs: z.ZodType
  outputs: z.ZodType
  assetNeeds?: readonly AssetNeed[]
}): AtomicPattern {
  return {
    kind: 'atomic',
    id: init.id,
    description: init.id,
    primary: {
      tool: { description: init.id, inputs: init.inputs as unknown as ZodSchema },
      modelTags: [],
    },
    outputs: init.outputs as unknown as ZodSchema,
    ...(init.assetNeeds !== undefined ? { assetNeeds: init.assetNeeds } : {}),
  }
}

/** An atomic whose outputs carry assets[]. */
const producer = (
  inputs: z.ZodType = z.object({ prompt: z.string() }),
  assetNeeds?: readonly AssetNeed[],
) => atomic({ id: 'acme__render', inputs, outputs: assetsOutputs(), ...(assetNeeds ? { assetNeeds } : {}) })

/** An atomic whose outputs carry no assets[]. */
const nonProducer = (
  inputs: z.ZodType = z.object({ prompt: z.string() }),
  assetNeeds?: readonly AssetNeed[],
) => atomic({ id: 'acme__caption', inputs, outputs: textOutputs(), ...(assetNeeds ? { assetNeeds } : {}) })

/**
 * A meta's inputs carrying an object-level check and object-level meta — the
 * base on which replacing a key is an overwrite only safeExtend allows.
 */
function refinedInputs(extra: z.ZodRawShape = {}) {
  return z
    .object({ prompt: z.string(), ...extra })
    .superRefine((v, ctx) => {
      if (v.prompt.trim() === '') {
        ctx.addIssue({ code: 'custom', path: ['prompt'], message: 'prompt must not be blank' })
      }
    })
    .meta({ id: 'RenderPairInput', title: 'Render pair input' })
}

/** A meta whose outputs carry assets[]. */
function metaProducer(
  inputs: z.ZodType = refinedInputs(),
  assetNeeds?: readonly AssetNeed[],
): MetaPattern {
  return {
    kind: 'meta',
    id: 'meta_render-pair',
    description: 'Render two images and keep the better one.',
    tool: { description: 'Render a pair.', inputs: inputs as unknown as ZodSchema },
    outputs: assetsOutputs() as unknown as ZodSchema,
    ...(assetNeeds !== undefined ? { assetNeeds } : {}),
    compose: async () => {
      throw new Error('never dispatched here')
    },
  }
}

/** An agent declaring no outputs: the registry backfills the default finish outputs. */
function agent(): AgentPattern {
  return {
    kind: 'agent',
    id: 'agent_helper',
    description: 'helper',
    primary: { tool: { description: 'helper', inputs: agentInputSchema({}) as unknown as ZodSchema } },
    loop: { system: 's', toolPatternIds: [], modelTags: [] },
  } as AgentPattern
}

const registry = () => new PatternRegistry({ logger: silentDiagnosticsLogger })

function toolInputsOf(pattern: Pattern | undefined): z.ZodObject<z.ZodRawShape> {
  const tool = pattern?.kind === 'meta' ? pattern.tool : pattern?.primary?.tool
  if (!tool) throw new Error('no LLM-facing tool')
  return tool.inputs as unknown as z.ZodObject<z.ZodRawShape>
}

const keysOf = (pattern: Pattern | undefined) => Object.keys(toolInputsOf(pattern).shape)

const bytesOf = (schema: unknown) => JSON.stringify(toJsonSchema(schema as z.ZodType))

/** The error `fn` throws, for asserting on its code and details. */
function thrownBy(fn: () => unknown): Error & { code?: unknown; details?: unknown } {
  try {
    fn()
  } catch (error) {
    return error as Error & { code?: unknown; details?: unknown }
  }
  throw new Error('expected a throw')
}

describe('registration derives the reserved input keys', () => {
  it('a Pattern whose inputs came from extendInputsWithReferences registers', () => {
    const reg = registry()
    reg.register(
      defineAtomicPattern({
        id: 'acme__render',
        description: 'render',
        primary: {
          tool: { description: 'render', inputs: z.object({ prompt: z.string() }) as unknown as ZodSchema },
          modelTags: [],
        },
        outputs: assetsOutputs() as unknown as ZodSchema,
        assetNeeds: DECLARED,
      }),
    )
    const stored = reg.get('acme__render')
    expect(keysOf(stored)).toEqual(['prompt', 'references', 'name'])
    expect(bytesOf(toolInputsOf(stored).shape.references)).toBe(
      bytesOf(deriveReferencesSchema(DECLARED)),
    )
  })

  it('a Pattern that placed deriveReferencesSchema itself under references registers', () => {
    const reg = registry()
    const placed = z.object({ prompt: z.string(), references: deriveReferencesSchema(DECLARED)! })
    reg.register(metaProducer(placed, DECLARED))
    expect(keysOf(reg.get('meta_render-pair'))).toEqual(['prompt', 'references', 'name'])

    // Identity, not shape: a wrapper is a new instance no derivation made, so
    // the same derivation wrapped once more reads as hand-written.
    const wrapped = z.object({
      prompt: z.string(),
      references: deriveReferencesSchema(DECLARED)!.describe('Assets by handle.'),
    })
    expect(thrownBy(() => registry().register(metaProducer(wrapped, DECLARED))).details).toEqual({
      patternId: 'meta_render-pair',
      key: 'references',
      reason: 'hand-written',
    })
  })

  it('refuses a hand-written top-level references at registration', () => {
    const handwritten = z.object({
      prompt: z.string(),
      references: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
    })
    const reg = registry()
    const error = thrownBy(() => reg.register(producer(handwritten, DECLARED)))
    expect(error.code).toBe('INPUT_RESERVED_KEY')
    expect(error.details).toEqual({ patternId: 'acme__render', key: 'references', reason: 'hand-written' })
    expect(error.message).toBe(
      'INPUT_RESERVED_KEY: acme__render declares a top-level "references" in its tool inputs. "references" is derived at registration (from assetNeeds); delete it.',
    )
    expect(reg.has('acme__render')).toBe(false)
    expect(reg.size()).toBe(0)

    // Hand-written is hand-written whether or not the Pattern declares slots.
    expect(thrownBy(() => reg.register(nonProducer(handwritten))).details).toEqual({
      patternId: 'acme__caption',
      key: 'references',
      reason: 'hand-written',
    })
    expect(reg.size()).toBe(0)
  })

  it('refuses a hand-written top-level name at registration', () => {
    const handwritten = z.object({ prompt: z.string(), name: z.string().max(64).optional() })
    const reg = registry()
    for (const pattern of [producer(handwritten), nonProducer(handwritten)]) {
      const error = thrownBy(() => reg.register(pattern))
      expect(error.code).toBe('INPUT_RESERVED_KEY')
      expect(error.details).toEqual({ patternId: pattern.id, key: 'name', reason: 'hand-written' })
      expect(error.message).toBe(
        `INPUT_RESERVED_KEY: ${pattern.id} declares a top-level "name" in its tool inputs. "name" is derived at registration (for a Pattern whose outputs carry assets[]); delete it.`,
      )
      expect(reg.has(pattern.id)).toBe(false)
    }
  })

  it('replaces a derived references built from a stale assetNeeds list', () => {
    const stale = extendInputsWithReferences('acme__render', z.object({ prompt: z.string() }), [SOURCE])
    const reg = registry()
    reg.register(producer(stale, DECLARED))
    const inputs = toolInputsOf(reg.get('acme__render'))
    expect(bytesOf(inputs.shape.references)).toBe(bytesOf(deriveReferencesSchema(DECLARED)))
    expect(inputs.safeParse({ prompt: 'x', references: { mask: 'image_2' } }).success).toBe(true)
  })

  it('refuses a derived references the Pattern does not declare', () => {
    const placed = extendInputsWithReferences('acme__caption', z.object({ prompt: z.string() }), [SOURCE])
    const error = thrownBy(() => registry().register(nonProducer(placed)))
    expect(error.code).toBe('INPUT_RESERVED_KEY')
    expect(error.details).toEqual({ patternId: 'acme__caption', key: 'references', reason: 'undeclared' })
    expect(error.message).toBe(
      'INPUT_RESERVED_KEY: acme__caption carries a derived "references" its own declaration does not produce (it declares no assetNeeds); build its inputs without it.',
    )

    // The same rule for the other key: the derived name on a Pattern whose
    // outputs carry no assets[] would advertise a name nothing records.
    const named = z.object({ prompt: z.string(), name: PRODUCT_NAME_FIELD })
    const nameError = thrownBy(() => registry().register(nonProducer(named)))
    expect(nameError.details).toEqual({ patternId: 'acme__caption', key: 'name', reason: 'undeclared' })
    expect(nameError.message).toBe(
      'INPUT_RESERVED_KEY: acme__caption carries a derived "name" its own declaration does not produce (its outputs carry no assets[]); build its inputs without it.',
    )
  })

  it('adds name after references to a Pattern whose outputs carry assets, and to no other', () => {
    const reg = registry()
    reg.register(producer(z.object({ prompt: z.string(), size: z.string().optional() }), DECLARED))
    reg.register(nonProducer(z.object({ prompt: z.string() }), [SOURCE]))
    reg.register(atomic({ id: 'acme__sketch', inputs: z.object({ prompt: z.string() }), outputs: assetsOutputs() }))

    const render = reg.get('acme__render')
    expect(keysOf(render)).toEqual(['prompt', 'size', 'references', 'name'])
    expect(toolInputsOf(render).shape.name).toBe(PRODUCT_NAME_FIELD)
    const rendered = toJsonSchema(toolInputsOf(render)) as { required?: string[] }
    expect(rendered.required).not.toContain('name')

    expect(keysOf(reg.get('acme__caption'))).toEqual(['prompt', 'references'])
    expect(keysOf(reg.get('acme__sketch'))).toEqual(['prompt', 'name'])
  })

  it('adds name to an agent registered with the default finish outputs', () => {
    const reg = registry()
    reg.register(agent())
    const stored = reg.get('agent_helper')
    expect(keysOf(stored)).toEqual(['description', 'prompt', 'name'])
    expect(toolInputsOf(stored).shape.name).toBe(PRODUCT_NAME_FIELD)

    // A host-only agent has nothing LLM-facing to complete.
    const { primary: _primary, ...hostOnly } = agent()
    expect(() => reg.register({ ...hostOnly, id: 'agent_host-only' } as AgentPattern)).not.toThrow()
  })

  it('is idempotent: a registered Pattern registers again to the same bytes', () => {
    for (const pattern of [producer(z.object({ prompt: z.string() }), DECLARED), metaProducer(refinedInputs(), DECLARED), agent()]) {
      const a = registry()
      a.register(pattern)
      const first = a.getEntry(pattern.id)!.pattern
      const b = registry()
      b.register(first)
      const second = b.getEntry(pattern.id)!.pattern

      expect(bytesOf(toolInputsOf(second))).toBe(bytesOf(toolInputsOf(first)))
      expect(toolInputsOf(second).shape.name).toBe(toolInputsOf(first).shape.name)
      expect(toolInputsOf(second).shape.name).toBe(PRODUCT_NAME_FIELD)
    }

    // With nothing to re-derive — no references, the name already in place —
    // the inputs come back by reference.
    const a = registry()
    a.register(agent())
    const first = a.get('agent_helper')
    const b = registry()
    b.register(first!)
    expect(toolInputsOf(b.get('agent_helper'))).toBe(toolInputsOf(first))
  })

  it('never mutates the object it was given', () => {
    const built = defineAtomicPattern({
      id: 'acme__render',
      description: 'render',
      primary: {
        tool: { description: 'render', inputs: z.object({ prompt: z.string() }) as unknown as ZodSchema },
        modelTags: [],
      },
      outputs: assetsOutputs() as unknown as ZodSchema,
      assetNeeds: DECLARED,
    })
    const primaryBefore = built.primary
    const inputsBefore = built.primary.tool.inputs
    const given = metaProducer(refinedInputs(), DECLARED)
    const toolBefore = given.tool
    const metaInputsBefore = given.tool.inputs

    const reg = registry()
    reg.register(built)
    reg.register(given)

    expect(built.primary).toBe(primaryBefore)
    expect(built.primary.tool.inputs).toBe(inputsBefore)
    expect(keysOf(built)).toEqual(['prompt', 'references'])
    expect(given.tool).toBe(toolBefore)
    expect(given.tool.inputs).toBe(metaInputsBefore)
    expect(keysOf(given)).toEqual(['prompt'])
    expect(reg.get('acme__render')).not.toBe(built)
    expect(reg.get('meta_render-pair')).not.toBe(given)
  })

  it('keeps object-level checks and meta on a refined base', () => {
    // Appending to a refined base, and replacing on one: the stale derived
    // references is a key overwrite, which .extend() refuses there.
    for (const inputs of [refinedInputs(), refinedInputs({ references: deriveReferencesSchema([SOURCE])! })]) {
      const reg = registry()
      reg.register(metaProducer(inputs, DECLARED))
      const stored = toolInputsOf(reg.get('meta_render-pair'))

      expect(Object.keys(stored.shape)).toEqual(['prompt', 'references', 'name'])
      expect(stored.safeParse({ prompt: '   ' }).success).toBe(false)
      expect(stored.safeParse({ prompt: 'two cats', name: 'hero' }).success).toBe(true)
      expect(stored.safeParse({ prompt: 'two cats', name: 'image_3' }).success).toBe(false)
      expect(stored.safeParse({ prompt: 'two cats', references: { mask: 'image_2' } }).success).toBe(true)
      expect(stored.meta()?.title).toBe('Render pair input')
      expect(stored.meta()?.id).toBeUndefined()
    }
  })

  it('refuses a Pattern that produces assets with non-object inputs', () => {
    const union = z.union([z.object({ a: z.string() }), z.object({ b: z.string() })])
    const reg = registry()
    const error = thrownBy(() => reg.register(producer(union)))
    expect(error.code).toBe('EXTEND_NAME_UNSUPPORTED_INPUTS')
    expect(error.message).toBe(
      'EXTEND_NAME_UNSUPPORTED_INPUTS: acme__render — its outputs carry assets[] but its tool inputs is not a ZodObject; define the input schema with z.object()',
    )
    expect(reg.has('acme__render')).toBe(false)

    // The slot record fails the same way, under its own unchanged message.
    expect(() => reg.register(nonProducer(union, DECLARED))).toThrow(
      'EXTEND_REFERENCES_UNSUPPORTED_INPUTS: acme__caption — assetNeeds declared but tool inputs is not a ZodObject; define the input schema with z.object()',
    )

    // Nothing is due, so there is nothing to refuse: the inputs stay as given.
    reg.register(nonProducer(union))
    expect(reg.get('acme__caption')!.primary!.tool.inputs).toBe(union)
  })

  it('does not reserve nested name keys', () => {
    const nested = z.object({ items: z.array(z.object({ name: z.string() })) })
    const reg = registry()
    reg.register(producer(nested))
    reg.register(nonProducer(nested))

    const stored = toolInputsOf(reg.get('acme__render'))
    expect(Object.keys(stored.shape)).toEqual(['items', 'name'])
    // A nested name is the author's field, not the product name: no mint grammar applies to it.
    expect(stored.safeParse({ items: [{ name: 'image_3' }] }).success).toBe(true)
    expect(keysOf(reg.get('acme__caption'))).toEqual(['items'])
  })
})

describe('extendInputsWithReferences applies the same rule at construction', () => {
  it('extendInputsWithReferences refuses a hand-written references at construction', () => {
    const handwritten = z.object({
      prompt: z.string(),
      references: z.record(z.string(), z.string()).optional(),
    })
    const error = thrownBy(() => extendInputsWithReferences('acme__render', handwritten, DECLARED))
    expect(error.code).toBe('INPUT_RESERVED_KEY')
    expect(error.details).toEqual({ patternId: 'acme__render', key: 'references', reason: 'hand-written' })

    // With no slots declared it inspects nothing; registration judges that case.
    expect(extendInputsWithReferences('acme__render', handwritten, undefined)).toBe(handwritten)
    expect(extendInputsWithReferences('acme__render', handwritten, [])).toBe(handwritten)
  })
})
