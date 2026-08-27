// Preflight — what a plan would cost, routed but not run.
//
// `preflightPlan` answers the one question a host has to ask before it lets a
// model-authored pipeline spend money: is this plan valid, and for every step
// it names, which model would serve it — or why would nothing. It is pure and
// synchronous, calls no model, mutates nothing, and never prints. The host
// turns it into a gate with its own AskUserHandler, outside any job:
//
//   const report = preflightPlan(dag, { registry, router, resolveCtx, sessionId })
//   if (report.problems.length) return showProblems(report.problems)
//   if (await askUser.confirm({ body: formatPlanPreflight(report) })) submitJob(…)
//
// Why it lives in the runtime and not beside `validatePlan` in core, which is
// where the rest of the plan contract is: it needs two things core cannot
// reach.
//
//   • The `ResolveContext` routing actually runs with comes from the HOST, as
//     `InlineRuntimeInit.resolveCtxProvider: (spec: JobSpec) => ResolveContext`
//     (inline.ts) — a runtime-owned seam. A preflight that made up its own
//     empty ctx would silently drop the host's pins, rankings and exclusions
//     and report a different model than the run would pick.
//   • `applicableAlternatives` (alternatives.ts) is runtime-internal — not on
//     this package's barrel, let alone core's. Reporting "nothing serves this,
//     but a declared path would have" means evaluating `appliesWhen` with the
//     same machinery the dispatch path evaluates it with, or the report
//     advertises a path that would never fire.
//
// Both directions of the dependency are one-way: `@orchestral/runtime` depends
// on `@orchestral/core`, never the reverse.
// DESIGN: preflight-prices-nothing

import type {
  Alternative,
  AtomicPattern,
  Capability,
  CapabilityRouter,
  DispatchAudience,
  JobSpec,
  MetaPattern,
  ModelTag,
  Pattern,
  PatternId,
  PatternRegistry,
  PlanDag,
  PlanProblem,
  ResolveContext,
  RoutingExplanation,
  Semantics,
  UnavailabilityReason,
} from '@orchestral/core'
import {
  PLAN_ASSET_REF_RE,
  PLAN_VALUE_REF_RE,
  validatePlan,
} from '@orchestral/core'
import type { z } from 'zod'

import {
  applicableAlternatives,
  toAvailableAlternative,
  type AvailableAlternative,
} from './alternatives'
import type { ResolveCtxProvider } from './inline'

// ── The report ──────────────────────────────────────────────────────────

/**
 * One declared alternative a preflighted step would fall back to, plus whether
 * the runtime it was preflighted for would actually take it.
 *
 * `wouldFire` is `deps.alternatives === 'auto'` and nothing else: selection is
 * the same either way, but `InlineRuntimeInit.alternatives` defaults to `'off'`
 * (DESIGN.md), under which the dispatch fails with ALTERNATIVES_NOT_ENABLED
 * naming this path rather than taking it. A report that said "will fall back"
 * to a host running the default would be wrong about the one thing it is for.
 * DESIGN: preflight-alternative-would-fire
 */
export type PreflightAlternative = AvailableAlternative & {
  wouldFire: boolean
}

/**
 * What routing would do with one step, in the three shapes it actually has.
 *
 * `selected` / `unsatisfiable` are atomic outcomes. `opaque` is every meta: a
 * meta's `compose` is code, not a capability, so there is no routing decision
 * to report — only what it has declared about itself.
 */
export type PlanStepRouting =
  | {
      kind: 'selected'
      /** `provider:modelId`. */
      model: string
      /**
       * Which rule picked it. A `RoutingSelectionRule` (`pinned` /
       * `preferred-provider` / `tier` / `first-candidate`) when the router has
       * `explain`; the literal `'checkSatisfiable'` when it does not — see
       * {@link preflightPlan}'s degraded path, where the model shown is the
       * first candidate the satisfiability check returned rather than the one
       * `resolve`'s precedence would land on. Typed `string` for exactly that
       * reason: the degraded path has no selection rule to report.
       */
      by: string
      explanation?: RoutingExplanation
    }
  | {
      kind: 'unsatisfiable'
      reason: UnavailabilityReason
      explanation?: RoutingExplanation
      /** The FIRST applicable declared alternative, if any. */
      alternative?: PreflightAlternative
    }
  | {
      kind: 'opaque'
      /** `MetaPattern.plannedDispatches(input)`, when declared and it returned. */
      plannedDispatches?: readonly PatternId[]
      /** One level of expansion for a meta that is itself a plan. */
      nested?: PlanPreflightReport
    }

