// meta_reference-image-cascade — MetaPattern.
//
// Pick the best reference images for a target frame, in up to two stages:
//   1. (only when candidates ≥ 8) reference-image-prefilter — TEXT-ONLY pass
//      over the candidate descriptions, narrows the set. → text-generation.
//   2. reference-image-multimodal-select — VLM pass over the (narrowed) images.
//      → image-to-text, declared with the multi-image + structured output
//      shape (`references.source: string[]` + `responseFormat: 'json'`).
// Returns the selected image handles + a generated text prompt.
//
// The two stage prompts are inlined as string constants in ./prompts. This
// meta is self-contained: nothing is loaded at dispatch, no host binding — the
// prompts ship with the pattern. This meta
// has no assetNeeds of its own: candidate image
// handles arrive in `input.candidates[].ref` and are forwarded to the
// image-to-text sub-step, which declares the `source` asset need and resolves
// them at its own dispatch boundary.

import { z } from 'zod'
import type { MetaPattern } from '@orchestral/core'
import { metaEnvelopeShape } from '@orchestral/core'
import { resolvePrompts, sumCosts, toJsonSchemaCached } from '../_shared/meta-utils'
import { textGeneration } from '../../atomic/text-generation'
import { imageToText } from '../../atomic/image-to-text'
import {
  REFERENCE_IMAGE_PREFILTER_PROMPT,
  REFERENCE_IMAGE_MULTIMODAL_SELECT_PROMPT,
} from './prompts'

// Prefilter only runs for large candidate sets (the text-only pass is
// cheap, but invoking it on small sets wastes a roundtrip).
const PREFILTER_THRESHOLD = 8

// Stage response shape — shared by both stages.
const RefSelectionResponseSchema = z.object({
  ref_image_indices: z.array(z.number().int().min(0)),
  text_prompt: z.string(),
})

const CandidateSchema = z.object({
  ref: z.string().describe('Asset handle of the candidate reference image.'),
  text: z.string().describe('Short text description of the candidate image.'),
})

export const ReferenceImageCascadeInputSchema = z.object({
  frameDescription: z
    .string()
    .min(1, 'frameDescription required')
    .describe('Text description of the target frame the references must match.'),
  candidates: z
    .array(CandidateSchema)
    .min(1, 'at least one candidate required')
    .describe('Available reference images (handle + description) to choose from.'),
})
export type ReferenceImageCascadeInput = z.infer<
  typeof ReferenceImageCascadeInputSchema
>

export const ReferenceImageCascadeOutputSchema = z.object({
  selectedRefs: z
    .array(z.string())
    .describe('Asset handles of the chosen reference images, in selection order.'),
  textPrompt: z
    .string()
    .describe('Generated guidance prompt describing how to use the references.'),
  ...metaEnvelopeShape,
})
export type ReferenceImageCascadeOutput = z.infer<
  typeof ReferenceImageCascadeOutputSchema
>

export const REFERENCE_IMAGE_CASCADE_PATTERN_ID = 'meta_reference-image-cascade'

/**
 * Render the candidate list into the block shape each stage prompt declares.
 * Both prompts index candidates as `Image {i}:` from 0 and read them out of a
 * named wrapper — `<SEQ_DESC>` for the text-only prefilter, `<SEQ_IMAGES>` for
 * the multimodal pass — and both return indices into exactly that numbering.
 */
function buildStagePrompt(
  frameDescription: string,
  candidates: readonly { text: string }[],
  seqTag: 'SEQ_DESC' | 'SEQ_IMAGES',
): string {
  const list = candidates.map((c, i) => `Image ${i}: ${c.text}`).join('\n')
  return `<FRAME_DESC>\n${frameDescription}\n</FRAME_DESC>\n\n<${seqTag}>\n${list}\n</${seqTag}>`
}

/** Keep only valid in-range indices, preserving the model's order. */
function validIndices(raw: readonly number[], len: number): number[] {
  return raw.filter((i) => Number.isInteger(i) && i >= 0 && i < len)
}

/**
 * @alpha
 * Default system prompts for meta_reference-image-cascade (text prefilter +
 * multimodal selection). Consumers override via
 * `ReferenceImageCascadeMetaInit.prompts`; unset keys fall back to these.
 */
export const REFERENCE_IMAGE_CASCADE_DEFAULT_PROMPTS = Object.freeze({
  referenceImagePrefilter: REFERENCE_IMAGE_PREFILTER_PROMPT,
  referenceImageMultimodalSelect: REFERENCE_IMAGE_MULTIMODAL_SELECT_PROMPT,
})

