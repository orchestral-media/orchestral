// Wiring smoke test — proves the atomic hello-world host links end to end
// (submitJob → router.resolve → ModelCapability.call → output) with NO
// OPENAI_API_KEY. Only difference from main.ts: the model instance is a
// MockImageModelV3 (ai/test) instead of openai.image(...), so the same
// ./ai-sdk-wiring → router → runtime → pattern path runs offline in CI.

import { describe, expect, it } from 'vitest'
import { MockImageModelV3 } from 'ai/test'
import {
  silentDiagnosticsLogger,
  type Artifact,
  PatternRegistry,
} from '@orchestral/core'
import { InMemoryJobStore } from '@orchestral/core/memory'
import { createDefaultCapabilityRouter } from '@orchestral/core/routing'
import {
  createTextToImagePattern,
  TEXT_TO_IMAGE_PATTERN_ID,
  type TextToImageOutput,
} from '@orchestral/patterns'
import { InlineRuntime } from '@orchestral/runtime'
import { createImageModels } from '../ai-sdk-wiring'

// Minimal valid PNG payload — MockImageModelV3 just echoes it back as base64.
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

describe('atomic hello-world wiring', () => {
  it('dispatches text-to-image end to end with a mock model (no API key)', async () => {
    // Identical wiring to src/main.ts, swapping only the model instance.
    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    registry.add(createTextToImagePattern())

    const getModels = createImageModels([
      {
        provider: 'openai',
        modelId: 'gpt-image-1',
        model: mockImageModel(),
      },
    ])
    const router = createDefaultCapabilityRouter({ getModels })
    const artifacts: Artifact[] = []
    const runtime = new InlineRuntime({
      store: new InMemoryJobStore(),
      registry,
      router,
      onJobCreated: (jobId) =>
        runtime.subscribe(jobId, (ev) => {
          if (ev.type === 'job:artifact') artifacts.push(ev.artifact)
        }),
    })

    const job = await runtime.submitJob<{ prompt: string }, TextToImageOutput>({
      patternId: TEXT_TO_IMAGE_PATTERN_ID,
      input: { prompt: 'a red bicycle' },
    })

    // The job ran to completion in this tick.
    expect(job.status).toBe('done')
    expect(job.error).toBeNull()
    expect(job.output).not.toBeNull()

    // The output satisfies the real patterns schema — the load-bearing contract
    // a host relies on when consuming job.output.
    const parsed = createTextToImagePattern().outputs.parse(job.output)
    expect(parsed.modality).toBe('image')
    expect(parsed.model).toBe('openai:gpt-image-1')
    expect(parsed.provider).toBe('openai')

    // The inventory came back on the output — and the bytes did NOT: `url` is
    // unset, because the bounded output is never the channel for a blob.
    expect(parsed.assets).toHaveLength(1)
    expect(parsed.assets[0]!.modality).toBe('image')
    expect(parsed.assets[0]!.url).toBeUndefined()
    // The bytes arrived on `job:artifact`, collected from the creation hook.
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]!.uri).toMatch(/^data:image\/png;base64,/)
  })
})
