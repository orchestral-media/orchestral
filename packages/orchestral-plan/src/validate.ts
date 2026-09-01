// Plan validation, layer 1 — every problem in a DAG, before any money is spent.
//
// `validatePlan` is pure, synchronous, returns and never throws. EVERY rule
// runs and problems accumulate: the point of this layer is that a model (or a
// host) gets the complete list in one turn instead of discovering mistake two
// after paying for step one. The rules zod can express live in plan.ts; the
// ones it cannot — uniqueness, backward-only references, path existence in a
// producer's output shape, slot modality, registry lookups — live here.
//
// Three call sites, one function:
//
//   • Host-direct: `assertPlanValid(dag, lookup, opts)` before submitJob.
//   • The LLM path: `PlanDagSchema.superRefine(planRefine(lookup, opts))` as a
//     meta's `tool.inputs`. `resolveDispatchTarget` applies top-level
//     `.passthrough()` and `safeParse`s (dispatch-pattern.ts:198-202); on zod
//     4.4.3 `.passthrough()` preserves the refine and reports its issues with
//     their paths, so the walk reaches the model through the existing
//     INPUT_VALIDATION_FAILED tool result with no new hook. The honest limit:
//     zod aborts a superRefine when an earlier check produced
//     `unrecognized_keys` or `invalid_type`, so a first draft with an extra key
//     gets the shape errors in one turn and the walk in the next — the same
//     two-turn cost dispatch_pattern already has.
//   • Inside a plan's `compose`, before the first `ctx.step`, with the lookup
//     the factory closed over — which is what makes "every problem at once,
//     nothing dispatched" hold on the host path too, where a factory built by
//     `addFromManifest` runs before any pattern is registered.
//
// Layer 2 (the per-step parse of the *substituted* input, at execution) lives
// with the interpreter, interpreter.ts.

import type { z } from 'zod'

import type {
  AssetNeed,
  DispatchAudience,
  Pattern,
  PatternId,
  PatternRegistry,
} from '@orchestral/core'
import { resolveExposure } from '@orchestral/core'

import {
  PLAN_ASSET_REF_RE,
  PLAN_VALUE_REF_RE,
  PlanDagSchema,
  type PlanDag,
} from './plan'
import {
  PLAN_REF_MAX_DEPTH,
  collectRefHeads,
  parseAssetRef,
  parseValueRef,
  type ParsedValueRef,
} from './refs'

// ── Vocabulary ──────────────────────────────────────────────────────────

/**
 * Every way a plan can be wrong before it runs. One code per remedy: a model
 * reading a refusal should be able to tell what to edit from the code alone,
 * which is why (for example) an unknown reference target and a forward one are
 * separate codes even though both are "bad `$ref`".
 */
export type PlanProblemCode =
  | 'PLAN_SCHEMA'
  | 'PLAN_STEP_ID_DUPLICATE'
  | 'PLAN_STEP_ID_RESERVED'
  | 'PLAN_REF_SYNTAX'
  | 'PLAN_REF_UNKNOWN_STEP'
  | 'PLAN_REF_FORWARD'
  | 'PLAN_REF_PATH_UNKNOWN'
  | 'PLAN_REF_INTO_ASSETS'
  | 'PLAN_REF_INPUT_NOT_ALLOWED'
  | 'PLAN_PARAM_UNKNOWN'
  | 'PLAN_INPUT_ASSET_NOT_ALLOWED'
  | 'PLAN_INPUT_SLOT_UNKNOWN'
  | 'PLAN_REF_IN_LITERAL'
  | 'PLAN_PATTERN_NOT_FOUND'
  | 'PLAN_PATTERN_KIND_AGENT'
  | 'PLAN_PATTERN_SELF'
  | 'PLAN_PATTERN_ONE_SHOT'
  | 'PLAN_PATTERN_NOT_EXPOSED'
  | 'PLAN_PATTERN_NOT_ALLOWED'
  | 'PLAN_ASSET_PRODUCER_NONE'
  | 'PLAN_ASSET_LABEL_UNSUPPORTED'
  | 'PLAN_SLOT_UNKNOWN'
  | 'PLAN_SLOT_MODALITY'
  | 'PLAN_SLOT_CARDINALITY'
  | 'PLAN_SLOT_DUAL_SOURCE'
  | 'PLAN_SLOT_REQUIRED_UNBOUND'
  | 'PLAN_STEP_INPUT_INVALID'
  | 'PLAN_STEP_UNUSED'
  | 'PLAN_OUTPUT_LABEL_DUPLICATE'
  | 'PLAN_INPUT_NOT_SERIALISABLE'

/** One thing wrong with a plan. */
export interface PlanProblem {
  code: PlanProblemCode
  /** Into the DAG, zod-style — `['steps', 2, 'input', 'prompt']`. */
  path: (string | number)[]
  message: string
  /** The step the problem belongs to, when it belongs to one. */
  stepId?: string
  /** The per-code side fields; see each rule below. */
  details?: Record<string, unknown>
}

/**
 * The registry reads a plan walk needs. `Pick<PatternRegistry, 'get' |
 * 'getEntry'>` rather than the class itself so a host can hand in an
 * `ops.getPattern` closure — a factory loaded through `addFromManifest` gets
 * host operations, never the registry object.
 */
export type PlanPatternLookup = Pick<PatternRegistry, 'get' | 'getEntry'>

/**
 * What the walk cannot read off the DAG or the registry: which surface asked,
 * what that surface is allowed to dispatch, and what `$input` binds to. Every
 * field is optional, and each absent one simply switches its rule off — the
 * host-direct path passes `{}` and gets the graph and registry rules alone.
 */
export interface PlanValidateOptions {
  /**
   * The surface this plan was authored on. Only when given does rule 13 run:
   * host-direct submit has no exposure gate (`inline.ts:701-707`), so "exposed
   * to the surface" is a parameter of the validator, not a fact the registry
   * holds.
   */
  audience?: DispatchAudience
  /**
   * The dispatch allowlist inner steps inherit — an agent's
   * `effectiveToolPatternIds`. Absent means "no allowlist in force".
   */
  allow?: readonly PatternId[]
  /** The id of the plan pattern itself, so a step cannot name it (rule 12). */
  selfId?: PatternId
  /** The reusable plan's own parameter schema; binds `$input.<field>`. */
  inputs?: z.ZodObject
  /**
   * The plan's own declared asset slots; binds `$input.assets[slot=<name>]`.
   *
   * The exact counterpart of `inputs` one field up. A plan is a MetaPattern,
   * and a MetaPattern declares the media it takes as `assetNeeds`; this is that
   * list, handed to the walk so it can tell a slot the plan really offers from
   * a typo. Absent — like an absent `inputs` — switches the channel off
   * entirely rather than accepting any slot name.
   *
   * Must be the SAME list the pattern declares. `planToMeta` guarantees that by
   * forwarding its own; a caller driving `runPlan` by hand and passing a
   * different list would have layer 1 check a contract other than the one the
   * runtime resolved `ctx.assets` against.
   */
  assetNeeds?: readonly AssetNeed[]
}

