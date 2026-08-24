// The id ↔ kind naming contract is enforced on BOTH ways into the registry.
//
// `addFromManifest` has always checked it (manifest.ts's `.refine`), but
// `register()` — the path first-party factories and any hand-wired Pattern take
// — did not. That mattered because the prefix is not cosmetic:
// DEFAULT_SUBAGENT_BLOCKLIST and inferNamespace route on it alone, so an agent
// Pattern registered as `helper` instead of `agent_helper` was structurally
// exempt from the sub-agent recursion guard.

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { PatternRegistry } from '../registry'
import { DEFAULT_SUBAGENT_BLOCKLIST } from '../catalog'
import type { AgentPattern, AtomicPattern, MetaPattern } from '../pattern'
import type { PatternId } from '../foundational'
import { silentDiagnosticsLogger } from '../logger'

const inputs = z.object({})
const outputs = z.object({ ok: z.boolean() })

function agentPattern(id: string): AgentPattern {
  return {
    id: id as PatternId,
    kind: 'agent',
    description: 'a',
    primary: { tool: { description: 'a', inputs } },
    loop: { system: 's', toolPatternIds: [], modelTags: [] },
  } as unknown as AgentPattern
}

function metaPattern(id: string): MetaPattern {
  return {
    id: id as PatternId,
    kind: 'meta',
    description: 'm',
    tool: { description: 'm', inputs },
    outputs,
    compose: async () => ({ ok: true }),
  } as unknown as MetaPattern
}

function atomicPattern(id: string): AtomicPattern {
  return {
    id: id as PatternId,
    kind: 'atomic',
    description: 'x',
    primary: { tool: { description: 'x', inputs } },
    outputs,
  } as unknown as AtomicPattern
}

describe('register() — id carries kind', () => {
  it('refuses an agent Pattern whose id lacks the agent_ prefix', () => {
    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    expect(() => registry.register(agentPattern('helper'))).toThrow(
      /PATTERN_ID_KIND_MISMATCH/,
    )
    expect(registry.get('helper' as PatternId)).toBeUndefined()
  })

  it('refuses a meta Pattern whose id lacks the meta_ prefix', () => {
    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    expect(() => registry.register(metaPattern('storyboard'))).toThrow(
      /PATTERN_ID_KIND_MISMATCH/,
    )
  })

  it('refuses an atomic Pattern whose id carries another kind prefix', () => {
    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    expect(() => registry.register(atomicPattern('meta_text-generation'))).toThrow(
      /PATTERN_ID_KIND_MISMATCH/,
    )
    expect(() => registry.register(atomicPattern('agent_text-generation'))).toThrow(
      /PATTERN_ID_KIND_MISMATCH/,
    )
  })

  it('accepts correctly prefixed ids of every kind', () => {
    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    registry.register(agentPattern('agent_helper'))
    registry.register(metaPattern('meta_storyboard'))
    registry.register(atomicPattern('text-generation'))
    expect(registry.get('agent_helper' as PatternId)).toBeDefined()
    expect(registry.get('meta_storyboard' as PatternId)).toBeDefined()
    expect(registry.get('text-generation' as PatternId)).toBeDefined()
  })

  it('the guard closes the blocklist bypass it exists for', () => {
    // The blocklist matches on the prefix, so an unprefixed agent id would slip
    // through it. Registration now refuses to create that id in the first place.
    const unprefixed = 'helper'
    expect(
      DEFAULT_SUBAGENT_BLOCKLIST.idPrefixes.some((p) => unprefixed.startsWith(p)),
    ).toBe(false)
    expect(
      DEFAULT_SUBAGENT_BLOCKLIST.patternIds.includes(unprefixed as PatternId),
    ).toBe(false)
    expect(() => new PatternRegistry({ logger: silentDiagnosticsLogger }).register(agentPattern(unprefixed))).toThrow(
      /PATTERN_ID_KIND_MISMATCH/,
    )
  })
})
