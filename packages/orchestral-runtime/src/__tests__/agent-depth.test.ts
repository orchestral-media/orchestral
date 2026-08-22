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
  it('counts agent ancestors only, ignoring meta/atomic', () => {
    const reg = makeKindLookup({
      agent_orchestrator: 'agent', meta_storyboard: 'meta',
      'meta_image-best-of-n': 'meta', 'text-to-image': 'atomic',
    })
    const visited = new Set<PatternId>([
      'agent_orchestrator', 'meta_storyboard', 'meta_image-best-of-n', 'text-to-image',
    ] as PatternId[])
    expect(countAgentAncestors(visited, reg)).toBe(1)
  })
  it('counts multiple agent ancestors', () => {
    const reg = makeKindLookup({ a1: 'agent', a2: 'agent', m: 'meta' })
    expect(countAgentAncestors(new Set(['a1', 'm', 'a2'] as PatternId[]), reg)).toBe(2)
  })
  it('an id the registry does not know is not counted', () => {
    const reg = makeKindLookup({ a1: 'agent' })
    expect(countAgentAncestors(new Set(['a1', 'ghost'] as PatternId[]), reg)).toBe(1)
  })
})