/** Thrown by {@link assertPlanValid}; `normaliseError` lands it on a job row as `PLAN_INVALID`. */
export class PlanInvalidError extends Error {
  readonly code = 'PLAN_INVALID'
  readonly details: { problems: readonly PlanProblem[] }
  constructor(problems: readonly PlanProblem[]) {
    super(
      `PLAN_INVALID: ${problems.length} problem${problems.length === 1 ? '' : 's'} — ` +
        problems
          .slice(0, 5)
          .map((p) => `${p.code} at ${formatPath(p.path)}`)
          .join('; ') +
        (problems.length > 5 ? `; +${problems.length - 5} more` : ''),
    )
    this.name = 'PlanInvalidError'
    this.details = { problems }
  }
}

function formatPath(path: readonly (string | number)[]): string {
  return path.length === 0 ? '(root)' : path.join('.')
}

// ── Entry points ────────────────────────────────────────────────────────

/**
 * List everything wrong with `dag`. Pure, synchronous, never throws; every
 * rule runs, so the returned array is the complete set of problems, not the
 * first one.
 *
 * `dag` is typed `PlanDag` for the callers that hold one, but treated as
 * untrusted inside: rule 1 re-parses it, and every subsequent rule reads
 * defensively, so a host-constructed literal that does not match the schema
 * still gets the graph rules rather than only the shape errors.
 */
export function validatePlan(
  dag: PlanDag,
  lookup: PlanPatternLookup,
  opts: PlanValidateOptions = {},
): PlanProblem[] {
  return new PlanWalk(dag, lookup, opts).run()
}

/** {@link validatePlan}, as a throw. Use before `submitJob` on the host path. */
export function assertPlanValid(
  dag: PlanDag,
  lookup: PlanPatternLookup,
  opts: PlanValidateOptions = {},
): void {
  const problems = validatePlan(dag, lookup, opts)
  if (problems.length > 0) throw new PlanInvalidError(problems)
}

/**
 * The walk as a zod `superRefine` body — one issue per problem, carrying the
 * code and details in `params` so a tool-result formatter can render them
 * without re-deriving anything.
 *
 * Use as `PlanDagSchema.superRefine(planRefine(lookup, opts))` for a plan
 * meta's `tool.inputs`. The refine is invisible to `toJsonSchema`, so the
 * rendered schema the model reads is the shape alone — which is why the rules
 * this emits are also spelled out in the schema's `.describe()` copy.
 */
export function planRefine(
  lookup: PlanPatternLookup,
  opts: PlanValidateOptions = {},
): (dag: PlanDag, ctx: z.core.$RefinementCtx<PlanDag>) => void {
  return (dag, ctx) => {
    for (const problem of validatePlan(dag, lookup, opts)) {
      ctx.addIssue({
        code: 'custom',
        path: problem.path,
        message: problem.message,
        params: { code: problem.code, details: problem.details },
      })
    }
  }
}

// ── The walk ────────────────────────────────────────────────────────────

/** A step read defensively: any field the schema rejected reads as absent. */
interface StepView {
  index: number
  id?: string
  pattern?: string
  input: Record<string, unknown>
  assets?: Record<string, unknown>
}

/** One `$…` reference found somewhere in the DAG, with where it was found. */
interface RefSite {
  ref: string
  path: (string | number)[]
  stepId?: string
}

/** A ref-shaped run anywhere inside a longer string — rule 9's needle. */
const EMBEDDED_REF_RE =
  /\$([A-Za-z][A-Za-z0-9_-]{0,63})((?:\.[A-Za-z_][A-Za-z0-9_]{0,63}|\[[0-9]{1,3}\])+)/g
/** "Looks like it was meant to be a reference" — rule 4's trigger. */
const REF_INTENT_RE = /^\$[A-Za-z]/

class PlanWalk {
  private readonly problems: PlanProblem[] = []
  private readonly steps: StepView[]
  /** id → the FIRST index that claimed it; a duplicate never becomes a target. */
  private readonly indexById = new Map<string, number>()
  /** Step ids any reference names — rule 22 subtracts this from the step list. */
  private readonly referenced = new Set<string>()
  /** Every declared step id, plus `input`: rule 9's "known" set. */
  private readonly knownHeads = new Set<string>(['input'])

  constructor(
    private readonly dag: PlanDag,
    private readonly lookup: PlanPatternLookup,
    private readonly opts: PlanValidateOptions,
  ) {
    const raw = asRecord(dag)
    const rawSteps: unknown[] = Array.isArray(raw.steps) ? raw.steps : []
    this.steps = rawSteps.map((entry, index) => {
      const o = isRecord(entry) ? entry : {}
      return {
        index,
        id: typeof o.id === 'string' ? o.id : undefined,
        pattern: typeof o.pattern === 'string' ? o.pattern : undefined,
        input: isRecord(o.input) ? o.input : {},
        assets: isRecord(o.assets) ? o.assets : undefined,
      }
    })
    for (const step of this.steps) {
      if (step.id === undefined) continue
      this.knownHeads.add(step.id)
      if (!this.indexById.has(step.id)) this.indexById.set(step.id, step.index)
    }
  }

  run(): PlanProblem[] {
    this.ruleSchema()
    this.ruleStepIds()
    for (const step of this.steps) this.walkStep(step)
    this.walkOutput()
    this.ruleUnusedSteps()
    return this.problems
  }

  private add(problem: PlanProblem): void {
    this.problems.push(problem)
  }

  // Rule 1. Catches every shape mistake — a missing `output`, a step id with a
  // '/', a retry with maxAttempts: 12 — in the vocabulary the model already
  // reads. Missing it would mean the graph rules ran against garbage and
  // reported nonsense instead of the real error.
  private ruleSchema(): void {
    const parsed = PlanDagSchema.safeParse(this.dag)
    if (parsed.success) return
    for (const issue of parsed.error.issues) {
      this.add({
        code: 'PLAN_SCHEMA',
        path: [...issue.path] as (string | number)[],
        message: issue.message,
        details: { issue },
      })
    }
  }

  // Rules 2 and 3.
  //
  // 2 — a duplicate id: the engine would throw DUPLICATE_STEP_ID mid-run
  //     (meta-execution-context.ts:383-394), after the earlier steps had spent.
  //     Here it costs nothing. It also makes `$<id>` ambiguous, which is the
  //     deeper reason: a plan keys its JobStore rows by id.
  // 3 — a step called `input`: `$input` names the plan's own parameters, so
  //     the step would be unreachable and every `$input.x` would silently mean
  //     something else than the author wrote.
  private ruleStepIds(): void {
    const claimed = new Set<string>()
    for (const step of this.steps) {
      const id = step.id
      if (id === undefined) continue
      if (id === 'input') {
        this.add({
          code: 'PLAN_STEP_ID_RESERVED',
          path: ['steps', step.index, 'id'],
          stepId: id,
          message:
            '"input" is reserved: $input names the plan\'s own parameters. Rename this step.',
          details: { stepId: id },
        })
      }
      if (claimed.has(id)) {
        this.add({
          code: 'PLAN_STEP_ID_DUPLICATE',
          path: ['steps', step.index, 'id'],
          stepId: id,
          message: `Step id "${id}" is used more than once; ids must be unique within a plan.`,
          details: { stepId: id },
        })
      }
      claimed.add(id)
    }
  }

