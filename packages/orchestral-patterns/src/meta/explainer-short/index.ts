import { z } from 'zod'
import type { MetaPattern, ExecutionContext } from '@orchestral/core'
import { metaEnvelopeShape, parallel } from '@orchestral/core'
import { textGeneration } from '../../atomic/text-generation'
import { textToImage } from '../../atomic/text-to-image'
import { textToSpeech } from '../../atomic/text-to-speech'
import { firstAssetId, parseJsonWithSchema, resolvePrompts, styleTag, sumCosts, toJsonSchemaCached, type MetaCommonDeps } from '../_shared/meta-utils'
import { EXPLAINER_SCENES_SYSTEM } from './prompts'

export const EXPLAINER_SHORT_PATTERN_ID = 'meta_explainer-short'

export const ExplainerShortInputSchema = z.object({
  topic: z.string().min(1).describe('The topic to explain in the video.'),
  style: z.string().optional().describe('Optional visual style directive.'),
  sceneCount: z
    .number()
    .int()
    .min(2)
    .max(8)
    .default(4)
    .describe('Number of scenes to generate (2–8).'),
  assemble: z
    .boolean()
    .default(true)
    .describe(
      'Assemble the scenes into one narrated video (each still shown for its narration).',
    ),
})
export type ExplainerShortInput = z.infer<typeof ExplainerShortInputSchema>

export const ExplainerShortOutputSchema = z.object({
  scenes: z
    .array(
      z.object({
        imageAssetId: z.string(),
        voAssetId: z.string(),
      }),
    )
    .describe('Per-scene component assets (visual + narration VO).'),
  videoAssetId: z
    .string()
    .optional()
    .describe(
      'Asset id of the assembled narrated video (present when assemble is on and scenes were produced).',
    ),
  ...metaEnvelopeShape,
})
export type ExplainerShortOutput = z.infer<typeof ExplainerShortOutputSchema>

const ScenesSchema = z.object({
  scenes: z
    .array(
      z.object({
        type: z.enum(['hook', 'concept', 'broll', 'cta']),
        narration: z.string().min(1),
        visual: z.string().min(1),
      }),
    )
    .min(1),
})

/**
 * @alpha
 * Default system prompt for meta_explainer-short. Consumers override via
 * `ExplainerShortMetaDeps.prompts`; the unset key falls back to this.
 */
export const EXPLAINER_SHORT_DEFAULT_PROMPTS = Object.freeze({
  explainerScenes: EXPLAINER_SCENES_SYSTEM,
})

/** @alpha Per-step prompt overrides for meta_explainer-short. */
export type ExplainerShortPromptOverrides = Partial<
  Record<keyof typeof EXPLAINER_SHORT_DEFAULT_PROMPTS, string>
>

/** @alpha */
export type ExplainerShortMetaDeps = Pick<
  MetaCommonDeps,
  'concatVideos' | 'stillToVideo'
> & {
  prompts?: ExplainerShortPromptOverrides
}

/** Max simultaneous hardware-encoder ffmpeg sessions for the Stage 4 fan-out
 *  (see stillToVideo — h264_videotoolbox / h264_mf are session-limited on
 *  consumer hardware). Not user-configurable; this is an encoder-resource
 *  constraint, not a product knob. */
const MAX_CONCURRENT_ENCODES = 3

