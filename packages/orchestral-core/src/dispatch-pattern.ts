// dispatch_pattern — the Pattern invocation primitive.
//
// LLM emits `dispatch_pattern({pattern_id, input})` after finding a Pattern
// via find_pattern. This module owns the input validation + scope contract;
// the actual dispatch (submitJob, resolution, inner-job tracking) stays in
// the host because it needs runtime + per-session context this layer
// doesn't have.
//
// Validation lives here rather than at each call site, so the chat-turn and
// agent-loop dispatch paths share one source of truth on:
//   • pattern_id resolution
//   • exposure / audience scope enforcement (chat-turn vs agent-loop)
//   • zod parse with structured error reporting for LLM self-correction
//
// Capability sub-modes are expressed via input.references asset slots +
// typed providerOptions schema.

import { z, type ZodType } from 'zod'

import type { Pattern, PatternExposure } from './pattern'
import { resolveExposure } from './pattern'
import type { PatternRegistry } from './registry'

/** LLM-facing input contract for the dispatch_pattern catalog tool. */
export const DispatchPatternInputSchema = z.object({
  pattern_id: z
    .string()
    .min(1)
    .describe(
      'Pattern id returned by find_pattern (e.g. "text-to-image", "image-to-image", "meta_image-to-image-via-caption").',
    ),
  input: z
    .record(z.string(), z.unknown())
    .describe(
      "Pattern-specific input fields. See find_pattern's primary.inputSchema for the derived schema (with the resolved top-1 model's typed providerOptions fields lifted in). Assets are referenced by HANDLE via `input.references.<slot>` — never pass raw asset ids. For OPTIONAL attachments (mask / end-frame / reference / voiceClone), read the per-slot descriptions inside the schema's `references` object — unknown slot keys are rejected.",
    ),
})
export type DispatchPatternInput = z.infer<typeof DispatchPatternInputSchema>

/**
 * Audience hint for scope enforcement. Mirrors find_pattern, plus `'slash'`
 * for the user-driven by-id dispatch surface. Slash
 * bypasses find_pattern discovery — the user supplies the exact pattern id —
 * so the gate is `resolveExposure(...).slash` rather than the LLM surfaces.
 * `'canvas'` is the per-node canvas-workflow dispatch surface: a canvas node
 * calls dispatch_pattern directly by id (no find_pattern hop, same as
 * slash), gated on `resolveExposure(...).canvas` — fail-closed like every
 * other surface, so a Pattern must opt in via `exposure.canvas` before a
 * canvas node can dispatch it.
 */
export type DispatchAudience = 'chat-turn' | 'agent-loop' | 'slash' | 'canvas'

/**
 * Discriminated union of dispatch-resolution failures. Every variant carries
 * a `code` literal so consumers narrow with `switch (err.code)` and TS knows
 * which side-fields are populated. Returned (not thrown) by
 * `resolveDispatchTarget` so the host can ship the JSON into a tool_result
 * for LLM self-correction.
 */
export type DispatchPatternError =
  | {
      code: 'PATTERN_NOT_FOUND'
      pattern_id: string
      message: string
      hint: string
    }
  | {
      code: 'AGENT_HOST_ONLY'
      pattern_id: string
      message: string
    }
  | {
      code: 'INPUT_VALIDATION_FAILED'
      pattern_id: string
      issues: readonly z.core.$ZodIssue[]
      message: string
      hint: string
    }
  | {
      code: 'PATTERN_NOT_DISPATCHABLE'
      pattern_id: string
      exposure: PatternExposure
      audience: DispatchAudience
      message: string
      hint: string
    }

export interface ResolvedDispatchTarget {
  pattern: Pattern
  /** Validated + parsed input ready to forward to runtime.submitJob. */
  parsedInput: Record<string, unknown>
}

