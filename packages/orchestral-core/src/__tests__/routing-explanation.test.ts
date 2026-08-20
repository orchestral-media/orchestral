import { describe, expect, it } from 'vitest'

import type { Capability } from '../capability'
import type { ModelCapability } from '../capability-model'
import type { ModelTag } from '../model-tag'
import { createDefaultCapabilityRouter } from '../capability-router-default'
import {
  formatRoutingExplanation,
  type RoutingCandidate,
} from '../routing-explanation'

// Unlike the routing suite's stub, `getModels` here returns EVERY model
// unfiltered — that is what exercises the 'capability-not-declared' stage, and
// the seam is documented as "models that declare cap", not "models the router
// may assume declare it".

interface ModelSpec {
  provider: string
  modelId: string
  capabilities: readonly Capability[]
  tags?: readonly ModelTag[]
  tier?: 'fast' | 'balanced' | 'premium'
}

function envelope(spec: ModelSpec): ModelCapability {
  return {
    modelId: spec.modelId,
    provider: spec.provider,
    capabilities: spec.capabilities,
    tags: spec.tags ?? [],
    inputs: ['text'],
    outputs: ['text'],
    tier: spec.tier,
    source: 'user',
    async call() {
      throw new Error('call should not be invoked by explain')
    },
  }
}

function makeRouter(
  models: readonly ModelSpec[],
  order?: Record<string, readonly string[]>,
) {
  return createDefaultCapabilityRouter({
    getModels: () => models.map(envelope),
    ...(order ? { getCapabilityOrder: (cap: Capability) => order[cap] } : {}),
  })
}

const CAP: Capability = 'text-generation'

function drop(
  candidates: readonly RoutingCandidate[],
  model: string,
): string | undefined {
  const found = candidates.find((c) => c.model === model)
  return found && !found.kept ? found.droppedBy : undefined
}

describe('CapabilityRouter.explain', () => {
  it('annotates every candidate with the filter that dropped it', () => {
    const router = makeRouter(
      [
        { provider: 'p', modelId: 'a', capabilities: [CAP] },
        { provider: 'q', modelId: 'b', capabilities: [CAP] },
        { provider: 'p', modelId: 'stale', capabilities: [CAP] },
        { provider: 'p', modelId: 'unlisted', capabilities: [CAP] },
        { provider: 'p', modelId: 'img', capabilities: ['text-to-image'] },
      ],
      { [CAP]: ['q:b', 'p:a', 'p:stale'] },
    )

    const explanation = router.explain!(CAP, [], {
      excludeModel: ['p:stale'],
      preferProvider: 'q',
    })

    expect(explanation.satisfiable).toBe(true)
    // Enablement order ranks the survivors — q:b before p:a, not declaration order.
    expect(explanation.order).toEqual(['q:b', 'p:a'])
    expect(explanation.enablementDefaulted).toBe(true)
    expect(explanation.candidates).toHaveLength(5)
    expect(drop(explanation.candidates, 'p:stale')).toBe('excluded-model')
    // Outside the stored enablement order, and the caller neither pinned nor
    // ranked — so the gate, not the caller, dropped it.
    expect(drop(explanation.candidates, 'p:unlisted')).toBe('not-enabled')
    expect(drop(explanation.candidates, 'p:img')).toBe('capability-not-declared')
    expect(explanation.outcome).toEqual({
      kind: 'selected',
      model: 'q:b',
      by: 'preferred-provider',
    })
  })

  it("caller-supplied rankedModels drops report 'not-ranked', not 'not-enabled'", () => {
    const router = makeRouter([
      { provider: 'p', modelId: 'a', capabilities: [CAP] },
      { provider: 'p', modelId: 'b', capabilities: [CAP] },
    ])
    const explanation = router.explain!(CAP, [], { rankedModels: ['p:b'] })
    expect(drop(explanation.candidates, 'p:a')).toBe('not-ranked')
    expect(explanation.enablementDefaulted).toBe(false)
    expect(explanation.outcome).toEqual({
      kind: 'selected',
      model: 'p:b',
      by: 'first-candidate',
    })
  })

  it('a requested tier that matches selects by tier; one that matches nothing falls through', () => {
    const router = makeRouter([
      { provider: 'p', modelId: 'fast', capabilities: [CAP], tier: 'fast' },
      { provider: 'p', modelId: 'slow', capabilities: [CAP], tier: 'premium' },
    ])
    expect(router.explain!(CAP, [], { tier: 'premium' }).outcome).toEqual({
      kind: 'selected',
      model: 'p:slow',
      by: 'tier',
    })
    // Tier never eliminates: both stay candidates and selection falls through.
    const noMatch = router.explain!(CAP, [], { tier: 'balanced' })
    expect(noMatch.order).toEqual(['p:fast', 'p:slow'])
    expect(noMatch.outcome).toEqual({
      kind: 'selected',
      model: 'p:fast',
      by: 'first-candidate',
    })
  })

  it('reports the unavailability reason when nothing survives', () => {
    const tagged = makeRouter([
      { provider: 'p', modelId: 'a', capabilities: [CAP], tags: ['fast'] },
    ])
    const byTag = tagged.explain!(CAP, ['premium'])
    expect(byTag.satisfiable).toBe(false)
    expect(byTag.order).toEqual([])
    expect(byTag.outcome).toEqual({ kind: 'no-candidate', reason: 'tag-mismatch' })
    expect(drop(byTag.candidates, 'p:a')).toBe('tag-mismatch')

    const unenabled = makeRouter(
      [{ provider: 'p', modelId: 'a', capabilities: [CAP] }],
      { [CAP]: [] },
    )
    expect(unenabled.explain!(CAP).outcome).toEqual({
      kind: 'no-candidate',
      reason: 'not-enabled',
    })

    const empty = makeRouter([])
    expect(empty.explain!(CAP).outcome).toEqual({
      kind: 'no-candidate',
      reason: 'no-model-in-catalog',
    })
  })

  it('a pin outside the candidate set is satisfiable but unresolvable', () => {
    const router = makeRouter([
      { provider: 'p', modelId: 'a', capabilities: [CAP] },
      { provider: 'p', modelId: 'b', capabilities: [CAP] },
    ])
    const explanation = router.explain!(CAP, [], {
      pinnedModel: 'p:b',
      excludeModel: ['p:b'],
    })
    expect(explanation.satisfiable).toBe(true)
    expect(explanation.outcome).toEqual({
      kind: 'pin-excluded',
      pinnedModel: 'p:b',
      excludedByRetry: true,
    })
  })

  it('agrees with resolve / checkSatisfiable on the same arguments', () => {
    const router = makeRouter(
      [
        { provider: 'p', modelId: 'a', capabilities: [CAP] },
        { provider: 'q', modelId: 'b', capabilities: [CAP] },
      ],
      { [CAP]: ['q:b', 'p:a'] },
    )
    const ctx = { excludeModel: ['q:b'] }
    const explanation = router.explain!(CAP, [], ctx)
    const resolved = router.resolve(CAP, [], ctx)
    expect(explanation.outcome).toEqual({
      kind: 'selected',
      model: `${resolved.provider}:${resolved.modelId}`,
      by: 'first-candidate',
    })
    const sat = router.checkSatisfiable(CAP, [], ctx)
    expect(sat.ok).toBe(explanation.satisfiable)
    expect(sat.candidates.map((c) => `${c.provider}:${c.modelId}`)).toEqual(
      explanation.order,
    )
  })
})

