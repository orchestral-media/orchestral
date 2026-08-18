// Shared dispatch-output envelope shapes.
//
// Every atomic Pattern output re-declared an identical cost / latencyMs / model
// / provider block plus a produced-asset element shape; nothing enforced that
// they stayed in sync. These composable *raw shapes* (plain objects of zod
// types, meant to be spread into `z.object({ ... })`) are the one source of
// truth for that envelope so a generic consumer — a cost meter, an asset picker
// — can rely on the fields being present and identically typed everywhere.
//
// They are raw shapes rather than assembled `z.object`s on purpose: a Pattern
// output carries domain fields alongside the envelope, and spreading lets each
// Pattern keep chaining `.describe()` / extra constraints on individual fields
// where its wording legitimately differs (see `metaEnvelopeShape`).

import { z } from 'zod'

/**
 * The dispatch envelope every atomic Pattern output carries. Spread into the
 * output `z.object({ ... })`. The four fields are byte-identical across all ten
 * atomics today (same types, same optionality, same `.describe()` text), so the
 * descriptions live here — a Pattern that ever needs different wording can
 * re-`.describe()` the spread field locally.
 */
export const dispatchEnvelopeShape = {
  cost: z.number().min(0).describe('USD cost charged for this call.'),
  latencyMs: z.number().int().min(0).describe('Wall-clock API latency.'),
  model: z.string().describe('Resolved provider:modelId.'),
  provider: z.string(),
} as const

/**
 * The meta envelope every meta Pattern output must carry, in addition to its
 * domain fields: `cost` = aggregated USD across sub-steps (0 when unknown),
 * `latencyMs` = measured compose wall time. Deliberately a subset of
 * `dispatchEnvelopeShape` — a meta spans many models, so it carries no `model` /
 * `provider`. Both are `>= 0` like the dispatch envelope; a meta re-chains only
 * the extra constraints it needs (`.describe()` wording, `latencyMs.int()`). A
 * bare re-chained `.min(0)` merges harmlessly, but note `latencyMs` must re-apply
 * `.min(0)` *after* `.int()` — zod v4's `.int()` resets the numeric floor to the
 * safe-integer minimum, discarding the spread's `.min(0)`.
 */
export const metaEnvelopeShape = {
  cost: z.number().min(0),
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
    assetId: z.string(),
    modality: z.literal(modality),
    url: z.string().url().optional(),
    cost: z.number().min(0).optional(),
  } as const
}
