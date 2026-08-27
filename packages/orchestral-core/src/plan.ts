// Plan — the wire schema a model fills to author a pipeline as data.
//
// A plan is a meta whose `compose` has been replaced by a list of steps, each
// one a `ctx.step` call written down as `{ id, pattern, input, assets }` with
// `$`-references between them. This module is the *contract* half of that: the
// three ref regexes, the DAG the model writes, and the fixed output envelope
// every plan returns. It lives here, beside the other wire schema the model
// fills (`DispatchPatternInputSchema`, dispatch-pattern.ts), because core is
// the contract package — the interpreter that walks this data (`planToMeta`)
// lives in @orchestral/patterns, where the label / cost conventions it needs
// already are.
//
// Every shape is chosen to survive `toJsonSchema(…)` (schema.ts), which is how
// find_pattern renders a tool's inputs to the model: `strictObject` (→
// `additionalProperties: false`), `.regex` (→ an exact `pattern`), `.min` /
// `.max`, `discriminatedUnion`, `record` with a typed value.
//
// What is deliberately NOT here:
//
//   • No `.default()`. Under the renderer's `io: 'output'` projection a
//     defaulted field is listed as *required*, so a field the model may omit
//     would render as one it must fill. Optionality is expressed with
//     `.optional()` and nothing else; the interpreter supplies the runtime
//     default.
//   • No `.transform`. `z.toJSONSchema` throws on one, which would take the
//     whole find_pattern render down with it.
//   • No graph rules. Uniqueness, backward-only references, slot modality and
//     the registry lookups zod cannot express live in `validatePlan`
//     (plan-validate.ts) and are repeated in `.describe()` copy so the model
//     reads them where it reads the shape. A `.superRefine` is invisible to
//     `toJsonSchema` (DESIGN.md's rule for refines), which is exactly why the
//     walk has to be a separate, readable function rather than schema sugar.

import { z } from 'zod'

import { metaEnvelopeShape } from './output-envelope'
import { assetIdField, boundedText, urlField } from './output-fields'

// ── The three productions ───────────────────────────────────────────────

// Identifiers start with a letter: no '/', the namespace separator
// (meta-execution-context.ts:379-381); no '.', '$' or '[' (the ref grammar);
// and "$5.99" in a prompt is never mistaken for a reference.
// DESIGN: plan-ref-grammar
export const PLAN_STEP_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
export const PLAN_VALUE_REF_RE =
  /^\$(input|[A-Za-z][A-Za-z0-9_-]{0,63})((\.[A-Za-z_][A-Za-z0-9_]{0,63})|(\[[0-9]{1,3}\]))+$/
export const PLAN_ASSET_REF_RE =
  /^\$([A-Za-z][A-Za-z0-9_-]{0,63})\.assets\[([0-9]{1,3}|label=[A-Za-z0-9_-]{1,64})\]$/

const StepId = z
  .string()
  .regex(PLAN_STEP_ID_RE)
  .describe('Unique within the plan. Other steps refer to this step as $<id>.')
const AssetRef = z
  .string()
  .regex(PLAN_ASSET_REF_RE)
  .describe(
    '"$<stepId>.assets[0]" by position, or "$<stepId>.assets[label=winner]" by label (label form only for meta_* steps).',
  )
const ValueRef = z.string().regex(PLAN_VALUE_REF_RE)

// ── The DAG ─────────────────────────────────────────────────────────────

// Mirrors RetryPolicy (execution-context.ts:22-25). Delays are bounded because
// the model writes them; the runtime itself still imposes no clock (DESIGN.md:327).
export const PlanRetrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.literal('exponential'),
    maxAttempts: z.number().int().min(1).max(5),
    baseMs: z.number().int().min(0).max(60_000),
    maxMs: z.number().int().min(0).max(300_000).optional(),
  }),
  z.strictObject({
    kind: z.literal('fixed'),
    maxAttempts: z.number().int().min(1).max(5),
    delayMs: z.number().int().min(0).max(60_000),
  }),
])
export type PlanRetry = z.infer<typeof PlanRetrySchema>

