// meta_image-to-image-via-caption — MetaPattern.
//
// Approximates an image edit when no native image-to-image model is available
// by chaining image-to-text → text-to-image. Loses subject and composition
// fidelity (only style descriptors survive the caption round-trip); the
// `degraded: true` output flag surfaces this tradeoff to the UI.
//
// Composition model:
//   • compose() is a plain `async (params, ctx) => Promise<O>` (no MetaPlan)
//   • ctx.step orchestrates 2 sub-steps; the previous step's output feeds
//     directly into the next step's input (typed State between steps)
//   • Pattern id uses the underscore prefix: 'meta_image-to-image-via-caption'
//
// Input mirrors the relevant subset of `image-to-image` so this Meta slots
// cleanly into that Pattern's `alternatives[]` via declarative redirect.

import { z } from 'zod'
import {
  boundedText,
  extendInputsWithReferences,
  metaEnvelopeShape,
  producedAssetShape,
  type AssetNeed,
  type DerivedReferences,
  type MetaPattern,
} from '@orchestral/core'
import { sumCosts } from '../meta/_shared/meta-utils'
import { imageToText } from './image-to-text'
import { textToImage } from './text-to-image'

// ── Schemas ─────────────────────────────────────────────────────────────

// The meta tool adds a providerOptions fallback entry, forwarded to the t2i sub-step.
export const ImageToImageViaCaptionInputSchema = z.object({
  editPrompt: z
    .string()
    .min(1, 'editPrompt required')
    .describe('Natural-language description of the desired edit.'),
  tier: z
    .enum(['preview', 'final'])
    .default('preview')
    .describe(
      'Output quality tier. Sets the `size` the text-to-image step requests: preview = 1024x1024 draft, final = 2048x2048 render.',
    ),
  providerOptions: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Provider-specific extras forwarded to the final text-to-image step.',
    ),
})

export type ImageToImageViaCaptionInput = z.infer<
  typeof ImageToImageViaCaptionInputSchema
> & { references?: DerivedReferences<typeof ASSET_NEEDS> }

// outputs.modality literal.
// Produced media is carried in `assets[]` (the legacy single assetId / imageUrl
// fields were removed). The final t2i step's assets[] are forwarded verbatim
// (no handle — the canonical handle is attached by the host from the
// SessionAssetStore after it records the asset).
export const ImageToImageViaCaptionOutputSchema = z.object({
  modality: z.literal('image'),
  assets: z
    .array(z.object(producedAssetShape('image')))
    .describe('Produced images forwarded from the final text-to-image step.'),
  cost: metaEnvelopeShape.cost.describe('USD cost summed across the chain.'),
  latencyMs: metaEnvelopeShape.latencyMs
    .int()
    .min(0)
    .describe('Wall-clock latency summed across the chain.'),
  model: z
    .string()
    .describe('Resolved provider:modelId of the final text-to-image step.'),
  provider: z.string(),
  /**
   * The "WIDTHxHEIGHT" the render step was asked for, derived from `tier`.
   * Render size travels on text-to-image's top-level `ImageGenerationParams`
   * channel, which an adapter is free to ignore — it then returns its own
   * default resolution with no error. Echoing the request here is what makes
   * that discrepancy detectable instead of a silent downgrade. `compose()`
   * always sets it; optional so the shape stays parseable for callers
   * assembling this output from elsewhere.
   *
   * Bounded per the output-field vocabulary: a "WIDTHxHEIGHT" pair is ~9
   * characters even at 8K, so 32 is generous and still makes a blob
   * unrepresentable here.
   */
  requestedSize: boundedText(32).optional(),
  /**
   * Always true for this path — runtime injects it to signal that subject /
   * composition fidelity was lost (only style descriptors survived the
   * caption round-trip). UIs surface a degradation notice.
   */
  degraded: z.literal(true),
})

export type ImageToImageViaCaptionOutput = z.infer<
  typeof ImageToImageViaCaptionOutputSchema
>

// ── Meta factory ────────────────────────────────────────────────────────

export const IMAGE_TO_IMAGE_VIA_CAPTION_PATTERN_ID =
  'meta_image-to-image-via-caption'

// source required (the image(s) to edit); feeds the caption sub-step. The
// resolution pass lands the real assetIds in ctx.assets. Hoisted so the same
// list feeds both the Pattern field and the derived `references` injection
// below (single source of truth).
//
// Cardinality is `array` because both neighbours are: image-to-image declares
// `source` as an array and its via-caption redirect forwards the parent's
// resolved assets verbatim, and the caption sub-step (image-to-text) reads an
// array too. compose() passes every `source` ref through, so a `single`
// declaration here would reject multi-source callers the chain otherwise
// serves end to end.
const ASSET_NEEDS = [
  {
    slot: 'source',
    modality: 'image',
    cardinality: 'array',
    required: true,
    description:
      'The image(s) to edit — captioned together, then regenerated from that caption round-trip (subject identity is not preserved).',
  },
] as const satisfies readonly AssetNeed[]