describe('formatRoutingExplanation', () => {
  it('renders the decision as printable lines', () => {
    const router = makeRouter(
      [
        { provider: 'p', modelId: 'a', capabilities: [CAP], tags: ['fast'] },
        {
          provider: 'q',
          modelId: 'b',
          capabilities: [CAP],
          tags: ['fast'],
          tier: 'premium',
        },
        { provider: 'p', modelId: 'stale', capabilities: [CAP], tags: ['fast'] },
      ],
      { [CAP]: ['q:b', 'p:a', 'p:stale'] },
    )
    const text = formatRoutingExplanation(
      router.explain!(CAP, ['fast'], { excludeModel: ['p:stale'] }),
    )
    const lines = text.split('\n')

    expect(lines[0]).toBe('routing: text-generation tags=[fast]')
    expect(lines).toContain('satisfiable: yes')
    expect(lines).toContain('resolve: q:b (by first-candidate)')
    expect(lines).toContain('context: excludeModel=[p:stale]')
    expect(lines).toContain(
      'ranking: enablement default (getCapabilityOrder) [q:b, p:a, p:stale]',
    )
    expect(lines).toContain('candidates: 2 kept of 3')
    expect(lines).toContain('  1. q:b tier=premium tags=[fast]')
    expect(lines).toContain('  2. p:a tags=[fast]')
    expect(lines).toContain('  -  p:stale tags=[fast] dropped: excluded-model')
  })

  it('renders an unroutable capability with its reason', () => {
    const router = makeRouter([])
    const text = formatRoutingExplanation(router.explain!(CAP))
    expect(text).toContain('satisfiable: no (no-model-in-catalog)')
    expect(text).toContain(
      'resolve: throws NO_MODEL_FOR_CAPABILITY (no-model-in-catalog)',
    )
    expect(text).toContain('context: (none)')
    expect(text).toContain('candidates: 0 kept of 0')
  })
})
