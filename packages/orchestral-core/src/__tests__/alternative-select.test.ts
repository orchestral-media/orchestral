// Selecting an alternative is contract; taking one is runtime.
//
// `applicableAlternatives` / `pickAlternative` evaluate `appliesWhen` against a
// registry and a router — both core types, both core-owned vocabulary
// (whenCapabilityUnavailable / whenPreservesRequired are built here). They live
// here so that the two surfaces that report "paths not taken" — the runtime's
// ALTERNATIVES_NOT_ENABLED diagnostic and @orchestral/plan's preflight — read
// the same evaluation rather than each other's copy.

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  applicableAlternatives,
  pickAlternative,
  readRequiresSemantics,
  toAvailableAlternative,
} from '../alternative-select'
import type { Alternative } from '../alternative'
import { whenCapabilityUnavailable, whenPreservesRequired } from '../alternative-builders'
import { defineAtomicPattern } from '../atomic-pattern'
import type { Capability } from '../capability'
import type { CapabilityRouter, SatisfiableResult } from '../capability-router'
import { dispatchEnvelopeShape, producedAssetShape } from '../output-envelope'
import { PatternRegistry } from '../registry'
import { silentDiagnosticsLogger } from '../logger'

const imageToImage = defineAtomicPattern({
  id: 'image-to-image',
  description: 'Edit an image.',
  primary: {
    tool: { description: 'Edit an image.', inputs: z.object({ prompt: z.string().min(1) }) },
    modelTags: [],
  },
  outputs: z.object({
    modality: z.literal('image'),
    assets: z.array(z.object(producedAssetShape('image'))),
    ...dispatchEnvelopeShape,
  }),
})

const viaCaption: Alternative<unknown, unknown> = {
  id: 'image-to-image-via-caption',
  description: 'Caption the source, then re-render from the caption.',
  appliesWhen: whenCapabilityUnavailable(),
  via: {
    patternId: 'meta_image-to-image-via-caption',
    mapInput: (i) => i,
    mapOutput: (o) => o,
  },
  losses: ['pixel-fidelity'],
}

const identityPreserving: Alternative<unknown, unknown> = {
  id: 'keep-identity',
  description: 'A path that preserves subject identity.',
  // Variadic, not an array: `whenPreservesRequired('a', 'b')`.
  appliesWhen: whenPreservesRequired('subject-identity'),
  via: { patternId: 'text-to-image', mapInput: (i) => i, mapOutput: (o) => o },
  preserves: ['subject-identity'],
}

function routerThatSays(ok: boolean): CapabilityRouter {
  // Selection reads `.ok` and nothing else, so the candidates are stubbed to
  // the two fields that identify a model rather than to a whole
  // ModelCapabilityRecord — a full record here would assert nothing extra.
  const result = (
    ok
      ? { ok: true, candidates: [{ provider: 'mock', modelId: 'mock-image' }] }
      : { ok: false, reason: 'no-model-in-catalog', candidates: [] }
  ) as unknown as SatisfiableResult
  return {
    resolve: () => {
      throw new Error('resolve is never called by selection')
    },
    checkSatisfiable: (_cap: Capability) => result,
  } as unknown as CapabilityRouter
}

function registryWith(alternatives: readonly Alternative<unknown, unknown>[]) {
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  registry.register({ ...imageToImage, alternatives } as never)
  return registry
}

describe('applicableAlternatives', () => {
  it('returns a capability-unavailable path only when the router cannot serve', () => {
    const registry = registryWith([viaCaption])
    const unavailable = applicableAlternatives(
      { registry, router: routerThatSays(false) },
      imageToImage,
      {},
      [],
      [],
    )
    expect(unavailable.map((a) => a.id)).toEqual(['image-to-image-via-caption'])

    const available = applicableAlternatives(
      { registry, router: routerThatSays(true) },
      imageToImage,
      {},
      [],
      [],
    )
    expect(available).toEqual([])
  })

  it('matches preserves-required against what the caller asked to preserve', () => {
    const registry = registryWith([identityPreserving])
    const deps = { registry, router: routerThatSays(true) }
    expect(
      applicableAlternatives(deps, imageToImage, {}, [], ['subject-identity']).map((a) => a.id),
    ).toEqual(['keep-identity'])
    expect(applicableAlternatives(deps, imageToImage, {}, [], [])).toEqual([])
  })
})

describe('pickAlternative', () => {
  it('takes the first declared path that applies, in declaration order', () => {
    const registry = registryWith([identityPreserving, viaCaption])
    const picked = pickAlternative(
      { registry, router: routerThatSays(false) },
      imageToImage,
      {},
      [],
      ['subject-identity'],
    )
    expect(picked?.id).toBe('keep-identity')
  })

  it('is null when nothing is declared', () => {
    const registry = registryWith([])
    expect(
      pickAlternative({ registry, router: routerThatSays(false) }, imageToImage, {}, [], []),
    ).toBeNull()
  })
})

describe('toAvailableAlternative', () => {
  it('projects the reported shape, omitting a trade-off nobody declared', () => {
    expect(toAvailableAlternative(viaCaption)).toEqual({
      id: 'image-to-image-via-caption',
      description: 'Caption the source, then re-render from the caption.',
      targetPatternId: 'meta_image-to-image-via-caption',
      losses: ['pixel-fidelity'],
    })
    expect(Object.keys(toAvailableAlternative(viaCaption))).not.toContain('preserves')
  })
})

describe('readRequiresSemantics', () => {
  it('is convention, not schema — anything unusable reads as "nothing required"', () => {
    expect(readRequiresSemantics({ requiresSemantics: ['subject-identity'] })).toEqual([
      'subject-identity',
    ])
    expect(readRequiresSemantics({ requiresSemantics: 'subject-identity' })).toEqual([])
    expect(readRequiresSemantics({ requiresSemantics: [1, 'text-fidelity'] })).toEqual([
      'text-fidelity',
    ])
    expect(readRequiresSemantics(null)).toEqual([])
    expect(readRequiresSemantics('nope')).toEqual([])
  })
})