/** One step of the plan, as routed. */
export interface PlanPreflightStep {
  id: string
  pattern: PatternId
  kind: 'atomic' | 'meta'
  /** 0-based stage index; `levels[level]` contains this id. */
  level: number
  routing: PlanStepRouting
}

/** Everything preflight knows about a plan. Data — nothing here prints. */
export interface PlanPreflightReport {
  /**
   * No problems AND no unsatisfiable atomic step without an applicable
   * alternative.
   *
   * Scoped to THIS report's own steps, deliberately: a nested plan carries its
   * own `ok`, and folding it in would make a plan's verdict depend on how far
   * the expansion happened to reach — a nested plan meta would gate the parent
   * while a hand-written meta doing exactly the same work would not, since a
   * meta is opaque and preflight never claims one will succeed. A host that
   * cares reads `steps[].routing.nested?.ok` too; `formatPlanPreflight` renders
   * it either way.
   */
  ok: boolean
  /** From `validatePlan`. Non-empty ⇒ `steps` is empty; nothing was routed. */
  problems: readonly PlanProblem[]
  steps: readonly PlanPreflightStep[]
  /** Step ids by stage, in execution order. `levels.length` is the stage count. */
  levels: readonly string[][]
  /** Ids of the steps whose routing is `unsatisfiable`. */
  unsatisfiable: readonly string[]
}

/**
 * What preflight needs to answer the question. Everything but `registry` and
 * `router` is optional, and each absent field switches its own contribution
 * off rather than changing the shape of the answer.
 */
export interface PlanPreflightDeps {
  registry: PatternRegistry
  router: CapabilityRouter
  /**
   * The SAME provider handed to `InlineRuntimeInit.resolveCtxProvider`. Omit
   * it and every step routes under `{}` — which silently drops the host's
   * pins, rankings and exclusions, so the report may name a model the run
   * would not pick.
   */
  resolveCtx?: ResolveCtxProvider
  /** Rides on the synthesized spec, since a host provider may key on it. */
  sessionId?: string
  /** Forwarded to `validatePlan` verbatim. */
  audience?: DispatchAudience
  allow?: readonly PatternId[]
  selfId?: PatternId
  inputs?: z.ZodObject
  /**
   * What the runtime this plan will be submitted to was built with. Decides
   * `wouldFire`, and nothing else. Defaults to `'off'`, as the runtime does.
   */
  alternatives?: 'off' | 'auto'
}

// ── Entry point ─────────────────────────────────────────────────────────

/**
 * Route every step of `dag` without running any of it.
 *
 * Pure, synchronous, calls no model, mutates nothing, never prints. The only
 * things it calls out to are `validatePlan` (pure by contract), the host's
 * `resolveCtx` provider, and the router's `explain` / `checkSatisfiable`, both
 * of which run the same screen `resolve` runs and are documented as
 * side-effect-free.
 *
 * Validation first: any problem at all and the report is
 * `{ ok: false, problems, steps: [], levels: [], unsatisfiable: [] }`. There is
 * nothing honest to route in a plan whose refs are forward or whose patterns
 * are not registered, and half a report invites a host to render half a plan.
 *
 * Per atomic step it synthesises `spec = { patternId, input: step.input,
 * sessionId }` — refs UNSUBSTITUTED, because substitution needs outputs that do
 * not exist yet and a host's `resolveCtxProvider` keys on pattern, session and
 * providerOptions rather than on prompt text — then asks
 * `router.explain?.(id, primary.modelTags ?? [], ctx)`. `explain` is optional
 * on `CapabilityRouter` (a host router written before it existed keeps
 * compiling), so it is feature-detected; absent, the report degrades to
 * `checkSatisfiable`, which every router implements, and says so through
 * `by: 'checkSatisfiable'` and an absent `explanation`.
 *
 * A meta step is `opaque`. One expansion applies: a meta whose `origin` is
 * `'plan'` and which carries its own DAG on a `plan` field is preflighted one
 * level deep into `routing.nested`, so a persisted plan's atomics are explained
 * too. ONE level — a plan may not step into itself (`PLAN_PATTERN_SELF`), but
 * two persisted plans may name each other, and a preflight is not the place to
 * discover that by recursing.
 */
