// derive-pattern-input.ts — capability-driven Pattern.input lift.
//
// Pure function — same inputs always produce the same outputs, order-stable,
// no side effects, NO provider knowledge and NO field names. The host stamps
// the fields it wants surfaced with `LIFT_MARKER`; this module reads only that
// marker, so the lift set is host-driven config, not coupling baked into this
// package.
//
// The function does TWO things:
//   1. Lift marked fields from per-model `providerOptions` schema into
//      Pattern.input TOP LEVEL (so the LLM sees the per-model constraint, e.g.
//      a fixed-count or enum, directly at top level).
//   2. REPLACE Pattern.input.providerOptions's loose `z.record(z.unknown())`
//      with a TYPED `z.object(remaining)` — where `remaining` is the model's
//      providerOptions schema minus the lifted fields. This fixes the case
//      where the LLM, seeing a bare `z.record`, has no clue how to fill
//      provider-specific fields — `z.record(z.unknown())` gives structured-
//      output generation zero structure to reason about.
//
// The derive function runs at catalog render time, under a contract that pins
// rendering order + JSON-Schema byte stability.

import { z, type ZodRawShape, type ZodTypeAny } from 'zod'

/**
 * Generic, provider-agnostic marker. A field schema carrying this property is
 * an ai-sdk top-level param the host wants lifted from providerOptions onto
 * Pattern.input. This module reads only the marker — it knows no ai-sdk field
 * names.
 * `Symbol.for` so the contract survives package duplication in node_modules.
 */
export const LIFT_MARKER = Symbol.for('orchestral.lift')

/** Host-injected-from-slot marker. Value is the binding payload `{ fromSlot }`.
 *  This module reads only its presence (field-name- and slot-agnostic) to keep
 *  the field out of the LLM-facing schema; the host reads the payload at
 *  dispatch. */
export const ASSET_MARKER = Symbol.for('orchestral.hostAsset')

/**
 * Derive the LLM-facing Pattern.input schema for a (Pattern, model) combo.
 *
 * Does two things:
 *   1. Lift the host-marked fields from providerOptionsSchema to
 *      Pattern.input top level. A field is lifted iff it carries `LIFT_MARKER`
 *      (stamped host-side) — this module names no fields and reads only the
 *      marker, so the lift set is host config, not coupling in this package.
 *   2. Replace Pattern.input.providerOptions (which is base
 *      `z.record(z.unknown()).optional()`) with TYPED `z.object(remaining).optional()`
 *      where `remaining` = providerOptionsSchema fields minus the lifted ones.
 *
 * The LLM consuming `find_pattern` output now sees concrete provider-specific
 * field names (e.g. a typed enum) instead of an opaque dict, which is what lets
 * structured-output generation fill provider-specific params.
 *
 * Pure function — runs at catalog render time.
 *
 * @param baseSchema             Pattern's static input schema.
 * @param providerOptionsSchema  ZodObject from `ModelCapability.providerOptions`
 *                               after host-side `jsonSchemaToZod` (undefined when
 *                               no schema declared — caller surfaces the Pattern
 *                               with the unlifted base schema; this function just
 *                               returns base unchanged for byte stability).
 * @returns Merged schema with lifted constraints + typed providerOptions.
 *          When providerOptionsSchema is undefined: returns baseSchema unchanged
 *          (referential identity for catalog byte stability).
 */
export function deriveLlmFacingInputSchema<T extends ZodRawShape>(
  baseSchema: z.ZodObject<T>,
  providerOptionsSchema: z.ZodObject<ZodRawShape> | undefined,
): z.ZodObject<ZodRawShape> {
  if (!providerOptionsSchema) {
    // Degraded path — return base unchanged. Pattern still surfaces via
    // find-pattern / always-load with the unlifted base schema; preserve
    // referential identity for byte stability.
    return baseSchema as z.ZodObject<ZodRawShape>
  }

  const optShape = providerOptionsSchema.shape

  // Partition providerOptions shape into lifted vs remaining by reading the
  // host-stamped LIFT_MARKER — this module knows no ai-sdk field names. Iterate
  // Object.keys(optShape) so both buckets inherit the ship-data declaration
  // order, which feeds zodToJsonSchema's property order: prerequisite for the
  // byte-stable always-load tool prefix / KV-cache.
  const hasLiftMarker = (s: ZodTypeAny): boolean =>
    (s as unknown as Record<symbol, unknown>)[LIFT_MARKER] === true

  // Host-injected-from-slot fields carry ASSET_MARKER. They are filled host-side
  // at dispatch from a resolved slot asset, so the LLM must never see them —
  // drop them from BOTH buckets. Only the marker's presence is read, never a
  // field or slot name, so this stays ai-sdk/provider-agnostic.
  const hasAssetMarker = (s: ZodTypeAny): boolean =>
    (s as unknown as Record<symbol, unknown>)[ASSET_MARKER] !== undefined

  const lifted: Record<string, ZodTypeAny> = {}
  const remaining: Record<string, ZodTypeAny> = {}
  for (const k of Object.keys(optShape)) {
    const field = (optShape as Record<string, ZodTypeAny>)[k]
    if (hasAssetMarker(field)) continue
    if (hasLiftMarker(field)) lifted[k] = field
    else remaining[k] = field
  }

  // Compose the LLM-facing schema:
  //   - omit the base's opaque providerOptions (z.record placeholder)
  //   - extend with lifted top-level fields (constraints override base)
  //   - extend with typed providerOptions = z.object(remaining)
  //     (omit if `remaining` is empty: a model whose providerOptions was
  //     fully LIFTED needs no leftover providerOptions field at all)
  //
  // Pattern factories no longer declare a `providerOptions` placeholder field,
  // so `.omit({providerOptions: true})` would throw "Unrecognized key" in zod
  // v4 strict mode. Only omit when the field actually exists on the base shape.
  const baseShape = (baseSchema as z.ZodObject<ZodRawShape>).shape
  const withoutPo: z.ZodObject<ZodRawShape> =
    'providerOptions' in baseShape
      ? (baseSchema as z.ZodObject<ZodRawShape>).omit(
          { providerOptions: true } as { providerOptions: true },
        )
      : (baseSchema as z.ZodObject<ZodRawShape>)

  let result: z.ZodObject<ZodRawShape> = withoutPo
  if (Object.keys(lifted).length > 0) {
    result = result.extend(lifted as ZodRawShape)
  }
  if (Object.keys(remaining).length > 0) {
    result = result.extend({
      providerOptions: z.object(remaining as ZodRawShape).optional(),
    } as ZodRawShape)
  }

  return result
}
