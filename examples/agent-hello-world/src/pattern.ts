// The minimal AgentPattern this example dispatches. Self-contained — it does
// not pull in the production agents from @orchestral/agent (those depend on
// host metas and their own inlined prompts). It exposes exactly one tool, the
// `text-to-image` atomic, and instructs the loop's LLM to generate an image
// then report a one-line JSON summary.
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
  boundedText,
  type ZodSchema,
} from '@orchestral/core'
import { TEXT_TO_IMAGE_PATTERN_ID } from '@orchestral/patterns'

// agentInputSchema injects `description` + `prompt` (the seed user message the
// runtime requires) + `references`. The image brief rides in `prompt`.
export const AgentImageInputSchema = agentInputSchema({})
export type AgentImageInput = z.infer<typeof AgentImageInputSchema>

// `summary` only. The image is not in the agent's output: the model never
// sees the bytes — the tool result it reads is projected to handles, and this
// standalone host injects no AgentAssetBridge, so it sees an empty inventory —
// and a bounded output is never the channel for a blob anyway. The host
// collects the generated file from the `job:artifact` event (see main.ts).
export const AgentImageOutputSchema = z.object({
  summary: boundedText(512).describe(
    'One-sentence description of what the agent produced.',
  ),
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
2. The generated image is delivered to the host directly; the tool result will not contain a URL and you do not need to reference the image.
3. Reply with ONLY a JSON object, no prose and no code fence, exactly:
   {"summary": "<one sentence describing the image you asked for>"}

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
      'A minimal image agent: the LLM calls text-to-image once, then reports a one-sentence summary as JSON. The image itself reaches the host as a job:artifact.',
    primary: {
      tool: {
        description:
          'Generate an image from a brief and return a one-sentence summary; the image is delivered to the host out of band.',
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
