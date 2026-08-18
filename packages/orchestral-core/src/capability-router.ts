// CapabilityRouter interface — the host-owned binding between a
// (capability, tags, ctx) triple and a concrete model. Both the interface
// and a storage-agnostic default implementation
// (createDefaultCapabilityRouter) live in this package; a host either feeds
// the default its getModels / getCapabilityOrder seams or implements the
// interface directly. It sits beside the Pattern vocabulary (not in the
// runtime) because Alternative.appliesWhen['capability-unavailable'] needs
// to ask the router whether a capability has any satisfiable model.

import type { Capability } from './capability'
import type { ModelTag } from './model-tag'
import type {
  ModelCapability,
  ModelCapabilityRecord,
  ResolveContext,
} from './capability-model'
import type { UnavailabilityReason } from './alternative'

/**
 * Discriminated-union result for `checkSatisfiable`. Replaces an earlier
 * `{ satisfiable: boolean; candidates; reason? }` anti-pattern that allowed
 * a `{ satisfiable: true, reason: 'no-model' }` contradiction.
 *
 * Returns persisted records (no `call` adapter) because checkSatisfiable
 * is a pure inspection — caller hasn't asked to dispatch yet. Only
 * `resolve()` returns the runtime envelope.
 */
export type SatisfiableResult =
  | { ok: true; candidates: readonly ModelCapabilityRecord[] }
  | {
      ok: false
      reason: UnavailabilityReason
      candidates: readonly ModelCapabilityRecord[]
    }

/**
 * The router is the host-owned binding between a (capability, tags, ctx)
 * triple and a concrete model. It is the single point where a Pattern's
 * capability requirement gets joined to a provider implementation.
 *
 * In-Router retry: when a model call fails transiently, the runtime adds
 * the failed `provider:modelId` to `ResolveContext.excludeModel` and calls
 * `resolve` again. If no candidate remains the runtime throws
 * NO_MODEL_FOR_CAPABILITY and the resolver evaluates `Alternative` fallbacks.
 */
export interface CapabilityRouter {
  /**
   * O(1) proactive check used by the resolver. Returns the candidate list
   * along with the satisfiable verdict so planner catalog rendering and
   * Alternative `appliesWhen` evaluation can both use it.
   */
  checkSatisfiable(
    capability: Capability,
    requiredTags: readonly ModelTag[],
    ctx: ResolveContext,
  ): SatisfiableResult

  /**
   * Pick a concrete model. Throws NO_MODEL_FOR_CAPABILITY if no candidate
   * survives filtering — the runtime translates this into fallback
   * evaluation.
   */
  resolve(
    capability: Capability,
    requiredTags: readonly ModelTag[],
    ctx: ResolveContext,
  ): ModelCapability
}