/** @alpha Per-step prompt overrides for meta_reference-image-cascade. */
export type ReferenceImageCascadePromptOverrides = Partial<
  Record<keyof typeof REFERENCE_IMAGE_CASCADE_DEFAULT_PROMPTS, string>
>

/**
 * @alpha Optional init for meta_reference-image-cascade (prompt overrides
 * only).
 */
export type ReferenceImageCascadeMetaInit = {
  prompts?: ReferenceImageCascadePromptOverrides
}

/** @alpha */
export function createReferenceImageCascadeMeta(
  init: ReferenceImageCascadeMetaInit = {},
): MetaPattern<ReferenceImageCascadeInput, ReferenceImageCascadeOutput> {
  const resolved = resolvePrompts(
    REFERENCE_IMAGE_CASCADE_DEFAULT_PROMPTS,
    init.prompts,
  )
  return {
    id: REFERENCE_IMAGE_CASCADE_PATTERN_ID,
    kind: 'meta',
    searchHint: 'select and rank the best candidate visuals for a target frame',
    namespace: 'meta-pipelines',
    description:
      'Select the best reference images for a target frame and generate a guidance prompt. Text-only prefilter for large candidate sets, then a multimodal VLM selection.',
    tool: {
      description:
        'Choose which of several candidate images best match a target frame description, and produce a prompt describing how to use them. Narrows large candidate sets by description first, then compares the images visually.',
      inputs: ReferenceImageCascadeInputSchema,
    },
    outputs: ReferenceImageCascadeOutputSchema,
    async compose(params, ctx): Promise<ReferenceImageCascadeOutput> {
      const { input } = params
      const startedAt = Date.now()
      let working = input.candidates
      let prefilterCost = 0

      // Stage 1 — text-only prefilter, only for large candidate sets.
      if (working.length >= PREFILTER_THRESHOLD) {
        const prefiltered = await textGeneration(ctx, {
          system: resolved.referenceImagePrefilter,
          prompt: buildStagePrompt(input.frameDescription, working, 'SEQ_DESC'),
          responseFormat: 'json',
          jsonSchema: toJsonSchemaCached(RefSelectionResponseSchema),
        })
        prefilterCost = sumCosts(prefiltered)
        const picked = validIndices(
          safeIndices(prefiltered.text),
          working.length,
        )
        // Only narrow when the prefilter returned a usable subset; otherwise
        // keep the full set and let Stage 2 decide (non-destructive
        // on prefilter failure).
        if (picked.length > 0) working = picked.map((i) => working[i])
      }

      // Stage 2 — multimodal selection over the (narrowed) candidate images.
      const selected = await imageToText(ctx, {
        system: resolved.referenceImageMultimodalSelect,
        prompt: buildStagePrompt(input.frameDescription, working, 'SEQ_IMAGES'),
        references: { source: working.map((c) => c.ref) },
        responseFormat: 'json',
        jsonSchema: toJsonSchemaCached(RefSelectionResponseSchema),
      })
      const parsed = RefSelectionResponseSchema.parse(JSON.parse(selected.text))
      const finalIdx = validIndices(parsed.ref_image_indices, working.length)

      // Distinguish "model legitimately picked nothing" (empty input) from
      // "model hallucinated all-invalid indices" (non-empty input, all
      // out-of-range). Silently collapsing both to `selectedRefs: []` would
      // hide a real failure mode — downstream callers couldn't tell the
      // difference, and the textPrompt may still look plausible.
      if (parsed.ref_image_indices.length > 0 && finalIdx.length === 0) {
        throw new Error(
          `REFERENCE_SELECTION_INVALID: model returned ${parsed.ref_image_indices.length} indices, all out of range for ${working.length} candidates`,
        )
      }

      return {
        selectedRefs: finalIdx.map((i) => working[i].ref),
        textPrompt: parsed.text_prompt,
        cost: sumCosts({ cost: prefilterCost }, selected),
        latencyMs: Date.now() - startedAt,
      }
    },
  }
}

/** Parse `ref_image_indices` defensively; [] on any parse failure. */
function safeIndices(text: string): number[] {
  try {
    const parsed = RefSelectionResponseSchema.safeParse(JSON.parse(text))
    if (parsed.success) return parsed.data.ref_image_indices
  } catch {
    // fall through — caller treats [] as "no prefilter narrowing"
  }
  return []
}
