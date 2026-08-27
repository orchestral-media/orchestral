// text-generation over the AI SDK's `generateText`.

import {
  type FinishReason,
  generateText,
  type LanguageModel,
  type LanguageModelUsage,
} from 'ai'
import type {
  DispatchContext,
  DispatchResult,
  ModelCapability,
} from '@orchestral/core'

import {
  type AdapterOptions,
  asRecord,
  buildRecord,
  dispatchEnvelope,
  optionalNumber,
  optionalString,
  optionalStringArray,
  providerOptionsFor,
  requireString,
  resolveIdentity,
} from './envelope'
import { readStructuredOutput, structuredText } from './structured-output'

/**
 * A resolved AI SDK language model OBJECT — `LanguageModel` minus the bare
 * `'provider/model-id'` string form the global provider registry accepts.
 * Build one with `openai('gpt-4o-mini')` (or any provider's default export /
 * `.languageModel()` / `.chat()`).
 */
export type LanguageModelInstance = Exclude<LanguageModel, string>

type TextGenerationFinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'tool_calls'
  | 'other'

// The SDK's unified finish reasons onto the pattern's enum. `error` has no
// counterpart there — a generation that "finished by erroring" still handed
// back text, or the SDK would have thrown — and lands on `other`.
const FINISH_REASON: Record<FinishReason, TextGenerationFinishReason> = {
  stop: 'stop',
  length: 'length',
  'content-filter': 'content_filter',
  'tool-calls': 'tool_calls',
  error: 'other',
  other: 'other',
}

// The pattern's `usage` wants both counts as integers; a provider that
// reported only one (or neither) leaves the field off rather than inventing
// a zero.
function usageFor(usage: LanguageModelUsage) {
  const { inputTokens, outputTokens } = usage
  return inputTokens !== undefined && outputTokens !== undefined
    ? { usage: { inputTokens, outputTokens } }
    : {}
}

/**
 * Wrap an AI SDK language model as a `text-generation` `ModelCapability`.
 *
 * Reads off the input every field the first-party pattern declares: `prompt`
 * (required), `system`, the sampling fields that already carry the SDK's own
 * names — `maxOutputTokens`, `temperature`, `topP`, `topK`, `stopSequences` —
 * the structured-output pair `responseFormat` / `jsonSchema`, and a flat
 * `providerOptions`. Returns a `TextGenerationOutput`: `text`, `usage` when
 * the provider reported both token counts, `finishReason` on the pattern's
 * enum, `cost: null`.
 *
 * `responseFormat: 'json'` goes through the SDK's structured output
 * (`Output.object` over the caller's `jsonSchema`, `Output.json` without
 * one); the reply is validated against that schema and lands in `text` as a
 * JSON string — the shape every first-party meta parses. A reply that does
 * not parse or does not match fails the call.
 */
export function fromLanguageModel(
  model: LanguageModelInstance,
  options: AdapterOptions = {},
): ModelCapability {
  const identity = resolveIdentity(model, options)
  return {
    ...buildRecord(identity, options, {
      capability: 'text-generation',
      inputs: ['text'],
      outputs: ['text'],
    }),
    async call<I, O>(input: I, ctx: DispatchContext): Promise<DispatchResult<O>> {
      const fields = asRecord(input)
      const prompt = requireString(fields, 'prompt', 'text-generation')
      const system = optionalString(fields, 'system')
      const maxOutputTokens = optionalNumber(fields, 'maxOutputTokens')
      const temperature = optionalNumber(fields, 'temperature')
      const topP = optionalNumber(fields, 'topP')
      const topK = optionalNumber(fields, 'topK')
      const stopSequences = optionalStringArray(fields, 'stopSequences')
      const structured = readStructuredOutput(fields, 'text-generation')
      const providerOptions = providerOptionsFor(identity.sdkProviderKey, ctx, fields)

      const startedAt = Date.now()
      const result = await generateText({
        model,
        prompt,
        ...(system !== undefined ? { system } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(topP !== undefined ? { topP } : {}),
        ...(topK !== undefined ? { topK } : {}),
        ...(stopSequences !== undefined ? { stopSequences } : {}),
        ...(structured.output ? { output: structured.output } : {}),
        ...(providerOptions ? { providerOptions } : {}),
        abortSignal: ctx.signal,
      })

      const output = {
        modality: 'text' as const,
        // `result.output` is the validated object; reading it throws when the
        // model never reached a `stop` finish, which is the loud failure a
        // truncated JSON reply deserves.
        text:
          structured.format === 'json'
            ? structuredText(result.output)
            : result.text,
        ...dispatchEnvelope(identity, startedAt),
        ...usageFor(result.usage),
        finishReason: FINISH_REASON[result.finishReason],
      }
      return { output: output as O }
    },
  }
}