/**
 * Resolve the dispatch target and validate input. Pure function — host
 * caller takes the resolved target and delegates to its dispatch pipeline —
 * both the chat-turn tool-call handler and the agent loop's onToolCall end up
 * calling runtime.submitJob with the parsed input.
 *
 * `audience` enforces the exposure scope contract symmetrically to
 * find_pattern: `exposure='no-tool'` Patterns are host-only and rejected
 * for both audiences; `exposure='agent-tool'` Patterns are subagent-only
 * and rejected for chat-turn. Without this enforcement the catalog
 * filter on find_pattern would be a cosmetic discovery aid only — a
 * hallucinating / replaying LLM could still dispatch any registered
 * Pattern by id.
 */
export function resolveDispatchTarget(
  registry: PatternRegistry,
  input: DispatchPatternInput,
  audience: DispatchAudience,
): ResolvedDispatchTarget | DispatchPatternError {
  const entry = registry.getEntry(input.pattern_id)
  if (!entry) {
    return {
      code: 'PATTERN_NOT_FOUND',
      pattern_id: input.pattern_id,
      message: `Pattern "${input.pattern_id}" is not registered.`,
      hint: 'Call find_pattern with a relevant query to discover valid pattern_id values.',
    }
  }
  const { pattern } = entry

  // Exposure / audience scope enforcement — symmetric to find_pattern's
  // catalog-side filter. find_pattern already hides non-dispatchable
  // Patterns from the LLM's view; this branch is the runtime gate against
  // a Pattern id the LLM produced from memory / training data / leaked
  // state without going through find_pattern.
  // Per-surface visibility comes from resolveExposure (back-compat with the
  // 'tool'/'agent-tool'/'no-tool' shorthand). The raw `exposure` is echoed
  // unchanged in the error payload for diagnostics.
  const exposure: PatternExposure = pattern.exposure ?? 'tool'
  const resolved = resolveExposure(pattern.exposure)
  const visibleToAudience =
    audience === 'agent-loop'
      ? resolved.agentLoop
      : audience === 'slash'
        ? resolved.slash
        : audience === 'canvas'
          ? resolved.canvas
          : resolved.chatTurn
  if (!visibleToAudience) {
    // No surface can dispatch this Pattern under the requested audience.
    // Distinguish "host-only everywhere" (both LLM surfaces closed) from
    // "subagent-only" (chat-turn closed but agent-loop open) for a clearer
    // hint, matching the prior shorthand messages. Slash gets its own hint
    // since it doesn't go through find_pattern.
    const hostOnly = !resolved.chatTurn && !resolved.agentLoop
    return {
      code: 'PATTERN_NOT_DISPATCHABLE',
      pattern_id: input.pattern_id,
      exposure,
      audience,
      message:
        audience === 'slash'
          ? `Pattern "${input.pattern_id}" is not exposed to slash commands.`
          : audience === 'canvas'
            ? `Pattern "${input.pattern_id}" is not exposed to the canvas.`
            : hostOnly
              ? `Pattern "${input.pattern_id}" is host-only and cannot be dispatched by any LLM.`
              : `Pattern "${input.pattern_id}" is not visible to the '${audience}' surface.`,
      hint:
        audience === 'slash'
          ? 'Set exposure.slash to true on the Pattern to allow user slash dispatch.'
          : audience === 'canvas'
            ? 'Set exposure.canvas to true on the Pattern to allow canvas-node dispatch.'
            : hostOnly
              ? 'Use find_pattern to discover Patterns visible to this audience.'
              : 'Use find_pattern from this audience to see Patterns appropriate for this surface.',
    }
  }

  const schema = selectInputSchema(pattern)
  if (!schema) {
    return {
      code: 'AGENT_HOST_ONLY',
      pattern_id: input.pattern_id,
      message: `Pattern "${input.pattern_id}" has no LLM-callable primary tool (host-only agent).`,
    }
  }

  // The `Pattern.input` schema no longer declares a `providerOptions`
  // placeholder field. The LLM-facing schema returned by find_pattern IS
  // extended via `deriveLlmFacingInputSchema` (typed `providerOptions:
  // z.object(remaining)` + lifted LIFTABLE fields), but dispatch_pattern
  // validates against the un-derived base schema for host portability — so
  // we must accept LLM-filled extra keys (providerOptions / lifted fields)
  // here, otherwise zod v4 strict parse strips them silently and the host
  // adapter sees an empty providerOptions / missing lifted constraints.
  //
  // Switching the base schema to passthrough on parse is the minimal fix:
  //  - all declared base fields still validate strictly (e.g. prompt required,
  //    a numeric field with integer min/max bounds)
  //  - LLM-filled extras (providerOptions blob, lifted top-level fields)
  //    pass through to `parsedInput` for the host to forward
  const parseSchema =
    'passthrough' in schema && typeof (schema as { passthrough?: unknown }).passthrough === 'function'
      ? ((schema as unknown as { passthrough: () => ZodType<unknown> }).passthrough() as ZodType<unknown>)
      : schema
  const parseResult = parseSchema.safeParse(input.input)
  if (!parseResult.success) {
    // When the LLM guessed a reference slot name (e.g. `reference` instead of
    // `source`/`mask`), zod reports `unrecognized_keys` under path ['references']
    // but the default hint says nothing about which slots exist — the model then
    // burns turns guessing synonyms. Mirror HANDLE_NOT_FOUND's meta.available
    // self-correction design: list the pattern's declared reference slots so the
    // model can pick a real one on the next call.
    const refSlotHint = buildReferenceSlotHint(parseResult.error.issues, pattern)
    return {
      code: 'INPUT_VALIDATION_FAILED',
      pattern_id: input.pattern_id,
      issues: parseResult.error.issues,
      message: `Input validation failed for "${input.pattern_id}". See issues[] for field-level errors.`,
      hint:
        (refSlotHint ? `${refSlotHint} ` : '') +
        'Fix the listed fields and call dispatch_pattern again. Re-fetch the schema via find_pattern if uncertain.',
    }
  }

  return {
    pattern,
    parsedInput: parseResult.data as Record<string, unknown>,
  }
}

