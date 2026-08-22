// meta_event-to-script — MetaPattern that consumes the
// next-scene-extraction, character-merge-scene-to-event, and script-enhancement
// skills.
//
// Turn a single plot event (from meta_novel-to-events) into a batch of
// polished per-scene screenplays + an event-scope character registry:
//
//   Stage 1 — scene extraction (one call, batch of ≤5 scenes per event):
//     next-scene-extraction returns {scenes: Scene[]} in a single dispatch,
//     avoiding an iterative loop over a per-scene termination flag.
//
//   Stage 2 ∥ Stage 3 (parallel):
//     Stage 2: character-merge-scene-to-event — once per event, returns the
//       event-scope character registry (each entry maps scene_idx →
//       per-scene identifier).
//     Stage 3: script-enhancement — per-scene polish (∥ via stepOptions.stepId);
//       skipped entirely when input.skipPolish === true.
//
// Output:
//   eventScenes: PolishedScene[]  (each = scene + polishedScript)
//   eventCharRegistry: CharacterInEvent[]
//
// Exposure: 'agent-tool'.
//
// The 3 stage prompts are inlined as string constants in ./prompts — nothing
// is loaded at dispatch. This meta has no host-injected deps.

import { z } from 'zod'
import type { MetaPattern } from '@orchestral/core'
import { metaEnvelopeShape, parallel } from '@orchestral/core'
import {
  CharacterInSceneSchema,
  resolvePrompts,
  sumCosts,
  textGeneration,
  toJsonSchemaCached,
} from '@orchestral/patterns'
import {
  NEXT_SCENE_EXTRACTION_PROMPT,
  CHARACTER_MERGE_SCENE_TO_EVENT_PROMPT,
  SCRIPT_ENHANCEMENT_PROMPT,
} from './prompts'

// Re-export so consumers can rely on a single canonical shape across
// meta_event-to-script ⇄ meta_script2video.
export type { CharacterInScene } from '@orchestral/patterns'

// ── Scene schema (matches the next-scene-extraction output contract).
// environment is left as a free record because the skill only loosely
// specifies it as "slugline + descriptive prose" — provider outputs vary and
// downstream consumers only need the script + characters.
const EnvironmentSchema = z.record(z.string(), z.unknown())
export const SceneSchema = z.object({
  idx: z.number().int().min(0),
  environment: EnvironmentSchema,
  characters: z.array(CharacterInSceneSchema),
  script: z.string(),
})
/** @alpha */
export type Scene = z.infer<typeof SceneSchema>

const ScenesResponseSchema = z.object({
  scenes: z.array(SceneSchema).min(1).max(5),
})

// ── Character-in-event schema (matches character-merge-scene-to-event OUTPUT).
/** @alpha */
export const CharacterInEventSchema = z.object({
  index: z.number().int().min(0),
  identifier_in_event: z.string(),
  static_features: z.string(),
  // scene_idx (stringified per JSON object key) → identifier_in_scene.
  active_scenes: z.record(z.string(), z.string()),
})
/** @alpha */
export type CharacterInEvent = z.infer<typeof CharacterInEventSchema>

const EventCharacterRegistryResponseSchema = z.object({
  characters: z.array(CharacterInEventSchema),
})

// ── Enhanced-script schema (matches script-enhancement OUTPUT).
const EnhancedScriptResponseSchema = z.object({
  enhanced_script: z.string(),
})

// ── input / output ──────────────────────────────────────────────────────

// Inline Event shape from meta_novel-to-events. Imported by structural
// duck-typing rather than schema import — we only read description (the
// extraction skill uses event description text as the anchor), so a string
// suffices for type safety here.
const EventInputSchema = z.object({
  index: z.number().int(),
  description: z.string(),
  timeframe: z.string(),
  characters: z.string(),
  cause: z.string(),
  process: z.string(),
  outcome: z.string(),
})

export const EventToScriptInputSchema = z.object({
  event: EventInputSchema.describe(
    'The plot event to expand into scenes — typically one entry from meta_novel-to-events.events.',
  ),
  contextFragments: z
    .array(z.string())
    .readonly()
    .optional()
    .describe(
      'Optional RAG-retrieved prose passages directly relevant to the event. Threaded into the next-scene-extraction prompt as <CONTEXT_FRAGMENTS_START>...<CONTEXT_FRAGMENTS_END>. Caller (typically M-5 agent) is responsible for retrieval.',
    ),
  skipPolish: z
    .boolean()
    .default(false)
    .optional()
    .describe(
      'When true, skip the per-scene script-enhancement Stage 3. The original scene scripts pass through unchanged (saving a fan-out of script-enhancement calls).',
    ),
})
export type EventToScriptInput = z.infer<typeof EventToScriptInputSchema>

