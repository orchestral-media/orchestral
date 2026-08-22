import { z } from 'zod'
import type { MetaPattern, ExecutionContext } from '@orchestral/core'
import { metaEnvelopeShape, parallel } from '@orchestral/core'
import { textGeneration } from '../../atomic/text-generation'
import { textToImage } from '../../atomic/text-to-image'
import { imageToVideo } from '../../atomic/image-to-video'
import { textToSpeech } from '../../atomic/text-to-speech'
import {
  automaticSpeechRecognition,
  type AutomaticSpeechRecognitionOutput,
} from '../../atomic/automatic-speech-recognition'
import {
  firstAsset,
  labelAsset,
  labelledAssetShape,
  parseJsonWithSchema,
  resolvePrompts,
  sumCosts,
  toJsonSchemaCached,
  type MetaCommonDeps,
} from '../_shared/meta-utils'
import { UGC_SCRIPT_SYSTEM, UGC_HERO_GUIDANCE } from './prompts'

export const UGC_TESTIMONIAL_PATTERN_ID = 'meta_ugc-testimonial'

export const UgcTestimonialInputSchema = z.object({
  product: z.string().min(1).describe('The product being reviewed.'),
  persona: z.string().optional().describe('Optional persona for the testimonial speaker (e.g. "busy mom in her 30s").'),
  targetSeconds: z.number().int().min(5).max(60).default(20)
    .describe('Target testimonial duration in seconds (5–60). Controls script word count and default shot count.'),
  shots: z.number().int().min(1).max(6).optional()
    .describe('Number of talking-head shot clips to animate (default: derived from targetSeconds, max 6).'),
  subtitles: z.boolean().default(true)
    .describe('Burn captions into the final video by transcribing the voiceover (skipped gracefully if transcription yields no timed segments).'),
})
export type UgcTestimonialInput = z.infer<typeof UgcTestimonialInputSchema>

// Produced media rides in `assets[]` with a role `label` and nowhere else —
// see labelledAssetShape for why the projection needs it that way. Three
// modalities come out of this meta, so the element is a union of the
// per-modality shapes (serialises as `anyOf`, which the outputs audit walks).
const UgcTestimonialAssetSchema = z.union([
  z.object(labelledAssetShape('image')),
  z.object(labelledAssetShape('audio')),
  z.object(labelledAssetShape('video')),
])

export const UgcTestimonialOutputSchema = z.object({
  assets: z
    .array(UgcTestimonialAssetSchema)
    .describe(
      'Every produced asset, by label: `hero` (the identity-locked still reused as startFrame on every shot), `voiceover` (the synthesized narration), `shot-<i>` (the animated talking-head clips, in shot order — absent if the user declined), and `final-video` (the shots concatenated with the voiceover laid over, subtitles burned in when requested — present only when shots were produced).',
    ),
  ...metaEnvelopeShape,
})
export type UgcTestimonialOutput = z.infer<typeof UgcTestimonialOutputSchema>

const ScriptSchema = z.object({
  script: z.string().min(1),
  shots: z.array(z.object({ motion: z.string().min(1) })).min(1),
})

/**
 * @alpha
 * Default prompts for meta_ugc-testimonial: `ugcScript` is the script/shot-list
 * system prompt; `ugcHeroGuidance` is the identity-lock guidance interpolated
 * into the hero-still image prompt. Consumers override via
 * `UgcTestimonialMetaDeps.prompts`; unset keys fall back to these.
 */
export const UGC_TESTIMONIAL_DEFAULT_PROMPTS = Object.freeze({
  ugcScript: UGC_SCRIPT_SYSTEM,
  ugcHeroGuidance: UGC_HERO_GUIDANCE,
})

/** @alpha Per-step prompt overrides for meta_ugc-testimonial. */
export type UgcTestimonialPromptOverrides = Partial<
  Record<keyof typeof UGC_TESTIMONIAL_DEFAULT_PROMPTS, string>
>

/** @alpha */
export type UgcTestimonialMetaDeps = Pick<
  MetaCommonDeps,
  'concatVideos' | 'addBackgroundAudio' | 'addSubtitles' | 'createSubtitleAsset'
> & {
  prompts?: UgcTestimonialPromptOverrides
}

// ASR timed segment, in seconds. Derived from the pattern's output schema so
// the field names stay locked to the canonical shape it declares
// (`startSecond`/`endSecond`, never `start`/`end`).
type AsrSegment = NonNullable<AutomaticSpeechRecognitionOutput['segments']>[number]

function srtTimecode(seconds: number): string {
  const s = Math.max(0, seconds)
  const h = Math.floor(s / 3600).toString().padStart(2, '0')
  const m = Math.floor((s % 3600) / 60).toString().padStart(2, '0')
  const sec = Math.floor(s % 60).toString().padStart(2, '0')
  const ms = Math.floor((s % 1) * 1000).toString().padStart(3, '0')
  return `${h}:${m}:${sec},${ms}`
}

/** Render ASR segments (seconds) as SubRip: index / timecode / text / blank line. */
export function toSrt(segments: readonly AsrSegment[]): string {
  return segments
    .map((seg, i) => {
      const start = srtTimecode(seg.startSecond)
      const end = srtTimecode(seg.endSecond)
      return `${i + 1}\n${start} --> ${end}\n${seg.text}\n`
    })
    .join('\n')
}

