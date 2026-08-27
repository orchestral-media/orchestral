// The plan interpreter — a meta whose `compose` is a list of steps.
//
// `planToMeta(dag, opts)` walks a `PlanDag` with the registry in hand and
// dispatches it through `ctx.step`; it never evaluates anything. A `$ref` is a
// path, not an expression, so everything a plan gets — validation before spend,
// content-addressed dedup per step, cancellation, `job:step` events — is a
// property the meta engine already gives a hand-written meta.
//
// It lives beside the schema it walks (plan.ts), the walk that refuses a bad
// one (validate.ts) and the preflight that prices one (preflight.ts). The two
// conventions it reads are `label` on a produced asset (how
// `$hero.assets[label=winner]` resolves) and `sumCosts`' "any null makes the
// total null" rule — both of which are core's, on `producedAssetShape` and
// `metaEnvelopeShape.cost`.
//
// Three forms, one primitive:
//
//   • the one-shot `meta_plan`, whose INPUT is the DAG (`createPlanMeta`);
//   • a session-scoped plan, `registry.scope().add(planToMeta(dag, …))`;
//   • a persisted plan package, whose factory calls `planToMeta` on a JSON
//     literal (examples/plan-short-clip).
//
// The last two bind `$input` to the factory's own `inputs` schema; the
// one-shot has no parameters, so `$input` is refused there by rule 8.

import {
  parallel,
  sumCosts,
  type DispatchAudience,
  type ExecutionContext,
  type MetaPattern,
  type Pattern,
  type PatternExposure,
  type PatternId,
  type PatternRef,
  type ResolvedAssetRef,
} from '@orchestral/core'
import { z } from 'zod'

import {
  PlanDagSchema,
  PlanOutputSchema,
  type PlanDag,
  type PlanOutput,
  type PlanStep,
} from './plan'
import { parseAssetRef, parseValueRef, planLevels } from './refs'
import {
  PlanInvalidError,
  planRefine,
  validatePlan,
  type PlanPatternLookup,
  type PlanProblem,
  type PlanProblemCode,
} from './validate'

// ── The one-shot's identity ─────────────────────────────────────────────

/** @alpha The shipped one-shot plan meta: its input IS the DAG. */
export const PLAN_PATTERN_ID = 'meta_plan' as const

/**
 * @alpha
 * `meta_plan`'s tool description. Long on purpose: `find_pattern` renders the
 * DAG schema but not the graph rules (a `.superRefine` is invisible to
 * `toJsonSchema`), so everything the walk will refuse has to be readable here
 * or the model learns it one rejected turn at a time.
 */
export const PLAN_TOOL_DESCRIPTION =
  'Run a fixed pipeline of registered patterns as one job: you write the steps ' +
  'as data and the runtime executes them in dependency order, in parallel ' +
  'where possible, caching completed steps across re-runs in this session. Use ' +
  'it when you already know the whole pipeline instead of calling patterns one ' +
  'at a time. First call find_pattern for every pattern you intend to use ' +
  '(query `select:text-to-image,image-to-video`, or `meta_*`) and copy each ' +
  "step's `input` from its primary.inputSchema — this tool does not know the " +
  "step schemas. Reference an earlier step's value with `$<stepId>.<path>` as " +
  'a whole string (e.g. `"prompt": "$describe.text"`; text-generation\'s text ' +
  'is at `.text`). Feed media an earlier step produced into a reference slot ' +
  'with `"assets": { "<slot>": "$<stepId>.assets[0]" }`, where `<slot>` is a ' +
  "key of that pattern's `references`; use `$<stepId>.assets[label=winner]` " +
  'for a meta_* step. Never put a `$…assets[…]` ref inside `input`. Steps may ' +
  'only reference steps listed before them; steps that do not reference each ' +
  'other run concurrently — write a fan-out as several steps with distinct ' +
  'ids. No conditionals, loops or text transforms: add a text-generation step ' +
  'to transform text, and call a meta_* pattern (e.g. meta_image-best-of-n) ' +
  'for choose-the-best logic. agent_* patterns and meta_plan itself are not ' +
  'allowed. `output` lists what comes back: media with a role label, text ' +
  'under `values`. The result is `{ assets[], values{}, steps[], cost, ' +
  'latencyMs }`. If the plan is invalid you get every problem at once and ' +
  'nothing runs; a failing step fails the job and the steps that succeeded are ' +
  'not re-run when you resubmit.'