export function preflightPlan(
  dag: PlanDag,
  deps: PlanPreflightDeps,
): PlanPreflightReport {
  return preflight(dag, deps, 0)
}

/** `depth` is 0 for the plan the host asked about, 1 for a nested one. */
function preflight(
  dag: PlanDag,
  deps: PlanPreflightDeps,
  depth: number,
): PlanPreflightReport {
  const problems = validatePlan(dag, deps.registry, {
    ...(deps.audience !== undefined ? { audience: deps.audience } : {}),
    ...(deps.allow !== undefined ? { allow: deps.allow } : {}),
    ...(deps.selfId !== undefined ? { selfId: deps.selfId } : {}),
    ...(deps.inputs !== undefined ? { inputs: deps.inputs } : {}),
  })
  if (problems.length > 0) {
    return { ok: false, problems, steps: [], levels: [], unsatisfiable: [] }
  }

  const { levels, levelOf } = computeLevels(dag)
  const steps: PlanPreflightStep[] = dag.steps.map((step) => ({
    id: step.id,
    pattern: step.pattern as PatternId,
    kind: kindOf(deps.registry.get(step.pattern as PatternId)),
    level: levelOf.get(step.id) ?? 0,
    routing: routeStep(step, deps, depth),
  }))

  const unsatisfiable = steps
    .filter((s) => s.routing.kind === 'unsatisfiable')
    .map((s) => s.id)
  const ok = steps.every(
    (s) => s.routing.kind !== 'unsatisfiable' || s.routing.alternative !== undefined,
  )
  return { ok, problems, steps, levels, unsatisfiable }
}

function kindOf(pattern: Pattern | undefined): 'atomic' | 'meta' {
  // `undefined` and `'agent'` are both unreachable here: validatePlan reports
  // PLAN_PATTERN_NOT_FOUND / PLAN_PATTERN_KIND_AGENT and we returned above.
  return pattern?.kind === 'atomic' ? 'atomic' : 'meta'
}

function routeStep(
  step: PlanDag['steps'][number],
  deps: PlanPreflightDeps,
  depth: number,
): PlanStepRouting {
  const pattern = deps.registry.get(step.pattern as PatternId)
  if (pattern === undefined) return { kind: 'opaque' }
  return pattern.kind === 'atomic'
    ? routeAtomic(step, pattern as AtomicPattern, deps)
    : routeMeta(step, pattern as MetaPattern, deps, depth)
}

// ── Atomic: the routing decision ────────────────────────────────────────

function routeAtomic(
  step: PlanDag['steps'][number],
  atomic: AtomicPattern,
  deps: PlanPreflightDeps,
): PlanStepRouting {
  // The spec the dispatch would build, minus everything that only exists once
  // the plan is running. `input` carries its `$refs` unsubstituted on purpose:
  // see preflightPlan's doc.
  const spec: JobSpec = {
    patternId: atomic.id,
    input: step.input,
    ...(deps.sessionId !== undefined ? { sessionId: deps.sessionId } : {}),
  }
  const ctx: ResolveContext = deps.resolveCtx?.(spec) ?? {}
  const capability = atomic.id as Capability
  // Dispatch always routes on the primary path's tags (inline.ts).
  const requiredTags: readonly ModelTag[] = atomic.primary.modelTags ?? []

  const explanation = deps.router.explain?.(capability, requiredTags, ctx)
  if (explanation !== undefined) {
    const outcome = explanation.outcome
    if (outcome.kind === 'selected') {
      return {
        kind: 'selected',
        model: outcome.model,
        by: outcome.by,
        explanation,
      }
    }
    // `no-candidate` is unsatisfiable outright. `pin-excluded` is the third
    // outcome the report's two-way union has no member for: candidates DO
    // exist, so `satisfiable` is true, but `resolve` throws MODEL_EXCLUDED and
    // the step cannot run — which is what preflight is asked about. It reports
    // as unsatisfiable with the nearest reason, and the full `explanation`
    // rides along carrying the exact outcome for a host that wants to say
    // "your pin was excluded" rather than "nothing serves this".
    const reason: UnavailabilityReason =
      outcome.kind === 'no-candidate' ? outcome.reason : 'all-excluded'
    return unsatisfiableRouting(step, atomic, deps, ctx, requiredTags, reason, explanation)
  }

  // Degraded path: a two-method router. `checkSatisfiable` is on the interface
  // and every router implements it, but it reports the candidate LIST rather
  // than the selection — so the model named here is the first candidate, not
  // necessarily the one `resolve`'s pin / provider / tier precedence would
  // land on. `by` says which path produced the answer.
  const sat = deps.router.checkSatisfiable(capability, requiredTags, ctx)
  if (sat.ok) {
    const first = sat.candidates[0]
    return {
      kind: 'selected',
      model: first ? `${first.provider}:${first.modelId}` : '(unreported)',
      by: 'checkSatisfiable',
    }
  }
  return unsatisfiableRouting(step, atomic, deps, ctx, requiredTags, sat.reason)
}