/** @alpha */
export function createUgcTestimonialMeta(deps: UgcTestimonialMetaDeps): MetaPattern<UgcTestimonialInput, UgcTestimonialOutput> {
  const resolved = resolvePrompts(UGC_TESTIMONIAL_DEFAULT_PROMPTS, deps.prompts)
  return {
    id: UGC_TESTIMONIAL_PATTERN_ID,
    kind: 'meta',
    namespace: 'meta-pipelines',
    description:
      'Create a UGC testimonial video: write a timed script, synthesize voiceover, generate an identity-locked hero still, then animate N talking-head shots (user confirms before animation). Use for UGC testimonial / talking-head product review / vertical social video / spokesperson content.',
    searchHint: 'UGC testimonial talking-head product review vertical social video spokesperson authentic user-generated content',
    tool: { description: 'Generate a UGC product testimonial video from a product description and optional persona.', inputs: UgcTestimonialInputSchema },
    outputs: UgcTestimonialOutputSchema,
    async compose({ input }, ctx: ExecutionContext): Promise<UgcTestimonialOutput> {
      const startedAt = Date.now()

      // Stage 1 — write script + shot list via text-generation
      const gen = await textGeneration(ctx, {
        system: resolved.ugcScript,
        prompt: `Product: ${input.product}${input.persona ? `\nPersona: ${input.persona}` : ''}\nTarget duration: ${input.targetSeconds} seconds`,
        responseFormat: 'json',
        jsonSchema: toJsonSchemaCached(ScriptSchema),
      })

      const parsed = parseJsonWithSchema(gen.text, ScriptSchema, 'ugc-testimonial')

      // Cap shots: use explicit input.shots or derive from targetSeconds (1 per 5s, min 1, max 6)
      const shotCap = input.shots ?? Math.min(6, Math.max(1, Math.ceil(input.targetSeconds / 5)))
      const shots = parsed.shots.slice(0, shotCap)

      // Stage 2 — TTS voiceover + hero still in parallel (independent). Keep the
      // outputs so their per-call cost aggregates into the meta total.
      const [voOut, heroOut] = await Promise.all([
        textToSpeech(ctx, { text: parsed.script }),
        textToImage(ctx, {
          prompt: `${input.persona ?? 'a relatable everyday person'}, ${resolved.ugcHeroGuidance} Product: ${input.product}.`,
        }),
      ])
      const voAsset = labelAsset(firstAsset(voOut, 'ugc-testimonial: text-to-speech'), 'audio', 'voiceover')
      const heroAsset = labelAsset(firstAsset(heroOut, 'ugc-testimonial: text-to-image'), 'image', 'hero')

      // Cost gate — confirm before animating shots
      const confirmed = await ctx.askUser.confirm({
        title: `Animate ${shots.length} testimonial shot${shots.length !== 1 ? 's' : ''} from this hero?`,
        body: parsed.script,
      })

      if (!confirmed) {
        // The assets already paid for are still the caller's — hero + voiceover
        // go out even though no shot was animated.
        return {
          assets: [heroAsset, voAsset],
          cost: sumCosts([gen.cost, voOut.cost, heroOut.cost]),
          latencyMs: Date.now() - startedAt,
        }
      }

      // Stage 3 — animate shots in parallel; same hero as startFrame on every shot (identity lock)
      const shotOutputs = await parallel(
        shots.map((shot) =>
          imageToVideo(
            ctx,
            { prompt: shot.motion },
            { assets: [{ slot: 'startFrame', assetId: heroAsset.assetId, modality: 'image' }] },
          ),
        ),
      )
      // `parallel` preserves shot order, so shot i is the i-th planned shot.
      const shotAssets = shotOutputs.map((r, i) =>
        labelAsset(firstAsset(r, 'ugc-testimonial: image-to-video'), 'video', `shot-${i}`),
      )

      // Stage 4 — concat shots then lay the VO over the stitched clip.
      const { assetId: stitched } = await ctx.compute('concat-shots', () =>
        deps.concatVideos(shotAssets.map((s) => s.assetId)),
      )
      let finalVideoId = (await ctx.compute('mux-vo', () => deps.addBackgroundAudio(stitched, voAsset.assetId, { mode: 'replace' }))).assetId

      // Stage 5 — optional burned subtitles. Transcribe the VO for timed
      // segments, build an SRT, materialize it, then hard-burn onto the video.
      // Skips gracefully when ASR returns no segments (silent VO / unsupported).
      let asrCost: number | null = 0
      if (input.subtitles) {
        const asr = await automaticSpeechRecognition(
          ctx,
          { timestamps: 'segment' },
          { assets: [{ slot: 'source', assetId: voAsset.assetId, modality: 'audio' }] },
        )
        asrCost = sumCosts([asr.cost])
        if (asr.segments?.length) {
          const srt = toSrt(asr.segments)
          const { assetId: srtId } = await ctx.compute('subtitle-asset', () => deps.createSubtitleAsset(srt))
          const { assetId: subbed } = await ctx.compute('burn-subs', () => deps.addSubtitles(finalVideoId, srtId, { mode: 'hard' }))
          finalVideoId = subbed
        }
      }

      return {
        assets: [heroAsset, voAsset, ...shotAssets, labelAsset({ assetId: finalVideoId }, 'video', 'final-video')],
        cost: sumCosts([gen.cost, voOut.cost, heroOut.cost, ...shotOutputs.map((s) => s.cost), asrCost]),
        latencyMs: Date.now() - startedAt,
      }
    },
  }
}
