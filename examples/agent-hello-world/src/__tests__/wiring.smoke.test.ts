// Wiring smoke test — proves the agent hello-world host links end to end with
// NO OPENAI_API_KEY. A scripted MockLanguageModelV3 (ai/test) drives the loop:
//   step 1 → emit a `text-to-image` tool call
//   (runtime dispatches it through the router → MockImageModelV3)
//   step 2 → emit the final JSON object the pattern's outputExtractor parses
//
// Test 1 asserts the agent job reaches `done`, its `outputs` parse against the
// pattern's schema, and the host's `resolveModel` seam was consulted. Test 2 is
// the one that proves the loop actually recursed into the runtime — it spies the
// image model's doGenerate to confirm the tool call round-tripped all the way to
// the model. Same router / runtime / pattern path as src/main.ts, swapping only
// the two model instances — including the same host-local `../agent-runner`,
// so this covers the reference AgentRunImpl a reader is meant to copy.

import { describe, expect, it, vi } from 'vitest'
import { MockImageModelV3, MockLanguageModelV3 } from 'ai/test'
import {
  silentDiagnosticsLogger,
  type Artifact,
  PatternRegistry,
} from '@orchestral/core'
import { InMemoryJobStore } from '@orchestral/core/memory'
import { createDefaultCapabilityRouter } from '@orchestral/core/routing'
import { createPatternSearch } from '@orchestral/discovery'
import { createTextToImagePattern } from '@orchestral/patterns'
import { InlineRuntime } from '@orchestral/runtime'
import { createInProcessAgentRunImpl } from '../agent-runner'
import { createImageModels } from '../ai-sdk-wiring'
import {
  AGENT_HELLO_WORLD_PATTERN_ID,
  AgentImageOutputSchema,
  createAgentHelloWorldPattern,
  type AgentImageOutput,
} from '../pattern'

// Minimal valid PNG payload — MockImageModelV3 echoes it back as base64.
const PNG_B64 = 'aVZCT1J3MEtHZ29BQUFBTlNVaEVVZ0E='

function mockImageModel(): MockImageModelV3 {
  return new MockImageModelV3({
    provider: 'openai',
    modelId: 'gpt-image-1',
    doGenerate: async () => ({
      images: [PNG_B64],
      warnings: [],
      response: { timestamp: new Date(0), modelId: 'gpt-image-1', headers: {} },
    }),
  })
}

const ZERO_USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
}

// The mock's own doGenerate field type — annotating each scripted result with
// it keeps `finishReason` / content-part discriminants narrow (an inline
// object would widen `finishReason` to `string`). Pulled off the mock class so
// we don't import LanguageModelV3GenerateResult from @ai-sdk/provider.
type DoGenerate = MockLanguageModelV3['doGenerate']
type DoGenerateResult = Awaited<ReturnType<DoGenerate>>

// A two-step LLM script. doGenerate is called once per loop step; the first
// call emits the tool call, the second (after the tool result is folded into
// history) emits the final JSON answer.
function scriptedLlm(): MockLanguageModelV3 {
  let call = 0
  const doGenerate: DoGenerate = async () => {
    call += 1
    if (call === 1) {
      const toolCallStep: DoGenerateResult = {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'text-to-image',
            input: JSON.stringify({ prompt: 'a red bicycle' }),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
        usage: ZERO_USAGE,
        warnings: [],
      }
      return toolCallStep
    }
    const finalStep: DoGenerateResult = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            summary: 'A red bicycle leaning against a wall.',
          }),
        },
      ],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: ZERO_USAGE,
      warnings: [],
    }
    return finalStep
  }
  return new MockLanguageModelV3({ provider: 'openai', modelId: 'gpt-4o', doGenerate })
}

