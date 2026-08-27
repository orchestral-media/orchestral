// The default CapabilityRouter algorithm — the pure (capability, tags, ctx) →
// model selection logic, with zero storage / SDK coupling. A host injects two
// seams: `getModels` returns the wrapped runtime envelopes for all models that
// DECLARE a capability (the host owns persistence + the `call` adapter), and
// `getCapabilityOrder` supplies the per-capability enablement order.
// Everything else — the enablement gate, exclude / tag / tier filtering, ranked
// ordering, selection precedence, and diagnosis — lives here so any host (or a
// pure in-memory test) gets identical routing behaviour. `explain` reports that
// same machinery instead of re-deriving it: one screening pass feeds the
// candidate list, the diagnosis and the dump alike.

import type { Capability } from './capability'
import type {
  ModelCapability,
  ModelCapabilityRecord,
  ResolveContext,
} from './capability-model'
import type {
  CapabilityRouter,
  SatisfiableResult,
} from './capability-router'
import type { ModelTag } from './model-tag'
import type { UnavailabilityReason } from './alternative'
import type {
  RoutingCandidate,
  RoutingDropStage,
  RoutingExplanation,
  RoutingOutcome,
  RoutingSelectionRule,
} from './routing-explanation'

export interface DefaultCapabilityRouterDeps {
  /**
   * Return the wrapped runtime envelopes for EVERY model that declares `cap`
   * (i.e. `capabilities.includes(cap)`), with the host's `call` adapter already
   * wired in. The default router does NOT construct `call` and never touches a
   * provider SDK — it only reads the record fields (`provider` / `modelId` /
   * `tags` / `tier` / `capabilities`) to filter and rank.
   *
   * Semantics: do NOT pre-filter on exclude / tag / tier / ranked here. That
   * filtering belongs to this router; pre-filtering would defeat
   * `diagnoseReason`'s step-by-step elimination (it needs the full declared
   * set to tell `tag-mismatch` from `all-excluded`).
   * DESIGN: get-models-no-prefilter
   */
  getModels(cap: Capability): readonly ModelCapability[]
  /**
   * The per-capability enablement order — index 0 = default, the rest =
   * fallback order. `[]` means "declared but not enabled" — nothing routes
   * until the host's enablement store has an entry. Omitting this dep (or
   * returning `undefined`) disables the enablement-default gate entirely:
   * when the caller neither pins nor ranks, candidates stay unrestricted
   * instead of no-routing.
   */
  getCapabilityOrder?(cap: Capability): readonly string[] | undefined
}

export function createDefaultCapabilityRouter(
  deps: DefaultCapabilityRouterDeps,
): CapabilityRouter {
  return new DefaultCapabilityRouter(deps)
}

class DefaultCapabilityRouter implements CapabilityRouter {
  private readonly deps: DefaultCapabilityRouterDeps

  constructor(deps: DefaultCapabilityRouterDeps) {
    this.deps = deps
  }

  checkSatisfiable(
    cap: Capability,
    requiredTags: readonly ModelTag[],
    rawCtx: ResolveContext,
  ): SatisfiableResult {
    const screening = this.screen(cap, requiredTags, rawCtx)
    const { candidates } = screening
    if (candidates.length === 0) {
      return { ok: false, reason: diagnoseReason(screening), candidates }
    }
    return { ok: true, candidates }
  }

  resolve(
    cap: Capability,
    requiredTags: readonly ModelTag[],
    rawCtx: ResolveContext,
  ): ModelCapability {
    const screening = this.screen(cap, requiredTags, rawCtx)
    const { ctx, candidates } = screening
    if (candidates.length === 0) {
      throw new NoModelForCapabilityError(
        cap,
        requiredTags,
        diagnoseReason(screening),
      )
    }
    const selection = selectCandidate(candidates, ctx)
    if (selection.kind === 'pin-excluded') {
      // Diagnosis travels on the error, not to a log — a library has no
      // business writing to the host's console, and nothing in this package
      // does: what cannot ride on an error or a JobEvent goes through the
      // host-injectable `DiagnosticsLogger` (./logger). `excludedByRetry`
      // distinguishes "excluded after a prior dispatch failure"
      // (ResolveContext.excludeModel hit) from "never a candidate"
      // (capability / tag rejection); the two have very different fixes.
      throw new ModelExcludedError(selection.pinnedModel, {
        capability: cap,
        requiredTags,
        excludedByRetry: selection.excludedByRetry,
        excludeModel: ctx.excludeModel ?? [],
        candidates: candidates.map(fullId),
      })
    }
    return selection.record
  }

