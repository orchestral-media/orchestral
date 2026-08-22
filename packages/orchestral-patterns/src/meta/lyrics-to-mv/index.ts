import { z } from 'zod'
import type { MetaPattern, ExecutionContext } from '@orchestral/core'
import { metaEnvelopeShape, parallel } from '@orchestral/core'
import { textGeneration } from '../../atomic/text-generation'
import { textToImage } from '../../atomic/text-to-image'
import { imageToVideo } from '../../atomic/image-to-video'
import { textToAudio } from '../../atomic/text-to-audio'
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
import { MV_KEYFRAMES_SYSTEM } from './prompts'

export const LYRICS_TO_MV_PATTERN_ID = 'meta_lyrics-to-mv'

export const LyricsToMvInputSchema = z.object({
  theme: z.string().min(1).describe('The lyrical theme or concept for the music video.'),
  style: z.string().optional().describe('Optional global visual style directive.'),
  keyframes: z.number().int().min(2).max(6).default(4)
    .describe('Number of keyframe moments to plan and animate.'),
  musicDurationSeconds: z.number().int().min(5).max(120).default(30)
    .describe('Duration of the generated music bed in seconds.'),
})
export type LyricsToMvInput = z.infer<typeof LyricsToMvInputSchema>

// Produced media rides in `assets[]` with a role `label` and nowhere else —
// see labelledAssetShape for why the projection needs it that way. Two
// modalities come out of this meta, so the element is a union of the
// per-modality shapes (serialises as `anyOf`, which the outputs audit walks).
const LyricsToMvAssetSchema = z.union([
  z.object(labelledAssetShape('audio')),
  z.object(labelledAssetShape('video')),
])

export const LyricsToMvOutputSchema = z.object({
  assets: z
    .array(LyricsToMvAssetSchema)
    .describe(
      'Every produced asset, by label: `music` (the audio bed), `clip-<i>` (the animated keyframe clips, in keyframe order) and `final-video` (the clips stitched with the music laid in). Empty when the user declined the cost gate.',
    ),
  ...metaEnvelopeShape,
})
export type LyricsToMvOutput = z.infer<typeof LyricsToMvOutputSchema>

const KeyframesSchema = z.object({
  keyframes: z.array(z.object({ prompt: z.string().min(1) })).min(1),
})

/**
 * @alpha
 * Default system prompt for meta_lyrics-to-mv. Consumers override via
 * `LyricsToMvMetaDeps.prompts`; the unset key falls back to this.
 */
export const LYRICS_TO_MV_DEFAULT_PROMPTS = Object.freeze({
  mvKeyframes: MV_KEYFRAMES_SYSTEM,
})

/** @alpha Per-step prompt overrides for meta_lyrics-to-mv. */
export type LyricsToMvPromptOverrides = Partial<
  Record<keyof typeof LYRICS_TO_MV_DEFAULT_PROMPTS, string>
>

/** @alpha */
export type LyricsToMvMetaDeps = Pick<
  MetaCommonDeps,
  'concatVideos' | 'addBackgroundAudio'
> & {
  prompts?: LyricsToMvPromptOverrides
}

/** @alpha */
export function createLyricsToMvMeta(deps: LyricsToMvMetaDeps): MetaPattern<LyricsToMvInput, LyricsToMvOutput> {
  const resolved = resolvePrompts(LYRICS_TO_MV_DEFAULT_PROMPTS, deps.prompts)
  return {
    id: LYRICS_TO_MV_PATTERN_ID,
    kind: 'meta',
    namespace: 'meta-pipelines',
    description:
      'Plan keyframe concepts for a music video / lyric video / MV, confirm with the user (cost gate), then generate a music bed + animated keyframes from a theme. Use for music video / lyric video / MV / animated keyframes from a theme.',
    searchHint: 'music video lyric video MV animated keyframes theme song visual',
    tool: { description: 'Generate a music video by planning keyframes, confirming, then generating music + animated clips.', inputs: LyricsToMvInputSchema },
    outputs: LyricsToMvOutputSchema,
    async compose({ input }, ctx: ExecutionContext): Promise<LyricsToMvOutput> {
      const startedAt = Date.now()

      // Stage 1 — plan N keyframe concepts via text-generation
      const gen = await textGeneration(ctx, {
        system: resolved.mvKeyframes,
        prompt: `Theme: ${input.theme}${styleTag(input.style)}\nPlan exactly ${input.keyframes} keyframe moments.`,
        responseFormat: 'json',
        jsonSchema: toJsonSchemaCached(KeyframesSchema),
      })

      const parsed = parseJsonWithSchema(gen.text, KeyframesSchema, 'lyrics-to-mv')

      // Clamp to requested keyframe count so over-count doesn't fire extra paid gens
      const frames = parsed.keyframes.slice(0, input.keyframes)

      // Cost gate — nothing paid runs before the user confirms
      const confirmed = await ctx.askUser.confirm({
        title: `Generate music + ${frames.length} keyframes and animate them?`,
        body: frames.map((f, i) => `${i + 1}. ${f.prompt.slice(0, 80)}`).join('\n'),
      })

      if (!confirmed) {
        return { assets: [], cost: sumCosts([gen.cost]), latencyMs: Date.now() - startedAt }
      }

      // After confirm — music and keyframe animation run concurrently.
      // Each keyframe: text-to-image → image-to-video (chained), parallel across
      // keyframes. Keep both sub-step outputs per keyframe to aggregate cost.
      const musicP = textToAudio(ctx, {
        prompt: `Music for: ${input.theme}${input.style ? `, ${input.style}` : ''}`,
        mode: 'music',
        durationSeconds: input.musicDurationSeconds,
      })

      const clipsP = parallel(
        frames.map((f) =>
          textToImage(ctx, { prompt: f.prompt }).then((still) =>
            imageToVideo(
              ctx,
              { prompt: f.prompt },
              { assets: [{ slot: 'startFrame', assetId: firstAssetId(still, 'lyrics-to-mv: text-to-image'), modality: 'image' }] },
            ).then((clip) => ({ still, clip })),
          ),
        ),
      )

      const [music, clipOutputs] = await Promise.all([musicP, clipsP])
      const musicAsset = labelAsset(firstAsset(music, 'lyrics-to-mv: text-to-audio'), 'audio', 'music')
      // `parallel` preserves frame order, so clip i is keyframe i.
      const clipAssets = clipOutputs.map(({ clip }, i) =>
        labelAsset(firstAsset(clip, 'lyrics-to-mv: image-to-video'), 'video', `clip-${i}`),
      )

      // Stitch the clips then lay the music track in.
      const { assetId: stitched } = await ctx.compute('concat-clips', () =>
        deps.concatVideos(clipAssets.map((c) => c.assetId)),
      )
      const final = await ctx.compute('mux-music', () =>
        deps.addBackgroundAudio(stitched, musicAsset.assetId, { mode: 'replace' }),
      )

      return {
        assets: [musicAsset, ...clipAssets, labelAsset(final, 'video', 'final-video')],
        cost: sumCosts([
          gen.cost,
          music.cost,
          ...clipOutputs.flatMap(({ still, clip }) => [still.cost, clip.cost]),
        ]),
        latencyMs: Date.now() - startedAt,
      }
    },
  }
}
