import { describe, expect, it } from 'vitest'

import type { Capability } from '../capability'
import type { ModelCapability, ModelCapabilityRecord } from '../capability-model'
import type { ModelTag } from '../model-tag'
import {
  createDefaultCapabilityRouter,
  ModelExcludedError,
  NoModelForCapabilityError,
  type DefaultCapabilityRouterDeps,
} from '../capability-router-default'

// In-memory stubs for the two seams a host injects. `getModels` returns the
// wrapped envelopes for every model DECLARING a capability (no pre-filtering);
// `getCapabilityOrder` is the per-capability enablement list. The `call`
// adapter is a no-op marker — selection never invokes it.

interface ModelSpec {
  provider: string
  modelId: string
  capabilities: readonly Capability[]
  tags?: readonly ModelTag[]
  tier?: 'fast' | 'balanced' | 'premium'
}

function envelope(spec: ModelSpec): ModelCapability {
  const record: ModelCapabilityRecord = {
    modelId: spec.modelId,
    provider: spec.provider,
    capabilities: spec.capabilities,
    tags: spec.tags ?? [],
    inputs: ['text'],
    outputs: ['text'],
    tier: spec.tier,
    source: 'user',
  }
  return {
    ...record,
    async call() {
      throw new Error('call should not be invoked by routing tests')
    },
  }
}

function makeRouter(
  models: ModelSpec[],
  order?: Record<string, readonly string[]>,
) {
  const deps: DefaultCapabilityRouterDeps = {
    getModels: (cap) =>
      models.filter((m) => m.capabilities.includes(cap)).map(envelope),
    ...(order
      ? { getCapabilityOrder: (cap: Capability) => order[cap] }
      : {}),
  }
  return createDefaultCapabilityRouter(deps)
}

const CAP: Capability = 'text-generation'

