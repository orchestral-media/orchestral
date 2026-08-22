import { z } from 'zod'
import type { MetaPattern, ExecutionContext } from '@orchestral/core'
import { metaEnvelopeShape, parallel } from '@orchestral/core'
import { textGeneration } from '../../atomic/text-generation'
import { textToImage } from '../../atomic/text-to-image'
import { firstAssetId, parseJsonWithSchema, resolvePrompts, styleTag, sumCosts, toJsonSchemaCached } from '../_shared/meta-utils'
import { PRODUCT_PHOTO_PACK_SYSTEM } from './prompts'

export const PRODUCT_PHOTO_PACK_PATTERN_ID = 'meta_product-photo-pack'

export const ProductPhotoPackInputSchema = z.object({
  brief: z.string().min(1).describe('What the product is, its materials, color, and form.'),
  style: z.string().optional().describe('Optional global visual style directive.'),
  maxSlots: z.number().int().min(1).max(6).default(4)
    .describe('Maximum number of product shots to generate (cost cap).'),
})
export type ProductPhotoPackInput = z.infer<typeof ProductPhotoPackInputSchema>

export const ProductPhotoPackOutputSchema = z.object({
  imageAssetIds: z.array(z.string()).describe('Asset ids of the generated product shot images, in slot order.'),
  ...metaEnvelopeShape,
})
export type ProductPhotoPackOutput = z.infer<typeof ProductPhotoPackOutputSchema>

const SlotsSchema = z.object({
  slots: z.array(z.object({ name: z.string().min(1), prompt: z.string().min(1) })).min(1),
})

/**
 * @alpha
 * Default system prompt for meta_product-photo-pack. Consumers override via
 * `ProductPhotoPackMetaInit.prompts`; the unset key falls back to this.
 */
export const PRODUCT_PHOTO_PACK_DEFAULT_PROMPTS = Object.freeze({
  productPhotoPack: PRODUCT_PHOTO_PACK_SYSTEM,
})

/** @alpha Per-step prompt overrides for meta_product-photo-pack. */
export type ProductPhotoPackPromptOverrides = Partial<
  Record<keyof typeof PRODUCT_PHOTO_PACK_DEFAULT_PROMPTS, string>
>

/** @alpha Optional init for meta_product-photo-pack (prompt overrides only). */
export type ProductPhotoPackMetaInit = {
  prompts?: ProductPhotoPackPromptOverrides
}

/** @alpha */
export function createProductPhotoPackMeta(
  init: ProductPhotoPackMetaInit = {},
): MetaPattern<ProductPhotoPackInput, ProductPhotoPackOutput> {
  const resolved = resolvePrompts(PRODUCT_PHOTO_PACK_DEFAULT_PROMPTS, init.prompts)
  return {
    id: PRODUCT_PHOTO_PACK_PATTERN_ID,
    kind: 'meta',
    namespace: 'meta-pipelines',
    description:
      'Plan and generate a set of product photos for an e-commerce listing from a product brief: write varied shot types (white background, lifestyle, detail/macro, infographic), confirm with the user, then generate all shots in parallel via text-to-image. Use for product photo pack / e-commerce listing images / white background / lifestyle / macro.',
    searchHint: 'product photo pack e-commerce listing images white background lifestyle macro product shots',
    tool: { description: 'Generate a product photo pack (multiple e-commerce shots) from a product brief.', inputs: ProductPhotoPackInputSchema },
    outputs: ProductPhotoPackOutputSchema,
    async compose({ input }, ctx: ExecutionContext): Promise<ProductPhotoPackOutput> {
      const startedAt = Date.now()

      // Stage 1 — plan shot slots via text-generation
      const gen = await textGeneration(ctx, {
        system: resolved.productPhotoPack,
        prompt: `<BRIEF>\n${input.brief}\n</BRIEF>${styleTag(input.style)}\nPlan up to ${input.maxSlots} shots.`,
        responseFormat: 'json',
        jsonSchema: toJsonSchemaCached(SlotsSchema),
      })

      // Wrap JSON.parse for a clear error on malformed JSON; let Zod throw for schema violations
      const parsed = parseJsonWithSchema(gen.text, SlotsSchema, 'product-photo-pack')

      // Clamp to maxSlots so over-count slots don't fire extra paid gens
      const chosen = parsed.slots.slice(0, input.maxSlots)

      // Cost gate: confirm before any paid image generation
      const confirmed = await ctx.askUser.confirm({
        title: `Generate ${chosen.length} product shots?`,
        body: chosen.map((s) => `• ${s.name}`).join('\n'),
      })
      if (!confirmed) {
        return {
          imageAssetIds: [],
          cost: sumCosts([gen.cost]),
          latencyMs: Date.now() - startedAt,
        }
      }

      // Stage 2 — parallel text-to-image for all chosen slots
      const images = await parallel(
        chosen.map((slot) => textToImage(ctx, { prompt: slot.prompt })),
      )
      const imageAssetIds = images.map((r) =>
        firstAssetId(r, 'product-photo-pack: text-to-image'),
      )

      return {
        imageAssetIds,
        cost: sumCosts([gen.cost, ...images.map((r) => r.cost)]),
        latencyMs: Date.now() - startedAt,
      }
    },
  }
}
