// meta_image-best-of-n — MetaPattern that consumes the
// best-of-n-image-judge skill.
//
// Render N candidate images in parallel via an inner image-gen Pattern
// (text-to-image or image-to-image), then VLM-judge with the
// best-of-n-image-judge prompt acting as the image-to-text system, and pick
// the winning candidate handle. Independent of the long-form video pipeline —
// any caller (chat user, agent, other meta) can use it as a quality gate on
// top of any image-gen.
//
// Design notes:
//  - Each fan-out call passes `stepOptions.stepId` so stepCache does not
//    collapse N "identical" dispatches into one.
//  - Judge call uses `image-to-text` multi-image input (the worker supports
//    multi-image + structured output).
//  - The judge prompt is inlined as a string constant in ./prompts. This meta
//    is self-contained for its prompt: nothing is loaded at dispatch, no host
//    binding for prompt loading.

import { z } from 'zod'
import type { MetaPattern } from '@orchestral/core'
import { createPatternFn, metaEnvelopeShape, parallel } from '@orchestral/core'
import { imageToText } from '../../atomic/image-to-text'
import {
  textToImage,
  type TextToImageInput,
  type TextToImageOutput,
} from '../../atomic/text-to-image'
import {
  imageToImage,
  type ImageToImageInput,
  type ImageToImageOutput,
} from '../../atomic/image-to-image'
import { BEST_OF_N_IMAGE_JUDGE_PROMPT } from './prompts'
import { firstAssetId, resolvePrompts, sumCosts, toJsonSchemaCached } from '../_shared/meta-utils'

// VLM judge response shape (matches the best-of-n-image-judge output section).
const BestOfNJudgeResponseSchema = z.object({
  best_image_index: z
    .number()
    .int()
    .min(0)
    .describe('0-based index into the candidate sequence (length must equal n).'),
  reason: z
    .string()
    .describe('Short explanation of why the chosen candidate won.'),
})

// ── input / output ──────────────────────────────────────────────────────

const InnerImagePatternIds = ['text-to-image', 'image-to-image'] as const

export const ImageBestOfNInputSchema = z.object({
  innerPatternId: z
    .enum(InnerImagePatternIds)
    .describe('Which image-gen atomic Pattern to fan out across N samples.'),
  innerInput: z
    .unknown()
    .describe(
      'Input forwarded verbatim to each inner Pattern dispatch. Must validate against the chosen innerPatternId schema (text-to-image or image-to-image input).',
    ),
  n: z
    .number()
    .int()
    .min(2)
    .max(8)
    .describe(
      'Number of candidate samples to draw. Typical 2-4; capped at 8 to keep judge prompt manageable.',
    ),
  targetDescription: z
    .string()
    .min(1)
    .describe(
      'Free-form description of what the winning image should look / feel like. Passed to the VLM judge as part of the user message.',
    ),
  referenceHandles: z
    .array(z.string())
    .optional()
    .describe(
      'Optional ground-truth reference image handles the judge compares each candidate against (character / spatial consistency). When present, these images are passed to the judge ahead of the candidates and labelled "Reference Image 0..". Omit for pure description-fidelity judging.',
    ),
  refDescriptions: z
    .array(z.string())
    .optional()
    .describe(
      'Optional captions paired by index with referenceHandles — e.g. "protagonist front view". Used to label each reference image in the judge prompt. Ignored when referenceHandles is absent.',
    ),
})
export type ImageBestOfNInput = z.infer<typeof ImageBestOfNInputSchema>

export const ImageBestOfNOutputSchema = z.object({
  winningAssetId: z
    .string()
    .describe('Asset id of the candidate the VLM judge selected.'),
  reason: z.string().describe('Judge rationale (verbatim from VLM).'),
  allCandidates: z
    .array(z.string())
    .readonly()
    .describe(
      'Asset ids of every generated candidate in submission order (idx 0..n-1), so a downstream human-in-the-loop reviewer can override.',
    ),
  cost: metaEnvelopeShape.cost.describe(
    'USD cost summed across all N image-gen calls + 1 judge call.',
  ),
  latencyMs: metaEnvelopeShape.latencyMs
    .int()
    .min(0)
    .describe(
      'Wall-clock latency: max(N parallel inner dispatch latencies) + judge latency.',
    ),
})
export type ImageBestOfNOutput = z.infer<typeof ImageBestOfNOutputSchema>

