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
const ideaMeta = { id: 'meta_idea2video', kind: 'meta', exposureMode: 'always-load',
  tool: { description: 'idea2video', inputs: z.object({ idea: z.string() }) },
  outputs: z.object({}), compose: async () => ({}) } as unknown as Pattern
const plainMeta = { id: 'meta_plain', kind: 'meta',
  tool: { description: 'x', inputs: z.object({}) }, outputs: z.object({}), compose: async () => ({}) } as unknown as Pattern

describe('buildAgentInlineCore', () => {
  it('renders only the allowlisted always-load patterns as direct tools, returning the inline tools plus the ids to exclude', () => {
    const r = buildAgentInlineCore(
      ['text-to-image', 'meta_idea2video', 'meta_plain'] as PatternId[],
      reg([t2i, ideaMeta, plainMeta]),
    )
    expect(r.descriptors.map((d) => d.name).sort()).toEqual(['meta_idea2video', 'text-to-image'])
    expect([...r.inlineIds].sort()).toEqual(['meta_idea2video', 'text-to-image'])
  })
  it('an always-load pattern outside the allowlist is not inlined (scope is the allowlist only)', () => {
    const r = buildAgentInlineCore(['meta_plain'] as PatternId[], reg([t2i, ideaMeta, plainMeta]))
    expect(r.descriptors).toHaveLength(0)
  })
})