  private walkStep(step: StepView): void {
    const target = this.ruleTargetPattern(step)
    // The grammar rules run whatever the target is: they are about the shape of
    // the graph, and an unresolvable pattern must not hide a forward reference.
    this.walkInputStrings(step, target)
    this.ruleSerialisable(step)
    this.walkStepAssets(step, target)
    if (target === undefined) return
    // A step already refused outright (an agent, the plan itself, or the
    // nested one-shot) gets no further per-target checks: they would pile a
    // schema complaint on top of a refusal with a different remedy, and
    // parsing an input against the plan meta's own schema would re-enter this
    // walk.
    if (
      target.kind === 'agent' ||
      step.pattern === this.opts.selfId ||
      isOneShotPlan(target)
    )
      return
    this.ruleRequiredSlots(step, target)
    this.ruleStepInput(step, target)
  }

  // Rules 10 to 14 — is this step allowed to name this pattern at all?
  //
  // 10 — not registered: the runtime would fail the job with
  //      PATTERN_NOT_REGISTERED at the level this step sits on, after the
  //      levels above it had spent.
  // 11 — an agent: by kind, not by prefix, because `idCarriesKind` is not on
  //      @orchestral/core's barrel. An agent inside a plan is an unbounded LLM loop
  //      inside something sold as a fixed pipeline.
  // 12 — the plan itself: the runtime refuses it as CIRCULAR_META_STEP
  //      (meta-execution-context.ts:396-404), again after earlier steps ran.
  // 13 — not exposed to the surface that authored the plan: without it a model
  //      reaches host-only patterns by naming them, which is the whole point of
  //      the exposure gate on dispatch_pattern.
  // 14 — outside the allowlist the dispatching call was held to: this is how an
  //      agent's toolPatternIds reaches a plan's inner steps, which otherwise
  //      inherit no allowlist at all.
  private ruleTargetPattern(step: StepView): Pattern | undefined {
    if (step.pattern === undefined) return undefined
    const at: (string | number)[] = ['steps', step.index, 'pattern']
    const pattern = this.lookup.get(step.pattern as PatternId)
    if (pattern === undefined) {
      this.add({
        code: 'PLAN_PATTERN_NOT_FOUND',
        path: at,
        stepId: step.id,
        message: `Pattern "${step.pattern}" is not registered. Use find_pattern to discover a valid pattern_id.`,
        details: { stepId: step.id, pattern: step.pattern },
      })
      return undefined
    }
    if (pattern.kind === 'agent') {
      this.add({
        code: 'PLAN_PATTERN_KIND_AGENT',
        path: at,
        stepId: step.id,
        message: `"${step.pattern}" is an agent pattern; a plan may only step into atomic and meta patterns.`,
        details: { stepId: step.id, pattern: step.pattern },
      })
    }
    if (this.opts.selfId !== undefined && step.pattern === this.opts.selfId) {
      this.add({
        code: 'PLAN_PATTERN_SELF',
        path: at,
        stepId: step.id,
        message: `A plan cannot run itself as one of its own steps ("${step.pattern}").`,
        details: { stepId: step.id, pattern: step.pattern },
      })
    } else if (isOneShotPlan(pattern)) {
      // The self rule catches meta_plan inside meta_plan; this catches the
      // one-shot named from any OTHER plan. Without it the nesting dies at
      // dispatch, where the outer substitution has already rewritten the inner
      // DAG's $refs and the diagnosis reads as a schema mismatch rather than
      // "you nested a plan".
      this.add({
        code: 'PLAN_PATTERN_ONE_SHOT',
        path: at,
        stepId: step.id,
        message:
          `"${step.pattern}" is the one-shot plan interpreter; a plan cannot nest it — ` +
          `this plan's own $refs would be rewritten inside the inner DAG before it runs. ` +
          `Inline the inner steps into this plan, or persist the inner plan (planToMeta) ` +
          `and step into that pattern instead.`,
        details: { stepId: step.id, pattern: step.pattern },
      })
    }
    const audience = this.opts.audience
    if (audience !== undefined && !exposedTo(pattern, audience)) {
      this.add({
        code: 'PLAN_PATTERN_NOT_EXPOSED',
        path: at,
        stepId: step.id,
        message: `Pattern "${step.pattern}" is not visible to the '${audience}' surface.`,
        details: { stepId: step.id, pattern: step.pattern, audience },
      })
    }
    const allow = this.opts.allow
    if (allow !== undefined && !allow.includes(step.pattern as PatternId)) {
      this.add({
        code: 'PLAN_PATTERN_NOT_ALLOWED',
        path: at,
        stepId: step.id,
        message: `Pattern "${step.pattern}" is outside the set this call may dispatch.`,
        details: { stepId: step.id, pattern: step.pattern, allowlist: [...allow] },
      })
    }
    return pattern
  }

  /** Deep-walk `step.input`, applying rules 4 and 7 to 9 to every string. */
  private walkInputStrings(step: StepView, target: Pattern | undefined): void {
    // A step whose target is the ONE-SHOT interpreter does not get the grammar
    // rules: its whole `input` IS another DAG, whose `$refs` name the INNER
    // plan's steps, so walking them against THIS plan's ids reports refusals
    // that are simply false — `$take-0.assets[0]` inside a nested DAG is not
    // this plan's `PLAN_REF_INTO_ASSETS`, and `$input.prompt` there binds the
    // inner plan's parameters, not ours. The step itself is already refused
    // (PLAN_PATTERN_ONE_SHOT); piling false grammar refusals on top would bury
    // the one with the remedy.
    //
    // A PERSISTED plan (`.plan` rides on the pattern) is not skipped: its
    // input is ordinary parameters, and a `$ref` filling one belongs to THIS
    // plan's namespace like any other step's, typos included.
    //
    // The heads still count as reads, or rule 22 would call a step nothing
    // reads unused purely because its only reader is a nested plan.
    if (target !== undefined && isOneShotPlan(target)) {
      collectRefHeads(step.input, this.referenced)
      return
    }
    const visit = (
      value: unknown,
      path: (string | number)[],
      depth: number,
    ): void => {
      // A cycle or a pathological nesting depth is rule 24's problem, and it
      // reports one — stop here rather than blowing the stack on the way.
      if (depth > PLAN_REF_MAX_DEPTH) return
      if (typeof value === 'string') {
        this.ruleInputString(step, value, path)
        return
      }
      if (Array.isArray(value)) {
        value.forEach((entry, i) => {
          visit(entry, [...path, i], depth + 1)
        })
        return
      }
      if (isRecord(value)) {
        for (const [k, v] of Object.entries(value)) visit(v, [...path, k], depth + 1)
      }
    }
    visit(step.input, ['steps', step.index, 'input'], 0)
  }