/**
 * Select the zod schema to validate `input` against. Meta uses its
 * top-level tool.inputs; atomic / agent use their primary.tool.inputs
 * directly.
 */
function selectInputSchema(pattern: Pattern): ZodType<unknown> | undefined {
  if (pattern.kind === 'meta') {
    return pattern.tool.inputs as unknown as ZodType<unknown>
  }
  if (!pattern.primary) return undefined
  return pattern.primary.tool.inputs as unknown as ZodType<unknown>
}

/**
 * If the parse failure includes an `unrecognized_keys` issue under the
 * `references` object, return a sentence naming the offending key(s) and the
 * pattern's actually-declared reference slots. Returns null when no reference
 * slot was misnamed (or the pattern declares no asset slots), so the caller
 * only augments the hint in the slot-typo case.
 */
function buildReferenceSlotHint(
  issues: readonly z.core.$ZodIssue[],
  pattern: Pattern,
): string | null {
  const declaredSlots = (pattern.assetNeeds ?? []).map((n) => n.slot)
  if (declaredSlots.length === 0) return null
  const badKeys = new Set<string>()
  for (const issue of issues) {
    if (
      issue.code === 'unrecognized_keys' &&
      issue.path.length === 1 &&
      issue.path[0] === 'references'
    ) {
      for (const k of issue.keys) badKeys.add(k)
    }
  }
  if (badKeys.size === 0) return null
  return (
    `Unknown references slot${badKeys.size > 1 ? 's' : ''} ` +
    `[${[...badKeys].join(', ')}] — this pattern only accepts ` +
    `references.{${declaredSlots.join(' | ')}}.`
  )
}

/** Type guard: did resolveDispatchTarget return a target or an error? */
export function isDispatchError(
  result: ResolvedDispatchTarget | DispatchPatternError,
): result is DispatchPatternError {
  return 'code' in result
}
