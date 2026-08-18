// Declarative helpers for authoring `Pattern.alternatives[*].appliesWhen`.
// Pure data constructors — no closures, no runtime state — so the resulting
// Alternative entries stay JSON-dumpable and diff-stable for cache keys and
// planner catalog inspection.

import type { ModelTag } from './model-tag'
import type {
  AlternativeAppliesWhen,
  Semantics,
} from './alternative'

/**
 * Match when the parent Pattern's capability cannot be served by any model
 * bearing every requested ModelTag. Typical use: "if no model has the
 * `identity-preserving` tag for `text-to-image`, fall back to a caption +
 * text-to-image meta-pattern".
 *
 * Pass no tags (empty) to match "no model at all serves this capability".
 */
export const whenCapabilityUnavailable = (
  ...requiredTags: readonly ModelTag[]
): AlternativeAppliesWhen => ({
  kind: 'capability-unavailable',
  requiredTags: requiredTags.length > 0 ? requiredTags : undefined,
})

/**
 * Match when the planner / user has signalled they want one or more
 * semantic dimensions preserved (via the conventional
 * `input.requiresSemantics: Semantics[]` field).
 */
export const whenPreservesRequired = (
  ...semantics: readonly Semantics[]
): AlternativeAppliesWhen => ({ kind: 'preserves-required', semantics })

/**
 * Match when BudgetGuard's remaining budget (cents) is below `threshold`.
 */
/**
 * Declaration-only in 0.1.0 — see `AlternativeAppliesWhen`'s 'budget-below'
 * arm: the default resolver does not evaluate budget.
 */
export const whenBudgetBelow = (
  threshold: number,
): AlternativeAppliesWhen => ({ kind: 'budget-below', threshold })

/**
 * Always applicable. Last-resort row. Use sparingly — a no-op `always`
 * alternative defeats proactive filtering.
 */
export const whenAlways: AlternativeAppliesWhen = { kind: 'always' }