  private ruleInputString(
    step: StepView,
    value: string,
    path: (string | number)[],
  ): void {
    if (this.checkWholeRef(value, path, step.id, step.index)) return
    // Rule 9 — a reference buried in a longer string. `"Animate: $describe.text"`
    // dispatches literally in every design that lacks this lint: there is no
    // interpolation, so the model pays for a step whose prompt contains the
    // word "$describe.text". The head must name a real step (or `input`), so
    // prose that merely mentions a dollar sign is untouched. Checked before
    // rule 4 because it is the more specific diagnosis of the same string.
    // DESIGN: plan-no-interpolation
    const fragment = findEmbeddedRef(value, this.knownHeads)
    if (fragment !== null) {
      this.add({
        code: 'PLAN_REF_IN_LITERAL',
        path,
        stepId: step.id,
        message:
          `"${fragment}" is inside a longer string, so it is sent literally — ` +
          'there is no interpolation. A reference must be the ENTIRE value; ' +
          'add a text-generation step to combine text.',
        details: { stepId: step.id, path: [...path], fragment },
      })
      return
    }
    // Rule 4 — meant to be a reference, spelled as no production at all. Note
    // what does NOT trigger it: "$5.99" has a digit after the `$`, so prices,
    // currency tables and shell-looking prose stay literal with no escape rule
    // to learn.
    if (REF_INTENT_RE.test(value)) {
      this.add({
        code: 'PLAN_REF_SYNTAX',
        path,
        stepId: step.id,
        message:
          `"${value}" starts like a reference but matches neither form. Use ` +
          '"$<stepId>.<field>" for a value or bind media through `assets`.',
        details: { stepId: step.id, path: [...path], value },
      })
    }
  }

  /**
   * Rules 5 to 8 over a string sitting where a VALUE belongs — a `step.input`
   * leaf or an `output.values` entry. Returns whether the string was a whole
   * reference at all, so an input leaf can fall through to rules 9 and 4.
   *
   * `maxIndex` is the index a target must sit below; `undefined` for references
   * in `output`, which may name any step.
   */
  private checkWholeRef(
    value: string,
    path: (string | number)[],
    stepId: string | undefined,
    maxIndex: number | undefined,
  ): boolean {
    const asValue = parseValueRef(value)
    // `$input.…` is a plan PARAMETER path and never produced media — including
    // when the parameter is itself called `assets`. Route it to rule 8 before
    // the assets test, which would otherwise accuse `$input.assets` of being a
    // reference to a step's output.
    if (asValue?.isInput) {
      this.ruleValueRef(stepId, asValue, value, path, maxIndex)
      return true
    }
    // Rule 7 — an asset reference where a value belongs. This is the single
    // most likely model mistake (`"references": {"startFrame":
    // "$render.assets[0]"}`, steered by the derived references copy) and it has
    // to be free: left through, the raw assetId string reaches the adapter as a
    // handle and either resolves to the wrong asset or fails after spend. Both
    // ref productions can spell it — `$r.assets[0]` is also a legal value path
    // — so both are caught here. In `output.values` the same string is just as
    // wrong for a different reason: `values` is declared as text, and the one
    // spelling that survives the output schema (`$r.assets[0].assetId`) hands
    // the model a raw asset id, which is exactly what the projection's
    // assets-only rewrite exists to prevent.
    const asAsset = parseAssetRef(value)
    if (asAsset !== null || (asValue !== null && asValue.segments[0] === 'assets')) {
      const head = asAsset?.head ?? asValue?.head
      if (head !== undefined) this.referenced.add(head)
      this.add({
        code: 'PLAN_REF_INTO_ASSETS',
        path,
        stepId,
        message:
          `"${value}" points at produced media, which is not a value. Bind media ` +
          'through a step\'s `assets` (by reference slot) or return it under ' +
          '`output.assets`, never as a value.',
        details: { stepId, ref: value },
      })
      return true
    }
    if (asValue !== null) {
      this.ruleValueRef(stepId, asValue, value, path, maxIndex)
      return true
    }
    return false
  }

  /**
   * Rules 5, 6 and 8 over one parsed value reference. `maxIndex` is the index a
   * target must sit below; `undefined` for references in `output`, which may
   * name any step.
   */
  private ruleValueRef(
    stepId: string | undefined,
    parsed: ParsedValueRef,
    ref: string,
    path: (string | number)[],
    maxIndex: number | undefined,
  ): void {
    // Rule 8 — `$input` in a plan that has no parameters (the one-shot has
    // none), or a field its schema does not declare. Both would resolve to
    // undefined at substitution time and fail the step after its level's
    // upstream steps had already run.
    if (parsed.isInput) {
      const inputs = this.opts.inputs
      if (inputs === undefined) {
        this.add({
          code: 'PLAN_REF_INPUT_NOT_ALLOWED',
          path,
          stepId,
          message: `"${ref}" reads a plan parameter, but this plan takes none — write the value literally.`,
          details: { ref, available: [] },
        })
        return
      }
      const first = parsed.segments[0]
      const available = Object.keys(inputs.shape)
      if (typeof first !== 'string' || !available.includes(first)) {
        this.add({
          code: 'PLAN_PARAM_UNKNOWN',
          path,
          stepId,
          message: `"${ref}" names no parameter of this plan. Available: ${available.join(', ') || '(none)'}.`,
          details: { ref, available },
        })
      }
      return
    }
    this.referenced.add(parsed.head)
    // Rule 5 — the target must exist and must sit EARLIER in the list. The
    // array order is the topological order, so a backward-only rule makes
    // cycles unrepresentable: this is the cycle check, and it costs one map
    // lookup instead of a graph traversal.
    const targetIndex = this.indexById.get(parsed.head)
    if (targetIndex === undefined) {
      this.add({
        code: 'PLAN_REF_UNKNOWN_STEP',
        path,
        stepId,
        message: `"${ref}" names step "${parsed.head}", which this plan does not declare.`,
        details: { stepId, ref, target: parsed.head },
      })
      return
    }
    if (maxIndex !== undefined && targetIndex >= maxIndex) {
      this.add({
        code: 'PLAN_REF_FORWARD',
        path,
        stepId,
        message:
          `"${ref}" points at step "${parsed.head}", which is listed at or after this one. ` +
          'A step may only reference steps listed before it.',
        details: { stepId, ref, target: parsed.head },
      })
      return
    }
    this.ruleValuePath(stepId, parsed, ref, path, targetIndex)
  }

