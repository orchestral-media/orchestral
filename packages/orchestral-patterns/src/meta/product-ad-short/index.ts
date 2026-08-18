import { z } from 'zod'
import type { MetaPattern, ExecutionContext } from '@orchestral/core'
import { metaEnvelopeShape, parallel } from '@orchestral/core'
import { textGeneration } from '../../atomic/text-generation'
import { textToImage } from '../../atomic/text-to-image'
import { imageToVideo } from '../../atomic/image-to-video'
import { textToAudio } from '../../atomic/text-to-audio'
import { firstAssetId, parseJsonWithSchema, resolvePrompts, styleTag, sumCosts, toJsonSchemaCached, type MetaCommonDeps } from '../_shared/meta-utils'
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

export const ProductAdShortOutputSchema = z.object({
  videoAssetId: z.string().describe('Asset id of the final ad video (muxed with music if requested, otherwise the raw clip).'),
  musicAssetId: z.string().optional().describe('Asset id of the music bed, if requested.'),
  ...metaEnvelopeShape,
})
export type ProductAdShortOutput = z.infer<typeof ProductAdShortOutputSchema>

// Fix B: add .min(1) to reject empty arrays at parse time
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

      // Fix B: clamp to variantCount so over-count prompts don't fire extra paid gens
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
      // G5: when a sessionId is available (chat dispatch), mint handles so the
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
      const adClipAssetId = firstAssetId(animate, 'product-ad-short: image-to-video')
      const musicAssetId = music ? firstAssetId(music, 'product-ad-short: text-to-audio') : undefined

      // If music was requested, mux it into the ad clip; otherwise the clip is the final video.
      const videoAssetId = musicAssetId
        ? (await ctx.compute('mux-music', () => deps.addBackgroundAudio(adClipAssetId, musicAssetId, { mode: 'replace' }))).assetId
        : adClipAssetId
      return {
        videoAssetId,
        ...(musicAssetId ? { musicAssetId } : {}),
        cost: sumCosts(gen, ...heroOutputs, animate, music),
        latencyMs: Date.now() - startedAt,
      }
    },
  }
}
