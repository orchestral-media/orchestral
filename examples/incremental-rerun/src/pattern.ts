// meta_short-clip — the three-step MetaPattern this example re-submits.
//
//   describe   text-generation   prompt → one-line shot description
//   render     text-to-image     description → a still (returns assets[])
//   animate    image-to-video    motion + the still → a clip
//
// Input is `{ prompt, motion }`. Steps 1–2 read only `prompt`; step 3 reads
// `motion` plus step 2's asset. That split is what the demo leans on: change
// `motion` and only `animate` has a different input, so only `animate` runs.
//
// The still reaches step 3 through `PatternRef.assets` — the machine-to-machine
// asset channel a meta uses to hand a sub-step an assetId it produced itself
// (see packages/orchestral-core/src/pattern-ref.ts; image-best-of-n threads its
// candidates to the judge the same way). It bypasses the LLM-facing handle
// layer entirely, lands in the child's `DispatchContext.assets` under the slot
// the child's `assetNeeds` declares (`startFrame` here), and is folded into the
// child's idempotency key — so the same `motion` over a different still is a
// different unit of work.

import {
  assetIdField,
  boundedText,
  metaEnvelopeShape,
  urlField,
  type MetaPattern,
} from '@orchestral/core'
import {
  firstAssetId,
  imageToVideo,
  sumCosts,
  textGeneration,
  textToImage,
} from '@orchestral/patterns'
import { z } from 'zod'

export const SHORT_CLIP_PATTERN_ID = 'meta_short-clip'

export const ShortClipInputSchema = z.object({
  prompt: z.string().min(1).describe('What the clip is of — the subject of the single shot.'),
  motion: z.string().min(1).describe('How the camera moves once the still is animated.'),
})
export type ShortClipInput = z.infer<typeof ShortClipInputSchema>

// Outputs use the bounded vocabulary (boundedText / assetIdField / urlField)
// so no string field can carry an unbounded blob into a model's context, and
// the registry's OUTPUTS_UNBOUNDED_FIELDS lint stays quiet for this pattern.
export const ShortClipOutputSchema = z.object({
  description: boundedText(512).describe('The one-line shot description step 1 wrote.'),
  frameAssetId: assetIdField().describe('The still step 2 rendered and step 3 animated.'),
  assets: z
    .array(
      z.object({
        assetId: assetIdField(),
        modality: z.literal('video'),
        url: urlField().optional(),
      }),
    )
    .describe('The produced clip(s) — the deliverable.'),
  cost: metaEnvelopeShape.cost,
  latencyMs: metaEnvelopeShape.latencyMs.int().min(0),
})
export type ShortClipOutput = z.infer<typeof ShortClipOutputSchema>

/** Step 1's system prompt. Exported because it is part of step 1's INPUT, and
 *  therefore part of its idempotency key — the smoke test re-derives the key. */
export const DESCRIBE_SYSTEM =
  'You are a cinematographer. Turn the subject into one line describing a single still shot: framing, light, lens. No preamble.'

export function createShortClipMeta(): MetaPattern<ShortClipInput, ShortClipOutput> {
  return {
    id: SHORT_CLIP_PATTERN_ID,
    kind: 'meta',
    searchHint: 'describe, render and animate a short clip from a prompt',
    namespace: 'meta-pipelines',
    description:
      'Three-step clip pipeline: describe the shot, render it, animate it. Exists to show that re-submitting with one input changed re-runs only the steps that input reaches.',
    tool: {
      description:
        'Turn a subject and a camera motion into a short clip: one line of shot direction, one still, one animated clip.',
      inputs: ShortClipInputSchema,
    },
    outputs: ShortClipOutputSchema,
    async compose({ input }, ctx): Promise<ShortClipOutput> {
      const startedAt = Date.now()

      // Every step carries an EXPLICIT stepId (`describe` / `render` /
      // `animate`) rather than the default `${patternId}#${n}`. Be precise
      // about what that buys, because it is less than it looks:
      //
      //   • It is the vocabulary the host sees. `job:step` carries the
      //     author-facing stepId, so a host can line up run 2's `render`
      //     against run 1's `render` by name across runs. The default id
      //     bakes in the step's ordinal (`text-to-image#1`), so inserting a
      //     step ahead of it renames it.
      //
      //   • It is NOT part of the idempotency key. The key hashes
      //     { patternId, input, assets, sessionId, stepIndex }, and stepIndex
      //     is the ordinal the runtime mints as compose calls ctx.step —
      //     independent of the id you pass. So the dedup is positional as
      //     well as content-addressed: add a step before `render` and
      //     `render`'s stepIndex moves from 1 to 2, which is a new key even
      //     though its input did not change. The author owns that — a
      //     shipped meta's step order is part of its contract
      //     (meta-execution-context.ts: "production Patterns are write-once").

      // 1. describe — reads only `prompt`. Its key: text-generation +
      //    { system, prompt } + session + stepIndex 0.
      const shot = await textGeneration(
        ctx,
        { system: DESCRIBE_SYSTEM, prompt: input.prompt },
        { stepId: 'describe' },
      )

      // 2. render — reads only step 1's text. On a run where `describe` was a
      //    dedup hit, `shot.text` is the STORED output verbatim, so this key is
      //    stable even if the real model behind step 1 is non-deterministic.
      const still = await textToImage(ctx, { prompt: shot.text }, { stepId: 'render' })
      const frameAssetId = firstAssetId(still, 'meta_short-clip: render')

      // 3. animate — reads `motion` plus step 2's asset through the
      //    internal-asset channel. Both are in its key: a new motion OR a new
      //    still is new work; the same pair is a hit.
      const clip = await imageToVideo(
        ctx,
        { prompt: input.motion },
        {
          stepId: 'animate',
          assets: [{ slot: 'startFrame', assetId: frameAssetId, modality: 'image' }],
        },
      )

      return {
        description: shot.text,
        frameAssetId,
        assets: clip.assets.map((a) => ({
          assetId: a.assetId,
          modality: 'video' as const,
          ...(a.url !== undefined ? { url: a.url } : {}),
        })),
        cost: sumCosts(shot, still, clip),
        latencyMs: Date.now() - startedAt,
      }
    },
  }
}