  // Rule 6 — does the path exist on what the producing step actually returns?
  // Walked against the producer's `outputs` zod shape with the same
  // introspection find_pattern does on `outputs.shape` (find-pattern.ts:553-579):
  // ZodObject / ZodArray / ZodOptional / ZodNullable are followed, anything else
  // accepts rather than guessing. `available` lists the producer's top-level
  // output keys because find_pattern never renders outputs — without them the
  // model has no way to learn that text-generation's field is `text`, and
  // "$describe.output" costs a whole step to discover at runtime.
  private ruleValuePath(
    stepId: string | undefined,
    parsed: ParsedValueRef,
    ref: string,
    path: (string | number)[],
    targetIndex: number,
  ): void {
    const producerId = this.steps[targetIndex]?.pattern
    if (producerId === undefined) return
    const producer = this.lookup.get(producerId as PatternId)
    if (producer === undefined) return // rule 10 already named it
    const outputs = producer.outputs
    if (pathExistsInOutputs(outputs, parsed.segments)) return
    const available = topLevelKeys(outputs)
    this.add({
      code: 'PLAN_REF_PATH_UNKNOWN',
      path,
      stepId,
      message:
        `"${ref}" is not a field of what step "${parsed.head}" (${producerId}) returns. ` +
        `Available top-level fields: ${available.join(', ') || '(unknown)'}.`,
      details: { stepId, ref, target: parsed.head, available },
    })
  }

  /** Rules 5 and 15 to 19 over `step.assets`. */
  private walkStepAssets(step: StepView, target: Pattern | undefined): void {
    const bound = step.assets
    if (bound === undefined) return
    const references = isRecord(step.input.references)
      ? step.input.references
      : undefined
    const needs = target === undefined ? undefined : (target.assetNeeds ?? [])
    for (const [slot, value] of Object.entries(bound)) {
      const slotPath: (string | number)[] = ['steps', step.index, 'assets', slot]
      const isList = Array.isArray(value)
      const sites: RefSite[] = isList
        ? value.flatMap((entry, i) =>
            typeof entry === 'string'
              ? [{ ref: entry, path: [...slotPath, i], stepId: step.id }]
              : [],
          )
        : typeof value === 'string'
          ? [{ ref: value, path: slotPath, stepId: step.id }]
          : []
      // How many refs the author WROTE, not how many parsed: a malformed entry
      // is rule 1's to report, and undercounting here would make the two
      // problems read as contradicting each other.
      const count = isList ? value.length : 1

      const need =
        needs === undefined ? undefined : needs.find((n) => n.slot === slot)
      // Rule 16 — the slot has to be one the target declares. An undeclared key
      // is dropped by the resolver, so the step runs without the media the
      // author wired to it and the mistake surfaces as a bad result, not an
      // error.
      if (needs !== undefined && need === undefined) {
        this.add({
          code: 'PLAN_SLOT_UNKNOWN',
          path: slotPath,
          stepId: step.id,
          message: `"${slot}" is not a reference slot of ${step.pattern}. Declared: ${needs.map((n) => n.slot).join(', ') || '(none)'}.`,
          details: {
            stepId: step.id,
            slot,
            declared: needs.map((n) => n.slot),
          },
        })
      }
      // Rule 19 — the same slot filled from both channels. Stricter than the
      // runtime's single-slot-only guard on purpose: on an array slot the
      // handle-first merge order is a best-of-n implementation detail, not a
      // contract a model can see, so "which image is first" would be decided by
      // something the author cannot read.
      if (references !== undefined && Object.hasOwn(references, slot)) {
        this.add({
          code: 'PLAN_SLOT_DUAL_SOURCE',
          path: slotPath,
          stepId: step.id,
          message: `Slot "${slot}" is bound both in \`assets\` and in \`input.references\`; pick one channel.`,
          details: { stepId: step.id, slot },
        })
      }
      // Rule 18 — a list on a single slot, or more refs than the slot accepts.
      // The runtime would take the first and silently drop the rest, so the
      // plan would read as a fan-in that never happened.
      if (need !== undefined) {
        if (need.cardinality === 'single' && isList) {
          this.add({
            code: 'PLAN_SLOT_CARDINALITY',
            path: slotPath,
            stepId: step.id,
            message: `Slot "${slot}" takes a single reference, not a list.`,
            details: { stepId: step.id, slot, cardinality: 'single', count },
          })
        } else if (
          need.cardinality === 'array' &&
          need.max !== undefined &&
          count > need.max
        ) {
          this.add({
            code: 'PLAN_SLOT_CARDINALITY',
            path: slotPath,
            stepId: step.id,
            message: `Slot "${slot}" accepts at most ${need.max} references; this binds ${count}.`,
            details: {
              stepId: step.id,
              slot,
              cardinality: 'array',
              count,
              max: need.max,
            },
          })
        }
      }
      for (const site of sites) this.checkAssetRef(site, step.index, need)
    }
  }

  /**
   * Rules 5, 15 and 17 over one asset reference — used for `step.assets`
   * entries (with a slot in hand) and for `output.assets[].from` (without).
   */
  private checkAssetRef(
    site: RefSite,
    maxIndex: number | undefined,
    need: AssetNeed | undefined,
  ): void {
    const parsed = parseAssetRef(site.ref)
    if (parsed === null) return // rule 1 reported the syntax
    // The caller's own media, not a step's product: no producer to find, no
    // position to be after. Checked against the plan's OWN slots instead, and
    // returned before `referenced` is touched — `input` is not a step, and rule
    // 22 would read it as one.
    if (parsed.slot !== undefined) {
      this.checkInputAssetRef(site, parsed.slot, need)
      return
    }
    this.referenced.add(parsed.head)
    const targetIndex = this.indexById.get(parsed.head)
    if (targetIndex === undefined) {
      this.add({
        code: 'PLAN_REF_UNKNOWN_STEP',
        path: site.path,
        stepId: site.stepId,
        message: `"${site.ref}" names step "${parsed.head}", which this plan does not declare.`,
        details: { stepId: site.stepId, ref: site.ref, target: parsed.head },
      })
      return
    }
    if (maxIndex !== undefined && targetIndex >= maxIndex) {
      this.add({
        code: 'PLAN_REF_FORWARD',
        path: site.path,
        stepId: site.stepId,
        message:
          `"${site.ref}" points at step "${parsed.head}", which is listed at or after this one. ` +
          'A step may only reference steps listed before it.',
        details: { stepId: site.stepId, ref: site.ref, target: parsed.head },
      })
      return
    }
    const producerId = this.steps[targetIndex]?.pattern
    if (producerId === undefined) return
    const producer = this.lookup.get(producerId as PatternId)
    if (producer === undefined) return
    const probe = probeProducedAssets(producer.outputs)
    // Rule 15a — the producing step returns no media at all. Left through, the
    // interpreter would throw at substitution after every upstream step had
    // already been paid for.
    if (probe.kind === 'none') {
      this.add({
        code: 'PLAN_ASSET_PRODUCER_NONE',
        path: site.path,
        stepId: site.stepId,
        message: `Step "${parsed.head}" (${producerId}) produces no assets, so "${site.ref}" cannot resolve.`,
        details: { stepId: site.stepId, ref: site.ref, target: parsed.head },
      })
      return
    }
    // Rule 15b — `[label=…]` against a producer whose elements carry no label.
    // Only a meta's output is labelled (an atomic's producedAssetShape has no
    // `label` field), so this is the "I read the meta_* example and applied it
    // to an atomic" mistake, caught before the find-first returns nothing.
    if (
      parsed.label !== undefined &&
      probe.kind === 'element' &&
      probe.shape !== undefined &&
      !Object.hasOwn(probe.shape, 'label')
    ) {
      this.add({
        code: 'PLAN_ASSET_LABEL_UNSUPPORTED',
        path: site.path,
        stepId: site.stepId,
        message:
          `Step "${parsed.head}" (${producerId}) does not label its assets; ` +
          'use a positional reference like "$' +
          `${parsed.head}.assets[0]" instead.`,
        details: { stepId: site.stepId, ref: site.ref, target: parsed.head },
      })
    }
    // Rule 17 — the producer's modality literal against the slot's declared
    // modality. Feeding a clip to a slot that wants a still is a provider-side
    // failure at best and a wasted call at worst; both sides are declared, so
    // it is knowable now.
    if (need !== undefined) {
      const got = probe.kind === 'element' ? literalModality(probe.shape) : undefined
      if (got !== undefined && got !== need.modality) {
        this.add({
          code: 'PLAN_SLOT_MODALITY',
          path: site.path,
          stepId: site.stepId,
          message: `Slot "${need.slot}" needs ${need.modality}; step "${parsed.head}" produces ${got}.`,
          details: {
            stepId: site.stepId,
            slot: need.slot,
            expected: need.modality,
            got,
          },
        })
      }
    }
  }

