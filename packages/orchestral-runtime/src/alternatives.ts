// Cross-Pattern fallback: selecting a declared `Alternative` and dispatching
// through it.
//
// Whether a redirect happens at all is `InlineRuntimeInit.alternatives`, and
// it defaults to 'off' — these functions are what the two modes share. Under
// 'off' the dispatch path calls `applicableAlternatives` only to name the
// paths it declined on `AlternativesNotEnabledError`; under 'auto' it calls
// `pickAlternative` and then `runAlternative`. Selection is synchronous and
// does no IO beyond `CapabilityRouter.checkSatisfiable`.

import type {
  Alternative,
  AlternativeAppliesWhen,
  AtomicPattern,
  Capability,
  CapabilityRouter,
  DispatchContext,
  JobEvent,
  JobSpec,
  JobStore,
  ModelTag,
  Pattern,
  PatternId,
  PatternRegistry,
  ResolveContext,
  Semantics,
  UnavailabilityReason,
} from '@orchestral/core'

/** What selecting an alternative needs: the declarations, and satisfiability. */
export interface AlternativeSelectionDeps {
  registry: PatternRegistry
  router: CapabilityRouter
}

/** Selection, plus what taking the path needs. */
export interface RunAlternativeDeps extends AlternativeSelectionDeps {
  store: JobStore
  fanout: (jobId: string, event: JobEvent) => void
  /**
   * `InlineRuntime.dispatch`. The redirect reuses the parent's jobId, so any
   * CallEvents the alternative's model fires still fan out under that Job.
   */
  dispatch: (
    jobId: string,
    pattern: Pattern,
    spec: JobSpec,
    signal: AbortSignal,
    visited: Set<PatternId>,
    depth: number,
    metaSharedState: undefined,
    parentCtx: DispatchContext | undefined,
  ) => Promise<unknown>
}

/**
 * Every declared alternative whose `appliesWhen` matches, in declaration
 * order. Used under `alternatives: 'off'` to report the paths not taken.
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

export async function runAlternative<TIn, TOut>(
  deps: RunAlternativeDeps,
  jobId: string,
  alt: Alternative<TIn, TOut>,
  spec: JobSpec<TIn>,
  signal: AbortSignal,
  visited: Set<PatternId>,
  depth: number,
  // Forward the parent ctx into the redirect dispatch so the alternative
  // target's atomic fork seed matches the original dispatch.
  parentCtx?: DispatchContext,
): Promise<TOut> {
  const targetId = alt.via.patternId
  if (visited.has(targetId)) {
    throw Object.assign(
      new Error(`CIRCULAR_ALTERNATIVE: ${targetId} already visited`),
      { code: 'CIRCULAR_ALTERNATIVE' },
    )
  }
  const target = deps.registry.getEntry(targetId)?.pattern
  if (!target) {
    throw Object.assign(
      new Error(`ALTERNATIVE_PATTERN_NOT_REGISTERED: ${targetId}`),
      { code: 'ALTERNATIVE_PATTERN_NOT_REGISTERED' },
    )
  }
  // Surface the degradation before the redirect dispatches — without this
  // event a subscriber cannot tell a degraded completion from a primary
  // one, and the Alternative's declared losses metadata would be evaluated
  // and then thrown away.
  const snapshot = await deps.store.get(jobId)
  if (snapshot) {
    deps.fanout(jobId, {
      type: 'job:alternative-selected',
      job: snapshot,
      alternativeId: alt.id,
      description: alt.description,
      targetPatternId: targetId,
      ...(alt.preserves ? { preserves: alt.preserves } : {}),
      ...(alt.losses ? { losses: alt.losses } : {}),
    })
  }
  const childInput = alt.via.mapInput(spec.input)
  const childSpec: JobSpec = {
    patternId: targetId,
    input: childInput,
    // Propagate the resolved assets into the redirect target so the
    // alternative dispatch sees the same source assets the parent resolved.
    ...(spec.assets ? { assets: spec.assets } : {}),
    // Ambient host context rides along too: the degraded path must run with
    // the same UI-default providerOptions and asset-resolution context the
    // primary would have received, or generation parameters silently change.
    ...(spec.providerOptions ? { providerOptions: spec.providerOptions } : {}),
    ...(spec.assetContextId ? { assetContextId: spec.assetContextId } : {}),
    sessionId: spec.sessionId,
  }
  const nextVisited = new Set(visited).add(targetId)
  // Alternative target always invoked via its primary path. To direct an
  // alternative to a specific sub-mode, the author shapes it via
  // the child Pattern's input.providerOptions / input.references.
  const childOutput = await deps.dispatch(
    jobId,
    target,
    childSpec,
    signal,
    nextVisited,
    depth + 1,
    undefined,
    parentCtx,
  )
  return alt.via.mapOutput(childOutput) as TOut
}

/** One declared alternative the dispatch declined to take, as reported. */
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

/** One sentence, both in the message and on the structured diagnostic. */
export const ALTERNATIVES_HINT =
  "Construct InlineRuntime with `alternatives: 'auto'` to let it redirect through declared alternatives automatically, or submit one of the listed targetPatternId values yourself."

/**
 * The primary path cannot be served, a declared alternative matches, and
 * automatic redirects are off (the default). Structured on purpose: `code` is
 * stable, and `diagnostic` reaches the host as `JobError.details.diagnostic`
 * through normaliseError, so a subscriber — or an LLM reading the failed tool
 * result — enumerates the paths without parsing the message.
 *
 * Runtime-internal: hosts narrow on `JobError.code`, which is the shape that
 * actually crosses the subscription boundary; the class itself is not part of
 * the package surface.
 */
export class AlternativesNotEnabledError extends Error {
  readonly code = 'ALTERNATIVES_NOT_ENABLED'
  readonly diagnostic: {
    capability: Capability
    reason: UnavailabilityReason
    alternatives: readonly AvailableAlternative[]
    hint: string
  }

  constructor(
    capability: Capability,
    reason: UnavailabilityReason,
    applicable: readonly Alternative<unknown, unknown>[],
  ) {
    const alternatives: readonly AvailableAlternative[] = applicable.map(
      (alt) => ({
        id: alt.id,
        description: alt.description,
        targetPatternId: alt.via.patternId,
        ...(alt.preserves ? { preserves: alt.preserves } : {}),
        ...(alt.losses ? { losses: alt.losses } : {}),
      }),
    )
    super(
      `ALTERNATIVES_NOT_ENABLED: ${capability} cannot be served (reason=${reason}) and automatic alternatives are off; ${alternatives.length} declared path(s) would have applied: ${alternatives
        .map((a) => `${a.id} → ${a.targetPatternId}`)
        .join(', ')}. ${ALTERNATIVES_HINT}`,
    )
    this.diagnostic = { capability, reason, alternatives, hint: ALTERNATIVES_HINT }
  }
}
