// The reserved top-level input keys, and the record of which schema instances
// a derivation produced.
//
// `references` and `name` are derived, never authored: the registry writes
// them from what a Pattern declares. To refuse what an author hand-wrote at
// either key while re-deriving what an earlier derivation placed there, it has
// to tell the two apart, and it does that by instance identity rather than by
// structure. Every derivation passes what it builds through markDerived, at the
// lowest producer, so the instance is recognised however it arrived — through
// a factory, through extendInputsWithReferences, or placed by a host itself.
// `.meta()` is not used for this: it writes to zod's global registry and into
// the JSON Schema output.
//
// A leaf module, importing nothing, so every producer and the registry can
// import it without a cycle. The set is weak, so marking an instance never
// keeps it alive.

/**
 * The top-level input keys only derivation may write. Nested keys are not reserved.
 *
 * Exported so a host that saves user-authored input schemas can refuse one
 * declaring either key when it is saved, rather than when it is registered.
 */
export const RESERVED_INPUT_KEYS = ['references', 'name'] as const

/** One of {@link RESERVED_INPUT_KEYS}. */
export type ReservedInputKey = (typeof RESERVED_INPUT_KEYS)[number]

const DERIVED = new WeakSet<object>()

/** Internal. Marks a schema instance as produced by a derivation; returns it. */
export function markDerived<T extends object>(schema: T): T {
  DERIVED.add(schema)
  return schema
}

/** Internal. True iff `schema` is an instance some derivation produced. */
export function isDerived(schema: unknown): boolean {
  return typeof schema === 'object' && schema !== null && DERIVED.has(schema)
}
