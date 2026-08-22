// Shared dispatch-output envelope shapes.
//
// Every atomic Pattern output re-declared an identical cost / latencyMs / model
// / provider block plus a produced-asset element shape; nothing enforced that
// they stayed in sync. These composable *raw shapes* (plain objects of zod
// types, meant to be spread into `z.object({ ... })`) are the one source of
// truth for that envelope so a generic consumer — a cost meter, an asset picker
// — can rely on the fields being present and identically typed everywhere.
//
// `cost` is host-reported and library-unvalidated: the adapter behind
// `ModelCapability.call` fills it in after the fact, and nothing here checks the
// figure against a price list. It is nullable for exactly that reason — `null`
// means "this adapter did not report a cost", which is a different fact from
// `0` ("this call was free"). An adapter that does not know the price must say
// null, never 0; a meta that sums sub-steps must propagate null rather than
// hand back a partial total that reads as a confident small number.
//
// They are raw shapes rather than assembled `z.object`s on purpose: a Pattern
// output carries domain fields alongside the envelope, and spreading lets each
// Pattern keep chaining `.describe()` / extra constraints on individual fields
// where its wording legitimately differs (see `metaEnvelopeShape`).

import { z } from 'zod'

import { assetIdField, boundedText, urlField } from './output-fields'

/**
 * The dispatch envelope every atomic Pattern output carries. Spread into the
 * output `z.object({ ... })`. The four fields are byte-identical across all ten
 * atomics today (same types, same optionality, same `.describe()` text), so the
 * descriptions live here — a Pattern that ever needs different wording can
 * re-`.describe()` the spread field locally.
 *
 * The two string fields carry explicit upper bounds from the bounded
 * output-field vocabulary (output-fields.ts). They have to: `auditOutputsSchema`
 * runs over every registered Pattern's outputs schema, and this shape is spread
 * into all ten of them — a bare `z.string()` here made OUTPUTS_UNBOUNDED_FIELDS
 * fire on every pattern at every boot, which is the same as the lint not
 * existing.
 */
export const dispatchEnvelopeShape = {
  cost: z
    .number()
    .min(0)
    .nullable()
    .describe('USD cost charged for this call, or null when the adapter did not report one.'),
  latencyMs: z.number().int().min(0).describe('Wall-clock API latency.'),
  model: boundedText(256).describe('Resolved provider:modelId.'),
  provider: boundedText(128),
} as const

/**
 * The meta envelope every meta Pattern output must carry, in addition to its
 * domain fields: `cost` = aggregated USD across sub-steps, or `null` when any
 * sub-step left its cost unreported (a partial sum would read as a confident
 * total — `sumCosts` in `@orchestral/patterns` applies that rule); `latencyMs`
 * = measured compose wall time. Deliberately a subset of
 * `dispatchEnvelopeShape` — a meta spans many models, so it carries no `model` /
 * `provider`. Both are `>= 0` like the dispatch envelope (`cost` when non-null);
 * a meta re-chains only the extra constraints it needs (`.describe()` wording,
 * `latencyMs.int()`). A bare re-chained `.min(0)` merges harmlessly, but note
 * `latencyMs` must re-apply `.min(0)` *after* `.int()` — zod v4's `.int()`
 * resets the numeric floor to the safe-integer minimum, discarding the spread's
 * `.min(0)`.
 */
export const metaEnvelopeShape = {
  cost: z.number().min(0).nullable(),
  latencyMs: z.number().min(0),
} as const

/** Modality of a produced media asset. */
export type ProducedAssetModality = 'image' | 'audio' | 'video'

/**
 * Raw shape for one element of a Pattern's produced `assets[]` — the real
 * `assetId`, the media `modality` literal, an optional public `url`, and an
 * optional per-asset `cost`. Build the element with
 * `z.object(producedAssetShape('image'))`; the enclosing array keeps its own
 * per-Pattern `.describe()`.
 */
export function producedAssetShape<M extends ProducedAssetModality>(modality: M) {
  return {
    assetId: assetIdField(),
    modality: z.literal(modality),
    // `.url()` keeps the format check the bounded vocabulary deliberately omits
    // (urlField is scheme-agnostic); the `.max()` is what keeps a provider that
    // hands back a data: URI from landing an unbounded blob in this field.
    url: urlField().url().optional(),
    cost: z.number().min(0).optional(),
  } as const
}