// ── Options ─────────────────────────────────────────────────────────────

/** @alpha Everything `planToMeta` needs that is not in the DAG itself. */
export interface PlanToMetaOptions {
  /**
   * The pattern id the plan registers under. Must start with `meta_` — the
   * registry refuses a kind/prefix mismatch, and this throws `PLAN_ID_INVALID`
   * first so the mistake is named at construction rather than at `add()`.
   */
  id: PatternId
  /**
   * The registry reads the walk and the interpreter need. Pass the
   * `PatternRegistry` itself, or a `{ get, getEntry }` pair closed over a
   * manifest factory's `ops.getPattern` — a factory loaded through
   * `addFromManifest` never receives the registry object.
   */
  lookup: PlanPatternLookup
  /**
   * The plan's own parameters. Becomes the pattern's `tool.inputs` AND what
   * `$input.<field>` binds to; absent means the plan takes no parameters and
   * every `$input` reference is refused.
   */
  inputs?: z.ZodObject
  /** Catalog copy. Defaults to the DAG's own `description`. */
  description?: string
  /** BM25 boost field for `find_pattern`. Omitted when not given. */
  searchHint?: string
  /**
   * Who may call it. Defaults to `'no-tool'`: a plan built at runtime is a
   * host's or a session's, and a sub-agent's `find_pattern` re-indexes the
   * registry at every dispatch — a session plan should not become another
   * loop's tool by accident. A shipped plan package passes `'tool'`.
   */
  exposure?: PatternExposure
}

/**
 * @alpha
 * What `planToMeta` returns: an ordinary `MetaPattern`, plus the DAG it
 * interprets. `plan` rides on the object so a catalog UI can draw the pipeline
 * and `preflightPlan` can expand a plan-origin meta step one level instead of
 * reporting it as opaque.
 */
export interface PlanMetaPattern<I = Record<string, unknown>>
  extends MetaPattern<I, PlanOutput> {
  /** The step list this pattern interprets. Frozen at construction. */
  readonly plan: PlanDag
}

// ── planToMeta ──────────────────────────────────────────────────────────

/**
 * @alpha
 * Turn a DAG into a `MetaPattern`.
 *
 * The registry-free half of layer 1 runs HERE, at construction: the grammar,
 * step-id uniqueness, backward-only references and the output block are
 * properties of the data alone, so a malformed plan is a `PlanInvalidError`
 * from the factory rather than a job that fails on submit. The registry rules
 * (is the pattern registered, is it an agent, does the slot exist) deliberately
 * wait for `compose` — `addFromManifest` builds every pattern in a package
 * before it registers any of them, so a factory that demanded a populated
 * registry could never be loaded from a manifest at all.
 */
