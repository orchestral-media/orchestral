// image-to-video — atomic Pattern factory.
//
// End-frame conditioning is exposed via
// the `input.references.endFrame` slot plus, for models that take it as a
// first-class param, a provider-specific raw field in the derived
// `providerOptions` schema.

import { z } from 'zod'
import { createPatternFn, defineAtomicPattern, dispatchEnvelopeShape, producedAssetShape, type AtomicPattern, type Alternative, type AssetNeed, type DerivedReferences } from '@orchestral/core'

// ── primary input schema ────────────────────────────────────────────────
// The base carries NO ai-sdk-shaped fields — only `prompt` + `references`
// (references.startFrame = the still being animated).
// The per-model generation params come entirely from the resolved model's
// `liftable.X()` declarations, lifted onto top level by
// `deriveLlmFacingInputSchema` at find_pattern render time. The clip resolution
// now flows through the video model's `liftable.resolution()` (canonical WxH,
// identical to text-to-video) — the old i2v provider-label enum
// (480p/720p/1080p/4k) is gone.

export const ImageToVideoPrimaryInputSchema = z.object({
  prompt: z
    .string()
    .optional()
    .describe('Optional natural-language description of the desired motion.'),
})

const ASSET_NEEDS = [
  {
    slot: 'startFrame',
    modality: 'image',
    cardinality: 'single',
    required: true,
    description: 'The image to animate — becomes the first frame.',
  },
  {
    slot: 'endFrame',
    modality: 'image',
    cardinality: 'single',
    required: false,
    description:
      'End-frame image for first→last interpolation (supported by some models; surfaces as a first-class field in the derived per-model schema).',
  },
  {
    slot: 'reference',
    modality: 'image',
    cardinality: 'array',
    required: false,
    description: 'Reference image(s) for style or subject guidance.',
  },
  {
    slot: 'referenceVideo',
    modality: 'video',
    cardinality: 'array',
    required: false,
    description: 'Reference video(s) for motion guidance / motion transfer.',
  },
  {
    slot: 'referenceAudio',
    modality: 'audio',
    cardinality: 'array',
    required: false,
    description: 'Reference audio for lip-sync or rhythm guidance.',
  },
] as const satisfies readonly AssetNeed[]

export type ImageToVideoInput = z.infer<typeof ImageToVideoPrimaryInputSchema> & {
  references?: DerivedReferences<typeof ASSET_NEEDS>
}

// ── outputs ───────────────────────────────────────────────────────────────

// outputs.modality literal.
// Produced media is carried in `assets[]`. The adapter no longer mints a handle
// — the canonical handle is attached by the host from the SessionAssetStore
// after it records the asset.
export const ImageToVideoOutputSchema = z.object({
  modality: z.literal('video'),
  assets: z
    .array(z.object(producedAssetShape('video')))
    .describe('Produced clips — one element per generated asset.'),
  ...dispatchEnvelopeShape,
  /** Actual clip length in milliseconds; may differ from requested when provider quantizes. */
  videoDurationMs: z.number().int().min(0).optional(),
  width: z.number().int().min(1).optional(),
  height: z.number().int().min(1).optional(),
  fps: z.number().int().min(1).optional(),
})

export type ImageToVideoOutput = z.infer<typeof ImageToVideoOutputSchema>

// ── Pattern factory ─────────────────────────────────────────────────────

export const IMAGE_TO_VIDEO_PATTERN_ID = 'image-to-video'

export interface ImageToVideoPatternInit {
  alternatives?: readonly Alternative<ImageToVideoInput, ImageToVideoOutput>[]
}

export function createImageToVideoPattern(
  init: ImageToVideoPatternInit = {},
): AtomicPattern<ImageToVideoInput, ImageToVideoOutput> {
  return defineAtomicPattern<ImageToVideoInput, ImageToVideoOutput>({
    id: IMAGE_TO_VIDEO_PATTERN_ID,
    searchHint: 'animate a still image into a video clip',
    namespace: 'video-gen',
    description:
      'Animate a still image or generate a short video from a first-frame reference, optionally guided by a motion prompt. Capability: image-to-video. End-frame conditioning is driven by attaching an endFrame asset; multimodal reference guidance flows through input.references slots.',
    primary: {
      tool: {
        description:
          'Animate a still image: the source image is the starting frame and the model invents motion forward, optionally guided by a motion prompt. Use when the user asks to animate, bring to life, add motion, animate this picture, 让它动起来, or otherwise turn an existing image into a moving clip. Supply an endFrame reference for first→last interpolation when the user provides both start and end frames.',
        inputs: ImageToVideoPrimaryInputSchema,
      },
      modelTags: [],
    },
    outputs: ImageToVideoOutputSchema,
    // No first-party default. text-to-video is the only other clip producer and
    // the start frame cannot reach it: a redirect forwards the parent's resolved
    // assets under the PARENT's slot names, so `startFrame` arrives at a pattern
    // that reads `reference` / `endFrame` and is ignored. That leaves the
    // prompt — optional here, required there — so the ordinary "animate this
    // picture" call would map to an empty prompt and invent an unrelated clip.
    // The frame's content needs a carrier the way image-to-image's caption
    // round-trip carries a source image across; a caption → text-to-video meta
    // could be one, but no such pattern ships (see the note on text-to-video).
    alternatives: init.alternatives,
    // startFrame required (I2V start frame); endFrame (optional); reference
    // image/video/audio (all optional) for multimodal guidance.
    assetNeeds: ASSET_NEEDS,
  })
}

/** Typed `ctx.step` sugar — dispatch image-to-video from a meta compose(). */
export const imageToVideo = createPatternFn<
  ImageToVideoInput,
  ImageToVideoOutput
>(IMAGE_TO_VIDEO_PATTERN_ID)