// Stage 3 outputs the polished script per scene; we surface it alongside
// the scene fields so downstream sees one packed shape.
export const PolishedSceneSchema = SceneSchema.extend({
  polishedScript: z
    .string()
    .describe(
      'Result of script-enhancement (Stage 3). Equals scene.script verbatim when input.skipPolish === true.',
    ),
})
/** @alpha */
export type PolishedScene = z.infer<typeof PolishedSceneSchema>

export const EventToScriptOutputSchema = z.object({
  eventScenes: z
    .array(PolishedSceneSchema)
    .readonly()
    .describe('Ordered per-scene screenplay output (scene + polished script).'),
  eventCharRegistry: z
    .array(CharacterInEventSchema)
    .readonly()
    .describe(
      'Event-scope character registry built by merging scene-scope characters across all scenes of this event.',
    ),
  cost: metaEnvelopeShape.cost.describe(
    'USD cost summed across the scene-extraction + character-merge + (optional) polish calls.',
  ),
  latencyMs: metaEnvelopeShape.latencyMs
    .int()
    .min(0)
    .describe(
      'Wall-clock latency: extraction + max(char-merge, max(polish fan-out)).',
    ),
})
export type EventToScriptOutput = z.infer<typeof EventToScriptOutputSchema>

export const EVENT_TO_SCRIPT_PATTERN_ID = 'meta_event-to-script'

// ── factory ──────────────────────────────────────────────────────────────

/**
 * @alpha
 * Default system prompts for meta_event-to-script (scene extraction, character
 * merge, per-scene enhancement). Consumers override via
 * `EventToScriptMetaInit.prompts`; unset keys fall back to these.
 */
export const EVENT_TO_SCRIPT_DEFAULT_PROMPTS = Object.freeze({
  nextSceneExtraction: NEXT_SCENE_EXTRACTION_PROMPT,
  characterMergeSceneToEvent: CHARACTER_MERGE_SCENE_TO_EVENT_PROMPT,
  scriptEnhancement: SCRIPT_ENHANCEMENT_PROMPT,
})

/** @alpha Per-step prompt overrides for meta_event-to-script. */
export type EventToScriptPromptOverrides = Partial<
  Record<keyof typeof EVENT_TO_SCRIPT_DEFAULT_PROMPTS, string>
>

/** @alpha Optional init for meta_event-to-script (prompt overrides only). */
export type EventToScriptMetaInit = {
  prompts?: EventToScriptPromptOverrides
}

