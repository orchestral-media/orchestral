// Host-local ai-sdk wiring. The @orchestral packages never import a provider
// SDK; bridging an ai-sdk ImageModel to the orchestral `call` contract is host
// territory — and `@orchestral/adapters-ai-sdk` is that bridge, shipped as a
// leaf package nothing in @orchestral/* depends on. What is left for the host
// is to say which models it serves and hand the router a `getModels`. (The
// hand-written version of the same bridge is the root README's "Minimal
// example"; it teaches the seam this package sits on.)

import { fromImageModel, type ImageModelInstance } from '@orchestral/adapters-ai-sdk'
import type { Capability, ModelCapability, ModelTag } from '@orchestral/core'

/** One model the host serves for text-to-image. `model` is its own ai-sdk
 * ImageModel instance, built with its own BYOK key. */
export interface ImageModelSpec {
  provider: string
  modelId: string
  model: ImageModelInstance
  tags?: readonly ModelTag[]
}

/**
 * Pack image-model specs into a `getModels(cap)` the default router consumes.
 * Each spec becomes a `ModelCapability` envelope via `fromImageModel`: the
 * record half (text-to-image `inputs`/`outputs`, `source: 'user'`,
 * `specificationVersion`) and the `generateImage` bridge behind `call`. Hand
 * the returned `getModels` straight to `createDefaultCapabilityRouter`.
 */
export function createImageModels(
  specs: readonly ImageModelSpec[],
): (cap: Capability) => readonly ModelCapability[] {
  const envelopes = specs.map((spec) =>
    fromImageModel(spec.model, {
      provider: spec.provider,
      modelId: spec.modelId,
      tags: spec.tags,
    }),
  )
  return (cap) => envelopes.filter((env) => env.capabilities.includes(cap))
}
