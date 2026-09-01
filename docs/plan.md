# Plan: an LLM-authored pipeline, executed as a meta

## The one idea

A plan is a meta whose `compose` has been replaced by data: a list of steps,
each one a `ctx.step` call written down as `{ id, pattern, input, assets }`,
with `$`-references between them. The grammar contains exactly what
`ctx.step` can already be asked for — a `patternId`, an `input` object,
`PatternRef.assets`, a `stepId`, a `retry` policy
(`packages/orchestral-runtime/src/meta-execution-context.ts:360-482`,
`packages/orchestral-core/src/pattern-ref.ts:25-35`,
`packages/orchestral-core/src/execution-context.ts:22-39`) — and nothing else,
so every property a plan has (validated before spend, content-addressed per
step, cached on re-run, cancellable, observable) is a property the meta engine
already gives a hand-written meta. `planToMeta(dag, opts)` walks that data
with the registry in hand and interprets it; it never evaluates anything.

## What it is not

A plan is not a Pattern kind, not an agent sub-type, and not a framework.
`kind` selects the dispatch engine (`inline.ts:1346-1358` branches on it) and
a plan runs on the meta engine unchanged, so `PATTERN_KINDS`
(`packages/orchestral-core/src/manifest.ts:22-31`), `idCarriesKind`, the
sub-agent blocklist and `find_pattern`'s kind filters are untouched; where the
plan came from is a provenance field, `origin: 'plan'`, that the registry
stores and nothing gates on. It is not an agent: zero LLM calls happen during
execution, the step list is fixed before the first dispatch, and resume is the
JobStore's idempotency dedup rather than a transcript replay. And it is not a
plugin framework: a persisted plan is an ordinary pattern package whose
factory calls `planToMeta` on a JSON literal, loaded by the manifest loader
that already exists (`registry.ts:291-370`), with no new manifest field, no
lifecycle and no sandbox — the interpreter is pure TypeScript over `ctx.step`
and `parallel`, which is why it needs none.

## The DAG

### Schema

Lives in `packages/orchestral-plan/src/plan.ts`, beside the walk that refuses a
bad DAG and the interpreter that runs a good one. (It shipped in
`@orchestral/core` first, next to `DispatchPatternInputSchema`; it moved when the
`$ref` walk it defines turned out to have three copies.)
Every shape is chosen to survive `z.toJSONSchema(…, { target: 'draft-2020-12' })`
(`packages/orchestral-core/src/schema.ts:26-42`), which is how `find_pattern`
renders it (`packages/orchestral-discovery/src/find-pattern.ts:599-600`):
`strictObject` (→ `additionalProperties: false`), `.regex` (→ an exact
`pattern`), `.min/.max`, `discriminatedUnion`, `record` with a typed value.
No `.default()` — under the renderer's `io: 'output'` a defaulted field is
listed as *required*. No `.transform` (throws). The graph rules zod cannot
express live in the walk below and are repeated in `.describe()` so the model
reads them where it reads the shape.

```ts
// Identifiers start with a letter: no '/', the namespace separator
// (meta-execution-context.ts:379-381); no '.', '$' or '[' (the ref grammar);
// and "$5.99" in a prompt is never mistaken for a reference.
export const PLAN_STEP_ID_RE  = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
export const PLAN_VALUE_REF_RE =
  /^\$(input|[A-Za-z][A-Za-z0-9_-]{0,63})((\.[A-Za-z_][A-Za-z0-9_]{0,63})|(\[[0-9]{1,3}\]))+$/
export const PLAN_ASSET_REF_RE =
  /^\$([A-Za-z][A-Za-z0-9_-]{0,63})\.assets\[([0-9]{1,3}|label=[A-Za-z0-9_-]{1,64})\]$/

const StepId   = z.string().regex(PLAN_STEP_ID_RE)
  .describe('Unique within the plan. Other steps refer to this step as $<id>.')
const AssetRef = z.string().regex(PLAN_ASSET_REF_RE)
  .describe('"$<stepId>.assets[0]" by position, or "$<stepId>.assets[label=winner]" by label (label form only for meta_* steps).')
const ValueRef = z.string().regex(PLAN_VALUE_REF_RE)

// Mirrors RetryPolicy (execution-context.ts:22-25). Delays are bounded because
// the model writes them; the runtime itself still imposes no clock (DESIGN.md:327).
export const PlanRetrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('exponential'),
    maxAttempts: z.number().int().min(1).max(5),
    baseMs: z.number().int().min(0).max(60_000),
    maxMs: z.number().int().min(0).max(300_000).optional() }),
  z.strictObject({ kind: z.literal('fixed'),
    maxAttempts: z.number().int().min(1).max(5),
    delayMs: z.number().int().min(0).max(60_000) }),
])

export const PlanStepSchema = z.strictObject({
  id: StepId,
  pattern: z.string().min(1).max(128)
    .describe('A pattern_id from find_pattern (use "select:<id>" to fetch its inputSchema first). Never an agent_* id and never meta_plan.'),
  input: z.record(z.string(), z.unknown())
    .describe('The pattern\'s input, exactly as find_pattern\'s primary.inputSchema describes it. A string value that is EXACTLY "$<stepId>.<path>" (e.g. "$describe.text") or "$input.<field>" is replaced by that value before dispatch; any other string is literal — there is no interpolation inside a string. Media produced by earlier steps goes in `assets`, not here.'),
  assets: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
                   z.union([AssetRef, z.array(AssetRef).min(1).max(32)])).optional()
    .describe('Media from earlier steps, keyed by this pattern\'s reference slot (the keys of inputSchema.references). A single slot takes one ref; an array slot takes a list, in order. A slot bound here must not also appear in input.references.'),
  retry: PlanRetrySchema.optional(),
})

export const PlanDagSchema = z.strictObject({
  description: z.string().min(1).max(512).optional(),
  steps: z.array(PlanStepSchema).min(1).max(64)
    .describe('In execution order: a reference may only point at a step listed EARLIER. Steps that do not reference each other run concurrently.'),
  output: z.strictObject({
    assets: z.array(z.strictObject({ from: AssetRef, label: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) })).max(64).optional()
      .describe('Which produced media the plan returns, each with a role label. Media not listed here is not returned.'),
    values: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), ValueRef).max(64).optional()
      .describe('Named text fields, each a value ref to a string on an earlier step.'),
  }).describe('What the plan returns. Required: a plan that returns nothing is money for nothing.'),
})
export type PlanDag = z.infer<typeof PlanDagSchema>
```

Field by field. `steps[].id` becomes `options.stepId` on the `ctx.step` call,
so `DUPLICATE_STEP_ID` (`meta-execution-context.ts:383-394`) is the runtime
twin of the uniqueness rule and `/` is refused because the engine uses it to
namespace nested ids (`:379-381`). `pattern` is `PatternRef.patternId`.
`input` is `PatternRef.input` after substitution; it is `z.record(z.string(),
z.unknown())` because that is what `dispatch_pattern.input` already is
(`dispatch-pattern.ts:32-36`) and what best-of-n's `innerInput` already is
(`image-best-of-n/index.ts:58-65`) — the per-pattern shape is learned from
`find_pattern`, never from this schema. `assets` is materialised as
`PatternRef.assets: { slot, assetId, modality }[]` (`pattern-ref.ts:25-35`),
the machine-to-machine channel, which is the *only* channel that can carry a
sub-step's product: `ctx.step` never mints a handle for what a step produced
(no `recordOutput` on the meta path, `meta-execution-context.ts:492-507`), so
an inner asset has an `assetId` and nothing else. `retry` threads to
`StepOptions.retry`. `output` names what leaves the plan: produced media with
a role label (the `labelledAssetShape` convention,
`packages/orchestral-patterns/src/meta/_shared/meta-utils.ts:79-95`) and
named text values; nothing else is exported. `description` is optional
because the one-shot is described by its tool description and a persisted
plan by its factory.

### Grammar

Four productions. A string either matches one of them whole, or it is a
literal.

| form | matches | resolves to |
|---|---|---|
| `$describe.text`, `$sb.panels[0].visualDesc`, `$render.cost` | `PLAN_VALUE_REF_RE` | a path over the producing step's **raw** output — what `ctx.step` returns (`meta-execution-context.ts:507`); `dispatchMeta` returns compose output unprojected (`inline.ts:1538-1543`) |
| `$input.motion` | `PLAN_VALUE_REF_RE`, head `input` | a field of a reusable plan's own parameters (the factory's `inputs` schema); refused in the one-shot, which has none |
| `$render.assets[0]` | `PLAN_ASSET_REF_RE` | `{ slot, assetId: out.assets[0].assetId, modality: out.assets[0].modality }` |
| `$bestof.assets[label=winner]` | `PLAN_ASSET_REF_RE` | find-first on `label`, the `assetIdByLabel` rule (`meta-utils.ts:107-119`); only a meta's output carries labels (`output-envelope.ts:81-91` has none) |
| `$input.assets[slot=still]` | `PLAN_INPUT_ASSET_REF_RE` | every entry of `ctx.assets` whose `slot` is `still` — media the CALLER supplied, addressed by a slot of the plan's own `assetNeeds`. None, one, or (on an array slot) several: a fan-in is one ref, not an enumeration. Legal only on a plan that declares slots, so refused in the one-shot, which cannot; the handle each asset arrived under is forwarded to the child, which a step's own product never carries |

The two asset productions are disjoint by construction: `PLAN_ASSET_REF_RE`
carves `input.` out of its head, so exactly one of them matches any string and a
parse can discriminate on which. A `[slot=…]` selector reads the plan's own slot
names; `[0]` and `[label=…]` read a producing step's `assets[]`. One selector
spelling across both namespaces would have made `label` mean the role a meta
stamped on its output in one position and the caller's slot name in another.
The one-shot never renders the fourth: `createPlanMeta` uses
`planDagSchema({ inputAssets: false })`, because a plan that declares no slots
refuses every such ref and advertising the form costs a turn to discover.