  explain(
    cap: Capability,
    requiredTags: readonly ModelTag[] = [],
    rawCtx: ResolveContext = {},
  ): RoutingExplanation {
    const screening = this.screen(cap, requiredTags, rawCtx)
    const { ctx, enablementDefaulted, screened, candidates } = screening
    return {
      capability: cap,
      requiredTags,
      context: ctx,
      enablementDefaulted,
      satisfiable: candidates.length > 0,
      candidates: screened.map(toRoutingCandidate),
      order: candidates.map(fullId),
      outcome:
        candidates.length === 0
          ? { kind: 'no-candidate', reason: diagnoseReason(screening) }
          : toRoutingOutcome(selectCandidate(candidates, ctx)),
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * The one pass every public entry runs: resolve the effective context, ask
   * the host for the declared models, and screen each one. `resolve`,
   * `checkSatisfiable` and `explain` differ only in what they read off the
   * result — the filters themselves exist once, so a diagnosis can never
   * disagree with the candidate list it explains.
   */
  private screen(
    cap: Capability,
    requiredTags: readonly ModelTag[],
    rawCtx: ResolveContext,
  ): Screening {
    const { ctx, enablementDefaulted } = this.effectiveCtx(cap, rawCtx)
    const rank = rankIndex(ctx)
    // No adapter-compatibility pre-filtering here by design. Deciding at
    // expose time whether a provider is "runnable" is a model-centric guess
    // that wrongly drops records — most visibly for providers that proxy many
    // upstream models under one name. Dispatch fails loudly instead: the
    // host's `call` adapter throws and the caller surfaces it.
    // DESIGN: no-adapter-prescreen
    const screened = this.deps.getModels(cap).map((record) => ({
      record,
      droppedBy: dropStageFor(
        record,
        cap,
        requiredTags,
        ctx,
        rank,
        enablementDefaulted,
      ),
    }))
    return {
      ctx,
      requiredTags,
      enablementDefaulted,
      screened,
      candidates: keptInOrder(screened, rank),
    }
  }

  /**
   * Enablement gate. An explicit pin is enablement by selection and an
   * explicit rankedModels is caller-owned ordering — both bypass the stored
   * order. Otherwise `deps.getCapabilityOrder(cap)` becomes the ranking: an
   * empty array reads as no route, so a host whose enablement store is still
   * empty must configure it before dispatching. Computed ONCE per public
   * entry, inside `screen()`; the `enablementDefaulted` flag tells
   * `diagnoseReason` the ranking came from the enablement default, so a
   * zero-candidate result reads 'not-enabled' rather than the caller's
   * ordering problem. Pin check is truthy on purpose: an empty-string pin
   * must not bypass the gate (it could never match in resolve()'s pin block).
   *
   * When `deps.getCapabilityOrder` is absent the gate is disabled — an
   * un-pinned / un-ranked caller stays unrestricted (`enablementDefaulted`
   * false), so `diagnoseReason` never reports 'not-enabled'.
   */
  private effectiveCtx(
    cap: Capability,
    ctx: ResolveContext,
  ): { ctx: ResolveContext; enablementDefaulted: boolean } {
    if (ctx.pinnedModel || ctx.rankedModels !== undefined) {
      return { ctx, enablementDefaulted: false }
    }
    const order = this.deps.getCapabilityOrder?.(cap)
    if (order === undefined) {
      return { ctx, enablementDefaulted: false }
    }
    return {
      ctx: { ...ctx, rankedModels: order },
      enablementDefaulted: true,
    }
  }
}

// ── Screening ──────────────────────────────────────────────────────────────

interface ScreenedModel {
  record: ModelCapability
  /** `undefined` = survived every filter. */
  droppedBy?: RoutingDropStage
}

/** One screening pass, shared by resolve / checkSatisfiable / explain. */
interface Screening {
  /** EFFECTIVE context — effectiveCtx has already run. */
  ctx: ResolveContext
  requiredTags: readonly ModelTag[]
  enablementDefaulted: boolean
  /** Every record getModels returned, in the order it returned them. */
  screened: readonly ScreenedModel[]
  /** Survivors in resolution order. */
  candidates: readonly ModelCapability[]
}

/**
 * The first filter that rejects `record`, or `undefined` if it survives.
 *
 * Order matters only for ATTRIBUTION (which stage gets the blame, and hence
 * which reason `diagnoseReason` narrows to) — the surviving set is an
 * intersection and is order-independent. Ranking is checked first so that a
 * model the host never enabled reports `not-enabled` rather than whichever
 * later filter also happened to reject it.
 */
function dropStageFor(
  record: ModelCapabilityRecord,
  cap: Capability,
  requiredTags: readonly ModelTag[],
  ctx: ResolveContext,
  rank: ReadonlyMap<string, number> | undefined,
  enablementDefaulted: boolean,
): RoutingDropStage | undefined {
  if (!record.capabilities.includes(cap)) return 'capability-not-declared'
  const id = fullId(record)
  // `rank` undefined = unrestricted; after effectiveCtx that only happens on
  // the explicit-pin path or with no enablement gate wired in.
  if (rank && !rank.has(id)) {
    return enablementDefaulted ? 'not-enabled' : 'not-ranked'
  }
  if (ctx.excludeProvider?.includes(record.provider)) return 'excluded-provider'
  if (ctx.excludeModel?.includes(id)) return 'excluded-model'
  if (
    requiredTags.length > 0 &&
    !requiredTags.every((t) => record.tags.includes(t))
  ) {
    return 'tag-mismatch'
  }
  return undefined
}

/**
 * Survivors ordered by `ctx.rankedModels` index (0 = default), or left in
 * declared order when no ranking applies. The runtime's model fallback walk
 * follows this order: a model the dispatch gives up on is excluded on
 * re-resolve, surfacing the next one.
 */
function keptInOrder(
  screened: readonly ScreenedModel[],
  rank: ReadonlyMap<string, number> | undefined,
): readonly ModelCapability[] {
  const kept = screened
    .filter((s) => s.droppedBy === undefined)
    .map((s) => s.record)
  if (!rank) return kept
  return kept.sort((a, b) => rank.get(fullId(a))! - rank.get(fullId(b))!)
}

function rankIndex(
  ctx: ResolveContext,
): ReadonlyMap<string, number> | undefined {
  const ranked = ctx.rankedModels
  if (!ranked) return undefined
  return new Map(ranked.map((id, i) => [id, i] as const))
}

/**
 * Step-by-step elimination to identify the narrowest reason no candidate
 * survived — read off the screening verdicts, in the same stage order
 * `dropStageFor` applied them. The planner / Alternative evaluator picks its
 * fallback path from this.
 */
function diagnoseReason(screening: Screening): UnavailabilityReason {
  const { requiredTags, enablementDefaulted, screened } = screening
  const survived = (
    stages: readonly RoutingDropStage[],
  ): readonly ScreenedModel[] =>
    screened.filter(
      (s) => s.droppedBy === undefined || !stages.includes(s.droppedBy),
    )

  const declared = survived(['capability-not-declared'])
  if (declared.length === 0) return 'no-model-in-catalog'

  // Capable rows exist but the ENABLEMENT DEFAULT (the stored
  // getCapabilityOrder ranking, not a caller-supplied one) filtered them to
  // zero: declared-but-not-enabled. A caller-owned rankedModels filtering to
  // zero is the caller's ordering, not the enablement gate, so it reports
  // no-model-in-catalog instead.
  const afterRank = survived([
    'capability-not-declared',
    'not-enabled',
    'not-ranked',
  ])
  if (afterRank.length === 0) {
    return enablementDefaulted ? 'not-enabled' : 'no-model-in-catalog'
  }

  const afterExcl = survived([
    'capability-not-declared',
    'not-enabled',
    'not-ranked',
    'excluded-provider',
    'excluded-model',
  ])
  if (afterExcl.length === 0) return 'all-excluded'

  if (
    requiredTags.length > 0 &&
    afterExcl.every((s) => s.droppedBy === 'tag-mismatch')
  ) {
    return 'tag-mismatch'
  }

  // No tier branch here on purpose. Tier biases selection and never eliminates
  // a candidate (see selectCandidate), so by this point an empty candidate set
  // was emptied by something else — reporting 'tier-mismatch' would name the
  // one filter that did not do it. `UnavailabilityReason` keeps the member for
  // routers that do treat tier as a hard filter.
  return 'no-model-in-catalog'
}

// ── Selection ──────────────────────────────────────────────────────────────

type Selection =
  | { kind: 'selected'; record: ModelCapability; by: RoutingSelectionRule }
  | { kind: 'pin-excluded'; pinnedModel: string; excludedByRetry: boolean }

/**
 * `resolve`'s precedence over a NON-EMPTY candidate list, factored out so
 * `explain` reports the rule that would fire rather than re-deriving it.
 */
function selectCandidate(
  candidates: readonly ModelCapability[],
  ctx: ResolveContext,
): Selection {
  // Pinned model wins outright if explicitly requested.
  if (ctx.pinnedModel) {
    const pinned = candidates.find((c) => fullId(c) === ctx.pinnedModel)
    if (!pinned) {
      return {
        kind: 'pin-excluded',
        pinnedModel: ctx.pinnedModel,
        excludedByRetry: (ctx.excludeModel ?? []).includes(ctx.pinnedModel),
      }
    }
    return { kind: 'selected', record: pinned, by: 'pinned' }
  }
  // Provider preference next.
  if (ctx.preferProvider) {
    const prefer = candidates.find((c) => c.provider === ctx.preferProvider)
    if (prefer) {
      return { kind: 'selected', record: prefer, by: 'preferred-provider' }
    }
  }
  // Tier filter (best-effort — if no tier match, fall through).
  if (ctx.tier) {
    const tierMatch = candidates.find((c) => c.tier === ctx.tier)
    if (tierMatch) return { kind: 'selected', record: tierMatch, by: 'tier' }
  }
  // Declared order is the default ranking.
  return { kind: 'selected', record: candidates[0]!, by: 'first-candidate' }
}

// ── Explanation mapping ────────────────────────────────────────────────────

function toRoutingCandidate(screened: ScreenedModel): RoutingCandidate {
  const { record, droppedBy } = screened
  const base = {
    model: fullId(record),
    provider: record.provider,
    modelId: record.modelId,
    tags: record.tags,
    tier: record.tier,
  }
  return droppedBy === undefined
    ? { ...base, kept: true }
    : { ...base, kept: false, droppedBy }
}

function toRoutingOutcome(selection: Selection): RoutingOutcome {
  return selection.kind === 'selected'
    ? { kind: 'selected', model: fullId(selection.record), by: selection.by }
    : {
        kind: 'pin-excluded',
        pinnedModel: selection.pinnedModel,
        excludedByRetry: selection.excludedByRetry,
      }
}

function fullId(record: ModelCapabilityRecord): string {
  return `${record.provider}:${record.modelId}`
}

// ── Errors ───────────────────────────────────────────────────────────────

export class NoModelForCapabilityError extends Error {
  readonly code = 'NO_MODEL_FOR_CAPABILITY'
  /**
   * `remedy` replaces the default host-neutral remedy clause (which names
   * the getModels / getCapabilityOrder seams). A host that wants its own
   * user-facing guidance rebuilds the error with this parameter instead of
   * string-surgery on `message` — one format source, no doubled remedies.
   */
  constructor(
    public cap: Capability,
    public requiredTags: readonly ModelTag[],
    public reason: UnavailabilityReason,
    remedy?: string,
  ) {
    super(
      `NO_MODEL_FOR_CAPABILITY: ${cap}${
        requiredTags.length > 0 ? ` tags=[${requiredTags.join(', ')}]` : ''
      } reason=${reason}${
        remedy ??
        (reason === 'no-model-in-catalog'
          ? ' — no registered model serves this capability; add one to your getModels source'
          : reason === 'not-enabled'
            ? ' — capability is declared on registered models but not enabled; add it to your getCapabilityOrder enablement source'
            : '')
      }`,
    )
  }
}

export class ModelExcludedError extends Error {
  readonly code = 'MODEL_EXCLUDED'
  /**
   * @param diagnostic Why the pin could not be honoured — carried on the error
   * so the caller can log or surface it. The router itself never writes to
   * stdout. `excludedByRetry` says the pin was dropped by
   * `ResolveContext.excludeModel` (a prior dispatch failure) rather than
   * never having been a candidate; `candidates` lists what did survive.
   */
  constructor(
    public modelStr: string,
    public diagnostic?: {
      capability: Capability
      requiredTags: readonly ModelTag[]
      excludedByRetry: boolean
      excludeModel: readonly string[]
      candidates: readonly string[]
    },
  ) {
    // Bare message; upstream `${err.code}: ${err.message}` wrappers add the
    // 'MODEL_EXCLUDED:' prefix. Self-prefixing here causes ugly double
    // prefix in surfaced error strings.
    super(modelStr)
  }
}
