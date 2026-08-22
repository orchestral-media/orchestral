// meta_consented-edit — the example's own MetaPattern.
//
// image-to-image declares one Alternative (`via-caption`: caption the source,
// re-render from the caption), and the runtime will not take it unless the
// host constructs it with `alternatives: 'auto'`. This meta is the third
// option between "fail" and "redirect silently": take the declared path, but
// ask first.
//
// It is built FROM the declaration rather than alongside it. The factory is
// handed the `Alternative` image-to-image declares (the host reads it off the
// registry entry); the question put to the user is worded from that entry's
// `description` / `preserves` / `losses`, and on yes the meta dispatches the
// entry's own `via.patternId` through `ctx.step`, with the same `mapInput` /
// `mapOutput` the runtime would have applied under 'auto'. Nothing here names
// meta_image-to-image-via-caption: whatever image-to-image declares is what
// the user is asked about, and what runs.
//
// `ctx.askUser.confirm` parks compose() until the host's AskUserHandler
// answers. There is no replay and no job state change — the job stays
// `running`, and compose's locals (the source refs, the start time) are simply
// still there when the await returns.

import { z } from 'zod'
import {
  assetIdField,
  extendInputsWithReferences,
  metaEnvelopeShape,
  type Alternative,
  type AssetNeed,
  type DerivedReferences,
  type MetaPattern,
  type Semantics,
} from '@orchestral/core'
import {
  ImageToImagePrimaryInputSchema,
  type ImageToImageInput,
  type ImageToImageOutput,
} from '@orchestral/patterns'

export const CONSENTED_EDIT_PATTERN_ID = 'meta_consented-edit'

// Same slot image-to-image declares, so the refs the host resolved for this
// meta are the ones the declared path expects (a redirect forwards resolved
// assets under the PARENT's slot names — see `Alternative.via.mapInput`).
const ASSET_NEEDS = [
  {
    slot: 'source',
    modality: 'image',
    cardinality: 'array',
    required: true,
    description:
      'The image(s) to edit. Forwarded verbatim to whichever path the user consents to.',
  },
] as const satisfies readonly AssetNeed[]

// The input IS image-to-image's input: `prompt` plus the derived `references`.
export type ConsentedEditInput = z.infer<typeof ImageToImagePrimaryInputSchema> & {
  references?: DerivedReferences<typeof ASSET_NEEDS>
}

// Bounded per the output-field vocabulary: ids only, never bytes — the host's
// asset store holds what the ids point at.
export const ConsentedEditOutputSchema = z.object({
  outcome: z.enum(['edited', 'declined']),
  assets: z
    .array(z.object({ assetId: assetIdField(), modality: z.literal('image') }))
    .describe('Produced images. Empty when the user declined.'),
  /** True iff the path taken declared losses — the same data the runtime
   *  puts on `job:alternative-selected` when it takes a path by itself. */
  degraded: z.boolean(),
  cost: metaEnvelopeShape.cost.describe('USD cost summed across the path taken.'),
  latencyMs: metaEnvelopeShape.latencyMs
    .int()
    .min(0)
    .describe('Wall-clock compose time, including the time spent parked on the user.'),
})
export type ConsentedEditOutput = z.infer<typeof ConsentedEditOutputSchema>

export interface ConsentedEditInit {
  /**
   * The fallback image-to-image declares. Read it off the registry after
   * registering image-to-image: `registry.getEntry('image-to-image')
   * .alternatives[0]`. The registry stores alternatives type-erased; this
   * one was declared against image-to-image's own I/O, so narrowing it back
   * is the host's (true) claim, not a cast of convenience.
   */
  path: Alternative<ImageToImageInput, ImageToImageOutput>
}

/** `['subject-identity', 'composition']` → `subject identity, composition`. */
export function spellOut(semantics: readonly Semantics[] | undefined): string {
  if (!semantics || semantics.length === 0) return 'nothing'
  return semantics.map((s) => s.replace(/-/g, ' ')).join(', ')
}

export function createConsentedEditPattern({
  path,
}: ConsentedEditInit): MetaPattern<ConsentedEditInput, ConsentedEditOutput> {
  const losses = path.losses ?? []
  return {
    id: CONSENTED_EDIT_PATTERN_ID,
    kind: 'meta',
    searchHint: 'edit an image, asking the user before taking a degraded path',
    namespace: 'meta-pipelines',
    description: `Edit an image when no image-to-image model is available: put the declared fallback (${path.id}) and its losses to the user, and take it only on consent.`,
    tool: {
      description:
        'Edit an existing image. When no image-to-image model is available, asks the user whether the declared degraded path is acceptable before running it; returns `outcome: declined` and no assets if they say no.',
      inputs: extendInputsWithReferences(
        CONSENTED_EDIT_PATTERN_ID,
        ImageToImagePrimaryInputSchema,
        ASSET_NEEDS,
      ),
    },
    outputs: ConsentedEditOutputSchema,
    assetNeeds: ASSET_NEEDS,
    async compose({ input }, ctx): Promise<ConsentedEditOutput> {
      const startedAt = Date.now()
      const sourceRefs = (ctx.assets ?? []).filter((a) => a.slot === 'source')

      // The question is the declaration, in words. `confirm` resolves true
      // only when the host answered `{ confirmed: true }` (validated by the
      // runtime bridge against the protocol schema before compose resumes).
      const confirmed = await ctx.askUser.confirm({
        title: `No image-to-image model. Take the '${path.id}' path instead?`,
        body:
          `${path.description}\n` +
          `Keeps: ${spellOut(path.preserves)}. Loses: ${spellOut(losses)}.`,
      })
      if (!confirmed) {
        return {
          outcome: 'declined',
          assets: [],
          degraded: false,
          cost: 0,
          latencyMs: Date.now() - startedAt,
        }
      }

      // The same redirect `alternatives: 'auto'` performs, done by hand:
      // `mapInput` shapes the child input from ours, the source image rides
      // the internal asset channel (`PatternRef.assets` → the child's
      // `ctx.assets`, under our slot name), and `mapOutput` projects the
      // child's envelope back to image-to-image's shape.
      const child = await ctx.step<unknown>({
        patternId: path.via.patternId,
        input: path.via.mapInput(input),
        ...(sourceRefs.length > 0 ? { assets: sourceRefs } : {}),
      })
      const out = path.via.mapOutput(child)

      return {
        outcome: 'edited',
        assets: out.assets.map((a) => ({ assetId: a.assetId, modality: 'image' as const })),
        degraded: losses.length > 0,
        cost: out.cost,
        latencyMs: Date.now() - startedAt,
      }
    },
  }
}
