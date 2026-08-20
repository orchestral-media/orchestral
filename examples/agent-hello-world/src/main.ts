// Agent hello-world — the whole host.
//
// Like the atomic example, a from-scratch host needs ONLY the published
// @orchestral/* packages plus its own ai-sdk model instances (built with its
// own API key) and the small host-local adapters that bridge them. The agent
// path adds one adapter beyond the atomic example: an AgentRunImpl that drives
// the LLM tool-loop, in ./agent-runner.ts. Orchestral does not ship one — the
// same rule that leaves `ModelCapability.call` to the host leaves the agent
// loop to it too, since a loop implementation is an agent-framework choice.
// The file next door is that ~150-line adapter over the ai-sdk's ToolLoopAgent;
// copy it into your own host and you're done. No worker, no IPC, no DB.
//
// Two models are in play:
//   • the agent loop's LLM (resolved by `resolveModel`), which decides to call
//     the text-to-image tool and then writes the JSON summary, and
//   • the text-to-image model (in the registry / router), which the tool call
//     dispatches through.

import { openai } from '@ai-sdk/openai'
import {
  createDefaultCapabilityRouter,
  InMemoryJobStore,
  PatternRegistry,
} from '@orchestral/core'
import { createTextToImagePattern } from '@orchestral/patterns'
import { InlineRuntime } from '@orchestral/runtime'
import { createInProcessAgentRunImpl } from './agent-runner'
import { createImageModels } from './ai-sdk-wiring'
import {
  AGENT_HELLO_WORLD_PATTERN_ID,
  createAgentHelloWorldPattern,
  type AgentImageOutput,
} from './pattern'

if (!process.env.OPENAI_API_KEY) {
  console.error(
    'Missing OPENAI_API_KEY.\n' +
      'Export a key first, e.g.  export OPENAI_API_KEY=sk-...\n' +
      '(no key? run `pnpm --filter agent-hello-world test` — the smoke test ' +
      'exercises the same wiring with a mock LLM and needs no key.)',
  )
  process.exit(1)
}

// 1. Register the agent Pattern AND the atomic tool it dispatches. The agent's
//    loop.toolPatternIds names 'text-to-image', so that atomic must be in the
//    registry for the loop to resolve + dispatch it.
const registry = new PatternRegistry()
registry.add(createAgentHelloWorldPattern())
registry.add(createTextToImagePattern())

// 2. The model that serves the text-to-image TOOL call (router territory),
//    bridged by the same host-local ai-sdk wiring the atomic example uses.
const getModels = createImageModels([
  {
    provider: 'openai',
    modelId: 'gpt-image-1',
    model: openai.image('gpt-image-1'),
  },
])
const router = createDefaultCapabilityRouter({ getModels })

// 3. The host-local in-process AgentRunImpl (./agent-runner.ts, written over
//    this host's own copy of `ai`). Its only host-shaped seam is
//    `resolveModel`: map the loop's modelTags to a concrete ai-sdk LLM instance
//    (BYOK). This demo serves one chat model regardless of tags. `stopWhen`
//    defaults to a 16-step cap — fine for a single-tool loop.
const agentRunImpl = createInProcessAgentRunImpl({
  resolveModel: () => openai('gpt-4o'),
})

// 4. In-process runtime over the zero-dependency in-memory JobStore, now with
//    the agent runner injected.
const runtime = new InlineRuntime({
  store: new InMemoryJobStore(),
  registry,
  router,
  agentRunImpl,
})

// 5. Dispatch the agent. The LLM loop runs to completion; the awaited Job is
//    already `done` with the extracted, schema-validated output.
const job = await runtime.submitJob<
  { description: string; prompt: string },
  AgentImageOutput
>({
  patternId: AGENT_HELLO_WORLD_PATTERN_ID,
  // description + prompt are the two AGENT_BASE_INPUT_SCHEMA fields — both are
  // `.min(1)` required, so the example honors its own agentInputSchema({})
  // contract (a tool-composed call would Zod-validate this input).
  input: {
    description: 'red bicycle',
    prompt:
      'a red bicycle leaning against a sunlit brick wall, golden hour, photoreal',
  },
})

if (job.status !== 'done' || !job.output) {
  console.error(`Agent dispatch did not complete: status=${job.status}`, job.error)
  process.exit(1)
}

console.log(`Agent summary: ${job.output.summary}`)
const uri = job.output.imageUrl
const preview = uri.length > 64 ? `${uri.slice(0, 64)}…` : uri
console.log(`Image: ${preview}`)
