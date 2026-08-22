// Third-party capability names have no namespace of their own. An atomic id
// IS its capability, `Capability` is open (`string & {}`), and the registry
// keys on the id — so package A's `video-concat` and package B's are one key,
// the second to load fails with PATTERN_ALREADY_REGISTERED, and neither
// manifest says anything. The registry cannot know which package is "right",
// so it does not refuse either: it warns CAPABILITY_NOT_NAMESPACED at
// registration, through the same DiagnosticsLogger as the outputs lints, for
// an atomic that is neither a first-party capability nor `<vendor>__<name>`.

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { PatternRegistry } from '../registry'
import { FIRST_PARTY_CAPABILITIES } from '../capability'
import type { DiagnosticsLogger } from '../logger'
import type { AtomicPattern } from '../pattern'
import type { PatternId } from '../foundational'

function recordingLogger() {
  const warned: string[] = []
  const errored: string[] = []
  const logger: DiagnosticsLogger = {
    warn: (message) => {
      warned.push(message)
    },
    error: (message) => {
      errored.push(message)
    },
  }
  return { logger, warned, errored }
}

// No string fields in `outputs`, so the outputs lints stay silent and every
// warning recorded below is the namespace lint's.
function atomicPattern(id: string): AtomicPattern {
  return {
    id: id as PatternId,
    kind: 'atomic',
    description: 'x',
    primary: { tool: { description: 'x', inputs: z.object({}) } },
    outputs: z.object({ ok: z.boolean() }),
  } as unknown as AtomicPattern
}

describe('register() — CAPABILITY_NOT_NAMESPACED', () => {
  it('warns for a bare third-party capability id, and still registers it', () => {
    const { logger, warned, errored } = recordingLogger()
    const registry = new PatternRegistry({ logger })

    registry.register(atomicPattern('video-concat'))

    expect(registry.get('video-concat' as PatternId)).toBeDefined()
    expect(warned).toHaveLength(1)
    expect(warned[0]).toMatch(/^\[patterns\] CAPABILITY_NOT_NAMESPACED \(video-concat\): /)
    // The line says what to do, not only what is wrong.
    expect(warned[0]).toContain('<vendor>__video-concat')
    expect(errored).toEqual([])
  })

  it('does not warn for a vendor-prefixed id', () => {
    const { logger, warned } = recordingLogger()
    const registry = new PatternRegistry({ logger })

    registry.register(atomicPattern('acme__video-concat'))

    expect(registry.get('acme__video-concat' as PatternId)).toBeDefined()
    expect(warned).toEqual([])
  })

  it('does not warn for any first-party capability', () => {
    const { logger, warned } = recordingLogger()
    const registry = new PatternRegistry({ logger })

    for (const cap of FIRST_PARTY_CAPABILITIES) registry.register(atomicPattern(cap))

    expect(registry.size()).toBe(FIRST_PARTY_CAPABILITIES.length)
    expect(warned).toEqual([])
  })

  it('a vendor prefix needs both halves', () => {
    // `__video-concat` claims no vendor and `acme__` names no capability —
    // neither is a name another package could not also pick.
    const { logger, warned } = recordingLogger()
    const registry = new PatternRegistry({ logger })

    registry.register(atomicPattern('__video-concat'))
    registry.register(atomicPattern('acme__'))

    expect(warned.map((w) => /\((.*?)\)/.exec(w)?.[1])).toEqual(['__video-concat', 'acme__'])
  })

  it('is the collision the lint predicts: two bare names are one key, two vendored names are two', () => {
    const { logger } = recordingLogger()
    const registry = new PatternRegistry({ logger })

    registry.register(atomicPattern('video-concat'))
    expect(() => registry.register(atomicPattern('video-concat'))).toThrow(
      /PATTERN_ALREADY_REGISTERED: video-concat/,
    )

    registry.register(atomicPattern('acme__video-concat'))
    registry.register(atomicPattern('bravo__video-concat'))
    expect(registry.get('acme__video-concat' as PatternId)).toBeDefined()
    expect(registry.get('bravo__video-concat' as PatternId)).toBeDefined()
  })

  it('only atomics are linted — a meta or agent id carries its kind, not a capability', () => {
    const { logger, warned } = recordingLogger()
    const registry = new PatternRegistry({ logger })

    registry.register({
      id: 'meta_video-concat' as PatternId,
      kind: 'meta',
      description: 'm',
      tool: { description: 'm', inputs: z.object({}) },
      outputs: z.object({ ok: z.boolean() }),
      compose: async () => ({ ok: true }),
    } as unknown as AtomicPattern)

    expect(warned).toEqual([])
  })

  it('the first-party list has no duplicates (the type-level check pins it to the union)', () => {
    expect(new Set(FIRST_PARTY_CAPABILITIES).size).toBe(FIRST_PARTY_CAPABILITIES.length)
    expect(FIRST_PARTY_CAPABILITIES).toContain('text-to-image')
  })
})