function unsatisfiableRouting(
  step: PlanDag['steps'][number],
  atomic: AtomicPattern,
  deps: PlanPreflightDeps,
  ctx: ResolveContext,
  requiredTags: readonly ModelTag[],
  reason: UnavailabilityReason,
  explanation?: RoutingExplanation,
): PlanStepRouting {
  const applicable = applicableAlternatives(
    { registry: deps.registry, router: deps.router },
    atomic,
    ctx,
    requiredTags,
    readRequiresSemantics(step.input),
  )
  const first: Alternative<unknown, unknown> | undefined = applicable[0]
  return {
    kind: 'unsatisfiable',
    reason,
    ...(explanation !== undefined ? { explanation } : {}),
    ...(first !== undefined
      ? {
          alternative: {
            ...toAvailableAlternative(first),
            wouldFire: deps.alternatives === 'auto',
          },
        }
      : {}),
  }
}

/**
 * TWIN of `readRequiresSemantics` in inline.ts, which is the dispatch path's
 * copy and the definition of record. Duplicated rather than imported: inline.ts
 * is a value module whose graph is `InlineRuntime` plus agent-dispatch plus
 * `@orchestral/discovery`, and the whole claim preflight makes is that it needs
 * no runtime to answer. Six defensive lines are the cheaper coupling.
 *
 * Keep the two identical. The rule: `requiresSemantics` is convention on a
 * Pattern's inputs, not schema — one `appliesWhen` member must not force a
 * field onto every Pattern's schema — so anything that is not an array of
 * strings means "nothing required", and nothing here throws.
 */
function readRequiresSemantics(input: unknown): readonly Semantics[] {
  if (typeof input !== 'object' || input === null) return []
  const raw = (input as { requiresSemantics?: unknown }).requiresSemantics
  if (!Array.isArray(raw)) return []
  return raw.filter((s): s is Semantics => typeof s === 'string')
}

// ── Meta: opaque, with what it declared about itself ────────────────────

function routeMeta(
  step: PlanDag['steps'][number],
  meta: MetaPattern,
  deps: PlanPreflightDeps,
  depth: number,
): PlanStepRouting {
  const routing: PlanStepRouting = { kind: 'opaque' }

  // `plannedDispatches` is author-supplied code running on a preflight path.
  // It is documented as pure and cheap, but a declaration that throws must
  // degrade to "not knowable" — the status quo for every meta that does not
  // declare — and never take the report down with it.
  if (typeof meta.plannedDispatches === 'function') {
    try {
      const declared = meta.plannedDispatches(step.input as never)
      if (Array.isArray(declared)) routing.plannedDispatches = declared
    } catch {
      // Deliberately swallowed: undefined means "not knowable", which is
      // exactly what a broken declaration has told us.
    }
  }

  // A meta that is itself a plan carries its DAG on a `plan` field, beside
  // `origin: 'plan'`, so a catalog UI can draw it and preflight can recurse.
  // Read structurally: the field is stamped by the interpreter in
  // @orchestral/patterns, which the runtime does not depend on.
  if (depth === 0 && meta.origin === 'plan') {
    const nested = (meta as { plan?: unknown }).plan
    if (looksLikePlanDag(nested)) {
      // The nested plan's own identity and parameters, not this one's: a step
      // of the inner plan may not name the INNER plan, and `$input` there binds
      // to the inner factory's `inputs` — which is that meta's `tool.inputs`,
      // when it is a plain object schema.
      //
      // `audience` stays OUT of the nested walk on purpose. The outer step
      // already passed the exposure gate for this surface, and the runtime
      // checks nothing further down: `runPlan` validates its DAG with no
      // audience ("the surface was checked at the boundary") and `ctx.step`
      // has no exposure gate at all. Forwarding it would predict a
      // PLAN_PATTERN_NOT_EXPOSED the runtime never raises and render a
      // runnable packaged plan as INVALID. `allow` DOES ride along — the
      // plannedDispatches guard really does hold a persisted plan's inner ids
      // to the caller's allowlist.
      const {
        inputs: _outerInputs,
        selfId: _outerSelfId,
        audience: _outerAudience,
        ...rest
      } = deps
      routing.nested = preflight(
        nested,
        {
          ...rest,
          selfId: meta.id,
          ...(isZodObject(meta.tool.inputs) ? { inputs: meta.tool.inputs } : {}),
        },
        1,
      )
    }
  }
  return routing
}

