import { z } from 'zod'
import type { AssetNeed } from './asset-index.types'
import { deriveReferencesSchema } from './derive-references-schema'
import type { ZodSchema } from './foundational'

/**
 * SSOT injection: extend a Pattern's tool input schema with the
 * assetNeeds-derived `references` field. AtomicPattern's constructor calls
 * this; MetaPattern factories (plain object literals, no ctor to hook) call
 * it directly at construction. Dispatch validates the extended BASE schema;
 * find_pattern renders an LLM-facing derivation of it (providerOptions
 * lift) through which the references field passes byte-identically — and
 * dispatch-pattern.ts applies .passthrough() at the TOP level only, so
 * nested strictness survives. Schema-shown and schema-enforced agree on
 * references.
 *
 * Returns `inputs` unchanged (same reference) when the Pattern declares no
 * asset slots. The derived field REPLACES any hand-written `references`
 * (derived wins) — in place, keeping that key's original position; only an
 * absent key is appended after the declared shape. Deterministic —
 * byte-stable for identical (inputs, assetNeeds). Object-level
 * describe/meta on the base survives (re-attached after safeExtend, minus
 * the registry id).
 * Throws EXTEND_REFERENCES_UNSUPPORTED_INPUTS when asset slots are
 * declared but inputs is not a ZodObject (construction-time author error —
 * fail fast rather than silently skipping the injection).
 */
export function extendInputsWithReferences<I>(
  patternId: string,
  inputs: ZodSchema<I>,
  assetNeeds: ReadonlyArray<AssetNeed> | undefined,
): ZodSchema<I> {
  const derivedRefs = deriveReferencesSchema(assetNeeds)
  if (!derivedRefs) return inputs
  if (!(inputs instanceof z.ZodObject)) {
    // Construction-time author error — fail fast, same as
    // DERIVE_REFERENCES_DUPLICATE_SLOT. Without the throw, injection is
    // silently skipped and dispatch parses the schema as-is (.passthrough()
    // is gated on the method existing — unions don't have it); the matched
    // member object's default strip mode then drops `references` from
    // parsedInput, blinding the UNKNOWN_SLOT resolution net while the
    // frozen catalog copy promises "unknown slot keys are rejected".
    throw new Error(
      `EXTEND_REFERENCES_UNSUPPORTED_INPUTS: ${patternId} — assetNeeds declared but tool inputs is not a ZodObject; define the input schema with z.object()`,
    )
  }
  // safeExtend, not extend: .extend() throws ("Cannot overwrite keys on
  // object schemas containing refinements") when the base has object-level
  // checks AND hand-writes a references key — exactly the derived-wins
  // path. safeExtend does the same replacement, keeps the checks, and
  // renders byte-identically to extend on the no-conflict path.
  const extended = inputs.safeExtend({ references: derivedRefs })
  // safeExtend drops the base's object-level metadata (registry-backed
  // .describe()/.meta()). Re-attach it minus `id` — the id names the BASE
  // schema; a duplicate id silently shadows the base in the registry's
  // _idmap and makes z.toJSONSchema throw ("Duplicate schema id") when both
  // schemas appear in one conversion tree (zod 4.4.3).
  const meta = { ...(inputs.meta() ?? {}) }
  delete meta.id
  // Cast: I is the base input type; the extended schema parses {…I,
  // references?} at runtime. Dispatch reads parsed input as
  // Record<string, unknown>, so typed callers aren't relying on I
  // including references — the narrower static type is a safe lie here.
  // extended carries no own metadata (safeExtend produces a parentless
  // clone), so .meta()'s overwrite-not-merge semantics can't drop anything.
  return (
    Object.keys(meta).length > 0 ? extended.meta(meta) : extended
  ) as unknown as ZodSchema<I>
}
