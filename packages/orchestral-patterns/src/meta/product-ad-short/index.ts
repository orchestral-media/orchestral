import { z } from 'zod'
import type { MetaPattern, ExecutionContext } from '@orchestral/core'
import { metaEnvelopeShape, parallel } from '@orchestral/core'
import { TEXT_GENERATION_PATTERN_ID, textGeneration } from '../../atomic/text-generation'
import { TEXT_TO_IMAGE_PATTERN_ID, textToImage } from '../../atomic/text-to-image'
import { IMAGE_TO_VIDEO_PATTERN_ID, imageToVideo } from '../../atomic/image-to-video'
import { TEXT_TO_AUDIO_PATTERN_ID, textToAudio } from '../../atomic/text-to-audio'
import {
  firstAsset,
  firstAssetId,
  labelAsset,
  labelledAssetShape,
  parseJsonWithSchema,
  resolvePrompts,
  styleTag,
  sumCosts,
  toJsonSchemaCached,
  type MetaCommonDeps,
} from '../_shared/meta-utils'
import { HERO_PROMPTS_SYSTEM } from './prompts'

export const PRODUCT_AD_SHORT_PATTERN_ID = 'meta_product-ad-short'

export const ProductAdShortInputSchema = z.object({
  brief: z.string().min(1).describe('What the product is and the ad angle/vibe.'),
  style: z.string().optional().describe('Optional global visual style directive.'),
  variantCount: z.number().int().min(1).max(6).default(4)
    .describe('How many cheap draft hero frames to generate for the pick.'),
  withMusic: z.boolean().default(false).describe('Also generate a music bed asset.'),
})
export type ProductAdShortInput = z.infer<typeof ProductAdShortInputSchema>

// Produced media rides in `assets[]` with a role `label` and nowhere else —
// see labelledAssetShape for why the projection needs it that way. Two
// modalities come out of this meta, so the element is a union of the
// per-modality shapes (serialises as `anyOf`, which the outputs audit walks).
const ProductAdShortAssetSchema = z.union([
  z.object(labelledAssetShape('video')),
  z.object(labelledAssetShape('audio')),
])

export const ProductAdShortOutputSchema = z.object({
  assets: z
    .array(ProductAdShortAssetSchema)
    .describe(
      'Every produced asset, by label: `final-video` (the ad clip — muxed with the music bed when withMusic is set, otherwise the raw animated clip) and, when withMusic is set, `music` (the audio bed).',
    ),
  ...metaEnvelopeShape,
})
export type ProductAdShortOutput = z.infer<typeof ProductAdShortOutputSchema>

const HeroPromptsSchema = z.object({ prompts: z.array(z.string().min(1)).min(1) })

/**
 * @alpha
 * Default system prompt for meta_product-ad-short. Consumers override via
 * `ProductAdShortMetaDeps.prompts`; the unset key falls back to this.
 */
export const PRODUCT_AD_SHORT_DEFAULT_PROMPTS = Object.freeze({
  heroPrompts: HERO_PROMPTS_SYSTEM,
})

/** @alpha Per-step prompt overrides for meta_product-ad-short. */
export type ProductAdShortPromptOverrides = Partial<
  Record<keyof typeof PRODUCT_AD_SHORT_DEFAULT_PROMPTS, string>
>

/** @alpha */
export type ProductAdShortMetaDeps = Pick<
  MetaCommonDeps,
  'addBackgroundAudio' | 'recordSessionAsset'
> & {
  prompts?: ProductAdShortPromptOverrides
}

