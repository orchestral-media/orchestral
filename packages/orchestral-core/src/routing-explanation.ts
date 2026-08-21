// The structured answer to "why did routing pick that model?" — the shape
// `CapabilityRouter.explain` returns, plus a formatter that renders it for a
// CLI or a log line. Routing is a stack of filters (enablement ranking,
// exclusion, tags) followed by a selection precedence (pin → provider → tier →
// first candidate); each of those steps is invisible from `resolve`'s return
// value alone, and a wrong model is indistinguishable from a wrong catalog.
// This is the `--dump-config` surface for that stack: no behaviour of its own,
// no IO, and nothing the router does not already compute.

import type { UnavailabilityReason } from './alternative'
import type { Capability } from './capability'
import type { ResolveContext } from './capability-model'
import type { ModelTag } from './model-tag'

/**
 * The filter step that eliminated a candidate. Listed in the order the router
 * applies them, so the reported stage is the FIRST one that rejected the
 * model — a model both un-enabled and excluded reports `'not-enabled'`.
 *
 * - `capability-not-declared` — `getModels` returned a record whose
 *   `capabilities` does not include the requested one. The seam is documented
 *   as "every model that declares `cap`"; seeing this stage means the host's
 *   query is wider than that.
 * - `not-enabled` — outside the stored enablement order
 *   (`getCapabilityOrder`), which the router injected because the caller
 *   neither pinned nor ranked.
 * - `not-ranked` — outside the caller's own `ctx.rankedModels`.
 * - `excluded-provider` / `excluded-model` — `ctx.excludeProvider` /
 *   `ctx.excludeModel`. The latter is also how the runtime's model fallback
 *   walk skips a model it has given up on.
 * - `tag-mismatch` — does not bear every required {@link ModelTag}.
 *
 * `tier` is deliberately absent: it never eliminates a candidate, it only
 * biases selection (see {@link RoutingSelectionRule}).
 */
export type RoutingDropStage =
  | 'capability-not-declared'
  | 'not-enabled'
  | 'not-ranked'
  | 'excluded-provider'
  | 'excluded-model'
  | 'tag-mismatch'

/**
 * Which rule in `resolve`'s precedence picked the winner:
 * pinned → preferred provider → tier → first candidate in ranked (or, with no
 * ranking, declared) order. `'tier'` appears only when a tier was requested
 * AND a candidate bears it; a requested tier that matches nothing falls
 * through to `'first-candidate'` rather than failing.
 */
export type RoutingSelectionRule =
  | 'pinned'
  | 'preferred-provider'
  | 'tier'
  | 'first-candidate'

interface RoutingCandidateBase {
  /** `provider:modelId` — the id every ctx knob and the ranking speak in. */
  model: string
  provider: string
  modelId: string
  tags: readonly ModelTag[]
  tier?: 'fast' | 'balanced' | 'premium'
}

/**
 * One model `getModels` returned, and its fate. Survivors carry no stage;
 * their position in the fallback chain is their index in
 * {@link RoutingExplanation.order}.
 */
export type RoutingCandidate =
  | (RoutingCandidateBase & { kept: true })
  | (RoutingCandidateBase & { kept: false; droppedBy: RoutingDropStage })

/**
 * What `resolve` would do with the same arguments — the three outcomes it
 * actually has, rather than a boolean that flattens two of them:
 *
 * - `selected` — returns that model, by that rule.
 * - `no-candidate` — throws `NO_MODEL_FOR_CAPABILITY` carrying `reason`.
 * - `pin-excluded` — throws `MODEL_EXCLUDED`. Candidates DO exist (so
 *   `satisfiable` is true); the pinned id is not among them.
 *   `excludedByRetry` distinguishes a pin dropped by `ctx.excludeModel` after
 *   a failed dispatch from one that was never a candidate.
 */
export type RoutingOutcome =
  | { kind: 'selected'; model: string; by: RoutingSelectionRule }
  | { kind: 'no-candidate'; reason: UnavailabilityReason }
  | { kind: 'pin-excluded'; pinnedModel: string; excludedByRetry: boolean }

/**
 * One routing decision, fully unfolded. Pure data — building it runs the same
 * filters `resolve` runs but calls no model and mutates nothing.
 */
