// The default CapabilityRouter algorithm — the pure (capability, tags, ctx) →
// model selection logic, with zero storage / SDK coupling. A host injects two
// seams: `getModels` returns the wrapped runtime envelopes for all models that
// DECLARE a capability (the host owns persistence + the `call` adapter), and
// `getCapabilityOrder` supplies the per-capability enablement order.
// Everything else — the enablement gate, exclude / tag / tier filtering, ranked
// ordering, selection precedence, and diagnosis — lives here so any host (or a
// pure in-memory test) gets identical routing behaviour.

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
    const { ctx, enablementDefaulted } = this.effectiveCtx(cap, rawCtx)
    const candidates = this.listCandidates(cap, requiredTags, ctx)
    if (candidates.length === 0) {
      return {
        ok: false,
        reason: this.diagnoseReason(cap, requiredTags, ctx, enablementDefaulted),
        candidates,
      }
    }
    return { ok: true, candidates }
  }

  resolve(
    cap: Capability,
    requiredTags: readonly ModelTag[],
    rawCtx: ResolveContext,
  ): ModelCapability {
    const { ctx, enablementDefaulted } = this.effectiveCtx(cap, rawCtx)
    const candidates = this.listCandidates(cap, requiredTags, ctx)
    if (candidates.length === 0) {
      const reason = this.diagnoseReason(cap, requiredTags, ctx, enablementDefaulted)
      throw new NoModelForCapabilityError(cap, requiredTags, reason)
    }
    // Pinned model wins outright if explicitly requested.
    if (ctx.pinnedModel) {
      const pinned = candidates.find(
        (c) => `${c.provider}:${c.modelId}` === ctx.pinnedModel,
      )
      if (!pinned) {
        // Diagnosis travels on the error, not to stdout — a library has no
        // business writing to the host's console. `excludedByRetry`
        // distinguishes "excluded after a prior dispatch failure"
        // (ResolveContext.excludeModel hit) from "never a candidate"
        // (capability / tag rejection); the two have very different fixes.
        throw new ModelExcludedError(ctx.pinnedModel, {
          capability: cap,
          requiredTags,
          excludedByRetry: (ctx.excludeModel ?? []).includes(ctx.pinnedModel),
          excludeModel: ctx.excludeModel ?? [],
          candidates: candidates.map((c) => `${c.provider}:${c.modelId}`),
        })
      }
      return pinned
    }
    // Provider preference next.
    if (ctx.preferProvider) {
      const prefer = candidates.find((c) => c.provider === ctx.preferProvider)
      if (prefer) return prefer
    }
    // Tier filter (best-effort — if no tier match, fall through).
    if (ctx.tier) {
      const tierMatch = candidates.find((c) => c.tier === ctx.tier)
      if (tierMatch) return tierMatch
    }
    // Declared order is the default ranking (TODO: latency/cost rank).
    return candidates[0]!
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Enablement gate. An explicit pin is enablement by selection and an
   * explicit rankedModels is caller-owned ordering — both bypass the stored
   * order. Otherwise `deps.getCapabilityOrder(cap)` becomes the ranking: an
   * empty array reads as no route, so a host whose enablement store is still
   * empty must configure it before dispatching. Computed ONCE per public
   * entry (resolve / checkSatisfiable); the `enablementDefaulted` flag tells
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

  /**
   * In-memory filtering over the host-declared candidate set. `getModels`
   * returns every model declaring the capability (with `call` wired in); the
   * exclude / tag filters + ranked ordering run here. `ctx` is the EFFECTIVE
   * context — the public entry already ran effectiveCtx.
   */
  private listCandidates(
    cap: Capability,
    requiredTags: readonly ModelTag[],
    ctx: ResolveContext,
  ): readonly ModelCapability[] {
    const out: ModelCapability[] = []
    for (const record of this.deps.getModels(cap)) {
      if (!record.capabilities.includes(cap)) continue
      // No adapter-compatibility pre-filtering here by design. Deciding at
      // expose time whether a provider is "runnable" is a model-centric
      // guess that wrongly drops records — most visibly for providers that
      // proxy many upstream models under one name. Dispatch fails loudly
      // instead: the host's `call` adapter throws and the caller surfaces it.
      if (ctx.excludeProvider?.includes(record.provider)) continue
      const fullId = `${record.provider}:${record.modelId}`
      if (ctx.excludeModel?.includes(fullId)) continue
      if (requiredTags.length > 0) {
        const hasAll = requiredTags.every((t) => record.tags.includes(t))
        if (!hasAll) continue
      }
      out.push(record)
    }
    return applyRankedOrder(out, ctx)
  }

  /**
   * Step-by-step elimination to identify the narrowest reason no candidate
   * survived. Used by checkSatisfiable() so the planner / Alternative
   * evaluator can pick the right fallback path. `ctx` is the EFFECTIVE
   * context; `enablementDefaulted` says its ranking came from the stored
   * enablement order rather than the caller.
   */
  private diagnoseReason(
    cap: Capability,
    requiredTags: readonly ModelTag[],
    ctx: ResolveContext,
    enablementDefaulted: boolean,
  ): UnavailabilityReason {
    const declared = this.deps
      .getModels(cap)
      .filter((r) => r.capabilities.includes(cap))
    const all = applyRankedOrder(declared, ctx)

    if (all.length === 0) {
      // Capable rows exist but the ENABLEMENT DEFAULT (the stored
      // getCapabilityOrder ranking, not a caller-supplied one) filtered them
      // to zero: declared-but-not-enabled. A caller-owned rankedModels
      // filtering to zero is the caller's ordering, not the enablement gate,
      // so it reports no-model-in-catalog instead.
      if (declared.length > 0 && enablementDefaulted) return 'not-enabled'
      return 'no-model-in-catalog'
    }

    const afterExcl = all.filter((r) => {
      if (ctx.excludeProvider?.includes(r.provider)) return false
      const fullId = `${r.provider}:${r.modelId}`
      if (ctx.excludeModel?.includes(fullId)) return false
      return true
    })
    if (afterExcl.length === 0) return 'all-excluded'

    if (requiredTags.length > 0) {
      const afterTags = afterExcl.filter((r) =>
        requiredTags.every((t) => r.tags.includes(t)),
      )
      if (afterTags.length === 0) return 'tag-mismatch'
    }

    if (ctx.tier) {
      const afterTier = afterExcl.filter((r) => r.tier === ctx.tier)
      if (afterTier.length === 0) return 'tier-mismatch'
    }

    return 'no-model-in-catalog'
  }
}

// ── Ranking ────────────────────────────────────────────────────────────────

/**
 * Restrict + order candidates by `ctx.rankedModels` (caller-supplied, or the
 * stored enablement order `effectiveCtx` injected). `undefined` = unrestricted —
 * after effectiveCtx that only happens on the explicit-pin path; an empty array
 * = no route. Exclusion / tag / tier filtering has already run, so this only
 * intersects with the ranked set and sorts by its index (0 = default). The
 * runtime's excludeModel retry then walks the order: the failed top model is
 * excluded on re-resolve, surfacing the next ranked one.
 */
function applyRankedOrder<T extends ModelCapabilityRecord>(
  records: readonly T[],
  ctx: ResolveContext,
): readonly T[] {
  const ranked = ctx.rankedModels
  if (!ranked) return records
  const rank = new Map(ranked.map((id, i) => [id, i] as const))
  return records
    .filter((r) => rank.has(`${r.provider}:${r.modelId}`))
    .sort(
      (a, b) =>
        rank.get(`${a.provider}:${a.modelId}`)! -
        rank.get(`${b.provider}:${b.modelId}`)!,
    )
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