export const IMAGE_BEST_OF_N_PATTERN_ID = 'meta_image-best-of-n'

/** Typed `ctx.step` sugar — dispatch this meta from another meta's compose(). */
export const imageBestOfNMeta = createPatternFn<
  ImageBestOfNInput,
  ImageBestOfNOutput
>(IMAGE_BEST_OF_N_PATTERN_ID)

// ── factory ──────────────────────────────────────────────────────────────

/**
 * @alpha
 * Default system prompt for meta_image-best-of-n's VLM judge. Consumers
 * override via `ImageBestOfNMetaInit.prompts`; the unset key falls back to
 * this.
 */
export const IMAGE_BEST_OF_N_DEFAULT_PROMPTS = Object.freeze({
  bestOfNImageJudge: BEST_OF_N_IMAGE_JUDGE_PROMPT,
})

/** @alpha Per-step prompt overrides for meta_image-best-of-n. */
export type ImageBestOfNPromptOverrides = Partial<
  Record<keyof typeof IMAGE_BEST_OF_N_DEFAULT_PROMPTS, string>
>

/** @alpha Optional init for meta_image-best-of-n (prompt overrides only). */
export type ImageBestOfNMetaInit = {
  prompts?: ImageBestOfNPromptOverrides
}

/** @alpha */
export function createImageBestOfNMeta(
  init: ImageBestOfNMetaInit = {},
): MetaPattern<ImageBestOfNInput, ImageBestOfNOutput> {
  const resolved = resolvePrompts(IMAGE_BEST_OF_N_DEFAULT_PROMPTS, init.prompts)
  return {
    id: IMAGE_BEST_OF_N_PATTERN_ID,
    kind: 'meta',
    searchHint:
      'render multiple image candidates and pick the best via VLM quality judging',
    namespace: 'meta-pipelines',
    description:
      'Quality gate on top of any image-gen Pattern: fan out N parallel samples through text-to-image or image-to-image, then use a VLM judge with the best-of-n-image-judge skill to select the strongest candidate by character consistency, spatial consistency, and description fidelity.',
    tool: {
      description:
        'Render multiple image candidates and pick the best one via VLM quality judging. Use when a single t2i / i2i call risks under-delivering (face drift, missing detail, off-style) and you can afford 2-4× the cost for a quality lift. Caller picks the inner Pattern (text-to-image or image-to-image) and forwards its input; the meta handles fan-out, judging, and selection.',
      inputs: ImageBestOfNInputSchema,
    },
    outputs: ImageBestOfNOutputSchema,
    async compose(params, ctx): Promise<ImageBestOfNOutput> {
      const { input } = params

      // Stage 1 — fan-out N independent samples.
      //
      // An explicit stepId per sample (`candidate-${idx}`) is essential. Step
      // identity is positional, not content-addressed — the runtime keys a step
      // by its stepId, and the default id is a sequential counter — precisely
      // so that N dispatches of the SAME patternId + SAME input stay N distinct
      // samples. A content key would collapse them into one; the positional
      // key is the correct semantics for sampling, and the explicit override
      // is what keeps the N ids stable across a resume (a counter-minted id
      // would shift if anything before the fan-out changed).
      const candidateOutputs = await parallel(
        Array.from({ length: input.n }, (_, idx) =>
          dispatchInner(ctx, input.innerPatternId, input.innerInput, idx),
        ),
      )
      const candidateIds = candidateOutputs.map((out) =>
        firstAssetId(out, 'meta_image-best-of-n: inner image-gen'),
      )
      const candidateLatencyMs = candidateOutputs.reduce(
        (max, out) => Math.max(max, out.latencyMs),
        0,
      )

      // Stage 2 — VLM judge picks the winner.
      //
      // Candidates flow to the judge by assetId through the internal-asset
      // channel (ref.assets), slot 'source' (image-to-text assetNeeds: source[]).
      // assetsForSlot preserves array order, so the judge sees candidates as
      // "Generated Image 0..N-1" and best_image_index indexes candidateIds
      // directly (candidate-relative, per the judge's output spec).
      //
      // referenceHandles (optional ground-truth comparison images) ride the
      // LLM-facing handle channel (input.references.source). Resolution keys off
      // the JUDGE sub-step's assetNeeds, not this meta's: image-to-text declares
      // a `source` slot, so the runtime's handle-resolution pass turns each
      // handle into a real assetId keyed to the dispatch's ledger context, then
      // merges that resolved set into the SAME 'source' slot as the candidates, ahead
      // of them, so the judge sees "Reference Image 0..M-1" then "Generated
      // Image 0..N-1" in the exact order buildJudgePrompt labels them.
      // (Candidates ride the internal ref.assets channel; references ride the
      // handle channel; the two meet in the runtime's same-slot merge.)
      const referenceHandles = input.referenceHandles ?? []
      const judgeOut = await imageToText(
        ctx,
        {
          system: resolved.bestOfNImageJudge,
          prompt: buildJudgePrompt(
            input.targetDescription,
            referenceHandles.length,
            input.refDescriptions ?? [],
            input.n,
          ),
          ...(referenceHandles.length > 0
            ? { references: { source: referenceHandles } }
            : {}),
          responseFormat: 'json',
          jsonSchema: toJsonSchemaCached(BestOfNJudgeResponseSchema),
        },
        {
          assets: candidateIds.map((assetId) => ({
            slot: 'source',
            assetId,
            modality: 'image' as const,
          })),
        },
      )

      // Parse strictly: if the judge returns out-of-range index or malformed
      // JSON, fail fast (no silent fallback to candidate 0 — that would mask
      // a model regression).
      const parsed = BestOfNJudgeResponseSchema.parse(
        JSON.parse(judgeOut.text),
      )
      if (parsed.best_image_index >= input.n) {
        throw new Error(
          `meta_image-best-of-n: judge returned best_image_index=${parsed.best_image_index} but only ${input.n} candidates exist`,
        )
      }

      return {
        winningAssetId: candidateIds[parsed.best_image_index]!,
        reason: parsed.reason,
        allCandidates: candidateIds,
        cost: sumCosts([...candidateOutputs.map((c) => c.cost), judgeOut.cost]),
        latencyMs: candidateLatencyMs + judgeOut.latencyMs,
      }
    },
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

type InnerImageOutput = TextToImageOutput | ImageToImageOutput

async function dispatchInner(
  ctx: Parameters<
    NonNullable<MetaPattern<ImageBestOfNInput, ImageBestOfNOutput>['compose']>
  >[1],
  innerPatternId: (typeof InnerImagePatternIds)[number],
  innerInput: unknown,
  candidateIdx: number,
): Promise<InnerImageOutput> {
  if (innerPatternId === 'text-to-image') {
    return textToImage(ctx, innerInput as TextToImageInput, {
      stepId: `candidate-${candidateIdx}`,
    })
  }
  return imageToImage(ctx, innerInput as ImageToImageInput, {
    stepId: `candidate-${candidateIdx}`,
  })
}

function buildJudgePrompt(
  targetDescription: string,
  referenceCount: number,
  refDescriptions: readonly string[],
  candidateCount: number,
): string {
  // One "Reference Image i:" label per actual reference image (referenceCount,
  // not refDescriptions.length) so the text labels line up 1:1 with the images
  // prepended to the source slot. Captions are best-effort — a reference with
  // no caption still gets a label so the image/label count stays aligned.
  const refSection =
    referenceCount > 0
      ? Array.from(
          { length: referenceCount },
          (_, i) =>
            `Reference Image ${i}: ${refDescriptions[i] ?? '(no caption)'}`,
        ).join('\n') + '\n\n'
      : ''
  const candidateSection = Array.from(
    { length: candidateCount },
    (_, i) => `Generated Image ${i}`,
  ).join('\n')
  // Reinforce the candidate-relative index contract — with references
  // prepended, a model could otherwise return a full-array index.
  const indexHint =
    referenceCount > 0
      ? '\n\nReturn best_image_index as a 0-based index among the Generated Images only (0..' +
        String(candidateCount - 1) +
        '), not counting the Reference Images.'
      : ''
  return (
    refSection +
    candidateSection +
    '\n\n' +
    `<TARGET_DESCRIPTION_START>\n${targetDescription}\n<TARGET_DESCRIPTION_END>` +
    indexHint
  )
}