/** Run `fn` over `items` with at most `limit` in flight at once, preserving
 *  output order. On failure no new items are started and the FIRST error is
 *  rethrown only after the in-flight calls settle — deliberately not
 *  `parallel`'s immediate Promise.all rejection, which would return while
 *  encoder processes are still running against the session-limited hardware. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  let firstError: unknown
  let hasError = false
  async function worker(): Promise<void> {
    while (next < items.length && !hasError) {
      const i = next++
      try {
        results[i] = await fn(items[i]!, i)
      } catch (err) {
        if (!hasError) {
          hasError = true
          firstError = err
        }
        return
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  )
  if (hasError) throw firstError
  return results
}

/** @alpha */
export function createExplainerShortMeta(
  deps: ExplainerShortMetaDeps,
): MetaPattern<ExplainerShortInput, ExplainerShortOutput> {
  const resolved = resolvePrompts(EXPLAINER_SHORT_DEFAULT_PROMPTS, deps.prompts)
  return {
    id: EXPLAINER_SHORT_PATTERN_ID,
    kind: 'meta',
    namespace: 'meta-pipelines',
    description:
      'Create a short explainer video / tutorial / concept walkthrough / narrated scenes: break a topic into typed scenes (hook/concept/broll/cta), let the user review/edit per-scene narration, then generate each scene\'s visual (text-to-image) and voiceover (text-to-speech). Returns component assets per scene.',
    searchHint:
      'explainer video tutorial concept walkthrough narrated scenes educational breakdown',
    tool: {
      description:
        'Generate a short explainer video from a topic: write a typed scene breakdown, let the user review narration, then produce per-scene visual + voiceover assets.',
      inputs: ExplainerShortInputSchema,
    },
    outputs: ExplainerShortOutputSchema,
    async compose({ input }, ctx: ExecutionContext): Promise<ExplainerShortOutput> {
      const startedAt = Date.now()

      // Stage 1 — generate typed scene breakdown via text-generation
      const gen = await textGeneration(ctx, {
        system: resolved.explainerScenes,
        prompt: `<TOPIC>\n${input.topic}\n</TOPIC>${styleTag(input.style)}\nWrite exactly ${input.sceneCount} scenes.`,
        responseFormat: 'json',
        jsonSchema: toJsonSchemaCached(ScenesSchema),
      })

      const parsed = parseJsonWithSchema(gen.text, ScenesSchema, 'explainer-short')

      // Clamp to sceneCount so over-count scenes don't fire extra paid gens
      const scenes = parsed.scenes.slice(0, input.sceneCount)

      // Stage 2 — review/edit narration per scene before expensive generation
      const values = await ctx.askUser.form({
        title: 'Review scene narration before generating',
        fields: scenes.map((s, i) => ({
          key: `scene_${i}`,
          label: `Scene ${i + 1} (${s.type})`,
          type: 'text' as const,
          value: s.narration,
        })),
      })
      // Non-string / missing values fall back to the generated narration
      const finalNarration = scenes.map((s, i) => {
        const edited = values[`scene_${i}`]
        return typeof edited === 'string' ? edited : s.narration
      })

      // Cost gate — nothing paid runs before the user confirms
      const confirmed = await ctx.askUser.confirm({
        title: `Generate ${scenes.length} scene visuals + voiceovers?`,
        body: scenes.map((s, i) => `${i + 1}. (${s.type}) ${finalNarration[i].slice(0, 80)}`).join('\n'),
      })

      if (!confirmed) {
        return { scenes: [], cost: sumCosts(gen), latencyMs: Date.now() - startedAt }
      }

      // Stage 3 — parallel per-scene: text-to-image + text-to-speech. Keep the
      // full sub-step outputs so their per-call cost can be aggregated.
      const sceneOutputs = await parallel(
        scenes.map((s, i) =>
          Promise.all([
            textToImage(ctx, { prompt: s.visual }),
            textToSpeech(ctx, { text: finalNarration[i] }),
          ]).then(([image, vo]) => ({ image, vo })),
        ),
      )
      const sceneAssets = sceneOutputs.map(({ image, vo }) => ({
        imageAssetId: firstAssetId(image, 'explainer-short: text-to-image'),
        voAssetId: firstAssetId(vo, 'explainer-short: text-to-speech'),
      }))
      const cost = sumCosts(
        gen,
        ...sceneOutputs.flatMap(({ image, vo }) => [image, vo]),
      )

      // Stage 4 (optional) — assemble each scene's still + VO into a video
      // segment, then concat the segments into one narrated video. The host
      // assembly ops carry no model cost.
      if (input.assemble && sceneAssets.length > 0) {
        const segmentIds = await mapWithConcurrency(
          sceneAssets,
          MAX_CONCURRENT_ENCODES,
          (scene, i) =>
            ctx
              .compute(`seg-${i}`, () =>
                deps.stillToVideo(scene.imageAssetId, scene.voAssetId),
              )
              .then((r) => r.assetId),
        )
        const { assetId: videoAssetId } = await ctx.compute('concat-scenes', () =>
          deps.concatVideos(segmentIds),
        )
        return { scenes: sceneAssets, videoAssetId, cost, latencyMs: Date.now() - startedAt }
      }

      return { scenes: sceneAssets, cost, latencyMs: Date.now() - startedAt }
    },
  }
}
