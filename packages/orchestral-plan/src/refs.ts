// The $ref grammar's one parser: heads, paths, dependencies, levels.
//
// This walk used to exist three times — beside `validatePlan` in
// @orchestral/core, inside the interpreter in @orchestral/patterns, inside
// `preflightPlan` in @orchestral/runtime — with three depth rules and two head
// filters between them, and two of the three carried a comment asking a human
// to keep them in step. The invariant those comments guarded is the plan's
// central one: the string layer 1 reads as a reference must be the string the
// interpreter substitutes and the string preflight bills for. It is a function
// call now, not a discipline.
//
// Four rules, stated once:
//
//   1. One depth cap for every walk (PLAN_REF_MAX_DEPTH).
//   2. A head is read only off a WHOLE-string reference — `"Costs $5.99 for
//      $render.assets[0]"` depends on nothing, exactly as `substitute` in
//      interpreter.ts replaces nothing in it.
//   3. `$input` is the plan's own CALLER and never a dependency — both of the
//      productions that read it, `$input.<field>` off the parameter schema and
//      `$input.assets[slot=…]` off the declared asset slots. Neither names a
//      step, so neither contributes a level or a `referenced` mark; a plan
//      whose only reads are from its caller is one level deep.
//   4. No declared-id filter: a head that names no step is returned as read.
//      `planLevels` has no level for it and moves on; `validatePlan`'s rules 5
//      and 6 refuse it long before either of them runs.

import {
  PLAN_ASSET_REF_RE,
  PLAN_INPUT_ASSET_REF_RE,
  PLAN_VALUE_REF_RE,
  type PlanDag,
  type PlanStep,
} from './plan'

/**
 * How deep a walk descends into a step's `input` before it stops.
 *
 * Well past anything a real `providerOptions` blob reaches; the point is that a
 * host handing in a cyclic object gets a problem back rather than a RangeError,
 * because `validatePlan` promises never to throw. `validate.ts`'s rule 24 uses
 * the same constant to refuse an input nested deeper than this, which is what
 * makes the cap invisible in practice: a plan that validates carries every one
 * of its references inside the reach of every walk here.
 */
export const PLAN_REF_MAX_DEPTH = 64

/** A whole-string value reference, parsed. */
export interface ParsedValueRef {
  head: string
  isInput: boolean
  segments: (string | number)[]
}

/** A whole-string asset reference, parsed. */
export interface ParsedAssetRef {
  /** The producing step, or `input` for media the caller supplied. */
  head: string
  /** Positional selector; absent when the ref selects by label or slot. */
  index?: number
  label?: string
  /**
   * This plan's own asset slot. Present exactly when `head` is `input` — the
   * two productions are disjoint, so `slot !== undefined` is the discriminator.
   */
  slot?: string
}

const REF_HEAD_RE = /^\$([A-Za-z][A-Za-z0-9_-]{0,63})/
const VALUE_SEGMENT_RE = /\.([A-Za-z_][A-Za-z0-9_]{0,63})|\[([0-9]{1,3})\]/g

/**
 * Parse a whole-string value reference. Note that `$render.assets[0]` parses
 * here as well as through {@link parseAssetRef} — the value production has no
 * way to exclude a field literally called `assets`, which is why validate.ts's
 * rule 7 checks the first segment rather than the regex.
 */
export function parseValueRef(value: string): ParsedValueRef | null {
  if (!PLAN_VALUE_REF_RE.test(value)) return null
  // The head alternation in PLAN_VALUE_REF_RE lists `input` first for
  // readability, but `[A-Za-z][A-Za-z0-9_-]*` matches it too — so read the head
  // greedily and compare, or `$inputs.x` would parse with head `input`.
  const head = REF_HEAD_RE.exec(value)?.[1]
  if (head === undefined) return null
  const segments: (string | number)[] = []
  for (const m of value.slice(1 + head.length).matchAll(VALUE_SEGMENT_RE)) {
    segments.push(m[1] !== undefined ? m[1] : Number(m[2]))
  }
  return { head, isInput: head === 'input', segments }
}

/**
 * Parse a whole-string asset reference: positional or by label off a producing
 * step, or by slot off the caller's own input.
 */
export function parseAssetRef(value: string): ParsedAssetRef | null {
  const fromInput = PLAN_INPUT_ASSET_REF_RE.exec(value)
  if (fromInput !== null) return { head: 'input', slot: fromInput[1] ?? '' }
  const m = PLAN_ASSET_REF_RE.exec(value)
  if (m === null) return null
  const selector = m[2] ?? ''
  return selector.startsWith('label=')
    ? { head: m[1] ?? '', label: selector.slice('label='.length) }
    : { head: m[1] ?? '', index: Number(selector) }
}

/**
 * The head of a whole-string reference of any production: the producing step
 * for the three that read one, and `input` for the two that read the plan's own
 * caller — `$input.<field>` and `$input.assets[slot=…]`. Callers that must not
 * treat the caller's input as a step filter it out; see rule 3 above.
 */
export function refHead(value: string): string | undefined {
  return parseValueRef(value)?.head ?? parseAssetRef(value)?.head
}

/**
 * Add the head of every whole-string reference in `value` to `into`, reporting
 * nothing. `$input` is skipped (rule 3).
 *
 * Used by {@link dependenciesOf} and, in validate.ts, for a subtree the grammar
 * rules deliberately skip (a nested plan's own DAG): the refusals would be
 * false there, but a head that names one of THIS plan's steps is still a read,
 * and rule 22 has to see it or an only-consumed-by-a-nested-plan step reads as
 * unused.
 */
export function collectRefHeads(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > PLAN_REF_MAX_DEPTH) return
  if (typeof value === 'string') {
    const head = refHead(value)
    if (head !== undefined && head !== 'input') into.add(head)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectRefHeads(entry, into, depth + 1)
    return
  }
  if (isRecord(value)) {
    for (const v of Object.values(value)) collectRefHeads(v, into, depth + 1)
  }
}

/** Every step id this step reads, through either channel. */
export function dependenciesOf(step: Pick<PlanStep, 'input' | 'assets'>): Set<string> {
  const deps = new Set<string>()
  collectRefHeads(step.input, deps)
  collectRefHeads(step.assets, deps)
  return deps
}

/**
 * Group the steps into dependency levels, preserving listed order within each:
 * `level(step) = 1 + max(level(dep))` over the backward refs, and a step that
 * references nothing is level 0. Steps sharing a level run concurrently.
 *
 * References are backward-only (validate.ts's rule 5 is the cycle check), so one
 * forward pass suffices: every dependency already has a level by the time it is
 * read. A head with no level — an unknown step, or a plan handed here before it
 * was validated — contributes nothing rather than throwing.
 *
 * `levels` is what the interpreter schedules; `levelOf` is what preflight
 * renders as a stage number. One function, so a preflight can never draw
 * different stages than the run executes.
 */
export function planLevels(dag: PlanDag): {
  levels: PlanStep[][]
  levelOf: Map<string, number>
} {
  const levelOf = new Map<string, number>()
  const levels: PlanStep[][] = []
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
    levels[level]?.push(step)
  }
  return { levels, levelOf }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
