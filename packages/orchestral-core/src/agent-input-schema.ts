// AgentPattern base input schema.
//
// The framework injects two base fields into an AgentPattern's LLM-facing tool:
//   • description — 3-5 word task label, used only for UI / transcript title /
//                   log; not part of the subagent's LLM seed
//   • prompt      — natural-language task brief, used *directly* as the
//                   subagent's first user message (not JSON.stringify'd, not
//                   merged with the Pattern's other input fields)
//
// Pattern authors get the merged schema via `agentInputSchema({...own extra
// fields})`. Extra fields are NOT auto-rendered into the seed message — when an
// author wants to expose them to the child LLM they must splice them into the
// `loop.system` template themselves (the values the parent LLM fills are visible
// to the runtime through the `input.X` closure).
//
// Contract:
//   • the prompt the parent LLM writes is the child agent's only seed user message
//   • the asset channel is the derived `references`, present when the agent
//     declares assetNeeds: registration derives it like any Pattern's, the
//     parent LLM fills handles, and the resolution pass resolves them into the
//     child agent's seed inventory at the parent dispatch boundary. The base
//     declares no `references` of its own — it and `name` are reserved input
//     keys, which only a derivation writes.
//   • description goes into transcript metadata / UI, not into the seed
//   • Pattern extra fields: consumed by the author in the system template, never
//     auto-rendered by the framework

import { z } from 'zod'

import { RESERVED_INPUT_KEYS } from './derived-fields'

/**
 * Framework-provided base input schema for every AgentPattern. Pattern
 * authors merge their incremental fields via `agentInputSchema()`.
 */
export const AGENT_BASE_INPUT_SCHEMA = z.object({
  description: z
    .string()
    .min(1, 'description required')
    .describe(
      'A short (3-5 word) task label. Used for UI / transcript title / log only; not part of the subagent\'s LLM context.',
    ),
  prompt: z
    .string()
    .min(1, 'prompt required')
    .describe(
      'Self-contained task brief in natural language. Becomes the subagent\'s first user message. Must contain all context needed to run the task — the subagent does NOT see the parent\'s chat history.',
    ),
})

/** Base input shape inferred from the framework schema. */
export type AgentBaseInput = z.infer<typeof AGENT_BASE_INPUT_SCHEMA>

/**
 * Helper for Pattern authors to declare their AgentPattern's `tool.inputs`
 * schema. Returns the merged schema:
 *
 *     AGENT_BASE_INPUT_SCHEMA ⊕ {...extra}
 *
 * @example
 * ```ts
 * import { agentInputSchema } from '@orchestral/core'
 * import { z } from 'zod'
 *
 * const DirectorAgentInput = agentInputSchema({
 *   targetDurationSec: z.number().min(5).max(120),
 *   characterRefs: z.array(z.string()).optional(),
 *   styleNotes: z.string().optional(),
 * })
 *
 * // parent LLM sees a merged schema:
 * //   { description, prompt, targetDurationSec, characterRefs?, styleNotes? }
 *
 * // Pattern author injects extras into system template:
 * loop: {
 *   system: (input) => `
 *     You are a video director.
 *     Target duration: ${input.targetDurationSec}s
 *     Characters: ${input.characterRefs?.join(', ') ?? 'none'}
 *   `,
 * }
 * ```
 *
 * Field-name collisions with `description` / `prompt` are rejected at
 * dispatch-time via Zod merge semantics (extra wins → bad UX), so we throw
 * eagerly in this factory to surface the error at registration time. The
 * reserved input keys (`references`, `name` — RESERVED_INPUT_KEYS) are refused
 * here too, with their own message: registration derives both, and would
 * refuse a declared one anyway, only later.
 */
export function agentInputSchema<TExtra extends z.ZodRawShape>(
  extra: TExtra,
) {
  for (const key of ['description', 'prompt'] as const) {
    if (key in extra) {
      throw new Error(
        `AGENT_INPUT_RESERVED_FIELD: '${key}' is provided by AGENT_BASE_INPUT_SCHEMA — Pattern authors must not redeclare it.`,
      )
    }
  }
  for (const key of RESERVED_INPUT_KEYS) {
    if (key in extra) {
      throw new Error(
        `AGENT_INPUT_RESERVED_FIELD: '${key}' is reserved: registration derives it (RESERVED_INPUT_KEYS) — do not declare it.`,
      )
    }
  }
  return AGENT_BASE_INPUT_SCHEMA.extend(extra)
}