export const PlanStepSchema = z.strictObject({
  id: StepId,
  pattern: z
    .string()
    .min(1)
    .max(128)
    .describe(
      'A pattern_id from find_pattern (use "select:<id>" to fetch its inputSchema first). Never an agent_* id and never meta_plan.',
    ),
  input: z
    .record(z.string(), z.unknown())
    .describe(
      'The pattern\'s input, exactly as find_pattern\'s primary.inputSchema describes it. A string value that is EXACTLY "$<stepId>.<path>" (e.g. "$describe.text") or "$input.<field>" is replaced by that value before dispatch; any other string is literal — there is no interpolation inside a string. Media produced by earlier steps goes in `assets`, not here.',
    ),
  assets: z
    .record(
      z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
      z.union([AssetRef, z.array(AssetRef).min(1).max(32)]),
    )
    .optional()
    .describe(
      "Media from earlier steps, keyed by this pattern's reference slot (the keys of inputSchema.references). A single slot takes one ref; an array slot takes a list, in order. A slot bound here must not also appear in input.references.",
    ),
  retry: PlanRetrySchema.optional(),
})
export type PlanStep = z.infer<typeof PlanStepSchema>

/**
 * Cap on the number of entries in `output.values`.
 *
 * DEVIATION from the design doc, which writes `z.record(...).max(64)`: zod
 * 4.4.3's `ZodRecord` carries no `.max()` (it is a `ZodString` / `ZodArray`
 * method), and `z.maxSize` — the top-level check that does exist — is a no-op
 * on records. A `.refine` is the minimal equivalent: it is invisible to
 * `toJsonSchema` exactly as the graph refine is, and when it trips it produces
 * an ordinary zod issue, which `validatePlan` reports as `PLAN_SCHEMA` — the
 * same code and the same accumulation the `.max()` would have had.
 */
const MAX_OUTPUT_VALUES = 64

export const PlanDagSchema = z.strictObject({
  description: z.string().min(1).max(512).optional(),
  steps: z
    .array(PlanStepSchema)
    .min(1)
    .max(64)
    .describe(
      'In execution order: a reference may only point at a step listed EARLIER. Steps that do not reference each other run concurrently.',
    ),
  output: z
    .strictObject({
      assets: z
        .array(
          z.strictObject({
            from: AssetRef,
            label: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
          }),
        )
        .max(64)
        .optional()
        .describe(
          'Which produced media the plan returns, each with a role label. Media not listed here is not returned.',
        ),
      values: z
        .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), ValueRef)
        .refine((v) => Object.keys(v).length <= MAX_OUTPUT_VALUES, {
          message: `at most ${MAX_OUTPUT_VALUES} named values`,
        })
        .optional()
        .describe(
          'Named text fields, each a value ref to a string on an earlier step.',
        ),
    })
    .describe(
      'What the plan returns. Required: a plan that returns nothing is money for nothing.',
    ),
})
export type PlanDag = z.infer<typeof PlanDagSchema>

// ── The fixed output envelope ───────────────────────────────────────────

/**
 * What every plan returns, in all three forms (the one-shot `meta_plan`, a
 * session-scoped temporary plan, a persisted plan package). Gated on the way
 * out by `OUTPUT_SCHEMA_MISMATCH` and audited at registration by
 * `auditOutputsSchema` (output-fields.ts), so every string here carries an
 * explicit bound.
 *
 * Every produced `assetId` is inside `assets[]` and no other field carries one:
 * `projectToolOutputForModel` rewrites only the top-level `assets` array and
 * spreads every other field through untouched (asset-index.ts), so a nested
 * echo of a step's raw output would hand the model raw ids. `steps[]`
 * therefore carries no `assetId`, `url` or `childJobId` — the last because
 * compose never sees one (`StepMeta` is `{ stepId, attempts, durationMs }`,
 * execution-context.ts).
 */
export const PlanOutputSchema = z.strictObject({
  assets: z
    .array(
      z.strictObject({
        assetId: assetIdField(),
        modality: z.enum(['image', 'audio', 'video']),
        url: urlField().optional(),
        label: boundedText(64),
      }),
    )
    .max(64),
  // 64 KiB — text-generation's own output bound (text-generation.ts), since a
  // value ref usually resolves to exactly that field.
  values: z.record(z.string().max(64), boundedText(65_536)),
  steps: z
    .array(
      z.strictObject({
        id: boundedText(64),
        pattern: boundedText(128),
        cost: z.number().min(0).nullable(),
      }),
    )
    .max(64),
  cost: metaEnvelopeShape.cost,
  // `.min(0)` is re-applied AFTER `.int()`: zod v4's `.int()` resets the
  // numeric floor to the safe-integer minimum, discarding the spread's.
  latencyMs: metaEnvelopeShape.latencyMs.int().min(0),
})
export type PlanOutput = z.infer<typeof PlanOutputSchema>
