// Shared utilities for the deliverable-meta patterns. These were each
// re-defined verbatim (toJsonSchemaCached), with diverged signatures (firstAssetId),
// or as inline blocks (parseJsonWithSchema) across the meta/*/index.ts files.
// One copy here keeps them from drifting apart.

import { z } from 'zod'

// Schemas passed here are module-level constants, so this cache is effectively
// a per-schema compute-once — the same object identity recurs every call.
const jsonSchemaCache = new WeakMap<z.ZodType, unknown>()

/**
 * Render a Zod schema to the draft-2020-12 JSON Schema the atomic
 * text-generation pattern expects as its `jsonSchema` field.
 *
 * Memoised per schema instance: every call returns the SAME object — treat it
 * as immutable. Mutating the result poisons the cache for the process
 * lifetime, including the copies the shipped metas feed to text-generation.
 * (Named `-Cached` to keep it distinct from `@orchestral/core`'s uncached
 * `toJsonSchema`, which has a different return type.)
 */
export const toJsonSchemaCached = (s: z.ZodType): unknown => {
  const cached = jsonSchemaCache.get(s)
  if (cached !== undefined) return cached
  const rendered = z.toJSONSchema(s, { target: 'draft-2020-12' })
  jsonSchemaCache.set(s, rendered)
  return rendered
}

/**
 * Pull the first produced asset id off a step output, throwing a labeled error
 * when the step produced nothing. `label` is the full error prefix — callers
 * pass e.g. `'product-ad-short: image-to-video'` so the thrown message reads
 * `'<label> produced no asset'`, matching the inline guards this replaces.
 */
export function firstAssetId(
  out: { assets?: ReadonlyArray<{ assetId: string }> },
  label: string,
): string {
  const id = out.assets?.[0]?.assetId
  if (id === undefined) throw new Error(`${label} produced no asset`)
  return id
}

/**
 * Sum the `cost` field of any sub-step outputs a compose() already holds,
 * treating a missing or non-finite cost as 0. Every atomic output carries `cost`
 * (USD for that call) and every meta output now carries an aggregated `cost`, so
 * a meta can total its sub-steps with `sumCosts(a, b, ...c)`. Kept intentionally
 * dumb — no latency logic (metas measure wall time with Date.now() locally).
 */
export function sumCosts(
  ...outputs: ReadonlyArray<{ cost?: number } | undefined>
): number {
  return outputs.reduce((total, out) => {
    const cost = out?.cost
    // Number.isFinite guards NaN/Infinity from a buggy adapter — `?? 0`
    // alone would let a single NaN poison the whole aggregate (and every
    // parent meta summing it).
    return total + (typeof cost === 'number' && Number.isFinite(cost) ? cost : 0)
  }, 0)
}

/**
 * Parse a JSON string and validate it against a schema. `JSON.parse` failures
 * raise a clear, labeled error (`'<label>: text-generation did not return valid
 * JSON'`); schema violations propagate from Zod unchanged. Mirrors the inline
 * `try { JSON.parse } catch → SomeSchema.parse` block every new meta repeated.
 */
export function parseJsonWithSchema<T>(
  text: string,
  schema: z.ZodType<T>,
  label: string,
): T {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(`${label}: text-generation did not return valid JSON`)
  }
  return schema.parse(raw)
}

/**
 * Render an optional style directive as an XML-tagged prompt block, or ''
 * when no style was given. Shared across the deliverable metas so the
 * directive format can't drift between them.
 */
export function styleTag(style: string | undefined): string {
  return style ? `\n<STYLE>\n${style}\n</STYLE>` : ''
}

/**
 * Merge a meta's `*_DEFAULT_PROMPTS` with optional per-step overrides. A default
 * wins only where the override for that key is `undefined`, so a caller can
 * override any subset (or none) without dropping the rest. Returns a fresh
 * object — the frozen defaults const is never mutated.
 */
export function resolvePrompts<T extends Record<string, string>>(
  defaults: T,
  overrides?: Partial<T>,
): T {
  const resolved = { ...defaults }
  if (overrides) {
    for (const key of Object.keys(defaults) as Array<keyof T>) {
      const override = overrides[key]
      if (override !== undefined) resolved[key] = override
    }
  }
  return resolved
}

/**
 * The union of every host-supplied operation the deliverable metas depend on.
 * Each meta's `*MetaDeps` is a `Pick<MetaCommonDeps, ...>` of exactly the ops
 * it uses, so the op signatures live in one place and can't drift between metas.
 */
export interface MetaCommonDeps {
  /**
   * Mix or replace a background audio track on a video.
   *
   * Takes a video asset and an audio asset, returns a NEW video asset — the
   * inputs are never mutated. `mode: 'mix'` (the default) keeps the video's
   * existing audio and layers the track under it; `'replace'` drops the
   * original audio entirely. The result keeps the video's duration: a shorter
   * track leaves silence at the tail, a longer one is cut off at the end.
   * Container/codec of the result must stay playable as-is (an mp4 in, an mp4
   * out) — metas hand the returned id straight back to the caller.
   */
  addBackgroundAudio: (
    videoAssetId: string,
    audioAssetId: string,
    opts?: { mode?: 'replace' | 'mix' },
  ) => Promise<{ assetId: string }>
  /**
   * Concatenate ordered video clips into one video.
   *
   * Clips are joined in array order and the result's duration is the sum of
   * theirs. Clips may differ in resolution, frame rate, and audio layout, so
   * an implementation must normalize before joining rather than assume a
   * stream-copy is safe. Returns a new video asset; a single-element array is
   * valid and must still yield a usable asset.
   */
  concatVideos: (clipAssetIds: readonly string[]) => Promise<{ assetId: string }>
  /**
   * Attach a subtitle track to a video.
   *
   * `mode: 'soft'` (the default) muxes the subtitles as a selectable track;
   * `'hard'` burns them into the picture, which re-encodes. Returns a new
   * video asset with the same duration as the input. `subtitleAssetId` is a
   * subtitle asset — typically one minted by `createSubtitleAsset`.
   */
  addSubtitles: (
    videoAssetId: string,
    subtitleAssetId: string,
    opts?: { mode?: 'soft' | 'hard' },
  ) => Promise<{ assetId: string }>
  /**
   * Materialize an SRT document into a subtitle asset.
   *
   * `srt` is the full SubRip text (numbered cues, `HH:MM:SS,mmm` timestamps),
   * already timed against the video it will be attached to. Returns the id of
   * a stored subtitle asset, suitable as `addSubtitles`' second argument.
   */
  createSubtitleAsset: (srt: string) => Promise<{ assetId: string }>
  /**
   * Render a still image over its narration into one video segment.
   *
   * The audio asset drives the segment's duration — the image is held for
   * exactly as long as the narration runs, with the narration as the segment's
   * audio track. Returns a video asset whose container and frame geometry are
   * consistent across calls, since metas feed a series of these straight into
   * `concatVideos`.
   */
  stillToVideo: (
    imageAssetId: string,
    audioAssetId: string,
  ) => Promise<{ assetId: string }>
  /**
   * Publish a meta-internal assetId into the session's asset ledger and return
   * the handle that addresses it.
   *
   * Meta-internal ids are not addressable outside the compose() that produced
   * them; a handle is. Metas call this before referencing an intermediate
   * asset in an `askUser` payload, so the answering surface can resolve it
   * back to real media instead of showing an opaque id.
   */
  recordSessionAsset: (
    sessionId: string,
    assetId: string,
    modality: 'image' | 'audio' | 'video',
  ) => Promise<{ handle: string }>
}
