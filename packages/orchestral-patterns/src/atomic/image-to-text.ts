// image-to-text — Pattern factory.
//
// Covers the full HF `image-to-text` task plus the modern `image-text-to-text`
// (multi-image VLM) usage. The two HF labels were split in 2024 for model
// discovery purposes (encoder-decoder captioners vs decoder-only VLMs), but
// every modern provider API (Anthropic / OpenAI / Gemini / Llama-vision)
// exposes one shape: `image[] + text → text`. We collapse them
// onto one atomic. If future work needs Router routing between caption-only
// models and multimodal VLMs, that is a modelTags routing concern,
// not a separate atomic Pattern.
//
// Sub-task variation is an INPUT concern (mode / prompt / responseFormat), not
// a strategy branch. Primary-only.

import { z } from 'zod'
import { createPatternFn, defineAtomicPattern, dispatchEnvelopeShape, type AtomicPattern, type Alternative, type AssetNeed, type DerivedReferences } from '@orchestral/core'

// ── primary input schema ────────────────────────────────────────────────

// image-to-text runs through a vision-LLM (the chat path). This Pattern does
// not call the ai-sdk generateText function directly; it goes through the host
// process's vision LLM call, but the interface shape follows the providerOptions
// forwarding convention. mode is a cross-provider abstraction (caption /
// describe / judge / extract-style) and is kept LLM-facing.

export const ImageToTextPrimaryInputSchema = z.object({
  mode: z
    .enum(['caption', 'describe', 'judge', 'extract-style'])
    .default('caption')
    .describe(
      'Task mode for caption-style usage. caption = short one-line caption; describe = multi-sentence description; judge = VLM-as-judge scoring / evaluation; extract-style = style / aesthetic feature extraction. Ignored when `system` is provided.',
    ),
  maxLength: z
    .number()
    .int()
    .min(10)
    .max(2048)
    .default(256)
    .describe('Soft cap on output length in characters.'),
  system: z
    .string()
    .optional()
    .describe(
      'Optional system preamble (e.g. a SKILL.md body fed by a meta Pattern). When provided, the host adapter sends this to the provider system slot and ignores the mode-default system text.',
    ),
  prompt: z
    .string()
    .optional()
    .describe(
      'Optional user-message instruction sent alongside the image(s). Examples: "Describe in one sentence.", "What art style is this?", "Which of these candidates best matches the target?". When `system` is absent, this also overrides the mode-default system text (legacy behavior).',
    ),
  responseFormat: z
    .enum(['text', 'json'])
    .default('text')
    .describe('text = plain answer; json = provider-enforced structured output.'),
  jsonSchema: z
    .unknown()
    .optional()
    .describe(
      'Opaque JSON schema constraining `responseFormat: json` output; runtime adapter normalizes per provider.',
    ),
  // `providerOptions` placeholder removed — derive injects typed schema at
  // find_pattern render time based on the resolved model (e.g. Anthropic
  // thinking, OpenAI reasoning_effort).
})

const ASSET_NEEDS = [
  {
    slot: 'source',
    modality: 'image',
    cardinality: 'array',
    required: true,
    description:
      'The image(s) to read — a single handle for caption / describe / OCR, or an array for multi-image comparison / grounded reasoning.',
  },
] as const satisfies readonly AssetNeed[]

export type ImageToTextInput = z.infer<typeof ImageToTextPrimaryInputSchema> & {
  references?: DerivedReferences<typeof ASSET_NEEDS>
}

// ── outputs ───────────────────────────────────────────────────────────────

// outputs.modality literal (text output).
export const ImageToTextOutputSchema = z.object({
  modality: z.literal('text'),
  text: z.string().describe("The VLM's textual output."),
  ...dispatchEnvelopeShape,
})

export type ImageToTextOutput = z.infer<typeof ImageToTextOutputSchema>

// ── Pattern factory ─────────────────────────────────────────────────────

export const IMAGE_TO_TEXT_PATTERN_ID = 'image-to-text'

export interface ImageToTextPatternInit {
  alternatives?: readonly Alternative<ImageToTextInput, ImageToTextOutput>[]
}

export function createImageToTextPattern(
  init: ImageToTextPatternInit = {},
): AtomicPattern<ImageToTextInput, ImageToTextOutput> {
  return defineAtomicPattern<ImageToTextInput, ImageToTextOutput>({
    id: IMAGE_TO_TEXT_PATTERN_ID,
    searchHint: 'describe an image or extract text via OCR',
    namespace: 'text-gen',
    exposure: { chatTurn: true, agentLoop: true, canvas: true },
    description:
      'Read one or more images and produce text about them: caption, describe, extract style features, act as a VLM judge, or answer an open-ended question grounded in the image(s). Capability: image-to-text. Primary-only Pattern — task variation is expressed via the `mode` / `system` / `prompt` / `responseFormat` input fields, not strategy variants.',
    primary: {
      tool: {
        description:
          'Read one or more images and produce text about them. Use when the user asks to caption, describe, summarise, label, tag, analyse, critique, score, compare, select-among, or extract structured information from an existing picture or set of pictures. Single-image cases set `mode` (caption / describe / judge / extract-style); open-ended or multi-image cases set `system` + `prompt` and (optionally) `responseFormat: "json"` with a `jsonSchema` for typed output.',
        inputs: ImageToTextPrimaryInputSchema,
      },
      modelTags: [],
    },
    outputs: ImageToTextOutputSchema,
    // No first-party default: nothing else in the catalog looks at pixels. This
    // pattern IS the media→text bridge the one shipped degradation path is built
    // on (see image-to-image's `via-caption`), so there is no second reader to
    // fall back to — text-generation would answer from the prompt alone and
    // describe an image it never saw.
    alternatives: init.alternatives,
    // source required, one or more images. Output is text, so no
    // outputs.assets[] (only declares the input need). Adapter contract: read
    // the `source` slot as an ARRAY (multi-image comparison is a first-class
    // case, e.g. meta_image-best-of-n), and forward `system` / `responseFormat`
    // / `jsonSchema` to the vision-LLM call — an adapter that only honours the
    // first image, or drops the structured-output fields, silently answers a
    // different question than the caller asked.
    assetNeeds: ASSET_NEEDS,
  })
}

// Dispatch-facing input: zod INPUT type (schema `.default()` fields optional —
// the sub-step path applies no parse) plus the derived-references channel.
type ImageToTextDispatchInput = z.input<
  typeof ImageToTextPrimaryInputSchema
> & { references?: DerivedReferences<typeof ASSET_NEEDS> }

/** Typed `ctx.step` sugar — dispatch image-to-text from a meta compose(). */
export const imageToText = createPatternFn<
  ImageToTextDispatchInput,
  ImageToTextOutput
>(IMAGE_TO_TEXT_PATTERN_ID)
