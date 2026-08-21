import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { Pattern, PatternExposure } from '../pattern'
import { PatternRegistry } from '../registry'
import { resolveSlashDispatch } from '../slash-dispatch'

// Slash by-id dispatch resolution. Gate is
// resolveExposure(pattern.exposure).slash; default first-party exposure
// ('tool' / undefined) has slash:false so everything is fail-closed until a
// Pattern explicitly opts in.

function atomic(
  id: string,
  opts: { namespace?: string; exposure?: PatternExposure } = {},
): Pattern {
  return {
    id,
    kind: 'atomic',
    ...(opts.namespace ? { namespace: opts.namespace } : {}),
    ...(opts.exposure !== undefined ? { exposure: opts.exposure } : {}),
    primary: {
      tool: {
        description: `do ${id}`,
        inputs: z.object({ prompt: z.string() }),
      },
    },
    outputs: z.object({ modality: z.literal('image') }),
  } as unknown as Pattern
}

function buildRegistry(patterns: Pattern[]): PatternRegistry {
  const registry = new PatternRegistry()
  for (const p of patterns) registry.register(p)
  return registry
}

describe('resolveSlashDispatch', () => {
  it('full id hit + exposure.slash:true → ok with the same full id', () => {
    const registry = buildRegistry([
      atomic('text-to-image', { exposure: { slash: true } }),
    ])
    const res = resolveSlashDispatch(registry, 'text-to-image')
    expect(res).toEqual({ ok: true, fullId: 'text-to-image' })
  })

  it('short-name hit → resolves to the canonical full id', () => {
    // Prefixed id so the short name (fancy-edit) differs from the full id.
    const registry = buildRegistry([
      atomic('image-gen/fancy-edit', {
        namespace: 'image-gen',
        exposure: { slash: true },
      }),
    ])
    const res = resolveSlashDispatch(registry, 'fancy-edit')
    expect(res).toEqual({ ok: true, fullId: 'image-gen/fancy-edit' })
  })

  it('unknown id → SLASH_PATTERN_NOT_FOUND', () => {
    const registry = buildRegistry([
      atomic('text-to-image', { exposure: { slash: true } }),
    ])
    const res = resolveSlashDispatch(registry, 'no-such-pattern')
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected error')
    expect(res.error.code).toBe('SLASH_PATTERN_NOT_FOUND')
    expect(res.error.patternId).toBe('no-such-pattern')
  })

  it('hit but exposure.slash defaults false → SLASH_NOT_EXPOSED', () => {
    // No exposure declared = 'tool' default = slash:false (fail-closed).
    const registry = buildRegistry([atomic('text-to-image')])
    const res = resolveSlashDispatch(registry, 'text-to-image')
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected error')
    expect(res.error.code).toBe('SLASH_NOT_EXPOSED')
    expect(res.error.patternId).toBe('text-to-image')
  })

  it("'tool' shorthand exposure → still slash:false → SLASH_NOT_EXPOSED", () => {
    const registry = buildRegistry([
      atomic('text-to-image', { exposure: 'tool' }),
    ])
    const res = resolveSlashDispatch(registry, 'text-to-image')
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected error')
    expect(res.error.code).toBe('SLASH_NOT_EXPOSED')
  })

  it('object exposure with slash:false explicitly → SLASH_NOT_EXPOSED', () => {
    const registry = buildRegistry([
      atomic('text-to-image', { exposure: { chatTurn: true, slash: false } }),
    ])
    const res = resolveSlashDispatch(registry, 'text-to-image')
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected error')
    expect(res.error.code).toBe('SLASH_NOT_EXPOSED')
  })
})
