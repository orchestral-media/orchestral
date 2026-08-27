// Selecting a declared Alternative — the contract half of cross-Pattern
// fallback.
//
// Deciding whether a declared path APPLIES is a pure read of `appliesWhen`
// against the registry's declarations and the router's satisfiability screen,
// and both of those are core vocabulary (alternative.ts, alternative-builders.ts,
// capability-router.ts). Deciding whether an applying path is TAKEN is a
// runtime policy (`InlineRuntimeInit.alternatives`, default 'off'), and taking
// it needs a dispatcher, a JobStore and an event fanout — all of which stay in
// @orchestral/runtime (`runAlternative`).
//
// The split is here because two surfaces report "paths not taken" and must not
// disagree: the runtime's ALTERNATIVES_NOT_ENABLED diagnostic and
// @orchestral/plan's `preflightPlan`. A preflight that advertised a path with
// different metadata — or a different applicability verdict — than the failure
// would carry is a report about a different system.

import type {
  Alternative,
  AlternativeAppliesWhen,
  Semantics,
  UnavailabilityReason,
} from './alternative'
import type { Capability } from './capability'
import type { ResolveContext } from './capability-model'
import type { CapabilityRouter } from './capability-router'
import type { PatternId } from './foundational'
import type { ModelTag } from './model-tag'
import type { AtomicPattern } from './pattern'
import type { PatternRegistry } from './registry'

/** What selecting an alternative needs: the declarations, and satisfiability. */
export interface AlternativeSelectionDeps {
  registry: PatternRegistry
  router: CapabilityRouter
}

/**
 * Every declared alternative whose `appliesWhen` matches, in declaration
 * order. Used under `alternatives: 'off'` to report the paths not taken, and by
 * `preflightPlan` to name the path an unsatisfiable step would have.
 */
export function applicableAlternatives<I, O>(
  deps: AlternativeSelectionDeps,
  atomic: AtomicPattern<I, O>,
  ctx: ResolveContext,
  requiredTags: readonly ModelTag[],
  requestedSemantics: readonly Semantics[],
): readonly Alternative<unknown, unknown>[] {
  const alternatives = deps.registry.getEntry(atomic.id)?.alternatives ?? []
  return alternatives.filter((alt) =>
    appliesWhen(
      deps,
      alt.appliesWhen,
      ctx,
      atomic.id as Capability,
      requiredTags,
      requestedSemantics,
    ),
  )
}

/**
 * Pick the first registered alternative whose appliesWhen matches.
 * Synchronous; no IO beyond Router.checkSatisfiable. Callers gate this on
 * `alternativesMode === 'auto'` — a match is only ever taken when the host
 * opted in.
 */
export function pickAlternative<I, O>(
  deps: AlternativeSelectionDeps,
  atomic: AtomicPattern<I, O>,
  ctx: ResolveContext,
  requiredTags: readonly ModelTag[],
  requestedSemantics: readonly Semantics[],
): Alternative<I, O> | null {
  const alternatives = deps.registry.getEntry(atomic.id)?.alternatives ?? []
  if (alternatives.length === 0) return null
  for (const alt of alternatives) {
    if (
      appliesWhen(
        deps,
        alt.appliesWhen,
        ctx,
        atomic.id as Capability,
        requiredTags,
        requestedSemantics,
      )
    ) {
      return alt as Alternative<I, O>
    }
  }
  return null
}

function appliesWhen(
  deps: AlternativeSelectionDeps,
  cond: AlternativeAppliesWhen,
  ctx: ResolveContext,
  cap: Capability,
  fallbackTags: readonly ModelTag[],
  requestedSemantics: readonly Semantics[],
): boolean {
  switch (cond.kind) {
    case 'always':
      return true
    case 'capability-unavailable': {
      const tags = cond.requiredTags ?? fallbackTags
      return !deps.router.checkSatisfiable(cap, tags, ctx).ok
    }
    case 'preserves-required':
      return cond.semantics.some((s) => requestedSemantics.includes(s))
  }
}

/**
 * The semantic dimensions the caller asked this dispatch to preserve, read off
 * the input's `requiresSemantics` field. This is the caller's half of
 * `appliesWhen: { kind: 'preserves-required' }`: alternative.ts sets the
 * convention that a Pattern wanting that member exposes
 * `requiresSemantics?: Semantics[]` on its inputs, and a caller compares
 * whatever was filled against the alternative's `semantics`.
 *
 * Read off the input rather than demanded of every schema because the field
 * is opt-in per Pattern — one appliesWhen kind must not force a field onto the
 * input schema of every Pattern that will never declare such a row. That also
 * makes this the one place the value is untyped: the input has passed the
 * Pattern's zod schema, but `requiresSemantics` is convention, not schema, so
 * a missing or malformed value means "nothing required" and never a throw.
 * Anything that is not an array is ignored; non-string entries are dropped.
 */
export function readRequiresSemantics(input: unknown): readonly Semantics[] {
  if (typeof input !== 'object' || input === null) return []
  const raw = (input as { requiresSemantics?: unknown }).requiresSemantics
  if (!Array.isArray(raw)) return []
  return raw.filter((s): s is Semantics => typeof s === 'string')
}

/** One declared alternative a dispatch or a preflight declined to take, as reported. */
export interface AvailableAlternative {
  /** `Alternative.id` — unique within the parent Pattern's list. */
  id: string
  /** `Alternative.description` — human-readable path summary. */
  description: string
  /** `Alternative.via.patternId` — submit this to take the path by hand. */
  targetPatternId: PatternId
  /**
   * `Alternative.preserves` / `Alternative.losses`, verbatim. The whole point
   * of refusing-with-the-path-named is that the host can put the trade-off in
   * front of a user before deciding; a diagnostic that names the path but not
   * what it gives up sends the host back to the registry to look it up by id.
   * The `job:alternative-selected` event on the `'auto'` path already carries
   * both — the default `'off'` path must not be the less informative one.
   */
  preserves?: readonly Semantics[]
  losses?: readonly Semantics[]
}

/**
 * `Alternative` → {@link AvailableAlternative}, the one projection every
 * "paths not taken" surface reports: the ALTERNATIVES_NOT_ENABLED diagnostic in
 * @orchestral/runtime and `preflightPlan` in @orchestral/plan.
 *
 * `preserves` / `losses` are spread conditionally so an alternative that
 * declares neither produces neither key, rather than two `undefined`s a host
 * has to filter out of a rendered trade-off.
 */
export function toAvailableAlternative(
  alt: Alternative<unknown, unknown>,
): AvailableAlternative {
  return {
    id: alt.id,
    description: alt.description,
    targetPatternId: alt.via.patternId,
    ...(alt.preserves ? { preserves: alt.preserves } : {}),
    ...(alt.losses ? { losses: alt.losses } : {}),
  }
}

/** Re-exported for the runtime's `RunAlternativeDeps`, which extends it. */
export type { UnavailabilityReason }
