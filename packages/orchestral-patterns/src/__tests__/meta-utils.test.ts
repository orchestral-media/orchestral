// Guards on the shared meta helpers — most importantly that one buggy
// adapter emitting a non-finite cost cannot poison every parent meta's
// aggregated envelope (the runtime does not zod-validate dispatch outputs,
// so sumCosts is the last line of defence), and that an adapter which did
// not report a cost (null) is never quietly summed past.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { auditOutputsSchema } from '@orchestral/core'
import {
  assetIdByLabel,
  firstAsset,
  labelAsset,
  labelledAssetShape,
  sumCosts,
} from '../meta/_shared/meta-utils'

describe('sumCosts', () => {
  it('sums plain costs and treats undefined as 0', () => {
    expect(sumCosts([1, 2])).toBe(3)
    expect(sumCosts([0.1, 0.2, undefined])).toBeCloseTo(0.3)
    expect(sumCosts([])).toBe(0)
  })

  it('returns null when any input is null — a partial sum reads as a confident total', () => {
    expect(sumCosts([1, null, 2])).toBeNull()
    expect(sumCosts([null])).toBeNull()
    // A sub-total that already came back null feeds straight back in.
    expect(sumCosts([sumCosts([1, null]), 5])).toBeNull()
  })

  it('treats NaN and Infinity as 0 instead of poisoning the aggregate', () => {
    expect(sumCosts([Number.NaN, 0.5])).toBeCloseTo(0.5)
    expect(sumCosts([Number.POSITIVE_INFINITY, 0.25])).toBeCloseTo(0.25)
  })

  it('ignores non-number cost values', () => {
    expect(sumCosts(['3' as unknown as number, 1])).toBe(1)
  })

})

// The produced-assets envelope helpers: how a meta forwards a sub-step's
// asset into its own labelled assets[], and how a consuming meta reads one
// back by role. See labelledAssetShape for why the role rides on the element.
describe('produced-assets envelope helpers', () => {
  it('firstAsset returns the sub-step element as emitted; throws the labeled error on an empty set', () => {
    const el = { assetId: 'a1', modality: 'image' as const, url: 'https://x/a1.png', cost: 0.1 }
    expect(firstAsset({ assets: [el] }, 'x: text-to-image')).toBe(el)
    expect(() => firstAsset({ assets: [] }, 'x: text-to-image')).toThrow(
      'x: text-to-image produced no asset',
    )
    expect(() => firstAsset({}, 'x: text-to-image')).toThrow('x: text-to-image produced no asset')
  })

  it('labelAsset stamps the declared modality + label, forwards url / cost, and drops everything else', () => {
    const fromSubStep = {
      assetId: 'a1',
      url: 'https://x/a1.png',
      cost: 0.1,
      handle: 'image_1',
    } as { assetId: string; url?: string; cost?: number }
    expect(labelAsset(fromSubStep, 'image', 'hero')).toEqual({
      assetId: 'a1',
      modality: 'image',
      label: 'hero',
      url: 'https://x/a1.png',
      cost: 0.1,
    })
    // A host op's bare `{ assetId }` yields the minimal element — no
    // undefined-valued keys that would serialise as noise.
    expect(labelAsset({ assetId: 'v1' }, 'video', 'final-video')).toEqual({
      assetId: 'v1',
      modality: 'video',
      label: 'final-video',
    })
  })

  it('assetIdByLabel finds by role and fails closed with a labeled error', () => {
    const out = {
      assets: [
        { assetId: 'c0', label: 'candidate' },
        { assetId: 'c1', label: 'winner' },
      ],
    }
    expect(assetIdByLabel(out, 'winner', 'storyboard: meta_image-best-of-n')).toBe('c1')
    expect(() => assetIdByLabel(out, 'final-video', 'x: y')).toThrow(
      'x: y produced no asset labelled "final-video"',
    )
    expect(() => assetIdByLabel({}, 'winner', 'x: y')).toThrow('produced no asset labelled')
  })

  it('labelledAssetShape: label is required and bounded, modality is the literal, and a union of shapes audits clean', () => {
    const audio = z.object(labelledAssetShape('audio'))
    expect(audio.safeParse({ assetId: 'a', modality: 'audio' }).success).toBe(false)
    expect(audio.safeParse({ assetId: 'a', modality: 'audio', label: 'music' }).success).toBe(true)
    expect(audio.safeParse({ assetId: 'a', modality: 'audio', label: 'x'.repeat(65) }).success).toBe(false)
    expect(audio.safeParse({ assetId: 'a', modality: 'video', label: 'music' }).success).toBe(false)

    // A mixed-modality meta declares a union — serialised as anyOf, which the
    // outputs audit walks branch by branch. Nothing under assets is unbounded.
    const audit = auditOutputsSchema(
      z.object({ assets: z.array(z.union([audio, z.object(labelledAssetShape('video'))])) }),
    )
    expect(audit.unbounded).toEqual([])
    expect(audit.notTraversed).toEqual([])
  })
})
