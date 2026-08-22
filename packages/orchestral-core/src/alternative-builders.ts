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
 * semantic dimensions preserved.
 *
 * The signal is the input field `requiresSemantics?: Semantics[]` — the
 * convention `AlternativeAppliesWhen` documents in ./alternative. A Pattern
 * that wants this row declares the field on its inputs, the caller fills it,
 * and the runtime reads it off `JobSpec.input` at dispatch; there is no other
 * wiring. @orchestral/runtime treats any overlap as a match: the row applies
 * when at least one of `semantics` is in what the caller filled, so list
 * every dimension the path is a good answer for. A dispatch with the field
 * absent (or not an array of strings) requires nothing and never matches.
 */
export const whenPreservesRequired = (
  ...semantics: readonly Semantics[]
): AlternativeAppliesWhen => ({ kind: 'preserves-required', semantics })

/**
 * Always applicable. Last-resort row. Use sparingly — a no-op `always`
 * alternative defeats proactive filtering.
 */
export const whenAlways: AlternativeAppliesWhen = { kind: 'always' }
