import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { Pattern, PatternExposure } from '../pattern'
import { resolveDispatchTarget } from '../dispatch-pattern'
import { PatternRegistry } from '../registry'
import { silentDiagnosticsLogger } from '../logger'

// Slash by-id dispatch, resolved by the one resolver.
//
// A person typing `/fancy-edit` and an LLM emitting dispatch_pattern are doing
// the same thing — naming a Pattern by id — so they get the same resolver, the
// same gate (resolveExposure(...).slash, fail-closed), and the same error
// vocabulary. The second module that used to answer this surface returned
// SLASH_NOT_EXPOSED / SLASH_PATTERN_NOT_FOUND, which meant the refusal a user
// saw depended on which entry point their host had happened to call.
//
// The one thing that module did add — accepting an unqualified short name —
// survives, and now applies to every audience: it is a spelling of the id, not
// a surface.

function atomic(
  id: string,
  opts: { namespace?: string; exposure?: PatternExposure } = {},
): Pattern {
  return {
    id,
    kind: 'atomic',
    description: `do ${id}`,
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
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  for (const p of patterns) registry.register(p)
  return registry
}

describe('slash dispatch audience', () => {
  it('full id + exposure.slash:true → resolves', () => {
    const registry = buildRegistry([
      atomic('text-to-image', { exposure: { slash: true } }),
    ])
    const target = resolveDispatchTarget(
      registry,
      { pattern_id: 'text-to-image', input: { prompt: 'x' } },
      'slash',
    )
    expect('parsedInput' in target).toBe(true)
    if ('parsedInput' in target) expect(target.pattern.id).toBe('text-to-image')
  })

  it('unqualified short name → resolves to the canonical full id', () => {
    // Prefixed id so the short name (fancy-edit) differs from the full id.
    const registry = buildRegistry([
      atomic('image-gen/fancy-edit', {
        namespace: 'image-gen',
        exposure: { slash: true },
      }),
    ])
    const target = resolveDispatchTarget(
      registry,
      { pattern_id: 'fancy-edit', input: { prompt: 'x' } },
      'slash',
    )
    expect('parsedInput' in target).toBe(true)
    if ('parsedInput' in target) {
      expect(target.pattern.id).toBe('image-gen/fancy-edit')
    }
  })

  it('short-name resolution is a spelling of the id, so every audience gets it', () => {
    const registry = buildRegistry([
      atomic('image-gen/fancy-edit', {
        namespace: 'image-gen',
        exposure: { chatTurn: true },
      }),
    ])
    const target = resolveDispatchTarget(
      registry,
      { pattern_id: 'fancy-edit', input: { prompt: 'x' } },
      'chat-turn',
    )
    expect('parsedInput' in target).toBe(true)
    if ('parsedInput' in target) {
      expect(target.pattern.id).toBe('image-gen/fancy-edit')
    }
  })

  it('unknown id → PATTERN_NOT_FOUND naming both spellings it tried', () => {
    const registry = buildRegistry([
      atomic('text-to-image', { exposure: { slash: true } }),
    ])
    const target = resolveDispatchTarget(
      registry,
      { pattern_id: 'no-such-pattern', input: { prompt: 'x' } },
      'slash',
    )
    expect('code' in target && target.code).toBe('PATTERN_NOT_FOUND')
    if ('code' in target && target.code === 'PATTERN_NOT_FOUND') {
      expect(target.pattern_id).toBe('no-such-pattern')
      expect(target.message).toContain('tried full id and short name')
      // find_pattern is not the discovery path for a surface where a person
      // supplies the id, so the hint must not send them there.
      expect(target.hint).not.toContain('find_pattern')
    }
  })

  it('an LLM audience still gets the find_pattern hint on a miss', () => {
    const registry = buildRegistry([atomic('text-to-image')])
    const target = resolveDispatchTarget(
      registry,
      { pattern_id: 'no-such-pattern', input: { prompt: 'x' } },
      'chat-turn',
    )
    expect('code' in target && target.code).toBe('PATTERN_NOT_FOUND')
    if ('code' in target && target.code === 'PATTERN_NOT_FOUND') {
      expect(target.hint).toContain('find_pattern')
    }
  })

  it('slash is fail-closed: default, shorthand and explicit false all refuse', () => {
    for (const exposure of [
      undefined,
      'tool' as const,
      { chatTurn: true, slash: false } as const,
    ]) {
      const registry = buildRegistry([atomic('text-to-image', { exposure })])
      const target = resolveDispatchTarget(
        registry,
        { pattern_id: 'text-to-image', input: { prompt: 'x' } },
        'slash',
      )
      expect('code' in target && target.code).toBe('PATTERN_NOT_DISPATCHABLE')
      if ('code' in target && target.code === 'PATTERN_NOT_DISPATCHABLE') {
        expect(target.audience).toBe('slash')
        expect(target.hint).toContain('exposure.slash')
      }
    }
  })

  it('still validates input for the slash audience', () => {
    const registry = buildRegistry([
      atomic('text-to-image', { exposure: { slash: true } }),
    ])
    const target = resolveDispatchTarget(
      registry,
      { pattern_id: 'text-to-image', input: {} },
      'slash',
    )
    expect('code' in target && target.code).toBe('INPUT_VALIDATION_FAILED')
  })
})
