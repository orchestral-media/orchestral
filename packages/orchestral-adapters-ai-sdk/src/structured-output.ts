// The structured-output half `fromLanguageModel` and `fromVisionModel` share.
//
// text-generation and image-to-text carry the same pair of input fields —
// `responseFormat: 'text' | 'json'` and an opaque `jsonSchema` — and the same
// output contract for them: the object lands in `text` as a JSON string.
// That is what every first-party meta reads (`JSON.parse(judgeOut.text)`,
// `parseJsonWithSchema(out.text, schema)`); neither output schema declares a
// separate object field, so none is invented here.

import { jsonSchema as sdkJsonSchema, Output } from 'ai'
import type { Capability } from '@orchestral/core'
import { z } from 'zod'

import type { InputRecord } from './envelope'

/** The JSON Schema value `jsonSchema()` accepts, minus its lazy / async forms. */
type Json7 = Exclude<
  Parameters<typeof sdkJsonSchema>[0],
  PromiseLike<unknown> | (() => unknown)
>

export interface StructuredOutput {
  /** `responseFormat` after the pattern's default for an absent field. */
  readonly format: 'text' | 'json'
  /**
   * The SDK `output` specification for `'json'`. Absent for `'text'`, so the
   * SDK sees no `output` key and sends no `responseFormat` at all — the same
   * call a plain `generateText({ prompt })` makes.
   */
  readonly output?: Output.Output<unknown>
}

/**
 * `responseFormat` / `jsonSchema` → the SDK's v7 structured-output mechanism
 * (`generateText`'s `output`; there is no separate `generateObject` call to
 * reach for):
 *
 * - `'json'` with a `jsonSchema`: `Output.object` over that schema. The SDK
 *   sends it as the provider `responseFormat`, parses the reply as JSON, and
 *   runs the `validate` hook below — zod's `fromJSONSchema` compiled from the
 *   caller's schema, so a reply that parses but does not match fails the call
 *   instead of reaching a meta that will `JSON.parse` it and choke later.
 *   A schema zod cannot compile fails before the model is called: the
 *   alternative is a validated-looking call that validated nothing.
 * - `'json'` without one: `Output.json` — any JSON value, parsed.
 * - `'text'`: nothing. `jsonSchema` is read only alongside `'json'`, which is
 *   the only thing the pattern says it constrains.
 */
export function readStructuredOutput(
  input: InputRecord,
  capability: Capability,
): StructuredOutput {
  const format = input.responseFormat ?? 'text'
  if (format === 'text') return { format }
  if (format !== 'json') {
    throw new Error(
      `${capability} call: input.responseFormat must be "text" or "json" (got ${JSON.stringify(format)})`,
    )
  }
  const schema = input.jsonSchema
  if (schema === undefined) return { format, output: Output.json() }
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(
      `${capability} call: input.jsonSchema must be a JSON Schema object (got ${Array.isArray(schema) ? 'an array' : typeof schema})`,
    )
  }
  let validator: z.ZodType
  try {
    validator = z.fromJSONSchema(
      schema as Parameters<typeof z.fromJSONSchema>[0],
    )
  } catch (err) {
    throw new Error(
      `${capability} call: input.jsonSchema cannot be compiled for validation (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    )
  }
  return {
    format,
    output: Output.object({
      schema: sdkJsonSchema(schema as Json7, {
        validate: (value) => {
          const result = validator.safeParse(value)
          return result.success
            ? { success: true, value: result.data }
            : { success: false, error: result.error }
        },
      }),
    }),
  }
}

/**
 * The `text` a `'json'` call returns: the validated object, serialised. Not
 * the raw model text — whitespace aside they are the same JSON, and the
 * serialised object is the one the validator actually passed.
 */
export function structuredText(output: unknown): string {
  return JSON.stringify(output)
}