export function planToMeta<I extends Record<string, unknown> = Record<string, unknown>>(
  dag: PlanDag,
  opts: PlanToMetaOptions,
): PlanMetaPattern<I> {
  if (!opts.id.startsWith('meta_')) {
    throw planError(
      'PLAN_ID_INVALID',
      `"${opts.id}" is not a legal id for a plan: a plan is a meta, so its id ` +
        'must start with "meta_" (the registry refuses a kind/prefix mismatch).',
      { id: opts.id },
    )
  }
  assertConstructionTimeValid(dag, opts)

  const inputs = opts.inputs
  const description =
    opts.description ??
    dag.description ??
    `A ${dag.steps.length}-step pipeline authored as data.`
  const patternIds = dag.steps.map((s) => s.pattern as PatternId)

  return {
    id: opts.id,
    kind: 'meta',
    origin: 'plan',
    namespace: 'meta-pipelines',
    exposure: opts.exposure ?? 'no-tool',
    description,
    ...(opts.searchHint !== undefined ? { searchHint: opts.searchHint } : {}),
    tool: {
      description,
      // The plan's parameters, not the DAG: the step list is fixed here, so a
      // caller fills `$input`, nothing else. A parameterless plan gets a plain
      // (non-strict) `z.object({})`, matching how the dispatch path parses an
      // input — top-level extras pass through rather than being refused.
      inputs: (inputs ?? z.object({})) as unknown as z.ZodType<I>,
    },
    outputs: PlanOutputSchema as unknown as z.ZodType<PlanOutput>,
    // Static: the step list cannot change between calls, so an agent loop can
    // hold every id it will dispatch to its own allowlist before submitting.
    plannedDispatches: () => patternIds,
    plan: dag,
    compose: ({ input }, ctx) =>
      runPlan(
        dag,
        opts.lookup,
        { selfId: opts.id, ...(inputs !== undefined ? { inputs } : {}) },
        (input ?? {}) as Record<string, unknown>,
        ctx,
      ),
  }
}

// ── createPlanMeta — the shipped one-shot ───────────────────────────────

/**
 * @alpha
 * Build `meta_plan`, the one-shot whose input IS a DAG.
 *
 * `ops.getPattern` is the manifest's `requiredOps: ["getPattern"]` channel:
 * `compose` receives no registry and a manifest-loaded factory receives only
 * `ops`, so a host function is the honest way for the walk to reach the
 * registry. A host wiring by hand passes
 * `createPlanMeta({ getPattern: (id) => registry.get(id) })`.
 *
 * `exposureMode: 'deferred'` because the rendered DAG schema is a few KB of
 * byte-stable prefix on every turn for a tool used rarely, and the model has to
 * call `find_pattern` per step anyway; a host may flip it.
 */
export function createPlanMeta(
  ops: { getPattern: (id: PatternId) => Pattern | undefined },
  init: { audience?: DispatchAudience } = {},
): MetaPattern<PlanDag, PlanOutput> {
  const lookup = lookupFromGetPattern(ops)
  const audience = init.audience ?? 'agent-loop'
  return {
    id: PLAN_PATTERN_ID,
    kind: 'meta',
    origin: 'plan',
    namespace: 'meta-pipelines',
    exposure: 'tool',
    exposureMode: 'deferred',
    description:
      'Execute an LLM-authored pipeline of registered patterns as one meta job.',
    // Names no atomic capability on purpose: searchHint is a boost-5.0 field
    // in the BM25 index, and "text-to-image" here would put meta_plan into the
    // top five of every atomic query.
    searchHint:
      'pipeline; multi-step; chain several patterns; fan out then judge; workflow as data',
    tool: {
      description: PLAN_TOOL_DESCRIPTION,
      // The whole of layer 1 as a refine, so every problem reaches the model
      // through the INPUT_VALIDATION_FAILED tool result the dispatch path
      // already produces. Invisible to `toJsonSchema` — which is why the rules
      // it enforces are also spelled out in the schema's `.describe()` copy and
      // in the tool description above.
      inputs: PlanDagSchema.superRefine(
        planRefine(lookup, { selfId: PLAN_PATTERN_ID, audience }),
      ) as unknown as z.ZodType<PlanDag>,
    },
    outputs: PlanOutputSchema as unknown as z.ZodType<PlanOutput>,
    // Read defensively: this runs on the dispatch path, and the host-direct
    // submit never parses an input against `tool.inputs`.
    plannedDispatches: (dag) =>
      (Array.isArray(dag?.steps) ? dag.steps : [])
        .map((s) => (s as { pattern?: unknown }).pattern)
        .filter((p): p is PatternId => typeof p === 'string'),
    compose: ({ input }, ctx) =>
      runPlan(input, lookup, { selfId: PLAN_PATTERN_ID }, {}, ctx),
  }
}

