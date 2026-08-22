// meta_script-planning — MetaPattern.
//
// Route a basic idea into one of three planning branches, then expand it
// into a full planned script. 2 steps, both text-generation:
//   1. script-intent-routing      → { intent: narrative | motion | montage }
//   2. <intent>-script-planning   → { planned_script }
//
// The router + 3 branch prompts are inlined as string constants in ./prompts.
// This meta is self-contained: nothing is loaded at dispatch, no host binding
// — the prompts ship with the pattern.

import { z } from 'zod'
import type { MetaPattern } from '@orchestral/core'
import { metaEnvelopeShape } from '@orchestral/core'
import { resolvePrompts, sumCosts, textGeneration, toJsonSchemaCached } from '@orchestral/patterns'
import {
  SCRIPT_INTENT_ROUTING_PROMPT,
  NARRATIVE_SCRIPT_PLANNING_PROMPT,
  MOTION_SCRIPT_PLANNING_PROMPT,
  MONTAGE_SCRIPT_PLANNING_PROMPT,
} from './prompts'

const INTENTS = ['narrative', 'motion', 'montage'] as const
type Intent = (typeof INTENTS)[number]

// Router response shape (matches SCRIPT_INTENT_ROUTING_PROMPT's output).
const IntentRouterResponseSchema = z.object({
  intent: z.enum(INTENTS),
  rationale: z.string().optional(),
})

// Planned-script response — shared by all three branch templates.
const PlannedScriptResponseSchema = z.object({
  planned_script: z.string(),
})

export const ScriptPlanningInputSchema = z.object({
  idea: z
    .string()
    .min(1, 'idea required')
    .describe('A basic story idea / concept to expand into a planned script.'),
})
export type ScriptPlanningInput = z.infer<typeof ScriptPlanningInputSchema>

export const ScriptPlanningOutputSchema = z.object({
  intent: z
    .enum(INTENTS)
    .describe('The branch the router chose (fallback: narrative).'),
  plannedScript: z
    .string()
    .describe('The full planned script produced by the chosen branch.'),
  cost: metaEnvelopeShape.cost.describe('USD cost summed across the two sub-steps.'),
  latencyMs: metaEnvelopeShape.latencyMs
    .int()
    .min(0)
    .describe('Wall-clock latency summed across the chain.'),
})
export type ScriptPlanningOutput = z.infer<typeof ScriptPlanningOutputSchema>

export const SCRIPT_PLANNING_PATTERN_ID = 'meta_script-planning'

/**
 * @alpha
 * Default system prompts for meta_script-planning: the intent router plus the
 * three branch templates. Consumers override any via
 * `ScriptPlanningMetaInit.prompts`; unset keys fall back to these.
 */
export const SCRIPT_PLANNING_DEFAULT_PROMPTS = Object.freeze({
  scriptIntentRouting: SCRIPT_INTENT_ROUTING_PROMPT,
  narrativeScriptPlanning: NARRATIVE_SCRIPT_PLANNING_PROMPT,
  motionScriptPlanning: MOTION_SCRIPT_PLANNING_PROMPT,
  montageScriptPlanning: MONTAGE_SCRIPT_PLANNING_PROMPT,
})

/** @alpha Per-step prompt overrides for meta_script-planning. */
export type ScriptPlanningPromptOverrides = Partial<
  Record<keyof typeof SCRIPT_PLANNING_DEFAULT_PROMPTS, string>
>

/** @alpha Optional init for meta_script-planning (prompt overrides only). */
export type ScriptPlanningMetaInit = {
  prompts?: ScriptPlanningPromptOverrides
}

/** @alpha */
export function createScriptPlanningMeta(
  init: ScriptPlanningMetaInit = {},
): MetaPattern<ScriptPlanningInput, ScriptPlanningOutput> {
  const resolved = resolvePrompts(SCRIPT_PLANNING_DEFAULT_PROMPTS, init.prompts)
  // Branch prompt for each routed intent. Exhaustive over Intent.
  const branchPrompts: Record<Intent, string> = {
    narrative: resolved.narrativeScriptPlanning,
    motion: resolved.motionScriptPlanning,
    montage: resolved.montageScriptPlanning,
  }
  return {
    id: SCRIPT_PLANNING_PATTERN_ID,
    kind: 'meta',
    searchHint: 'develop a basic idea into a narrative, motion, or montage treatment',
    namespace: 'meta-pipelines',
    description:
      'Plan a full script from a basic idea: route to the narrative / motion / montage specialist template, then expand.',
    tool: {
      description:
        'Turn a one-line story idea into a full planned script. Routes the idea to a narrative, motion, or montage planning template, then expands it into a complete script ready for storyboarding.',
      inputs: ScriptPlanningInputSchema,
    },
    outputs: ScriptPlanningOutputSchema,
    async compose(params, ctx): Promise<ScriptPlanningOutput> {
      const { input } = params
      const ideaBlock = `<BASIC_IDEA_START>\n${input.idea}\n<BASIC_IDEA_END>`

      // Step 1 — classify intent. The router prompt becomes the system prompt.
      const routed = await textGeneration(ctx, {
        system: resolved.scriptIntentRouting,
        prompt: ideaBlock,
        responseFormat: 'json',
        jsonSchema: toJsonSchemaCached(IntentRouterResponseSchema),
      })
      const intent = parseIntent(routed.text)

      // Step 2 — expand the idea via the chosen branch's prompt.
      const planned = await textGeneration(ctx, {
        system: branchPrompts[intent],
        prompt: ideaBlock,
        responseFormat: 'json',
        jsonSchema: toJsonSchemaCached(PlannedScriptResponseSchema),
      })
      const plannedScript = PlannedScriptResponseSchema.parse(
        JSON.parse(planned.text),
      ).planned_script

      return {
        intent,
        plannedScript,
        cost: sumCosts([routed.cost, planned.cost]),
        latencyMs: routed.latencyMs + planned.latencyMs,
      }
    },
  }
}

/**
 * Parse the router's JSON, defaulting to 'narrative' on parse failure or an
 * invalid intent. An intentional default, not a swallowed error.
 */
function parseIntent(text: string): Intent {
  try {
    const parsed = IntentRouterResponseSchema.safeParse(JSON.parse(text))
    if (parsed.success) return parsed.data.intent
  } catch {
    // fall through to the documented narrative default
  }
  return 'narrative'
}