describe('default capability router', () => {
  describe('pinnedModel', () => {
    it('resolves a pinned model that is a candidate', () => {
      const router = makeRouter([
        { provider: 'p', modelId: 'a', capabilities: [CAP] },
        { provider: 'p', modelId: 'b', capabilities: [CAP] },
      ])
      const res = router.resolve(CAP, [], { pinnedModel: 'p:b' })
      expect(`${res.provider}:${res.modelId}`).toBe('p:b')
    })

    it('pin bypasses the enablement order (enablement by selection)', () => {
      const router = makeRouter(
        [
          { provider: 'p', modelId: 'a', capabilities: [CAP] },
          { provider: 'p', modelId: 'b', capabilities: [CAP] },
        ],
        { [CAP]: ['p:a'] },
      )
      const res = router.resolve(CAP, [], { pinnedModel: 'p:b' })
      expect(`${res.provider}:${res.modelId}`).toBe('p:b')
    })

    it('throws ModelExcludedError when the pin is not among candidates', () => {
      const router = makeRouter([
        { provider: 'p', modelId: 'a', capabilities: [CAP] },
      ])
      let thrown: unknown
      try {
        router.resolve(CAP, [], { pinnedModel: 'p:ghost', rankedModels: ['p:a'] })
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(ModelExcludedError)
      expect((thrown as ModelExcludedError).code).toBe('MODEL_EXCLUDED')
      expect((thrown as ModelExcludedError).modelStr).toBe('p:ghost')
    })
  })

  describe('ranked ordering', () => {
    it('resolves to the head of the ranked order, ignoring declaration order', () => {
      const router = makeRouter([
        { provider: 'p', modelId: 'a', capabilities: [CAP] },
        { provider: 'p', modelId: 'b', capabilities: [CAP] },
      ])
      const res = router.resolve(CAP, [], { rankedModels: ['p:b', 'p:a'] })
      expect(`${res.provider}:${res.modelId}`).toBe('p:b')
    })

    it('restricts candidates to the ranked set', () => {
      const router = makeRouter([
        { provider: 'p', modelId: 'a', capabilities: [CAP] },
        { provider: 'p', modelId: 'b', capabilities: [CAP] },
      ])
      const sat = router.checkSatisfiable(CAP, [], { rankedModels: ['p:b'] })
      expect(sat.ok).toBe(true)
      if (sat.ok) {
        expect(sat.candidates.map((c) => `${c.provider}:${c.modelId}`)).toEqual([
          'p:b',
        ])
      }
    })

    it('the stored enablement order ranks an un-pinned / un-ranked caller', () => {
      const router = makeRouter(
        [
          { provider: 'p', modelId: 'a', capabilities: [CAP] },
          { provider: 'p', modelId: 'b', capabilities: [CAP] },
        ],
        { [CAP]: ['p:b', 'p:a'] },
      )
      const res = router.resolve(CAP, [], {})
      expect(`${res.provider}:${res.modelId}`).toBe('p:b')
    })
  })

  describe('preferProvider / tier selection', () => {
    it('prefers a provider when one matches', () => {
      const router = makeRouter([
        { provider: 'p', modelId: 'a', capabilities: [CAP] },
        { provider: 'q', modelId: 'b', capabilities: [CAP] },
      ])
      const res = router.resolve(CAP, [], { preferProvider: 'q' })
      expect(res.provider).toBe('q')
    })

    it('selects a tier match when present', () => {
      const router = makeRouter([
        { provider: 'p', modelId: 'a', capabilities: [CAP], tier: 'fast' },
        { provider: 'p', modelId: 'b', capabilities: [CAP], tier: 'premium' },
      ])
      const res = router.resolve(CAP, [], { tier: 'premium' })
      expect(res.modelId).toBe('b')
    })
  })

  describe('exclusion filtering', () => {
    it('excludeModel drops a candidate', () => {
      const router = makeRouter([
        { provider: 'p', modelId: 'a', capabilities: [CAP] },
        { provider: 'p', modelId: 'b', capabilities: [CAP] },
      ])
      const res = router.resolve(CAP, [], { excludeModel: ['p:a'] })
      expect(res.modelId).toBe('b')
    })

    it("every candidate excluded → 'all-excluded'", () => {
      const router = makeRouter([
        { provider: 'p', modelId: 'a', capabilities: [CAP] },
      ])
      const sat = router.checkSatisfiable(CAP, [], { excludeModel: ['p:a'] })
      expect(sat.ok).toBe(false)
      if (!sat.ok) expect(sat.reason).toBe('all-excluded')
    })
  })

  describe('diagnosis', () => {
    it("required tag not borne by any model → 'tag-mismatch'", () => {
      const router = makeRouter([
        { provider: 'p', modelId: 'a', capabilities: [CAP], tags: ['fast'] },
      ])
      const sat = router.checkSatisfiable(CAP, ['premium'], {})
      expect(sat.ok).toBe(false)
      if (!sat.ok) expect(sat.reason).toBe('tag-mismatch')
    })

    it('tier is best-effort: a tier with no match still satisfies and falls through', () => {
      // listCandidates never filters by tier (only resolve()'s best-effort
      // selection does), so a non-empty post-rank/exclude/tag set keeps
      // checkSatisfiable ok:true. 'tier-mismatch' is therefore only the
      // narrowest diagnosis when the set was ALSO empty for another reason —
      // it never surfaces while candidates remain. Mirrors host router.
      const router = makeRouter([
        { provider: 'p', modelId: 'a', capabilities: [CAP], tier: 'fast' },
      ])
      const sat = router.checkSatisfiable(CAP, [], { tier: 'premium' })
      expect(sat.ok).toBe(true)
      // resolve falls through to candidates[0] when no tier matches.
      expect(router.resolve(CAP, [], { tier: 'premium' }).modelId).toBe('a')
    })

    it("capable rows but enablement order is empty → 'not-enabled'", () => {
      const router = makeRouter(
        [{ provider: 'p', modelId: 'a', capabilities: [CAP] }],
        { [CAP]: [] },
      )
      const sat = router.checkSatisfiable(CAP, [], {})
      expect(sat.ok).toBe(false)
      if (!sat.ok) expect(sat.reason).toBe('not-enabled')

      let thrown: unknown
      try {
        router.resolve(CAP, [], {})
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(NoModelForCapabilityError)
      const err = thrown as NoModelForCapabilityError
      expect(err.code).toBe('NO_MODEL_FOR_CAPABILITY')
      expect(err.reason).toBe('not-enabled')
      expect(err.message).toContain('getCapabilityOrder')
      // Host remedy override: the 4th constructor param REPLACES the default
      // clause (single format source — no doubled remedies).
      const custom = new NoModelForCapabilityError(
        err.cap,
        err.requiredTags,
        err.reason,
        ' — custom host remedy',
      )
      expect(custom.message).toContain(' — custom host remedy')
      expect(custom.message).not.toContain('getCapabilityOrder')
      expect(err.message).not.toContain('add one to your getModels source')
    })

    it("host shape: missing key returns [] → 'not-enabled' (fresh-install gate)", () => {
      // The real host seam (readCapabilityOrder) returns [] — never undefined —
      // for a key it has no entry for. An empty array IS the enablement gate:
      // capable rows exist but none enabled. (A genuine `undefined` instead
      // means "no gate"; that's the separate suite below.)
      const router = makeRouter(
        [{ provider: 'p', modelId: 'a', capabilities: [CAP] }],
        { 'text-to-image': ['p:img'] }, // CAP has no entry → stub returns undefined…
      )
      // …so emulate the host's [] default explicitly for this assertion:
      const hostShaped = createDefaultCapabilityRouter({
        getModels: () => [
          {
            modelId: 'a',
            provider: 'p',
            capabilities: [CAP],
            tags: [],
            inputs: ['text'],
            outputs: ['text'],
            source: 'user',
            async call() {
              throw new Error('unused')
            },
          },
        ],
        getCapabilityOrder: () => [], // missing key → [] (host shape)
      })
      const sat = hostShaped.checkSatisfiable(CAP, [], {})
      expect(sat.ok).toBe(false)
      if (!sat.ok) expect(sat.reason).toBe('not-enabled')
      // And confirm the contrast: when the dep genuinely returns undefined
      // for CAP, the gate is OFF and the same catalog resolves.
      expect(router.checkSatisfiable(CAP, [], {}).ok).toBe(true)
    })

    it("no model declares the capability → 'no-model-in-catalog'", () => {
      const router = makeRouter([
        { provider: 'p', modelId: 'a', capabilities: ['text-to-image'] },
      ])
      const sat = router.checkSatisfiable(CAP, [], {})
      expect(sat.ok).toBe(false)
      if (!sat.ok) expect(sat.reason).toBe('no-model-in-catalog')
      expect(() => router.resolve(CAP, [], {})).toThrow(
        /add one to your getModels source/,
      )
    })

    it("empty catalog → 'no-model-in-catalog' even with an enablement order", () => {
      const router = makeRouter([], { [CAP]: ['p:a'] })
      const sat = router.checkSatisfiable(CAP, [], {})
      expect(sat.ok).toBe(false)
      if (!sat.ok) expect(sat.reason).toBe('no-model-in-catalog')
    })

    it("caller-supplied rankedModels filtering to zero → 'no-model-in-catalog', not 'not-enabled'", () => {
      const router = makeRouter(
        [{ provider: 'p', modelId: 'a', capabilities: [CAP] }],
        { [CAP]: ['p:a'] },
      )
      const sat = router.checkSatisfiable(CAP, [], {
        rankedModels: ['p:nonexistent'],
      })
      expect(sat.ok).toBe(false)
      if (!sat.ok) expect(sat.reason).toBe('no-model-in-catalog')
    })
  })

  describe('no enablement gate (getCapabilityOrder omitted)', () => {
    it('un-pinned / un-ranked caller stays unrestricted and resolves', () => {
      const router = makeRouter([
        { provider: 'p', modelId: 'a', capabilities: [CAP] },
      ])
      const res = router.resolve(CAP, [], {})
      expect(res.modelId).toBe('a')
    })
  })
})