/** @alpha */
export function createEventToScriptMeta(
  init: EventToScriptMetaInit = {},
): MetaPattern<EventToScriptInput, EventToScriptOutput> {
  const resolved = resolvePrompts(EVENT_TO_SCRIPT_DEFAULT_PROMPTS, init.prompts)
  return {
    id: EVENT_TO_SCRIPT_PATTERN_ID,
    kind: 'meta',
    searchHint:
      'turn a single plot event into polished per-scene screenplays with character continuity',
    namespace: 'meta-pipelines',
    exposure: 'agent-tool',
    description:
      'Turn one plot event into a batch of per-scene screenplays plus an event-scope character registry. Calls the next-scene-extraction skill once to produce all scenes for the event, then runs character-merge-scene-to-event and (optionally) per-scene script-enhancement in parallel.',
    tool: {
      description:
        'Adapt a single plot event into polished per-scene screenplays with cross-scene character continuity. Each scene returns environment, characters, script, and a polished script suitable for downstream storyboard / video rendering.',
      inputs: EventToScriptInputSchema,
    },
    outputs: EventToScriptOutputSchema,
    async compose(params, ctx): Promise<EventToScriptOutput> {
      const { input } = params

      // Stage 1 — extract all scenes for this event in one batch (the skill
      // guarantees ≤5 scenes per event).
      const scenesOut = await textGeneration(ctx, {
        system: resolved.nextSceneExtraction,
        prompt: buildSceneExtractionPrompt(
          input.event,
          input.contextFragments ?? [],
        ),
        responseFormat: 'json',
        jsonSchema: toJsonSchemaCached(ScenesResponseSchema),
      })
      const scenes = ScenesResponseSchema.parse(JSON.parse(scenesOut.text))
        .scenes

      // Stage 2 ∥ Stage 3 — character merge across all scenes + (optional)
      // per-scene polish. Both branches are independent of each other; we
      // structure as parallel for max throughput.
      const skipPolish = input.skipPolish ?? false

      const [mergeOut, polishedScripts] = await parallel([
        textGeneration(ctx, {
          system: resolved.characterMergeSceneToEvent,
          prompt: buildCharMergePrompt(scenes),
          responseFormat: 'json',
          jsonSchema: toJsonSchemaCached(EventCharacterRegistryResponseSchema),
        }),
        skipPolish
          ? Promise.resolve(
              scenes.map((s) => ({
                text: s.script,
                // Polish skipped: nothing ran, so this is a genuine 0, not an
                // unreported (null) cost.
                cost: 0,
                latencyMs: 0,
              })),
            )
          : parallel(
              scenes.map((s, idx) =>
                textGeneration(
                  ctx,
                  {
                    system: resolved.scriptEnhancement,
                    prompt: `<PLANNED_SCRIPT_START>\n${s.script}\n<PLANNED_SCRIPT_END>`,
                    responseFormat: 'json',
                    jsonSchema: toJsonSchemaCached(EnhancedScriptResponseSchema),
                  },
                  { stepId: `polish-${idx}` },
                )
                  .then((out) => ({
                    text: EnhancedScriptResponseSchema.parse(
                      JSON.parse(out.text),
                    ).enhanced_script,
                    cost: out.cost,
                    latencyMs: out.latencyMs,
                  })),
              ),
            ),
      ])

      const eventCharRegistry = EventCharacterRegistryResponseSchema.parse(
        JSON.parse(mergeOut.text),
      ).characters

      const eventScenes = scenes.map((scene, idx) => ({
        ...scene,
        polishedScript: polishedScripts[idx]!.text,
      }))

      const polishCost = sumCosts(polishedScripts.map((p) => p.cost))
      const polishLatencyMs = polishedScripts.reduce(
        (max, p) => Math.max(max, p.latencyMs),
        0,
      )

      return {
        eventScenes,
        eventCharRegistry,
        cost: sumCosts([scenesOut.cost, mergeOut.cost, polishCost]),
        latencyMs:
          scenesOut.latencyMs +
          Math.max(mergeOut.latencyMs, polishLatencyMs),
      }
    },
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

interface PromptEventInput {
  description: string
  timeframe: string
  characters: string
  cause: string
  process: string
  outcome: string
}

function buildSceneExtractionPrompt(
  event: PromptEventInput,
  contextFragments: readonly string[],
): string {
  const eventBlock = `<EVENT_DESCRIPTION_START>\n${renderEventForExtraction(event)}\n<EVENT_DESCRIPTION_END>`
  const fragmentsBlock =
    contextFragments.length === 0
      ? '<CONTEXT_FRAGMENTS_START>\n<CONTEXT_FRAGMENTS_END>'
      : `<CONTEXT_FRAGMENTS_START>\n${contextFragments
          .map((f, i) => `<FRAGMENT_${i}_START>\n${f}\n<FRAGMENT_${i}_END>`)
          .join('\n\n')}\n<CONTEXT_FRAGMENTS_END>`
  return `${eventBlock}\n\n${fragmentsBlock}`
}

function renderEventForExtraction(event: PromptEventInput): string {
  return [
    `Description: ${event.description}`,
    `Timeframe: ${event.timeframe}`,
    `Characters: ${event.characters}`,
    `Cause: ${event.cause}`,
    `Process: ${event.process}`,
    `Outcome: ${event.outcome}`,
  ].join('\n')
}

function buildCharMergePrompt(scenes: readonly Scene[]): string {
  return scenes
    .map((scene) => renderSceneForCharMerge(scene))
    .join('\n\n')
}

function renderSceneForCharMerge(scene: Scene): string {
  const charsBlock = scene.characters
    .map(
      (c) =>
        `<CHARACTER_${c.idx}_START>\n${c.identifierInScene} [${c.isVisible ? 'visible' : 'invisible'}]\nstatic features: ${c.staticFeatures}\ndynamic features: ${c.dynamicFeatures}\n<CHARACTER_${c.idx}_END>`,
    )
    .join('\n\n')
  return `<SCENE_${scene.idx}_START>\n\n<SCRIPT_START>\n${scene.script}\n<SCRIPT_END>\n\n<CHARACTERS_START>\n\n${charsBlock}\n\n<CHARACTERS_END>\n\n<SCENE_${scene.idx}_END>`
}
