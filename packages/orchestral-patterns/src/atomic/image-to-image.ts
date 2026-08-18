// image-to-image — atomic Pattern factory.
//
// inpaint / outpaint / style-transfer strategies are expressed via:
//   - `input.references.{source, mask}` asset slots — style transfer rides the
//     multi-source `source[]` slot (pass subject + style image together and
//     describe each one's role in the prompt)
//   - typed `providerOptions` schema (e.g. providerOptions.outpaint:
//     {direction, pixels})
//
// Pattern factory itself no longer declares `providerOptions: z.record(...)`
// placeholder — `deriveLlmFacingInputSchema` injects a typed providerOptions
// object at find_pattern render time based on the resolved top-1 model.

import { z } from 'zod'
import { createPatternFn, defineAtomicPattern, dispatchEnvelopeShape, producedAssetShape, whenCapabilityUnavailable, type AtomicPattern, type Alternative, type AssetNeed, type DerivedReferences } from '@orchestral/core'
import {
  IMAGE_TO_IMAGE_VIA_CAPTION_PATTERN_ID,
  type ImageToImageViaCaptionInput,
  type ImageToImageViaCaptionOutput,
} from './image-to-image-via-caption'

// ── primary input schema ────────────────────────────────────────────────
// The base carries NO ai-sdk-shaped fields — only `prompt` + `references`
// (references.source = the image being edited).
// The per-model generation params come entirely from the resolved model's
// `liftable.X()` declarations, lifted onto top level by
// `deriveLlmFacingInputSchema` at find_pattern render time.

export const ImageToImagePrimaryInputSchema = z.object({
  prompt: z
    .string()
    .min(1, 'prompt required')
    .describe('Text instruction describing the desired edit.'),
})

const ASSET_NEEDS = [
  {
    slot: 'source',
    modality: 'image',
    cardinality: 'array',
    required: true,
    description:
      'The image(s) to edit, extend (outpaint — direction/pixels via providerOptions.outpaint when the model supports it), or fuse — some models accept multiple source images for multi-source fusion (per-model max varies). When passing multiple images (e.g. a subject photo plus a style/reference photo), describe each image\'s role in the prompt text — the model sees them in array order. To keep several characters/subjects consistent in one frame (e.g. two characters sharing a shot), pass each one\'s reference image here so the model fuses them all — passing only one loses the others\' identity.',
  },
  {
    slot: 'mask',
    modality: 'image',
    cardinality: 'single',
    required: false,
    description:
      'Mask image for masked editing / inpaint — white = region to edit, black = preserve. Per-model mask blur / strength surface in the derived providerOptions schema.',
  },
] as const satisfies readonly AssetNeed[]

export type ImageToImageInput = z.infer<typeof ImageToImagePrimaryInputSchema> & {
  references?: DerivedReferences<typeof ASSET_NEEDS>
}

// ── outputs ───────────────────────────────────────────────────────────────

// outputs.modality literal.
// Produced media is carried in `assets[]` (the legacy single assetId / imageUrl
// fields were removed). The adapter no longer mints a handle — the canonical
// handle is attached by the host from the SessionAssetStore after it records
// the asset. assetId is projected out by toModelOutput, so the LLM only ever
// sees the handle.
export const ImageToImageOutputSchema = z.object({
  modality: z.literal('image'),
  assets: z
    .array(z.object(producedAssetShape('image')))
    .describe('Produced images — one element per generated asset (n>1 → multiple).'),
  ...dispatchEnvelopeShape,
})

export type ImageToImageOutput = z.infer<typeof ImageToImageOutputSchema>

// ── Pattern factory ─────────────────────────────────────────────────────

export const IMAGE_TO_IMAGE_PATTERN_ID = 'image-to-image'

export interface ImageToImagePatternInit {
  /**
   * Replaces the first-party fallback path below. Pass `[]` to run with no
   * fallback at all (an unavailable capability then fails the job).
   */
  alternatives?: readonly Alternative<ImageToImageInput, ImageToImageOutput>[]
}

