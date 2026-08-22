// meta_novel-to-events — MetaPattern that consumes the
// next-event-extraction skill.
//
// Decompose a long-form prose work into a causal chain of plot events:
//   1. Optionally pre-compress the prose via meta_prose-chunking when it
//      exceeds `compressBeyond` (char count, not token — string-length
//      based to match the host-side chunker threshold).
//   2. Iteratively call text-generation with next-event-extraction as
//      system; each call gets the (working) prose + already-extracted
//      events and returns the next Event {index, description, timeframe,
//      characters, cause, process, outcome, is_last}.
//   3. Stop when `is_last === true` OR `events.length >= maxEvents`
//      safeguard (LLM-self-reported termination + a host-side cap).
//
// Loop bound: deterministic — the skill signals via `is_last`, the host
// enforces `maxEvents`. No agent escalation needed: an adaptive event count
// alone doesn't warrant promoting this to an agent kind.
//
// The next-event-extraction prompt is inlined as a string constant in
// ./prompts — nothing is loaded at dispatch.
//
// Exposure: 'agent-tool' — agent-only entry point; chat catalog hides.

import { z } from 'zod'
import type { MetaPattern } from '@orchestral/core'
import { metaEnvelopeShape } from '@orchestral/core'
import { resolvePrompts, sumCosts, textGeneration, toJsonSchemaCached } from '@orchestral/patterns'
import { proseChunkingMeta } from '../prose-chunking'
import { NEXT_EVENT_EXTRACTION_PROMPT } from './prompts'

// Event response shape (matches the next-event-extraction output).
export const EventResponseSchema = z.object({
  index: z.number().int().min(0),
  description: z.string(),
  timeframe: z.string(),
  characters: z.string(),
  cause: z.string(),
  process: z.string(),
  outcome: z.string(),
  is_last: z.boolean(),
})
/** @alpha */
export type Event = z.infer<typeof EventResponseSchema>

// ── input / output ──────────────────────────────────────────────────────

export const NovelToEventsInputSchema = z.object({
  prose: z
    .string()
    .min(1, 'prose required')
    .describe('The novel / long-form prose to decompose into a causal event chain.'),
  maxEvents: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(50)
    .optional()
    .describe(
      'Safeguard cap on the number of events extracted. Loop also terminates earlier when the SKILL self-reports is_last === true.',
    ),
  compressBeyond: z
    .number()
    .int()
    .min(0)
    .default(60_000)
    .optional()
    .describe(
      'When prose.length exceeds this char threshold, nest meta_prose-chunking first and walk events on the compressed aggregate instead of the raw source. Disable by setting to 0 to always pass raw prose through.',
    ),
})
export type NovelToEventsInput = z.infer<typeof NovelToEventsInputSchema>

export const NovelToEventsOutputSchema = z.object({
  events: z
    .array(EventResponseSchema)
    .readonly()
    .describe(
      'Ordered causal chain of events extracted from the prose. Length ≤ maxEvents; the final entry has is_last === true unless the safeguard cap fired first.',
    ),
  cost: metaEnvelopeShape.cost.describe(
    'USD cost summed across all per-event calls (+ chunking cost if engaged).',
  ),
  latencyMs: metaEnvelopeShape.latencyMs
    .int()
    .min(0)
    .describe(
      'Wall-clock latency summed across all per-event calls (sequential by design) plus the chunking step if engaged.',
    ),
})
export type NovelToEventsOutput = z.infer<typeof NovelToEventsOutputSchema>

export const NOVEL_TO_EVENTS_PATTERN_ID = 'meta_novel-to-events'

// ── factory ──────────────────────────────────────────────────────────────

/**
 * @alpha
 * Default system prompt for meta_novel-to-events. Consumers override via
 * `NovelToEventsMetaInit.prompts`; the unset key falls back to this.
 */
export const NOVEL_TO_EVENTS_DEFAULT_PROMPTS = Object.freeze({
  nextEventExtraction: NEXT_EVENT_EXTRACTION_PROMPT,
})

/** @alpha Per-step prompt overrides for meta_novel-to-events. */
export type NovelToEventsPromptOverrides = Partial<
  Record<keyof typeof NOVEL_TO_EVENTS_DEFAULT_PROMPTS, string>
