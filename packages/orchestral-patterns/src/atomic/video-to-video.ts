// video-to-video — Pattern factory.
// primary path = vanilla video-to-video transformation.
// The transformation family (reframe / upscale / restyle / extend) lives in
// `input.mode` because the input field set the user fills out changes per
// mode, not the underlying capability branch.

import { z } from 'zod'
import { defineAtomicPattern, dispatchEnvelopeShape, producedAssetShape, type AtomicPattern, type Alternative, type AssetNeed, type DerivedReferences } from '@orchestral/core'

// ── primary input schema ────────────────────────────────────────────────
// `mode` is a plain input field (not a discriminated-union arm): the host's
// resolver enforces per-mode required fields beyond zod (e.g. `prompt` for
// restyle, `targetResolution` for upscale) because optional-rich shapes
// don't compose cleanly into discriminated arms here.

// Field placement rationale:
// - strength → carried in providerOptions.strength (provider-specific knob)
// - mode + aspectRatio + targetResolution + extendSeconds stay LLM-facing as a
//   cross-provider abstraction; the adapter translates them to each provider's
//   own naming.
// - n and providerOptions are exposed too.

export const VideoToVideoPrimaryInputSchema = z.object({
  mode: z
    .enum(['reframe', 'upscale', 'restyle', 'extend'])
    .default('restyle')
    .describe(
      'Transformation family. reframe = change aspect ratio; upscale = increase resolution; restyle = change visual look guided by prompt; extend = append more footage. Cross-provider abstraction.',
    ),
  prompt: z
    .string()
    .optional()
    .describe(
      'Text instruction. Required for restyle / extend; ignored by reframe / upscale.',
    ),
  n: z
    .number()
    .int()
    .min(1)
    .max(4)
    .default(1)
    .describe('Number of output clips. derive() lifts per-model constraints.'),
  aspectRatio: z
    .enum(['16:9', '9:16', '1:1', '4:5', '3:4'])
    .optional()
    .describe('Target aspect ratio for reframe mode; ignored otherwise.'),
  targetResolution: z
    .enum(['720p', '1080p', '4k'])
    .optional()
    .describe('Target resolution for upscale mode; ignored otherwise.'),
  extendSeconds: z
    .number()
    .min(1)
    .max(20)
    .optional()
    .describe('Seconds of additional footage to append in extend mode.'),
  seed: z.number().int().optional().describe('Deterministic seed.'),
  // `providerOptions` placeholder removed — derive injects a typed schema at
  // find_pattern render time based on the resolved model (e.g. Runway strength
  // or Topaz upscale model).
})

const ASSET_NEEDS = [
  {
    slot: 'source',
    modality: 'video',
    cardinality: 'single',
    required: true,
    description: 'The video to transform.',
  },
  {
    slot: 'reference',
    modality: 'image',
    cardinality: 'array',
    required: false,
    description:
      'Style reference image(s) guiding the visual look in restyle mode; other modes ignore them.',
  },
] as const satisfies readonly AssetNeed[]

export type VideoToVideoInput = z.infer<typeof VideoToVideoPrimaryInputSchema> & {
  references?: DerivedReferences<typeof ASSET_NEEDS>
}

// ── outputs ───────────────────────────────────────────────────────────────

// outputs.modality is a literal. Produced media is carried in `assets[]`
// (the legacy single assetId / videoUrl fields were removed). The adapter no
// longer mints handles — the host records the asset and attaches the canonical
// handle from the SessionAssetStore. toModelOutput strips assetId via a hard
// projection so the LLM only ever sees the handle.
export const VideoToVideoOutputSchema = z.object({
  modality: z.literal('video'),
  assets: z
    .array(z.object(producedAssetShape('video')))
    .describe('Produced clips — one element per generated asset.'),
  ...dispatchEnvelopeShape,
  /** Length of the produced video in milliseconds. */
  videoDurationMs: z.number().int().min(0).optional(),
  width: z.number().int().min(1).optional(),
  height: z.number().int().min(1).optional(),
  fps: z.number().int().min(1).optional(),
})

export type VideoToVideoOutput = z.infer<typeof VideoToVideoOutputSchema>

// ── Pattern factory ─────────────────────────────────────────────────────

export const VIDEO_TO_VIDEO_PATTERN_ID = 'video-to-video'

export interface VideoToVideoPatternInit {
  alternatives?: readonly Alternative<VideoToVideoInput, VideoToVideoOutput>[]
}

export function createVideoToVideoPattern(
  init: VideoToVideoPatternInit = {},
): AtomicPattern<VideoToVideoInput, VideoToVideoOutput> {
  return defineAtomicPattern<VideoToVideoInput, VideoToVideoOutput>({
    id: VIDEO_TO_VIDEO_PATTERN_ID,
    searchHint: 'restyle, reframe, or upscale an existing video',
    namespace: 'video-gen',
    description:
      'Transform an existing video: reframe its aspect ratio, upscale its resolution, restyle its look from a prompt, or extend its duration with more footage. Capability: video-to-video. Primary-only — no strategy variants; the transformation family is selected via the `mode` input field.',
    primary: {
      tool: {
        description:
          'Transform an existing video: reframe its aspect ratio, upscale its resolution, restyle its look from a prompt, or extend its duration with more footage. Use when the user asks to edit, reframe, crop, upscale, enhance, restyle, recut, or continue an existing video clip. Set the mode field to the requested transformation family (reframe / upscale / restyle / extend).',
        inputs: VideoToVideoPrimaryInputSchema,
      },
      modelTags: [],
    },
    outputs: VideoToVideoOutputSchema,
    // No first-party default. Every candidate path has to turn the source clip
    // into something another capability can read, and `mapInput` is pure and
    // synchronous — it cannot decode a frame — while no first-party capability
    // converts video → image or describes a clip as text. The `mode` families
    // make it worse: upscale and reframe have no generative equivalent to
    // degrade into at all.
    alternatives: init.alternatives,
    // source is required (the video to transform); reference[] holds optional
    // images used as style references in restyle mode.
    assetNeeds: ASSET_NEEDS,
  })
}