/** The `{ get, getEntry }` pair a `requiredOps: ['getPattern']` host supplies. */
function lookupFromGetPattern(ops: {
  getPattern: (id: PatternId) => Pattern | undefined
}): PlanPatternLookup {
  return {
    get: (id) => ops.getPattern(id),
    getEntry: (id) => {
      const pattern = ops.getPattern(id)
      return pattern === undefined ? undefined : { pattern, alternatives: [] }
    },
  }
}

// ── The interpreter ─────────────────────────────────────────────────────

/** What the interpreter reads off a step's output. Everything else flows through. */
interface StepValue {
  cost?: number | null
  assets?: readonly {
    assetId: string
    modality: string
    url?: string
    label?: string
  }[]
  [field: string]: unknown
}

/** @alpha What `runPlan` needs beyond the DAG and the registry. */
export interface RunPlanOptions {
  /** The plan pattern's own id: refuses a self-step, and stamps failures. */
  selfId: PatternId
  /** The plan's parameter schema; binds `$input.<field>`. */
  inputs?: z.ZodObject
}

/**
 * @alpha
 * Execute a DAG as a meta's compose body. Exported because a host that builds
 * a plan pattern by hand (rather than through `planToMeta`) still wants the
 * same eight steps.
 */
export async function runPlan(
  dag: PlanDag,
  lookup: PlanPatternLookup,
  opts: RunPlanOptions,
  planInput: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<PlanOutput> {
  const startedAt = Date.now()

  // 1. Validate, with the registry this time. Zero spend: an unregistered
  //    pattern on level 3 would otherwise surface as PATTERN_NOT_REGISTERED
  //    after levels 1 and 2 had been paid for. No `audience` — the surface was
  //    checked at the boundary, and host-direct submit has no exposure gate.
  const problems = validatePlan(dag, lookup, {
    selfId: opts.selfId,
    ...(opts.inputs !== undefined ? { inputs: opts.inputs } : {}),
  })
  if (problems.length > 0) throw new PlanInvalidError(problems)

  const outputs = new Map<string, StepValue>()

  // 3. Substitution — a whole-string value ref reads a path off the producing
  //    step's STORED output (or off `planInput` for `$input`); anything else is
  //    a literal. There is no interpolation, so nothing here rewrites a string.
  const readRef = (ref: string, site: RefSite): unknown => {
    const parsed = parseValueRef(ref)
    if (parsed === null) return unresolved(ref, site)
    const root = parsed.isInput ? planInput : outputs.get(parsed.head)
    if (root === undefined) return unresolved(ref, site)
    const value = readPath(root, parsed.segments)
    return value === undefined ? unresolved(ref, site) : value
  }

  // 3b. `step.assets` → `PatternRef.assets`. This is the only channel that can
  //     carry a sub-step's product: `ctx.step` mints no handle for what a step
  //     produced, so an inner asset has an assetId and nothing else.
  const readAsset = (
    ref: string,
    site: RefSite,
  ): { assetId: string; modality: string; url?: string } => {
    const parsed = parseAssetRef(ref)
    if (parsed === null) return unresolved(ref, site)
    const produced = outputs.get(parsed.head)?.assets
    if (produced === undefined) return unresolved(ref, site)
    const element =
      parsed.label !== undefined
        ? produced.find((a) => a.label === parsed.label)
        : produced[parsed.index ?? 0]
    if (element === undefined || typeof element.assetId !== 'string') {
      return unresolved(ref, site)
    }
    return element
  }

  const runStep = async (step: PlanStep): Promise<StepValue> => {
    // `validatePlan` already refused an unregistered target; this read is the
    // type narrowing, not a second check.
    const target = lookup.get(step.pattern as PatternId)
    if (target === undefined) {
      throw planError(
        'PLAN_PATTERN_NOT_FOUND',
        `Step "${step.id}" names pattern "${step.pattern}", which is not registered.`,
        { planStepId: step.id, pattern: step.pattern },
      )
    }
    const stepSite: RefSite = { planStepId: step.id, path: ['steps', step.id] }
    const input = substitute(step.input, (ref) => readRef(ref, stepSite)) as Record<
      string,
      unknown
    >
    const assets: ResolvedAssetRef[] = []
    for (const [slot, bound] of Object.entries(step.assets ?? {})) {
      for (const ref of Array.isArray(bound) ? bound : [bound]) {
        const element = readAsset(ref, {
          planStepId: step.id,
          path: ['steps', step.id, 'assets', slot],
        })
        assets.push({
          slot,
          assetId: element.assetId,
          modality: element.modality as ResolvedAssetRef['modality'],
        })
      }
    }

    // 4. Layer 2 — the SUBSTITUTED input against the target's own schema, with
    //    the same top-level passthrough `resolveDispatchTarget` applies, so
    //    `size` / `seed` / `providerOptions` / the derived `references` survive.
    //    A gate, not a rewrite: what gets dispatched below is `input`, the
    //    object built above, never `parsed.data`. zod's copy would carry the
    //    schema's defaults, which would land in the child's idempotency input
    //    and key a plan's text-generation step differently from a hand-written
    //    meta's with the same prompt.
    // DESIGN: plan-layer-2-gate-not-rewrite
    const schema = inputSchemaOf(target)
    if (schema !== undefined) {
      const parsed = passthroughOf(schema).safeParse(input)
      if (!parsed.success) {
        throw planError(
          'PLAN_STEP_INPUT_INVALID',
          `Step "${step.id}" does not match ${step.pattern}'s schema after substitution: ` +
            parsed.error.issues
              .map(
                (i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`,
              )
              .join('; '),
          {
            planStepId: step.id,
            patternId: step.pattern,
            issues: parsed.error.issues,
          },
        )
      }
    }

    // 5. Dispatch. `identity: 'id'` keys the durable row on the namespaced
    //    stepId rather than the counter position, so inserting a step ahead of
    //    this one does not re-key work whose inputs did not change.
    const ref: PatternRef = {
      patternId: step.pattern as PatternId,
      input,
      ...(assets.length > 0 ? { assets } : {}),
    }
    const { value } = await ctx.step.withMeta<StepValue>(ref, {
      stepId: step.id,
      identity: 'id',
      ...(step.retry !== undefined ? { retry: step.retry } : {}),
    })

    // 6. Null guard. A dedup hit on a queued or running row returns that row
    //    without awaiting it, and `ctx.step` hands its `null` output straight
    //    to compose. Refuse rather than feed `null` into the next step's prompt.
    if (value === null || value === undefined) {
      throw planError(
        'PLAN_STEP_IN_FLIGHT',
        `Step "${step.id}" (${step.pattern}) deduped onto a row that has not finished ` +
          'yet, so it has no output to read. Wait for the earlier submit to settle ' +
          'and resubmit; nothing downstream of it ran.',
        { planStepId: step.id, patternId: step.pattern },
      )
    }
    return value
  }

  // 2. Levels. `level(step) = 1 + max(level(dep))` over the backward refs.
  //
  //    Why a level loop and not a promise graph. Every `ctx.step` call advances
  //    a counter that is SHARED across the whole meta tree, and that counter is
  //    the durable key of every POSITIONAL child — the internals of a shipped
  //    meta called as one plan step (`meta_image-best-of-n`'s `candidate-N`
  //    rows are keyed on it). The counter advances at CALL time, so the level
  //    loop below — every step of a level called synchronously inside the
  //    `map`, before anything is awaited — hands those inner steps the same
  //    indices run after run. A scheduler that started each step when its last
  //    dependency settled would decide which step claims which index by
  //    provider latency, and the dedup a plan exists for would fail for exactly
  //    the nested metas the grammar tells an author to reach for.
  //
  //    "The same indices run after run" holds while every earlier step's
  //    compose actually RUNS. A plan step that dedupes to a cached row skips
  //    its compose — and its subtree's counter consumption — so resubmitting a
  //    partly-failed plan that contains two or more nested positional metas
  //    can shift, and thereby re-pay, the completed inner rows of the later
  //    one. That is the engine's documented cost of positional identity
  //    (DESIGN.md, "We don't content-hash step ids"), inherited here, not
  //    introduced: the plan's OWN steps are immune (`identity: 'id'`), and a
  //    plan adds no new identity for other metas' internals.
  //
  //    `parallel` is `Promise.all`: the first rejection rejects the level, no
  //    further level starts, and siblings already in flight complete and
  //    persist — which is what "completed steps stay in the JobStore" means.
  for (const level of planLevels(dag).levels) {
    const promises = level.map((step) =>
      runStep(step).catch((err: unknown) => {
        throw stampPlanStep(err, step.id, opts.selfId)
      }),
    )
    const settled = await parallel(promises)
    // 7. Collect. Keyed by id, which is also what `$<id>.<path>` reads.
    settled.forEach((value, i) => {
      const step = level[i]
      if (step !== undefined) outputs.set(step.id, value)
    })
  }

  // 8. Assemble. `output` is the whole model-facing surface: media the plan
  //    declared, each stamped with its role label, and named text values.
  //    Nothing else leaves — a nested echo of a step's raw output would hand
  //    the model raw asset ids, which the projection's assets-only rewrite
  //    exists to prevent.
  const assets: PlanOutput['assets'] = (dag.output.assets ?? []).map((entry) => {
    const element = readAsset(entry.from, {
      path: ['output', 'assets', entry.label],
    })
    return {
      assetId: element.assetId,
      modality: element.modality as PlanOutput['assets'][number]['modality'],
      ...(element.url !== undefined ? { url: element.url } : {}),
      label: entry.label,
    }
  })

  const values: Record<string, string> = {}
  for (const [name, ref] of Object.entries(dag.output.values ?? {})) {
    const value = readRef(ref, { path: ['output', 'values', name] })
    if (typeof value !== 'string') {
      throw planError(
        'PLAN_OUTPUT_NOT_SCALAR',
        `output.values.${name} ("${ref}") resolved to ${describeType(value)}, not text. ` +
          '`values` returns strings; media belongs in `output.assets`.',
        { name, ref },
      )
    }
    values[name] = value
  }

  return {
    assets,
    values,
    steps: dag.steps.map((step) => ({
      id: step.id,
      pattern: step.pattern,
      cost: finiteCost(outputs.get(step.id)?.cost),
    })),
    // Null if ANY step is unpriced: a partial sum renders as a confident small
    // number, which a host reads as the real total of an unpriced run.
    cost: sumCosts(dag.steps.map((step) => outputs.get(step.id)?.cost)),
    latencyMs: Date.now() - startedAt,
  }
}

// ── Failure ─────────────────────────────────────────────────────────────

/**
 * Stamp which plan step failed onto the error and hand back the SAME object, so
 * the plan's job row carries the innermost code — `OUTPUT_SCHEMA_MISMATCH`,
 * `NO_MODEL_FOR_CAPABILITY`, `PLAN_STEP_INPUT_INVALID` — rather than a wrapper
 * that hides it. `normaliseError` lifts `details` onto `JobError.details`
 * whole, so the host reads which step from `job.error.details.planStepId`.
 *
 * A `CANCELLED` error is passed through untouched: a cascade from
 * `cancelJob(planJobId)` is not a step's failure, and the row it writes is
 * `cancelled`, not `error`.
 * DESIGN: plan-step-failure-stamped
 */
function stampPlanStep(
  err: unknown,
  planStepId: string,
  planPatternId: PatternId,
): unknown {
  if (!(err instanceof Error)) return err
  if ((err as { code?: string }).code === 'CANCELLED') return err
  const existing = (err as { details?: unknown }).details
  ;(err as { details?: unknown }).details = {
    ...(typeof existing === 'object' && existing !== null ? existing : {}),
    planStepId,
    planPatternId,
  }
  return err
}

/** Where a reference was written, for the refusal that names it. */
interface RefSite {
  planStepId?: string
  path: (string | number)[]
}

function unresolved(ref: string, site: RefSite): never {
  throw planError(
    'PLAN_REF_UNRESOLVED',
    `"${ref}" resolved to nothing at ${site.path.join('.')}. The reference is ` +
      'well-formed and its target ran, but that path is absent from what the ' +
      'plan has in hand — an optional output field, an assets[] index past the ' +
      'end, or a label no element carries.',
    {
      ...(site.planStepId !== undefined ? { planStepId: site.planStepId } : {}),
      ref,
      path: site.path,
    },
  )
}

/** Every coded throw the interpreter makes, in the shape `normaliseError` reads. */
function planError(
  code: string,
  message: string,
  details: Record<string, unknown>,
): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code, details })
}

// ── Construction-time validation ────────────────────────────────────────

/**
 * The registry rules, which cannot run at construction. With a lookup that
 * knows nothing, most of them simply never fire — the walk returns early
 * wherever it could not resolve a producer — so only "not registered" has to be
 * dropped by hand.
 */
const REGISTRY_DEPENDENT: ReadonlySet<PlanProblemCode> = new Set([
  'PLAN_PATTERN_NOT_FOUND',
])

/** A lookup that resolves nothing: switches every registry rule off. */
const EMPTY_LOOKUP: PlanPatternLookup = {
  get: () => undefined,
  getEntry: () => undefined,
}

function assertConstructionTimeValid(dag: PlanDag, opts: PlanToMetaOptions): void {
  const problems = validatePlan(dag, EMPTY_LOOKUP, {
    selfId: opts.id,
    ...(opts.inputs !== undefined ? { inputs: opts.inputs } : {}),
  }).filter((p) => !REGISTRY_DEPENDENT.has(p.code))
  if (problems.length > 0) throw new PlanInvalidError(problems as PlanProblem[])
}

// ── Reference grammar ───────────────────────────────────────────────────
//
// The parse and the dependency walk are refs.ts's — one copy for layer 1, the
// interpreter and preflight, which is what makes "the string the walk read as a
// reference is the string substituted here" a function call. What stays below
// is what only execution needs: applying a parsed ref to real values.

/** Replace every whole-string value reference; leave everything else alone. */
function substitute(value: unknown, resolve: (ref: string) => unknown): unknown {
  if (typeof value === 'string') {
    return parseValueRef(value) === null ? value : resolve(value)
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, resolve))
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, resolve)
    return out
  }
  return value
}

function readPath(root: unknown, segments: readonly (string | number)[]): unknown {
  let node: unknown = root
  for (const segment of segments) {
    if (node === null || node === undefined) return undefined
    if (typeof segment === 'number') {
      if (!Array.isArray(node)) return undefined
      node = node[segment]
      continue
    }
    if (typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return node
}

// ── Small helpers ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The schema a dispatch would parse this target's input against. */
function inputSchemaOf(target: Pattern): z.ZodType<unknown> | undefined {
  return target.kind === 'meta' ? target.tool.inputs : target.primary?.tool.inputs
}

/**
 * Top-level `.passthrough()` when the schema supports it — byte-for-byte what
 * `resolveDispatchTarget` does, so the gate's verdict and the dispatch path's
 * verdict cannot disagree.
 */
function passthroughOf(schema: unknown): z.ZodType<unknown> {
  if (
    typeof schema === 'object' &&
    schema !== null &&
    'passthrough' in schema &&
    typeof (schema as { passthrough?: unknown }).passthrough === 'function'
  ) {
    return (schema as { passthrough: () => z.ZodType<unknown> }).passthrough()
  }
  return schema as z.ZodType<unknown>
}

/** `steps[].cost` is `number | null`; an absent or non-finite value is null. */
function finiteCost(cost: number | null | undefined): number | null {
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null
}

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}