Nothing else: no interpolation, no arithmetic, no conditionals, no `map`. A
transform is a `text-generation` step; a decision is a shipped meta called as
one step; a dynamic width is written as a fixed one. The cost is named in
"What we deliberately do not do".

### Worked example 1 — red bicycle

`examples/incremental-rerun/src/pattern.ts:83-145` as data, in the persisted
form where `$input` is bound to the factory's `{ prompt, motion }`:

```json
{
  "description": "Describe, render and animate one short clip.",
  "steps": [
    { "id": "describe", "pattern": "text-generation",
      "input": { "system": "You are a cinematographer. Turn the subject into one line describing a single still shot: framing, light, lens. No preamble.",
                 "prompt": "$input.prompt" } },
    { "id": "render",   "pattern": "text-to-image",
      "input": { "prompt": "$describe.text" } },
    { "id": "animate",  "pattern": "image-to-video",
      "input": { "prompt": "$input.motion" },
      "assets": { "startFrame": "$render.assets[0]" } }
  ],
  "output": {
    "assets": [ { "from": "$animate.assets[0]", "label": "clip" } ],
    "values": { "description": "$describe.text" }
  }
}
```

What the walk checks: `startFrame` is a declared slot of `image-to-video`,
single, image (`packages/orchestral-patterns/src/atomic/image-to-video.ts:29-35`);
`text-to-image`'s assets element declares `modality: 'image'`
(`text-to-image.ts:95-101`), so the modalities agree; every ref points
backward; `describe`, `render` and `animate` are each consumed. What the
example's own comment says about identity (`pattern.ts:96-104`: explicit ids
are *not* in the key, the positional `stepIndex` is) is what "Step identity"
below changes for plans.

### Worked example 2 — three takes, a judge, and a winner

A persisted plan with `$input.prompt`. The three `take-*` steps are the plan's
own fan-out; `judge` reads all three on `image-to-text`'s array slot `source`
(`image-to-text.ts:68-73`); `hero` delegates the *choice* to
`meta_image-best-of-n` and the clip is animated from its `winner` label
(`image-best-of-n/index.ts:237-255` stamps it):

```json
{
  "steps": [
    { "id": "take-0", "pattern": "text-to-image", "input": { "prompt": "$input.prompt" } },
    { "id": "take-1", "pattern": "text-to-image", "input": { "prompt": "$input.prompt" } },
    { "id": "take-2", "pattern": "text-to-image", "input": { "prompt": "$input.prompt" } },
    { "id": "judge",  "pattern": "image-to-text",
      "input": { "prompt": "Images 0-2 are candidates for one prompt. Reply with the index of the strongest and one sentence why." },
      "assets": { "source": [ "$take-0.assets[0]", "$take-1.assets[0]", "$take-2.assets[0]" ] } },
    { "id": "hero",   "pattern": "meta_image-best-of-n",
      "input": { "innerPatternId": "text-to-image", "innerInput": { "prompt": "$input.prompt" },
                 "n": 3, "targetDescription": "$input.prompt" } },
    { "id": "animate", "pattern": "image-to-video",
      "input": { "prompt": "slow push-in" },
      "assets": { "startFrame": "$hero.assets[label=winner]" } }
  ],
  "output": {
    "assets": [ { "from": "$take-0.assets[0]", "label": "take-0" },
                { "from": "$take-1.assets[0]", "label": "take-1" },
                { "from": "$take-2.assets[0]", "label": "take-2" },
                { "from": "$hero.assets[label=winner]", "label": "hero" },
                { "from": "$animate.assets[0]", "label": "clip" } ],
    "values": { "verdict": "$judge.text" }
  }
}
```

`take-0..2` have identical `pattern` and `input`; that is legal because a
plan keys its steps by id ("Step identity"). The list order of `source` is the
order the model sees the images (merge order, `meta-execution-context.ts:426-449`).
Picking the winner from `$judge.text` is a conditional over a number inside a
string — not expressible, and not meant to be: plans wire, metas decide.
`take-*`, `judge` and `hero` share a level and run concurrently; `animate`
waits on `hero` only.

## Validation

Two layers. The first runs before any money is spent and lists every problem
at once. The second runs per step at execution — and GROUND corrects decision
4 here: neither `ctx.step` nor `_submitJobInternal` parses an input against
`tool.inputs` (`meta-execution-context.ts:455-480`, `inline.ts:1069-1070`;
`text-generation.ts:148-150` states it), so the per-step parse is something
`planToMeta` adds, not something it inherits. The only zod gate the engine has
is on *outputs* (`OUTPUT_SCHEMA_MISMATCH`, `inline.ts:1386-1387`).

### Layer 1 — `validatePlan(dag, lookup, opts): PlanProblem[]`

Core, pure, synchronous, returns and never throws. `lookup` is
`Pick<PatternRegistry, 'get' | 'getEntry'>`; `opts` is `{ audience?:
DispatchAudience; allow?: readonly PatternId[]; selfId?: PatternId; inputs?:
ZodObject; assetNeeds?: readonly AssetNeed[] }`. Every rule runs; problems
accumulate. Twenty-six codes, one per remedy: a model reading a refusal should
be able to tell what to edit from the code alone.

```ts
export interface PlanProblem {
  code: PlanProblemCode
  path: (string | number)[]          // into the DAG, zod-style (dispatch-pattern.ts:211-219 is the precedent)
  message: string
  stepId?: string
  details?: Record<string, unknown>  // the per-code fields below
}
export class PlanInvalidError extends Error {
  readonly code = 'PLAN_INVALID'
  readonly details: { problems: readonly PlanProblem[] }
}
```

1. `PLAN_SCHEMA` — one problem per `PlanDagSchema.safeParse` issue; details `{ issue }`.
2. `PLAN_STEP_ID_DUPLICATE` — details `{ stepId }`. The engine would throw `DUPLICATE_STEP_ID` mid-run (`meta-execution-context.ts:383-394`); we throw before.
3. `PLAN_STEP_ID_RESERVED` — `input` as a step id; `{ stepId }`.
4. `PLAN_REF_SYNTAX` — a whole-string value that begins with `$` followed by a letter and matches neither production; `{ stepId, path, value }`. `$5.99` does not trigger it (digit after `$`), so prices stay literal without an escape rule.
5. `PLAN_REF_UNKNOWN_STEP` / `PLAN_REF_FORWARD` — a ref must name a step at a *lower* array index; `{ stepId, ref, target }`. Array order is the topological order and cycles are unrepresentable; this is the cycle check.
6. `PLAN_REF_PATH_UNKNOWN` — a value path walked against the producer's `outputs` zod shape (`ZodObject` / `ZodArray` / `ZodOptional` / `ZodNullable`; anything else accepts), the same introspection `find_pattern` does on `outputs.shape` (`find-pattern.ts:553-579`); `{ stepId, ref, target, available: string[] }`. `available` is the producer's top-level output keys, because `find_pattern` never renders outputs (`:626`) and the model otherwise has no way to learn that the field is `text`.
7. `PLAN_REF_INTO_ASSETS` — a value ref whose path enters `assets`; `{ stepId, ref }`. This is the single most likely model mistake (`"references": { "startFrame": "$render.assets[0]" }`, steered by the derived references copy at `derive-references-schema.ts:30-43`), and it must be free.
8. `PLAN_REF_INPUT_NOT_ALLOWED` / `PLAN_PARAM_UNKNOWN` — `$input.<f>` with no `opts.inputs` (the one-shot), or `f` not a key of its shape; `{ ref, available }`.
9. `PLAN_REF_IN_LITERAL` — a string that is not a whole-string ref but contains `$<knownStepId>.` or `$input.`; `{ stepId, path, fragment }`. `"Animate: $describe.text"` dispatches literally in every design that lacks this lint; a model that wrote it meant a reference.
10. `PLAN_PATTERN_NOT_FOUND` — `lookup.get(step.pattern)` undefined; `{ stepId, pattern }`.
11. `PLAN_PATTERN_KIND_AGENT` — `pattern.kind === 'agent'` (by kind, not prefix: `idCarriesKind` is not on the core barrel, `index.ts:228-246`); `{ stepId, pattern }`.
12. `PLAN_PATTERN_SELF` — `step.pattern === opts.selfId`; `{ stepId, pattern }`. The runtime would refuse it as `CIRCULAR_META_STEP` (`meta-execution-context.ts:396-404`) after earlier steps had run.
12a. `PLAN_PATTERN_ONE_SHOT` — the target is the one-shot interpreter, recognised structurally (`origin === 'plan'` with no `.plan` step list riding on the pattern), named from any plan that is not it (rule 12 covers the self case); `{ stepId, pattern }`. Nesting the one-shot cannot work — the outer substitution rewrites the inner DAG's `$refs` before it runs — and without this rule the wreckage surfaces at layer 2 as a schema mismatch rather than "you nested a plan". The message carries the remedy: inline the inner steps, or persist the inner plan with `planToMeta` — a persisted plan (`.plan` present) is an ordinary steppable meta whose parameter input the walk checks normally.
13. `PLAN_PATTERN_NOT_EXPOSED` — `resolveExposure(pattern.exposure)[audience]` false (`pattern.ts:349-368`), only when `opts.audience` is given; `{ stepId, pattern, audience }`. Host-direct submit has no exposure gate (`inline.ts:701-707`), so "exposed to the surface" is a parameter of the validator, not a fact the registry holds.
14. `PLAN_PATTERN_NOT_ALLOWED` — `opts.allow` given and the id absent; `{ stepId, pattern, allowlist }`. This is how an agent's `toolPatternIds` reaches inner steps ("Trust").
15. `PLAN_ASSET_PRODUCER_NONE` / `PLAN_ASSET_LABEL_UNSUPPORTED` — an asset ref into a step whose `outputs.shape.assets` is absent, or a `label=` ref into one whose assets element has no `label` (atomics: `producedAssetShape`, `output-envelope.ts:81-91`); `{ stepId, ref, target }`.
16. `PLAN_SLOT_UNKNOWN` — the bound slot is not in the target's `assetNeeds` (`pattern.ts:208-218`); `{ stepId, slot, declared: string[] }`.
17. `PLAN_SLOT_MODALITY` — the producer's `modality` literal differs from `need.modality`; `{ stepId, slot, expected, got }`.
18. `PLAN_SLOT_CARDINALITY` — `single` with a list, or `array` over `need.max`; `{ stepId, slot, cardinality, count, max? }`.
19. `PLAN_SLOT_DUAL_SOURCE` — the same slot in `assets` and in `input.references`, any cardinality; `{ stepId, slot }`. Stricter than the runtime's single-only guard (`meta-execution-context.ts:228-255`): the handle-first merge order on array slots is a best-of-n implementation detail (`image-best-of-n/index.ts:190-232`), not a contract a model can see.
20. `PLAN_SLOT_REQUIRED_UNBOUND` — a `required: true` slot neither bound in `assets` nor present in `input.references`; `{ stepId, slot }`. Left unbound, the resolver's "most recent of modality" default (`inline.ts:1444-1485`, `derive-references-schema.ts:40-42`) would feed the step a *session ledger* image, not the upstream step's — silently, after spend.
21. `PLAN_STEP_INPUT_INVALID` — the step's input parsed against the target's schema (meta → `tool.inputs`, atomic → `primary.tool.inputs`, top-level `.passthrough()` exactly as `resolveDispatchTarget` does, `dispatch-pattern.ts:184-201`, so `size` / `seed` / `providerOptions` / the derived `references` survive); issues whose path lands on a ref-valued field are suppressed because that field's type exists only after substitution; `{ stepId, pattern, issues }`. A mistyped literal (`"temperature": "0.7"`) is caught here, before the step it belongs to has upstream spend.
22. `PLAN_STEP_UNUSED` — a step no later step and no `output` entry reads; `{ stepId }`. Money for nothing is what this layer exists to prevent.
23. `PLAN_OUTPUT_LABEL_DUPLICATE` — `{ label }`.
24. `PLAN_INPUT_NOT_SERIALISABLE` — the input fails `canonicalise`'s rules (`idempotency.ts:77-127`); `{ stepId, path }`. The engine would throw `IDEMPOTENCY_NOT_SERIALISABLE` at dispatch; the plan is JSON already, so this only fires on a host-constructed DAG.
25. `PLAN_INPUT_ASSET_NOT_ALLOWED` — a `$input.assets[slot=…]` ref on a plan that declares no `assetNeeds` at all; `{ stepId, ref, available: [] }`. The twin of rule 8's `PLAN_REF_INPUT_NOT_ALLOWED`, which says the same thing about `$input.<field>` on a plan with no parameters. The one-shot is permanently in this case, which is why `createPlanMeta` renders the producer-only grammar and never advertises the form.
26. `PLAN_INPUT_SLOT_UNKNOWN` — the slot name is not one this plan declares; `{ stepId, ref, slot, available: string[] }`. The twin of `PLAN_PARAM_UNKNOWN`, and it lists what IS declared for the same reason: the author cannot otherwise see the vocabulary from the refusal. Where the caller slot and the child slot disagree it is rules 17/18/20's codes that fire, not a new one — both sides are declared, so modality, cardinality and required-ness are knowable statically and get the code the reader already knows. In particular an *optional* caller slot feeding a *required* child slot reports `PLAN_SLOT_REQUIRED_UNBOUND`: it is rule 20's failure mode reached one step further out.

