// Plan — the wire schema a model fills to author a pipeline as data.
//
// A plan is a meta whose `compose` has been replaced by a list of steps, each
// one a `ctx.step` call written down as `{ id, pattern, input, assets }` with
// `$`-references between them. This module is the *contract* half of that: the
// three ref regexes, the DAG the model writes, and the fixed output envelope
// every plan returns. It lives beside the interpreter that walks it
// (interpreter.ts) and the walk that refuses it (validate.ts): one feature, one
// package, one definition of "what is a reference".
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
//     (validate.ts) and are repeated in `.describe()` copy so the model
//     reads them where it reads the shape. A `.superRefine` is invisible to
//     `toJsonSchema` (DESIGN.md's rule for refines), which is exactly why the
//     walk has to be a separate, readable function rather than schema sugar.

import { z } from 'zod'

import {
  assetIdField,
  assetKindField,
  boundedText,
  metaEnvelopeShape,
  urlField,
} from '@orchestral/core'

// ── The three productions ───────────────────────────────────────────────

// Identifiers start with a letter: no '/', the namespace separator
// (meta-execution-context.ts:379-381); no '.', '$' or '[' (the ref grammar);
// and "$5.99" in a prompt is never mistaken for a reference.
// DESIGN: plan-ref-grammar
export const PLAN_STEP_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
export const PLAN_VALUE_REF_RE =
  /^\$(input|[A-Za-z][A-Za-z0-9_-]{0,63})((\.[A-Za-z_][A-Za-z0-9_]{0,63})|(\[[0-9]{1,3}\]))+$/
export const PLAN_ASSET_REF_RE =
  /^\$(?!input\.)([A-Za-z][A-Za-z0-9_-]{0,63})\.assets\[([0-9]{1,3}|label=[A-Za-z0-9_-]{1,64})\]$/
/**
 * Media the CALLER supplied, picked out by the plan's own asset slot.
 *
 * A separate production rather than another selector on the one above, because
 * it reads a different namespace: `[0]` and `[label=…]` index a producing
 * step's `assets[]`, while `[slot=…]` names a key of THIS plan's `assetNeeds`
 * — the same word `references.<slot>` and `step.assets`' keys already use. One
 * selector spelling for two namespaces would have made `label` mean the role a
 * meta stamped on its output in one position and the caller's slot name in
 * another.
 *
 * `PLAN_ASSET_REF_RE` carves `input.` out of its head so exactly one of the two
 * matches any string. Without that the producer branch swallows
 * `$input.assets[0]` — a step may not be called `input`
 * (PLAN_STEP_ID_RESERVED), so it resolves to nothing — and the rendered
 * grammar would be advertising a form the walk always refuses. The carve-out is
 * narrow: `$inputs.…` and `$input-frames.…` are ordinary producer refs.
 */
export const PLAN_INPUT_ASSET_REF_RE =
  /^\$input\.assets\[slot=([A-Za-z][A-Za-z0-9_]{0,63})\]$/

const StepId = z
  .string()
  .regex(PLAN_STEP_ID_RE)
  .describe('Unique within the plan. Other steps refer to this step as $<id>.')
/**
 * What a producer ref looks like, in prose, written once.
 *
 * Three sites render it — a step's `assets` on a plan that declares slots, the
 * same field on a plan that does not, and `output.assets[].from` — and they
 * differ only in what they add after it. Splitting the shared sentence out is
 * what keeps "how you address an earlier step's media" from acquiring three
 * slightly different spellings, one per site, the way the ref grammar itself
 * once acquired three walks.
 */
const PRODUCER_REF_COPY =
  'Media produced by an earlier step: "$<stepId>.assets[0]" by position, or ' +
  '"$<stepId>.assets[label=winner]" by label (label form only for meta_* ' +
  'steps).'

/**
 * Media a step PRODUCED. Its own name because `output.assets[].from` accepts
 * only this half: an output entry is exactly one asset under exactly one label
 * (rule 23), and the caller-slot form below carries no such guarantee — an
 * array slot resolves to several and an optional one to none, neither of which
 * an output entry can be. Keeping the narrow type at that site makes both
 * refusals the schema's, rather than two more walk rules.
 */
const ProducedAssetRef = z
  .string()
  .regex(PLAN_ASSET_REF_RE)
  .describe(
    `${PRODUCER_REF_COPY} Media the CALLER supplied is not returnable here — ` +
      "it is already the caller's; return only what this plan produced.",
  )

