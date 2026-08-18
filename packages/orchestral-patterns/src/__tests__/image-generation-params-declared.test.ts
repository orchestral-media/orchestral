// The render size meta_image-to-image-via-caption asks for travels on
// text-to-image's top-level ImageGenerationParams channel, which an adapter can
// ignore without erroring — a `final` tier would then come back at the
// adapter's default resolution with nothing anywhere saying so. These pin the
// two halves of the fix: the meta states the size it asked for, and
// image-to-image ships its fallback path instead of leaving it to the host.
import { describe, expect, it } from 'vitest'

import type { ExecutionContext, PatternRef } from '@orchestral/core'
import { createImageToImagePattern } from '../atomic/image-to-image'
import {
  IMAGE_TO_IMAGE_VIA_CAPTION_PATTERN_ID,
  createImageToImageViaCaptionPattern,
} from '../atomic/image-to-image-via-caption'

function makeCtx(seen: Record<string, unknown>[]) {
  return {
    compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
    step: async <T>(ref: PatternRef): Promise<T> => {
      seen.push({
        patternId: ref.patternId,
        ...(ref.input as Record<string, unknown>),
      })
      if (ref.patternId === 'image-to-text') {
        return {
          modality: 'text',
          text: 'a red kite over a beach',
          cost: 0.01,
          latencyMs: 10,
          model: 'test:vlm',
          provider: 'test',
        } as unknown as T
      }
      return {
        modality: 'image',
        assets: [{ assetId: 'asset-edit-0', modality: 'image' }],
        cost: 0.2,
        latencyMs: 20,
        model: 'test:t2i',
        provider: 'test',
      } as unknown as T
    },
  } as unknown as ExecutionContext
}

describe('meta_image-to-image-via-caption render size', () => {
  it('sends the tier size to the render step and echoes it on the output', async () => {
    const seen: Record<string, unknown>[] = []
    const out = await createImageToImageViaCaptionPattern().compose(
      { input: { editPrompt: 'make it night', tier: 'final' } },
      makeCtx(seen),
    )

    const render = seen.find((s) => s.patternId === 'text-to-image')!
    expect(render.size).toBe('2048x2048')
    expect(render.n).toBe(1)
    expect(out.requestedSize).toBe('2048x2048')
  })

  it('falls to the draft size when a machine caller omits tier — no schema default runs on the sub-step path', async () => {
    const seen: Record<string, unknown>[] = []
    const out = await createImageToImageViaCaptionPattern().compose(
      { input: { editPrompt: 'make it night' } as never },
      makeCtx(seen),
    )

    const render = seen.find((s) => s.patternId === 'text-to-image')!
    expect(render.size).toBe('1024x1024')
    expect(out.requestedSize).toBe('1024x1024')
  })
})

describe('image-to-image alternatives', () => {
  it('ships the caption fallback by default', () => {
    const pattern = createImageToImagePattern() as unknown as {
      alternatives: readonly {
        id: string
        appliesWhen: { kind: string }
        via: { patternId: string }
        losses?: readonly string[]
      }[]
    }
    expect(pattern.alternatives).toHaveLength(1)
    const alt = pattern.alternatives[0]!
    expect(alt.id).toBe('via-caption')
    expect(alt.appliesWhen.kind).toBe('capability-unavailable')
    expect(alt.via.patternId).toBe(IMAGE_TO_IMAGE_VIA_CAPTION_PATTERN_ID)
    expect(alt.losses).toContain('subject-identity')
  })

  it('lets a host replace the default set, including with none at all', () => {
    const pattern = createImageToImagePattern({
      alternatives: [],
    }) as unknown as { alternatives: readonly unknown[] }
    expect(pattern.alternatives).toEqual([])
  })
})
