import { describe, expect, it } from 'vitest'

import {
  // atomic (11)
  TEXT_TO_IMAGE_PATTERN_ID,
  IMAGE_TO_IMAGE_PATTERN_ID,
  IMAGE_TO_TEXT_PATTERN_ID,
  TEXT_TO_VIDEO_PATTERN_ID,
  IMAGE_TO_VIDEO_PATTERN_ID,
  VIDEO_TO_VIDEO_PATTERN_ID,
  TEXT_TO_SPEECH_PATTERN_ID,
  TEXT_TO_AUDIO_PATTERN_ID,
  AUTOMATIC_SPEECH_RECOGNITION_PATTERN_ID,
  TEXT_GENERATION_PATTERN_ID,
  IMAGE_TO_IMAGE_VIA_CAPTION_PATTERN_ID,
  // meta (7)
  SCRIPT2VIDEO_PATTERN_ID,
  IMAGE_BEST_OF_N_PATTERN_ID,
  STORYBOARD_PATTERN_ID,
  EXPLAINER_SHORT_PATTERN_ID,
  PRODUCT_AD_SHORT_PATTERN_ID,
  PRODUCT_PHOTO_PACK_PATTERN_ID,
  UGC_TESTIMONIAL_PATTERN_ID,
} from '../index'

// Runtime-freeze gate. Pattern IDs are load-bearing string literals:
// they are hashed into the idempotency key (so they persist into dedup
// decisions), written into job rows, and their `agent_` / `meta_` prefixes
// drive inferNamespace + DEFAULT_SUBAGENT_BLOCKLIST. Changing any one of
// these after release silently corrupts dedup + on-disk history, so every id
// is pinned to its exact literal here. A change to any literal trips this
// test immediately.
describe('first-party Pattern ID literals', () => {
  it('atomic Pattern IDs are pinned', () => {
    expect(TEXT_TO_IMAGE_PATTERN_ID).toBe('text-to-image')
    expect(IMAGE_TO_IMAGE_PATTERN_ID).toBe('image-to-image')
    expect(IMAGE_TO_TEXT_PATTERN_ID).toBe('image-to-text')
    expect(TEXT_TO_VIDEO_PATTERN_ID).toBe('text-to-video')
    expect(IMAGE_TO_VIDEO_PATTERN_ID).toBe('image-to-video')
    expect(VIDEO_TO_VIDEO_PATTERN_ID).toBe('video-to-video')
    expect(TEXT_TO_SPEECH_PATTERN_ID).toBe('text-to-speech')
    expect(TEXT_TO_AUDIO_PATTERN_ID).toBe('text-to-audio')
    expect(AUTOMATIC_SPEECH_RECOGNITION_PATTERN_ID).toBe(
      'automatic-speech-recognition',
    )
    expect(TEXT_GENERATION_PATTERN_ID).toBe('text-generation')
    // Note: via-caption is authored in atomic/ but carries the meta_ prefix —
    // it routes to the meta-pipelines namespace (see pattern-namespace.test).
    expect(IMAGE_TO_IMAGE_VIA_CAPTION_PATTERN_ID).toBe(
      'meta_image-to-image-via-caption',
    )
  })

  it('meta Pattern IDs are pinned (meta_ prefix is load-bearing)', () => {
    expect(SCRIPT2VIDEO_PATTERN_ID).toBe('meta_script2video')
    expect(IMAGE_BEST_OF_N_PATTERN_ID).toBe('meta_image-best-of-n')
    expect(STORYBOARD_PATTERN_ID).toBe('meta_storyboard')
    expect(EXPLAINER_SHORT_PATTERN_ID).toBe('meta_explainer-short')
    expect(PRODUCT_AD_SHORT_PATTERN_ID).toBe('meta_product-ad-short')
    expect(PRODUCT_PHOTO_PACK_PATTERN_ID).toBe('meta_product-photo-pack')
    expect(UGC_TESTIMONIAL_PATTERN_ID).toBe('meta_ugc-testimonial')
  })

  // The agent Pattern ID (`agent_orchestrator`) is pinned by the same gate in
  // @orchestral/agent, which owns it. The long-form pipeline's ids
  // (`meta_script-planning`, `meta_idea2video`, …, `agent_long-form-video`)
  // left this package for examples/long-form-video and are pinned there.

  it('every meta id carries the meta_ prefix', () => {
    const metaIds = [
      SCRIPT2VIDEO_PATTERN_ID,
      IMAGE_BEST_OF_N_PATTERN_ID,
      STORYBOARD_PATTERN_ID,
      EXPLAINER_SHORT_PATTERN_ID,
      PRODUCT_AD_SHORT_PATTERN_ID,
      PRODUCT_PHOTO_PACK_PATTERN_ID,
      UGC_TESTIMONIAL_PATTERN_ID,
    ]
    for (const id of metaIds) {
      expect(id.startsWith('meta_'), `${id} must start with meta_`).toBe(true)
    }
  })
})
