// Every registered Pattern whose outputs carry assets[] takes a `name`, and no
// other Pattern does.
//
// The field is not written by any factory: registration derives it, from the
// one fact that decides whether a product can be recorded under a name at all.
// So the claim is a property of the CATALOG as the registry holds it, swept the
// way meta-planned-dispatches.test.ts sweeps it — through `addFromManifest`, so
// `meta_plan` arrives through its `getPattern` op like any host would load it,
// and a Pattern added to the manifest tomorrow is covered the day it ships.
//
// The sweep is held to having teeth: the same check, run over the catalog as
// its factories build it — before registration has derived anything — must
// name every producer. A check that passed both ways would be passing on
// nothing.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'

import {
  buildAlwaysLoadDescriptors,
  isDispatchError,
  PatternRegistry,
  producesAssets,
  resolveDispatchTarget,
  silentDiagnosticsLogger,
  toJsonSchema,
  type Pattern,
} from '@orchestral/core'
import { handleFindPattern, PatternSearchIndex } from '@orchestral/discovery'

import * as patterns from '../index'

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { orchestral: { patterns: ReadonlyArray<{ id: string; export: string }> } }

/** Host ops the manifest declares — stubs; nothing dispatches here. */
const OPS = {
  concatVideos: async () => ({ assetId: 'v' }),
  stillToVideo: async () => ({ assetId: 'v' }),
  addBackgroundAudio: async () => ({ assetId: 'v' }),
  addSubtitles: async () => ({ assetId: 'v' }),
  createSubtitleAsset: async () => ({ assetId: 's' }),
  recordSessionAsset: async () => ({ handle: 'image_1' }),
  getPattern: () => undefined,
}

// The field as every surface renders it. Model-visible copy, frozen: it enters
// the tool schema of every asset-producing Pattern, so a change here is a
// deliberate release decision, not a refactor.
const NAME_NODE = {
  type: 'string',
  maxLength: 64,
  description:
    'Optional handle for what this call produces, bound now rather than assigned on completion — one asset is named exactly this, several are named <name>-1, <name>-2, … in output order — so later references can use it instead of a handle guessed from call order. It must not already be in use in this context and must not look like a generated handle (image_3, video_1).',
}

function shippedCatalog(): PatternRegistry {
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  const result = registry.addFromManifest(pkg.orchestral, patterns, OPS)
  // The whole catalog — a pattern skipped for want of an op would be one this
  // sweep never looked at.
  expect(result.skipped).toEqual([])
  return registry
}

/** The same Patterns, as their factories build them: nothing derived yet. */
function unregisteredCatalog(): Pattern[] {
  const factories = patterns as unknown as Record<string, (ops: unknown) => Pattern>
  return pkg.orchestral.patterns.map((entry) => factories[entry.export]!(OPS))
}

/** The LLM-facing input schema, or undefined for a Pattern with no tool. */
function toolInputsOf(pattern: Pattern): z.ZodObject<z.ZodRawShape> | undefined {
  const tool = pattern.kind === 'meta' ? pattern.tool : pattern.primary?.tool
  return tool?.inputs as unknown as z.ZodObject<z.ZodRawShape> | undefined
}

/** Ids whose tool inputs carry `name` exactly when their outputs do not carry assets[], or the reverse. */
function mismatched(catalog: Iterable<Pattern>): string[] {
  const out: string[] = []
  for (const pattern of catalog) {
    const inputs = toolInputsOf(pattern)
    if (!inputs) continue
    if (Object.hasOwn(inputs.shape, 'name') !== producesAssets(pattern)) out.push(pattern.id)
  }
  return out
}

describe('the registered catalog derives name from assets[]', () => {
  it('every registered Pattern whose outputs carry assets exposes name, and no other Pattern does', () => {
    const registry = shippedCatalog()
    const withTool = [...registry.values()].filter((p) => toolInputsOf(p) !== undefined)
    const producers = withTool.filter((p) => producesAssets(p))

    // Guard the guard: a sweep over no producers, or over producers only,
    // would pass whatever registration did.
    expect(producers.length).toBeGreaterThan(0)
    expect(producers.map((p) => p.id)).toContain('meta_plan')
    expect(withTool.map((p) => p.id)).toContain('text-generation')
    expect(producers.map((p) => p.id)).not.toContain('text-generation')

    expect(mismatched(withTool)).toEqual([])

    for (const pattern of producers) {
      const inputs = toolInputsOf(pattern)!
      const rendered = toJsonSchema(inputs) as {
        properties: Record<string, unknown>
        required?: string[]
      }
      expect(rendered.properties.name, pattern.id).toEqual(NAME_NODE)
      expect(rendered.required ?? [], pattern.id).not.toContain('name')
      // Derived keys come last, `name` after `references`.
      expect(Object.keys(inputs.shape).at(-1), pattern.id).toBe('name')
    }

    // Teeth: before registration derives it, every producer is missing the
    // field, and the check above names each one.
    expect(mismatched(unregisteredCatalog())).toEqual(producers.map((p) => p.id))
  })

  it('text-to-image accepts a name through dispatch', () => {
    const registry = shippedCatalog()
    const accepted = resolveDispatchTarget(
      registry,
      { pattern_id: 'text-to-image', input: { prompt: 'a red bicycle', name: 'hero' } },
      'chat-turn',
    )
    if (isDispatchError(accepted)) throw new Error(`expected a target, got ${accepted.code}`)
    expect(accepted.parsedInput.name).toBe('hero')

    // Validated as the schema's own field, not carried as a passthrough extra:
    // a name in the mint grammar is an input issue at `name`.
    const refused = resolveDispatchTarget(
      registry,
      { pattern_id: 'text-to-image', input: { prompt: 'a red bicycle', name: 'image_3' } },
      'chat-turn',
    )
    if (!isDispatchError(refused) || refused.code !== 'INPUT_VALIDATION_FAILED') {
      throw new Error('expected INPUT_VALIDATION_FAILED')
    }
    expect(refused.issues.map(({ path, code }) => ({ path, code }))).toEqual([
      { path: ['name'], code: 'custom' },
    ])
  })

  it('the always-load descriptor and find_pattern render the same name field', () => {
    const registry = shippedCatalog()
    const descriptor = buildAlwaysLoadDescriptors([...registry.values()]).find(
      (d) => d.name === 'text-to-image',
    )
    const match = handleFindPattern(new PatternSearchIndex(registry), {
      query: 'select:text-to-image',
    }).matches.find((m) => m.patternId === 'text-to-image')
    expect(descriptor).toBeDefined()
    expect(match).toBeDefined()

    const alwaysLoad = descriptor!.inputSchema as { properties: Record<string, unknown> }
    const found = match!.primary.inputSchema as { properties: Record<string, unknown> }
    expect(alwaysLoad.properties.name).toEqual(NAME_NODE)
    expect(found.properties.name).toEqual(NAME_NODE)
    expect(JSON.stringify(found)).toBe(JSON.stringify(alwaysLoad))
  })
})