export interface RoutingExplanation {
  capability: Capability
  requiredTags: readonly ModelTag[]
  /**
   * The EFFECTIVE context, i.e. the caller's plus the stored enablement order
   * injected as `rankedModels` when the gate applied. Read it together with
   * `enablementDefaulted` — a `rankedModels` here is not necessarily one the
   * caller passed.
   */
  context: ResolveContext
  /** True when `rankedModels` in `context` came from `getCapabilityOrder`. */
  enablementDefaulted: boolean
  /**
   * At least one candidate survived — the same verdict `checkSatisfiable`
   * returns. Not the same as "resolve will succeed": a pin that is not among
   * the survivors still throws (outcome `pin-excluded`).
   */
  satisfiable: boolean
  /** Every record `getModels` returned, in the order it returned them. */
  candidates: readonly RoutingCandidate[]
  /**
   * Surviving `provider:modelId`s in resolution order. Index 0 is the default;
   * the rest are what the runtime's `excludeModel` retry walks through.
   */
  order: readonly string[]
  outcome: RoutingOutcome
}

/**
 * Render an explanation as plain multi-line text for a CLI dump or a log
 * entry. Pure and dependency-free — the library never writes to stdout, so
 * printing the result is the caller's move. ASCII only; the output is meant to
 * survive a Windows console and a grep.
 */
export function formatRoutingExplanation(
  explanation: RoutingExplanation,
): string {
  const {
    capability,
    requiredTags,
    context,
    enablementDefaulted,
    satisfiable,
    candidates,
    order,
    outcome,
  } = explanation

  const lines: string[] = []
  lines.push(
    `routing: ${capability}${
      requiredTags.length > 0 ? ` tags=[${requiredTags.join(', ')}]` : ''
    }`,
  )
  lines.push(
    `satisfiable: ${satisfiable ? 'yes' : 'no'}${
      outcome.kind === 'no-candidate' ? ` (${outcome.reason})` : ''
    }`,
  )
  lines.push(`resolve: ${formatOutcome(outcome)}`)
  lines.push(`context: ${formatContext(context)}`)
  lines.push(`ranking: ${formatRanking(context, enablementDefaulted)}`)
  lines.push(`candidates: ${order.length} kept of ${candidates.length}`)

  for (const candidate of candidates) {
    if (candidate.kept) {
      const rank = order.indexOf(candidate.model) + 1
      lines.push(`  ${rank}. ${candidate.model}${formatTraits(candidate)}`)
    } else {
      lines.push(
        `  -  ${candidate.model}${formatTraits(candidate)} dropped: ${candidate.droppedBy}`,
      )
    }
  }
  return lines.join('\n')
}

function formatOutcome(outcome: RoutingOutcome): string {
  switch (outcome.kind) {
    case 'selected':
      return `${outcome.model} (by ${outcome.by})`
    case 'no-candidate':
      return `throws NO_MODEL_FOR_CAPABILITY (${outcome.reason})`
    case 'pin-excluded':
      return `throws MODEL_EXCLUDED (${outcome.pinnedModel}${
        outcome.excludedByRetry ? ', excluded by retry' : ', never a candidate'
      })`
  }
}

/** Only the knobs the caller actually set; `(none)` when it set nothing. */
function formatContext(ctx: ResolveContext): string {
  const parts: string[] = []
  if (ctx.pinnedModel) parts.push(`pinnedModel=${ctx.pinnedModel}`)
  if (ctx.preferProvider) parts.push(`preferProvider=${ctx.preferProvider}`)
  if (ctx.tier) parts.push(`tier=${ctx.tier}`)
  if (ctx.excludeProvider?.length) {
    parts.push(`excludeProvider=[${ctx.excludeProvider.join(', ')}]`)
  }
  if (ctx.excludeModel?.length) {
    parts.push(`excludeModel=[${ctx.excludeModel.join(', ')}]`)
  }
  return parts.length > 0 ? parts.join(' ') : '(none)'
}

function formatRanking(
  ctx: ResolveContext,
  enablementDefaulted: boolean,
): string {
  if (ctx.rankedModels === undefined) return 'declared order (getModels)'
  const source = enablementDefaulted
    ? 'enablement default (getCapabilityOrder)'
    : 'caller rankedModels'
  return `${source} [${ctx.rankedModels.join(', ')}]`
}

function formatTraits(candidate: RoutingCandidate): string {
  const parts: string[] = []
  if (candidate.tier) parts.push(`tier=${candidate.tier}`)
  if (candidate.tags.length > 0) parts.push(`tags=[${candidate.tags.join(', ')}]`)
  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}
