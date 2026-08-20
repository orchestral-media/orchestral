// Host-local ai-sdk wiring for the text-to-image TOOL the agent calls. Same
// shape as the atomic example's ai-sdk-wiring.ts — kept example-local (not
// imported across packages) so this example stands alone. The @orchestral
// packages never import a provider SDK; bridging an ai-sdk ImageModel to the
// orchestral `call` contract is host territory, which is what this file shows.

import { generateImage } from 'ai'
import type {
  CallEvents,
  Capability,
  DispatchContext,
  ModelCapability,
  ModelTag,
  DispatchResult,
} from '@orchestral/core'
import { MODEL_SPEC_VERSION } from '@orchestral/core'

// The resolved ImageModel OBJECT type, pulled out of generateImage's signature
// (avoids a transitive @ai-sdk/provider import). A host passes the instance it
// built from `openai.image(...)`.
type ImageModelInstance = Exclude<
  Parameters<typeof generateImage>[0]['model'],
  string
>
type AiSdkProviderOptions = NonNullable<
  Parameters<typeof generateImage>[0]['providerOptions']
>

/** One model the host serves for text-to-image, with its own ai-sdk
 * ImageModel instance (built with its own BYOK key). */
export interface ImageModelSpec {
  provider: string
  modelId: string
  model: ImageModelInstance
  tags?: readonly ModelTag[]
}

function readPrompt(input: unknown): string {
  if (input && typeof input === 'object' && 'prompt' in input) {
    const prompt = (input as { prompt?: unknown }).prompt
    if (typeof prompt === 'string' && prompt.length > 0) return prompt
  }
  throw new Error('text-to-image call: input.prompt (non-empty string) is required')
}

// Bridge a single ai-sdk ImageModel to a `ModelCapability.call` closure. Output
// matches patterns' TextToImageOutputSchema field-for-field so
// `pattern.outputs.parse()` succeeds.
function imageCall(model: ImageModelInstance): ModelCapability['call'] {
  return async function aiSdkImageCall<I, O>(
    input: I,
    ctx: DispatchContext,
    events?: CallEvents,
  ): Promise<DispatchResult<O>> {
    const prompt = readPrompt(input)

    const startedAt = Date.now()
    const { images } = await generateImage({
      model,
      prompt,
      // ctx.providerOptions is host-validated at the dispatch boundary; cast at
      // this trusted seam to ai-sdk's stricter wire contract.
      ...(ctx.providerOptions
        ? { providerOptions: ctx.providerOptions as AiSdkProviderOptions }
        : {}),
      abortSignal: ctx.signal,
    })

    const latencyMs = Date.now() - startedAt
    const produced = (images ?? []).filter((img) => !!img?.base64)
    if (produced.length === 0) {
      throw new Error(`${model.provider}: ai-sdk image generation returned no images`)
    }

    const artifacts = produced.map((img) => {
      const mime = img.mediaType || 'image/png'
      return { kind: 'image' as const, uri: `data:${mime};base64,${img.base64}`, mime }
    })
    for (const artifact of artifacts) events?.onArtifact?.(artifact)

    // Standalone host has no asset store, so `url` is the data URI.
    const output = {
      modality: 'image' as const,
      assets: artifacts.map((artifact, i) => ({
        assetId: `aisdk-image-${i}`,
        modality: 'image' as const,
        url: artifact.uri,
      })),
      cost: 0,
      latencyMs,
      model: `${model.provider}:${model.modelId}`,
      provider: model.provider,
    }

    return { output: output as O, artifacts }
  }
}

/**
 * Pack image-model specs into a `getModels(cap)` the default router consumes.
 * Hand the returned `getModels` straight to `createDefaultCapabilityRouter`.
 */
export function createImageModels(
  specs: readonly ImageModelSpec[],
): (cap: Capability) => readonly ModelCapability[] {
  const envelopes: ModelCapability[] = specs.map((spec) => ({
    // The `call` contract generation this adapter implements — imported, not
    // hard-coded, so a runtime that cannot execute it says so before calling.
    specificationVersion: MODEL_SPEC_VERSION,
    capabilities: ['text-to-image'],
    provider: spec.provider,
    modelId: spec.modelId,
    inputs: ['text'],
    outputs: ['image'],
    tags: spec.tags ?? [],
    source: 'user',
    call: imageCall(spec.model),
  }))
  return (cap) => envelopes.filter((env) => env.capabilities.includes(cap))
}
