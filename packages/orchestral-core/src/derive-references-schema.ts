// Single-source-of-truth derivation: the LLM-facing `references` schema is
// DERIVED from Pattern.assetNeeds — the single hand-written source. Pure
// function: zero IO, no provider/model knowledge (host filters the needs list
// per model later — declare-full then filter-down), byte-stable output for
// identical input so the KV-cache prefix stays stable.
//
// Shape rules:
//   single → z.string()            (a single slot rejects arrays at parse)
//   array  → z.union([z.string(), z.array(z.string())])
//   every key .optional()          (omitting a REQUIRED slot triggers the
//                                   host default rule — required-ness must NOT
//                                   be enforced by zod, only documented)
//   strictObject                   (unknown slot keys fail dispatch validation
//                                   with field-pathed zod issues)
//
// COPY IS FROZEN. These strings enter the byte-stable always-load tool prefix;
// editing a single character invalidates every in-flight KV-cache across all
// patterns at once. Change only with a deliberate release decision.
//
// The copy speaks of a "context", never a chat session: handles are minted per
// asset-resolution context (a conversation, an agent run's own ledger, a batch
// job), and the same handle can name different assets in two of them.
//
// Compile-time twin: DerivedReferences<N> in asset-index.types.ts mirrors
// these shape rules at the type level. Keep both in lockstep — any change
// to the single/array value mapping here must be reflected there.
import { z } from 'zod'
import type { AssetNeed } from './asset-index.types'

const REFERENCES_DESCRIBE =
  'Reference assets by their handle (e.g. "image_2"), keyed by slot. ' +
  'Pick handles from the asset list provided in context. Never pass raw asset ids or URLs.'

function slotDescribe(need: AssetNeed): string {
  const desc = need.description ? `${need.description} ` : ''
  if (!need.required) {
    return `${desc}Optional — provide only when needed; omitting means none (never auto-filled).`
  }
  return need.cardinality === 'array'
    ? `${desc}Omit to auto-use the most recent ${need.modality} batch in this context.`
    : `${desc}Omit to auto-use the most recent ${need.modality} in this context.`
}

/**
 * Derive the typed `references` field for a Pattern's input schema. Returns
 * undefined when the Pattern declares no asset slots (no field is injected —
 * text-generation etc. keep a references-free schema).
 *
 * @alpha Test seam — production code reaches this through
 * `extendInputsWithReferences`; this raw form is exported so invariant
 * tests can byte-compare the derived schema. Not a stable public API.
 */
export function deriveReferencesSchema(
  assetNeeds: ReadonlyArray<AssetNeed> | undefined,
): z.ZodOptional<z.ZodObject<z.ZodRawShape>> | undefined {
  if (!assetNeeds || assetNeeds.length === 0) return undefined
  const shape: Record<string, z.ZodTypeAny> = {}
  const seen = new Set<string>()
  for (const need of assetNeeds) {
    if (seen.has(need.slot)) {
      throw new Error(
        `DERIVE_REFERENCES_DUPLICATE_SLOT: "${need.slot}" appears more than once in assetNeeds`,
      )
    }
    seen.add(need.slot)
    const value =
      need.cardinality === 'single'
        ? z.string()
        : z.union([z.string(), z.array(z.string())])
    shape[need.slot] = value.optional().describe(slotDescribe(need))
  }
  return z.strictObject(shape).describe(REFERENCES_DESCRIBE).optional()
}
