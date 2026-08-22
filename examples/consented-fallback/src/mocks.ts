// Offline stand-ins for the two models, built from `ai/test`. main.ts runs on
// these by default (so the narrative records without a key) and the smoke
// test runs on the same ones — the envelopes in ./ai-sdk-wiring never know
// the difference, which is the point: `--live` swaps only the instances.

import { MockImageModelV3, MockLanguageModelV3 } from 'ai/test'
import type { HostModels } from './ai-sdk-wiring'

/** A real 1x1 PNG. The source image "the user wants to edit", and what the
 *  mock image model hands back as the render. */
export const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

export const MOCK_CAPTION =
  'a red bicycle leaning against a sunlit brick wall, flat illustration'

export function mockImageModel(): MockImageModelV3 {
  return new MockImageModelV3({
    provider: 'mock',
    modelId: 'mock-image',
    doGenerate: async () => ({
      images: [PNG_B64],
      warnings: [],
      response: { timestamp: new Date(0), modelId: 'mock-image', headers: {} },
    }),
  })
}

// The mock's own doGenerate result type, so `finishReason` / the content
// discriminant stay narrow (an inline literal would widen them to `string`).
type DoGenerateResult = Awaited<ReturnType<MockLanguageModelV3['doGenerate']>>

/** A "vision model" that answers every prompt with the same caption. It still
 *  records what it was sent (`doGenerateCalls`), which is how the smoke test
 *  proves the source image actually reached the caption step. */
export function mockCaptionModel(caption = MOCK_CAPTION): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-vlm',
    doGenerate: async () => {
      const result: DoGenerateResult = {
        content: [{ type: 'text', text: caption }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 12, text: 12, reasoning: 0 },
        },
        warnings: [],
      }
      return result
    },
  })
}

export function mockModels(): HostModels {
  return {
    image: { provider: 'mock', modelId: 'mock-image', model: mockImageModel() },
    caption: { provider: 'mock', modelId: 'mock-vlm', model: mockCaptionModel() },
  }
}
