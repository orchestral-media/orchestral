// meta_idea2video — MetaPattern.
//
// Turn a one-line idea into a multi-scene video. 5-stage DAG:
//   1. story-development     (text-generation, free-form story text)
//   2. character-extraction  (text-generation, JSON)
//   3. script-writing        (text-generation, JSON → per-scene scripts)
//   4. meta_script2video     (NESTED meta, ∥ per scene) — each scene → a video
//   5. concatenate           (host op — injected)
//
// The 3 stage prompts are inlined as string constants in ./prompts — nothing
// is loaded at dispatch. The one real host-injected dep is `concatVideos`
// (Stage 5 has no generation-capability backing).

import { z } from 'zod'
import type { MetaPattern } from '@orchestral/core'
import { metaEnvelopeShape, parallel } from '@orchestral/core'
import { textGeneration } from '../../atomic/text-generation'
import { script2videoMeta, CharacterInSceneSchema } from '../script2video'
import { parseJsonWithSchema, resolvePrompts, sumCosts, toJsonSchemaCached, type MetaCommonDeps } from '../_shared/meta-utils'
import {
  STORY_DEVELOPMENT_PROMPT,
  CHARACTER_EXTRACTION_PROMPT,
  SCRIPT_WRITING_PROMPT,
} from './prompts'

const CharactersResponseSchema = z.object({
  characters: z.array(CharacterInSceneSchema).min(1),
})
// Per-scene scripts wrapper: { script: string[] }.
const ScriptResponseSchema = z.object({ script: z.array(z.string()).min(1) })

export const IdeaToVideoInputSchema = z.object({
  idea: z
    .string()
    .min(1, 'idea required')
    .describe('A one-line idea to develop into a multi-scene video.'),
  style: z.string().optional().describe('Optional global visual style directive.'),
  userRequirement: z
    .string()
    .optional()
    .describe('Optional extra requirements threaded into story/script planning.'),
})
export type IdeaToVideoInput = z.infer<typeof IdeaToVideoInputSchema>

export const IdeaToVideoOutputSchema = z.object({
  videoAssetId: z.string().describe('Asset id of the final concatenated video.'),
  sceneCount: z.number().int().min(0).describe('Number of scenes rendered.'),
  ...metaEnvelopeShape,
})
export type IdeaToVideoOutput = z.infer<typeof IdeaToVideoOutputSchema>

export const IDEA2VIDEO_PATTERN_ID = 'meta_idea2video'

/**
 * @alpha
 * Default system prompts for meta_idea2video. Consumers pass a partial of the
 * same key set via `IdeaToVideoMetaDeps.prompts` to override a step's prompt
 * (tone, house style, localization) without forking the package.
 */
export const IDEA2VIDEO_DEFAULT_PROMPTS = Object.freeze({
  storyDevelopment: STORY_DEVELOPMENT_PROMPT,
  characterExtraction: CHARACTER_EXTRACTION_PROMPT,
  scriptWriting: SCRIPT_WRITING_PROMPT,
})

/** @alpha Per-step prompt overrides for meta_idea2video. */
export type IdeaToVideoPromptOverrides = Partial<
  Record<keyof typeof IDEA2VIDEO_DEFAULT_PROMPTS, string>
>

/**
 * @alpha
 * Host op: concatenate scene videos into one final video (see script2video).
 * `prompts` optionally overrides any of the three text-generation system
 * prompts; unset keys fall back to {@link IDEA2VIDEO_DEFAULT_PROMPTS}.
 */
export type IdeaToVideoMetaDeps = Pick<MetaCommonDeps, 'concatVideos'> & {
  prompts?: IdeaToVideoPromptOverrides
}

