// Cross-Pattern fallback: TAKING a declared `Alternative`, and the refusal
// that names the ones not taken.
//
// Whether a redirect happens at all is `InlineRuntimeInit.alternatives`, and it
// defaults to 'off'. Under 'off' the dispatch path calls
// `applicableAlternatives` only to name the paths it declined on
// `AlternativesNotEnabledError`; under 'auto' it calls `pickAlternative` and
// then `runAlternative` below.
//
// Selection itself — `applicableAlternatives` / `pickAlternative` /
// `toAvailableAlternative` — is @orchestral/core's (alternative-select.ts): it
// is a pure read of the registry's declarations and the router's satisfiability
// screen, and @orchestral/plan's preflight reports the same paths from the same
// evaluation. What stays here is what taking one needs — a dispatcher, a
// JobStore, an event fanout — none of which core has.

import type {
  Alternative,
  Capability,
  DispatchContext,
  JobEvent,
  JobSpec,
  JobStore,
  Pattern,
  PatternId,
  UnavailabilityReason,
} from '@orchestral/core'
import {
  toAvailableAlternative,
  type AlternativeSelectionDeps,
  type AvailableAlternative,
} from '@orchestral/core'

// Re-exported so a host that narrows on ALTERNATIVES_NOT_ENABLED's diagnostic
// reads the payload type off this package's barrel, where the error is.
export type { AvailableAlternative }

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
    const alternatives: readonly AvailableAlternative[] =
      applicable.map(toAvailableAlternative)
    super(
      `ALTERNATIVES_NOT_ENABLED: ${capability} cannot be served (reason=${reason}) and automatic alternatives are off; ${alternatives.length} declared path(s) would have applied: ${alternatives
        .map((a) => `${a.id} → ${a.targetPatternId}`)
        .join(', ')}. ${ALTERNATIVES_HINT}`,
    )
    this.diagnostic = { capability, reason, alternatives, hint: ALTERNATIVES_HINT }
  }
}
