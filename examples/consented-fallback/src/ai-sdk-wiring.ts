// Host-local ai-sdk wiring — the two `ModelCapability` envelopes this host
// serves, one per model, both from @orchestral/adapters-ai-sdk. core /
// runtime / patterns never import a provider SDK; talking to one is host
// territory, and this file is the whole of it. What the adapters cannot know
// is the one thing that is the host's alone: how an assetId and bytes relate.
//
//   • text-to-image  → `fromImageModel` over an ai-sdk image model. This host
//                      records every produced image into its own store and
//                      wants the store's id on the output, at the moment the
//                      output is produced — that is the `mintAssetId` hook.
//   • image-to-text  → `fromVisionModel` over a vision-capable language
//                      model. The hook in the other direction: `loadImage`
//                      turns an assetId on `ctx.assets` back into bytes,
//                      answered from the same store.
//
// There is deliberately NO image-to-image envelope. That gap is what main.ts
// is about. Both take a model INSTANCE the host built (a real
// `openai.image(...)` / `openai(...)`, or an `ai/test` mock) so the same code
// runs offline and live.

import {
  fromImageModel,
  fromVisionModel,
  type ImageModelInstance,
  type LanguageModelInstance,
} from '@orchestral/adapters-ai-sdk'
import type { Artifact, Capability, ModelCapability } from '@orchestral/core'
import type { HostAssetStore, StoredAsset } from './asset-store'

/** One model the host serves, with its own ai-sdk instance (BYOK). */
export interface ModelSpec<M> {
  provider: string
  modelId: string
  model: M
}

/** The two models this host has. Nothing for image-to-image, on purpose. */
export interface HostModels {
  image: ModelSpec<ImageModelInstance>
  caption: ModelSpec<LanguageModelInstance>
}

// The adapters hand produced bytes over as a `data:` URI — the artifact
// channel's form — and this store keeps mime + base64, the shape `loadImage`
// hands back. One split between the two.
const BASE64_MARKER = ';base64,'

function toStoredAsset(artifact: Artifact): StoredAsset {
  const at = artifact.uri.indexOf(BASE64_MARKER)
  if (!artifact.uri.startsWith('data:') || at < 0) {
    throw new Error(`expected a base64 data: URI artifact, got "${artifact.uri.slice(0, 40)}"`)
  }
  return {
    mime: artifact.mime ?? artifact.uri.slice('data:'.length, at),
    base64: artifact.uri.slice(at + BASE64_MARKER.length),
  }
}

// ── getModels ───────────────────────────────────────────────────────────────

/**
 * Pack the host's two models into the `getModels(cap)` the default router
 * consumes. Each is a `ModelCapability` envelope declaring exactly one
 * capability; asking for any other capability — image-to-image included —
 * returns `[]`, which is what the router reports as `no-model-in-catalog`.
 */
export function createModels(
  models: HostModels,
  store: HostAssetStore,
): (cap: Capability) => readonly ModelCapability[] {
  const envelopes: ModelCapability[] = [
    // Every produced image is recorded into the host store under a fresh id,
    // and THAT id is what the output element carries — minted here, when the
    // output is produced, not rewritten afterwards. The adapter stamps the
    // same id on the artifact's `meta.assetId`, so a `job:artifact`
    // subscriber and the output agree on what to look up.
    fromImageModel(models.image.model, {
      provider: models.image.provider,
      modelId: models.image.modelId,
      mintAssetId: (artifact) => store.record(toStoredAsset(artifact)),
    }),
    // The source image(s) arrive as assetIds on `ctx.assets` (slot `source`,
    // array cardinality — the adapter sends every ref, in order, as a `file`
    // part). The runtime only ever passes ids; `loadImage` is where one
    // becomes bytes, and only this host can answer that.
    fromVisionModel(models.caption.model, {
      provider: models.caption.provider,
      modelId: models.caption.modelId,
      loadImage: (ref) => {
        const { mime, base64 } = store.get(ref.assetId)
        return { data: base64, mediaType: mime }
      },
    }),
  ]
  return (cap) => envelopes.filter((env) => env.capabilities.includes(cap))
}