  /**
   * Rules 25 to 27 over `$input.assets[slot=…]` — the caller's media, bound
   * into a step's slot.
   *
   * `need` is the child slot being wired into, and in practice it is always
   * given: `output.assets[].from` is typed `ProducedAssetRef` (plan.ts), which
   * admits the producer form alone, so a slot ref cannot legally reach this
   * function without a `need`. The `need === undefined` arm below is what the
   * walk does when it sees one anyway — the walk reads raw data and promises
   * never to throw, so a host handing in a DAG that never met the schema still
   * gets an answer.
   *
   * 25 — the plan declares no asset slots at all, so there is nothing for the
   *      ref to name. The twin of rule 8's PLAN_REF_INPUT_NOT_ALLOWED, which
   *      says the same thing about `$input.<field>` on a plan with no
   *      parameters.
   * 26 — a slot name the plan does not declare. The twin of PLAN_PARAM_UNKNOWN,
   *      and it lists what IS declared for the same reason: the author cannot
   *      otherwise see the vocabulary from the refusal.
   * 27 — the caller slot against the CHILD slot it is being wired into. Three
   *      ways they can disagree, and all three are knowable now because both
   *      sides are declared. The third is the interesting one: an optional
   *      caller slot feeding a required child slot type-checks and then fails
   *      open at run time, because an unfilled optional slot resolves to
   *      nothing and the resolver's "most recent of this modality" default
   *      hands the step an unrelated asset from the ledger. That is rule 20's
   *      failure mode reached one step further out, so it reports rule 20's
   *      code.
   */
  private checkInputAssetRef(
    site: RefSite,
    slot: string,
    need: AssetNeed | undefined,
  ): void {
    const declared = this.opts.assetNeeds
    if (declared === undefined || declared.length === 0) {
      this.add({
        code: 'PLAN_INPUT_ASSET_NOT_ALLOWED',
        path: site.path,
        stepId: site.stepId,
        message:
          `"${site.ref}" takes media from the plan's caller, but this plan declares ` +
          'no asset slots — bind the slot from an earlier step instead, or declare ' +
          'the slot on the plan.',
        details: { stepId: site.stepId, ref: site.ref, available: [] },
      })
      return
    }
    const planNeed = declared.find((n) => n.slot === slot)
    if (planNeed === undefined) {
      this.add({
        code: 'PLAN_INPUT_SLOT_UNKNOWN',
        path: site.path,
        stepId: site.stepId,
        message: `"${site.ref}" names no asset slot of this plan. Declared: ${declared.map((n) => n.slot).join(', ') || '(none)'}.`,
        details: {
          stepId: site.stepId,
          ref: site.ref,
          slot,
          available: declared.map((n) => n.slot),
        },
      })
      return
    }
    // No child slot, which for a schema-valid plan cannot happen: the only
    // site that calls in without one is `output.assets[].from`, and its type
    // (`ProducedAssetRef`) admits the producer form alone — a plan returning
    // the caller's own media is refused by the schema, not here. So this is
    // reachable only alongside a `PLAN_SCHEMA` problem for the same string,
    // and rule 1 owns that. Return rather than add a second, vaguer problem:
    // one code per remedy, and the remedy is already stated.
    if (need === undefined) return
    if (planNeed.modality !== need.modality) {
      this.add({
        code: 'PLAN_SLOT_MODALITY',
        path: site.path,
        stepId: site.stepId,
        message: `Slot "${need.slot}" needs ${need.modality}; this plan's "${slot}" slot supplies ${planNeed.modality}.`,
        details: {
          stepId: site.stepId,
          slot: need.slot,
          fromPlanSlot: slot,
          expected: need.modality,
          got: planNeed.modality,
        },
      })
    }
    if (planNeed.cardinality === 'array' && need.cardinality === 'single') {
      this.add({
        code: 'PLAN_SLOT_CARDINALITY',
        path: site.path,
        stepId: site.stepId,
        message:
          `Slot "${need.slot}" takes a single reference, but this plan's "${slot}" slot ` +
          'accepts a list — it can resolve to more than one asset.',
        details: {
          stepId: site.stepId,
          slot: need.slot,
          fromPlanSlot: slot,
          cardinality: 'single',
        },
      })
    }
    if (!planNeed.required && need.required) {
      this.add({
        code: 'PLAN_SLOT_REQUIRED_UNBOUND',
        path: site.path,
        stepId: site.stepId,
        message:
          `${site.stepId === undefined ? 'This step' : `Step "${site.stepId}"`} requires the ` +
          `"${need.slot}" slot, but it is bound from this plan's OPTIONAL "${slot}" slot: ` +
          'a caller that omits it leaves the step unbound. Declare "' +
          `${slot}" as required, or bind "${need.slot}" from an earlier step.`,
        details: { stepId: site.stepId, slot: need.slot, fromPlanSlot: slot },
      })
    }
  }

