// text-to-video — atomic Pattern factory.
//
// Native joint audio+video synthesis is exposed via a provider-self-reported flat audio-synthesis field (the host
// wraps it with `providerOptionsKeyFor(providerName)` at the worker layer).
// Models that support joint audio+video declare it in their ship-data; the LLM
// sees the derived typed schema and toggles it directly.

import { z } from 'zod'
import { defineAtomicPattern, dispatchEnvelopeShape, producedAssetShape, type AtomicPattern, type Alternative, type AssetNeed, type DerivedReferences } from '@orchestral/core'

// ── primary input schema ────────────────────────────────────────────────
// ai-sdk decoupling: the base carries NO ai-sdk-shaped fields — only
// `prompt` + `references`. The per-model generation params come entirely from
// the resolved model's `liftable.X()` declarations, lifted onto Pattern.input
// top level by `deriveLlmFacingInputSchema` at find_pattern render time. Note
// the lifted clip-length field is `duration` (host coalesces it at the workflow
// adapter).

export const TextToVideoPrimaryInputSchema = z.object({
  prompt: z
    .string()
    .min(1, 'prompt required')
    .describe('Text description of the video to generate.'),
})

const ASSET_NEEDS = [
  {
    slot: 'reference',
    modality: 'image',
    cardinality: 'array',
    required: false,
    description:
      'Style / subject reference image(s); models without explicit reference support ignore them gracefully.',
  },
  {
    slot: 'endFrame',
    modality: 'image',
    cardinality: 'single',
    required: false,
    description:
      'End-frame image for first→last interpolation (supported by some models; surfaces as a first-class field in the derived per-model schema).',
  },
] as const satisfies readonly AssetNeed[]

export type TextToVideoInput = z.infer<typeof TextToVideoPrimaryInputSchema> & {
  references?: DerivedReferences<typeof ASSET_NEEDS>
}

// ── outputs ───────────────────────────────────────────────────────────────

// outputs.modality literal.
// Produced media is carried in `assets[]` (legacy single assetId / videoUrl
// removed). The adapter no longer fabricates handles — the canonical handle is
// attached by the host from the SessionAssetStore after recording. assetId is
// stripped by toModelOutput's projection, so the LLM only ever sees the handle.
export const TextToVideoOutputSchema = z.object({
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

export type TextToVideoOutput = z.infer<typeof TextToVideoOutputSchema>

// ── Pattern factory ─────────────────────────────────────────────────────

export const TEXT_TO_VIDEO_PATTERN_ID = 'text-to-video'

export interface TextToVideoPatternInit {
  alternatives?: readonly Alternative<TextToVideoInput, TextToVideoOutput>[]
}

export function createTextToVideoPattern(
  init: TextToVideoPatternInit = {},
): AtomicPattern<TextToVideoInput, TextToVideoOutput> {
  return defineAtomicPattern<TextToVideoInput, TextToVideoOutput>({
    id: TEXT_TO_VIDEO_PATTERN_ID,
    searchHint: 'generate a short video clip from a text prompt',
    namespace: 'video-gen',
    description:
      'Generate a short video clip from a text prompt. Capability: text-to-video. Native joint audio synthesis is opt-in via the audio-synthesis field exposed in the derived per-model schema, when the resolved model supports it.',
    primary: {
      tool: {
        description:
          'Generate a short video clip from a text prompt. Use when the user asks to create, produce, render, animate or generate a video, clip, animation, motion graphic, 动画 or 视频 from a text description. When the user explicitly asks for sound, dialogue, or music baked into the clip, set the audio-synthesis field exposed in the derived per-model schema (its exact name varies by model).',
        inputs: TextToVideoPrimaryInputSchema,
      },
      modelTags: [],
    },
    outputs: TextToVideoOutputSchema,
    // No first-party default. The honest degradation here is text-to-image →
    // image-to-video (render a still, then animate it), and that is a chain an
    // Alternative cannot express by itself: `via.patternId` names ONE registered
    // pattern and `mapInput` is a pure synchronous closure, so the chain has to
    // exist as a meta to redirect to — and none ships in this package. Pointing
    // at an id the host has not registered would be strictly worse than the
    // current behaviour: the runtime raises ALTERNATIVE_PATTERN_NOT_REGISTERED
    // in place of the router's actionable "no model for text-to-video".
    // DESIGN: text-to-video-no-fallback
    alternatives: init.alternatives,
    // reference[] (optional) + endFrame (optional single). Refs are image
    // assets even though the output is video; both optional (references opt-in).
    assetNeeds: ASSET_NEEDS,
  })
}
