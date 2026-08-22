import { describe, expect, it } from 'vitest'

import type { ExecutionContext, PatternRef } from '@orchestral/core'

import { createStoryboardMeta, STORYBOARD_DEFAULT_PROMPTS } from '../meta/storyboard'
import { SCRIPT2VIDEO_DEFAULT_PROMPTS } from '../meta/script2video'
import { STORYBOARD_DESIGN_PROMPT } from '../meta/_shared/storyboard-design-prompt'

// Every shipped meta factory + the smoke deps each one needs. Kept in one
// place so the "construct every meta" case below can't silently miss one.
import { createScript2VideoMeta } from '../meta/script2video'
import { createExplainerShortMeta } from '../meta/explainer-short'
import { createUgcTestimonialMeta } from '../meta/ugc-testimonial'
import { createProductAdShortMeta } from '../meta/product-ad-short'
import { createProductPhotoPackMeta } from '../meta/product-photo-pack'
import { createImageBestOfNMeta } from '../meta/image-best-of-n'

// Fake ExecutionContext: records each ctx.step input in call order and
// returns a canned output per pattern — the storyboard-design JSON for
// text-generation, one produced image for image-to-image.
function makeCtx(designJson: string) {
  const stepInputs: Array<Record<string, unknown>> = []
  const ctx = {
    compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
    step: async <T>(ref: PatternRef): Promise<T> => {
      stepInputs.push(ref.input as Record<string, unknown>)
      if (ref.patternId === 'text-generation') {
        return {
          modality: 'text',
          text: designJson,
          cost: 1,
          latencyMs: 10,
          model: 'test:model',
          provider: 'test',
        } as unknown as T
      }
      return {
        modality: 'image',
        assets: [{ assetId: 'asset-panel', modality: 'image' }],
        cost: 1,
        latencyMs: 10,
        model: 'test:i2i',
        provider: 'test',
      } as unknown as T
    },
  } as unknown as ExecutionContext
  return { ctx, stepInputs }
}

const ONE_SHOT = JSON.stringify({
  storyboard: [
    { idx: 0, is_last: true, cam_idx: 0, visual_desc: '<Ada> at the window', audio_desc: '' },
  ],
})

// Host-op stubs — never invoked (compose short-circuits before any host op in
// these tests), but satisfy the required `deps` param at construction.
const videoOp = async () => ({ assetId: 'a_stub' })
const handleOp = async () => ({ handle: 'h_stub' })

describe('meta prompt overrides', () => {
  it('threads an override into the sub-step that uses it', async () => {
    const CUSTOM_DESIGN = 'CUSTOM STORYBOARD DESIGN SYSTEM PROMPT'
    const meta = createStoryboardMeta({
      prompts: { storyboardDesign: CUSTOM_DESIGN },
    })
    const { ctx, stepInputs } = makeCtx(ONE_SHOT)

    const out = await meta.compose(
      { input: { scene: 'a quiet drama', characters: [{ name: 'Ada', refs: ['h-ada'] }] } },
      ctx,
    )

    expect(out.panels).toHaveLength(1)
    // Step 1 (the design pass) carries the OVERRIDDEN prompt, not the default.
    expect(stepInputs[0]!.system).toBe(CUSTOM_DESIGN)
    expect(stepInputs[0]!.system).not.toBe(STORYBOARD_DESIGN_PROMPT)
  })

  it('overriding one meta leaves the frozen defaults, and the sibling that shares the prompt, untouched', () => {
    createStoryboardMeta({ prompts: { storyboardDesign: 'CUSTOM' } })

    // resolvePrompts returns a fresh object; the frozen const is never mutated…
    expect(Object.isFrozen(STORYBOARD_DEFAULT_PROMPTS)).toBe(true)
    expect(STORYBOARD_DEFAULT_PROMPTS).toEqual({
      storyboardDesign: STORYBOARD_DESIGN_PROMPT,
    })
    // …and the defaults reference the prompt constant, they don't copy the
    // bytes.
    expect(STORYBOARD_DEFAULT_PROMPTS.storyboardDesign).toBe(STORYBOARD_DESIGN_PROMPT)
    // meta_script2video reads the same storyboard-design prompt under an
    // identically-named key; overriding one meta's copy does not reach the
    // other's.
    expect(SCRIPT2VIDEO_DEFAULT_PROMPTS.storyboardDesign).toBe(STORYBOARD_DESIGN_PROMPT)
  })

  it('constructs every shipped meta with no prompt overrides', () => {
    const built = [
      createScript2VideoMeta({ concatVideos: videoOp }),
      createStoryboardMeta(),
      createExplainerShortMeta({ concatVideos: videoOp, stillToVideo: videoOp }),
      createUgcTestimonialMeta({
        concatVideos: videoOp,
        addBackgroundAudio: videoOp,
        addSubtitles: videoOp,
        createSubtitleAsset: videoOp,
      }),
      createProductAdShortMeta({
        addBackgroundAudio: videoOp,
        recordSessionAsset: handleOp,
      }),
      createProductPhotoPackMeta(),
      createImageBestOfNMeta(),
    ]

    expect(built.map((m) => m.id).sort()).toEqual(
      [
        'meta_explainer-short',
        'meta_image-best-of-n',
        'meta_product-ad-short',
        'meta_product-photo-pack',
        'meta_script2video',
        'meta_storyboard',
        'meta_ugc-testimonial',
      ].sort(),
    )
  })
})