>

/** @alpha Optional init for meta_novel-to-events (prompt overrides only). */
export type NovelToEventsMetaInit = {
  prompts?: NovelToEventsPromptOverrides
}

/** @alpha */
export function createNovelToEventsMeta(
  init: NovelToEventsMetaInit = {},
): MetaPattern<NovelToEventsInput, NovelToEventsOutput> {
  const resolved = resolvePrompts(NOVEL_TO_EVENTS_DEFAULT_PROMPTS, init.prompts)
  return {
    id: NOVEL_TO_EVENTS_PATTERN_ID,
    kind: 'meta',
    searchHint:
      'decompose a long novel into a causal chain of plot events with characters and outcomes',
    namespace: 'meta-pipelines',
    exposure: 'agent-tool',
    description:
      'Walk a novel into a causal chain of plot events. Optionally pre-compresses the prose via meta_prose-chunking when it exceeds a char threshold, then iteratively extracts events one at a time via the next-event-extraction skill until the model self-reports the chain is complete (or a safeguard cap is reached).',
    tool: {
      description:
        'Decompose a novel (or any long-form prose) into a causal chain of plot events. Each event captures timeframe, characters, cause, process, outcome. Use upstream of per-event screenplay adaptation or per-event scene rendering.',
      inputs: NovelToEventsInputSchema,
    },
    outputs: NovelToEventsOutputSchema,
    async compose(params, ctx): Promise<NovelToEventsOutput> {
      const { input } = params

      // Stage 1 — optional pre-compression. Threshold is char-based to
      // match the chunker's internal token≈4chars heuristic; "60_000 chars"
      // approximates "15K tokens" — small enough to fit modern context
      // windows comfortably as a single LLM input.
      const compressThreshold = input.compressBeyond ?? 60_000
      let workingProse = input.prose
      let chunkingCost: number | null = 0
      let chunkingLatencyMs = 0
      if (compressThreshold > 0 && input.prose.length > compressThreshold) {
        const chunkOut = await proseChunkingMeta(ctx, { prose: input.prose })
        workingProse = chunkOut.aggregatedNarrative
        chunkingCost = sumCosts([chunkOut.cost])
        chunkingLatencyMs = chunkOut.latencyMs
      }

      // Stage 2 — iterative event extraction. Sequential by design: each
      // round needs the prior events as context for "the next" event.
      const events: Event[] = []
      const maxEvents = input.maxEvents ?? 50
      let eventCost: number | null = 0
      let eventLatencyMs = 0

      while (events.length < maxEvents) {
        const out = await textGeneration(
          ctx,
          {
            system: resolved.nextEventExtraction,
            prompt: buildEventExtractionPrompt(workingProse, events),
            responseFormat: 'json',
            jsonSchema: toJsonSchemaCached(EventResponseSchema),
          },
          { stepId: `event-${events.length}` },
        )
        const parsed = EventResponseSchema.parse(JSON.parse(out.text))
        events.push(parsed)
        eventCost = sumCosts([eventCost, out.cost])
        eventLatencyMs += out.latencyMs
        if (parsed.is_last) break
      }

      return {
        events,
        cost: sumCosts([chunkingCost, eventCost]),
        latencyMs: chunkingLatencyMs + eventLatencyMs,
      }
    },
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function buildEventExtractionPrompt(
  workingProse: string,
  priorEvents: readonly Event[],
): string {
  const eventsBlock =
    priorEvents.length === 0
      ? '<EXTRACTED_EVENTS_START>\n<EXTRACTED_EVENTS_END>'
      : `<EXTRACTED_EVENTS_START>\n${priorEvents.map(renderEvent).join('\n\n')}\n<EXTRACTED_EVENTS_END>`
  return `<NOVEL_TEXT_START>\n${workingProse}\n<NOVEL_TEXT_END>\n\n${eventsBlock}`
}

function renderEvent(e: Event): string {
  return [
    `<Event ${e.index}>`,
    `Description: ${e.description}`,
    `Timeframe: ${e.timeframe}`,
    `Characters: ${e.characters}`,
    `Cause: ${e.cause}`,
    `Process: ${e.process}`,
    `Outcome: ${e.outcome}`,
  ].join('\n')
}
