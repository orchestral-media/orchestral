// The minimal AgentPattern this example dispatches. Self-contained — it does
// not pull in any of @orchestral/patterns' production agents (those depend on
// host metas / SKILL bodies). It exposes exactly one tool, the `text-to-image`
// atomic, and instructs the loop's LLM to generate an image then report a
// one-line JSON summary.
//
// Output strategy: this Pattern declares `loop.outputExtractor`, so the
// runtime skips injecting its default finish tool for this dispatch and the
// in-process AgentRunImpl returns the natural-finish `{ text }` fallback
// instead. `outputExtractor` lifts typed deliverables out of the LLM's final
// text block (runtime then runs `outputs.parse()` on it). This is the
// @alpha agent-battery analogue of the atomic example's `call` seam.

import { z } from 'zod'
import {
  agentInputSchema,
  type AgentPattern,
  type ZodSchema,
} from '@orchestral/core'
import { TEXT_TO_IMAGE_PATTERN_ID } from '@orchestral/patterns'

// agentInputSchema injects `description` + `prompt` (the seed user message the
// runtime requires) + `references`. The image brief rides in `prompt`.
export const AgentImageInputSchema = agentInputSchema({})
export type AgentImageInput = z.infer<typeof AgentImageInputSchema>

export const AgentImageOutputSchema = z.object({
  imageUrl: z
    .string()
    .describe('URL (data URI in the standalone bridge) of the generated image.'),
  summary: z
    .string()
    .describe('One-sentence description of what the agent produced.'),
})
export type AgentImageOutput = z.infer<typeof AgentImageOutputSchema>

export const AGENT_HELLO_WORLD_PATTERN_ID = 'agent_hello-world-image'

// The loop's system prompt. Static (no per-dispatch params), so it doubles as
// the cacheable prefix. It tells the LLM to call the one tool it has, then to
// emit ONLY a JSON object matching the output schema as its final message —
// which `outputExtractor` (below) parses.
const SYSTEM = `You are an image agent. You have a single tool: \`text-to-image\`, which generates an image from a text prompt and returns the produced asset(s).

Your job, given the user's brief:
1. Call \`text-to-image\` once with a vivid prompt derived from the brief.
2. Read the tool result — it contains \`assets[0].url\` (the generated image).
3. Reply with ONLY a JSON object, no prose and no code fence, exactly:
   {"imageUrl": "<assets[0].url>", "summary": "<one sentence describing the image>"}

Do not call the tool more than once.`

/**
 * Lift the typed output from the LLM's final text. Tolerant of an accidental
 * ```json fence the model may wrap around the object.
 */
function extractAgentImageOutput(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = (fenced ? fenced[1] : text).trim()
  return JSON.parse(body)
}

export function createAgentHelloWorldPattern(): AgentPattern<
  AgentImageInput,
  AgentImageOutput
> {
  return {
    id: AGENT_HELLO_WORLD_PATTERN_ID,
    kind: 'agent',
    searchHint: 'generate an image and summarize it via an LLM agent loop',
    namespace: 'image-gen',
    description:
      'A minimal image agent: the LLM calls text-to-image once, then reports the produced image URL plus a one-sentence summary as JSON.',
    primary: {
      tool: {
        description:
          'Generate an image from a brief and return its URL with a one-sentence summary.',
        inputs: AgentImageInputSchema as unknown as ZodSchema<AgentImageInput>,
      },
    },
    outputs: AgentImageOutputSchema as unknown as ZodSchema<AgentImageOutput>,
    loop: {
      system: SYSTEM,
      toolPatternIds: [TEXT_TO_IMAGE_PATTERN_ID],
      modelTags: [],
      // Declaring outputExtractor tells the runtime not to inject its
      // default finish tool for this Pattern — lift typed output from the
      // final text block instead. Runtime parses the return against
      // `outputs`.
      outputExtractor: extractAgentImageOutput,
    },
  }
}