function looksLikePlanDag(value: unknown): value is PlanDag {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { steps?: unknown }).steps)
  )
}

/**
 * A `tool.inputs` that is a plain ZodObject can bind `$input.<field>`; anything
 * else (a `.superRefine`d schema, a union) cannot, and passing it would break
 * `validatePlan`'s rule 8 rather than switch it off. Same `_def.type`
 * introspection plan-validate and find_pattern do.
 */
function isZodObject(schema: unknown): schema is z.ZodObject {
  return (
    (schema as { _def?: { type?: string } } | undefined)?._def?.type === 'object'
  )
}

// ── Levels ──────────────────────────────────────────────────────────────

/**
 * `level(step) = 1 + max(level(dep))` over the step's backward references; a
 * step that references nothing is level 0. Steps sharing a level run
 * concurrently.
 *
 * TWIN of the level loop in `planToMeta` (@orchestral/patterns), which is the
 * one that actually schedules. Duplicated, not imported, for two reasons:
 * `@orchestral/patterns` is a devDependency of this package (a src import would
 * be a broken dependency at publish), and the rule is fifteen lines. If the
 * interpreter's grouping ever changes, this changes with it — a preflight that
 * draws different stages than the run executes is worse than no stage count.
 *
 * Safe to compute unguarded because it runs only after `validatePlan` returned
 * clean: every ref is backward, every target exists, ids are unique. A cycle is
 * unrepresentable in the grammar (array order IS the topological order), so the
 * fold below terminates by construction.
 */
function computeLevels(dag: PlanDag): {
  levels: string[][]
  levelOf: Map<string, number>
} {
  const levelOf = new Map<string, number>()
  const levels: string[][] = []
  for (const step of dag.steps) {
    let level = 0
    for (const dep of dependenciesOf(step)) {
      const depLevel = levelOf.get(dep)
      if (depLevel !== undefined) level = Math.max(level, depLevel + 1)
    }
    levelOf.set(step.id, level)
    // A hole is impossible — a level-N step needs a level-(N-1) dependency, so
    // every stage below N already has an occupant — but filling forward costs
    // nothing and keeps `levels` dense whatever the caller hands in.
    while (levels.length <= level) levels.push([])
    levels[level]?.push(step.id)
  }
  return { levels, levelOf }
}

/** The step ids this step references, from `input` value refs and `assets`. */
function dependenciesOf(step: PlanDag['steps'][number]): Set<string> {
  const deps = new Set<string>()
  const visit = (value: unknown, depth: number): void => {
    if (depth > 64) return
    if (typeof value === 'string') {
      const head = refHead(value)
      // `$input` is the plan's own parameters, not a step.
      if (head !== undefined && head !== 'input') deps.add(head)
      return
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1)
      return
    }
    if (typeof value === 'object' && value !== null) {
      for (const entry of Object.values(value)) visit(entry, depth + 1)
    }
  }
  visit(step.input, 0)
  visit(step.assets, 0)
  return deps
}

/** The producing step id of a whole-string reference, or undefined. */
function refHead(value: string): string | undefined {
  return (
    PLAN_VALUE_REF_RE.exec(value)?.[1] ?? PLAN_ASSET_REF_RE.exec(value)?.[1]
  )
}

// ── The formatter ───────────────────────────────────────────────────────

/** Longest id / pattern column before the formatter stops padding. */
const MAX_COLUMN = 28
/** Problem lines rendered before the block is truncated. */
const MAX_PROBLEM_LINES = 20

