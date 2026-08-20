// Declarative cross-Pattern fallback paths. Data-only Alternative entries a
// runtime evaluates proactively (`appliesWhen`) before dispatching, and
// reactively cascades through when a chosen path fails.
//
// Declaring an alternative does not make it fire: whether a runtime redirects
// automatically is the runtime's policy, and @orchestral/runtime keeps it off
// by default (`InlineRuntimeInit.alternatives`), reporting the applicable paths
// on the failure instead. These types describe the paths; they do not promise
// one will be taken.

import type { ModelTag } from './model-tag'
import type { PatternId } from './foundational'

/**
 * Semantic dimensions an alternative path can preserve or lose. Used by
 * `appliesWhen: { kind: 'preserves-required' }` to express user / planner
 * quality constraints, and by `preserves` / `losses` to inform UI
 * degradation notices.
 *
 * The open `(string & {})` tail lets host code introduce private semantic
 * dimensions without modifying this package.
 */
export type Semantics =
  /** Subject preservation (IP-Adapter / InstantID / PuLID territory) */
  | 'subject-identity'
  /** Visual style preservation across edits */
  | 'style'
  /** Composition / framing preservation */
  | 'composition'
  /** Same character across multiple shots / a longer sequence */
  | 'character-consistency'
  /** TTS / dubbing alignment with mouth movements */
  | 'lipsync-accuracy'
  /** Smooth motion / continuity across video frames */
  | 'temporal-coherence'
  | (string & {})

/**
 * Why a capability cannot currently be satisfied by the router. Returned
 * inside `CapabilityRouter.checkSatisfiable` results so callers (planner
 * catalog builder, resolver) can surface the specific reason.
 */
export type UnavailabilityReason =
  /** No model in the user's catalog declares the requested capability. */
  | 'no-model-in-catalog'
  /**
   * Declared-but-not-enabled: models in the catalog declare the capability,
   * but the host's enablement list excludes every capable model (the user
   * never enabled one for this capability).
   */
  | 'not-enabled'
  /** Every candidate has been excluded via ResolveContext.excludeModel. */
  | 'all-excluded'
  /** Requested tier (fast / balanced / premium) has no candidates. */
  | 'tier-mismatch'
  /** No model bears every requested ModelTag. */
  | 'tag-mismatch'

/**
 * Condition under which a given Alternative becomes a candidate path during
 * resolution. Evaluated synchronously with no IO — the router consults catalog
 * metadata via `checkSatisfiable` plus input fields only.
 */
export type AlternativeAppliesWhen =
  /**
   * The parent Pattern's capability (= Pattern.id) has no satisfiable
   * model bearing `requiredTags`. The classic "user has no
   * identity-preserving image-to-image, fall back to caption → t2i".
   */
  | {
      kind: 'capability-unavailable'
      requiredTags?: readonly ModelTag[]
    }
  /**
   * Planner / user requested one or more semantic dimensions be preserved.
   * Pattern.inputs by convention exposes a
   * `requiresSemantics?: Semantics[]` field; the LLM populates it via Skill
   * guidance and the resolver compares against `semantics`.
   */
  | { kind: 'preserves-required'; semantics: readonly Semantics[] }
  /**
   * Always considered applicable. Useful as a last-resort fallback row
   * that runs whenever earlier paths fail.
   */
  | { kind: 'always' }

/**
 * A declarative cross-Pattern fallback entry attached to a Pattern.
 * Reads as "if {appliesWhen}, dispatch via {via.patternId} instead".
 *
 * Authoring contract:
 * - `id` unique within this Pattern's `alternatives` array (used in trace
 *   spans + lifecycle hooks).
 * - `description` shown to planner in `<available_patterns>` when this
 *   alternative is the active path.
 * - `appliesWhen` declarative; runtime evaluates synchronously, no IO.
 * - `via.mapInput` / `via.mapOutput` are imperative closures — the
 *   acknowledged escape hatch where pure-declarative breaks down (input
 *   shape transforms, prompt template assembly). Keep them pure
 *   (synchronous, deterministic, no IO).
 * - Declaration order in the parent `alternatives` array is the ranking.
 */
export interface Alternative<I = unknown, O = unknown> {
  /** Stable id; unique within the parent Pattern's `alternatives` array. */
  id: string
  /** Surfaced to planner / log when this alternative is the active path. */
  description: string
  /** Declarative match condition; runtime evaluates synchronously. */
  appliesWhen: AlternativeAppliesWhen
  /** Redirect target. `via.patternId` may point to an atomic or a Meta. */
  via: {
    patternId: PatternId
    /**
     * Transform parent input into the child Pattern's input. Pure /
     * synchronous / deterministic. Covers the `input` fields only —
     * host-injected context (providerOptions, asset context id) and the
     * parent's already-resolved assets are forwarded by the runtime and are
     * not this closure's to touch.
     *
     * Resolved assets travel under the *parent's* slot names, verbatim; there
     * is no slot renaming step. The target must therefore declare a
     * semantically compatible slot of the same name for every slot the parent
     * resolves, and slots the target does not declare simply go unused (say so
     * in `losses` when that costs the caller something — e.g. a dropped
     * `mask`).
     */
    mapInput: (parentInput: I) => unknown
    /** Transform child output back into the parent's declared output shape. */
    mapOutput: (childOutput: unknown) => O
  }
  /** Semantic dimensions retained through this path. */
  preserves?: readonly Semantics[]
  /** Semantic dimensions lost. Surfaced to user via degradation notice. */
  losses?: readonly Semantics[]
}
