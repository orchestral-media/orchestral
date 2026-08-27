import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { buildAgentInlineCore } from '../inline'
import type { Pattern, PatternId } from '@orchestral/core'

function reg(patterns: Pattern[]) {
  const m = new Map(patterns.map((p) => [p.id, p]))
  return { get: (id: PatternId) => m.get(id) }
}
const t2i = { id: 'text-to-image', kind: 'atomic', exposureMode: 'always-load',
  primary: { tool: { description: 't2i', inputs: z.object({ prompt: z.string() }) } },
  outputs: z.object({}) } as unknown as Pattern
const storyboardMeta = { id: 'meta_storyboard', kind: 'meta', exposureMode: 'always-load',
  tool: { description: 'storyboard', inputs: z.object({ scene: z.string() }) },
  outputs: z.object({}), compose: async () => ({}) } as unknown as Pattern
const plainMeta = { id: 'meta_plain', kind: 'meta',
  tool: { description: 'x', inputs: z.object({}) }, outputs: z.object({}), compose: async () => ({}) } as unknown as Pattern
const agentToolAtomic = { id: 'video-to-frames', kind: 'atomic', exposure: 'agent-tool', exposureMode: 'always-load',
  primary: { tool: { description: 'split a video into frames', inputs: z.object({ handle: z.string() }) } },
  outputs: z.object({}) } as unknown as Pattern
const hostOnlyAtomic = { id: 'data-migration', kind: 'atomic', exposure: 'no-tool', exposureMode: 'always-load',
  primary: { tool: { description: 'host-direct only', inputs: z.object({}) } },
  outputs: z.object({}) } as unknown as Pattern
// A blocklisted (agent_-prefixed) always-load pattern WITH a primary surface —
// exactly what buildAlwaysLoadDescriptors renders as an inline tool. This is
// the shape agent_orchestrator itself has, so an author who lists a shipped
// agent in loop.toolPatternIds hits this path.
const nestedAgent = { id: 'agent_inner', kind: 'agent', exposureMode: 'always-load',
  primary: { tool: { description: 'a nested agent', inputs: z.object({ prompt: z.string() }) } },
  loop: { system: 'sys', toolPatternIds: [], modelTags: [] } } as unknown as Pattern

describe('buildAgentInlineCore', () => {
  it('renders only the allowlisted always-load patterns as direct tools, returning the inline tools plus the ids to exclude', () => {
    const r = buildAgentInlineCore(
      ['text-to-image', 'meta_storyboard', 'meta_plain'] as PatternId[],
      reg([t2i, storyboardMeta, plainMeta]),
      'agent_test' as PatternId,
    )
    expect(r.descriptors.map((d) => d.name).sort()).toEqual(['meta_storyboard', 'text-to-image'])
    expect([...r.inlineIds].sort()).toEqual(['meta_storyboard', 'text-to-image'])
  })
  it('an always-load pattern outside the allowlist is not inlined (scope is the allowlist only)', () => {
    const r = buildAgentInlineCore(
      ['meta_plain'] as PatternId[],
      reg([t2i, storyboardMeta, plainMeta]),
      'agent_test' as PatternId,
    )
    expect(r.descriptors).toHaveLength(0)
  })
  it("inlines an exposure:'agent-tool' pattern — this catalog is the agent loop's, not chat-turn's", () => {
    const r = buildAgentInlineCore(
      ['video-to-frames'] as PatternId[],
      reg([agentToolAtomic]),
      'agent_test' as PatternId,
    )
    expect(r.descriptors.map((d) => d.name)).toEqual(['video-to-frames'])
    expect([...r.inlineIds]).toEqual(['video-to-frames'])
  })
  it("does not inline an exposure:'no-tool' pattern even when the allowlist names it and it is always-load", () => {
    const r = buildAgentInlineCore(
      ['data-migration'] as PatternId[],
      reg([hostOnlyAtomic]),
      'agent_test' as PatternId,
    )
    expect(r.descriptors).toHaveLength(0)
    expect(r.inlineIds.size).toBe(0)
  })
  it('throws, naming every absent id, when the allowlist references a pattern the registry does not have', () => {
    // Skipping them silently shrank the tool catalog while the agent's system
    // prompt kept instructing the LLM to use what was no longer there — the
    // model then spends the run discovering that by trial. The allowlist is
    // the author's declaration; a registry that cannot satisfy it is a host
    // wiring bug, and the only place it is still nameable is here.
    let thrown: unknown
    try {
      buildAgentInlineCore(
        ['text-to-image', 'meta_absent', 'meta_also_absent'] as PatternId[],
        reg([t2i]),
        'agent_test' as PatternId,
      )
      expect.unreachable('buildAgentInlineCore must not accept an unsatisfiable allowlist')
    } catch (err) {
      thrown = err
    }
    expect((thrown as { code?: string }).code).toBe('AGENT_TOOL_PATTERN_NOT_REGISTERED')
    const message = (thrown as Error).message
    // Both absent ids, not just the first: a host fixing them one per run is a
    // host reading a bad error.
    expect(message).toContain('meta_absent')
    expect(message).toContain('meta_also_absent')
    // And who declared them — the allowlist belongs to a pattern.
    expect(message).toContain('agent_test')
    // The satisfiable id is not what the error is about.
    expect(message).not.toContain('text-to-image')
  })
  it('drops a blocklisted id from the inline core rather than advertising a tool every call refuses', () => {
    // The blocklist is the one rule, and listing an id past it changes
    // nothing — the same stance computeStaticAgentExcludes takes for the
    // find_pattern corpus. Without this, an allowlisted `agent_*` reached the
    // model as an inline tool that onToolCall then answered with
    // SUBAGENT_BLOCKED: the catalog and the call side have to say the same
    // sentence.
    const r = buildAgentInlineCore(
      ['text-to-image', 'agent_inner'] as PatternId[],
      reg([t2i, nestedAgent]),
      'agent_test' as PatternId,
    )
    expect(r.descriptors.map((d) => d.name)).toEqual(['text-to-image'])
    expect([...r.inlineIds]).toEqual(['text-to-image'])
  })
  it('does not report a blocklisted id as unregistered — the blocklist judges the id, not the registry', () => {
    // Judged before the lookup, so the missing-id error never tells a host to
    // register something that would be refused at every call anyway. A
    // blocklisted id is an authoring no-op, not a wiring bug the host can fix.
    expect(() =>
      buildAgentInlineCore(
        ['agent_never_registered'] as PatternId[],
        reg([t2i]),
        'agent_test' as PatternId,
      ),
    ).not.toThrow()
  })
})