/**
 * Render a report as plain multi-line text — the body of a host's confirm
 * dialog, or a log entry. Pure and dependency-free, in the style of
 * `formatRoutingExplanation` (core/routing-explanation.ts): no colour codes, no
 * IO, bounded output, and nothing the report does not already carry.
 *
 * One line per step:
 *
 *   describe   text-generation   → openai:gpt-4.1
 *   animate    image-to-video    ✗ no-model-in-catalog (would fall back to
 *                                  meta_image-to-video-via-frames under auto:
 *                                  loses camera-motion)
 *
 * `→` and `✗` are the two glyphs docs/plan.md's Preflight section pins for this
 * surface, which is why this formatter is not ASCII-only as its sibling in core
 * is. Everything else here is.
 */
export function formatPlanPreflight(report: PlanPreflightReport): string {
  const lines: string[] = []
  if (report.problems.length > 0) {
    lines.push(
      `plan: INVALID — ${report.problems.length} problem${
        report.problems.length === 1 ? '' : 's'
      }, nothing routed`,
    )
    for (const problem of report.problems.slice(0, MAX_PROBLEM_LINES)) {
      const at = problem.path.length === 0 ? '(root)' : problem.path.join('.')
      lines.push(`  ${problem.code} at ${at}: ${problem.message}`)
    }
    if (report.problems.length > MAX_PROBLEM_LINES) {
      lines.push(`  … +${report.problems.length - MAX_PROBLEM_LINES} more`)
    }
    return lines.join('\n')
  }

  lines.push(
    `plan: ${report.steps.length} step${report.steps.length === 1 ? '' : 's'} in ${
      report.levels.length
    } stage${report.levels.length === 1 ? '' : 's'}${
      report.unsatisfiable.length > 0
        ? `, ${report.unsatisfiable.length} unsatisfiable`
        : ''
    }${report.ok ? '' : ' — NOT ok'}`,
  )
  lines.push(...formatSteps(report.steps, ''))
  lines.push(
    `stages: ${report.levels
      .map((ids, i) => `${i + 1} [${ids.join(', ')}]`)
      .join('  ')}`,
  )
  return lines.join('\n')
}

function formatSteps(
  steps: readonly PlanPreflightStep[],
  indent: string,
): string[] {
  const idWidth = columnWidth(steps.map((s) => s.id))
  const patternWidth = columnWidth(steps.map((s) => s.pattern))
  const lines: string[] = []
  for (const step of steps) {
    lines.push(
      `${indent}${step.id.padEnd(idWidth)}  ${step.pattern.padEnd(
        patternWidth,
      )}  ${formatRouting(step.routing)}`,
    )
    const nested = step.routing.kind === 'opaque' ? step.routing.nested : undefined
    if (nested === undefined) continue
    lines.push(
      `${indent}  plan: ${nested.problems.length > 0 ? `INVALID (${nested.problems.length} problem(s))` : `${nested.steps.length} step(s) in ${nested.levels.length} stage(s)${nested.ok ? '' : ' — NOT ok'}`}`,
    )
    lines.push(...formatSteps(nested.steps, `${indent}    `))
  }
  return lines
}

function columnWidth(values: readonly string[]): number {
  return Math.min(
    MAX_COLUMN,
    values.reduce((max, v) => Math.max(max, v.length), 0),
  )
}

function formatRouting(routing: PlanStepRouting): string {
  switch (routing.kind) {
    case 'selected':
      return `→ ${routing.model}`
    case 'unsatisfiable':
      return `✗ ${routing.reason}${formatAlternative(routing.alternative)}`
    case 'opaque': {
      const parts: string[] = [routing.nested ? 'meta, plan' : 'meta, opaque']
      if (routing.plannedDispatches !== undefined) {
        parts.push(
          routing.plannedDispatches.length > 0
            ? `dispatches ${routing.plannedDispatches.join(', ')}`
            : 'dispatches nothing',
        )
      }
      return `(${parts.join('; ')})`
    }
  }
}

function formatAlternative(alt: PreflightAlternative | undefined): string {
  if (alt === undefined) return ''
  const tradeoff =
    alt.losses && alt.losses.length > 0
      ? `: loses ${alt.losses.join(', ')}`
      : alt.preserves && alt.preserves.length > 0
        ? `: preserves ${alt.preserves.join(', ')}`
        : ''
  return alt.wouldFire
    ? ` (falls back to ${alt.targetPatternId}${tradeoff})`
    : ` (would fall back to ${alt.targetPatternId} under auto${tradeoff})`
}
