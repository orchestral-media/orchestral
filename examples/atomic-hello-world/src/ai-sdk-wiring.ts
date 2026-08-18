// Host-local ai-sdk wiring — this is the part the @orchestral packages
// deliberately don't ship. core / runtime / patterns never import a provider
// SDK; talking to one is host territory. This file is the reference for how a
// host bridges an ai-sdk ImageModel to the orchestral dispatch contract:
// wrap each model instance into a `ModelCapability` envelope whose `call`
// closure drives ai-sdk's `generateImage`, then hand `getModels` to
// `createDefaultCapabilityRouter`. ~50 lines; copy it into your own host.

import { generateImage } from 'ai'
import type {
  CallEvents,
  Capability,
  DispatchContext,
  ModelCapability,
  ModelTag,
  DispatchResult,
} from '@orchestral/core'

// `ImageModel` from 'ai' is the broad `string | ImageModelV3` union (the bare
// id form is accepted by helpers that resolve through a provider registry). The
// bridge needs the resolved model OBJECT (it reads `.provider` / `.modelId` and
// hands the instance to `generateImage`), so pull that object type out of
// `generateImage`'s own signature — avoids a transitive `@ai-sdk/provider`
// import. A host passes the instance it built from `openai.image(...)`.
type ImageModelInstance = Exclude<
  Parameters<typeof generateImage>[0]['model'],
  string
>
type AiSdkProviderOptions = NonNullable<
  Parameters<typeof generateImage>[0]['providerOptions']
>

/** One model the host serves for text-to-image. `model` is its own ai-sdk
 * ImageModel, built with its own BYOK key. */
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

// Bridge a single ai-sdk ImageModel to a `ModelCapability.call` closure. The
// host owns the model (and its key); this only translates the orchestral
// dispatch contract to/from `generateImage`. The output matches patterns'
// TextToImageOutputSchema field-for-field so `pattern.outputs.parse()` succeeds.
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
      // ctx.providerOptions is host-validated at the dispatch boundary;
      // ai-sdk's stricter SharedV3ProviderOptions is the wire contract, so cast
      // at this trusted seam.
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

    // Standalone host has no asset store, so `url` is the data URI and assetId
    // is a synthesized placeholder. A host that records assets stamps canonical
    // handles afterward.
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
 * Each spec becomes a `ModelCapability` envelope: the record half is derived
 * (text-to-image `inputs`/`outputs`, `source: 'user'`), and `call` is the
 * `generateImage` bridge above. Hand the returned `getModels` straight to
 * `createDefaultCapabilityRouter`.
 */
export function createImageModels(
  specs: readonly ImageModelSpec[],
): (cap: Capability) => readonly ModelCapability[] {
  const envelopes: ModelCapability[] = specs.map((spec) => ({
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
