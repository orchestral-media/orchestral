// Host-local ai-sdk wiring for the text-to-image TOOL the agent calls. Same
// shape as the atomic example's ai-sdk-wiring.ts — kept example-local so this
// example stands alone. The @orchestral packages never import a provider SDK;
// `@orchestral/adapters-ai-sdk` is the leaf package that bridges an ai-sdk
// ImageModel to the orchestral `call` contract, so the host only declares
// which models it serves.

import { fromImageModel, type ImageModelInstance } from '@orchestral/adapters-ai-sdk'
import type { Capability, ModelCapability, ModelTag } from '@orchestral/core'

/** One model the host serves for text-to-image, with its own ai-sdk
 * ImageModel instance (built with its own BYOK key). */
export interface ImageModelSpec {
  provider: string
  modelId: string
  model: ImageModelInstance
  tags?: readonly ModelTag[]
}

/**
 * Pack image-model specs into a `getModels(cap)` the default router consumes.
 * Hand the returned `getModels` straight to `createDefaultCapabilityRouter`.
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
