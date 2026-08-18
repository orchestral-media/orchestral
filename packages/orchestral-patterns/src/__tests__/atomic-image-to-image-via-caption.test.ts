import { describe, expect, it } from 'vitest'

import type { ExecutionContext, PatternRef } from '@orchestral/core'
import { createImageToImageViaCaptionPattern } from '../atomic/image-to-image-via-caption'

// Fake ExecutionContext: routes by patternId — the caption step
// (image-to-text) returns a canned description, the render step
// (text-to-image) returns one produced asset. Per-step costs are injectable
// so the NaN-guard case can poison exactly one sub-step.
function makeCtx(
  costs: { caption: number; image: number },
  ctxAssets?: ExecutionContext['assets'],
  seen: PatternRef[] = [],
) {
  return {
    ...(ctxAssets ? { assets: ctxAssets } : {}),
    compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
    step: async <T>(ref: PatternRef): Promise<T> => {
      seen.push(ref)
      if (ref.patternId === 'image-to-text') {
        return {
          modality: 'text',
          text: 'a red kite over a beach',
          cost: costs.caption,
          latencyMs: 10,
          model: 'test:vlm',
          provider: 'test',
        } as unknown as T
      }
      // text-to-image
      return {
        modality: 'image',
        assets: [{ assetId: 'asset-edit-0', modality: 'image' }],
        cost: costs.image,
        latencyMs: 20,
        model: 'test:t2i',
        provider: 'test',
      } as unknown as T
    },
  } as unknown as ExecutionContext
}

describe('meta_image-to-image-via-caption', () => {
  it('chains caption → render, forwarding the render assets and summing costs', async () => {
    const meta = createImageToImageViaCaptionPattern()

    const out = await meta.compose(
      { input: { editPrompt: 'make it night', tier: 'preview' } },
      makeCtx({ caption: 0.01, image: 0.2 }),
    )

    expect(out.assets).toEqual([{ assetId: 'asset-edit-0', modality: 'image' }])
    expect(out.degraded).toBe(true)
    expect(out.cost).toBeCloseTo(0.21)
  })

  it('forwards every source ref to the caption step (multi-source direct call)', async () => {
    const meta = createImageToImageViaCaptionPattern()
    const sources = [
      { slot: 'source', assetId: 'asset-a', modality: 'image' as const, handle: 'image_1' },
      { slot: 'source', assetId: 'asset-b', modality: 'image' as const, handle: 'image_2' },
    ]
    const seen: PatternRef[] = []

    await meta.compose(
      { input: { editPrompt: 'merge them at dusk', tier: 'preview' } },
      makeCtx({ caption: 0.01, image: 0.2 }, [...sources, { slot: 'mask', assetId: 'asset-m', modality: 'image' }], seen),
    )

    const caption = seen.find((ref) => ref.patternId === 'image-to-text')
    // Both sources ride the internal channel, handles preserved; `mask` does
    // not — this path regenerates the whole frame.
    expect(caption?.assets).toEqual(sources)
  })

  it('declares `source` with the same cardinality as image-to-image', () => {
    // The via-caption alternative forwards image-to-image's resolved assets
    // verbatim under the same slot name, so a narrower cardinality here would
    // reject multi-source callers the redirect legitimately hands over.
    const need = createImageToImageViaCaptionPattern().assetNeeds?.find(
      (n) => n.slot === 'source',
    )
    expect(need).toMatchObject({ modality: 'image', cardinality: 'array', required: true })
  })

  it('keeps cost finite when the caption step reports NaN (sumCosts guard)', async () => {
    const meta = createImageToImageViaCaptionPattern()

    const out = await meta.compose(
      { input: { editPrompt: 'make it night', tier: 'preview' } },
      makeCtx({ caption: Number.NaN, image: 0.2 }),
    )

    // The NaN caption cost is guarded to 0 — only the render (0.2) counts.
    expect(Number.isFinite(out.cost)).toBe(true)
    expect(out.cost).toBeCloseTo(0.2)
  })
})
