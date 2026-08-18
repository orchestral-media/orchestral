// text-generation — Pattern factory. Pattern : Capability = 1:1
// (capability 'text-generation'). Primary-only — `responseFormat` (text vs
// json) and `jsonSchema` are INPUT FIELDS, not strategy branches; they share
// the same LLM call shape so a JSON request still routes to the same
// candidate set.
//
// Scope: one-shot completion (prompt rewrite, summarize, translate,
// classify, extract JSON). Multi-turn conversation is handled by the
// host's agent loop (not a Pattern).

import { z } from 'zod'
import { createPatternFn, defineAtomicPattern, dispatchEnvelopeShape, type AtomicPattern, type Alternative } from '@orchestral/core'

// ── primary input schema ────────────────────────────────────────────────

// - maxTokens → maxOutputTokens (matches ai-sdk v5+ generateText naming)
// - added topK (standard Anthropic / Gemini sampling parameter)
// - added providerOptions (passes through provider-specific fields like
//   anthropic.thinking)

export const TextGenerationPrimaryInputSchema = z.object({
  prompt: z
    .string()
    .min(1, 'prompt required')
    .describe('User-facing prompt sent to the LLM.'),
  system: z
    .string()
    .optional()
    .describe(
      'Optional system preamble; provider-specific role mapping handled by host.',
    ),
  maxOutputTokens: z
    .number()
    .int()
    .min(1)
    .max(128_000)
    .default(2048)
    .describe('Hard cap on generated tokens (ai-sdk v5+ naming).'),
  temperature: z
    .number()
    .min(0)
    .max(2)
    .default(0.7)
    .describe('Sampling temperature; 0 = deterministic, higher = more random.'),
  topP: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      'Nucleus sampling threshold; mutually exclusive with temperature on some providers.',
    ),
  topK: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Top-K sampling (Anthropic / Gemini). Number of highest-probability tokens to consider.',
    ),
  stopSequences: z
    .array(z.string())
    .optional()
    .describe('Strings that end generation when produced verbatim.'),
  responseFormat: z
    .enum(['text', 'json'])
    .default('text')
    .describe(
      'text = plain completion; json = provider-enforced structured output.',
    ),
  jsonSchema: z
    .unknown()
    .optional()
    .describe(
      'Opaque JSON schema constraining `responseFormat: json` output. Shape varies per provider (Anthropic tool-use, OpenAI response_format json_schema, Gemini responseSchema); runtime adapter normalizes per call.',
    ),
  // `providerOptions` placeholder removed — derive injects a typed schema at
  // find_pattern render time based on the resolved model (e.g. Anthropic
  // thinking config, OpenAI reasoning effort).
})

export type TextGenerationInput = z.infer<
  typeof TextGenerationPrimaryInputSchema
>

// ── outputs ─────────────────────────────────────────────────────────────

// outputs.modality literal.
export const TextGenerationOutputSchema = z.object({
  modality: z.literal('text'),
  text: z.string().describe('Generated text body.'),
  ...dispatchEnvelopeShape,
  usage: z
    .object({
      inputTokens: z.number().int().min(0),
      outputTokens: z.number().int().min(0),
    })
    .optional()
    .describe('Token accounting; provider may omit when not reported.'),
  finishReason: z
    .enum(['stop', 'length', 'content_filter', 'tool_calls', 'other'])
    .optional()
    .describe('Why generation stopped; provider may omit.'),
})

export type TextGenerationOutput = z.infer<typeof TextGenerationOutputSchema>

// ── Pattern factory ─────────────────────────────────────────────────────

export const TEXT_GENERATION_PATTERN_ID = 'text-generation'

export interface TextGenerationPatternInit {
  /** Cross-Pattern fallback (rare for text-generation, but symmetric). */
  alternatives?: readonly Alternative<
    TextGenerationInput,
    TextGenerationOutput
  >[]
}

export function createTextGenerationPattern(
  init: TextGenerationPatternInit = {},
): AtomicPattern<TextGenerationInput, TextGenerationOutput> {
  return defineAtomicPattern<TextGenerationInput, TextGenerationOutput>({
    id: TEXT_GENERATION_PATTERN_ID,
    searchHint: 'rewrite, summarize, translate or extract structured JSON',
    namespace: 'text-gen',
    description:
      'Generate text from a single prompt: rewrite, summarize, translate, classify, or extract structured JSON. Use for one-shot text transformations. Multi-turn chat is handled by the host agent loop, not by this Pattern. Switch between plain text and structured JSON via the `responseFormat` input field.',
    primary: {
      tool: {
        description:
          'Generate text from a single prompt. Use when the user asks to rewrite, summarize, translate, classify, extract, or otherwise transform text in a single shot. Set `responseFormat: "json"` (and optionally `jsonSchema`) when a structured object is required; default `text` produces a plain string completion.',
        inputs: TextGenerationPrimaryInputSchema,
      },
      modelTags: [],
    },
    outputs: TextGenerationOutputSchema,
    // No first-party default: the catalog's other two text producers read media
    // this caller has not got — image-to-text needs an image, ASR needs a
    // recording. A prompt-only completion has nothing to degrade into.
    alternatives: init.alternatives,
    // text-generation takes no asset input (no assetNeeds).
  })
}

// The dispatch-facing input uses the zod INPUT type (schema-`.default()` fields
// stay optional — the sub-step dispatch path applies no parse, so a meta fills
// only what it means to set and the resolved model adapter supplies the rest).
type TextGenerationDispatchInput = z.input<typeof TextGenerationPrimaryInputSchema>

/** Typed `ctx.step` sugar — dispatch text-generation from a meta compose(). */
export const textGeneration = createPatternFn<
  TextGenerationDispatchInput,
  TextGenerationOutput
>(TEXT_GENERATION_PATTERN_ID)