Where it runs, one function, three sites:

- **Host-direct.** `assertPlanValid(dag, lookup, opts)` (throws
  `PlanInvalidError`) before `submitJob`; `preflightPlan` includes it.
- **LLM paths.** The one-shot's `tool.inputs` is
  `planDagSchema({ inputAssets: false }).superRefine(planRefine(lookup, { selfId:
  'meta_plan', audience }))` — the producer-only variant, because a one-shot
  declares no asset slots and rule 25 would refuse every `$input.assets[slot=…]`
  it could be sent,
  emitting one zod issue per problem (`params: { code, details }`).
  `resolveDispatchTarget` applies top-level `.passthrough()` and `safeParse`
  (`dispatch-pattern.ts:198-202`); on zod 4.4.3 (the pinned instance under
  `packages/orchestral-core/node_modules/zod`) `.passthrough()` preserves the
  refine and reports its issues with their paths, so the model gets every
  walk problem through the existing `INPUT_VALIDATION_FAILED` tool result
  (`agent-dispatch.ts:809-825`) with no new hook. Be honest about the limit:
  zod aborts a `superRefine` when an earlier check produced `unrecognized_keys`
  or `invalid_type`, so a first draft with an extra key gets the shape errors
  in one turn and the walk in the next. That is the two-turn cost
  `dispatch_pattern` already has (`INVALID_INPUT` then
  `INPUT_VALIDATION_FAILED`) and the refine is invisible to `toJsonSchema`
  exactly as DESIGN.md:119-132 says refines are — the regexes render, the
  registry rules cannot.
- **Inside `compose`**, before the first `ctx.step`, with the `lookup` the
  factory closed over and no `audience` (the surface was checked at the
  boundary). This is what makes "every problem at once, nothing dispatched"
  hold on the host-direct path too: without it, an unregistered pattern at
  level 3 surfaces as `PATTERN_NOT_REGISTERED` (`inline.ts:700-707`) after
  levels 1 and 2 have run. The thrown `PlanInvalidError` reaches the plan's
  job row as code `PLAN_INVALID` via `normaliseError`
  (`packages/orchestral-runtime/src/errors.ts:8-33`).

### Layer 2 — per step, at execution

Immediately before each `ctx.step`, after substitution, `planToMeta`
`safeParse`s the substituted input against the same schema as rule 21 (now
with nothing suppressed). Failure throws `PLAN_STEP_INPUT_INVALID` with
`details: { planStepId, patternId, issues }`. It is a gate, not a rewrite:
the input is dispatched **as written**, never as zod's defaults-applied copy —
a copy would put `maxOutputTokens: 2048` into the child's idempotency input
(`idempotency.ts:58-67`) and key a plan's `text-generation` step differently
from a hand-written meta's. Then the engine's own checks apply unchanged:
`CIRCULAR_META_STEP`, `DUAL_SOURCE_SINGLE_SLOT`, and `OUTPUT_SCHEMA_MISMATCH`
on every child output and on the plan's own (`inline.ts:1542`).

## Execution

`planToMeta(dag, opts)` validates the registry-free subset of layer 1 at
construction (grammar, ids, backward refs, output shape) and throws
`PlanInvalidError` then; the registry rules wait for `compose`, because a
factory loaded through `addFromManifest` runs before any pattern is
registered (`registry.ts:291-370` builds every pattern, then registers). The
returned `MetaPattern` is `{ kind: 'meta', id, origin: 'plan', tool: {
description, inputs }, outputs: PlanOutputSchema, compose, plannedDispatches,
plan }` — the shape `createStoryboardMeta` returns (`storyboard/index.ts:279-300`)
*plus* the three plan fields (`origin`, `plannedDispatches`, `plan`), which no
authored meta carries today.
`compose({ input }, ctx)`:

1. **Validate.** `validatePlan(dag, lookup, { selfId, inputs, assetNeeds })`;
   throw on any problem. Zero spend. `assetNeeds` is the plan's declared asset
   slots, forwarded rather than re-derived — layer 1 has to check the same list
   the pattern declared, or it validates a contract other than the one the host
   resolved `ctx.assets` against.
2. **Levels.** `level(step) = 1 + max(level(dep))` over the backward refs,
   computed once. For each level in order, in listed order,
   `ctx.step.withMeta({ patternId, input, assets }, { stepId: step.id,
   identity: 'id', retry: step.retry })` is *called* synchronously inside a
   `map`, and the level is awaited through `parallel.limit(thunks,
   opts.concurrency ?? Infinity)`. The call order matters: the
   tree-shared counter advances at call time (`meta-execution-context.ts:366`),
   and that counter is the durable key of every *positional* child — the
   internals of a shipped meta called as a step (`meta_image-best-of-n`'s
   `candidate-N` rows are keyed on `stepIndex`, `:477-478`, `idempotency.ts:64`).
   A level loop keeps those indices identical run to run. A promise graph
   that starts each step when its last dependency settles does not: which
   step claims which index then depends on provider latency, and decision 7
   fails for exactly the steps the grammar tells an author to reach for.
   Uncapped, `parallel.limit` invokes every thunk synchronously and in list
   order, exactly as a bare `Promise.all` over eagerly-built promises would,
   which is what keeps that argument true at the default; a finite
   `concurrency` gives it up by construction, since a capped task starts when an
   earlier one settles. That cost is stated on `RunPlanOptions.concurrency`.

   **What a failure invalidates.** Exactly the failing step's transitive
   dependents — which is what the DAG the author wrote already says. A step
   whose dependencies all produced output runs; a step that reads something
   which failed, or which was itself never attempted, is marked unreachable and
   skipped. Independent branches therefore run to completion and their rows are
   banked, which is what makes "the steps that succeeded are not re-run when you
   resubmit" pay off for a plan that failed in one branch. The plan still fails,
   after the reachable frontier is done, and the error raised is the first
   failure in **step-list order** — not the first to settle, or the same plan
   would blame a different step on a different day. Two costs: a failing plan
   now takes as long as its slowest independent branch rather than failing fast,
   and a step invalidated on one run consumes counter positions on the resubmit
   that it did not consume before, so a surviving branch's *nested positional*
   rows can miss where they hit (the plan's own steps are immune —
   `identity: 'id'`). A `CANCELLED` error is the exception: `cancelJob` has
   already torn the tree down, so it is rethrown immediately rather than
   collected, because there is no frontier left to finish.
