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

describe('buildAgentInlineCore', () => {
  it('renders only the allowlisted always-load patterns as direct tools, returning the inline tools plus the ids to exclude', () => {
    const r = buildAgentInlineCore(
      ['text-to-image', 'meta_storyboard', 'meta_plain'] as PatternId[],
      reg([t2i, storyboardMeta, plainMeta]),
    )
    expect(r.descriptors.map((d) => d.name).sort()).toEqual(['meta_storyboard', 'text-to-image'])
    expect([...r.inlineIds].sort()).toEqual(['meta_storyboard', 'text-to-image'])
  })
  it('an always-load pattern outside the allowlist is not inlined (scope is the allowlist only)', () => {
    const r = buildAgentInlineCore(['meta_plain'] as PatternId[], reg([t2i, storyboardMeta, plainMeta]))
    expect(r.descriptors).toHaveLength(0)
  })
  it("inlines an exposure:'agent-tool' pattern — this catalog is the agent loop's, not chat-turn's", () => {
    const r = buildAgentInlineCore(['video-to-frames'] as PatternId[], reg([agentToolAtomic]))
    expect(r.descriptors.map((d) => d.name)).toEqual(['video-to-frames'])
    expect([...r.inlineIds]).toEqual(['video-to-frames'])
  })
  it("does not inline an exposure:'no-tool' pattern even when the allowlist names it and it is always-load", () => {
    const r = buildAgentInlineCore(['data-migration'] as PatternId[], reg([hostOnlyAtomic]))
    expect(r.descriptors).toHaveLength(0)
    expect(r.inlineIds.size).toBe(0)
  })
})
