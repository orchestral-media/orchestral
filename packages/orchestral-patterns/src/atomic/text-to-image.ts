// text-to-image — atomic Pattern factory.
//
// Strategy branches (ip-adapter / controlnet / lora-style) are expressed via:
//   - `input.references.{reference, control}` asset slots — LLM fills handles
//   - provider-self-reported typed `providerOptions` schema — LLM fills raw
//     fields like `ip_adapter_image_url` / `loras: [...]` / `control_*`
//     directly from derived schema (no normalization layer)
//
// Pattern factory itself no longer declares `providerOptions: z.record(...)`
// placeholder — `deriveLlmFacingInputSchema` injects a typed providerOptions
// object at find_pattern render time based on the resolved top-1 model.

import { z } from 'zod'
import { createPatternFn, defineAtomicPattern, dispatchEnvelopeShape, producedAssetShape, type AtomicPattern, type Alternative, type AssetNeed, type DerivedReferences } from '@orchestral/core'

// ── primary input schema ────────────────────────────────────────────────
// The LLM-facing base carries only `prompt` + `references`: every generation
// param is per-model, and comes from the resolved model's `liftable.X()`
// declarations, lifted onto the top level by `deriveLlmFacingInputSchema` at
// find_pattern render time. Standalone use (no host lift) sees just the slim
// base — that degraded shape is intentional. Machine callers that skip the lift
// step fill the same top-level params through `ImageGenerationParams` below.

export const TextToImagePrimaryInputSchema = z.object({
  prompt: z
    .string()
    .min(1, 'prompt required')
    .describe('Text description of the image to generate.'),
})

const ASSET_NEEDS = [
  {
    slot: 'reference',
    modality: 'image',
    cardinality: 'array',
    required: false,
    description:
      'Reference image(s) to preserve subject identity / face / style (IP-Adapter / InstantID / PuLID class). Provider-specific scale / strength (e.g. providerOptions.ip_adapter_scale) surfaces in the derived schema. For a trained LoRA style no asset is needed — supply providerOptions.loras [{path, scale}].',
  },
  {
    slot: 'control',
    modality: 'image',
    cardinality: 'single',
    required: false,
    description:
      'Control image (pose / depth / canny / scribble map) to match a specific pose or structural layout. Control type / strength surface in the derived providerOptions schema (e.g. providerOptions.control_type).',
  },
] as const satisfies readonly AssetNeed[]

/**
 * The generation-param channel a machine caller fills directly — a meta
 * `compose()`, which has no LLM lift step to fill the same fields from a
 * per-model derived schema. These params ride on the TOP LEVEL of the Pattern
 * input alongside `prompt`.
 *
 * Adapter contract, and it is load-bearing: read all four off the top level and
 * pass them to the image API. An adapter that ignores `size` does not fail — it
 * returns an image at its own default resolution, so a caller that asked for a
 * 2048 render gets a smaller one back with no error. `ImageToImageViaCaption`'s
 * `tier` is exactly such a caller, which is why its output echoes the size it
 * requested: the discrepancy is detectable rather than invisible.
 */
export interface ImageGenerationParams {
  /** Output dimensions as "WIDTHxHEIGHT", e.g. "1024x1024". */
  size?: string
  /** Batch count (n>1 → multiple assets). Adapters default to 1. */
  n?: number
  /** Size-free alternative "W:H"; mutually exclusive with `size`. */
  aspectRatio?: string
  /** Deterministic-repro seed. */
  seed?: number
  /**
   * Flat provider-specific tuning params. At find_pattern render time the
   * derived schema replaces this loose shape with a typed per-model object; a
   * meta compose() sets it directly.
   */
  providerOptions?: Record<string, unknown>
}

export type TextToImageInput = z.infer<typeof TextToImagePrimaryInputSchema> & {
  references?: DerivedReferences<typeof ASSET_NEEDS>
} & ImageGenerationParams

// ── outputs ───────────────────────────────────────────────────────────────

// Produced media is carried in `assets[]` (one element per generated image;
// real assetId + optional url). Legacy single `assetId` / `imageUrl` removed —
// even a single image goes through assets[1]. The adapter no longer fabricates
// handles — the canonical handle is attached by the host from the
// SessionAssetStore after recording (stampSessionHandles matches by assetId).
// The modality literal lets the LLM see `{ handle, modality: 'image' }` in the
// tool_result (only present after the handle is stamped), so natural-language
// references stay precise ("the image I generated"). assetId is stripped by
// toModelOutput's projection and stays invisible to the LLM.
export const TextToImageOutputSchema = z.object({
  modality: z.literal('image'),
  assets: z
    .array(z.object(producedAssetShape('image')))
    .describe('Produced images — one element per generated asset (n>1 → multiple).'),
  ...dispatchEnvelopeShape,
})

export type TextToImageOutput = z.infer<typeof TextToImageOutputSchema>

// ── Pattern factory ─────────────────────────────────────────────────────

export const TEXT_TO_IMAGE_PATTERN_ID = 'text-to-image'

export function createTextToImagePattern(
  init: {
    alternatives?: readonly Alternative<TextToImageInput, TextToImageOutput>[]
  } = {},
): AtomicPattern<TextToImageInput, TextToImageOutput> {
  return defineAtomicPattern<TextToImageInput, TextToImageOutput>({
    id: TEXT_TO_IMAGE_PATTERN_ID,
    searchHint: 'generate an image from a text prompt',
    exposureMode: 'always-load',
    namespace: 'image-gen',
    exposure: { chatTurn: true, agentLoop: true, canvas: true },
    description:
      'Generate an image from a text prompt. Capability: text-to-image. Identity preservation, structural control, LoRA stacking, and other provider-specific strategies are driven via input.references and typed providerOptions exposed in the derived per-model schema.',
    primary: {
      tool: {
        description:
          'Generate an image from a text prompt. Use when the user asks to create, draw, paint, illustrate, or generate a picture, photo, illustration, or visual artwork from a text description.',
        inputs: TextToImagePrimaryInputSchema,
      },
      modelTags: [],
    },
    outputs: TextToImageOutputSchema,
    // No first-party default. The only other pattern that can put out an image
    // is image-to-image, and it wants a source picture this caller need not
    // have: `reference` / `control` are optional here, and `appliesWhen` is
    // evaluated against the catalog alone — it never sees the input — so the
    // entry would fire on prompt-only calls too. Even when a reference IS
    // attached it does not arrive: a redirect forwards the parent's resolved
    // assets under the PARENT's slot names, so `reference` reaches a pattern
    // whose adapter reads `source` and the edit runs with nothing to edit.
    alternatives: init.alternatives,
    // reference / control image slots. Both optional.
    assetNeeds: ASSET_NEEDS,
  })
}

/** Typed `ctx.step` sugar — dispatch text-to-image from a meta compose(). */
export const textToImage = createPatternFn<TextToImageInput, TextToImageOutput>(
  TEXT_TO_IMAGE_PATTERN_ID,
)