3. **Substitute.** Deep-walk `step.input`; replace every whole-string value
   ref by the value at that path in the producer's stored output (or in
   `input` for `$input`); a path that resolves to `undefined` throws
   `PLAN_REF_UNRESOLVED { planStepId, ref }` before the dispatch. Build
   `PatternRef.assets` from `step.assets`: `[i]` → `out.assets[i]`,
   `[label=L]` → `out.assets.find(a => a.label === L)`; each entry is
   `{ slot, assetId: el.assetId, modality: el.modality }`; missing →
   `PLAN_REF_UNRESOLVED`, the same failure `firstAsset` / `assetIdByLabel`
   produce (`meta-utils.ts:107-137`). A `[slot=S]` ref instead reads every entry
   of `ctx.assets` under slot `S` — none, one or several — and forwards each
   asset's `handle` alongside its id, which a step's own product never has;
   nothing under a *required* slot throws
   `PLAN_INPUT_ASSET_MISSING { planStepId, ref, slot, path }`, while nothing
   under an optional one contributes no refs and lets the step run, which is
   what `required: false` means. Every resolved `modality` is narrowed to an
   `AssetKind` rather than cast: a producer whose own schema does not pin the
   field (`modality: z.string()`) throws
   `PLAN_ASSET_MODALITY_UNKNOWN { planStepId?, ref, path, modality }` at the
   site that read it — `planStepId` is the CONSUMING step here and absent at the
   output-assembly site in step 8, where `path` addresses the entry instead.
   Handles the author put in
   `input.references.<slot>` are untouched and resolve through
   `resolveStepReferences` against `spec.assetContextId ?? sessionId`
   (`inline.ts:1454-1487`) when a bridge exists; the two channels never meet
   on one slot because rule 19 refused it.
4. **Gate.** Layer 2 parse on the substituted input.
5. **Dispatch.** The key each child lands on, exactly:
   `sha256(JSON.stringify({ patternId, input: canonicalise(substitutedInput),
   assets: canonicalise(mergedAssets) | null, sessionId | null, stepIndex: 0,
   stepKey: effectiveStepId }))` — the existing allowlist
   (`idempotency.ts:58-67`) plus the one field "Step identity" adds — unless
   `RunPlanOptions.idempotencyKeyFor` returned a string for this step, in which
   case that string IS the key and none of the above is hashed.
6. **Null guard.** A dedup hit on a queued or running row returns that row
   without awaiting it and `ctx.step` hands its `null` output to compose
   (`inline.ts:748-783`, `meta-execution-context.ts:483-507`). A `null` step
   value throws `PLAN_STEP_IN_FLIGHT { planStepId }` rather than feeding
   `null` into the next step's prompt.
7. **Collect.** `outputs.set(step.id, value)`; `costs.push(value.cost)` —
   every atomic and meta envelope carries `cost: number | null`
   (`output-envelope.ts:41-69`).
8. **Assemble.** `{ assets, values, steps, cost: sumCosts(costs), latencyMs:
   Date.now() - startedAt }`, where `assets` is each `output.assets[]` entry
   resolved as in step 3 and stamped with its label, `values` each
   `output.values` ref resolved and required to be a string (anything else
   throws `PLAN_OUTPUT_NOT_SCALAR { name }`), and `steps` is `{ id, pattern,
   cost }` per step. `sumCosts` is null if any step is unpriced
   (`meta-utils.ts:158-170`).

**Failure.** A failed child *throws* out of `_submitJobInternal` with its own
code (`inline.ts:916-943`); `META_STEP_FAILED` at
`meta-execution-context.ts:483-491` is unreachable under `InlineRuntime`
because `insertIfAbsent` never returns an error row (`job-store-memory.ts:189-196`).
The interpreter catches in the level loop, stamps `err.details = {
...err.details, planStepId, planPatternId }` and **collects** the same object,
so the plan's job row carries the innermost code — `OUTPUT_SCHEMA_MISMATCH`,
`NO_MODEL_FOR_CAPABILITY`, `PLAN_STEP_INPUT_INVALID` — which
`output-validation.test.ts:280-305` pins as the intent, and the host reads
which step from `job.error.details.planStepId`. The walk continues to the end of
the reachable frontier and then raises the first collected failure **in
step-list order**; a plain `CANCELLED` error is rethrown on the spot instead,
untouched, because `cancelJob` has already torn the tree down and there is no
frontier left to run. No partial-success state: the rows that succeeded are the
partial result, and the next submit hits them — which the keep-going walk makes
truer, not less true, since more of them exist to hit.

**Re-run.** The one-shot's own key hashes the DAG as `input`, so any edit is a
new plan job whose unchanged steps still hit. Per step: same session, same
`stepKey`, same substituted input, same upstream `assetId`s ⇒
`insertIfAbsent` returns the done row and no model is called. Because
`assets` is in the key, a re-rendered `render` re-keys `animate`, and a
failed-then-fixed upstream correctly invalidates downstream. A changed
`motion` re-keys only `animate`. Re-runs must pass the same `sessionId`
(`idempotency.ts:63`). On a hit, the *stored* `describe.text` feeds `render`
verbatim, so a non-deterministic model behind step 1 does not re-key step 2.

**Events.** One `job:step` per plan step on the plan's job stream with
`stepId = step.id`, `patternId`, `childJobId`, and the child's `assets[]`
(`inline.ts:1498-1510`, `job.ts:252-269`). A shipped meta called as a step
emits its own inner ids (`candidate-0`) unnamespaced on the same stream; two
plan steps calling the same meta are told apart by `childJobId`. The
`job.ts:250` sentence saying a failing step raises `META_STEP_FAILED`
describes the unreachable path and is corrected in the implementation.

**Abort.** The meta's controller signal is the `parentSignal` of every child
(`inline.ts:1489-1497`); `cancelJob(planJobId)` cascades, the row is written
`cancelled` (`inline.ts:917-933`), and cancelled rows never dedupe. Nothing to
add.

**Cost.** Spend decisions stay with the host: `preflightPlan` before submit,
`beforeDispatch` counting per `rootJobId` for a cap (DESIGN.md:327-343). The
interpreter never calls `ctx.askUser` — it parks without replay and consumes
the same counter as `ctx.step` (`meta-execution-context.ts:571`), shifting
every positional key after it — and never calls `ctx.submitJob`, which starts
a fresh shared state and emits no `job:step` (`:601-612`).

## Step identity

Today the durable key is the counter position, not the id: `ctx.step` passes
`stepIndex: idx` on the child spec (`meta-execution-context.ts:477-478`),
`deriveIdempotencyKey` hashes it (`idempotency.ts:64`), and `stepIdNamespace`
— the only place the author's id reaches the spec — is excluded on purpose
(`:49-50`). `ctx.step` does not use the in-run `stepCache` at all
(`useCache = false`, `:514-522`); resume is entirely `insertIfAbsent`. So
decision 6 cannot be met by "pass the id through": inserting a step ahead of
`render` moves its index from 1 to 2, a new key for unchanged work
(`examples/incremental-rerun/src/pattern.ts:96-104` says exactly this). The
opt-in is a key-derivation change, kept additive:

```ts
// packages/orchestral-core/src/execution-context.ts — StepOptions
/** 'index' (default): the tree-wide counter position keys the JobStore row.
 *  'id': the namespaced stepId keys it instead. Requires an explicit stepId. */
identity?: 'index' | 'id'

// packages/orchestral-core/src/job.ts — IDENTITY group (doc at :80-96 updated)
/** Set by ctx.step under identity:'id': the namespaced effective step id.
 *  Replaces stepIndex in the idempotency derivation when present. */
stepKey?: string

// packages/orchestral-runtime/src/idempotency.ts
stepIndex: args.stepIndex ?? 0,
...(args.stepKey !== undefined ? { stepKey: args.stepKey } : {}),
```

In `ctx.step`: `identity === 'id'` without `options.stepId` throws
`STEP_IDENTITY_REQUIRES_STEP_ID` (the default id embeds the counter, which
would defeat the point); the child spec then carries `stepKey:
effectiveStepId` and omits `stepIndex`. The counter still advances (default
ids, nested namespaces and events are unchanged). `createPatternFn` forwards
options untouched (`create-pattern-fn.ts:78-85`), so typed wrappers get it
for free.

Why positional stays the default. Every shipped meta is write-once and its
author owns the order (DESIGN.md:311-325); none of them sets `identity`, so no
`stepKey` reaches their hash, the stringified object is byte-identical, and
the pinned snapshot (`idempotency-stability.test.ts:11-18`) stays green. The
conditional spread is what makes the warning at `idempotency.ts:55-58`
("adding a field changes dedup for every existing row") not apply — the field
is absent unless asked for. A plan opts in because its step list is edited
between runs by a model; that is the one population for which reordering is
routine rather than a code change.

Why the namespaced id. Two plan steps each calling `meta_image-best-of-n`
produce `a/candidate-0` and `b/candidate-0`; if that meta ever opts in they
must not collide. The rationale at `idempotency.ts:49-50` for excluding the
namespace ("an identical sub-step in two subtrees would fail to dedupe") is
already vacuous: the tree-shared counter makes their `stepIndex` differ today.