/**
 * First-party degradation path: with no image-to-image model in the catalog,
 * approximate the edit by captioning the source image and re-rendering that
 * caption together with the edit instruction
 * (`meta_image-to-image-via-caption`). Only style descriptors survive the
 * round-trip — subject identity and composition do not — and an inpaint `mask`
 * has no meaning on the redirect target, which regenerates the whole frame.
 *
 * The redirect target must be registered alongside this Pattern; the runtime
 * raises ALTERNATIVE_PATTERN_NOT_REGISTERED when it is not.
 */
const VIA_CAPTION_ALTERNATIVE: Alternative<
  ImageToImageInput,
  ImageToImageOutput
> = {
  id: 'via-caption',
  description:
    'No image-to-image model is available: caption the source image, then re-render it from that caption plus the edit instruction. Subject identity and composition are lost, and a mask is ignored — the whole frame is regenerated.',
  appliesWhen: whenCapabilityUnavailable(),
  // Two model calls (caption + render) replace one edit call.
  costMultiplier: 2,
  qualityDelta: -0.5,
  preserves: ['style'],
  // `mask-guidance` is listed because the redirect silently has no use for the
  // `mask` slot — see mapInput below. A caller that asked for a masked edit
  // gets a full-frame regeneration, and the degradation notice must say so.
  losses: ['subject-identity', 'composition', 'mask-guidance'],
  via: {
    patternId: IMAGE_TO_IMAGE_VIA_CAPTION_PATTERN_ID,
    mapInput: (input): ImageToImageViaCaptionInput => ({
      // The edit instruction is the whole of the parent's intent; the source
      // image rides along in the dispatch context, which the runtime forwards
      // to the redirect target unchanged.
      //
      // The `mask` slot is intentionally not projected: the target has no mask
      // input to project it onto, because captioning and re-rendering replaces
      // the whole frame — there is no preserved region for a mask to protect.
      // The `mask-guidance` loss above is what makes that visible.
      editPrompt: input.prompt,
      // Draft resolution: the source image's dimensions are not part of the
      // parent input, so a 2048 render would be a guess, not a match.
      tier: 'preview',
    }),
    mapOutput: (childOutput): ImageToImageOutput => {
      const out = childOutput as ImageToImageViaCaptionOutput
      // Lossless projection — the meta envelope is a superset of this
      // Pattern's. `degraded` is dropped: the degradation is already reported
      // out-of-band by the runtime's `job:alternative-selected` event, which
      // carries this entry's `losses` / `qualityDelta`.
      return {
        modality: 'image',
        assets: out.assets,
        cost: out.cost,
        latencyMs: out.latencyMs,
        model: out.model,
        provider: out.provider,
      }
    },
  },
}

export function createImageToImagePattern(
  init: ImageToImagePatternInit = {},
): AtomicPattern<ImageToImageInput, ImageToImageOutput> {
  return defineAtomicPattern<ImageToImageInput, ImageToImageOutput>({
    id: IMAGE_TO_IMAGE_PATTERN_ID,
    searchHint: 'modify or restyle an existing image with a prompt',
    exposureMode: 'always-load',
    namespace: 'image-gen',
    exposure: { chatTurn: true, agentLoop: true, canvas: true },
    description:
      'Modify, edit, restyle or transform an existing image guided by a text prompt. Capability: image-to-image. Inpaint / outpaint / style-transfer strategies are driven via input.references slots and typed providerOptions from the derived per-model schema.',
    primary: {
      tool: {
        description:
          'Edit an existing image guided by a text prompt. Use when the user asks to edit, retouch, restyle, recolor, transform, redraw or refine a source picture rather than generate one from scratch.',
        inputs: ImageToImagePrimaryInputSchema,
      },
      modelTags: [],
    },
    outputs: ImageToImageOutputSchema,
    // source[] required (≥1 source image; multi-source fusion covers style
    // transfer); mask (optional single, for inpaint).
    assetNeeds: ASSET_NEEDS,
    alternatives: init.alternatives ?? [VIA_CAPTION_ALTERNATIVE],
  })
}

/** Typed `ctx.step` sugar — dispatch image-to-image from a meta compose(). */
export const imageToImage = createPatternFn<
  ImageToImageInput,
  ImageToImageOutput
>(IMAGE_TO_IMAGE_PATTERN_ID)
