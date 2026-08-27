import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { Alternative } from '../alternative'
import { defineAtomicPattern } from '../atomic-pattern'
import type { PatternId } from '../foundational'
import { silentDiagnosticsLogger } from '../logger'
import { dispatchEnvelopeShape, producedAssetShape } from '../output-envelope'
import type { MetaPattern, Pattern } from '../pattern'
import { PatternRegistry } from '../registry'

function newRegistry(): PatternRegistry {
  return new PatternRegistry({ logger: silentDiagnosticsLogger })
}

function scopedMeta(id: string): MetaPattern {
  return {
    id: id as PatternId,
    kind: 'meta',
    description: 'A plan registered for the life of one session.',
    // The scope's own rule: a temporary plan is host-only, so a sub-agent's
    // find_pattern (which indexes the registry at each dispatch) never sees it.
    exposure: 'no-tool',
    tool: { description: 'Run it.', inputs: z.object({}) },
    outputs: z.object({ ok: z.literal(true) }),
    compose: async () => ({ ok: true }) as never,
  }
}

const imagePattern = defineAtomicPattern({
  id: 'text-to-image',
  description: 'Render an image.',
  primary: {
    tool: { description: 'Render.', inputs: z.object({ prompt: z.string().min(1) }) },
    modelTags: [],
  },
  outputs: z.object({
    modality: z.literal('image'),
    assets: z.array(z.object(producedAssetShape('image'))),
    ...dispatchEnvelopeShape,
  }),
}) as unknown as Pattern

describe('PatternRegistry.scope', () => {
  it('add / dispose round-trips', () => {
    const registry = newRegistry()
    const scope = registry.scope()
    scope.add(scopedMeta('meta_plan-abc'))
    scope.add(scopedMeta('meta_plan-def'))

    expect(registry.has('meta_plan-abc' as PatternId)).toBe(true)
    expect(registry.get('meta_plan-def' as PatternId)?.kind).toBe('meta')

    scope.dispose()
    expect(registry.has('meta_plan-abc' as PatternId)).toBe(false)
    expect(registry.has('meta_plan-def' as PatternId)).toBe(false)
  })

  it('re-adding the same id after dispose is legal', () => {
    const registry = newRegistry()
    const first = registry.scope()
    first.add(scopedMeta('meta_plan-abc'))
    first.dispose()
    const second = registry.scope()
    expect(() => second.add(scopedMeta('meta_plan-abc'))).not.toThrow()
    second.dispose()
  })

  it('dispose is idempotent', () => {
    const registry = newRegistry()
    const scope = registry.scope()
    scope.add(scopedMeta('meta_plan-abc'))
    scope.dispose()
    expect(() => scope.dispose()).not.toThrow()
    expect(() => scope.dispose()).not.toThrow()
    expect(registry.has('meta_plan-abc' as PatternId)).toBe(false)
  })

  it('does not throw when a pattern was already unregistered by hand', () => {
    const registry = newRegistry()
    const scope = registry.scope()
    scope.add(scopedMeta('meta_plan-abc'))
    expect(registry.unregister('meta_plan-abc' as PatternId)).toBe(true)
    expect(() => scope.dispose()).not.toThrow()
  })

  it('disposing one scope leaves another scope and the base registry untouched', () => {
    const registry = newRegistry()
    registry.register(imagePattern)
    const a = registry.scope()
    const b = registry.scope()
    a.add(scopedMeta('meta_plan-a'))
    b.add(scopedMeta('meta_plan-b'))

    a.dispose()
    expect(registry.has('meta_plan-a' as PatternId)).toBe(false)
    expect(registry.has('meta_plan-b' as PatternId)).toBe(true)
    expect(registry.has('text-to-image' as PatternId)).toBe(true)

    b.dispose()
    expect(registry.has('meta_plan-b' as PatternId)).toBe(false)
    expect(registry.has('text-to-image' as PatternId)).toBe(true)
  })

  it('a duplicate add throws and leaves nothing half-owned in the scope', () => {
    const registry = newRegistry()
    registry.register(scopedMeta('meta_plan-abc'))
    const scope = registry.scope()
    expect(() => scope.add(scopedMeta('meta_plan-abc'))).toThrow(
      /PATTERN_ALREADY_REGISTERED/,
    )
    // The failed add never entered the scope, so dispose must not remove the
    // registration that was already there.
    scope.dispose()
    expect(registry.has('meta_plan-abc' as PatternId)).toBe(true)
  })

  it('expands the `alternatives` sugar exactly as registry.add does', () => {
    const registry = newRegistry()
    const alt: Alternative<unknown, unknown> = {
      id: 'alt-fallback',
      targetPatternId: 'text-to-image' as PatternId,
      semanticsDelta: 'renders at a lower tier',
      via: { patternId: 'text-to-image' as PatternId },
    } as unknown as Alternative<unknown, unknown>
    const scope = registry.scope()
    scope.add({ ...imagePattern, alternatives: [alt] } as unknown as Pattern)

    const entry = registry.getEntry('text-to-image' as PatternId)
    expect(entry?.alternatives.map((a) => a.id)).toEqual(['alt-fallback'])
    // The sugar is stripped off the stored Pattern, as on the direct path.
    expect((entry?.pattern as { alternatives?: unknown }).alternatives).toBeUndefined()

    scope.dispose()
    expect(registry.has('text-to-image' as PatternId)).toBe(false)
  })
})