The insert-a-step trace. Run 1: `describe` (key K1 = text-generation,
{system, prompt}, session, `stepKey: describe`), `render` (K2 = text-to-image,
{prompt: text}, session, `render`), `animate` (K3 = image-to-video,
{prompt: motion}, assets [render's id], session, `animate`). Run 2 inserts
`caption` (text-generation over `$input.prompt`, listed second, read only by
`output.values`) — an independent branch. `describe` → K1, hit. `caption` →
new key, runs. `render` → K2, hit: its key never saw the counter. `animate` →
K3, hit. One model call for one new step. Under positional identity the same
edit moves `render` from index 1 to 2 and `animate` from 2 to 3, and both
re-run with nothing they read changed — three paid calls for one new step,
which is the cost `pattern.ts:96-104` names and a model-edited plan pays on
every revision. Had the insert instead fed `animate` (an `upscale` step on
`$render.assets[0]`, with `startFrame` rebound to it), `animate`'s key would
differ in `assets` and it would re-run — correctly, because its input changed.
Stated caveat: a shipped meta called as a step keeps positional
internals under the shared counter, so inserting a plan step ahead of a
`meta_storyboard` step shifts that meta's inner indices and re-runs them.
Closing that requires the inner meta to opt in, which is its author's call.

### The third bypass: the caller writes the key

`identity` chooses between two projections of one derivation, and that
derivation hashes `sessionId` on purpose ("dedup never crosses a session
boundary", `idempotency.ts`). So a caller whose notion of "the same work"
outlives the conversation the request arrived in cannot express it by choosing a
mode at all. `StepOptions.idempotencyKey` is where it says so: the string it
returns IS the durable key, and `deriveIdempotencyKey` does not run.
`RunPlanOptions.idempotencyKeyFor(step, substitutedInput, resolvedAssets)` is
the same seam for a plan's steps, which the interpreter dispatches on the
author's behalf — without it, a plan's steps would be the only steps in the
library that cannot reach the option. It is a pure derivation: it cannot skip a
step, supply an output or stop the walk, and returning `undefined` leaves the
engine's derivation in place for that step. It is offered on `planToMeta` and
NOT on `createPlanMeta`: a one-shot's step ids are invented by the model on the
turn it submits, so there is nothing stable for a host to key a durable row on.

The burden that moves with the key, stated exactly, because a plan reaches all
three cases where a hand-written meta reaches one:

- **Same pattern, same step, a key that omits something the step reads.** The
  engine stops asking whether the input changed, so the earlier output comes
  back for later work: a stale but schema-valid result, not an error, and only
  the caller can tell it is wrong. This is the documented cost of the option.
- **Two steps naming different patterns under one key** — what a key derived
  from the substituted input alone produces, since `render` and `animate` can
  agree on it. Refused: `IDEMPOTENCY_KEY_CROSS_PATTERN`, named at the dedup hit
  in `_submitJobInternal`. Not a stale answer but an answer to a different
  question — the row's output was gated against the other pattern's `outputs`
  schema and never against this one's, so returning it hands the dispatch exit a
  value no schema in this call's path ever checked. Only a caller-supplied key
  can produce it; the derivation always hashes `patternId`.
- **Two steps of the SAME pattern on one level under one key** — the fan-out
  case, and one the engine cannot call wrong: the row is the right pattern, it is
  simply still queued when the sibling dedupes onto it. It surfaces through the
  null guard as `PLAN_STEP_IN_FLIGHT` naming the second step. Include `step.id`
  in the key, or anything else that tells two independent steps apart.

## Three forms

One primitive, `planToMeta(dag, opts: PlanToMetaOptions): PlanMetaPattern`,
in `packages/orchestral-plan/src/interpreter.ts`:

```ts
export interface PlanToMetaOptions {
  id: PatternId                        // must start with meta_ (manifest.ts:67-70); PLAN_ID_INVALID otherwise
  lookup: PlanPatternLookup            // Pick<PatternRegistry, 'get' | 'getEntry'> — the registry, or ops.getPattern
  inputs?: ZodObject                   // binds $input.<field>; absent ⇒ $input is refused
  description?: string; searchHint?: string
  exposure?: PatternExposure           // default 'no-tool' for anything not shipped (see Trust)
  assetNeeds?: readonly AssetNeed[]    // binds $input.assets[slot=…]; also carried on the pattern, so a
                                       // host resolves for it like any other media pattern, and derives
                                       // the `references` field onto tool.inputs
  concurrency?: number                 // cap on one level's width; default unlimited (see "Cost")
  idempotencyKeyFor?: PlanStepIdentity // per-step durable key (see "The third bypass")
}
```

It lives in `@orchestral/plan`, with the schema, the walk and the preflight.
Core keeps the vocabulary those four consume — `producedAssetShape`'s `label`,
`metaEnvelopeShape.cost` and the `sumCosts` rule that reads it, `PatternRegistry`
— and nothing plan-shaped. `@orchestral/patterns` depends on the package to
register `meta_plan`, and re-exports `createPlanMeta` because its own manifest
names that factory; a host that builds a plan of its own imports
`@orchestral/plan` directly.

**One-shot — `meta_plan`.** A shipped pattern whose input *is* the DAG:

```ts
// packages/orchestral-plan/src/interpreter.ts
export const PLAN_PATTERN_ID = 'meta_plan' as const
export function createPlanMeta(ops: { getPattern: (id: PatternId) => Pattern | undefined },
                               init: { audience?: DispatchAudience; concurrency?: number } = {}): MetaPattern<PlanDag, PlanOutput> {
  const lookup = { get: ops.getPattern, getEntry: (id) => { const p = ops.getPattern(id); return p && { pattern: p, alternatives: [] } } }
  return {
    id: PLAN_PATTERN_ID, kind: 'meta', origin: 'plan', namespace: 'meta-pipelines',
    exposure: 'tool', exposureMode: 'deferred',
    description: 'Execute an LLM-authored pipeline of registered patterns as one meta job.',
    searchHint: 'pipeline; multi-step; chain several patterns; fan out then judge; workflow as data',
    tool: { description: PLAN_TOOL_DESCRIPTION,
            inputs: planDagSchema({ inputAssets: false })
                      .superRefine(planRefine(lookup, { selfId: PLAN_PATTERN_ID, audience: init.audience ?? 'agent-loop' })) },
    outputs: PlanOutputSchema,
    plannedDispatches: (dag) => dag.steps.map((s) => s.pattern),
    // A width cap is offered; the identity seam is not. A one-shot's step ids
    // are invented by the model on the turn it submits, so there is nothing
    // stable for a host to key a durable row on.
    compose: ({ input }, ctx) => runPlan(input, lookup, { selfId: PLAN_PATTERN_ID, ...(init.concurrency !== undefined ? { concurrency: init.concurrency } : {}) }, {}, ctx),
  }
}
```

Manifest entry: `{ "id": "meta_plan", "kind": "meta", "export":
"createPlanMeta", "requiredOps": ["getPattern"] }`. `requiredOps` is the
honest channel for this: `compose` receives no registry
(`meta-execution-context.ts:601-624`), a factory receives only `ops`
(`registry.ts:291-370`), and the manifest doc defines `requiredOps` as "names
of host operations THIS pattern's factory expects" checked as
`typeof ops[op] === 'function'` (`manifest.ts:51-62`, `registry.ts:315`) —
ffmpeg is the example, the function check is the contract. A host that loads
by hand calls `createPlanMeta({ getPattern: (id) => registry.get(id) })`. The
`searchHint` names no atomic capability: `searchHint` is a boost-5.0 field
(`pattern-search-index.ts:63-74`), and "text-to-image" in it would put
`meta_plan` into every atomic query's top five. `exposureMode: 'deferred'`
because the rendered DAG schema is ~3.5 KB of byte-stable prefix on every turn
for a tool used rarely, and the model must call `find_pattern` per step
anyway; a host may flip it (`catalog-builder.ts:156-164` renders metas).

`tool.description`, verbatim:

> Run a fixed pipeline of registered patterns as one job: you write the steps
> as data and the runtime executes them in dependency order, in parallel
> where possible, caching completed steps across re-runs in this session. Use
> it when you already know the whole pipeline instead of calling patterns one
> at a time. First call find_pattern for every pattern you intend to use
> (query `select:text-to-image,image-to-video`, or `meta_*`) and copy each
> step's `input` from its primary.inputSchema — this tool does not know the
> step schemas. Reference an earlier step's value with `$<stepId>.<path>` as
> a whole string (e.g. `"prompt": "$describe.text"`; text-generation's text
> is at `.text`). Feed media an earlier step produced into a reference slot
> with `"assets": { "<slot>": "$<stepId>.assets[0]" }`, where `<slot>` is a
> key of that pattern's `references`; use `$<stepId>.assets[label=winner]`
> for a meta_* step. Never put a `$…assets[…]` ref inside `input`. Steps may
> only reference steps listed before them; steps that do not reference each
> other run concurrently — write a fan-out as several steps with distinct
> ids. No conditionals, loops or text transforms: add a text-generation step
> to transform text, and call a meta_* pattern (e.g. meta_image-best-of-n)
> for choose-the-best logic. agent_* patterns and meta_plan itself are not
> allowed. `output` lists what comes back: media with a role label, text
> under `values`. The result is `{ assets[], values{}, steps[], cost,
> latencyMs }`. If the plan is invalid you get every problem at once and
> nothing runs; a failing step fails the job and the steps that succeeded are
> not re-run when you resubmit.

**Temporary.** A plan registered for the life of a session:

```ts
const scope = registry.scope()
scope.add(planToMeta(dag, { id: `meta_plan-${sessionSlug}`, lookup: registry }))   // exposure defaults to 'no-tool'
try { const job = await runtime.submitJob({ patternId: `meta_plan-${sessionSlug}`, input: {}, sessionId }) }
finally { scope.dispose() }   // only after the job is terminal
```

`scope()` is a list of ids over the primitives that exist: `add` is
`register` (`registry.ts:67-235`) plus remembering the id; `dispose` is
`unregister` for each (`:372-386`, idempotent, returns `false` when gone).
No revision counter, no listeners, no activation — nothing in the runtime
needs them, because dispatch re-reads the Map per step (`inline.ts:701`).
Two rules the name carries: dispose after the job is terminal (constituent
patterns are re-read at every step, `inline.ts:1463, 1518`; the plan pattern
itself is held by `submitJob` so disposing *it* mid-run is harmless), and
default `exposure: 'no-tool'`, because a sub-agent's `find_pattern` indexes
the registry at each dispatch (`agent-dispatch.ts:422`) and a session's plan
should not become another loop's tool by accident (DESIGN.md:372-383). The
generated id must start with `meta_` (`PATTERN_ID_KIND_MISMATCH` otherwise),
stay within `[A-Za-z0-9_-]` (it doubles as a tool name,
`foundational.ts:4-13`), and contain no `/` (`shortNameOf` strips to the last
segment, `registry.ts:106-112`).

**Persisted.** An ordinary package; no manifest field changes
(`manifest.ts:44-115` ignores unknown keys, and `addFromManifest` checks only
`id` and `kind`, `registry.ts:559-599`):

```jsonc
// package.json
{ "name": "orchestral-pattern-short-clip", "keywords": ["orchestral-pattern"],
  "peerDependencies": { "@orchestral/core": ">=0.2 <0.3", "@orchestral/plan": ">=0.2 <0.3" },
  "orchestral": { "patterns": [
    { "id": "meta_short-clip", "kind": "meta", "export": "createShortClip", "requiredOps": ["getPattern"] } ] } }
```
```ts
import { planToMeta } from '@orchestral/plan'
import plan from './short-clip.plan.json' with { type: 'json' }
export function createShortClip(ops: { getPattern: (id: PatternId) => Pattern | undefined }) {
  return planToMeta(plan, {
    id: 'meta_short-clip', lookup: { get: ops.getPattern, getEntry: /* as above */ },
    inputs: z.object({ prompt: z.string().min(1).max(2000), motion: z.string().min(1).max(500) }),
    exposure: 'tool', description: 'Describe, render and animate one short clip.',
    searchHint: 'short clip from a prompt: describe, render, animate',
  })
}
```

The factory's `inputs` is the pattern's `tool.inputs` and binds `$input`;
`plannedDispatches` is the static step list; `origin: 'plan'` and the `plan`
field ride on the returned object so a catalog UI can draw it and preflight
can recurse into it.

The fixed output envelope, every form (gated by `OUTPUT_SCHEMA_MISMATCH` at
`inline.ts:1542`, audited at registration by `auditOutputsSchema`,
`output-fields.ts:63-131`):

```ts
export const PlanOutputSchema = z.strictObject({
  // core's whole AssetKind, via assetKindField() — a plan steps into any
  // registered pattern, so what its assets[] can carry is whatever a pattern
  // can produce. The old image/audio/video subset did not stop a plan ending in
  // a document from being written; it moved the refusal to the dispatch exit.
  assets: z.array(z.strictObject({ assetId: assetIdField(), modality: assetKindField(),
                                   url: urlField().optional(), label: boundedText(64) })).max(64),
  values: z.record(z.string().max(64), boundedText(65_536)),   // text-generation's own bound (text-generation.ts:93)
  steps:  z.array(z.strictObject({ id: boundedText(64), pattern: boundedText(128), cost: z.number().min(0).nullable() })).max(64),
  cost: metaEnvelopeShape.cost,
  latencyMs: metaEnvelopeShape.latencyMs.int().min(0),
})
```

Every produced `assetId` is inside `assets[]` and no other field carries one
(`meta-utils.ts:59-77`): `projectToolOutputForModel` rewrites only the
top-level `assets` array and spreads every other field through
(`asset-index.ts:366-411`), so a nested echo of step outputs would hand the
model raw ids. `steps[]` therefore carries no `assetId`, `url` or
`childJobId` — the last because compose never sees one (`StepMeta` is
`{ stepId, attempts, durationMs }`, `execution-context.ts:41-45`).

## Preflight

A pure host function in `@orchestral/plan`. The two things it cannot invent —
the `ResolveContext` the runtime routes with, and which declared alternative
applies — arrive as parameters: the host hands it the same `ResolveCtxProvider`
it gave `InlineRuntimeInit`, and `applicableAlternatives` is core's
(`alternative-select.ts`), shared with the runtime's ALTERNATIVES_NOT_ENABLED
diagnostic so the two cannot disagree.

```ts
export function preflightPlan(dag: PlanDag, deps: {
  registry: PatternRegistry
  router: CapabilityRouter
  resolveCtx?: ResolveCtxProvider        // the SAME provider handed to InlineRuntimeInit; {} silently drops pins and rankings
  sessionId?: string
  audience?: DispatchAudience; allow?: readonly PatternId[]; selfId?: PatternId; inputs?: ZodObject
  alternatives?: 'off' | 'auto'          // what the runtime was built with; decides the wording of `wouldFire`
}): PlanPreflightReport

export interface PlanPreflightReport {
  ok: boolean                            // no problems AND no unsatisfiable atomic step without an applicable alternative
  problems: readonly PlanProblem[]       // validatePlan; non-empty ⇒ steps is empty
  steps: readonly {
    id: string; pattern: PatternId; kind: 'atomic' | 'meta'; level: number
    routing:
      | { kind: 'selected'; model: string; by: string; explanation?: RoutingExplanation }
      | { kind: 'unsatisfiable'; reason: UnavailabilityReason; explanation?: RoutingExplanation;
          alternative?: AvailableAlternative & { wouldFire: boolean } }   // first applicable; wouldFire = alternatives === 'auto'
      | { kind: 'opaque'; plannedDispatches?: readonly PatternId[]; nested?: PlanPreflightReport }
  }[]
  levels: readonly string[][]
  unsatisfiable: readonly string[]
}
```

Per atomic step it synthesises `spec = { patternId, input: step.input,
sessionId }` (refs unsubstituted — providers key on pattern, session and
providerOptions, not on prompt text), obtains `ctx = resolveCtx?.(spec) ?? {}`,
and calls `router.explain?.(pattern.id as Capability, primary.modelTags ?? [],
ctx)` — `explain` is optional on the interface and must be feature-detected
(`capability-router.ts:84-90`); when absent it degrades to `checkSatisfiable`,
which every router implements. The default router's `explain` runs the same
screen as `resolve`, calls no model and mutates nothing
(`capability-router-default.ts:117-135`). When unsatisfiable it evaluates the
attached alternatives with the runtime's own `appliesWhen`
(`alternatives.ts:112-130`), `requestedSemantics` read from
`step.input.requiresSemantics` as `inline.ts:147-152` does, and reports the
first match — "would fire under `auto`", never "will", because
`InlineRuntimeInit.alternatives` defaults to `'off'` (DESIGN.md:185-201). A
meta step is `opaque` (compose is code, no capability); a meta with
`origin: 'plan'` is expanded one level through its `plan` field so a persisted
plan's atomics are explained too; any other meta reports its
`plannedDispatches` when declared. The report is data; `formatPlanPreflight`
is a pure formatter in the style of `formatRoutingExplanation`
(`routing-explanation.ts:129-216`). Nothing prints.

The host turns it into a gate with its own handler, outside any job:

```ts
const report = preflightPlan(dag, { registry, router, resolveCtx, sessionId, audience: 'chat-turn', alternatives: 'off' })
if (report.problems.length) return showProblems(report.problems)        // PLAN_INVALID, nothing ran
const yes = await askUser.confirm({
  title: `Run ${report.steps.length} steps in ${report.levels.length} stages?`,
  body: formatPlanPreflight(report),
  // describe   text-generation   → openai:gpt-4.1
  // render     text-to-image     → fal:flux-pro
  // animate    image-to-video    ✗ no-model-in-catalog (would fall back to meta_image-to-video-via-frames under auto: loses camera-motion)
})
if (yes) await runtime.submitJob({ patternId: 'meta_plan', input: dag, sessionId })
```

A `confirm: true` option on `planToMeta` that asked from inside `compose` was
rejected: compose has no router (`meta-execution-context.ts:601-624`) so it
could not show models, `askUser` parks without replay, and the spend decision
is the host's.

## Trust

**Allowlist inheritance — the rule.** A plan's inner steps are held to the
same allowlist as the call that dispatched the plan: inside an agent loop,
every pattern a plan will dispatch must be in that agent's
`effectiveToolPatternIds`, must not be `agent_`-prefixed, and must not be on
the ancestor chain; a plan that names anything else is refused as a tool
result before `submitChild`, with nothing dispatched.

**Where it is enforced.** Today a meta dispatched by an agent inherits no
allowlist at all: `_submitJobInternal` checks only `registry.get`
(`inline.ts:700-707`), `dispatch()` branches on kind, and `ctx.step` adds only
`DUPLICATE_STEP_ID` and `CIRCULAR_META_STEP` (`meta-execution-context.ts:383-404`)
— so any meta in `toolPatternIds` can step into `no-tool` patterns and
`agent_*` patterns, and the guards suite builds its ring through exactly that
(`agent-tool-guards.test.ts:91-113`). For a hand-written meta that is
tolerable: a human who put `meta_storyboard` in `toolPatternIds` reviewed its
step list. A plan's step list is written by the model at call time — the case
DESIGN.md:385-403 ("capabilities are off by default, opened explicitly by the
author") exists for. The mechanism is a declared dispatch set, not a branch on
a pattern id:

```ts
// packages/orchestral-core/src/pattern.ts — MetaPattern
/** The pattern ids this meta will dispatch for a given input, when knowable
 *  before compose runs. An agent loop checks them against its allowlist
 *  before submitting; undeclared means "not knowable", which is the status
 *  quo for every hand-written meta. */
plannedDispatches?: (input: I) => readonly PatternId[]
```

In `onToolCall`, after `resolveDispatchTarget` succeeds and the three existing
guards have passed (`agent-dispatch.ts:820-961`), and before `submitChild`
(`:991`): if `target.pattern.plannedDispatches` exists, each returned id is
checked against `effectiveToolPatternIds`, `DEFAULT_SUBAGENT_BLOCKLIST`
(`catalog.ts:57-63`) and `visited`; the first offender produces the existing
refusal shapes — `SUBAGENT_TOOL_OUT_OF_SCOPE`, `SUBAGENT_BLOCKED`,
`CIRCULAR_AGENT_TOOL` — with an added `via: <offending id>` field, preceded by
the awaited `job:tool-rejected` event with the same code, exactly as the
direct guards do (`:851-880`, the convention commit 66ada20 made observable).
The agent job settles `done`, not errored; refused calls do not count against
the envelope. The runtime never names `meta_plan`: the one-shot declares
`plannedDispatches` like any meta would, a persisted plan declares its static
list, and a shipped meta may opt in later. This closes the hole for plans and
for any meta that declares; it does not retroactively change undeclared
metas, which is a separate decision about every meta.

**Origin.** `PatternBase.origin?: 'plan'` (`pattern.ts:57`; propagates to all
three kinds). Absent means authored code. The registry stores it type-erased
(`registry.ts:221`), `addFromManifest` does not check it, and no runtime
path branches on it — provenance is readable, never a gate. The one reader is
the validator, which pairs it with the *absence* of a `.plan` step list to
recognise the one-shot interpreter (rule 12a and the walk's nested-DAG skip):
a statement about what the step's input IS, not a permission derived from
where the pattern came from. `etc/core.api.md` gains it between `namespace?`
and `outputs`.

**Bounds.** Everything a model can fill is bounded by the schema: step ids
and labels ≤ 64, pattern ids ≤ 128, ≤ 64 steps, ≤ 32 refs per slot, ≤ 64
output entries, description ≤ 512, retry attempts ≤ 5 and delays ≤ 60 s /
300 s. Step input strings are bounded by the target's own schema, as they are
for `dispatch_pattern` today. Outputs: labels ≤ 64, values ≤ 65 536, no
nested echo of step outputs.

**Refusals and where each bites.**

| refused | schema | submit walk | runtime |
|---|---|---|---|
| `agent_*` targets | `.describe` | `PLAN_PATTERN_KIND_AGENT`; `plannedDispatches` guard | `maxAgentDepth` via inherited `visited` only |
| `meta_plan` / self | `.describe` | `PLAN_PATTERN_SELF` (self), `PLAN_PATTERN_ONE_SHOT` (from any other plan) | `CIRCULAR_META_STEP` (`meta-execution-context.ts:396-404`) |
| host-only (`no-tool`) targets | — | `PLAN_PATTERN_NOT_EXPOSED` | none (`inline.ts:701-707`) |
| patterns outside the agent's list | — | `PLAN_PATTERN_NOT_ALLOWED`; `plannedDispatches` guard | none |
| cycles, forward refs | `.describe` | `PLAN_REF_FORWARD` | unrepresentable |
| expressions, interpolation, loops | regex `pattern` | `PLAN_REF_SYNTAX`, `PLAN_REF_IN_LITERAL` | n/a |
| an assetId inside an input | — | `PLAN_REF_INTO_ASSETS` | n/a |
| dual-sourced slots | `.describe` | `PLAN_SLOT_DUAL_SOURCE` | `DUAL_SOURCE_SINGLE_SLOT` |
| `/` in ids | regex | — | (would be namespaced) |
| `askUser`, `submitJob`, `compute` | not in the grammar | — | n/a |
| unbounded output | `PlanOutputSchema` | audit at register | `OUTPUT_SCHEMA_MISMATCH` |

## What we deliberately do not do

### We don't evaluate anything in a plan
**Why.** A `$ref` is a path, not an expression: no interpolation, no
arithmetic, no conditionals, no `map`. The cost is real and named: none of
the three shipped metas can be written as a plan, because each parses JSON
out of a `text-generation` `.text` and fans out to a width the model chose
(`product-photo-pack/index.ts:81-111`, `storyboard/index.ts:392-445`,
`image-best-of-n/index.ts:166-255`). The moment the grammar can express `if`
it is a second Pattern language with none of the type checking the first one
has, and it needs the sandbox DESIGN.md:35-50 refuses.
**Instead.** A transform is a `text-generation` step; a decision is a shipped
meta called as one step (`$hero.assets[label=winner]`); a dynamic width is
authored as a fixed one.
**Where.** `packages/orchestral-plan/src/plan.ts` (the three regexes);
`validatePlan` rules 4 and 9.

<!-- DESIGN: plan-doc-no-evaluation -->

### We don't give a plan its own Alternatives
**Why.** `Alternative.via.mapInput` / `mapOutput` are closures by design
(`alternative.ts:87-135`) and cannot survive JSON. Alternatives are also
evaluated only for atomic dispatches (`inline.ts:1040-1110`), so a meta — plan
or hand-written — never has semantic fallback of its own.
**Instead.** A plan inherits whatever is attached to the atomics it
dispatches; `preflightPlan` reports which would fire, and the runtime's
`alternatives` mode still decides whether one does.
**Where.** `preflightPlan` (`routing.alternative`).

### We don't add a partial-success state
**Why.** A plan is a meta, so the job is one row whatever the interpreter does
inside it. The steps that succeeded are already rows of their own in the
JobStore and hit on the next submit; a status for "some steps done" would be a
second source of truth for what the store already records, and a column on every
host store to serve it. The argument does not depend on how a level is
scheduled — the keep-going walk banks MORE of a failed plan, which strengthens
it: the more a resubmit finds already there, the less such a status could tell
anyone that the store cannot.
**Instead.** `job.error.details.planStepId` names the step; `job:step` events
name the ones that landed; resubmit.
**Where.** "Execution — Failure"; DESIGN.md, "We don't add a partial-success
state for plans".

### We don't rewrite a step's input at execution
**Why.** The layer-2 parse is a gate that dispatches the original value. A
defaults-applied copy would change the child's idempotency input relative to
a hand-written meta's and, for `text-generation`, key every plan step
differently from every meta step with the same prompt.
**Instead.** `safeParse` for the verdict, dispatch the input as written.
**Where.** `runPlan`, step 4.

### We don't close the allowlist bypass for hand-written metas here
**Why.** It predates plans, the guards suite depends on it
(`agent-tool-guards.test.ts:91-113`), and changing it is a decision about
every meta, not a plan feature.
**Instead.** `plannedDispatches` is an opt-in any meta can declare; the
shipped catalog took it up afterwards and now declares end to end, so the
bypass is only as wide as the metas that stay silent. Requiring the
declaration is refused on its own terms (DESIGN.md, "We don't require a meta
to declare what it dispatches").
**Where.** `agent-dispatch.ts` guard, "Trust".

### We don't namespace `job:step` ids or mint handles for inner steps
**Why.** Both are engine-wide changes with a one-line host workaround
(`childJobId`) and would make a plan more visible, not more correct.
Intermediate lineage stays a host concern; the plan's `output.assets` is the
model-facing surface.
**Instead.** Key a progress UI on `childJobId`; list what should be
addressable in `output`.
**Where.** `inline.ts:1498-1510`; `meta-execution-context.ts:492-507`.

### We don't gate spend inside the interpreter
**Why.** The host decides on spend (DESIGN.md:327-343); compose has no router
to show a model with, and `askUser` consumes the step counter and parks
without replay.
**Instead.** `preflightPlan` + the host's own `AskUserHandler` before
`submitJob`; `beforeDispatch` for a cap.
**Where.** "Preflight".

## Open decisions for the owner

1. **`requiredOps: ['getPattern']` as the registry channel for factories.**
   It reuses the one mechanism a manifest-loaded factory has for host
   functions; the objection is that the doc's example is ffmpeg.
   Recommendation: adopt it, and widen the `requiredOps` doc at
   `manifest.ts:51-62` to say "a function the host supplies, media work or a
   registry read". The alternative — `ExecutionContext.patterns` — puts
   registry access on the compose contract the engine deliberately keeps
   inside `MetaCtxDeps` (`meta-execution-context.ts:91-161`).
2. **Ship `registry.scope()` or document `try/finally` over `unregister`.**
   Equivalent in code; the method is ~15 lines and gives the two rules
   (dispose after terminal, `no-tool` default) a place to be documented.
   Recommendation: ship it, exactly that small, and say in its doc that it
   is not a lifecycle.
3. **`$step.json.<path>` for `responseFormat: 'json'` text steps.** Parsing
   what a step declared it would emit is arguably not a transform, and it is
   the one thing between a plan and the "describe, then fan out" shape.
   Recommendation: defer; v1 is static pipelines, and the projection is
   additive to the grammar later.
4. **Agent-path failure shape.** A failed plan step rejects out of
   `onToolCall` (`agent-dispatch.ts:991-1021`; `SUBAGENT_TOOL_FAILED` is
   reachable only through a non-conforming store), so the model never reads
   `planStepId`. Recommendation: a separate change that catches the throw
   and returns `SUBAGENT_TOOL_FAILED` with `inner_code` and `details` — the
   protocol-level change the code already flags, benefiting every sub-tool.
5. **Should shipped metas declare `plannedDispatches`?** It would apply the
   agent allowlist to `meta_storyboard`'s and `meta_image-best-of-n`'s inner
   steps uniformly (best-of-n's `innerPatternId` is an input value, so it can
   return it). Recommendation: yes, as a follow-up with its own test changes
   in `agent-tool-guards.test.ts`. **Decided: yes**, and shipped — all nine
   registered metas declare, pinned per meta and swept in
   `packages/orchestral-patterns/src/__tests__/meta-planned-dispatches.test.ts`.
   `agent-tool-guards.test.ts` needed nothing: it declares its own fixture
   metas, so the guard's behaviour was never keyed to the catalog.

## Implementation order

Dependency order; each step leaves the tree green.

The paths below are the ones the feature first landed on, kept as written: the
plan feature has since moved whole into `@orchestral/plan` (schema, walk,
interpreter and preflight), so read steps 3–5 as a record of the original build
rather than as a map of the tree.

1. `packages/orchestral-core/src/execution-context.ts` — `StepOptions.identity` (+8).
   `packages/orchestral-core/src/job.ts` — `JobSpec.stepKey`, IDENTITY-group doc at :80-96, fix the `META_STEP_FAILED` sentence at :250 (+12).
   `packages/orchestral-core/src/pattern.ts` — `PatternBase.origin?`, `MetaPattern.plannedDispatches?` (+25).
2. `packages/orchestral-runtime/src/idempotency.ts` — `DeriveIdempotencyKeyInput.stepKey`, conditional spread, doc (+12).
   `packages/orchestral-runtime/src/meta-execution-context.ts:366-481` — identity branch, `STEP_IDENTITY_REQUIRES_STEP_ID` (+25).
   Tests: `idempotency-stability.test.ts` unchanged plus a second snapshot for a `stepKey` input; new `meta-step-identity-id.test.ts` (reorder, insert, nested namespace) (~140).
3. `packages/orchestral-core/src/plan.ts` — schema, regexes, `PlanDag`, `PlanOutputSchema` types (~150).
   `packages/orchestral-core/src/plan-validate.ts` — `validatePlan`, `assertPlanValid`, `planRefine`, `PlanProblem`, `PlanInvalidError` (~320).
   `packages/orchestral-core/src/registry.ts` — `scope()` (+20). `index.ts` exports (+15).
   Tests: `plan-validate.test.ts` — every rule, the superRefine-through-passthrough path, `$5.99` literal, `available` keys on a path miss (~320); `registry-scope.test.ts` (~40).
4. `packages/orchestral-patterns/src/meta/plan/index.ts` — `planToMeta`, `runPlan`, `createPlanMeta`, `PLAN_PATTERN_ID`, `PLAN_TOOL_DESCRIPTION` (~340); `src/index.ts` export; `package.json` manifest entry with `requiredOps`.
   Tests over an in-memory runtime: red bicycle, three takes + winner, re-run after insert (id-keyed hits), failure code preserved with `planStepId`, in-flight null, layer-2 gate dispatches the original input, output audit clean, `tool.inputs` survives `toJsonSchema` (~380).
5. `packages/orchestral-runtime/src/preflight-plan.ts` — `preflightPlan`, `formatPlanPreflight`, report types; barrel exports plus `AvailableAlternative` (~220). Test with a router that lacks `explain` and one that has it (~140).
6. `packages/orchestral-runtime/src/agent-dispatch.ts:961-991` — `plannedDispatches` guard, `via` field, `job:tool-rejected` (~45). `agent-tool-guards.test.ts` — out-of-scope, blocked and circular inner steps refused as tool results (~120).
7. `examples/plan-short-clip/` — the persisted form of the red bicycle, asserting the same dedup trace as `examples/incremental-rerun` (~90).
8. Docs and reports. `pnpm api:update` for `packages/orchestral-core/etc/core.api.md` (`origin?`, `plannedDispatches?`, `identity?`, `stepKey?`, `scope()`, the plan exports), `packages/orchestral-runtime/etc/runtime.api.md` (`preflightPlan`, report types, `AvailableAlternative`, `DeriveIdempotencyKeyInput.stepKey`), `packages/orchestral-patterns/etc/patterns.api.md` (`planToMeta`, `createPlanMeta`, `PLAN_PATTERN_ID`, `PlanOutputSchema`); commit them with the change (CONTRIBUTING.md:37). `DESIGN.md`: new entries from "What we deliberately do not do"; "We don't content-hash step ids" gains a paragraph naming `identity: 'id'` as the second documented bypass; `idempotency.ts:27-57` and `manifest.ts:51-62` docs updated. `CHANGELOG.md` in core, runtime, patterns.

## Rejected alternatives

| alternative | why not | proposed by |
|---|---|---|
| A `plan` Pattern kind | `kind` selects the dispatch engine; a plan runs on the meta engine unchanged. Adding a kind touches `PATTERN_KINDS`, `idCarriesKind`, the blocklist and every kind filter for no new behaviour. | context (refused) |
| `{{ }}` interpolation in strings | The first rung of an expression language; concatenation is a `text-generation` step. | A, B, C (all rejected) |
| `map` / `repeat` nodes for fan-out | Dynamic width is what the shipped metas need and what cannot be validated or drawn before a model answers; N written-out steps is the engine's own fan-out idiom. | A, B, C (all rejected) |
| Any-order steps plus Kahn sorting | Backward-only refs make cycles unrepresentable and the list *is* the topological order the model already thinks in. | A, B, C (all rejected) |
| Promise-graph scheduling (each step starts when its last dependency settles) | Makes the tree-shared counter timing-dependent (`meta-execution-context.ts:366`), so nested shipped metas lose positional dedup. That is the whole of the objection now: the second half of it — "a failed plan keeps dispatching branches whose deps later fulfil" — described the *level loop's* behaviour too once the walk stopped aborting a level on the first rejection, and running independent branches after a failure is now deliberate rather than a leak. What the level loop still buys, and a promise graph cannot, is call-time determinism; what it costs is that a capped level gives that up as well (`RunPlanOptions.concurrency`). | C |
| `version: z.literal(1)` on the DAG | The second version number DESIGN.md:51-59 refuses; the one-shot is versioned with `meta_plan`, a persisted plan by its package. | B |
| `steps[].childJobId` in the plan output | Compose cannot obtain it (`StepMeta` is `{ stepId, attempts, durationMs }`, `execution-context.ts:41-45`); every successful run would trip the output gate. | B |
| `checkPermissions` as a validation backstop | Its refusal is `PERMISSION_DENIED`, not `PLAN_INVALID` (`pattern.ts:195-218`), and it receives no registry. | B |
| `origin: 'plan-interpreter'` driving an agent-dispatch branch | Provenance is a field, not a kind (decision 1); coupling the engine to one pattern's input shape. `plannedDispatches` does the job generically. | A |
| `if (fullId === META_PLAN_PATTERN_ID)` in `agent-dispatch.ts` | No file in the runtime names a content pattern id today; `AGENT_FINISH_TOOL_NAME` is a runtime-owned tool, not a pattern. | C |
| `ExecutionContext.patterns` | Puts registry access on the compose contract the engine keeps inside `MetaCtxDeps` (`meta-execution-context.ts:91-161`); a construction-time `lookup` needs no contract change. | C |
| `output` optional with an implicit "last step's assets" default | Behaviour by omission; a plan that returns nothing is money for nothing, and the declaration is one line. | C |
| `$$` escape for a literal `$` | Rewrites any literal containing `$$` (LaTeX, currency tables) and so changes the child's idempotency input; letter-initial ids make the escape unnecessary. | A |
| No execution-time input parse | The stated reason (defaults would rewrite the input) is false for a gate that dispatches the original value; the gap it leaves — a wrong-typed ref failing in the adapter after upstream spend — is real. | A |
| `renderPlanMermaid` in core | A host/UI concern in the contract package (DESIGN.md:490-504). | A |
| `StepOptions.idempotencyKey` from `ctx.step` as **the** identity mechanism | **Rejected, and still rejected as *the* mechanism.** It puts the hash recipe in pattern code and lets an author forget `assets`; the allowlist in `deriveIdempotencyKey` stays the one place, and `identity: 'id'` is what a plan uses by default. **Shipped as a third bypass since**, because the objection was to it *replacing* the derivation, not to it existing beside one: the derivation hashes `sessionId` by design, so reuse that outlives a session is not expressible by choosing an `identity` mode, and that is a real question the library was answering with "you cannot ask". The forgotten-field failure is bounded rather than waved away — same pattern, a stale but schema-valid result the caller owns; a key that crosses patterns is refused outright (`IDEMPOTENCY_KEY_CROSS_PATTERN`), and one that collides on a fan-out surfaces as `PLAN_STEP_IN_FLIGHT`. Opt-in per step, absent by default, and every stored key unmoved. | context option (i) |
| Hashing `stepIdNamespace` unconditionally | Changes every existing key (`idempotency.ts:55-58`); it is a prefix, not an identity. | — |
| `$input.assets[slot=…]` as a further production | **Rejected because** it gives `$input` two meanings in the rendered grammar, one of which the one-shot can never satisfy. **Accepted since, for declaring plans only**, because both halves of that objection are now answered rather than tolerated. The two meanings are not ambiguous: `PLAN_ASSET_REF_RE` carves `input.` out of its head, so exactly one production matches any string and a parse discriminates on which — and the two fail closed by name rather than by resolving to nothing (`PLAN_INPUT_ASSET_NOT_ALLOWED`, `PLAN_INPUT_SLOT_UNKNOWN`). The unsatisfiable half **stood**, and is why the one-shot is carved out rather than argued away: `createPlanMeta` renders `planDagSchema({ inputAssets: false })`, so a plan that can never declare slots is never shown the form. What made the difference is that a plan is a MetaPattern and every other MetaPattern declares the media it takes; without this, a plan was the one pattern kind whose caller had to thread an asset id through as an untyped string. | C |
| Moving `sumCosts` into core | Unnecessary once the interpreter lives in patterns, where `sumCosts` already is. | A, B |
| A `confirm: true` option calling `ctx.askUser` inside compose | No router in compose to show models; parks without replay; spend is the host's decision. | A, B, C (all rejected) |
| A TTL / auto-dispose on `scope()` | A clock the library does not own (DESIGN.md:327-343). | B (rejected) |