/** @alpha */
export function createIdea2VideoMeta(
  deps: IdeaToVideoMetaDeps,
): MetaPattern<IdeaToVideoInput, IdeaToVideoOutput> {
  const resolved = resolvePrompts(IDEA2VIDEO_DEFAULT_PROMPTS, deps.prompts)
  return {
    id: IDEA2VIDEO_PATTERN_ID,
    kind: 'meta',
    searchHint: 'generate a full multi-scene video from a single idea',
    namespace: 'meta-pipelines',
    // Canonical meta surfaced as a first-class chat-turn tool so the main turn
    // can dispatch idea→video in one hop (no find_pattern hop).
    exposureMode: 'always-load',
    description:
      'Turn a one-line idea into a multi-scene video: develop a story, extract characters, write per-scene scripts, render each scene (via meta_script2video), and concatenate.',
    tool: {
      description:
        'Generate a multi-scene video from a short idea. Develops a story, writes scene scripts, renders each scene into a video, and stitches them together.',
      inputs: IdeaToVideoInputSchema,
    },
    outputs: IdeaToVideoOutputSchema,
    async compose(params, ctx): Promise<IdeaToVideoOutput> {
      const { input } = params
      const startedAt = Date.now()
      // STORY_DEVELOPMENT_PROMPT and the script step both read the optional
      // requirement from <USER_REQUIREMENT> — emit that exact tag (was
      // <REQUIREMENT>, which neither prompt looked for → silently ignored).
      const req = input.userRequirement
        ? `\n\n<USER_REQUIREMENT>\n${input.userRequirement}\n</USER_REQUIREMENT>`
        : ''

      // Stage 1 — develop a free-form story (text, not JSON).
      const storyOut = await textGeneration(ctx, {
        system: resolved.storyDevelopment,
        prompt: `<IDEA>\n${input.idea}\n</IDEA>${req}`,
      })
      const story = storyOut.text

      // Stage 2 — extract characters from the story.
      const charsOut = await textGeneration(ctx, {
        system: resolved.characterExtraction,
        prompt: `<STORY>\n${story}\n</STORY>`,
        responseFormat: 'json',
        jsonSchema: toJsonSchemaCached(CharactersResponseSchema),
      })
      const { characters } = parseJsonWithSchema(
        charsOut.text,
        CharactersResponseSchema,
        'idea2video: characters',
      )

      // Stage 3 — write the per-scene scripts.
      const scriptOut = await textGeneration(ctx, {
        system: resolved.scriptWriting,
        prompt: `<STORY>\n${story}\n</STORY>${req}`,
        responseFormat: 'json',
        jsonSchema: toJsonSchemaCached(ScriptResponseSchema),
      })
      const { script: sceneScripts } = parseJsonWithSchema(
        scriptOut.text,
        ScriptResponseSchema,
        'idea2video: script',
      )

      // Checkpoint — review/edit the generated scene scripts before the
      // expensive per-scene render + concat. Cost-discipline made first-class:
      // paid generation is deferred behind an explicit OK. ctx.askUser.form
      // renders one text field per scene; Save resumes with the (possibly
      // edited) values.
      const values = await ctx.askUser.form({
        title: 'Review scene scripts before rendering',
        fields: sceneScripts.map((s, i) => ({
          key: `scene_${i}`,
          label: `Scene ${i + 1}`,
          type: 'text' as const,
          value: s,
        })),
      })
      // Scene count is fixed by the script stage; the user can tweak each
      // scene's text but not add/remove scenes. Non-string / missing values
      // fall back to the generated text.
      const finalScripts = sceneScripts.map((s, i) => {
        const edited = values[`scene_${i}`]
        return typeof edited === 'string' ? edited : s
      })

      // Stage 4 — render each scene through the nested meta_script2video (∥).
      // Keep the full sub-meta outputs so their aggregated cost rolls up here.
      const sceneOutputs = await parallel(
        finalScripts.map((sceneScript) =>
          script2videoMeta(ctx, {
            sceneScript,
            characters,
            style: input.style,
            userRequirement: input.userRequirement,
          }),
        ),
      )
      const sceneVideos = sceneOutputs.map((r) => r.videoAssetId)

      // Stage 5 — concatenate the scene videos (host op, no model cost).
      const final = await ctx.compute('concat-final-video', () =>
        deps.concatVideos(sceneVideos),
      )
      return {
        videoAssetId: final.assetId,
        sceneCount: finalScripts.length,
        cost: sumCosts(storyOut, charsOut, scriptOut, ...sceneOutputs),
        latencyMs: Date.now() - startedAt,
      }
    },
  }
}