/**
 * A step's asset ref, in the reach the plan actually has.
 *
 * With slots: a union, not one widened regex, so `toJsonSchema` renders two
 * `pattern` alternatives and the model reads both forms where it reads the
 * shape. The describe carries what a pattern cannot — that the second form is
 * legal only on a plan that declares asset slots.
 *
 * Without: the producer regex alone. A plan that declares no `assetNeeds`
 * refuses `$input.assets[slot=…]` at every layer, so rendering the form to the
 * model writing such a plan advertises a guaranteed rejection. The one-shot
 * `meta_plan` is permanently that plan — `createPlanMeta` takes no slots and
 * has nowhere to be given any — which is the case this parameter exists for.
 *
 * A parameter rather than a second schema: the two differ in this one field and
 * nothing else, and a copy would drift in the other twenty.
 */
function assetRefFor(inputAssets: boolean): z.ZodType<string> {
  if (!inputAssets) {
    return z.string().regex(PLAN_ASSET_REF_RE).describe(PRODUCER_REF_COPY)
  }
  return z
    .union([
      z.string().regex(PLAN_ASSET_REF_RE),
      z.string().regex(PLAN_INPUT_ASSET_REF_RE),
    ])
    .describe(
      `${PRODUCER_REF_COPY} Or media the CALLER supplied: ` +
        '"$input.assets[slot=<name>]", ' +
        "where <name> is one of this plan's own declared asset slots — usable " +
        'only on a plan that declares them, and never written with [0] or ' +
        '[label=…], which read a step\'s output rather than the caller\'s input.',
    )
}
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

function planStepSchema(inputAssets: boolean) {
  const AssetRef = assetRefFor(inputAssets)
  return z.strictObject({
    id: StepId,
    pattern: z
      .string()
      .min(1)
      .max(128)
      .describe(
        "A registered pattern_id; fetch its inputSchema through your catalog's discovery tool before writing the step. Never an agent_* id and never meta_plan.",
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
}

/**
 * One step, with the whole grammar. Exported as it always was; the narrow
 * variant is reached through {@link planDagSchema}, which is where the choice
 * belongs — a step schema on its own has no plan to ask about `assetNeeds`.
 */
export const PlanStepSchema = planStepSchema(true)
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

/**
 * The DAG schema, in the reach a given plan has.
 *
 * `inputAssets: true` is the whole grammar and is what {@link PlanDagSchema}
 * is. `false` drops the `$input.assets[slot=…]` production from the step
 * `assets` field — both the `pattern` alternative and the describe copy — for a
 * plan that declares no `assetNeeds` and would therefore refuse every such ref
 * anyway. `output.assets[].from` is unaffected either way: it has only ever
 * accepted the producer form.
 *
 * Why the choice is worth a parameter. This schema is not only a validator; it
 * is the bytes `find_pattern` renders to a model, and a rendered form the walk
 * always refuses costs a turn to learn. The one-shot `meta_plan` is the plan
 * that can never declare slots — `createPlanMeta` has nowhere to be given any —
 * so for it the caller-slot form is not merely unused but unsatisfiable.
 *
 * `PlanDag` is inferred from the full variant, and both variants infer the same
 * type (a ref is a `string` either way), so a narrow schema still parses into
 * the type every caller already holds.
 */
export function planDagSchema(options: { inputAssets: boolean }) {
  return z.strictObject({
    description: z.string().min(1).max(512).optional(),
    steps: z
      .array(planStepSchema(options.inputAssets))
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
              from: ProducedAssetRef,
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
}

/**
 * The DAG schema with the WHOLE grammar, caller-slot refs included — the
 * variant a plan that declares `assetNeeds` has, and the one `validatePlan`
 * parses against for every plan.
 *
 * Deliberately not narrowed per plan on the validation path: a plan with no
 * slots that writes `$input.assets[slot=hero]` is already refused by rule 25
 * with `PLAN_INPUT_ASSET_NOT_ALLOWED`, whose message carries the remedy
 * ("declare the slot, or bind it from an earlier step"). Parsing it against the
 * narrow schema as well would add a second problem saying only that the string
 * failed a regex, which is the less useful half of the same finding — and
 * validate.ts's rule is one code per remedy.
 */
export const PlanDagSchema = planDagSchema({ inputAssets: true })
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
        // Core's own AssetKind, not the image/audio/video subset this field
        // used to list. A plan steps into any registered pattern, so what its
        // `assets[]` can carry is whatever a pattern can produce — and core
        // classifies a produced file with seven kinds, four of which this
        // enum used to reject. The narrower list did not prevent a plan
        // ending in a document from being WRITTEN; it only moved the refusal
        // to the dispatch exit, as an OUTPUT_SCHEMA_MISMATCH naming the plan
        // rather than the step, after every step had been paid for.
        modality: assetKindField(),
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