/** @alpha */
export function createProductAdShortMeta(deps: ProductAdShortMetaDeps): MetaPattern<ProductAdShortInput, ProductAdShortOutput> {
  const resolved = resolvePrompts(PRODUCT_AD_SHORT_DEFAULT_PROMPTS, deps.prompts)
  return {
    id: PRODUCT_AD_SHORT_PATTERN_ID,
    kind: 'meta',
    namespace: 'meta-pipelines',
    description:
      'Make a short product ad video from a brief: generate several draft hero frames, let the user pick one, then animate it (optionally with a music bed). Use for product ads / promo clips / commercials.',
    searchHint: 'product ad video commercial promo hero clip advertisement',
    tool: { description: 'Generate a short product ad clip via a pick-then-animate flow.', inputs: ProductAdShortInputSchema },
    outputs: ProductAdShortOutputSchema,
    // The whole set, the `withMusic`-only text-to-audio included: this is what
    // compose MAY dispatch on some call, and over-declaring costs a caller
    // permission, never spend. `addBackgroundAudio` is a host op, not a
    // dispatch.
    plannedDispatches: () => [
      TEXT_GENERATION_PATTERN_ID,
      TEXT_TO_IMAGE_PATTERN_ID,
      IMAGE_TO_VIDEO_PATTERN_ID,
      TEXT_TO_AUDIO_PATTERN_ID,
    ],
    async compose({ input }, ctx: ExecutionContext): Promise<ProductAdShortOutput> {
      const startedAt = Date.now()

      // Stage 1 — write N hero prompts via text-generation
      const gen = await textGeneration(ctx, {
        system: resolved.heroPrompts,
        prompt: `<BRIEF>\n${input.brief}\n</BRIEF>${styleTag(input.style)}\nWrite exactly ${input.variantCount} prompts.`,
        responseFormat: 'json',
        jsonSchema: toJsonSchemaCached(HeroPromptsSchema),
      })

      // Wrap JSON.parse for a clear error on malformed JSON; let Zod throw for schema violations.
      const parsed = parseJsonWithSchema(gen.text, HeroPromptsSchema, 'product-ad-short')

      // Clamp to variantCount so over-count prompts don't fire extra paid gens
      const prompts = parsed.prompts.slice(0, input.variantCount)

      // Stage 2 — generate draft heros via parallel text-to-image. Keep the
      // outputs so their per-call cost aggregates into the meta total.
      const heroOutputs = await parallel(
        prompts.map((p) => textToImage(ctx, { prompt: p })),
      )
      const heroAssetIds = heroOutputs.map((r) =>
        firstAssetId(r, 'product-ad-short: text-to-image'),
      )

      // Cheap-explore → commit gate: the user picks one hero before any expensive step.
      // When a sessionId is available (chat dispatch), mint handles so the
      // picker can render thumbnails; fall back to text labels for headless runs.
      const sessionId = ctx.sessionId
      let chosenHeroAssetId: string
      if (sessionId) {
        const handles = await Promise.all(
          heroAssetIds.map((id) => deps.recordSessionAsset(sessionId, id, 'image').then((r) => r.handle)),
        )
        const pick = await ctx.askUser.custom<
          { title: string; mode: 'single'; options: { value: string; label: string; tag: 'image' }[] },
          { mode: 'single'; chosen: string }
        >({
          kind: 'choice',
          payload: {
            title: 'Pick the hero frame to turn into the ad',
            mode: 'single',
            options: handles.map((h, i) => ({ value: h, label: `Hero ${i + 1}`, tag: 'image' as const })),
          },
          answerSchema: z.object({ mode: z.literal('single'), chosen: z.string() }),
        })
        const idx = handles.indexOf(pick.chosen)
        if (idx < 0) throw new Error('product-ad-short: chosen hero handle not found')
        chosenHeroAssetId = heroAssetIds[idx]
      } else {
        // Fallback (no session, e.g. headless): text-label choose.
        const options = heroAssetIds.map((_, i) => `Hero ${i + 1}: ${prompts[i].slice(0, 80)}`)
        const chosen = await ctx.askUser.choose({
          title: 'Pick the hero frame to turn into the ad',
          options,
        })
        const chosenIdx = options.indexOf(chosen)
        if (chosenIdx < 0) throw new Error('product-ad-short: chosen hero not found in options')
        chosenHeroAssetId = heroAssetIds[chosenIdx]
      }

      // Commit point passed — animate the chosen hero, optionally with a music bed (concurrently).
      const animateP = imageToVideo(
        ctx,
        { prompt: `Animate this product hero into a short ad shot: ${input.brief}. One clear camera move; keep the product identity exact.` },
        { assets: [{ slot: 'startFrame', assetId: chosenHeroAssetId, modality: 'image' }] },
      )
      const musicP = input.withMusic
        ? textToAudio(ctx, {
            prompt: `Upbeat music bed for a product ad: ${input.brief}`,
            mode: 'music',
            durationSeconds: 10,
          })
        : Promise.resolve(undefined)
      const [animate, music] = await Promise.all([animateP, musicP])
      const adClip = firstAsset(animate, 'product-ad-short: image-to-video')
      const musicAsset = music
        ? labelAsset(firstAsset(music, 'product-ad-short: text-to-audio'), 'audio', 'music')
        : undefined

      // If music was requested, mux it into the ad clip; otherwise the clip
      // itself is the final video (and keeps its url / cost on the element).
      const finalVideo = musicAsset
        ? labelAsset(
            await ctx.compute('mux-music', () =>
              deps.addBackgroundAudio(adClip.assetId, musicAsset.assetId, { mode: 'replace' }),
            ),
            'video',
            'final-video',
          )
        : labelAsset(adClip, 'video', 'final-video')
      return {
        assets: musicAsset ? [finalVideo, musicAsset] : [finalVideo],
        cost: sumCosts([gen.cost, ...heroOutputs.map((h) => h.cost), animate.cost, music?.cost]),
        latencyMs: Date.now() - startedAt,
      }
    },
  }
}