  // Rule 20 — a required slot bound through neither channel. Left unbound, the
  // resolver's "most recent of this modality" default feeds the step an image
  // from the SESSION ledger rather than the upstream step's — silently, and
  // after the money is spent. This is the rule with the worst failure mode in
  // the set, which is why it looks at `input.references` too rather than only
  // at the channel a plan prefers.
  private ruleRequiredSlots(step: StepView, target: Pattern): void {
    const references = isRecord(step.input.references)
      ? step.input.references
      : undefined
    for (const need of target.assetNeeds ?? []) {
      if (!need.required) continue
      const inAssets =
        step.assets !== undefined && Object.hasOwn(step.assets, need.slot)
      const inReferences =
        references !== undefined && Object.hasOwn(references, need.slot)
      if (inAssets || inReferences) continue
      this.add({
        code: 'PLAN_SLOT_REQUIRED_UNBOUND',
        path: ['steps', step.index, 'assets'],
        stepId: step.id,
        message:
          `${step.pattern} requires the "${need.slot}" slot (${need.modality}). ` +
          `Bind it: "assets": { "${need.slot}": "$<stepId>.assets[0]" }.`,
        details: { stepId: step.id, slot: need.slot },
      })
    }
  }

  // Rule 21 — the step's input against the target's own schema, parsed exactly
  // as `resolveDispatchTarget` does it (meta → tool.inputs, atomic →
  // primary.tool.inputs, top-level `.passthrough()`), so `size` / `seed` /
  // `providerOptions` / the derived `references` survive instead of reading as
  // unrecognized keys. Issues landing on a ref-valued field are suppressed:
  // that field's type only exists after substitution, and a `"$describe.text"`
  // in a numeric slot is not a type error the model can act on here. What it
  // does catch is a mistyped literal — `"temperature": "0.7"` — before the step
  // it belongs to has any upstream spend.
  private ruleStepInput(step: StepView, target: Pattern): void {
    const schema =
      target.kind === 'meta' ? target.tool.inputs : target.primary?.tool.inputs
    if (schema === undefined) return
    const result = passthroughOf(schema).safeParse(step.input)
    if (result.success) return
    const issues = result.error.issues.filter(
      (issue) => !pathLandsOnRef(step.input, issue.path),
    )
    if (issues.length === 0) return
    this.add({
      code: 'PLAN_STEP_INPUT_INVALID',
      path: ['steps', step.index, 'input'],
      stepId: step.id,
      message:
        `Input does not match ${step.pattern}'s schema: ` +
        issues
          .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
          .join('; '),
      details: { stepId: step.id, pattern: step.pattern, issues },
    })
  }

  // Rule 24 — the input has to survive `canonicalise` (idempotency.ts:77-127),
  // which is what turns a dispatch into a durable key. A Date or a Map in there
  // makes the engine throw IDEMPOTENCY_NOT_SERIALISABLE at dispatch; a plan
  // that arrived as JSON cannot contain one, so this only ever fires on a
  // host-constructed DAG — which is exactly the caller that would otherwise
  // learn about it from a stack trace mid-run.
  private ruleSerialisable(step: StepView): void {
    const bad: (string | number)[][] = []
    collectNonSerialisable(step.input, ['steps', step.index, 'input'], bad)
    for (const path of bad) {
      this.add({
        code: 'PLAN_INPUT_NOT_SERIALISABLE',
        path,
        stepId: step.id,
        message:
          `The value at ${formatPath(path)} cannot be canonicalised into an idempotency key. ` +
          'Use plain JSON values only (no Date / Map / Set / bigint / function / undefined).',
        details: { stepId: step.id, path },
      })
    }
  }

  /** Rules 5, 6, 8, 15, 17 and 23 over the `output` block. */
  private walkOutput(): void {
    const output = asRecord(asRecord(this.dag).output)

    const assets: unknown[] = Array.isArray(output.assets) ? output.assets : []
    const labels = new Set<string>()
    assets.forEach((entry, i) => {
      const o = isRecord(entry) ? entry : {}
      if (typeof o.from === 'string') {
        this.checkAssetRef(
          { ref: o.from, path: ['output', 'assets', i, 'from'] },
          undefined,
          undefined,
        )
      }
      // Rule 23 — two returned assets under one label. The label is how a
      // caller picks an asset out after the projection replaces its id with a
      // handle, so a duplicate makes one of the two unreachable.
      if (typeof o.label === 'string') {
        if (labels.has(o.label)) {
          this.add({
            code: 'PLAN_OUTPUT_LABEL_DUPLICATE',
            path: ['output', 'assets', i, 'label'],
            message: `Output label "${o.label}" is used more than once; labels must be unique.`,
            details: { label: o.label },
          })
        }
        labels.add(o.label)
      }
    })

    const values = isRecord(output.values) ? output.values : {}
    for (const [name, ref] of Object.entries(values)) {
      if (typeof ref !== 'string') continue
      // A non-ref here is rule 1's to report — the schema types `values` as
      // ValueRef, so anything else never reaches this walk.
      this.checkWholeRef(ref, ['output', 'values', name], undefined, undefined)
    }
  }

  // Rule 22 — a step nothing downstream and no `output` entry reads. Money for
  // nothing is what this whole layer exists to prevent, and an orphan step is
  // almost always a rename that only got applied on one side.
  private ruleUnusedSteps(): void {
    for (const step of this.steps) {
      if (step.id === undefined) continue
      if (this.referenced.has(step.id)) continue
      this.add({
        code: 'PLAN_STEP_UNUSED',
        path: ['steps', step.index],
        stepId: step.id,
        message: `Step "${step.id}" is read by no later step and returned by no \`output\` entry — it would be paid for and discarded.`,
        details: { stepId: step.id },
      })
    }
  }
}

// ── Reference parsing ───────────────────────────────────────────────────
//
// `parseValueRef` / `parseAssetRef` / `collectRefHeads` are refs.ts's — the one
// walk this package has. What stays here are the two needles no other walk
// wants: rule 9's embedded-reference scan and rule 4's "looks like it was meant
// to be a reference".

/** The first `$<known>.…` run inside `value`, or null. Rule 9's needle. */
function findEmbeddedRef(
  value: string,
  known: ReadonlySet<string>,
): string | null {
  for (const m of value.matchAll(EMBEDDED_REF_RE)) {
    // "$<knownStepId>." / "$input." — a head followed by `[0]` is not the
    // interpolation mistake, it is a fragment of prose that happens to index.
    if (!m[2].startsWith('.')) continue
    if (known.has(m[1])) return m[0]
  }
  return null
}

function isWholeRef(value: string): boolean {
  return PLAN_VALUE_REF_RE.test(value) || PLAN_ASSET_REF_RE.test(value)
}

/** Does `path` land on (or pass through) a string that is a whole reference? */
function pathLandsOnRef(
  input: Record<string, unknown>,
  path: readonly PropertyKey[],
): boolean {
  let node: unknown = input
  for (const segment of path) {
    if (typeof node === 'string') return isWholeRef(node)
    if (node === null || typeof node !== 'object') return false
    node = (node as Record<PropertyKey, unknown>)[segment]
  }
  return typeof node === 'string' && isWholeRef(node)
}