describe('agent hello-world wiring', () => {
  it('runs the agent loop end to end with a mock LLM (no API key)', async () => {
    // Identical wiring to src/main.ts, swapping only the model instances.
    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    registry.add(createAgentHelloWorldPattern())
    registry.add(createTextToImagePattern())

    const getModels = createImageModels([
      {
        provider: 'openai',
        modelId: 'gpt-image-1',
        model: mockImageModel(),
      },
    ])
    const router = createDefaultCapabilityRouter({ getModels })

    // resolveModel hands the loop the scripted LLM. Spy on it to assert the
    // in-process AgentRunImpl actually consulted the host's resolver.
    const resolveModel = vi.fn(() => scriptedLlm())
    const agentRunImpl = createInProcessAgentRunImpl({ resolveModel })

    // The image bytes arrive on the text-to-image CHILD job's `job:artifact`;
    // the creation hook fires for every job in the tree, so one subscription
    // from it sees the child's artifact.
    const artifacts: Artifact[] = []
    const runtime = new InlineRuntime({
      store: new InMemoryJobStore(),
      registry,
      router,
      agentRunImpl,
      patternSearch: createPatternSearch(registry, { router }),
      onJobCreated: (jobId) =>
        runtime.subscribe(jobId, (ev) => {
          if (ev.type === 'job:artifact') artifacts.push(ev.artifact)
        }),
    })

    const job = await runtime.submitJob<
      { description: string; prompt: string },
      AgentImageOutput
    >({
      patternId: AGENT_HELLO_WORLD_PATTERN_ID,
      input: { description: 'red bicycle', prompt: 'draw a red bicycle' },
    })

    // The agent loop ran to completion in this tick.
    expect(job.status).toBe('done')
    expect(job.error).toBeNull()
    expect(job.output).not.toBeNull()

    // The host resolver was consulted (model resolution is the injected seam).
    expect(resolveModel).toHaveBeenCalledOnce()

    // outputExtractor lifted typed deliverables from the final text, and they
    // satisfy the agent pattern's real outputs schema — the load-bearing
    // contract runtime enforces via pattern.outputs.parse().
    const parsed = AgentImageOutputSchema.parse(job.output)
    expect(parsed.summary).toBe('A red bicycle leaning against a wall.')
    expect(parsed).not.toHaveProperty('imageUrl')
    // The image reached the host on the CHILD job's `job:artifact`, through
    // the one subscription made from the creation hook — never via the agent.
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]!.uri).toMatch(/^data:image\/png;base64,/)
  })

  it('recurses through onToolCall into the runtime for the tool dispatch', async () => {
    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    registry.add(createAgentHelloWorldPattern())
    registry.add(createTextToImagePattern())

    // Spy on the image model's doGenerate to prove the tool call actually
    // round-tripped: onToolCall → runtime.submitJob(text-to-image) → router →
    // ModelCapability.call → this image model.
    const imageGen = vi.fn(async () => ({
      images: [PNG_B64],
      warnings: [] as never[],
      response: { timestamp: new Date(0), modelId: 'gpt-image-1', headers: {} },
    }))
    const imageModel = new MockImageModelV3({
      provider: 'openai',
      modelId: 'gpt-image-1',
      doGenerate: imageGen,
    })

    const getModels = createImageModels([
      {
        provider: 'openai',
        modelId: 'gpt-image-1',
        model: imageModel,
      },
    ])
    const router = createDefaultCapabilityRouter({ getModels })
    const agentRunImpl = createInProcessAgentRunImpl({
      resolveModel: () => scriptedLlm(),
    })
    // No `patternSearch` here, deliberately: this agent's one tool is
    // always-load, so it reaches the loop as a direct tool and the loop runs
    // to completion with no find_pattern in its catalog at all.
    const runtime = new InlineRuntime({
      store: new InMemoryJobStore(),
      registry,
      router,
      agentRunImpl,
    })

    const job = await runtime.submitJob<
      { description: string; prompt: string },
      AgentImageOutput
    >({
      patternId: AGENT_HELLO_WORLD_PATTERN_ID,
      input: { description: 'red bicycle', prompt: 'draw a red bicycle' },
    })

    expect(job.status).toBe('done')
    // The reverse onToolCall hook recursed all the way into the image model.
    expect(imageGen).toHaveBeenCalledOnce()
  })
})
