import { describe, it, expect } from 'vitest'
import { countAgentAncestors } from '../inline'
import type { Pattern, PatternId } from '@orchestral/core'

function makeKindLookup(kinds: Record<string, Pattern['kind']>) {
  return {
    get: (id: PatternId) =>
      (id in kinds ? ({ id, kind: kinds[id] } as Pattern) : undefined),
  }
}

describe('countAgentAncestors', () => {
  it('只数 agent 祖先,忽略 meta/atomic', () => {
    const reg = makeKindLookup({
      agent_orchestrator: 'agent', meta_idea2video: 'meta',
      meta_script2video: 'meta', 'text-to-image': 'atomic',
    })
    const visited = new Set<PatternId>([
      'agent_orchestrator', 'meta_idea2video', 'meta_script2video', 'text-to-image',
    ] as PatternId[])
    expect(countAgentAncestors(visited, reg)).toBe(1)
  })
  it('多个 agent 祖先正确计数', () => {
    const reg = makeKindLookup({ a1: 'agent', a2: 'agent', m: 'meta' })
    expect(countAgentAncestors(new Set(['a1', 'm', 'a2'] as PatternId[]), reg)).toBe(2)
  })
  it('registry 未命中的 id 不计入', () => {
    const reg = makeKindLookup({ a1: 'agent' })
    expect(countAgentAncestors(new Set(['a1', 'ghost'] as PatternId[]), reg)).toBe(1)
  })
})