// ── zod-shape introspection ─────────────────────────────────────────────
//
// Deliberately the same technique find_pattern uses on `outputs.shape`
// (find-pattern.ts:553-579): read `_def.type` for the zod v4 type tag and walk
// the four containers a Pattern output realistically nests. Anything else is
// accepted rather than guessed — a false PLAN_REF_PATH_UNKNOWN on a
// hand-rolled outputs schema would block a legal plan, which is worse than
// missing a typo that layer 2 catches at the step.

function typeTag(node: unknown): string | undefined {
  return (node as { _def?: { type?: string } } | undefined)?._def?.type
}

/** Strip ZodOptional / ZodNullable wrappers. */
function unwrap(node: unknown): unknown {
  let current = node
  for (let i = 0; i < 8; i++) {
    const tag = typeTag(current)
    if (tag !== 'optional' && tag !== 'nullable') return current
    current = (current as { _def: { innerType?: unknown } })._def.innerType
  }
  return current
}

function shapeOf(node: unknown): Record<string, unknown> | undefined {
  if (typeTag(node) !== 'object') return undefined
  const shape = (node as { shape?: Record<string, unknown> }).shape
  return typeof shape === 'object' && shape !== null ? shape : undefined
}

function elementOf(node: unknown): unknown | undefined {
  if (typeTag(node) !== 'array') return undefined
  return (node as { _def: { element?: unknown } })._def.element
}

function topLevelKeys(outputs: unknown): string[] {
  const shape = shapeOf(unwrap(outputs))
  return shape === undefined ? [] : Object.keys(shape)
}

function pathExistsInOutputs(
  outputs: unknown,
  segments: readonly (string | number)[],
): boolean {
  let node: unknown = outputs
  for (const segment of segments) {
    node = unwrap(node)
    if (typeof segment === 'number') {
      const element = elementOf(node)
      if (element === undefined) return true // not an array we can read — accept
      node = element
      continue
    }
    const shape = shapeOf(node)
    if (shape === undefined) return true // not an object we can read — accept
    if (!Object.hasOwn(shape, segment)) return false
    node = shape[segment]
  }
  return true
}

type ProducedAssetsProbe =
  /** The outputs schema declares no `assets` field. */
  | { kind: 'none' }
  /** It declares one, but its element is not something we can read. */
  | { kind: 'opaque' }
  | { kind: 'element'; shape: Record<string, unknown> | undefined }

function probeProducedAssets(outputs: unknown): ProducedAssetsProbe {
  const shape = shapeOf(unwrap(outputs))
  if (shape === undefined) return { kind: 'opaque' } // cannot read → do not accuse
  if (!Object.hasOwn(shape, 'assets')) return { kind: 'none' }
  const element = elementOf(unwrap(shape.assets))
  if (element === undefined) return { kind: 'opaque' }
  return { kind: 'element', shape: shapeOf(unwrap(element)) }
}

/**
 * The `modality` literal on a produced-asset element, when it is one. zod v4's
 * ZodLiteral keeps its accepted values in `_def.values` (length 1 for
 * `z.literal('image')`) — the same read `summariseOutputs` does.
 */
function literalModality(
  elementShape: Record<string, unknown> | undefined,
): string | undefined {
  if (elementShape === undefined) return undefined
  const field = unwrap(elementShape.modality)
  const def = (field as { _def?: { type?: string; values?: unknown[] } })?._def
  if (def?.type !== 'literal' || !Array.isArray(def.values)) return undefined
  const value = def.values[0]
  return typeof value === 'string' ? value : undefined
}

// ── Small helpers ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `isRecord`, as a coercion — every defensive read starts from one of these. */
function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function exposedTo(pattern: Pattern, audience: DispatchAudience): boolean {
  const resolved = resolveExposure(pattern.exposure)
  return audience === 'agent-loop'
    ? resolved.agentLoop
    : audience === 'slash'
      ? resolved.slash
      : audience === 'canvas'
        ? resolved.canvas
        : resolved.chatTurn
}

/**
 * Top-level `.passthrough()` when the schema supports it — byte-for-byte what
 * `resolveDispatchTarget` does (its `parseSchema` branch), so rule 21's
 * verdict and the dispatch path's verdict cannot disagree.
 */
/**
 * The one-shot interpreter, recognised structurally: interpreted-from-steps by
 * `origin`, but carrying no step list of its own — its input IS a DAG. A
 * `planToMeta` product carries its frozen list as `.plan` (a field
 * @orchestral/core does not declare on `Pattern`; `PlanMetaPattern` in
 * interpreter.ts does, hence the cast) and is an ordinary steppable meta.
 */
function isOneShotPlan(pattern: Pattern): boolean {
  return (
    pattern.origin === 'plan' &&
    (pattern as { plan?: unknown }).plan === undefined
  )
}

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

/**
 * Mirror of `canonicalise`'s refusals (idempotency.ts:77-127), collecting every
 * offending path instead of throwing on the first. Re-implemented rather than
 * imported because `canonicalise` is private to @orchestral/runtime, which this
 * package does not depend on; keep the two in step.
 */
function collectNonSerialisable(
  value: unknown,
  path: (string | number)[],
  bad: (string | number)[][],
  depth = 0,
): void {
  // `canonicalise` recurses unguarded, so a cycle or a pathological nesting
  // depth in a host-constructed input blows the stack there. Reporting it is
  // this rule's whole job — and `validatePlan` promises never to throw — so the
  // cap is here rather than a RangeError anywhere.
  //
  // Same cap every reference walk uses (refs.ts). Sharing it is what makes
  // "a plan that validates has every $ref inside every walk's reach" a
  // property instead of an argument: this rule refuses anything deeper.
  if (depth > PLAN_REF_MAX_DEPTH) {
    bad.push(path)
    return
  }
  if (value === null) return
  const t = typeof value
  if (t === 'string' || t === 'boolean') return
  if (t === 'number') {
    if (!Number.isFinite(value as number)) bad.push(path)
    return
  }
  if (t === 'undefined' || t === 'bigint' || t === 'symbol' || t === 'function') {
    bad.push(path)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, i) => {
      // Arrays keep their indices, so an `undefined` slot is ambiguous rather
      // than droppable — JSON.stringify would silently substitute null.
      if (entry === undefined) bad.push([...path, i])
      else collectNonSerialisable(entry, [...path, i], bad, depth + 1)
    })
    return
  }
  const proto = Object.getPrototypeOf(value as object)
  if (proto !== Object.prototype && proto !== null) {
    bad.push(path)
    return
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // A plain `undefined` OBJECT property is dropped, matching JSON.
    if (v === undefined) continue
    collectNonSerialisable(v, [...path, k], bad, depth + 1)
  }
}