/**
 * Build the Meta. Returned object literal is typed against
 * `MetaPattern<I, O>` directly. Host-injected context (projectId /
 * providerOptions) + the resolved source image flow through `ctx`,
 * not a typed `bindings` param.
 * @alpha
 */
export function createImageToImageViaCaptionPattern(): MetaPattern<
  ImageToImageViaCaptionInput,
  ImageToImageViaCaptionOutput
> {
  return {
    id: IMAGE_TO_IMAGE_VIA_CAPTION_PATTERN_ID,
    kind: 'meta',
    searchHint: 'edit an image via caption fallback chain',
    namespace: 'meta-pipelines',
    description:
      'Approximate an image edit when no native image-to-image model is available: caption the source image, then text-to-image the caption combined with the edit instruction. Loses subject and composition fidelity — only style descriptors survive. Runtime sets `degraded: true` on the output.',
    tool: {
      description:
        'Edit an image without a native image-to-image model by chaining caption → text-to-image. Use as a degraded fallback when the user wants to modify an image but no identity-preserving / image-to-image model is available. Subject identity and composition will NOT be preserved.',
      // Meta literals have no ctor — inject here (semantics on the helper's JSDoc).
      inputs: extendInputsWithReferences(
        IMAGE_TO_IMAGE_VIA_CAPTION_PATTERN_ID,
        ImageToImageViaCaptionInputSchema,
        ASSET_NEEDS,
      ),
    },
    outputs: ImageToImageViaCaptionOutputSchema,
    assetNeeds: ASSET_NEEDS,
    async compose(params, ctx): Promise<ImageToImageViaCaptionOutput> {
      const { input } = params
      // tier drives the render resolution requested from the text-to-image
      // step. A machine caller that omits it gets the draft size — the sub-step
      // path applies no schema parse, so the zod `.default()` never runs here.
      const requestedSize = input.tier === 'final' ? '2048x2048' : '1024x1024'

      // Step 0 — caption / describe the source image.
      //
      // The source arrives on `ctx.assets`: either the host's resolution pass
      // for this meta's own `source` need, or — on the image-to-image redirect
      // path — the parent's resolved assets forwarded verbatim. It does NOT
      // reach the caption step by itself; a sub-step's context starts empty, so
      // whatever is not handed to `imageToText` here is simply not there and the
      // VLM captions nothing.
      //
      // Every source ref rides the internal channel (`ref.assets`), verbatim —
      // assetId always present, `handle` preserved where the ref has one so the
      // host can still translate it into the child-context announcement. The
      // internal channel is the only one that works in every wiring: the handle
      // channel (`input.references`) needs a host bridge plus a context id, and
      // this meta cannot see whether the runtime has either. The runtime
      // exempts internally-covered slots from the resolver's
      // omitted-required-slot default rule, so passing no `references` here
      // cannot pull an unrelated "latest of modality" ledger asset in.
      //
      // `mask` is deliberately not forwarded: this path regenerates the whole
      // frame from a caption, so a masked-edit region has nothing to apply to.
      // image-to-image's alternative declares that as the `mask-guidance` loss.
      const sourceRefs = (ctx.assets ?? []).filter((a) => a.slot === 'source')

      const caption = await imageToText(
        ctx,
        {
          mode: 'describe' as const,
          maxLength: 512,
          prompt:
            'Describe this image in detail for use as a basis for editing.',
        },
        sourceRefs.length > 0 ? { assets: sourceRefs } : undefined,
      )

      // Step 1 — text-to-image with caption + editPrompt (typed State!).
      // caption.text is fed straight into this step's input.
      // `size` / `n` ride text-to-image's top-level ImageGenerationParams
      // channel — the machine-to-machine equivalent of the per-model params an
      // LLM caller fills from the derived schema. An adapter that ignores
      // `size` renders at its own default instead, which is why the requested
      // size is echoed on the output below rather than assumed. providerOptions
      // is forwarded from the meta input (an explicit meta override wins over
      // the meta fallback).
      const image = await textToImage(ctx, {
        prompt: `${caption.text}\n\nEdit instruction: ${input.editPrompt}`,
        size: requestedSize,
        n: 1,
        ...(input.providerOptions !== undefined
          ? { providerOptions: input.providerOptions }
          : {}),
      })

      return {
        modality: 'image' as const,
        // Forward the final t2i step's produced assets[] verbatim (assetId +
        // modality; no handle — host attaches the canonical handle after record).
        // t2i now only produces assets[].
        assets: image.assets ?? [],
        cost: sumCosts(caption, image),
        latencyMs: caption.latencyMs + image.latencyMs,
        model: image.model,
        provider: image.provider,
        requestedSize,
        degraded: true as const,
      }
    },
  }
}
